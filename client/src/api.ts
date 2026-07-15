import type { AstroBias, BacktestResult, GannBias, Health, MarketIndex, OIAnalysis, OptionChain, Signal } from './types'

// In dev, vite proxy handles /api → localhost:4000. In production (Vercel)
// the build can set VITE_API_URL to a backend URL OR leave it blank — when
// VITE_PUBLIC_MODE=true and no live backend, the 3 public tabs read from
// static JSON snapshots hosted at VITE_SNAPSHOT_BASE_URL (e.g. raw GitHub).
const API = (import.meta as any).env?.VITE_API_URL || ''
// 2026-05-22: SNAPSHOT_BASE falls back to the GitHub raw URL so localhost dev
// (where no .env.development exists) can still load Track Record + other
// public snapshot pages. Previously this was empty in dev → "Couldn't load"
// error on /track-record. Now the same data Vercel reads is also available
// locally without any env setup.
// Snapshot URL — env-var preferred, hardcoded fallback for resilience.
// Removing the fallback would break the public site if Vercel env var is
// ever unset, so kept defensive. URL appears in bundle either way.
const SNAPSHOT_BASE = (import.meta as any).env?.VITE_SNAPSHOT_BASE_URL
  || 'https://raw.githubusercontent.com/addonwebsolutionsai-droid/tradewithvarsha/main/server/data/public-snapshots'
const PUBLIC_MODE = (import.meta as any).env?.VITE_PUBLIC_MODE === 'true'

// Auth token in localStorage — attached as Bearer header automatically.
const TOKEN_KEY = 'hf-auth-token'
export const auth = {
  getToken: () => localStorage.getItem(TOKEN_KEY) || '',
  setToken: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

/** Snapshot fetcher — returns raw JSON from VITE_SNAPSHOT_BASE_URL/<file>. */
async function snapshot<T>(file: string): Promise<T> {
  if (!SNAPSHOT_BASE) throw new Error('VITE_SNAPSHOT_BASE_URL not configured')
  const res = await fetch(`${SNAPSHOT_BASE}/${file}?t=${Date.now()}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`snapshot ${file} → ${res.status}`)
  return res.json() as Promise<T>
}

export const isPublicMode = (): boolean => PUBLIC_MODE
export const snapshots = {
  weeklyPick: () => snapshot<{ generatedAt: string; weekOf: string; regime: string; rows: any[] }>('weekly-pick.json'),
  dailyPick: () => snapshot<{ generatedAt: string; regime: string; rows: any[] }>('daily-pick.json'),
  preMove: () => snapshot<{ generatedAt: string; rows: any[] }>('pre-move.json'),
  options: () => snapshot<{ generatedAt: string; rows: any[] }>('options.json'),
  intraday: () => snapshot<{ generatedAt: string; rows: any[] }>('intraday.json'),
  hitLog: () => snapshot<{ generatedAt: string; entries: any[] }>('hit-log.json'),
  topTrades: () => snapshot<{ generatedAt: string; filterMinConv: number; totalAvailable: number; rows: any[] }>('top-trades.json'),
  accuracy: () => snapshot<{ generatedAt: string; daysBack: number; total: number; byStatus: Record<string, number>; triggeredRate: number; winRate: number; slRate: number; avgRMultiple: number; bySource: any; byConvictionTier: any }>('accuracy.json'),
  signalsHistory: () => snapshot<{ generatedAt: string; total: number; signals: any[] }>('signals-history.json'),
  preMoveIdentifier: () => snapshot<{ generatedAt: string; universeSize: number; evaluated: number; qualityPassed: number; candidates: any[]; tier1Count: number; tier2Count: number; tier3Count: number; notes: string[] }>('pre-move-identifier.json'),
  oiBuildup: () => snapshot<{ generatedAt: string; symbols: string[]; summary: any[]; rows: any[] }>('oi-buildup.json'),
  fnoFutures: () => snapshot<{ generatedAt: string; universeSize: number; total: number; highConvCount: number; medConvCount: number; rows: any[] }>('fno-futures.json'),
  oldWeeklyPick: () => snapshot<{ generatedAt: string; weekOf: string; regime: string; universe: string; preRankMode: string; rowCount: number; rows: any[] }>('old-weekly-pick.json'),
  sectorRotation: () => snapshot<{ generatedAt: string; total: number; leading: string[]; lagging: string[]; rows: any[] }>('sector-rotation.json'),
  crossConfluence: () => snapshot<{ generatedAt: string; totalEvaluated: number; ultraCount: number; strongCount: number; rows: any[] }>('cross-confluence.json'),
  adDivergence: () => snapshot<{ generatedAt: string; universe: string; universeSize: number; total: number; accumulationCount: number; distributionCount: number; rows: any[] }>('ad-divergence.json'),
  proEdge: () => snapshot<{ generatedAt: string; totalEvaluated: number; passCount: number; rows: any[]; filters: { ultraPicks: number; smartMoneyOk: number; sectorAligned: number; convOk: number } }>('pro-edge.json'),
  optionsPro: () => snapshot<{ generatedAt: string; totalRaw: number; eliteCount: number; liveWinRate: number | null; winRateWindowDays: number; rows: any[] }>('options-pro.json'),
  slTraps: () => snapshot<{ generatedAt: string; trapsSuspected: number; trapsConfirmedWin: number; genuineSLs: number; effectiveWinRate: number | null; baseWinRate: number | null; rows: any[] }>('sl-trap-alerts.json'),
  missAnalysis: () => snapshot<{ generatedAt: string; totalGainers: number; caughtCount: number; missedCount: number; catchRate: number; rows: any[]; diagnoses: Record<string, number> }>('miss-analysis.json'),
  gainerPostmortem: () => snapshot<{ generatedAt: string; totalGainers: number; caughtCount: number; wouldHaveCaughtCount: number; patternBreakdown: Record<string, number>; topMissReasons: Record<string, number>; rows: any[] }>('gainer-postmortem.json'),
  multiStrikeOi: () => snapshot<{ generatedAt: string; total: number; bullishCount: number; bearishCount: number; rows: any[] }>('multi-strike-oi.json'),
  archive: () => snapshot<{ generatedAt: string; windowDays: number; total: number; byStatus: Record<string, number>; rows: any[] }>('archive.json'),
  superstarPicks: () => snapshot<{ generatedAt: string; investorCount: number; investors: any[]; total: number; activelyLoadingCount: number; rows: any[] }>('superstar-picks.json'),
  bulkDeals: () => snapshot<{ generatedAt: string; totalDeals: number; superstarDeals: number; institutionDeals: number; strongAccumulationCount: number; strongDistributionCount: number; rows: any[]; rawDeals: any[] }>('bulk-deals.json'),
  earlyMomentum: () => snapshot<{ generatedAt: string; criterion: string; total: number; tierCounts: Record<string, number>; rows: any[] }>('early-momentum.json'),
  pedigreeAccumulation: () => snapshot<{ generatedAt: string; criterion: string; total: number; deepCount: number; moderateCount: number; rows: any[] }>('pedigree-accumulation.json'),
  xRecs: () => snapshot<{ generatedAt: string; bySite: Record<string, string>; recommendations: any[] }>('x-recs.json'),
  chartPatterns: () => snapshot<{ generatedAt: string; criterion: string; note: string; total: number; byPattern: Record<string, number>; rows: any[] }>('chart-patterns.json'),
  insiderBuys: () => snapshot<{ generatedAt: string; criterion: string; total: number; strongCount: number; rows: any[] }>('insider-buys.json'),
  niftyOutlook: () => snapshot<{ generatedAt: string; spot: number; direction: string; confidence: string; bullScore: number; bearScore: number; netScore: number; tradePlan: any; reasoning: any; smartMoneyLevel: number; smartMoneyDirection: string; playbookDetected: string[]; cycle: any; keyLevels: any; historyPoints: number }>('nifty-outlook.json'),
  niftyVolumeProfile: () => snapshot<{ generatedAt: string; spot: number; compositeBias: string; confidence: string; bullTfCount: number; bearTfCount: number; agreementScore: number; timeframes: any[]; strongestSetup: any; tradeRecommendation: any }>('nifty-volume-profile.json'),
}

// Chat assistant — talks directly to Gemini from the browser.
// 2026-06-15: Vercel function /api/chat kept hitting 405/403/404 due to
// SPA rewrite + bot-challenge interference. Removed the middleman:
// browser fetches snapshots from GitHub raw (already does), builds the
// same prompt, and POSTs to Gemini directly. No Vercel function in the
// path = no 405/403.
//
// Security note: VITE_GEMINI_API_KEY is baked into the JS bundle at
// build time and visible to anyone who views source. Mitigations:
//   1. Restrict the key in Google Cloud Console to HTTP referrers
//      = tradewithvarsha.vercel.app (Application restrictions)
//   2. Use a separate key for client-side; rotate via Vercel rebuild
//   3. Free tier rate-limits per project (1500 req/day) cap abuse
const GEMINI_API_KEY = (import.meta as any).env?.VITE_GEMINI_API_KEY || ''
const SYSTEM_PROMPT = `You are TradewithVarsha AI, a hedge-fund trading assistant for the tradewithvarsha platform.

CRITICAL RULES:
1. NEVER make up numbers, prices, dates, or percentages. ONLY use values from the JSON data provided.
2. If a value the user asks about is NOT in the provided JSON, say: "I don't have current data on that — please check the relevant tab directly." Do not guess.
3. Always cite the source snapshot for every number (e.g. "per weekly-pick.json", "per smart-money").
4. For LOSS-related queries, be empathetic but factual. Don't gaslight. Acknowledge the loss, explain what current data shows.
5. End loss-related advice with: "Final decision is yours. The system flags risk; you manage capital."
6. For "should I buy X" queries: check Weekly Pick / PRO Edge / Smart Money / SL Traps / Sector for that symbol. Synthesize. If symbol isn't in any snapshot, say so.
7. Use simple language. Indian English / Hinglish welcome.
8. Maximum 350 words per response.

You will receive the user's question + relevant snapshot JSON wrapped in <data> tags.
Answer using ONLY that data. Never invent.`

const STOP_WORDS = new Set(['BUY','SELL','HOLD','CE','PE','PUT','CALL','OPTION','OPTIONS','STRIKE','EXPIRY','JUNE','JULY','AUGUST','JANUARY','FEBRUARY','MARCH','APRIL','MAY','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER','SL','TARGET','TGT','STOP','LOSS','LOSSES','PROFIT','TRADE','AT','OF','WITH','FROM','INTO','THE','AND','BUT','YOU','AI','AM','ARE','WAS','ASK','TELL','PLEASE','SHOULD','WE','OUR','MY','ME','IS','IT','NOW','WILL','CAN','DID','NOT','YES','NO','SO','OR','IF','ON','BY','FOR','AS','BE','TO','IN','A','AN','ALL','BIG','BIGGER','GOOD','BAD','BUYING','THINKING','BOUGHT','SOLD','SAME','ERROR','ANY','WHAT','WHY','HOW','WHEN','WHERE','WHICH','WHO','CURRENT','TRAP','TRAPPING','MAKING','POSITIONS','POSITION','RETAILER','RETAILERS','SMART','MONEY','FALLING','FALL','COMPANY','MULTI','YEAR','LOW','HIGH','BECAUSE','SYSTEM','GENERATED','REGENERATED','SIGNAL','HIT','HITTED','SITTING','HUGE','GIVE','GIVEN','GAVE','HAS','HAVE','HAD','DO','DOES','DONE'])
const POPULAR_TICKERS = new Set(['NIFTY','BANKNIFTY','FINNIFTY','RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','SBIN','AXISBANK','ITC','LT','BHARTIARTL','BAJFINANCE','KOTAKBANK','MARUTI','ASIANPAINT','TATAMOTORS','TATASTEEL','ONGC','HCLTECH','WIPRO','ULTRACEMCO','NTPC','POWERGRID','ADANIENT','ADANIPORTS','BAJAJFINSV','JSWSTEEL','HINDUNILVR','NESTLEIND','COALINDIA','INDUSINDBK','SUNPHARMA','EICHERMOT','HEROMOTOCO','BRITANNIA','DRREDDY','GRASIM','TITAN','DIVISLAB','BPCL','CIPLA','TECHM','HDFCLIFE','SBILIFE','ADANIGREEN','ADANIPOWER','TATAPOWER','HAL','BEL','CANBK','BANKBARODA','IRCTC','IRFC','PFC','RECLTD','JNKINDIA','MOSCHIP','MARKSANS','FINPIPE','JIOFIN'])
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-pro']

function classifyIntent(query: string): { symbols: string[]; topics: string[] } {
  const tokens = query.toUpperCase().split(/[^A-Z0-9&]+/).filter(t => t.length >= 3 && t.length <= 14)
  const tickers = new Set<string>()
  for (const t of tokens) {
    if (STOP_WORDS.has(t)) continue
    if (POPULAR_TICKERS.has(t) || /^[A-Z][A-Z&]{2,11}$/.test(t)) tickers.add(t)
  }
  const topics: string[] = []
  if (/SMART|MONEY|INSTITUTION|FII|DII|PROMOTER/i.test(query)) topics.push('smart-money')
  if (/OI|OPTION CHAIN|CE|PE|CALL|PUT|STRIKE/i.test(query)) topics.push('oi')
  if (/SL|STOP LOSS|HIT|TRAP|LIQUIDITY/i.test(query)) topics.push('sl-trap')
  if (/SECTOR|ROTATION|LEADING|LAGGING/i.test(query)) topics.push('sector')
  if (/LOSS|LOSING|DOWN|RED|FALL/i.test(query)) topics.push('loss')
  return { symbols: Array.from(tickers), topics }
}

async function loadChatContext(symbols: string[], topics: string[]): Promise<{ snippets: Record<string, any>; sources: string[] }> {
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
  const results = await Promise.all(Array.from(wanted).map(async name => {
    try {
      const res = await fetch(`${SNAPSHOT_BASE}/${name}.json?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) return { name, data: null }
      return { name, data: await res.json() }
    } catch { return { name, data: null } }
  }))
  for (const { name, data } of results) {
    if (!data) continue
    let payload: any = data
    if (symbols.length > 0 && data.rows && Array.isArray(data.rows)) {
      const matches = data.rows.filter((r: any) => {
        const s = String(r.symbol || r.instrument || '').toUpperCase()
        return symbols.some(t => s.includes(t) || (t.length >= 5 && t.includes(s.slice(0, 5))))
      })
      payload = { ...data, rows: matches.slice(0, 20) }
    } else if (data.rows && Array.isArray(data.rows)) {
      payload = { ...data, rows: data.rows.slice(0, 8) }
    } else if (data.signals && Array.isArray(data.signals)) {
      const matches = symbols.length > 0
        ? data.signals.filter((s: any) => symbols.some(t => String(s.symbol || '').toUpperCase().includes(t)))
        : data.signals.slice(0, 5)
      payload = { ...data, signals: matches.slice(0, 30) }
    }
    snippets[name] = payload
    sources.push(name)
  }
  return { snippets, sources }
}

async function callGeminiDirect(systemPrompt: string, userPrompt: string): Promise<{ text: string | null; error: string | null }> {
  if (!GEMINI_API_KEY) return { text: null, error: 'VITE_GEMINI_API_KEY not configured at build time' }
  let lastErr: string | null = null
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`
      const body = {
        contents: [{ role: 'user', parts: [{ text: systemPrompt + '\n\n---\n\nUSER:\n' + userPrompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
      }
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (res.ok) {
        const j: any = await res.json()
        const text = j?.candidates?.[0]?.content?.parts?.[0]?.text
        if (typeof text === 'string') return { text: text.trim(), error: null }
      } else {
        const t = await res.text().catch(() => '')
        if (res.status === 429) { lastErr = `${model}: quota exceeded`; continue }
        lastErr = `${model}: ${res.status} ${t.slice(0, 150)}`; continue
      }
    } catch (e: any) {
      lastErr = `${model}: ${e.message}`
    }
  }
  return { text: null, error: lastErr }
}

export const chat = {
  ask: async (query: string): Promise<{ answer: string; sourcesUsed: string[]; llmProvider: string; warnings: string[] }> => {
    const { symbols, topics } = classifyIntent(query)
    const { snippets, sources } = await loadChatContext(symbols, topics)
    const dataBlocks = Object.entries(snippets)
      .map(([name, data]) => `<data source="${name}">\n${JSON.stringify(data).slice(0, 4000)}\n</data>`)
      .join('\n\n')
    const userPrompt = `USER QUESTION: ${query}\n\nAVAILABLE DATA (do not invent any number not present below):\n${dataBlocks}\n\nAnswer the user using ONLY the data above. Cite source snapshots.`

    if (!GEMINI_API_KEY) {
      return {
        answer: `🔧 AI not configured. The site owner needs to set VITE_GEMINI_API_KEY as a Build env var in Vercel:\n\n1. Vercel Dashboard → tradewithvarsha → Settings → Environment Variables\n2. Add: VITE_GEMINI_API_KEY = (your free Gemini key from aistudio.google.com)\n3. Check "Production" + "Preview" + "Development"\n4. Save → trigger a fresh deploy\n\nUntil then, showing raw data:\n\n${symbols.length === 0 ? 'No stock ticker detected in your question.' : `For ${symbols.join(', ')}, see: ${sources.join(', ')}`}`,
        sourcesUsed: sources,
        llmProvider: 'fallback',
        warnings: ['VITE_GEMINI_API_KEY not set at build time'],
      }
    }

    const r = await callGeminiDirect(SYSTEM_PROMPT, userPrompt)
    if (r.text) {
      return { answer: r.text, sourcesUsed: sources, llmProvider: 'gemini', warnings: [] }
    }
    const warnings: string[] = []
    if (r.error && /quota|429|RESOURCE_EXHAUSTED/i.test(r.error)) {
      warnings.push('Gemini key has zero free-tier quota. Create a fresh key at aistudio.google.com/app/apikey.')
    } else if (r.error) {
      warnings.push(`Gemini: ${r.error.slice(0, 200)}`)
    }
    return {
      answer: `⚠️ Couldn't reach the AI right now.${warnings.length ? ' ' + warnings[0] : ''}\n\nFor ${symbols.length ? symbols.join(', ') : 'your query'}, snapshots loaded: ${sources.join(', ')}. Check the relevant tabs directly for now.`,
      sourcesUsed: sources,
      llmProvider: 'fallback',
      warnings,
    }
  },
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {})
  const t = auth.getToken()
  if (t) headers.set('Authorization', `Bearer ${t}`)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await fetch(`${API}${path}`, { ...init, headers })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  health: () => j<Health>('/api/health'),
  diagnose: () => j<{ healthy: boolean; checks: { service: string; ok: boolean; note?: string }[] }>('/api/diagnose'),
  signals: (params?: { type?: string; grade?: string; minScore?: number }) => {
    const q = new URLSearchParams()
    if (params?.type) q.set('type', params.type)
    if (params?.grade) q.set('grade', params.grade)
    if (params?.minScore != null) q.set('minScore', String(params.minScore))
    return j<{ signals: Signal[]; count: number }>(`/api/signals${q.toString() ? '?' + q : ''}`)
  },
  refreshSignals: () => j<{ signals: Signal[]; count: number }>('/api/signals/refresh', { method: 'POST' }),
  refreshAll: () => j<{ accepted: boolean; runId: string; startedAt: string; clicksRemaining: number }>('/api/refresh-all', { method: 'POST' }),
  refreshAllStatus: () => j<{ allowed: boolean; reason?: string; remaining: number; resetInSec?: number }>('/api/refresh-all/status'),
  signalForSymbol: (symbol: string) => j<{ signals: Signal[]; count: number }>(`/api/signal/${symbol}`),
  indices: () => j<{ indices: MarketIndex[] }>('/api/market/indices'),
  optionChain: (symbol: 'NIFTY' | 'BANKNIFTY') =>
    j<{ chain: OptionChain; analysis: OIAnalysis }>(`/api/options/${symbol}`),
  gann: (symbol: string, price?: number) => {
    const q = new URLSearchParams({ symbol })
    if (price) q.set('price', String(price))
    return j<{ symbol: string; bias: GannBias }>(`/api/gann?${q}`)
  },
  astro: (date?: string) => {
    const q = date ? `?date=${date}` : ''
    return j<{ date: string; bias: AstroBias }>(`/api/astro${q}`)
  },
  backtestSuite: () => j<{ results: BacktestResult[] }>('/api/backtest/suite'),
  backtest: (symbol: string, strategy: string, tf = '1D') =>
    j<BacktestResult>(`/api/backtest?symbol=${symbol}&strategy=${strategy}&tf=${tf}`),
  candles: (symbol: string, tf = '15m', count = 80) =>
    j<{ symbol: string; timeframe: string; candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[]; count: number }>(
      `/api/candles/${symbol}?tf=${tf}&count=${count}`,
    ),
  botStatus: () => j<{ running: boolean; configured: boolean; chatIds: number; startedAt: string | null }>('/api/bot/status'),

  // Top trades — single curated stream, ≥85 conviction, deduped by symbol.
  topTrades: (minConv = 85, limit = 20) =>
    j<{ generatedAt: string; filterMinConv: number; totalAvailable: number; rows: any[] }>(
      `/api/top-trades?minConv=${minConv}&limit=${limit}`,
    ),

  // Auth
  signup: (email: string, password: string) =>
    j<{ ok: boolean; error?: string; token?: string; user?: any }>('/api/auth/signup', {
      method: 'POST', body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    j<{ ok: boolean; error?: string; token?: string; user?: { email: string; isAdmin: boolean; expiryAt?: string; allowedTabs?: string[] } }>('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    }),
  me: () =>
    j<{ email: string; isAdmin: boolean; isActive: boolean; expiryAt?: string; allowedTabs: string[]; signupAt: string; lastLoginAt?: string }>('/api/auth/me'),
  logout: () => { auth.clear(); return j<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }) },
  changePassword: (oldPassword: string, newPassword: string) =>
    j<{ ok: boolean; error?: string }>('/api/auth/change-password', {
      method: 'POST', body: JSON.stringify({ oldPassword, newPassword }),
    }),
  adminUsers: () =>
    j<{ users: Array<{ email: string; isAdmin: boolean; isActive: boolean; expiryAt?: string; allowedTabs: string[]; signupAt: string; lastLoginAt?: string }> }>('/api/admin/users'),
  adminUpdateUser: (email: string, patch: { isActive?: boolean; expiryAt?: string | null; allowedTabs?: string[] }) =>
    j<{ ok: boolean; error?: string }>('/api/admin/user', {
      method: 'POST', body: JSON.stringify({ email, ...patch }),
    }),
}
