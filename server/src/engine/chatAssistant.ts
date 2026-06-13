/**
 * Trade Chat Assistant — natural-language Q&A over the entire vedicedge
 * platform data. Designed for 100% factual accuracy by NEVER letting the
 * LLM generate numbers — it only summarizes the snapshot JSON we feed it.
 *
 * Architecture (the anti-hallucination protocol):
 *   1. User submits a query (e.g. "buying MOSCHIP, give analysis")
 *   2. Backend identifies relevant symbols + tabs (regex + keyword match)
 *   3. Backend loads ALL relevant snapshot JSONs into the prompt context
 *   4. LLM is given a strict system prompt: "ONLY use the provided JSON.
 *      Never make up numbers. If data isn't there, say 'I don't have that
 *      data' rather than guess. Always cite the source snapshot."
 *   5. LLM response is returned with source-citation tags so the user can
 *      verify every number.
 *
 * Free LLM backend (no paid API):
 *   - Primary: Google Gemini (1,500 req/day free tier from aistudio.google.com)
 *   - Fallback: Groq (free tier, very fast Llama-3 inference)
 *   - User sets GEMINI_API_KEY or GROQ_API_KEY in server .env
 *
 * Security: API keys are server-side only, never exposed to client.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import axios from 'axios'
import { log } from '../util/logger'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

// Snapshots that get loaded into context based on query intent
const ALL_SNAPSHOTS = [
  'weekly-pick', 'daily-pick', 'pre-move', 'fno-futures',
  'options', 'options-pro', 'oi-buildup',
  'cross-confluence', 'pro-edge', 'ad-divergence',
  'sl-trap-alerts', 'sector-rotation', 'old-weekly-pick',
  'signals-history', 'accuracy', 'gainer-postmortem',
]

const SYSTEM_PROMPT = `You are TradewithVarsha AI, a hedge-fund trading assistant for tradewithvarsha.

CRITICAL RULES (violating these means refunds and lost users):
1. NEVER make up numbers, prices, dates, or percentages. ONLY use values from the JSON data provided in the user message below.
2. If a value the user asks about is NOT in the provided JSON, say exactly: "I don't have current data on that — please check the relevant tab directly." Do not guess.
3. Always cite the source snapshot for every number (e.g. "per weekly-pick.json", "per smart-money snapshot").
4. For LOSS-related queries (user sitting on losses), be empathetic but factual. Do not gaslight. Acknowledge the loss and explain what the data shows now (current status, smart-money side, SL-Trap status). Give actionable next-step rules based on the platform's playbook.
5. Always end loss-related advice with: "Final decision is yours. The system flags risk; you manage capital."
6. For "should I buy X" queries: check Weekly Pick / PRO Edge / Smart Money / SL Traps / Sector for that symbol. Synthesize. If symbol isn't tracked, say so.
7. Use clear, simple language. No jargon without explanation. Indian English / Hinglish is fine.
8. Maximum 250 words per response.

You will receive:
- The user's question
- Relevant snapshot JSON data wrapped in <data> tags
Answer using ONLY the data. Never invent.`

interface ChatResponse {
  answer: string
  sourcesUsed: string[]
  llmProvider: 'gemini' | 'groq' | 'fallback'
  warnings: string[]
}

async function readSnap(name: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(SNAP_DIR, name + '.json'), 'utf8'))
  } catch { return null }
}

// Cached ticker set — populated on first call from Angel ScripMaster.
// This is the SOURCE OF TRUTH for what is a real Indian listed ticker
// vs what is just an English word that happens to be uppercase.
let TICKER_SET: Set<string> | null = null
async function loadTickerSet(): Promise<Set<string>> {
  if (TICKER_SET) return TICKER_SET
  try {
    const angel = await import('../data/angel')
    const sm = await angel.loadScripMaster()
    const set = new Set<string>()
    for (const s of (sm || [])) {
      if (s.exch_seg !== 'NSE' && s.exch_seg !== 'BSE') continue
      const sym = (s.symbol ?? '').toUpperCase().replace(/-EQ$|-BE$|-BZ$|-SM$|-ST$/, '')
      if (sym.length >= 3 && sym.length <= 16 && /^[A-Z0-9&]+$/.test(sym)) set.add(sym)
    }
    set.add('NIFTY'); set.add('BANKNIFTY'); set.add('FINNIFTY')
    TICKER_SET = set
    log.info('CHAT', `ticker set loaded: ${set.size} valid Indian tickers`)
    return set
  } catch (e) {
    log.warn('CHAT', `ticker set load failed: ${(e as Error).message}`)
    return new Set()
  }
}

/**
 * Intent classifier — extracts symbol mentions + topic keywords. Uses the
 * Angel ScripMaster ticker set as ground truth so English words like
 * "BUYING", "THINKING", "SYSTEM" don't get classified as stocks.
 */
async function classifyIntent(query: string): Promise<{ symbols: string[]; topics: string[] }> {
  const tickerSet = await loadTickerSet()
  // Normalize: split on word boundaries, uppercase, keep only tokens that
  // exist in ScripMaster. Tokens < 3 chars rejected.
  const tokens = query.toUpperCase().split(/[^A-Z0-9&]+/).filter(t => t.length >= 3)
  const tickers = new Set<string>()
  for (const t of tokens) {
    // Exact match against ScripMaster — only real tickers pass
    if (tickerSet.has(t)) tickers.add(t)
  }
  const topics: string[] = []
  if (/SMART|MONEY|INSTITUTION|FII|DII|PROMOTER/i.test(query)) topics.push('smart-money')
  if (/OI|OPTION CHAIN|CE|PE|CALL|PUT|STRIKE/i.test(query)) topics.push('oi')
  if (/SL|STOP LOSS|HIT|TRAP|LIQUIDITY/i.test(query)) topics.push('sl-trap')
  if (/SECTOR|ROTATION|LEADING|LAGGING/i.test(query)) topics.push('sector')
  if (/CONFLUENCE|ULTRA|MULTIPLE/i.test(query)) topics.push('confluence')
  if (/LOSS|LOSING|DOWN|RED/i.test(query)) topics.push('loss')
  if (/PRO|EDGE|PREMIUM/i.test(query)) topics.push('pro-edge')
  if (/ACCURACY|WIN RATE|WR/i.test(query)) topics.push('accuracy')
  return { symbols: Array.from(tickers), topics }
}

async function loadContext(symbols: string[], topics: string[]): Promise<{
  snippets: Record<string, any>
  sources: string[]
}> {
  const snippets: Record<string, any> = {}
  const sources: string[] = []
  const wantedSnaps = new Set<string>([
    'accuracy',           // always relevant — current WR
    'sl-trap-alerts',     // critical for loss queries
  ])
  if (topics.includes('smart-money') || symbols.length > 0) wantedSnaps.add('ad-divergence')
  if (topics.includes('oi')) { wantedSnaps.add('oi-buildup'); wantedSnaps.add('options') }
  if (topics.includes('sector') || symbols.length > 0) wantedSnaps.add('sector-rotation')
  if (topics.includes('confluence') || symbols.length > 0) wantedSnaps.add('cross-confluence')
  if (topics.includes('pro-edge') || symbols.length > 0) wantedSnaps.add('pro-edge')
  if (symbols.length > 0) {
    wantedSnaps.add('weekly-pick')
    wantedSnaps.add('daily-pick')
    wantedSnaps.add('fno-futures')
    wantedSnaps.add('signals-history')
  }

  for (const name of wantedSnaps) {
    const j = await readSnap(name)
    if (!j) continue
    // For symbol-specific filtering, slice rows to just the mentioned symbols
    let payload: any = j
    if (symbols.length > 0 && j.rows && Array.isArray(j.rows)) {
      const matchingRows = j.rows.filter((r: any) => {
        const s = (r.symbol ?? r.instrument ?? '').toUpperCase()
        return symbols.some(t => s.includes(t) || t.includes(s.slice(0, 5)))
      })
      payload = { ...j, rows: matchingRows.slice(0, 20) }
    } else if (j.rows && Array.isArray(j.rows)) {
      // No specific symbol — give top 10 of each tab
      payload = { ...j, rows: j.rows.slice(0, 10) }
    } else if (j.signals && Array.isArray(j.signals)) {
      // signals-history shape
      const matchingSigs = symbols.length > 0
        ? j.signals.filter((s: any) => symbols.some(t => (s.symbol ?? '').toUpperCase().includes(t)))
        : j.signals.slice(0, 5)
      payload = { ...j, signals: matchingSigs.slice(0, 30) }
    }
    snippets[name] = payload
    sources.push(name)
  }
  return { snippets, sources }
}

// Try multiple Gemini models in order — different models have different
// free-tier quotas. If a project has zero quota on flash, lite may have
// some, etc. Returns { text, lastError } so the caller can surface quota
// issues to the user clearly.
const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-2.5-pro',
]

async function callGemini(systemPrompt: string, userPrompt: string): Promise<{ text: string | null; error: string | null }> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return { text: null, error: 'GEMINI_API_KEY not set' }
  let lastErr: string | null = null
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`
      const body = {
        contents: [
          { role: 'user', parts: [{ text: systemPrompt + '\n\n---\n\nUSER:\n' + userPrompt }] },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,        // Was 600 — 2.5 models reserve thinking tokens
          thinkingConfig: { thinkingBudget: 0 },   // Disable thinking on 2.5 models
        },
      }
      const res = await axios.post(url, body, { timeout: 20_000, validateStatus: () => true })
      if (res.status === 200) {
        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text
        if (typeof text === 'string') return { text: text.trim(), error: null }
      } else if (res.status === 429) {
        // Quota — try next model
        const msg = res.data?.error?.message ?? 'quota exhausted'
        lastErr = `${model}: 429 ${msg.split('\n')[0]}`
        continue
      } else {
        lastErr = `${model}: ${res.status} ${JSON.stringify(res.data?.error ?? res.data ?? '').slice(0, 200)}`
        continue
      }
    } catch (e) {
      lastErr = `${model}: ${(e as Error).message}`
    }
  }
  log.warn('CHAT', `Gemini all models failed: ${lastErr}`)
  return { text: null, error: lastErr }
}

/** Call Groq (free Llama-3 inference). Very fast. */
async function callGroq(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const key = process.env.GROQ_API_KEY
  if (!key) return null
  try {
    const url = 'https://api.groq.com/openai/v1/chat/completions'
    const body = {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 600,
    }
    const res = await axios.post(url, body, {
      timeout: 20_000,
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    })
    return res.data?.choices?.[0]?.message?.content?.trim() ?? null
  } catch (e) {
    log.warn('CHAT', `Groq error: ${(e as Error).message}`)
    return null
  }
}

/** Deterministic fallback when no LLM key is set — does dumb extraction. */
function fallbackAnswer(symbols: string[], context: Record<string, any>): string {
  const lines: string[] = ['No AI key configured. Showing raw data from snapshots:\n']
  if (symbols.length === 0) {
    lines.push('No symbol detected in query. Please mention a stock ticker for analysis.')
    return lines.join('\n')
  }
  for (const sym of symbols) {
    lines.push(`\n📊 ${sym}:`)
    for (const [snapName, data] of Object.entries(context)) {
      const rows = (data as any).rows ?? (data as any).signals ?? []
      const matches = rows.filter((r: any) => {
        const s = (r.symbol ?? r.instrument ?? '').toUpperCase()
        return s.includes(sym) || sym.includes(s.slice(0, 5))
      })
      if (matches.length > 0) {
        for (const r of matches.slice(0, 3)) {
          const info = []
          if (r.direction) info.push(`${r.direction}`)
          if (r.side) info.push(`${r.side}`)
          if (r.conviction != null) info.push(`conv ${r.conviction}`)
          if (r.entry != null) info.push(`entry ${r.entry}`)
          if (r.stopLoss != null) info.push(`SL ${r.stopLoss}`)
          if (r.status) info.push(`status ${r.status}`)
          lines.push(`  · ${snapName}: ${info.join(' · ')}`)
        }
      }
    }
  }
  lines.push('\nFor a synthesized AI answer, set GEMINI_API_KEY or GROQ_API_KEY in server .env. Both are free.')
  return lines.join('\n')
}

export async function askAi(query: string): Promise<ChatResponse> {
  const warnings: string[] = []
  const { symbols, topics } = await classifyIntent(query)
  log.info('CHAT', `intent: symbols=${symbols.join(',') || 'none'} · topics=${topics.join(',') || 'none'}`)
  const { snippets, sources } = await loadContext(symbols, topics)

  // Build user prompt with strict data tags
  const dataBlocks = Object.entries(snippets)
    .map(([name, data]) => `<data source="${name}">\n${JSON.stringify(data, null, 0).slice(0, 4000)}\n</data>`)
    .join('\n\n')
  const userPrompt = `USER QUESTION: ${query}\n\nAVAILABLE DATA (do not invent any number not present below):\n${dataBlocks}\n\nAnswer the user using ONLY the data above. Cite source snapshots.`

  let answer: string | null = null
  let provider: ChatResponse['llmProvider'] = 'fallback'
  let geminiErr: string | null = null
  if (process.env.GEMINI_API_KEY) {
    const r = await callGemini(SYSTEM_PROMPT, userPrompt)
    if (r.text) { answer = r.text; provider = 'gemini' }
    else geminiErr = r.error
  }
  if (!answer && process.env.GROQ_API_KEY) {
    const t = await callGroq(SYSTEM_PROMPT, userPrompt)
    if (t) { answer = t; provider = 'groq' }
  }
  if (!answer) {
    answer = fallbackAnswer(symbols, snippets)
    if (!process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
      warnings.push('No LLM key configured (set GEMINI_API_KEY or GROQ_API_KEY in server .env)')
    } else if (geminiErr && /quota|429|RESOURCE_EXHAUSTED/i.test(geminiErr)) {
      warnings.push(`Gemini key has zero free-tier quota on this project. Create a fresh key at https://aistudio.google.com/app/apikey (sign in → "Create API key" → choose default project, NOT a custom Cloud project).`)
    } else if (geminiErr) {
      warnings.push(`Gemini error: ${geminiErr.slice(0, 200)}`)
    }
  }

  return { answer, sourcesUsed: sources, llmProvider: provider, warnings }
}
