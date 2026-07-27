/**
 * PRO Multi-TF Setups — money-printing engine.
 *
 * User directive (2026-07-27): scan every actionable instrument
 *   NIFTY · NIFTY Futures · Stock F&O · MCX Gold · MCX Silver · MCX Crude
 *   · COMEX XAUUSD
 * across every meaningful timeframe
 *   5m · 15m · 30m · 1h · 4h · 1D
 * through the 6-lens confluence stack + astro overlay + liquidity trap
 * detector, and emit dated actionable setups with entry / SL / T1-T2-T3
 * PER (instrument, timeframe) tuple.
 *
 * Lens weights per tuple:
 *   1. Volume Profile           (POC/VAH/VAL)                  up to 18 pts
 *   2. Fibonacci Levels         (61.8-78.6% golden zone)       up to 15 pts
 *   3. Volume Build             (5d/20d + range compression)   up to 15 pts
 *   4. Smart Money Concept      (FVG · OB · BoS)               up to 18 pts
 *   5. Liquidity Sweep / Trap   (stop-hunt reclaim)            up to 15 pts
 *   6. Seasonality              (same calendar month avg 5+yr) up to 10 pts
 *   7. Astro overlay            (planetary hora + day lordship) up to 8 pts
 *
 * Output: server/data/public-snapshots/pro-setups.json
 */

import fs from 'fs'
import path from 'path'
import { getCandles } from '../data/index'
import { buildVolumeProfile } from './volumeProfile'
import { detectOrderBlock, detectLiquiditySweep, detectFVG, detectBoS } from './smcPatterns'
import type { Candle, Timeframe } from '../types'
import { log } from '../util/logger'

const OUT_PATH = path.resolve(process.cwd(), 'data', 'public-snapshots', 'pro-setups.json')

// ─── Universe: high-value instruments only ─────────────────────────

const INSTRUMENTS: Array<{ key: string; displayName: string; kind: 'INDEX' | 'STOCK' | 'COMMODITY' }> = [
  { key: 'NIFTY',      displayName: 'NIFTY 50',        kind: 'INDEX' },
  { key: 'XAUUSD',     displayName: 'XAU/USD (COMEX)', kind: 'COMMODITY' },
  { key: 'GOLD',       displayName: 'GOLD (MCX)',      kind: 'COMMODITY' },
  { key: 'SILVER',     displayName: 'SILVER (MCX)',    kind: 'COMMODITY' },
  { key: 'CRUDE',      displayName: 'CRUDEOIL (MCX)',  kind: 'COMMODITY' },
  { key: 'RELIANCE',   displayName: 'Reliance',        kind: 'STOCK' },
  { key: 'HDFCBANK',   displayName: 'HDFC Bank',       kind: 'STOCK' },
  { key: 'ICICIBANK',  displayName: 'ICICI Bank',      kind: 'STOCK' },
  { key: 'AXISBANK',   displayName: 'Axis Bank',       kind: 'STOCK' },
  { key: 'SBIN',       displayName: 'SBI',             kind: 'STOCK' },
  { key: 'INFY',       displayName: 'Infosys',         kind: 'STOCK' },
  { key: 'TCS',        displayName: 'TCS',             kind: 'STOCK' },
  { key: 'HCLTECH',    displayName: 'HCL Tech',        kind: 'STOCK' },
  { key: 'PERSISTENT', displayName: 'Persistent',      kind: 'STOCK' },
  { key: 'MARUTI',     displayName: 'Maruti',          kind: 'STOCK' },
  { key: 'TATAMOTORS', displayName: 'Tata Motors',     kind: 'STOCK' },
  { key: 'TVSMOTOR',   displayName: 'TVS Motor',       kind: 'STOCK' },
  { key: 'EICHERMOT',  displayName: 'Eicher',          kind: 'STOCK' },
  { key: 'M&M',        displayName: 'M&M',             kind: 'STOCK' },
  { key: 'ADANIENT',   displayName: 'Adani Ent',       kind: 'STOCK' },
  { key: 'HAL',        displayName: 'HAL',             kind: 'STOCK' },
  { key: 'BEL',        displayName: 'BEL',             kind: 'STOCK' },
  { key: 'MAZDOCK',    displayName: 'Mazagon Dock',    kind: 'STOCK' },
  { key: 'TATAPOWER',  displayName: 'Tata Power',      kind: 'STOCK' },
  { key: 'PFC',        displayName: 'PFC',             kind: 'STOCK' },
  { key: 'RECLTD',     displayName: 'REC',             kind: 'STOCK' },
  { key: 'TRENT',      displayName: 'Trent',           kind: 'STOCK' },
  { key: 'DIXON',      displayName: 'Dixon',           kind: 'STOCK' },
  { key: 'KAYNES',     displayName: 'Kaynes Tech',     kind: 'STOCK' },
]

const TIMEFRAMES: Array<{ key: Timeframe; label: string; barMinutes: number; count: number }> = [
  { key: '5m',  label: '5m',  barMinutes: 5,    count: 500 },
  { key: '15m', label: '15m', barMinutes: 15,   count: 300 },
  { key: '30m', label: '30m', barMinutes: 30,   count: 200 },
  { key: '1h',  label: '1h',  barMinutes: 60,   count: 200 },
  { key: '4h',  label: '4h',  barMinutes: 240,  count: 150 },
  { key: '1D',  label: '1D',  barMinutes: 1440, count: 250 },
]

interface LensHit { hit: boolean; points: number; detail: string }

function atr14(candles: Candle[]): number {
  if (candles.length < 15) return 0
  let sum = 0
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return sum / 14
}

function toIstIsoDateTime(ms: number): string {
  return new Date(ms + 5.5 * 3600_000).toISOString().replace('T', ' ').replace('.000Z', ' IST')
}

function vpLens(candles: Candle[], ltp: number, atr: number, side: 'LONG' | 'SHORT'): LensHit {
  const p = buildVolumeProfile(candles, 40, '1D')
  if (!p) return { hit: false, points: 0, detail: 'no profile' }
  const tol = Math.max(atr * 1.0, ltp * 0.015)
  if (side === 'LONG') {
    if (Math.abs(ltp - p.val) <= tol) return { hit: true, points: 18, detail: `at VAL ₹${p.val.toFixed(2)}` }
    if (Math.abs(ltp - p.poc) <= tol) return { hit: true, points: 15, detail: `at POC ₹${p.poc.toFixed(2)}` }
    if (ltp > p.vah && candles[candles.length - 1].close > p.vah) return { hit: true, points: 12, detail: `VAH ₹${p.vah.toFixed(2)} breakout` }
  } else {
    if (Math.abs(ltp - p.vah) <= tol) return { hit: true, points: 18, detail: `at VAH ₹${p.vah.toFixed(2)}` }
    if (Math.abs(ltp - p.poc) <= tol) return { hit: true, points: 15, detail: `at POC ₹${p.poc.toFixed(2)}` }
    if (ltp < p.val && candles[candles.length - 1].close < p.val) return { hit: true, points: 12, detail: `VAL ₹${p.val.toFixed(2)} breakdown` }
  }
  return { hit: false, points: 0, detail: 'no VP touch' }
}

function fibLens(candles: Candle[], ltp: number, atr: number, side: 'LONG' | 'SHORT'): LensHit {
  const lookback = candles.slice(-40)
  let hi = -Infinity, lo = Infinity, hiIdx = 0, loIdx = 0
  for (let i = 0; i < lookback.length; i++) {
    if (lookback[i].high > hi) { hi = lookback[i].high; hiIdx = i }
    if (lookback[i].low < lo) { lo = lookback[i].low; loIdx = i }
  }
  if (hi <= lo) return { hit: false, points: 0, detail: 'no swing' }
  const range = hi - lo
  const tol = Math.max(atr * 1.0, ltp * 0.012)
  const uptrend = hiIdx > loIdx
  if (uptrend && side === 'LONG') {
    const f618 = hi - range * 0.618
    const f786 = hi - range * 0.786
    if (Math.abs(ltp - f618) <= tol) return { hit: true, points: 15, detail: `61.8% ₹${f618.toFixed(2)}` }
    if (Math.abs(ltp - f786) <= tol) return { hit: true, points: 15, detail: `78.6% ₹${f786.toFixed(2)}` }
  }
  if (!uptrend && side === 'SHORT') {
    const f618 = lo + range * 0.618
    const f786 = lo + range * 0.786
    if (Math.abs(ltp - f618) <= tol) return { hit: true, points: 15, detail: `61.8% bounce ₹${f618.toFixed(2)}` }
    if (Math.abs(ltp - f786) <= tol) return { hit: true, points: 15, detail: `78.6% ₹${f786.toFixed(2)}` }
  }
  return { hit: false, points: 0, detail: 'no fib' }
}

function volumeLens(candles: Candle[]): LensHit {
  if (candles.length < 25) return { hit: false, points: 0, detail: 'insufficient' }
  const v5 = candles.slice(-5).reduce((s, c) => s + (c.volume || 0), 0) / 5
  const v20 = candles.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20
  const r = v20 > 0 ? v5 / v20 : 1
  const recentRange = candles.slice(-10).reduce((s, c) => s + (c.high - c.low), 0) / 10
  const priorRange = candles.slice(-30, -10).reduce((s, c) => s + (c.high - c.low), 0) / 20
  const compressed = priorRange > 0 && recentRange / priorRange < 0.75
  if (r >= 1.5 && compressed) return { hit: true, points: 15, detail: `vol ${r.toFixed(1)}× + coil ready` }
  if (r >= 1.8) return { hit: true, points: 12, detail: `vol ${r.toFixed(1)}× surge` }
  if (r >= 1.3) return { hit: true, points: 7, detail: `vol ${r.toFixed(1)}× mild build` }
  return { hit: false, points: 0, detail: `vol ${r.toFixed(1)}× flat` }
}

function smcLens(candles: Candle[], side: 'LONG' | 'SHORT'): LensHit {
  const want = side === 'LONG'
  const bits: string[] = []
  const fvg = detectFVG(candles); if (fvg && fvg.bullish === want) bits.push('FVG')
  const ob = detectOrderBlock(candles); if (ob && ob.bullish === want) bits.push('OB')
  const bos = detectBoS(candles); if (bos && bos.bullish === want) bits.push('BoS')
  if (bits.length === 0) return { hit: false, points: 0, detail: 'no SMC' }
  return { hit: true, points: Math.min(18, bits.length * 6), detail: bits.join('+') }
}

function liquidityLens(candles: Candle[], side: 'LONG' | 'SHORT'): LensHit {
  const sweep = detectLiquiditySweep(candles)
  if (!sweep) return { hit: false, points: 0, detail: 'no sweep' }
  const want = side === 'LONG'
  if (sweep.bullish !== want) return { hit: false, points: 0, detail: 'sweep wrong side' }
  return { hit: true, points: 15, detail: `${sweep.detail.slice(0, 60)} → trap` }
}

function seasonalityLens(candles: Candle[], side: 'LONG' | 'SHORT'): LensHit {
  if (candles.length < 60) return { hit: false, points: 0, detail: 'insufficient history' }
  const currentMonth = new Date(candles[candles.length - 1].time).getUTCMonth()
  const monthly = new Map<string, { first: number; last: number }>()
  for (const c of candles) {
    const d = new Date(c.time)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`
    const cur = monthly.get(key)
    if (!cur) monthly.set(key, { first: c.close, last: c.close })
    else cur.last = c.close
  }
  const returns: number[] = []
  for (const [k, v] of monthly) {
    const m = parseInt(k.split('-')[1], 10)
    if (m === currentMonth && v.first > 0) returns.push((v.last - v.first) / v.first * 100)
  }
  if (returns.length < 2) return { hit: false, points: 0, detail: 'no history' }
  const avg = returns.reduce((s, v) => s + v, 0) / returns.length
  const monthName = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][currentMonth]
  if (side === 'LONG' && avg > 1.5) return { hit: true, points: 10, detail: `${monthName} avg +${avg.toFixed(1)}% (${returns.length}yr)` }
  if (side === 'SHORT' && avg < -1.5) return { hit: true, points: 10, detail: `${monthName} avg ${avg.toFixed(1)}% (${returns.length}yr)` }
  return { hit: false, points: 0, detail: `${monthName} avg ${avg.toFixed(1)}%` }
}

/**
 * Astro overlay — Vedic day lordship + planetary hora heuristic.
 *   Jupiter/Venus/Mercury hora → benefic → LONG bias
 *   Mars/Saturn hora → malefic → SHORT bias
 * Commodities (esp gold/silver) get an extra bonus on Venus/Jupiter days.
 */
function astroLens(side: 'LONG' | 'SHORT', kind: 'INDEX' | 'STOCK' | 'COMMODITY'): LensHit {
  const now = new Date(Date.now() + 5.5 * 3600_000)
  const dow = now.getUTCDay()
  const hour = now.getUTCHours()
  const dayLords = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn']
  const p = dayLords[dow]
  const horaOrder = ['Sun', 'Venus', 'Mercury', 'Moon', 'Saturn', 'Jupiter', 'Mars']
  const dayLordIdx = horaOrder.indexOf(p)
  const horaSinceSunrise = (hour + 24 - 6) % 24
  const currentHora = horaOrder[(dayLordIdx + horaSinceSunrise) % 7]

  const bullish = ['Jupiter', 'Venus', 'Mercury']
  const bearish = ['Mars', 'Saturn']
  if (side === 'LONG' && bullish.includes(currentHora)) return { hit: true, points: 8, detail: `${p}-day · ${currentHora} hora → benefic` }
  if (side === 'SHORT' && bearish.includes(currentHora)) return { hit: true, points: 8, detail: `${p}-day · ${currentHora} hora → malefic` }
  if (kind === 'COMMODITY' && side === 'LONG' && (p === 'Venus' || p === 'Jupiter')) return { hit: true, points: 6, detail: `${p}-day favours precious metals LONG` }
  return { hit: false, points: 0, detail: `${p}-day / ${currentHora} hora → neutral` }
}

interface Setup {
  instrument: string
  displayName: string
  kind: 'INDEX' | 'STOCK' | 'COMMODITY'
  timeframe: string
  side: 'LONG' | 'SHORT'
  score: number
  tier: 'ELITE' | 'STRONG' | 'DECENT'
  lensesHit: number
  ltp: number
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  riskPct: number
  rrT1: number
  rrT2: number
  rrT3: number
  entryTime: string
  target1Time: string
  target2Time: string
  target3Time: string
  slTime: string
  lenses: Record<string, LensHit>
  observation: string
  bestWayToPlay: string
  reasoning: string[]
  unifiedReason: string
}

async function scanOne(inst: typeof INSTRUMENTS[0], tf: typeof TIMEFRAMES[0]): Promise<Setup | null> {
  const candles = await getCandles(inst.key, tf.key, tf.count).catch(() => [])
  if (!candles || candles.length < 30) return null
  const ltp = candles[candles.length - 1].close
  const atr = atr14(candles)
  if (atr <= 0) return null

  const scoreSide = (side: 'LONG' | 'SHORT') => {
    const lenses: Record<string, LensHit> = {
      vp: vpLens(candles, ltp, atr, side),
      fib: fibLens(candles, ltp, atr, side),
      volume: volumeLens(candles),
      smc: smcLens(candles, side),
      liquidity: liquidityLens(candles, side),
      seasonality: seasonalityLens(candles, side),
      astro: astroLens(side, inst.kind),
    }
    const hitCount = Object.values(lenses).filter(l => l.hit).length
    let total = Object.values(lenses).reduce((s, l) => s + l.points, 0)
    if (hitCount >= 5) total += 10
    total = Math.min(100, total)
    return { lenses, hitCount, total }
  }

  const longR = scoreSide('LONG')
  const shortR = scoreSide('SHORT')
  const best = longR.total >= shortR.total ? { ...longR, side: 'LONG' as const } : { ...shortR, side: 'SHORT' as const }
  if (best.hitCount < 2 || best.total < 30) return null

  const tier: 'ELITE' | 'STRONG' | 'DECENT' = best.total >= 65 ? 'ELITE' : best.total >= 45 ? 'STRONG' : 'DECENT'

  const slDistPct = inst.kind === 'INDEX' ? 0.012 : inst.kind === 'COMMODITY' ? 0.02 : 0.03
  const slDist = Math.min(ltp * slDistPct, Math.max(atr * 1.2, ltp * 0.008))
  const t1Dist = Math.max(atr * 1.5, slDist * 1.5)
  const t2Dist = Math.max(atr * 3.0, slDist * 2.5)
  const t3Dist = Math.max(atr * 5.0, slDist * 3.5)

  const entry = ltp
  const sl = best.side === 'LONG' ? entry - slDist : entry + slDist
  const t1 = best.side === 'LONG' ? entry + t1Dist : entry - t1Dist
  const t2 = best.side === 'LONG' ? entry + t2Dist : entry - t2Dist
  const t3 = best.side === 'LONG' ? entry + t3Dist : entry - t3Dist

  const now = Date.now()
  const t1Time = now + tf.barMinutes * 60_000 * 5
  const t2Time = now + tf.barMinutes * 60_000 * 12
  const t3Time = now + tf.barMinutes * 60_000 * 25
  const slTime = now + tf.barMinutes * 60_000 * 15

  const observation = best.lenses.smc.hit || best.lenses.liquidity.hit
    ? `Smart-money ${best.side === 'LONG' ? 'ACCUMULATION' : 'DISTRIBUTION'} signature — ${[best.lenses.smc.hit ? best.lenses.smc.detail : null, best.lenses.liquidity.hit ? best.lenses.liquidity.detail : null].filter(Boolean).join(' + ')}`
    : `${tf.label} ${best.side} setup — VP + Fib + volume alignment`

  const bestWayToPlay = tier === 'ELITE'
    ? `${best.side === 'LONG' ? 'Buy' : 'Short'} ${inst.kind === 'INDEX' ? 'NIFTY futures + ATM' : inst.kind === 'COMMODITY' ? 'MCX front-month FUT + ATM' : 'stock futures + ATM'} ${best.side === 'LONG' ? 'CE' : 'PE'} current-week expiry. Cap risk at 2% of capital.`
    : tier === 'STRONG'
    ? `Scale-in 30% at entry, add 30% on next-bar confirmation, 40% on retest. ${inst.kind === 'STOCK' ? 'Prefer spot delivery + partial futures.' : 'Futures preferred over options.'}`
    : `Watch-list: place limit order at ${best.side === 'LONG' ? 'VAL' : 'VAH'} touch. Don't chase.`

  const reasoning = Object.entries(best.lenses).filter(([_, l]) => l.hit).map(([k, l]) => `[${k.toUpperCase()}] ${l.detail}`)
  reasoning.push(`Observation: ${observation}`)
  reasoning.push(`Play: ${bestWayToPlay}`)

  return {
    instrument: inst.key,
    displayName: inst.displayName,
    kind: inst.kind,
    timeframe: tf.label,
    side: best.side,
    score: best.total,
    tier,
    lensesHit: best.hitCount,
    ltp: Math.round(ltp * 100) / 100,
    entry: Math.round(entry * 100) / 100,
    stopLoss: Math.round(sl * 100) / 100,
    target1: Math.round(t1 * 100) / 100,
    target2: Math.round(t2 * 100) / 100,
    target3: Math.round(t3 * 100) / 100,
    riskPct: Math.round((slDist / entry) * 10000) / 100,
    rrT1: Math.round((t1Dist / slDist) * 100) / 100,
    rrT2: Math.round((t2Dist / slDist) * 100) / 100,
    rrT3: Math.round((t3Dist / slDist) * 100) / 100,
    entryTime: toIstIsoDateTime(now),
    target1Time: toIstIsoDateTime(t1Time),
    target2Time: toIstIsoDateTime(t2Time),
    target3Time: toIstIsoDateTime(t3Time),
    slTime: toIstIsoDateTime(slTime),
    lenses: best.lenses,
    observation,
    bestWayToPlay,
    reasoning,
    unifiedReason: reasoning.join(' · '),
  }
}

export async function runProMultiTfSetups(): Promise<{
  generatedAt: string
  marketOpen: boolean
  instruments: number
  timeframes: number
  totalScanned: number
  eliteCount: number
  strongCount: number
  decentCount: number
  rows: Setup[]
}> {
  const now = new Date(Date.now() + 5.5 * 3600_000)
  const dow = now.getUTCDay()
  const minOfDay = now.getUTCHours() * 60 + now.getUTCMinutes()
  const marketOpen = dow >= 1 && dow <= 5 && minOfDay >= 555 && minOfDay <= 930

  const rows: Setup[] = []
  const tasks: Array<() => Promise<void>> = []
  for (const inst of INSTRUMENTS) {
    for (const tf of TIMEFRAMES) {
      tasks.push(async () => {
        try {
          const s = await scanOne(inst, tf)
          if (s) rows.push(s)
        } catch { /* silent skip */ }
      })
    }
  }
  let idx = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (idx < tasks.length) {
      const t = tasks[idx++]
      await t()
    }
  }))

  rows.sort((a, b) => b.score - a.score)
  const out = {
    generatedAt: new Date().toISOString(),
    marketOpen,
    instruments: INSTRUMENTS.length,
    timeframes: TIMEFRAMES.length,
    totalScanned: INSTRUMENTS.length * TIMEFRAMES.length,
    eliteCount: rows.filter(r => r.tier === 'ELITE').length,
    strongCount: rows.filter(r => r.tier === 'STRONG').length,
    decentCount: rows.filter(r => r.tier === 'DECENT').length,
    rows,
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf-8')
  log.info('PRO-SETUPS', `${INSTRUMENTS.length}i × ${TIMEFRAMES.length}tf = ${INSTRUMENTS.length * TIMEFRAMES.length} scans · ${rows.length} setups · ${out.eliteCount}E ${out.strongCount}S ${out.decentCount}D · market ${marketOpen ? 'OPEN' : 'CLOSED'}`)
  return out
}
