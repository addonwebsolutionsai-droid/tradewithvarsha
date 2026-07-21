/**
 * VP + FIB Confluence Scanner — the "PRO Trader Master" engine.
 *
 * Combines 7 institutional-grade setups into one confluence score per stock,
 * the same way a hedge fund desk stacks edges before pulling the trigger:
 *
 *   1. Volume Profile (POC · VAH · VAL · HVN · LVN)            — 20 pts
 *   2. Fibonacci retracement (golden-zone 61.8–78.6 + 50%)      — 15 pts
 *   3. Order Block (SMC — last opposing candle before impulse)  — 20 pts
 *   4. Liquidity Grab / Stop Sweep + reversal                   — 20 pts
 *   5. Elliott Wave count (W2 pullback · W3 underway · ABC)     — 10 pts
 *   6. Harmonic pattern PRZ (Gartley/Bat/Butterfly/Crab)        — 10 pts
 *   7. Volume Engine (relative volume spike ≥ 1.5×)             — 10 pts
 *
 *   Max = 105 → capped at 100. Bonus +5 for 5+ confluences aligning.
 *   Tier:
 *     · ELITE   ≥ 80  →  4+ confluences · full trade plan · 5★
 *     · STRONG  60-79 →  3+ confluences · trade plan · 3★
 *     · DECENT  40-59 →  2+ confluences · watch-list only · 2★
 *     · < 40   dropped.
 *
 * Reuses existing infrastructure:
 *   - buildVolumeProfile / detectSetups   (engine/volumeProfile.ts)
 *   - detectOrderBlock / detectLiquiditySweep  (engine/smcPatterns.ts)
 *   - elliott-wave.json snapshot          (joined by symbol)
 *   - harmonic.json snapshot              (joined by symbol)
 *
 * Fresh math added here:
 *   - Fibonacci retracement + extension from last significant swing
 *   - Composite confluence scoring
 *   - Tier-aware SL + guaranteed R:R ≥ 1:1 at T1
 *   - Volume-engine confluence (v5/v20 ratio)
 *
 * Original code, standard trading concepts (Volume Profile from Steidlmayer,
 * Fibonacci from Elliott, SMC vocabulary from ICT community).
 */

import fs from 'fs'
import path from 'path'
import { getCandles } from '../data/index'
import { buildVolumeProfile, detectSetups } from './volumeProfile'
import { detectOrderBlock, detectLiquiditySweep } from './smcPatterns'
import { resolveUniverse } from '../screeners/universe'
import { isEtfSymbol } from '../util/etfDetect'
import type { Candle } from '../types'
import { log } from '../util/logger'

// ─── Types ──────────────────────────────────────────────────────────

type Side = 'LONG' | 'SHORT'
type Tier = 'ELITE' | 'STRONG' | 'DECENT'

export interface Confluence {
  key: 'vp' | 'fib' | 'ob' | 'liq' | 'elliott' | 'harmonic' | 'volume'
  hit: boolean
  points: number
  detail: string
  level?: number     // key price level for this confluence
}

export interface VpFibRow {
  symbol: string
  side: Side
  ltp: number
  confluenceScore: number
  tier: Tier
  stars: 5 | 3 | 2
  confluencesHit: number       // count of hit confluences
  keyLevels: {
    poc?: number
    vah?: number
    val?: number
    fib618?: number
    fib786?: number
    obZone?: [number, number]  // [low, high]
  }
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  riskPct: number
  rewardT1Pct: number
  rrT1: number
  rrT2: number
  rrT3: number
  entryDate: string
  target1Date: string
  target2Date: string
  target3Date: string
  slDate: string
  confluences: Record<string, Confluence>
  reasoning: string[]
  unifiedReason: string
}

// ─── Helpers ────────────────────────────────────────────────────────

function atr14(candles: Candle[]): number {
  if (candles.length < 15) return 0
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  const last14 = trs.slice(-14)
  return last14.reduce((s, v) => s + v, 0) / last14.length
}

function istDateStr(ms: number): string {
  const d = new Date(ms + 5.5 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function addBusinessDays(fromMs: number, n: number): string {
  let d = new Date(fromMs)
  let added = 0
  while (added < n) {
    d = new Date(d.getTime() + 86_400_000)
    const day = d.getDay()
    if (day !== 0 && day !== 6) added++
  }
  return istDateStr(d.getTime())
}

/**
 * Detect the most recent significant swing (max high, min low over last N bars)
 * then compute Fibonacci retracements. Return TRUE if LTP is within tolerance
 * of the 50% / 61.8% / 78.6% level — the golden zone institutions accumulate in.
 */
function detectFibConfluence(candles: Candle[], ltp: number, atr: number, side: Side): Confluence {
  if (candles.length < 25) return { key: 'fib', hit: false, points: 0, detail: 'insufficient data' }
  const lookback = candles.slice(-40)
  let highIdx = 0, lowIdx = 0
  let hi = -Infinity, lo = Infinity
  for (let i = 0; i < lookback.length; i++) {
    if (lookback[i].high > hi) { hi = lookback[i].high; highIdx = i }
    if (lookback[i].low < lo) { lo = lookback[i].low; lowIdx = i }
  }
  if (hi <= lo) return { key: 'fib', hit: false, points: 0, detail: 'no swing detected' }
  const range = hi - lo
  const tol = Math.max(atr * 0.5, ltp * 0.005)   // wider of 0.5×ATR or 0.5% of price

  // Direction of the impulse determines what a retracement means:
  // if high came AFTER low → uptrend → retracement is fib from high down
  // if low came AFTER high → downtrend → retracement is fib from low up
  const uptrend = highIdx > lowIdx
  if (uptrend) {
    const fib382 = hi - range * 0.382
    const fib500 = hi - range * 0.500
    const fib618 = hi - range * 0.618
    const fib786 = hi - range * 0.786
    // LONG confluence: LTP within golden zone (61.8-78.6) of an uptrend retracement
    if (side === 'LONG') {
      if (Math.abs(ltp - fib618) <= tol) return { key: 'fib', hit: true, points: 15, level: fib618, detail: `LTP at 61.8% golden-zone retracement (₹${fib618.toFixed(2)}) of the last swing ₹${lo.toFixed(2)}→₹${hi.toFixed(2)}` }
      if (Math.abs(ltp - fib786) <= tol) return { key: 'fib', hit: true, points: 15, level: fib786, detail: `LTP at 78.6% deep retracement (₹${fib786.toFixed(2)}) — last-chance institutional buy zone` }
      if (Math.abs(ltp - fib500) <= tol) return { key: 'fib', hit: true, points: 10, level: fib500, detail: `LTP at 50% retracement (₹${fib500.toFixed(2)})` }
      if (Math.abs(ltp - fib382) <= tol) return { key: 'fib', hit: true, points: 8, level: fib382, detail: `LTP at 38.2% shallow retracement (₹${fib382.toFixed(2)})` }
    }
  } else {
    // Downtrend swing: fib retracements go UP from low, so LTP inside golden zone = short opportunity
    const fib382 = lo + range * 0.382
    const fib500 = lo + range * 0.500
    const fib618 = lo + range * 0.618
    const fib786 = lo + range * 0.786
    if (side === 'SHORT') {
      if (Math.abs(ltp - fib618) <= tol) return { key: 'fib', hit: true, points: 15, level: fib618, detail: `LTP at 61.8% golden-zone retracement (₹${fib618.toFixed(2)}) of downtrend — institutional short zone` }
      if (Math.abs(ltp - fib786) <= tol) return { key: 'fib', hit: true, points: 15, level: fib786, detail: `LTP at 78.6% deep retracement — last-chance short` }
      if (Math.abs(ltp - fib500) <= tol) return { key: 'fib', hit: true, points: 10, level: fib500, detail: `LTP at 50% retracement (₹${fib500.toFixed(2)})` }
      if (Math.abs(ltp - fib382) <= tol) return { key: 'fib', hit: true, points: 8, level: fib382, detail: `LTP at 38.2% shallow retracement (₹${fib382.toFixed(2)})` }
    }
  }
  return { key: 'fib', hit: false, points: 0, detail: 'no fib golden-zone touch' }
}

/**
 * Order Block confluence: reuses smcPatterns.detectOrderBlock.
 * Directional alignment required — only counts if the OB matches trade side.
 */
function detectObConfluence(candles: Candle[], side: Side): Confluence {
  const ob = detectOrderBlock(candles)
  if (!ob) return { key: 'ob', hit: false, points: 0, detail: 'no order block' }
  const wantBullish = side === 'LONG'
  if (ob.bullish !== wantBullish) return { key: 'ob', hit: false, points: 0, detail: 'OB opposes trade side' }
  return { key: 'ob', hit: true, points: 20, detail: ob.detail }
}

/**
 * Liquidity Grab confluence: reuses smcPatterns.detectLiquiditySweep.
 * Textbook stop-hunt pattern that precedes real institutional entry.
 */
function detectLiqConfluence(candles: Candle[], side: Side): Confluence {
  const sweep = detectLiquiditySweep(candles)
  if (!sweep) return { key: 'liq', hit: false, points: 0, detail: 'no liquidity sweep' }
  const wantBullish = side === 'LONG'
  if (sweep.bullish !== wantBullish) return { key: 'liq', hit: false, points: 0, detail: 'sweep opposes trade side' }
  return { key: 'liq', hit: true, points: 20, detail: sweep.detail }
}

/**
 * Volume Engine confluence: relative-volume spike vs 20-day average.
 * ≥1.5× = institutional footprint, ≥2× = full accumulation/distribution day.
 */
function detectVolConfluence(candles: Candle[]): Confluence {
  if (candles.length < 25) return { key: 'volume', hit: false, points: 0, detail: 'insufficient data' }
  const v5 = candles.slice(-5).reduce((s, c) => s + (c.volume || 0), 0) / 5
  const v20 = candles.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20
  if (v20 <= 0) return { key: 'volume', hit: false, points: 0, detail: 'no volume data' }
  const ratio = v5 / v20
  if (ratio >= 2) return { key: 'volume', hit: true, points: 10, detail: `5-day vol ${ratio.toFixed(1)}× the 20-day avg — full accumulation` }
  if (ratio >= 1.5) return { key: 'volume', hit: true, points: 8, detail: `5-day vol ${ratio.toFixed(1)}× the 20-day avg — institutional footprint` }
  if (ratio >= 1.2) return { key: 'volume', hit: true, points: 5, detail: `5-day vol ${ratio.toFixed(1)}× the 20-day avg — mild expansion` }
  return { key: 'volume', hit: false, points: 0, detail: `vol ratio ${ratio.toFixed(2)}× — no expansion` }
}

/**
 * Volume Profile confluence: LTP at POC / VAH / VAL / HVN.
 * Reuses buildVolumeProfile from the shared engine.
 */
function detectVpConfluence(candles: Candle[], ltp: number, atr: number, side: Side): {
  confluence: Confluence
  keyLevels: { poc?: number; vah?: number; val?: number }
} {
  const profile = buildVolumeProfile(candles, 40, '1D')
  if (!profile) return { confluence: { key: 'vp', hit: false, points: 0, detail: 'profile build failed' }, keyLevels: {} }
  const tol = Math.max(atr * 0.4, ltp * 0.005)
  const { poc, vah, val, hvn } = profile
  // Trade side alignment:
  //   LONG at POC/VAL = mean-revert buy at value floor
  //   LONG at VAH breakout confirmed by close above = continuation
  //   SHORT at VAH/POC = rejection short
  //   SHORT at VAL breakdown = continuation
  if (side === 'LONG') {
    if (Math.abs(ltp - val) <= tol) return { confluence: { key: 'vp', hit: true, points: 20, level: val, detail: `LTP at VAL ₹${val.toFixed(2)} — value-area floor buy zone` }, keyLevels: { poc, vah, val } }
    if (Math.abs(ltp - poc) <= tol) return { confluence: { key: 'vp', hit: true, points: 18, level: poc, detail: `LTP at POC ₹${poc.toFixed(2)} — auction fair-value magnet` }, keyLevels: { poc, vah, val } }
    if (ltp > vah && candles[candles.length - 1].close > vah) return { confluence: { key: 'vp', hit: true, points: 15, level: vah, detail: `Close above VAH ₹${vah.toFixed(2)} — value-area breakout continuation` }, keyLevels: { poc, vah, val } }
    for (const h of hvn) {
      if (Math.abs(ltp - h) <= tol) return { confluence: { key: 'vp', hit: true, points: 12, level: h, detail: `LTP at HVN ₹${h.toFixed(2)} — high-volume node support` }, keyLevels: { poc, vah, val } }
    }
  } else {
    if (Math.abs(ltp - vah) <= tol) return { confluence: { key: 'vp', hit: true, points: 20, level: vah, detail: `LTP at VAH ₹${vah.toFixed(2)} — value-area ceiling short zone` }, keyLevels: { poc, vah, val } }
    if (Math.abs(ltp - poc) <= tol) return { confluence: { key: 'vp', hit: true, points: 18, level: poc, detail: `LTP at POC ₹${poc.toFixed(2)} — auction fair-value magnet` }, keyLevels: { poc, vah, val } }
    if (ltp < val && candles[candles.length - 1].close < val) return { confluence: { key: 'vp', hit: true, points: 15, level: val, detail: `Close below VAL ₹${val.toFixed(2)} — value-area breakdown` }, keyLevels: { poc, vah, val } }
  }
  return { confluence: { key: 'vp', hit: false, points: 0, detail: 'LTP not at key VP level' }, keyLevels: { poc, vah, val } }
}

// ─── Elliott / Harmonic snapshot join ───────────────────────────────

function readSnapshot(name: string): any | null {
  try {
    const p = path.resolve(process.cwd(), 'data', 'public-snapshots', name)
    if (!fs.existsSync(p)) return null
    const raw = fs.readFileSync(p, 'utf-8')
    return JSON.parse(raw)
  } catch { return null }
}

function buildElliottMap(): Map<string, any> {
  const snap = readSnapshot('elliott-wave.json')
  const m = new Map<string, any>()
  if (!snap || !Array.isArray(snap.rows)) return m
  for (const r of snap.rows) if (r?.symbol) m.set(String(r.symbol).toUpperCase(), r)
  return m
}
function buildHarmonicMap(): Map<string, any> {
  const snap = readSnapshot('harmonic.json')
  const m = new Map<string, any>()
  if (!snap || !Array.isArray(snap.rows)) return m
  for (const r of snap.rows) if (r?.symbol) m.set(String(r.symbol).toUpperCase(), r)
  return m
}

function elliottConfluence(hit: any | undefined, side: Side): Confluence {
  if (!hit) return { key: 'elliott', hit: false, points: 0, detail: 'no active wave count' }
  const w = String(hit.wave || hit.setup || hit.type || '').toUpperCase()
  const bull = /BULLISH|LONG|UP/.test(String(hit.direction || hit.bias || ''))
  const wantBull = side === 'LONG'
  if (bull !== wantBull) return { key: 'elliott', hit: false, points: 0, detail: `wave count ${w} on opposite side` }
  const points = /WAVE_3|W3/.test(w) ? 10 : /WAVE_2|W2/.test(w) ? 9 : /ABC/.test(w) ? 7 : 6
  return { key: 'elliott', hit: true, points, detail: `${w} · ${hit.detail || hit.reason || 'active wave count'}` }
}
function harmonicConfluence(hit: any | undefined, side: Side): Confluence {
  if (!hit) return { key: 'harmonic', hit: false, points: 0, detail: 'no harmonic pattern' }
  const bull = /BULLISH|LONG|UP/.test(String(hit.direction || hit.side || hit.bias || ''))
  const wantBull = side === 'LONG'
  if (bull !== wantBull) return { key: 'harmonic', hit: false, points: 0, detail: `${hit.pattern || 'harmonic'} pattern on opposite side` }
  const pattern = hit.pattern || hit.name || 'harmonic'
  return { key: 'harmonic', hit: true, points: 10, detail: `${pattern} PRZ hit · ${hit.detail || hit.reason || 'reversal zone reached'}` }
}

// ─── Tier-aware SL + guaranteed R:R (same as onDemandScan) ──────────

function slDistanceFor(entry: number, atr: number, symbol: string): number {
  const isIndex = /^\^|NIFTY|SENSEX|BANKNIFTY|FINNIFTY|MIDCP|VIX/i.test(symbol)
  const isCommodityFx = /=[FX]$|-USD|=X|GOLD|SILVER|CRUDE|OIL|COPPER|NATGAS|XAU|XAG|BTC|ETH|USDINR|EURUSD|DXY/i.test(symbol)
  if (isIndex) return Math.min(entry * 0.02, Math.max(atr * 1.2, entry * 0.008))
  if (isCommodityFx) return Math.min(entry * 0.05, Math.max(atr * 1.5, entry * 0.02))
  const cap = entry >= 500 ? 0.05 : entry >= 100 ? 0.055 : entry >= 20 ? 0.065 : 0.08
  return Math.min(entry * cap, Math.max(atr * 1.5, entry * 0.025))
}

// ─── Main scanner ───────────────────────────────────────────────────

async function scanOneSymbol(
  symbol: string,
  elliottMap: Map<string, any>,
  harmonicMap: Map<string, any>,
): Promise<VpFibRow | null> {
  const candles = await getCandles(symbol, '1D', 100)
  if (!candles || candles.length < 30) return null
  const last = candles[candles.length - 1]
  const ltp = last.close
  const atr = atr14(candles)
  if (atr <= 0) return null

  // Try both sides; take the higher-scoring one.
  const scoreSide = (side: Side): { row: VpFibRow | null; total: number } => {
    const vpOut = detectVpConfluence(candles, ltp, atr, side)
    const fib = detectFibConfluence(candles, ltp, atr, side)
    const ob = detectObConfluence(candles, side)
    const liq = detectLiqConfluence(candles, side)
    const vol = detectVolConfluence(candles)
    const elliott = elliottConfluence(elliottMap.get(symbol.toUpperCase()), side)
    const harm = harmonicConfluence(harmonicMap.get(symbol.toUpperCase()), side)

    const confluences: Record<string, Confluence> = {
      vp: vpOut.confluence, fib, ob, liq, volume: vol, elliott, harmonic: harm,
    }
    const hitCount = Object.values(confluences).filter(c => c.hit).length
    let total = Object.values(confluences).reduce((s, c) => s + c.points, 0)
    if (hitCount >= 5) total += 5   // multi-confluence bonus
    total = Math.min(100, total)

    if (hitCount < 2 || total < 40) return { row: null, total }

    const tier: Tier = total >= 80 ? 'ELITE' : total >= 60 ? 'STRONG' : 'DECENT'
    const stars: 5 | 3 | 2 = tier === 'ELITE' ? 5 : tier === 'STRONG' ? 3 : 2
    const now = Date.now()
    const slDist = slDistanceFor(ltp, atr, symbol)
    const t1Dist = Math.max(atr * 1.5, slDist * 1.2)
    const t2Dist = Math.max(atr * 3.0, slDist * 2.2)
    const t3Dist = Math.max(atr * 5.0, slDist * 3.2)

    const entry = ltp
    const stopLoss = side === 'LONG' ? entry - slDist : entry + slDist
    const target1 = side === 'LONG' ? entry + t1Dist : entry - t1Dist
    const target2 = side === 'LONG' ? entry + t2Dist : entry - t2Dist
    const target3 = side === 'LONG' ? entry + t3Dist : entry - t3Dist

    const reasoning: string[] = []
    for (const c of Object.values(confluences)) {
      if (c.hit) reasoning.push(`[${c.key.toUpperCase()}] ${c.detail}`)
    }

    const row: VpFibRow = {
      symbol,
      side,
      ltp: Math.round(ltp * 100) / 100,
      confluenceScore: total,
      tier,
      stars,
      confluencesHit: hitCount,
      keyLevels: {
        poc: vpOut.keyLevels.poc,
        vah: vpOut.keyLevels.vah,
        val: vpOut.keyLevels.val,
        fib618: fib.hit && /61\.8/.test(fib.detail) ? fib.level : undefined,
        fib786: fib.hit && /78\.6/.test(fib.detail) ? fib.level : undefined,
      },
      entry: Math.round(entry * 100) / 100,
      stopLoss: Math.round(stopLoss * 100) / 100,
      target1: Math.round(target1 * 100) / 100,
      target2: Math.round(target2 * 100) / 100,
      target3: Math.round(target3 * 100) / 100,
      riskPct: Math.round((slDist / entry) * 10000) / 100,
      rewardT1Pct: Math.round((t1Dist / entry) * 10000) / 100,
      rrT1: Math.round((t1Dist / slDist) * 100) / 100,
      rrT2: Math.round((t2Dist / slDist) * 100) / 100,
      rrT3: Math.round((t3Dist / slDist) * 100) / 100,
      entryDate: istDateStr(now),
      target1Date: addBusinessDays(now, 3),
      target2Date: addBusinessDays(now, 6),
      target3Date: addBusinessDays(now, 10),
      slDate: addBusinessDays(now, 8),
      confluences,
      reasoning,
      unifiedReason: reasoning.join(' · '),
    }
    return { row, total }
  }

  const longR = scoreSide('LONG')
  const shortR = scoreSide('SHORT')
  if (!longR.row && !shortR.row) return null
  if (!longR.row) return shortR.row
  if (!shortR.row) return longR.row
  return longR.total >= shortR.total ? longR.row : shortR.row
}

/**
 * Run the scanner over a universe.
 *
 * Default coverage is FULL Indian market (MARKET_ALL — NSE + BSE, ~11.5k
 * equities from ScripMaster). Intraday-tick cron uses a smaller universe
 * (existing signal snapshots) for speed; EOD tick covers the whole thing.
 *
 * `maxRuntimeMs` gates the scan — as soon as budget is exceeded we stop
 * spawning new symbols and return what we have. This lets the 5-min
 * intraday cron scan MARKET_ALL without ever blowing its budget.
 */
export async function scanVpFibConfluence(opts?: {
  universe?: string[] | 'MARKET_ALL' | 'NSE_ALL' | 'BSE_ALL' | 'CNX500' | 'DEFAULT'
  concurrency?: number
  limit?: number
  maxRuntimeMs?: number
  /** Set true to KEEP ETFs in the scan (default false — the main desk feed
   *  drops them). Used by the ETF-tab scan in highQualitySetups.ts. */
  includeEtfs?: boolean
  /** Set true to scan ETFs EXCLUSIVELY (universe filtered to ETFs only). */
  onlyEtfs?: boolean
}): Promise<{
  generatedAt: string
  universe: string
  scanned: number
  attempted: number
  eliteCount: number
  strongCount: number
  decentCount: number
  runtimeMs: number
  rows: VpFibRow[]
}> {
  const elliottMap = buildElliottMap()
  const harmonicMap = buildHarmonicMap()

  // Resolve universe. Symbols → use verbatim. Universe key → look up.
  let seed: string[] = []
  let universeLabel = 'DEFAULT'
  if (Array.isArray(opts?.universe)) {
    seed = opts!.universe as string[]
    universeLabel = 'CUSTOM'
  } else {
    const key = (opts?.universe as string) ?? 'DEFAULT'
    universeLabel = key
    if (key === 'DEFAULT') {
      seed = await buildDefaultUniverse()
    } else {
      try {
        seed = await resolveUniverse(key)
      } catch (e) {
        log.warn('VP-FIB', `resolveUniverse(${key}) failed, falling back to DEFAULT: ${(e as Error).message}`)
        seed = await buildDefaultUniverse()
        universeLabel = 'DEFAULT_FALLBACK'
      }
    }
  }

  // ETF handling:
  //   default        → drop ETFs (stock-only feed for desk)
  //   includeEtfs    → keep both stocks and ETFs
  //   onlyEtfs       → keep ONLY ETFs (used by the addon ETF-tab scan)
  const preFilter = Array.from(new Set(seed.map(s => s.toUpperCase()))).filter(Boolean)
  const uniq = opts?.onlyEtfs
    ? preFilter.filter(s => isEtfSymbol(s))
    : opts?.includeEtfs
      ? preFilter
      : preFilter.filter(s => !isEtfSymbol(s))
  const dropped = preFilter.length - uniq.length
  if (dropped > 0) log.info('VP-FIB', `filter dropped ${dropped} symbols (mode=${opts?.onlyEtfs ? 'ETFs-only' : opts?.includeEtfs ? 'include-ETFs' : 'stocks-only'})`)
  const targets = opts?.limit ? uniq.slice(0, opts.limit) : uniq
  const concurrency = opts?.concurrency ?? 20
  const maxRuntimeMs = opts?.maxRuntimeMs ?? 8 * 60_000   // 8 min default

  log.info('VP-FIB', `scanning ${targets.length} candidates · universe=${universeLabel} · concurrency=${concurrency} · budget=${(maxRuntimeMs / 1000).toFixed(0)}s · elliott ${elliottMap.size} · harmonic ${harmonicMap.size}`)

  const t0 = Date.now()
  const results: VpFibRow[] = []
  let i = 0
  let attempted = 0
  const runners = Array.from({ length: concurrency }, async () => {
    while (i < targets.length) {
      if (Date.now() - t0 > maxRuntimeMs) break   // time-budget gate
      const sym = targets[i++]
      attempted++
      try {
        const row = await scanOneSymbol(sym, elliottMap, harmonicMap)
        if (row) results.push(row)
      } catch (e) {
        // Silent skip — one bad symbol shouldn't tank the whole scan.
      }
    }
  })
  await Promise.all(runners)

  results.sort((a, b) => b.confluenceScore - a.confluenceScore)

  const eliteCount = results.filter(r => r.tier === 'ELITE').length
  const strongCount = results.filter(r => r.tier === 'STRONG').length
  const decentCount = results.filter(r => r.tier === 'DECENT').length
  const runtimeMs = Date.now() - t0

  // Cap output to keep snapshot small enough for the browser to fetch quickly.
  // Elite + Strong are ALWAYS kept in full — those are the actionable tier.
  // Decent is capped so the whole snapshot stays roughly under ~600KB.
  const elites = results.filter(r => r.tier === 'ELITE')
  const strongs = results.filter(r => r.tier === 'STRONG')
  const decents = results.filter(r => r.tier === 'DECENT')
  const DECENT_KEEP = 150
  const capped = [...elites, ...strongs, ...decents.slice(0, DECENT_KEEP)]

  // Trim non-hit confluence detail strings — they're always the same "no
  // touch" boilerplate and bloat the payload. Hit confluences keep their
  // full detail (that's the interesting narrative the UI shows).
  for (const r of capped) {
    for (const key of Object.keys(r.confluences)) {
      const c = r.confluences[key]
      if (!c.hit) c.detail = ''      // client's tooltip skips empty strings
    }
  }

  log.info('VP-FIB', `done · attempted ${attempted}/${targets.length} · ${results.length} setups (${eliteCount} elite · ${strongCount} strong · ${decentCount} decent · kept ${capped.length}) · ${(runtimeMs / 1000).toFixed(1)}s`)

  return {
    generatedAt: new Date().toISOString(),
    universe: universeLabel,
    scanned: attempted,
    attempted,
    eliteCount, strongCount, decentCount,
    runtimeMs,
    rows: capped,
  }
}

/**
 * Default scanner universe: read every existing high-signal snapshot on
 * disk + the full F&O leader list. This is intentionally BIG — the
 * confluence gate (2+ lenses · score ≥ 40) does the filtering. On the
 * dev box with ScripMaster loaded, this typically yields 2-4k candidates
 * (the top-of-market that other scanners have already flagged).
 */
async function buildDefaultUniverse(): Promise<string[]> {
  const seed = new Set<string>()
  const feeds = [
    'elliott-wave.json', 'harmonic.json', 'stock-fno-volume-profile.json',
    'chart-patterns.json', 'weekly-pick.json', 'daily-pick.json',
    'pro-edge.json', 'cross-confluence.json', 'ad-divergence.json',
    'early-momentum.json', 'pedigree-accumulation.json', 'bulk-deals.json',
    'insider-buys.json', 'oi-buildup.json',
  ]
  for (const name of feeds) {
    const snap = readSnapshot(name)
    if (snap && Array.isArray(snap.rows)) {
      for (const r of snap.rows) if (r?.symbol) seed.add(String(r.symbol).toUpperCase())
    }
    // Some snapshots use `signals` instead of `rows`
    if (snap && Array.isArray(snap.signals)) {
      for (const s of snap.signals) if (s?.symbol) seed.add(String(s.symbol).toUpperCase())
    }
  }
  for (const s of TOP_FNO_LEADERS) seed.add(s)
  return Array.from(seed)
}

const TOP_FNO_LEADERS = [
  'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','SBIN','AXISBANK','ITC','LT','BHARTIARTL',
  'BAJFINANCE','KOTAKBANK','MARUTI','ASIANPAINT','TATAMOTORS','TATASTEEL','ONGC','HCLTECH','WIPRO','ULTRACEMCO',
  'NTPC','POWERGRID','ADANIENT','ADANIPORTS','BAJAJFINSV','JSWSTEEL','HINDUNILVR','NESTLEIND','COALINDIA','INDUSINDBK',
  'SUNPHARMA','EICHERMOT','HEROMOTOCO','BRITANNIA','DRREDDY','GRASIM','TITAN','DIVISLAB','BPCL','CIPLA',
  'TECHM','HDFCLIFE','SBILIFE','ADANIGREEN','TATAPOWER','HAL','BEL','CANBK','BANKBARODA','JIOFIN',
  'MOTHERSON','TRENT','APOLLOHOSP','PIDILITIND','GODREJCP','BAJAJ-AUTO','DABUR','MARICO','HAVELLS','SHREECEM',
  'DLF','LODHA','GODREJPROP','OBEROIRLTY','MAHIND','TVSMOTOR','ASHOKLEY','PVRINOX','PAYTM','ZOMATO',
  'IRCTC','IRFC','PFC','RECLTD','LICI','CHOLAFIN','SHRIRAMFIN','MUTHOOTFIN','MANAPPURAM','BANDHANBNK',
  'IEX','MCX','NAM-INDIA','ABFRL','TATACHEM','DEEPAKNTR','CROMPTON','WHIRLPOOL','VOLTAS','BLUESTARCO',
]

/** Write the scanner output to the public-snapshots directory. */
export async function writeVpFibSnapshot(out: {
  generatedAt: string
  scanned: number
  eliteCount: number
  strongCount: number
  decentCount: number
  rows: VpFibRow[]
}): Promise<void> {
  const p = path.resolve(process.cwd(), 'data', 'public-snapshots', 'vp-fib.json')
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf-8')
  log.info('VP-FIB', `wrote snapshot → ${p} (${out.rows.length} rows)`)
}
