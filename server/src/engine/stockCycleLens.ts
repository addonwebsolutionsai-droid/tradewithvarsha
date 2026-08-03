/**
 * Stock Cycle + Seasonality Lens (3 Aug 2026)
 *
 * User directive #5:
 *   "Time Cycle, Historical seasonality analysis"
 *
 * Currently only NIFTY has time-cycle analysis (nifty-long-horizon
 * emits Gann 90/180/270-day waypoints). This module gives ANY stock a
 * cycle + seasonality score so those lenses feed MASTER / Money-Printer.
 *
 * Composition:
 *
 *   1. GANN cycles (90 / 180 / 270 / 360-day forward projection from
 *      every major swing high/low in the last 3y). If today ± 3
 *      sessions falls inside a cycle cluster → +bonus.
 *
 *   2. SEASONALITY — same-calendar-week 5y median return. If the
 *      stock has historically returned >2% in this calendar week
 *      → bullish tailwind. <-2% → bearish headwind.
 *
 *   3. MONTHLY seasonality — same-calendar-month 5y median.
 *
 * Output: cycleScore ∈ [-30, +30] per symbol, direction-aligned.
 * Callers pass their direction and receive a signed adjustment.
 */

import type { Candle } from '../types'
import { log } from '../util/logger'
import * as data from '../data'

export interface CycleLensResult {
  symbol: string
  cycleScore: number                     // signed, direction-aligned to BUY
  gannCycles: Array<{ pivotDate: string; days: number; targetDate: string; type: 'HIGH' | 'LOW' }>
  gannHit: boolean                        // is today within ± 3 sessions of a cycle cluster?
  seasonalityWeekMedian: number          // % — same calendar week 5y median return
  seasonalityMonthMedian: number         // % — same calendar month 5y median return
  seasonalityTailwind: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  reasoning: string[]
}

/**
 * Extract swing pivots (highs + lows) using a simple ZigZag with
 * threshold N% — matches how nifty-long-horizon does it.
 */
function extractPivots(candles: Candle[], thresholdPct = 5): Array<{ index: number; price: number; type: 'HIGH' | 'LOW' }> {
  const pivots: Array<{ index: number; price: number; type: 'HIGH' | 'LOW' }> = []
  if (!candles || candles.length < 30) return pivots
  const th = thresholdPct / 100
  let lastPivot = { index: 0, price: candles[0].close, type: 'LOW' as 'HIGH' | 'LOW' }
  let currentExtreme = { index: 0, price: candles[0].close, type: 'LOW' as 'HIGH' | 'LOW' }
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    if (currentExtreme.type === 'LOW') {
      if (c.high > currentExtreme.price * (1 + th)) {
        pivots.push(lastPivot)
        lastPivot = { ...currentExtreme }
        currentExtreme = { index: i, price: c.high, type: 'HIGH' }
      } else if (c.low < currentExtreme.price) {
        currentExtreme = { index: i, price: c.low, type: 'LOW' }
      }
    } else {
      if (c.low < currentExtreme.price * (1 - th)) {
        pivots.push(lastPivot)
        lastPivot = { ...currentExtreme }
        currentExtreme = { index: i, price: c.low, type: 'LOW' }
      } else if (c.high > currentExtreme.price) {
        currentExtreme = { index: i, price: c.high, type: 'HIGH' }
      }
    }
  }
  pivots.push(lastPivot)
  return pivots
}

/**
 * Same-week-of-year median return over the last 5y worth of data.
 */
function sameWeekMedian(candles: Candle[]): number {
  if (!candles || candles.length < 250) return 0
  const now = new Date()
  const nowWeek = Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / (7 * 24 * 3600_000))
  const returns: number[] = []
  // Walk candles, group by week-of-year, compute weekly return
  for (let i = 5; i < candles.length; i++) {
    const c = candles[i]
    const d = new Date(c.time)
    const w = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / (7 * 24 * 3600_000))
    if (Math.abs(w - nowWeek) <= 1) {
      const ref = candles[i - 5]
      if (ref?.close > 0) returns.push((c.close - ref.close) / ref.close * 100)
    }
  }
  if (returns.length === 0) return 0
  returns.sort((a, b) => a - b)
  return returns[Math.floor(returns.length / 2)]
}

/**
 * Same-month median return over available history.
 */
function sameMonthMedian(candles: Candle[]): number {
  if (!candles || candles.length < 250) return 0
  const nowMonth = new Date().getMonth()
  const returns: number[] = []
  for (let i = 20; i < candles.length; i++) {
    const c = candles[i]
    const d = new Date(c.time)
    if (d.getMonth() !== nowMonth) continue
    const ref = candles[i - 20]
    if (ref?.close > 0) returns.push((c.close - ref.close) / ref.close * 100)
  }
  if (returns.length === 0) return 0
  returns.sort((a, b) => a - b)
  return returns[Math.floor(returns.length / 2)]
}

/**
 * Compute a symbol's cycle + seasonality score. Direction-aligned
 * to BUY (a caller shorting the name should invert).
 */
export async function computeStockCycleLens(symbol: string, direction: 'BUY' | 'SHORT' = 'BUY'): Promise<CycleLensResult | null> {
  let candles: Candle[]
  try {
    candles = await data.getCandles(symbol, '1D' as any, 900)
  } catch {
    return null
  }
  if (!candles || candles.length < 90) return null

  const pivots = extractPivots(candles, 5)
  const gannCycles: CycleLensResult['gannCycles'] = []
  const nowMs = Date.now()
  const nowSessionIdx = candles.length - 1
  let gannHit = false
  let gannBull = 0, gannBear = 0
  for (const p of pivots) {
    for (const d of [90, 180, 270, 360]) {
      const targetIdx = p.index + d
      if (targetIdx <= nowSessionIdx && Math.abs(targetIdx - nowSessionIdx) <= 3) {
        gannHit = true
        const pivotDateStr = new Date(candles[p.index].time).toISOString().slice(0, 10)
        const targetDateStr = new Date(candles[Math.min(targetIdx, candles.length - 1)].time).toISOString().slice(0, 10)
        gannCycles.push({ pivotDate: pivotDateStr, days: d, targetDate: targetDateStr, type: p.type })
        // Cycle from a LOW pivot = reversal date → LOW likely turns bullish
        // Cycle from a HIGH pivot = reversal date → HIGH likely turns bearish
        if (p.type === 'LOW') gannBull++
        else gannBear++
      }
    }
  }
  const weekMedian = sameWeekMedian(candles)
  const monthMedian = sameMonthMedian(candles)
  const seasonalityAvg = (weekMedian + monthMedian) / 2
  let seasonalityTailwind: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL'
  if (seasonalityAvg > 2) seasonalityTailwind = 'BULLISH'
  else if (seasonalityAvg < -2) seasonalityTailwind = 'BEARISH'

  const reasoning: string[] = []
  let cycleScore = 0
  if (gannHit) {
    const net = gannBull - gannBear
    const gannBonus = Math.min(15, Math.abs(net) * 5)
    cycleScore += net > 0 ? gannBonus : -gannBonus
    reasoning.push(`Gann cluster hit: ${gannBull} LOW + ${gannBear} HIGH pivot echoes align today (± 3 sessions)`)
  }
  if (seasonalityTailwind === 'BULLISH') {
    cycleScore += Math.min(15, weekMedian * 3)
    reasoning.push(`Seasonality tailwind: this week 5y median ${weekMedian.toFixed(2)}% · this month ${monthMedian.toFixed(2)}%`)
  } else if (seasonalityTailwind === 'BEARISH') {
    cycleScore -= Math.min(15, Math.abs(weekMedian) * 3)
    reasoning.push(`⚠ Seasonality headwind: this week 5y median ${weekMedian.toFixed(2)}% · this month ${monthMedian.toFixed(2)}%`)
  }
  // Invert if the caller is shorting
  if (direction === 'SHORT') cycleScore = -cycleScore

  return {
    symbol,
    cycleScore: Math.max(-30, Math.min(30, Math.round(cycleScore))),
    gannCycles,
    gannHit,
    seasonalityWeekMedian: +weekMedian.toFixed(2),
    seasonalityMonthMedian: +monthMedian.toFixed(2),
    seasonalityTailwind,
    reasoning,
  }
}
