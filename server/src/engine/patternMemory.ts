/**
 * Pattern Memory — per user directive 2026-06-24:
 *   "Whenever target hit, you keep the pattern or chart pattern in the mind,
 *    for scanning new signals. This can help you too."
 *
 * When the lifecycle marks a signal T1_HIT / T2_HIT / T3_HIT, we snapshot the
 * 30-candle daily fingerprint that preceded entry (volatility regime,
 * EMA stack, ADX, RSI band, volume ratio, base tightness, range, gap). The
 * fingerprint is appended to `winning-patterns.json`.
 *
 * Future scans compute the SAME fingerprint for live candidates and a fast
 * lookup awards +5 conviction when the live fingerprint is within tolerance
 * of any historic winner. Memory is bounded to 500 patterns (FIFO).
 */
import fs from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import type { Candle } from '../types'

const DATA_DIR = path.resolve(__dirname, '../../data')
const PATTERN_FILE = path.join(DATA_DIR, 'winning-patterns.json')
const MAX_PATTERNS = 500

export interface PatternFingerprint {
  symbol: string
  status: 'T1_HIT' | 'T2_HIT' | 'T3_HIT'
  direction: 'BUY' | 'SHORT'
  capturedAt: string
  /** Avg true range as % of close, 14-period */
  atrPct: number
  /** EMA stack: 9>21>50>200 bullish, 9<21<50<200 bearish, 0 mixed */
  emaStack: -2 | -1 | 0 | 1 | 2
  /** ADX 14 */
  adx: number
  /** RSI 14 */
  rsi: number
  /** vol5d / vol60d ratio */
  volRatio: number
  /** 20-day range as % of close (tightness) */
  range20Pct: number
  /** Days within ±2% of close in last 20 sessions (consolidation count) */
  baseDays: number
  /** Position vs 20d high: 0 = at high, 1 = 100% below high */
  distFrom20High: number
}

export interface PatternStore {
  patterns: PatternFingerprint[]
  lastUpdated: string
}

let cached: PatternStore | null = null

async function load(): Promise<PatternStore> {
  if (cached) return cached
  try {
    const raw = await fs.readFile(PATTERN_FILE, 'utf8')
    cached = JSON.parse(raw)
    return cached!
  } catch {
    cached = { patterns: [], lastUpdated: '' }
    return cached
  }
}

async function save(store: PatternStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(PATTERN_FILE, JSON.stringify(store, null, 2), 'utf8')
  cached = store
}

/**
 * Compute the fingerprint for the last 30 candles. Returns null if not enough data.
 */
export function computeFingerprint(candles: Candle[]): Omit<PatternFingerprint, 'symbol' | 'status' | 'direction' | 'capturedAt'> | null {
  if (!candles || candles.length < 30) return null
  const window = candles.slice(-30)
  const last = window[window.length - 1]
  if (!last || !Number.isFinite(last.close)) return null

  const ema = (period: number): number => {
    const k = 2 / (period + 1)
    let e = window[0].close
    for (let i = 1; i < window.length; i++) e = window[i].close * k + e * (1 - k)
    return e
  }
  const e9 = ema(9), e21 = ema(21), e50 = ema(Math.min(50, window.length)), e200 = ema(Math.min(200, window.length))
  let emaStack: PatternFingerprint['emaStack'] = 0
  if (e9 > e21 && e21 > e50 && e50 > e200) emaStack = 2
  else if (e9 > e21 && e21 > e50) emaStack = 1
  else if (e9 < e21 && e21 < e50 && e50 < e200) emaStack = -2
  else if (e9 < e21 && e21 < e50) emaStack = -1

  // ATR 14
  let trSum = 0, n = 0
  for (let i = Math.max(1, window.length - 14); i < window.length; i++) {
    const prev = window[i - 1]
    const cur = window[i]
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close))
    trSum += tr
    n++
  }
  const atr = n > 0 ? trSum / n : 0
  const atrPct = last.close > 0 ? (atr / last.close) * 100 : 0

  // RSI 14
  let gains = 0, losses = 0
  for (let i = window.length - 14; i < window.length; i++) {
    if (i <= 0) continue
    const diff = window[i].close - window[i - 1].close
    if (diff > 0) gains += diff
    else losses -= diff
  }
  const rs = losses > 0 ? gains / losses : 100
  const rsi = 100 - (100 / (1 + rs))

  // ADX 14 (simplified)
  let dmPlus = 0, dmMinus = 0
  for (let i = Math.max(1, window.length - 14); i < window.length; i++) {
    const up = window[i].high - window[i - 1].high
    const dn = window[i - 1].low - window[i].low
    if (up > dn && up > 0) dmPlus += up
    if (dn > up && dn > 0) dmMinus += dn
  }
  const dx = (dmPlus + dmMinus) > 0 ? Math.abs(dmPlus - dmMinus) / (dmPlus + dmMinus) * 100 : 0
  const adx = dx   // single-period proxy

  // Volume ratio
  const recent5 = window.slice(-5)
  const v5 = recent5.reduce((s, c) => s + c.volume, 0) / 5
  const v60 = candles.slice(-60).reduce((s, c) => s + c.volume, 0) / Math.min(60, candles.length)
  const volRatio = v60 > 0 ? v5 / v60 : 1

  // 20-day range tightness
  const last20 = candles.slice(-20)
  const hi20 = Math.max(...last20.map(c => c.high))
  const lo20 = Math.min(...last20.map(c => c.low))
  const range20Pct = last.close > 0 ? ((hi20 - lo20) / last.close) * 100 : 0

  // Base days — within ±2% of close
  let baseDays = 0
  for (const c of last20) {
    if (Math.abs(c.close - last.close) / last.close < 0.02) baseDays++
  }
  const distFrom20High = hi20 > 0 ? (hi20 - last.close) / hi20 : 0

  return {
    atrPct: +atrPct.toFixed(2),
    emaStack,
    adx: +adx.toFixed(1),
    rsi: +rsi.toFixed(1),
    volRatio: +volRatio.toFixed(2),
    range20Pct: +range20Pct.toFixed(2),
    baseDays,
    distFrom20High: +distFrom20High.toFixed(3),
  }
}

/**
 * Called by the lifecycle when a target hits. Stores the fingerprint of the
 * candles up to the ENTRY date (not the hit date) so we learn the SETUP.
 */
export async function recordWinningPattern(opts: {
  symbol: string
  status: 'T1_HIT' | 'T2_HIT' | 'T3_HIT'
  direction: 'BUY' | 'SHORT'
  candlesAtEntry: Candle[]
}): Promise<void> {
  const fp = computeFingerprint(opts.candlesAtEntry)
  if (!fp) return
  const store = await load()
  store.patterns.unshift({
    symbol: opts.symbol,
    status: opts.status,
    direction: opts.direction,
    capturedAt: new Date().toISOString(),
    ...fp,
  })
  // FIFO cap
  store.patterns = store.patterns.slice(0, MAX_PATTERNS)
  store.lastUpdated = new Date().toISOString()
  await save(store)
  log.ok('PATTERN-MEM', `Captured winning pattern: ${opts.symbol} ${opts.status} (stack=${fp.emaStack}, adx=${fp.adx}, rsi=${fp.rsi}, vol=${fp.volRatio}×)`)
}

/**
 * Live-scan helper: returns true if the candidate's fingerprint is similar to
 * any known winner (same direction). Tolerance is per-feature.
 */
export async function matchesKnownWinner(opts: {
  candles: Candle[]
  direction: 'BUY' | 'SHORT'
}): Promise<{ match: boolean; winnerSymbol?: string; status?: string }> {
  const fp = computeFingerprint(opts.candles)
  if (!fp) return { match: false }
  const store = await load()
  for (const w of store.patterns) {
    if (w.direction !== opts.direction) continue
    // Tolerances chosen to be tight enough to mean "same setup type"
    if (w.emaStack !== fp.emaStack) continue
    if (Math.abs(w.adx - fp.adx) > 12) continue
    if (Math.abs(w.rsi - fp.rsi) > 12) continue
    if (Math.abs(w.atrPct - fp.atrPct) > 1.5) continue
    if (Math.abs(w.volRatio - fp.volRatio) > 1.0) continue
    if (Math.abs(w.range20Pct - fp.range20Pct) > 6) continue
    return { match: true, winnerSymbol: w.symbol, status: w.status }
  }
  return { match: false }
}

export async function getPatternStore(): Promise<PatternStore> {
  return load()
}
