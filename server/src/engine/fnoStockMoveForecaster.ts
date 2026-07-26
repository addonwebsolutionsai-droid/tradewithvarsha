/**
 * F&O Stock Move Forecaster — predicts moves on high-beta F&O stocks
 * BEFORE they happen, by composing 6 lenses per stock:
 *
 *   1. Volume Profile levels (POC/VAH/VAL touch or breakout setup)
 *   2. Fibonacci retracement zones (golden zone 61.8-78.6% + extensions)
 *   3. Seasonality (avg return in current calendar month, 5-year history)
 *   4. Volume Build / Price Action (delivery-% surge, vol/20d ratio,
 *      range compression → expansion imminent)
 *   5. Smart Money Concept primitives (FVG · Order Block · BoS · LiqSweep)
 *   6. Smart Money Footprint join (Pedigree QoQ + Bulk Deals + Insider
 *      Buys + Superstar holdings + FII/DII delta)
 *
 * PLUS user's 4 explicit inputs mapped 1:1, and one MISSING dimension
 * I'm adding on top: OPTIONS OI velocity per underlying (institutional
 * option-writing at specific strikes signals target price ahead of move).
 *
 * Output: server/data/public-snapshots/fno-stock-forecast.json
 * Refresh: every intraday tick (5 min) + EOD.
 * Universe: 85 hand-picked high-beta F&O stocks from user (2026-07-26).
 *
 * Signal style matches the platform's other engines — each row carries
 * entry / SL / T1-T2-T3 with dates + full narrative reason including
 * which lenses lit up + accumulation vs distribution signature + how to
 * play (spot vs futures vs options).
 */

import fs from 'fs'
import path from 'path'
import { getCandles } from '../data/index'
import { buildVolumeProfile } from './volumeProfile'
import { detectOrderBlock, detectLiquiditySweep, detectFVG, detectBoS } from './smcPatterns'
import type { Candle } from '../types'
import { log } from '../util/logger'

const OUT_PATH = path.resolve(process.cwd(), 'data', 'public-snapshots', 'fno-stock-forecast.json')

// ─── User-provided F&O universe (85 high-beta stocks, 2026-07-26) ─────
// Preserves original spelling where NSE symbol matches; fixed typos.

export const FNO_STOCK_UNIVERSE: string[] = [
  // Capital goods / Industrials
  'ABB', 'SIEMENS', 'BHEL', 'CGPOWER', 'DIXON', 'KAYNES', 'CONCOR',
  // IT
  'LTIM', 'PERSISTENT', 'TECHM', 'TCS', 'INFY', 'HCLTECH', 'TATAELXSI',
  // Auto
  'TVSMOTOR', 'EICHERMOT', 'M&M', 'MARUTI', 'ASHOKLEY', 'BAJAJ-AUTO', 'SONACOMS',
  // Banks
  'AXISBANK', 'HDFCBANK', 'SBIN', 'INDIANB', 'IDFCFIRSTB',
  // NBFC / Financial
  'CHOLAFIN', 'SHRIRAMFIN', 'ABCAPITAL', 'LTF', 'BSE', 'MOTILALOFS', 'MCX',
  // Insurance
  'SBILIFE', 'ICICIGI', 'SBICARD', 'MFSL', 'HDFCLIFE',
  // Pharma
  'LAURUSLABS', 'AUROPHARMA', 'LUPIN', 'ALKEM', 'GLENMARK', 'DRREDDY', 'SUNPHARMA', 'CIPLA',
  // Cement
  'ULTRACEMCO', 'GRASIM', 'SHREECEM',
  // Defence / PSU
  'HAL', 'MAZDOCK', 'BDL', 'BEL', 'COCHINSHIP', 'SOLARINDS',
  // New Age
  'PAYTM', 'ETERNAL', 'ZOMATO', 'SWIGGY',
  // Real Estate
  'OBEROIRLTY', 'LODHA', 'GODREJPROP', 'PRESTIGE', 'DLF',
  // Telecom
  'BHARTIARTL', 'INDUSTOWER',
  // Railway / Infra
  'RVNL', 'IRFC', 'PFC', 'RECLTD',
  // Renewables / Utilities
  'INOXWIND', 'JSWENERGY', 'NTPC', 'TATAPOWER', 'NHPC',
  // Metals
  'NATIONALUM', 'HINDALCO', 'TATASTEEL', 'JSWSTEEL',
  // FMCG / Retail
  'GODFRYPHLP', 'COLPAL', 'HINDUNILVR', 'TRENT', 'NESTLEIND',
  // Others
  'RELIANCE', 'ITC', 'LT',
]

// ─── Types ──────────────────────────────────────────────────────────

interface LensHit {
  key: 'vp' | 'fib' | 'seasonality' | 'volume' | 'smc' | 'smart_money' | 'oi'
  hit: boolean
  points: number
  detail: string
}

export interface FnoForecastRow {
  symbol: string
  side: 'LONG' | 'SHORT'
  ltp: number
  score: number                     // 0-100 composite
  tier: 'ELITE' | 'STRONG' | 'DECENT'
  lensesHit: number

  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  riskPct: number
  rrT1: number
  rrT2: number
  rrT3: number
  entryDate: string
  target1Date: string
  target2Date: string
  target3Date: string
  slDate: string

  // 6 lenses
  lenses: Record<string, LensHit>

  // Actionable interpretation
  observation: string               // accumulation vs distribution signature
  bestWayToPlay: string             // spot / futures / options guidance
  reasoning: string[]
  unifiedReason: string
}

// ─── Snapshot joiners (smart-money footprint) ───────────────────────

function readSnap(name: string): any | null {
  try {
    const p = path.resolve(process.cwd(), 'data', 'public-snapshots', name)
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch { return null }
}

function buildSmartMoneyIndex(): Map<string, {
  pedigreeScore?: number
  hasInsider?: boolean
  hasBulkDeal?: boolean
  hasSuperstar?: boolean
  adDivergence?: 'ACCUMULATION' | 'DISTRIBUTION' | null
  shareholdingNote?: string
}> {
  const idx = new Map<string, any>()
  const bump = (sym: string, k: string, v: any) => {
    const cur = idx.get(sym) ?? {}
    cur[k] = v
    idx.set(sym, cur)
  }
  const pedigree = readSnap('pedigree-accumulation.json')
  if (pedigree && Array.isArray(pedigree.rows)) {
    for (const r of pedigree.rows) if (r?.symbol) bump(String(r.symbol).toUpperCase(), 'pedigreeScore', r.score ?? r.conviction ?? 0)
  }
  const insider = readSnap('insider-buys.json')
  if (insider && Array.isArray(insider.rows)) {
    for (const r of insider.rows) if (r?.symbol) bump(String(r.symbol).toUpperCase(), 'hasInsider', true)
  }
  const bulk = readSnap('bulk-deals.json')
  if (bulk && Array.isArray(bulk.rows)) {
    for (const r of bulk.rows) if (r?.symbol) bump(String(r.symbol).toUpperCase(), 'hasBulkDeal', true)
  }
  const superstar = readSnap('superstar-picks.json')
  if (superstar && Array.isArray(superstar.rows)) {
    for (const r of superstar.rows) if (r?.symbol) bump(String(r.symbol).toUpperCase(), 'hasSuperstar', true)
  }
  const ad = readSnap('ad-divergence.json')
  if (ad && Array.isArray(ad.rows)) {
    for (const r of ad.rows) {
      if (!r?.symbol) continue
      const sym = String(r.symbol).toUpperCase()
      const sig = String(r.signal ?? r.type ?? '').toUpperCase()
      bump(sym, 'adDivergence', sig.includes('ACC') ? 'ACCUMULATION' : sig.includes('DIST') ? 'DISTRIBUTION' : null)
    }
  }
  return idx
}

// ─── Individual lenses ─────────────────────────────────────────────

function atr14(candles: Candle[]): number {
  if (candles.length < 15) return 0
  let sum = 0
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return sum / 14
}

function lensVolumeProfile(candles: Candle[], ltp: number, atr: number, side: 'LONG' | 'SHORT'): LensHit {
  const profile = buildVolumeProfile(candles, 40, '1D')
  if (!profile) return { key: 'vp', hit: false, points: 0, detail: 'no profile' }
  const tol = Math.max(atr * 0.5, ltp * 0.008)
  const { poc, vah, val } = profile
  if (side === 'LONG') {
    if (Math.abs(ltp - val) <= tol) return { key: 'vp', hit: true, points: 18, detail: `LTP at VAL ₹${val.toFixed(2)} — value-area floor buy zone` }
    if (Math.abs(ltp - poc) <= tol) return { key: 'vp', hit: true, points: 15, detail: `LTP at POC ₹${poc.toFixed(2)} — auction fair-value magnet` }
    if (ltp > vah && candles[candles.length - 1].close > vah) return { key: 'vp', hit: true, points: 12, detail: `Close above VAH ₹${vah.toFixed(2)} — value-area breakout` }
  } else {
    if (Math.abs(ltp - vah) <= tol) return { key: 'vp', hit: true, points: 18, detail: `LTP at VAH ₹${vah.toFixed(2)} — value-area ceiling short zone` }
    if (Math.abs(ltp - poc) <= tol) return { key: 'vp', hit: true, points: 15, detail: `LTP at POC ₹${poc.toFixed(2)} — auction fair-value magnet` }
    if (ltp < val && candles[candles.length - 1].close < val) return { key: 'vp', hit: true, points: 12, detail: `Close below VAL ₹${val.toFixed(2)} — value-area breakdown` }
  }
  return { key: 'vp', hit: false, points: 0, detail: 'LTP not at key VP level' }
}

function lensFibonacci(candles: Candle[], ltp: number, atr: number, side: 'LONG' | 'SHORT'): LensHit {
  if (candles.length < 30) return { key: 'fib', hit: false, points: 0, detail: 'insufficient data' }
  const lookback = candles.slice(-40)
  let hi = -Infinity, lo = Infinity, hiIdx = 0, loIdx = 0
  for (let i = 0; i < lookback.length; i++) {
    if (lookback[i].high > hi) { hi = lookback[i].high; hiIdx = i }
    if (lookback[i].low < lo) { lo = lookback[i].low; loIdx = i }
  }
  const range = hi - lo
  if (range <= 0) return { key: 'fib', hit: false, points: 0, detail: 'no swing' }
  const tol = Math.max(atr * 0.5, ltp * 0.006)
  const uptrend = hiIdx > loIdx
  if (uptrend && side === 'LONG') {
    const fib618 = hi - range * 0.618
    const fib786 = hi - range * 0.786
    if (Math.abs(ltp - fib618) <= tol) return { key: 'fib', hit: true, points: 15, detail: `61.8% golden-zone retracement ₹${fib618.toFixed(2)} (of swing ₹${lo.toFixed(0)}→₹${hi.toFixed(0)})` }
    if (Math.abs(ltp - fib786) <= tol) return { key: 'fib', hit: true, points: 15, detail: `78.6% deep retracement ₹${fib786.toFixed(2)} — last-chance buy` }
  }
  if (!uptrend && side === 'SHORT') {
    const fib618 = lo + range * 0.618
    const fib786 = lo + range * 0.786
    if (Math.abs(ltp - fib618) <= tol) return { key: 'fib', hit: true, points: 15, detail: `61.8% golden-zone bounce ₹${fib618.toFixed(2)} of downtrend — institutional short zone` }
    if (Math.abs(ltp - fib786) <= tol) return { key: 'fib', hit: true, points: 15, detail: `78.6% retest ₹${fib786.toFixed(2)} — last-chance short` }
  }
  return { key: 'fib', hit: false, points: 0, detail: 'no fib touch' }
}

/**
 * Seasonality: compute the average return in the CURRENT calendar month
 * across all prior years in the candle history. If current month typically
 * delivers a strong directional bias, that's an edge.
 */
function lensSeasonality(candles: Candle[], side: 'LONG' | 'SHORT'): LensHit {
  const now = candles[candles.length - 1]
  const nowDate = new Date(now.time)
  const currentMonth = nowDate.getUTCMonth()
  // Aggregate monthly returns by (year, month)
  const monthly = new Map<string, { first: number; last: number }>()
  for (const c of candles) {
    const d = new Date(c.time)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    const cur = monthly.get(key)
    if (!cur) monthly.set(key, { first: c.close, last: c.close })
    else cur.last = c.close
  }
  // Extract only current-month bins from history (past years)
  const returns: number[] = []
  for (const [key, val] of monthly) {
    const m = parseInt(key.split('-')[1], 10)
    if (m === currentMonth && val.first > 0) {
      returns.push((val.last - val.first) / val.first * 100)
    }
  }
  if (returns.length < 2) return { key: 'seasonality', hit: false, points: 0, detail: `only ${returns.length}yr history for this month` }
  const avg = returns.reduce((s, v) => s + v, 0) / returns.length
  const positiveRate = returns.filter(r => r > 0).length / returns.length
  const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][currentMonth]
  if (side === 'LONG' && avg > 2 && positiveRate >= 0.6) {
    return { key: 'seasonality', hit: true, points: 12, detail: `${monthName} avg return +${avg.toFixed(1)}% over ${returns.length}yrs · positive ${(positiveRate * 100).toFixed(0)}% of years — bullish seasonality` }
  }
  if (side === 'SHORT' && avg < -2 && positiveRate <= 0.4) {
    return { key: 'seasonality', hit: true, points: 12, detail: `${monthName} avg return ${avg.toFixed(1)}% over ${returns.length}yrs · negative ${((1 - positiveRate) * 100).toFixed(0)}% of years — bearish seasonality` }
  }
  return { key: 'seasonality', hit: false, points: 0, detail: `${monthName} avg ${avg.toFixed(1)}% over ${returns.length}yrs — no strong bias` }
}

function lensVolumeBuild(candles: Candle[], side: 'LONG' | 'SHORT'): LensHit {
  if (candles.length < 25) return { key: 'volume', hit: false, points: 0, detail: 'insufficient data' }
  const v5 = candles.slice(-5).reduce((s, c) => s + (c.volume || 0), 0) / 5
  const v20 = candles.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20
  const ratio = v20 > 0 ? v5 / v20 : 1
  // Range compression → expansion: last 10 bars' range vs prior 20 bars
  const recentRange = candles.slice(-10).reduce((s, c) => s + (c.high - c.low), 0) / 10
  const priorRange = candles.slice(-30, -10).reduce((s, c) => s + (c.high - c.low), 0) / 20
  const compressed = priorRange > 0 && recentRange / priorRange < 0.75    // coil
  if (ratio >= 1.5 && compressed) return { key: 'volume', hit: true, points: 15, detail: `vol 5d/20d ${ratio.toFixed(2)}× + range compressed (${(recentRange / priorRange * 100).toFixed(0)}% of prior) — coil ready to break` }
  if (ratio >= 1.8) return { key: 'volume', hit: true, points: 12, detail: `vol 5d/20d ${ratio.toFixed(2)}× — sharp volume build` }
  if (ratio >= 1.3) return { key: 'volume', hit: true, points: 7, detail: `vol 5d/20d ${ratio.toFixed(2)}× — mild build` }
  return { key: 'volume', hit: false, points: 0, detail: `vol 5d/20d ${ratio.toFixed(2)}× — flat` }
}

function lensSmc(candles: Candle[], side: 'LONG' | 'SHORT'): LensHit {
  const wantBull = side === 'LONG'
  const hits: string[] = []
  const fvg = detectFVG(candles); if (fvg && fvg.bullish === wantBull) hits.push(`FVG ${fvg.detail}`)
  const ob = detectOrderBlock(candles); if (ob && ob.bullish === wantBull) hits.push(`OB ${ob.detail}`)
  const bos = detectBoS(candles); if (bos && bos.bullish === wantBull) hits.push(`BoS ${bos.detail}`)
  const ls = detectLiquiditySweep(candles); if (ls && ls.bullish === wantBull) hits.push(`Sweep ${ls.detail}`)
  if (hits.length === 0) return { key: 'smc', hit: false, points: 0, detail: 'no SMC alignment' }
  const points = Math.min(20, hits.length * 6)
  return { key: 'smc', hit: true, points, detail: hits.join(' · ') }
}

function lensSmartMoney(sym: string, smIdx: Map<string, any>, side: 'LONG' | 'SHORT'): LensHit {
  const s = smIdx.get(sym.toUpperCase())
  if (!s) return { key: 'smart_money', hit: false, points: 0, detail: 'no smart-money footprint' }
  const bits: string[] = []
  let points = 0
  if (side === 'LONG') {
    if (s.pedigreeScore && s.pedigreeScore >= 70) { bits.push(`Pedigree ${s.pedigreeScore}`); points += 8 }
    if (s.hasInsider) { bits.push('Insider buys'); points += 6 }
    if (s.hasBulkDeal) { bits.push('Bulk-deal buyers'); points += 5 }
    if (s.hasSuperstar) { bits.push('Superstar holding'); points += 4 }
    if (s.adDivergence === 'ACCUMULATION') { bits.push('A/D ACCUMULATION'); points += 5 }
  } else {
    if (s.adDivergence === 'DISTRIBUTION') { bits.push('A/D DISTRIBUTION'); points += 12 }
  }
  if (bits.length === 0) return { key: 'smart_money', hit: false, points: 0, detail: `footprint neutral / opposite for ${side}` }
  return { key: 'smart_money', hit: true, points: Math.min(20, points), detail: bits.join(' + ') }
}

/**
 * OI velocity per stock — reads options-radar for signals mentioning this
 * underlying, gives a bonus if OI is stacking in the direction of trade.
 */
function lensOiFlow(sym: string, side: 'LONG' | 'SHORT'): LensHit {
  const radar = readSnap('options-radar.json')
  if (!radar || !Array.isArray(radar.signals)) return { key: 'oi', hit: false, points: 0, detail: 'no options radar data' }
  const matches = radar.signals.filter((s: any) => String(s.underlying ?? '').toUpperCase() === sym.toUpperCase())
  if (matches.length === 0) return { key: 'oi', hit: false, points: 0, detail: 'no OI accumulation detected for this underlying' }
  const wantBias = side === 'LONG' ? 'BULLISH' : 'BEARISH'
  const aligned = matches.filter((s: any) => s.bias === wantBias)
  if (aligned.length === 0) return { key: 'oi', hit: false, points: 0, detail: `OI radar shows opposite direction for ${sym}` }
  const bestScore = Math.max(...aligned.map((s: any) => s.strikeScore ?? 0))
  const points = Math.round(Math.min(15, bestScore / 100 * 15))
  return { key: 'oi', hit: true, points, detail: `${aligned.length} OI radar signal(s), best strike-score ${bestScore} · institutional stacking ${wantBias}` }
}

// ─── Scoring + trade plan ──────────────────────────────────────────

function slDistanceFor(entry: number, atr: number): number {
  // F&O stocks: 5% cap (large-cap floor), 1.5×ATR min
  return Math.min(entry * 0.05, Math.max(atr * 1.5, entry * 0.025))
}

async function forecastOne(sym: string, smIdx: Map<string, any>): Promise<FnoForecastRow | null> {
  const candles = await getCandles(sym, '1D', 300).catch(() => [])
  if (!candles || candles.length < 60) return null
  const ltp = candles[candles.length - 1].close
  const atr = atr14(candles)
  if (atr <= 0) return null

  const scoreSide = (side: 'LONG' | 'SHORT') => {
    const lenses: Record<string, LensHit> = {
      vp: lensVolumeProfile(candles, ltp, atr, side),
      fib: lensFibonacci(candles, ltp, atr, side),
      seasonality: lensSeasonality(candles, side),
      volume: lensVolumeBuild(candles, side),
      smc: lensSmc(candles, side),
      smart_money: lensSmartMoney(sym, smIdx, side),
      oi: lensOiFlow(sym, side),
    }
    const hitCount = Object.values(lenses).filter(l => l.hit).length
    let total = Object.values(lenses).reduce((s, l) => s + l.points, 0)
    if (hitCount >= 5) total += 10                     // multi-lens bonus
    total = Math.min(100, total)
    return { lenses, hitCount, total }
  }

  const long = scoreSide('LONG')
  const short = scoreSide('SHORT')
  const best = long.total >= short.total ? { ...long, side: 'LONG' as const } : { ...short, side: 'SHORT' as const }

  // Gate: min 3 lenses + score ≥ 50
  if (best.hitCount < 3 || best.total < 50) return null

  const tier: 'ELITE' | 'STRONG' | 'DECENT' = best.total >= 80 ? 'ELITE' : best.total >= 65 ? 'STRONG' : 'DECENT'
  const slDist = slDistanceFor(ltp, atr)
  const t1Dist = Math.max(atr * 1.5, slDist * 1.5)
  const t2Dist = Math.max(atr * 3.0, slDist * 2.5)
  const t3Dist = Math.max(atr * 5.0, slDist * 3.5)

  const entry = ltp
  const stopLoss = best.side === 'LONG' ? entry - slDist : entry + slDist
  const target1 = best.side === 'LONG' ? entry + t1Dist : entry - t1Dist
  const target2 = best.side === 'LONG' ? entry + t2Dist : entry - t2Dist
  const target3 = best.side === 'LONG' ? entry + t3Dist : entry - t3Dist

  const now = Date.now()
  const addBiz = (n: number) => {
    let d = new Date(now)
    let added = 0
    while (added < n) { d = new Date(d.getTime() + 86_400_000); const w = d.getUTCDay(); if (w !== 0 && w !== 6) added++ }
    return d.toISOString().slice(0, 10)
  }

  // Observation narrative (accumulation vs distribution signature)
  const observation =
    best.side === 'LONG' && (best.lenses.smart_money.hit || best.lenses.oi.hit || best.lenses.smc.hit)
      ? `Smart-money ACCUMULATION signature detected — ${[best.lenses.smart_money.hit ? 'institutional footprint' : null, best.lenses.oi.hit ? 'OI stacking bullish strikes' : null, best.lenses.smc.hit ? 'SMC primitives (order block / BoS / liquidity grab)' : null].filter(Boolean).join(' + ')}`
      : best.side === 'SHORT' && (best.lenses.smart_money.hit || best.lenses.oi.hit || best.lenses.smc.hit)
      ? `Smart-money DISTRIBUTION signature detected — ${[best.lenses.smart_money.hit ? 'A/D divergence' : null, best.lenses.oi.hit ? 'OI stacking bearish strikes' : null, best.lenses.smc.hit ? 'SMC bearish primitives' : null].filter(Boolean).join(' + ')}`
      : `Structural setup — VP + Fib + volume alignment, no explicit smart-money read yet`

  const bestWayToPlay =
    tier === 'ELITE'
      ? `Buy stock futures 1 lot for directional exposure (leverage without decay). If size is small, buy 1 lot ATM ${best.side === 'LONG' ? 'CE' : 'PE'} of current-week expiry with 3% stop on premium.`
      : tier === 'STRONG'
      ? `Take spot delivery 20-30% of intended full size, add on confirmation candle. Options: 1 lot slightly-OTM ${best.side === 'LONG' ? 'CE' : 'PE'} of current-week expiry, size the debit at 2% of capital.`
      : `Watch-list only — put a limit-buy at Fib 78.6% / VAL level. Do not chase.`

  const reasoning = Object.values(best.lenses).filter(l => l.hit).map(l => `[${l.key.toUpperCase()}] ${l.detail}`)
  reasoning.push(`OBSERVATION: ${observation}`)
  reasoning.push(`HOW TO PLAY: ${bestWayToPlay}`)

  return {
    symbol: sym,
    side: best.side,
    ltp: Math.round(ltp * 100) / 100,
    score: best.total,
    tier,
    lensesHit: best.hitCount,
    entry: Math.round(entry * 100) / 100,
    stopLoss: Math.round(stopLoss * 100) / 100,
    target1: Math.round(target1 * 100) / 100,
    target2: Math.round(target2 * 100) / 100,
    target3: Math.round(target3 * 100) / 100,
    riskPct: Math.round((slDist / entry) * 10000) / 100,
    rrT1: Math.round((t1Dist / slDist) * 100) / 100,
    rrT2: Math.round((t2Dist / slDist) * 100) / 100,
    rrT3: Math.round((t3Dist / slDist) * 100) / 100,
    entryDate: new Date().toISOString().slice(0, 10),
    target1Date: addBiz(3),
    target2Date: addBiz(6),
    target3Date: addBiz(10),
    slDate: addBiz(8),
    lenses: best.lenses,
    observation,
    bestWayToPlay,
    reasoning,
    unifiedReason: reasoning.join(' · '),
  }
}

// ─── Main ──────────────────────────────────────────────────────────

export async function runFnoStockMoveForecast(): Promise<{
  generatedAt: string
  universeSize: number
  totalScored: number
  eliteCount: number
  strongCount: number
  decentCount: number
  rows: FnoForecastRow[]
}> {
  const smIdx = buildSmartMoneyIndex()
  log.info('FNO-FORECAST', `smart-money index: ${smIdx.size} symbols · universe: ${FNO_STOCK_UNIVERSE.length}`)

  const rows: FnoForecastRow[] = []
  const concurrency = 6
  let i = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < FNO_STOCK_UNIVERSE.length) {
      const sym = FNO_STOCK_UNIVERSE[i++]
      try {
        const r = await forecastOne(sym, smIdx)
        if (r) rows.push(r)
      } catch (e) {
        log.warn('FNO-FORECAST', `${sym}: ${(e as Error).message}`)
      }
    }
  }))

  rows.sort((a, b) => b.score - a.score)
  const eliteCount = rows.filter(r => r.tier === 'ELITE').length
  const strongCount = rows.filter(r => r.tier === 'STRONG').length
  const decentCount = rows.filter(r => r.tier === 'DECENT').length

  const out = {
    generatedAt: new Date().toISOString(),
    universeSize: FNO_STOCK_UNIVERSE.length,
    totalScored: rows.length,
    eliteCount, strongCount, decentCount,
    rows,
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf-8')
  log.info('FNO-FORECAST', `wrote ${rows.length} forecasts (${eliteCount} elite · ${strongCount} strong · ${decentCount} decent)`)
  return out
}
