import type { Candle } from '../types'
import { findZigZagPivots, type Pivot } from './harmonic'

/**
 * Lightweight Elliott Wave context — NOT a full impulse counter (proper wave
 * counting is subjective even for human traders). What we provide instead:
 *
 *   - Trend state from the last 7-9 ZigZag pivots
 *   - Simple HH/HL or LL/LH classification
 *   - "Bottoming complete?" heuristic — needs 2+ Higher Lows AND 1 Higher High
 *     after the most recent significant low
 *   - "Topping complete?" heuristic — mirror logic
 *   - Wave 5 hypothesis flag — when we see the 9-pivot pattern of an
 *     impulse approaching exhaustion (3 of 5 with extension on wave 3)
 *
 * Used by getBestCycleTrade to decide whether the cycle's directional bias
 * is supported by structure or fighting it.
 */

export type WavePhase =
  | 'IMPULSE_UP'           // bull trend in progress (HH/HL sequence)
  | 'IMPULSE_DOWN'         // bear trend in progress (LL/LH sequence)
  | 'CORRECTION_UP'        // counter-trend bounce within larger downtrend
  | 'CORRECTION_DOWN'      // pullback within larger uptrend
  | 'BOTTOMING'            // structure suggests low is in
  | 'TOPPING'              // structure suggests high is in
  | 'CONSOLIDATION'        // ranging, no clear wave
  | 'UNKNOWN'

export interface ElliottContext {
  phase: WavePhase
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  reasoning: string[]
  bottomingComplete: boolean
  toppingComplete: boolean
  pivotsAnalysed: number
  lastSignificantLow?: { time: number; price: number }
  lastSignificantHigh?: { time: number; price: number }
  /** Ratio of last leg vs prior — wave 3 should be > wave 1, wave 5 ≈ wave 1 */
  legRatios: { last: number; prior: number; ratio: number } | null
}

export function getElliottContext(candles: Candle[], minSwingPct = 1.5): ElliottContext {
  const pivots = findZigZagPivots(candles, minSwingPct)
  if (pivots.length < 4) {
    return {
      phase: 'UNKNOWN',
      confidence: 'LOW',
      reasoning: ['Not enough swing pivots to analyze structure'],
      bottomingComplete: false,
      toppingComplete: false,
      pivotsAnalysed: pivots.length,
      legRatios: null,
    }
  }

  // Use the last 7 pivots for wave context (covers a 5-3 cycle)
  const recent = pivots.slice(-7)
  const highs = recent.filter(p => p.kind === 'HIGH')
  const lows = recent.filter(p => p.kind === 'LOW')

  const reasoning: string[] = []

  // Sequence checks
  let hhCount = 0, hlCount = 0, llCount = 0, lhCount = 0
  for (let i = 1; i < highs.length; i++) {
    if (highs[i].price > highs[i - 1].price) hhCount++; else lhCount++
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price > lows[i - 1].price) hlCount++; else llCount++
  }

  const lastLow  = lows.length ? lows[lows.length - 1] : undefined
  const lastHigh = highs.length ? highs[highs.length - 1] : undefined
  const lastPivot = recent[recent.length - 1]
  const last2 = recent.slice(-2)
  const last3 = recent.slice(-3)

  // Bottoming check: most recent low followed by HL + HH
  let bottomingComplete = false
  if (lows.length >= 2 && highs.length >= 1) {
    const recentTwoLows = lows.slice(-2)
    const recentHigh = highs[highs.length - 1]
    if (recentTwoLows[1].price > recentTwoLows[0].price &&
        recentHigh.time > recentTwoLows[0].time &&
        recentHigh.price > recentTwoLows[1].price * 1.005) {
      bottomingComplete = true
      reasoning.push(`Bottoming structure intact: HL after low + HH at ₹${recentHigh.price.toFixed(2)}`)
    }
  }

  // Topping check: most recent high followed by LH + LL
  let toppingComplete = false
  if (highs.length >= 2 && lows.length >= 1) {
    const recentTwoHighs = highs.slice(-2)
    const recentLow = lows[lows.length - 1]
    if (recentTwoHighs[1].price < recentTwoHighs[0].price &&
        recentLow.time > recentTwoHighs[0].time &&
        recentLow.price < recentTwoHighs[1].price * 0.995) {
      toppingComplete = true
      reasoning.push(`Topping structure intact: LH after high + LL at ₹${recentLow.price.toFixed(2)}`)
    }
  }

  // Determine phase
  let phase: WavePhase = 'UNKNOWN'
  let confidence: ElliottContext['confidence'] = 'MEDIUM'

  if (hhCount >= 2 && hlCount >= 2 && llCount === 0) {
    phase = 'IMPULSE_UP'
    confidence = 'HIGH'
    reasoning.push(`${hhCount} higher highs + ${hlCount} higher lows — clean uptrend impulse`)
  } else if (llCount >= 2 && lhCount >= 2 && hhCount === 0) {
    phase = 'IMPULSE_DOWN'
    confidence = 'HIGH'
    reasoning.push(`${llCount} lower lows + ${lhCount} lower highs — clean downtrend impulse`)
  } else if (bottomingComplete) {
    phase = 'BOTTOMING'
    confidence = hlCount >= 2 ? 'HIGH' : 'MEDIUM'
  } else if (toppingComplete) {
    phase = 'TOPPING'
    confidence = lhCount >= 2 ? 'HIGH' : 'MEDIUM'
  } else if (lhCount >= 1 && hhCount === 0 && llCount >= 1) {
    phase = 'IMPULSE_DOWN'
    confidence = 'MEDIUM'
    reasoning.push(`Lower highs + lower lows — downtrend, bottoming NOT yet confirmed`)
  } else if (hhCount === 0 && lhCount >= 1 && hlCount >= 1) {
    phase = 'CORRECTION_UP'
    confidence = 'MEDIUM'
    reasoning.push('Counter-trend bounce within larger downtrend (no HH yet)')
  } else if (llCount === 0 && hlCount >= 1 && lhCount >= 1) {
    phase = 'CORRECTION_DOWN'
    confidence = 'MEDIUM'
    reasoning.push('Pullback within larger uptrend (no LL yet)')
  } else {
    phase = 'CONSOLIDATION'
    confidence = 'LOW'
    reasoning.push('Mixed pivot structure — no clean wave count')
  }

  // Last leg vs prior — Elliott extension hint
  let legRatios: ElliottContext['legRatios'] = null
  if (last3.length === 3) {
    const lastLeg  = Math.abs(last3[2].price - last3[1].price)
    const priorLeg = Math.abs(last3[1].price - last3[0].price)
    legRatios = {
      last: lastLeg, prior: priorLeg,
      ratio: priorLeg > 0 ? +(lastLeg / priorLeg).toFixed(2) : 0,
    }
  }

  // Wave 5 exhaustion heuristic — last leg ≈ first leg AND in same direction
  if (legRatios && legRatios.ratio > 0.85 && legRatios.ratio < 1.25 && pivots.length >= 9) {
    if (phase === 'IMPULSE_UP') {
      reasoning.push(`Last leg ${legRatios.ratio}× prior — possible Wave 5 exhaustion (uptrend)`)
    } else if (phase === 'IMPULSE_DOWN') {
      reasoning.push(`Last leg ${legRatios.ratio}× prior — possible Wave 5 capitulation (downtrend bottom near)`)
    }
  }

  return {
    phase,
    confidence,
    reasoning,
    bottomingComplete,
    toppingComplete,
    pivotsAnalysed: recent.length,
    lastSignificantLow:  lastLow  ? { time: lastLow.time,  price: lastLow.price }  : undefined,
    lastSignificantHigh: lastHigh ? { time: lastHigh.time, price: lastHigh.price } : undefined,
    legRatios,
  }
}
