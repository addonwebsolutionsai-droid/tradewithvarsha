/**
 * F&O Stock-Futures scanner — produces a daily curated list of futures
 * that show PRE-BREAKOUT or PRE-BREAKDOWN setups across the entire NSE
 * F&O underlying universe (~210 names).
 *
 * The goal (per user): "identify BEFORE the move happens, not after the
 * move started" — so we explicitly REJECT names that have already run
 * (|ret5d| > 8 % or |ret20d| > 25 %) and reward COILING setups: tight
 * Bollinger range, at-20d-high (or low), volume rising, EMA-stacked.
 *
 * Confluences scored (max 100):
 *   - EMA 9 > 21 > 50 stack alignment                  (20)
 *   - At/near 20-day high (long) or 20-day low (short) (15)
 *   - Tight range (BB-width < 12 %)                    (15)
 *   - Volume 5d/20d rising > 1.3 ×                     (15)
 *   - RSI in productive band                           (10)
 *   - 20d return in healthy range (not extended)       (10)
 *   - FII stake increasing (institutional confirm)     (10)
 *   - Promoter stake stable or up                      ( 5)
 *   - Penalty: |ret5d| > 8 %                           (-20)
 *
 * Confidence buckets:
 *   80+  HIGH (Grade A)
 *   65–79 MED (Grade B)
 *   <65 dropped
 */
import * as angel from '../data/angel'
import * as data from '../data'
import { getShareholding } from '../data/shareholding'
import { log } from '../util/logger'

const TARGET_DAYS = { T1: 7, T2: 14, T3: 21 }
const TARGET_PCT = { T1: 0.06, T2: 0.12, T3: 0.20 }   // 6 % / 12 % / 20 %

export type FnoSide = 'LONG' | 'SHORT'
export type FnoConfidence = 'HIGH' | 'MED'

export interface FnoFuturesRow {
  symbol: string
  side: FnoSide
  price: number
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  target1Date: string
  target2Date: string
  target3Date: string
  expectedMovePct: number    // T3 absolute % move
  score: number              // 0-100
  confidence: FnoConfidence
  grade: 'A' | 'B'
  // Feature snapshot for transparency / UI
  features: {
    ret5d: number
    ret20d: number
    rsi14: number
    bbWidthPct: number
    distFromHigh20: number
    distFromLow20: number
    volRatio: number
    emaStackBull: boolean
    emaStackBear: boolean
  }
  // Multi-lens confluence breakdown ("why this is here")
  confluences: { name: string; pass: boolean; detail: string }[]
  // Institutional overlay
  fiiDelta: number | null
  diiDelta: number | null
  promoterDelta: number | null
  marketCapCr: number | null
  reasons: string[]
  asOf: string
}

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

function ema(values: number[], period: number): number {
  const k = 2 / (period + 1)
  let v = values[0]
  for (let i = 1; i < values.length; i++) v = values[i] * k + v * (1 - k)
  return v
}

function rsi14(values: number[]): number {
  if (values.length < 15) return 50
  let g = 0, l = 0
  for (let i = values.length - 14; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) g += d; else l -= d
  }
  if (l === 0) return 100
  return 100 - 100 / (1 + g / l)
}

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length

function addBizDays(from: Date, days: number): string {
  const d = new Date(from)
  let added = 0
  while (added < days) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d.toISOString().slice(0, 10)
}

async function fetchCandles(symbol: string): Promise<Candle[] | null> {
  // Use the unified data layer so we ride the warm Angel session +
  // automatic fallback (Yahoo/NSE) when one source rate-limits. Direct
  // angel.getCandles() races with auth refresh on cold start and returns
  // empty arrays for most symbols — fixed by going through data.getCandles.
  try {
    const c = await data.getCandles(symbol, '1D' as any, 90)
    return c && c.length >= 25 ? (c as Candle[]) : null
  } catch { return null }
}

async function listFnoUnderlyings(): Promise<string[]> {
  const sm = await angel.loadScripMaster()
  if (!sm) return []
  const futs = sm.filter(s => s.exch_seg === 'NFO' && s.instrumenttype === 'FUTSTK')
  return [...new Set(futs.map(s => s.name))]
    .filter(n => !!n && !/NSETEST/i.test(n))
    .sort()
}

function scoreOne(symbol: string, candles: Candle[]): {
  side: FnoSide; score: number; features: FnoFuturesRow['features'];
  confluences: FnoFuturesRow['confluences']; reasons: string[]; price: number
} | null {
  if (candles.length < 25) return null
  const closes = candles.map(c => c.close)
  const vols = candles.map(c => c.volume)
  const price = closes[closes.length - 1]
  if (!Number.isFinite(price) || price < 5) return null

  const ret5d = ((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
  const ret20d = ((price - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
  const high20 = Math.max(...closes.slice(-20))
  const low20 = Math.min(...closes.slice(-20))
  const distFromHigh20 = ((high20 - price) / high20) * 100
  const distFromLow20 = ((price - low20) / low20) * 100
  const bbWidthPct = ((high20 - low20) / price) * 100
  const v5 = mean(vols.slice(-5)), v20 = mean(vols.slice(-20))
  const volRatio = v20 > 0 ? v5 / v20 : 1
  const rsi = rsi14(closes)
  const e9 = ema(closes, 9), e21 = ema(closes, 21)
  const e50 = closes.length >= 50 ? ema(closes, 50) : e21
  const emaStackBull = e9 > e21 && e21 > e50 && price > e21
  const emaStackBear = e9 < e21 && e21 < e50 && price < e21
  const features = { ret5d, ret20d, rsi14: rsi, bbWidthPct, distFromHigh20, distFromLow20, volRatio, emaStackBull, emaStackBear }

  const longCfl: FnoFuturesRow['confluences'] = [
    { name: 'EMA 9>21>50 stack', pass: emaStackBull, detail: `9=${e9.toFixed(1)} 21=${e21.toFixed(1)} 50=${e50.toFixed(1)}` },
    { name: 'At 20d high', pass: distFromHigh20 < 3, detail: `${distFromHigh20.toFixed(1)}% off` },
    { name: 'Tight coil (BB <12%)', pass: bbWidthPct < 12, detail: `${bbWidthPct.toFixed(1)}%` },
    { name: 'Vol 5d/20d rising >1.3×', pass: volRatio > 1.3, detail: `${volRatio.toFixed(2)}×` },
    { name: 'RSI 50–70 productive', pass: rsi >= 50 && rsi <= 70, detail: `${rsi.toFixed(0)}` },
    { name: '20d return 5–25% (not extended)', pass: ret20d > 5 && ret20d < 25, detail: `${ret20d.toFixed(1)}%` },
  ]
  const shortCfl: FnoFuturesRow['confluences'] = [
    { name: 'EMA 9<21<50 stack', pass: emaStackBear, detail: `9=${e9.toFixed(1)} 21=${e21.toFixed(1)} 50=${e50.toFixed(1)}` },
    { name: 'At 20d low', pass: distFromLow20 < 3, detail: `${distFromLow20.toFixed(1)}% off` },
    { name: 'Tight coil (BB <12%)', pass: bbWidthPct < 12, detail: `${bbWidthPct.toFixed(1)}%` },
    { name: 'Vol 5d/20d distribution >1.3×', pass: volRatio > 1.3, detail: `${volRatio.toFixed(2)}×` },
    { name: 'RSI 30–50 weak', pass: rsi >= 30 && rsi <= 50, detail: `${rsi.toFixed(0)}` },
    { name: '20d return -25–-5% (breakdown)', pass: ret20d < -5 && ret20d > -25, detail: `${ret20d.toFixed(1)}%` },
  ]

  const longPoints = [20, 15, 15, 15, 10, 10]
  const longScore = longCfl.reduce((s, c, i) => s + (c.pass ? longPoints[i] : 0), 0)
  const shortScore = shortCfl.reduce((s, c, i) => s + (c.pass ? longPoints[i] : 0), 0)
  const extPenalty = Math.abs(ret5d) > 8 ? 20 : 0
  let score = 0, side: FnoSide = 'LONG', cfl = longCfl
  if (shortScore > longScore) { score = shortScore; side = 'SHORT'; cfl = shortCfl }
  else { score = longScore }
  score -= extPenalty

  const reasons: string[] = []
  for (const c of cfl) if (c.pass) reasons.push(`${c.name}: ${c.detail}`)
  if (extPenalty) reasons.push(`⚠️ already extended (5d ${ret5d.toFixed(1)}%) — penalty applied`)

  return { side, score, features, confluences: cfl, reasons, price }
}

export async function scanFnoFutures(opts?: { maxConcurrency?: number; limit?: number }): Promise<FnoFuturesRow[]> {
  const universe = await listFnoUnderlyings()
  if (!universe.length) {
    log.warn('FNO-SCAN', 'no F&O underlyings (ScripMaster not loaded?)')
    return []
  }
  log.info('FNO-SCAN', `scanning ${universe.length} F&O futures`)

  const BATCH = opts?.maxConcurrency ?? 6
  const raw: Array<{ symbol: string; r: NonNullable<ReturnType<typeof scoreOne>> }> = []
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = universe.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(async sym => {
      const c = await fetchCandles(sym)
      if (!c) return null
      const r = scoreOne(sym, c)
      return r ? { symbol: sym, r } : null
    }))
    for (const x of results) if (x) raw.push(x)
  }

  // Keep only setups with base score ≥ 55 (before institutional overlay)
  const surviving = raw.filter(x => x.r.score >= 55)
  log.info('FNO-SCAN', `${surviving.length} setups passed base filter`)

  // Institutional overlay — FII / DII / promoter — bounded concurrency
  const enriched: FnoFuturesRow[] = []
  const today = new Date()
  for (let i = 0; i < surviving.length; i += 4) {
    const batch = surviving.slice(i, i + 4)
    const rows = await Promise.all(batch.map(async ({ symbol, r }) => {
      const shp = await getShareholding(symbol).catch(() => null)
      const fiiDelta = shp?.fiiDeltaQoQ ?? null
      const diiDelta = shp?.diiDeltaQoQ ?? null
      const promoterDelta = shp?.promoterDeltaQoQ ?? null
      const marketCapCr = shp?.marketCapCr ?? null

      let score = r.score
      const cfl: FnoFuturesRow['confluences'] = [...r.confluences]
      if (typeof fiiDelta === 'number' && fiiDelta > 0.2) {
        score += 10
        cfl.push({ name: 'FII stake ↑', pass: true, detail: `+${fiiDelta.toFixed(2)}pp QoQ` })
      } else {
        cfl.push({ name: 'FII stake ↑', pass: false, detail: fiiDelta != null ? `${fiiDelta.toFixed(2)}pp QoQ` : 'unavailable' })
      }
      if (typeof promoterDelta === 'number' && promoterDelta >= 0) {
        score += 5
        cfl.push({ name: 'Promoter stable/buying', pass: true, detail: `${promoterDelta >= 0 ? '+' : ''}${promoterDelta.toFixed(2)}pp` })
      } else {
        cfl.push({ name: 'Promoter stable/buying', pass: false, detail: promoterDelta != null ? `${promoterDelta.toFixed(2)}pp` : 'unavailable' })
      }

      score = Math.max(0, Math.min(100, score))
      if (score < 65) return null

      const conf: FnoConfidence = score >= 80 ? 'HIGH' : 'MED'
      const grade: 'A' | 'B' = score >= 80 ? 'A' : 'B'
      const dir = r.side === 'LONG' ? 1 : -1
      const slPct = r.features.bbWidthPct < 8 ? 0.045 : 0.06
      const entry = r.price
      const sl = +(entry * (1 - dir * slPct)).toFixed(2)
      const t1 = +(entry * (1 + dir * TARGET_PCT.T1)).toFixed(2)
      const t2 = +(entry * (1 + dir * TARGET_PCT.T2)).toFixed(2)
      const t3 = +(entry * (1 + dir * TARGET_PCT.T3)).toFixed(2)

      const out: FnoFuturesRow = {
        symbol, side: r.side, price: r.price,
        entry, stopLoss: sl, target1: t1, target2: t2, target3: t3,
        target1Date: addBizDays(today, TARGET_DAYS.T1),
        target2Date: addBizDays(today, TARGET_DAYS.T2),
        target3Date: addBizDays(today, TARGET_DAYS.T3),
        expectedMovePct: TARGET_PCT.T3 * 100,
        score, confidence: conf, grade,
        features: r.features, confluences: cfl, reasons: r.reasons,
        fiiDelta, diiDelta, promoterDelta, marketCapCr,
        asOf: today.toISOString(),
      }
      return out
    }))
    for (const r of rows) if (r) enriched.push(r)
  }

  enriched.sort((a, b) => b.score - a.score)
  const top = enriched.slice(0, opts?.limit ?? 20)
  log.ok('FNO-SCAN', `${enriched.length} final picks · top ${top.length} returned`)
  return top
}
