/**
 * Vercel serverless function for the AI chat assistant.
 *
 * Mirrors the local /api/chat endpoint that runs against the dev server,
 * but here we run on Vercel's edge — no on-disk snapshots, so we fetch
 * the snapshot JSONs from raw.githubusercontent.com (same source the
 * frontend uses) and feed them to Gemini.
 *
 * Anti-hallucination protocol (identical to local engine):
 *   - LLM sees only the snapshot JSON for the symbols/topics in the query
 *   - System prompt forbids inventing numbers
 *   - Answer must cite the source snapshot
 *
 * Required env var on Vercel: GEMINI_API_KEY  (free from aistudio.google.com)
 */
import { applyCors } from './_lib/db'

const SNAP_BASE = 'https://raw.githubusercontent.com/addonwebsolutionsai-droid/tradewithvarsha/main/server/data/public-snapshots'

const SYSTEM_PROMPT = `You are TradewithVarsha AI, a hedge-fund trading assistant for the tradewithvarsha platform.

CRITICAL RULES (violating these loses user trust):
1. NEVER make up numbers, prices, dates, or percentages. ONLY use values from the JSON data provided below.
2. If a value the user asks about is NOT in the provided JSON, say: "I don't have current data on that — please check the relevant tab directly." Do not guess.
3. Always cite the source snapshot for every number (e.g. "per weekly-pick.json", "per smart-money snapshot").
4. For LOSS-related queries, be empathetic but factual. Don't gaslight. Acknowledge the loss, then explain what current data shows (status, smart-money side, SL-Trap status).
5. Always end loss-related advice with: "Final decision is yours. The system flags risk; you manage capital."
6. For "should I buy X" queries: check Weekly Pick / PRO Edge / Smart Money / SL Traps / Sector for that symbol. Synthesize. If symbol isn't in any snapshot, say so.
7. Use simple language. Indian English / Hinglish welcome.
8. Maximum 350 words per response.

You will receive the user's question + relevant snapshot JSON wrapped in <data> tags.
Answer using ONLY that data. Never invent.`

const ALL_SNAPSHOTS = [
  'weekly-pick', 'daily-pick', 'pre-move', 'fno-futures',
  'options', 'options-pro', 'oi-buildup',
  'cross-confluence', 'pro-edge', 'ad-divergence',
  'sl-trap-alerts', 'sector-rotation', 'old-weekly-pick',
  'signals-history', 'accuracy', 'multi-strike-oi',
]

// Common stop words that look like tickers — must be filtered.
const STOP_WORDS = new Set([
  'BUY', 'SELL', 'HOLD', 'CE', 'PE', 'PUT', 'CALL', 'OPTION', 'OPTIONS', 'STRIKE',
  'EXPIRY', 'JUNE', 'JULY', 'AUGUST', 'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY',
  'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
  'SL', 'TARGET', 'TGT', 'STOP', 'LOSS', 'LOSSES', 'PROFIT', 'TRADE', 'AT', 'OF',
  'WITH', 'FROM', 'INTO', 'THE', 'AND', 'BUT', 'YOU', 'AI', 'AM', 'ARE', 'WAS',
  'ASK', 'TELL', 'PLEASE', 'SHOULD', 'WE', 'OUR', 'MY', 'ME', 'IS', 'IT', 'NOW',
  'WILL', 'CAN', 'DID', 'NOT', 'YES', 'NO', 'SO', 'OR', 'IF', 'ON', 'BY',
  'FOR', 'AS', 'BE', 'TO', 'IN', 'A', 'AN', 'ALL', 'BIG', 'BIGGER', 'GOOD', 'BAD',
  'BUYING', 'THINKING', 'BOUGHT', 'SOLD', 'SAME', 'ERROR', 'ANY', 'WHAT', 'WHY',
  'HOW', 'WHEN', 'WHERE', 'WHICH', 'WHO', 'CURRENT', 'TRAP', 'TRAPPING', 'MAKING',
  'POSITIONS', 'POSITION', 'RETAILER', 'RETAILERS', 'SMART', 'MONEY', 'BIG',
  'FALLING', 'FALL', 'COMPANY', 'MULTI', 'YEAR', 'LOW', 'HIGH', 'BECAUSE',
  'SYSTEM', 'GENERATED', 'REGENERATED', 'SIGNAL', 'HIT', 'HITTED', 'SITTING',
  'HUGE', 'GIVE', 'GIVEN', 'GAVE', 'HAS', 'HAVE', 'HAD', 'DO', 'DOES', 'DONE',
])

// Curated ticker list — common Indian large/mid caps. Vercel function can't
// load Angel ScripMaster (no Angel auth), so we use a static popular list.
// For unknown tickers, we still pass the original token if it looks valid
// (3-12 alpha chars not in STOP_WORDS).
const POPULAR_TICKERS = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY',
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'AXISBANK', 'ITC',
  'LT', 'BHARTIARTL', 'BAJFINANCE', 'KOTAKBANK', 'MARUTI', 'ASIANPAINT',
  'TATAMOTORS', 'TATASTEEL', 'ONGC', 'HCLTECH', 'WIPRO', 'ULTRACEMCO', 'NTPC',
  'POWERGRID', 'ADANIENT', 'ADANIPORTS', 'BAJAJFINSV', 'JSWSTEEL', 'HINDUNILVR',
  'NESTLEIND', 'COALINDIA', 'INDUSINDBK', 'SUNPHARMA', 'EICHERMOT', 'HEROMOTOCO',
  'BRITANNIA', 'DRREDDY', 'GRASIM', 'TITAN', 'DIVISLAB', 'BPCL', 'CIPLA',
  'TECHM', 'HDFCLIFE', 'SBILIFE', 'ADANIGREEN', 'ADANIPOWER', 'TATAPOWER',
  'HAL', 'BEL', 'CANBK', 'BANKBARODA', 'IRCTC', 'IRFC', 'PFC', 'RECLTD',
  'JNKINDIA', 'MOSCHIP', 'MARKSANS', 'FINPIPE', 'JIOFIN',
])

function classifyIntent(query: string): { symbols: string[]; topics: string[] } {
  const tokens = query.toUpperCase().split(/[^A-Z0-9&]+/).filter(t => t.length >= 3 && t.length <= 14)
  const tickers = new Set<string>()
  for (const t of tokens) {
    if (STOP_WORDS.has(t)) continue
    // Either explicit popular ticker OR a token that looks ticker-shaped
    // (all alpha, 3-12 chars, not a stop word — falls back to "send it
    // to the LLM and let snapshot search figure out").
    if (POPULAR_TICKERS.has(t) || /^[A-Z][A-Z&]{2,11}$/.test(t)) {
      tickers.add(t)
    }
  }
  const topics: string[] = []
  if (/SMART|MONEY|INSTITUTION|FII|DII|PROMOTER/i.test(query)) topics.push('smart-money')
  if (/OI|OPTION CHAIN|CE|PE|CALL|PUT|STRIKE/i.test(query)) topics.push('oi')
  if (/SL|STOP LOSS|HIT|TRAP|LIQUIDITY/i.test(query)) topics.push('sl-trap')
  if (/SECTOR|ROTATION|LEADING|LAGGING/i.test(query)) topics.push('sector')
  if (/LOSS|LOSING|DOWN|RED|FALL/i.test(query)) topics.push('loss')
  return { symbols: Array.from(tickers), topics }
}

async function fetchSnap(name: string): Promise<any | null> {
  try {
    const res = await fetch(`${SNAP_BASE}/${name}.json?t=${Date.now()}`)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function loadContext(symbols: string[], topics: string[]): Promise<{
  snippets: Record<string, any>
  sources: string[]
}> {
  // Decide which snapshots to load
  const wanted = new Set<string>(['accuracy', 'sl-trap-alerts'])
  if (topics.includes('smart-money') || symbols.length > 0) wanted.add('ad-divergence')
  if (topics.includes('oi')) { wanted.add('oi-buildup'); wanted.add('options'); wanted.add('multi-strike-oi') }
  if (topics.includes('sector') || symbols.length > 0) wanted.add('sector-rotation')
  if (symbols.length > 0) {
    wanted.add('weekly-pick'); wanted.add('daily-pick'); wanted.add('fno-futures')
    wanted.add('cross-confluence'); wanted.add('pro-edge'); wanted.add('signals-history')
    wanted.add('options')
  }

  const snippets: Record<string, any> = {}
  const sources: string[] = []
  // Parallel fetch
  const results = await Promise.all(
    Array.from(wanted).map(async name => ({ name, data: await fetchSnap(name) })),
  )
  for (const { name, data } of results) {
    if (!data) continue
    let payload: any = data
    // Filter rows to mentioned symbols (if any)
    if (symbols.length > 0 && data.rows && Array.isArray(data.rows)) {
      const matches = data.rows.filter((r: any) => {
        const s = String(r.symbol ?? r.instrument ?? '').toUpperCase()
        return symbols.some(t => s.includes(t) || (t.length >= 5 && t.includes(s.slice(0, 5))))
      })
      payload = { ...data, rows: matches.slice(0, 20) }
    } else if (data.rows && Array.isArray(data.rows)) {
      payload = { ...data, rows: data.rows.slice(0, 8) }
    } else if (data.signals && Array.isArray(data.signals)) {
      const matches = symbols.length > 0
        ? data.signals.filter((s: any) => symbols.some(t => String(s.symbol ?? '').toUpperCase().includes(t)))
        : data.signals.slice(0, 5)
      payload = { ...data, signals: matches.slice(0, 30) }
    }
    snippets[name] = payload
    sources.push(name)
  }
  return { snippets, sources }
}

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.5-pro',
]

async function callGemini(systemPrompt: string, userPrompt: string): Promise<{ text: string | null; error: string | null }> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return { text: null, error: 'GEMINI_API_KEY not set on Vercel' }
  let lastErr: string | null = null
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
      const body = {
        contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n---\n\nUSER:\n' + userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const j: any = await res.json()
        const text = j?.candidates?.[0]?.content?.parts?.[0]?.text
        if (typeof text === 'string') return { text: text.trim(), error: null }
      } else if (res.status === 429) {
        const j: any = await res.json().catch(() => ({}))
        lastErr = `${model}: 429 ${(j?.error?.message ?? '').split('\n')[0]}`
        continue
      } else {
        const t = await res.text().catch(() => '')
        lastErr = `${model}: ${res.status} ${t.slice(0, 200)}`
        continue
      }
    } catch (e: any) {
      lastErr = `${model}: ${e.message}`
    }
  }
  return { text: null, error: lastErr }
}

function fallbackAnswer(symbols: string[], context: Record<string, any>): string {
  const lines: string[] = ['🔧 AI not configured on Vercel (set GEMINI_API_KEY env var). Showing raw snapshot data:\n']
  if (symbols.length === 0) {
    lines.push('No stock ticker detected in your query. Please mention a stock name.')
    return lines.join('\n')
  }
  for (const sym of symbols) {
    lines.push(`\n📊 ${sym}:`)
    for (const [snapName, data] of Object.entries(context)) {
      const rows = (data as any).rows ?? (data as any).signals ?? []
      const matches = rows.filter((r: any) => {
        const s = String(r.symbol ?? r.instrument ?? '').toUpperCase()
        return s.includes(sym)
      })
      if (matches.length > 0) {
        for (const r of matches.slice(0, 2)) {
          const info = []
          if (r.direction) info.push(r.direction)
          if (r.side) info.push(r.side)
          if (r.conviction != null) info.push(`conv ${r.conviction}`)
          if (r.entry != null) info.push(`entry ₹${r.entry}`)
          if (r.stopLoss != null) info.push(`SL ₹${r.stopLoss}`)
          if (r.status) info.push(`status ${r.status}`)
          lines.push(`  · ${snapName}: ${info.join(' · ')}`)
        }
      }
    }
  }
  return lines.join('\n')
}

export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' })
    return
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {})
    const query = String(body?.query ?? '').trim()
    if (!query) {
      res.status(400).json({ error: 'query required' })
      return
    }
    if (query.length > 1000) {
      res.status(400).json({ error: 'query too long (max 1000 chars)' })
      return
    }

    const { symbols, topics } = classifyIntent(query)
    const { snippets, sources } = await loadContext(symbols, topics)

    const dataBlocks = Object.entries(snippets)
      .map(([name, data]) => `<data source="${name}">\n${JSON.stringify(data).slice(0, 4000)}\n</data>`)
      .join('\n\n')
    const userPrompt = `USER QUESTION: ${query}\n\nAVAILABLE DATA (do not invent any number not present below):\n${dataBlocks}\n\nAnswer the user using ONLY the data above. Cite source snapshots.`

    const warnings: string[] = []
    let answer: string | null = null
    let provider: string = 'fallback'

    if (process.env.GEMINI_API_KEY) {
      const r = await callGemini(SYSTEM_PROMPT, userPrompt)
      if (r.text) { answer = r.text; provider = 'gemini' }
      else if (r.error && /429|quota|RESOURCE_EXHAUSTED/i.test(r.error)) {
        warnings.push('Gemini key has zero free-tier quota on this project. Create a fresh key at aistudio.google.com/app/apikey.')
      } else if (r.error) {
        warnings.push(`Gemini: ${r.error.slice(0, 180)}`)
      }
    } else {
      warnings.push('GEMINI_API_KEY not set on Vercel — add it in Project Settings → Environment Variables.')
    }

    if (!answer) answer = fallbackAnswer(symbols, snippets)

    res.status(200).json({
      answer,
      sourcesUsed: sources,
      llmProvider: provider,
      warnings,
      intent: { symbols, topics },
    })
  } catch (e: any) {
    res.status(500).json({ error: e.message })
  }
}
