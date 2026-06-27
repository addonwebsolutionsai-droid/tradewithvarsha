/**
 * CHART PATTERN SCANNER — pilot mode.
 *
 * User directive 2026-06-26: build a chart-pattern recognizer that scans
 * the full list across timeframes and outputs pattern + measured-move
 * target.
 *
 * IMPORTANT — IP / attribution:
 * The detection algorithms below are my own original implementations of
 * widely-documented technical-analysis patterns. The patterns themselves
 * (Head & Shoulders, Double Top, Triangles, Flag, Wedge, Cup & Handle,
 * candlestick formations etc.) have been described in countless sources
 * going back to Robert D. Edwards & John Magee's "Technical Analysis of
 * Stock Trends" (1948). The math is factual / non-copyrightable.
 * Attribution credit (not redistribution) to the standard reference set:
 *   - Edwards & Magee, Technical Analysis of Stock Trends
 *   - John J. Murphy, Technical Analysis of the Financial Markets
 *   - Thomas Bulkowski, Encyclopedia of Chart Patterns
 *   - Steve Nison, Japanese Candlestick Charting Techniques
 *
 * The PDFs the user linked are NOT downloaded or stored. The user can
 * read those publishers' original works to cross-reference our outputs.
 *
 * Each detector returns:
 *   { pattern, direction, entry, stopLoss, target, confidence, neckline,
 *     reasoning }
 *
 * Target calculation uses the "measured move" / "pattern height" rule
 * standard in classical TA — e.g. H&S target = neckline - (head - neckline).
 */
import fs from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import { getCandles } from '../data'
import type { Candle } from '../types'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

export type Direction = 'BUY' | 'SHORT'
export type Timeframe = 'DAILY' | 'WEEKLY'

export interface PatternHit {
  symbol: string
  pattern: string                  // e.g. "Head & Shoulders" / "Bullish Engulfing"
  direction: Direction
  timeframe: Timeframe
  entry: number
  stopLoss: number
  target1: number
  target2: number | null
  expectedMovePct: number
  confidence: 'HIGH' | 'MED' | 'LOW'
  patternHeight: number            // measured-move basis
  reasoning: string[]
  formedAt: string                 // ISO date of pattern completion
  capturedAt: string
}

// — Swing / pivot detection (shared by chart patterns) —

interface Pivot { idx: number; price: number; type: 'HIGH' | 'LOW' }

function findPivots(candles: Candle[], lookback = 3): Pivot[] {
  const out: Pivot[] = []
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]
    let isHigh = true, isLow = true
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue
      if (candles[j].high >= c.high) isHigh = false
      if (candles[j].low <= c.low) isLow = false
    }
    if (isHigh) out.push({ idx: i, price: c.high, type: 'HIGH' })
    if (isLow) out.push({ idx: i, price: c.low, type: 'LOW' })
  }
  return out
}

function atr14(candles: Candle[]): number {
  if (candles.length < 15) return 0
  let s = 0
  for (let i = candles.length - 14; i < candles.length; i++) {
    s += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    )
  }
  return s / 14
}

// ─────────────────────────────────────────────────────────────────────
// PATTERN DETECTORS
// Each takes candles + symbol + timeframe, returns hit or null.
// All return at most ONE most-recent pattern of its kind.
// ─────────────────────────────────────────────────────────────────────

// — Head & Shoulders / Inverse H&S —
// Three peaks (or troughs): left shoulder · head (highest) · right shoulder.
// Neckline = line through the two intervening lows. Pattern completes when
// price closes below the neckline (bearish) or above (bullish inverse).
// Measured-move target = neckline - (head - neckline).
function detectHeadAndShoulders(candles: Candle[], symbol: string, tf: Timeframe): PatternHit | null {
  if (candles.length < 30) return null
  const last = candles[candles.length - 1]
  const pivots = findPivots(candles, 3)
  if (pivots.length < 5) return null

  // Look at the last 5 alternating high/low pivots
  // For bearish: HIGH (LS) - LOW - HIGH (Head, highest) - LOW - HIGH (RS)
  const recent = pivots.slice(-9)
  for (let i = 0; i <= recent.length - 5; i++) {
    const window = recent.slice(i, i + 5)
    const [ls, t1, head, t2, rs] = window
    if (!ls || !t1 || !head || !t2 || !rs) continue
    if (ls.type !== 'HIGH' || t1.type !== 'LOW' || head.type !== 'HIGH' || t2.type !== 'LOW' || rs.type !== 'HIGH') continue
    if (head.price <= ls.price || head.price <= rs.price) continue          // head must be highest
    const shoulderDiff = Math.abs(ls.price - rs.price) / ls.price
    if (shoulderDiff > 0.08) continue                                       // shoulders within 8%
    const neckline = (t1.price + t2.price) / 2
    const height = head.price - neckline
    if (height / head.price < 0.04) continue                                // need a meaningful pattern
    // Confirmation: last close below neckline
    if (last.close >= neckline * 1.005) continue
    const target = +(neckline - height).toFixed(2)
    const sl = +(rs.price * 1.02).toFixed(2)
    const entry = +last.close.toFixed(2)
    return {
      symbol, pattern: 'Head & Shoulders', direction: 'SHORT', timeframe: tf,
      entry, stopLoss: sl, target1: target, target2: +(target - height * 0.4).toFixed(2),
      expectedMovePct: +(((entry - target) / entry) * 100).toFixed(1),
      confidence: shoulderDiff < 0.04 ? 'HIGH' : 'MED',
      patternHeight: +height.toFixed(2),
      reasoning: [
        `LS ₹${ls.price.toFixed(1)} · Head ₹${head.price.toFixed(1)} · RS ₹${rs.price.toFixed(1)}`,
        `Neckline ₹${neckline.toFixed(1)} · pattern height ₹${height.toFixed(1)}`,
        `Measured-move target = neckline − height`,
      ],
      formedAt: new Date(candles[rs.idx].time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  return null
}

function detectInverseHeadAndShoulders(candles: Candle[], symbol: string, tf: Timeframe): PatternHit | null {
  if (candles.length < 30) return null
  const last = candles[candles.length - 1]
  const pivots = findPivots(candles, 3)
  if (pivots.length < 5) return null
  const recent = pivots.slice(-9)
  for (let i = 0; i <= recent.length - 5; i++) {
    const window = recent.slice(i, i + 5)
    const [ls, t1, head, t2, rs] = window
    if (!ls || !t1 || !head || !t2 || !rs) continue
    if (ls.type !== 'LOW' || t1.type !== 'HIGH' || head.type !== 'LOW' || t2.type !== 'HIGH' || rs.type !== 'LOW') continue
    if (head.price >= ls.price || head.price >= rs.price) continue
    const shoulderDiff = Math.abs(ls.price - rs.price) / ls.price
    if (shoulderDiff > 0.08) continue
    const neckline = (t1.price + t2.price) / 2
    const height = neckline - head.price
    if (height / head.price < 0.04) continue
    if (last.close <= neckline * 0.995) continue                            // need confirmation
    const target = +(neckline + height).toFixed(2)
    const sl = +(rs.price * 0.98).toFixed(2)
    const entry = +last.close.toFixed(2)
    return {
      symbol, pattern: 'Inverse Head & Shoulders', direction: 'BUY', timeframe: tf,
      entry, stopLoss: sl, target1: target, target2: +(target + height * 0.4).toFixed(2),
      expectedMovePct: +(((target - entry) / entry) * 100).toFixed(1),
      confidence: shoulderDiff < 0.04 ? 'HIGH' : 'MED',
      patternHeight: +height.toFixed(2),
      reasoning: [
        `LS ₹${ls.price.toFixed(1)} · Head ₹${head.price.toFixed(1)} · RS ₹${rs.price.toFixed(1)}`,
        `Neckline ₹${neckline.toFixed(1)} · pattern height ₹${height.toFixed(1)}`,
        `Measured-move target = neckline + height`,
      ],
      formedAt: new Date(candles[rs.idx].time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  return null
}

// — Double Top / Double Bottom —
function detectDoubleTop(candles: Candle[], symbol: string, tf: Timeframe): PatternHit | null {
  if (candles.length < 20) return null
  const last = candles[candles.length - 1]
  const pivots = findPivots(candles, 3)
  const highs = pivots.filter(p => p.type === 'HIGH').slice(-4)
  if (highs.length < 2) return null
  for (let i = highs.length - 2; i >= 0; i--) {
    const a = highs[i], b = highs[i + 1]
    const diff = Math.abs(a.price - b.price) / a.price
    if (diff > 0.04) continue                                               // peaks within 4%
    const gapBars = b.idx - a.idx
    if (gapBars < 5 || gapBars > 60) continue
    // Find the valley between them
    let valley = candles[a.idx]
    for (let k = a.idx; k <= b.idx; k++) if (candles[k].low < valley.low) valley = candles[k]
    const neckline = valley.low
    const height = ((a.price + b.price) / 2) - neckline
    if (height / a.price < 0.04) continue
    if (last.close >= neckline * 1.005) continue                            // need break below neckline
    const target = +(neckline - height).toFixed(2)
    const sl = +(b.price * 1.02).toFixed(2)
    const entry = +last.close.toFixed(2)
    return {
      symbol, pattern: 'Double Top', direction: 'SHORT', timeframe: tf,
      entry, stopLoss: sl, target1: target, target2: null,
      expectedMovePct: +(((entry - target) / entry) * 100).toFixed(1),
      confidence: diff < 0.02 ? 'HIGH' : 'MED',
      patternHeight: +height.toFixed(2),
      reasoning: [
        `Peak1 ₹${a.price.toFixed(1)} · Peak2 ₹${b.price.toFixed(1)} (Δ ${(diff * 100).toFixed(1)}%)`,
        `Neckline ₹${neckline.toFixed(1)}`,
        `Measured-move target = neckline − height`,
      ],
      formedAt: new Date(candles[b.idx].time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  return null
}

function detectDoubleBottom(candles: Candle[], symbol: string, tf: Timeframe): PatternHit | null {
  if (candles.length < 20) return null
  const last = candles[candles.length - 1]
  const pivots = findPivots(candles, 3)
  const lows = pivots.filter(p => p.type === 'LOW').slice(-4)
  if (lows.length < 2) return null
  for (let i = lows.length - 2; i >= 0; i--) {
    const a = lows[i], b = lows[i + 1]
    const diff = Math.abs(a.price - b.price) / a.price
    if (diff > 0.04) continue
    const gapBars = b.idx - a.idx
    if (gapBars < 5 || gapBars > 60) continue
    let peak = candles[a.idx]
    for (let k = a.idx; k <= b.idx; k++) if (candles[k].high > peak.high) peak = candles[k]
    const neckline = peak.high
    const height = neckline - ((a.price + b.price) / 2)
    if (height / a.price < 0.04) continue
    if (last.close <= neckline * 0.995) continue
    const target = +(neckline + height).toFixed(2)
    const sl = +(b.price * 0.98).toFixed(2)
    const entry = +last.close.toFixed(2)
    return {
      symbol, pattern: 'Double Bottom', direction: 'BUY', timeframe: tf,
      entry, stopLoss: sl, target1: target, target2: null,
      expectedMovePct: +(((target - entry) / entry) * 100).toFixed(1),
      confidence: diff < 0.02 ? 'HIGH' : 'MED',
      patternHeight: +height.toFixed(2),
      reasoning: [
        `Trough1 ₹${a.price.toFixed(1)} · Trough2 ₹${b.price.toFixed(1)} (Δ ${(diff * 100).toFixed(1)}%)`,
        `Neckline ₹${neckline.toFixed(1)}`,
        `Measured-move target = neckline + height`,
      ],
      formedAt: new Date(candles[b.idx].time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  return null
}

// — Triangle (ascending / descending / symmetrical) —
// Linear regression on recent pivots: rising support + flat resistance = ASC
// (bullish breakout target). Falling resistance + flat support = DESC
// (bearish). Both converging = symmetrical (direction = prior trend).
function detectTriangle(candles: Candle[], symbol: string, tf: Timeframe): PatternHit | null {
  if (candles.length < 25) return null
  const recent = candles.slice(-30)
  const pivots = findPivots(recent, 2)
  const highs = pivots.filter(p => p.type === 'HIGH')
  const lows = pivots.filter(p => p.type === 'LOW')
  if (highs.length < 2 || lows.length < 2) return null
  const last = recent[recent.length - 1]

  const slope = (pts: Pivot[]): number => {
    const n = pts.length
    if (n < 2) return 0
    const meanX = pts.reduce((s, p) => s + p.idx, 0) / n
    const meanY = pts.reduce((s, p) => s + p.price, 0) / n
    let num = 0, den = 0
    for (const p of pts) { num += (p.idx - meanX) * (p.price - meanY); den += (p.idx - meanX) ** 2 }
    return den > 0 ? num / den : 0
  }
  const hSlope = slope(highs.slice(-4))
  const lSlope = slope(lows.slice(-4))
  // Normalize slope to percent-per-bar
  const hSlopePct = highs.length ? hSlope / highs[highs.length - 1].price * 100 : 0
  const lSlopePct = lows.length ? lSlope / lows[lows.length - 1].price * 100 : 0
  const lastHigh = Math.max(...recent.slice(-15).map(c => c.high))
  const lastLow = Math.min(...recent.slice(-15).map(c => c.low))
  const height = lastHigh - lastLow

  // Ascending: flat top + rising bottom
  if (Math.abs(hSlopePct) < 0.1 && lSlopePct > 0.15) {
    if (last.close > lastHigh * 0.995) {
      const target = +(lastHigh + height).toFixed(2)
      const entry = +last.close.toFixed(2)
      const sl = +(lastLow + height * 0.4).toFixed(2)
      return {
        symbol, pattern: 'Ascending Triangle', direction: 'BUY', timeframe: tf,
        entry, stopLoss: sl, target1: target, target2: null,
        expectedMovePct: +(((target - entry) / entry) * 100).toFixed(1),
        confidence: 'MED', patternHeight: +height.toFixed(2),
        reasoning: [
          `Flat resistance ₹${lastHigh.toFixed(1)} · rising support (slope ${lSlopePct.toFixed(2)}%/bar)`,
          `Breakout confirmed`,
          `Target = resistance + height ₹${height.toFixed(1)}`,
        ],
        formedAt: new Date(last.time).toISOString().slice(0, 10),
        capturedAt: new Date().toISOString(),
      }
    }
  }

  // Descending: falling top + flat bottom
  if (hSlopePct < -0.15 && Math.abs(lSlopePct) < 0.1) {
    if (last.close < lastLow * 1.005) {
      const target = +(lastLow - height).toFixed(2)
      const entry = +last.close.toFixed(2)
      const sl = +(lastHigh - height * 0.4).toFixed(2)
      return {
        symbol, pattern: 'Descending Triangle', direction: 'SHORT', timeframe: tf,
        entry, stopLoss: sl, target1: target, target2: null,
        expectedMovePct: +(((entry - target) / entry) * 100).toFixed(1),
        confidence: 'MED', patternHeight: +height.toFixed(2),
        reasoning: [
          `Falling resistance (slope ${hSlopePct.toFixed(2)}%/bar) · flat support ₹${lastLow.toFixed(1)}`,
          `Breakdown confirmed`,
          `Target = support − height ₹${height.toFixed(1)}`,
        ],
        formedAt: new Date(last.time).toISOString().slice(0, 10),
        capturedAt: new Date().toISOString(),
      }
    }
  }

  // Symmetrical: both converging
  if (hSlopePct < -0.1 && lSlopePct > 0.1) {
    const priorTrend = recent[10].close < recent[recent.length - 5].close ? 'BUY' : 'SHORT'
    if (priorTrend === 'BUY' && last.close > lastHigh * 0.995) {
      const target = +(lastHigh + height).toFixed(2)
      const entry = +last.close.toFixed(2)
      const sl = +(((lastHigh + lastLow) / 2) - height * 0.2).toFixed(2)
      return {
        symbol, pattern: 'Symmetrical Triangle (bullish)', direction: 'BUY', timeframe: tf,
        entry, stopLoss: sl, target1: target, target2: null,
        expectedMovePct: +(((target - entry) / entry) * 100).toFixed(1),
        confidence: 'MED', patternHeight: +height.toFixed(2),
        reasoning: [`Coiling triangle · prior trend bullish · breakout`],
        formedAt: new Date(last.time).toISOString().slice(0, 10),
        capturedAt: new Date().toISOString(),
      }
    }
    if (priorTrend === 'SHORT' && last.close < lastLow * 1.005) {
      const target = +(lastLow - height).toFixed(2)
      const entry = +last.close.toFixed(2)
      const sl = +(((lastHigh + lastLow) / 2) + height * 0.2).toFixed(2)
      return {
        symbol, pattern: 'Symmetrical Triangle (bearish)', direction: 'SHORT', timeframe: tf,
        entry, stopLoss: sl, target1: target, target2: null,
        expectedMovePct: +(((entry - target) / entry) * 100).toFixed(1),
        confidence: 'MED', patternHeight: +height.toFixed(2),
        reasoning: [`Coiling triangle · prior trend bearish · breakdown`],
        formedAt: new Date(last.time).toISOString().slice(0, 10),
        capturedAt: new Date().toISOString(),
      }
    }
  }
  return null
}

// — Flag / Pennant (continuation) —
// Strong impulse leg (the "flagpole") followed by a tight counter-trend
// consolidation 5-15 bars. Breakout in impulse direction. Target = pole height.
function detectFlag(candles: Candle[], symbol: string, tf: Timeframe): PatternHit | null {
  if (candles.length < 20) return null
  const last = candles[candles.length - 1]
  const atr = atr14(candles)
  if (atr === 0) return null
  // Search for impulse 5-12 bars long ending 5-15 bars ago
  for (let consolBars = 5; consolBars <= 15; consolBars++) {
    const poleEndIdx = candles.length - 1 - consolBars
    if (poleEndIdx < 7) continue
    for (let poleBars = 5; poleBars <= 12; poleBars++) {
      const poleStartIdx = poleEndIdx - poleBars
      if (poleStartIdx < 0) continue
      const poleStart = candles[poleStartIdx]
      const poleEnd = candles[poleEndIdx]
      const poleMovePct = (poleEnd.close - poleStart.close) / poleStart.close * 100
      const consolBlock = candles.slice(poleEndIdx, poleEndIdx + consolBars + 1)
      const consolHi = Math.max(...consolBlock.map(c => c.high))
      const consolLo = Math.min(...consolBlock.map(c => c.low))
      const consolRange = (consolHi - consolLo) / poleEnd.close * 100
      // Bullish flag: pole >7% up, consol range <40% of pole, breakout above consol hi
      if (poleMovePct > 7 && consolRange < poleMovePct * 0.5 && last.close > consolHi) {
        const poleHeight = poleEnd.close - poleStart.close
        const target = +(last.close + poleHeight).toFixed(2)
        const sl = +(consolLo * 0.99).toFixed(2)
        return {
          symbol, pattern: 'Bullish Flag', direction: 'BUY', timeframe: tf,
          entry: +last.close.toFixed(2), stopLoss: sl, target1: target, target2: null,
          expectedMovePct: +((poleHeight / last.close) * 100).toFixed(1),
          confidence: poleMovePct > 12 ? 'HIGH' : 'MED',
          patternHeight: +poleHeight.toFixed(2),
          reasoning: [
            `Pole ${poleBars}-bar (+${poleMovePct.toFixed(1)}%) · consol ${consolBars} bars (range ${consolRange.toFixed(1)}%)`,
            `Breakout above consol high ₹${consolHi.toFixed(1)}`,
            `Target = breakout + pole height`,
          ],
          formedAt: new Date(last.time).toISOString().slice(0, 10),
          capturedAt: new Date().toISOString(),
        }
      }
      // Bearish flag: pole >7% down
      if (poleMovePct < -7 && consolRange < Math.abs(poleMovePct) * 0.5 && last.close < consolLo) {
        const poleHeight = poleStart.close - poleEnd.close
        const target = +(last.close - poleHeight).toFixed(2)
        const sl = +(consolHi * 1.01).toFixed(2)
        return {
          symbol, pattern: 'Bearish Flag', direction: 'SHORT', timeframe: tf,
          entry: +last.close.toFixed(2), stopLoss: sl, target1: target, target2: null,
          expectedMovePct: +((poleHeight / last.close) * 100).toFixed(1),
          confidence: Math.abs(poleMovePct) > 12 ? 'HIGH' : 'MED',
          patternHeight: +poleHeight.toFixed(2),
          reasoning: [
            `Pole ${poleBars}-bar (${poleMovePct.toFixed(1)}%) · consol ${consolBars} bars`,
            `Breakdown below consol low ₹${consolLo.toFixed(1)}`,
            `Target = breakdown − pole height`,
          ],
          formedAt: new Date(last.time).toISOString().slice(0, 10),
          capturedAt: new Date().toISOString(),
        }
      }
    }
  }
  return null
}

// — Cup & Handle —
// Rounded U-shaped base ("cup") followed by a small pullback ("handle")
// then breakout above the cup rim. Bullish continuation.
function detectCupAndHandle(candles: Candle[], symbol: string, tf: Timeframe): PatternHit | null {
  if (candles.length < 60) return null
  const last = candles[candles.length - 1]
  // Look back 40-90 bars for the cup
  for (let cupLen = 30; cupLen <= 90; cupLen += 10) {
    const cupEndIdx = candles.length - 8        // handle starts ~5-10 bars ago
    const cupStartIdx = cupEndIdx - cupLen
    if (cupStartIdx < 5) continue
    const cup = candles.slice(cupStartIdx, cupEndIdx + 1)
    const cupRim = Math.max(cup[0].close, cup[cup.length - 1].close)
    const cupLow = Math.min(...cup.map(c => c.low))
    const depth = (cupRim - cupLow) / cupRim
    if (depth < 0.12 || depth > 0.50) continue                              // cup 12-50% deep
    // Rim symmetry — both sides should be close in price
    const sideDiff = Math.abs(cup[0].close - cup[cup.length - 1].close) / cupRim
    if (sideDiff > 0.05) continue
    // Cup bottom should be roughly in the middle
    const lowIdx = cup.reduce((mi, c, i) => c.low < cup[mi].low ? i : mi, 0)
    if (lowIdx < cupLen * 0.3 || lowIdx > cupLen * 0.7) continue
    // Handle
    const handle = candles.slice(cupEndIdx)
    const handleHi = Math.max(...handle.map(c => c.high))
    const handleLo = Math.min(...handle.map(c => c.low))
    const handleDepth = (handleHi - handleLo) / cupRim
    if (handleDepth > depth * 0.5) continue                                 // handle < half cup depth
    if (last.close <= cupRim * 1.005) continue                              // need breakout above rim
    const cupHeight = cupRim - cupLow
    const target = +(cupRim + cupHeight).toFixed(2)
    const sl = +(handleLo * 0.99).toFixed(2)
    return {
      symbol, pattern: 'Cup & Handle', direction: 'BUY', timeframe: tf,
      entry: +last.close.toFixed(2), stopLoss: sl, target1: target, target2: null,
      expectedMovePct: +((cupHeight / last.close) * 100).toFixed(1),
      confidence: depth >= 0.18 && depth <= 0.33 ? 'HIGH' : 'MED',
      patternHeight: +cupHeight.toFixed(2),
      reasoning: [
        `Cup ${cup.length}-bar (depth ${(depth * 100).toFixed(0)}%)`,
        `Handle ${handle.length}-bar (depth ${(handleDepth * 100).toFixed(0)}% of cup)`,
        `Breakout above rim ₹${cupRim.toFixed(1)} · target = rim + cup depth`,
      ],
      formedAt: new Date(last.time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  return null
}

// — Rising Wedge (bearish) / Falling Wedge (bullish) —
function detectWedge(candles: Candle[], symbol: string, tf: Timeframe): PatternHit | null {
  if (candles.length < 25) return null
  const last = candles[candles.length - 1]
  const recent = candles.slice(-25)
  const pivots = findPivots(recent, 2)
  const highs = pivots.filter(p => p.type === 'HIGH').slice(-3)
  const lows = pivots.filter(p => p.type === 'LOW').slice(-3)
  if (highs.length < 2 || lows.length < 2) return null
  const hSlope = (highs[highs.length - 1].price - highs[0].price) / Math.max(1, highs[highs.length - 1].idx - highs[0].idx)
  const lSlope = (lows[lows.length - 1].price - lows[0].price) / Math.max(1, lows[lows.length - 1].idx - lows[0].idx)
  const recentLow = Math.min(...recent.slice(-10).map(c => c.low))
  const recentHigh = Math.max(...recent.slice(-10).map(c => c.high))
  // Rising wedge: both slopes positive, hSlope < lSlope (convergent), breakdown
  if (hSlope > 0 && lSlope > 0 && lSlope > hSlope * 1.3 && last.close < recentLow) {
    const height = recentHigh - recentLow
    const target = +(last.close - height).toFixed(2)
    const sl = +(recentHigh * 1.01).toFixed(2)
    return {
      symbol, pattern: 'Rising Wedge', direction: 'SHORT', timeframe: tf,
      entry: +last.close.toFixed(2), stopLoss: sl, target1: target, target2: null,
      expectedMovePct: +((height / last.close) * 100).toFixed(1),
      confidence: 'MED', patternHeight: +height.toFixed(2),
      reasoning: [
        `Rising wedge — converging trendlines (h-slope ${hSlope.toFixed(2)} < l-slope ${lSlope.toFixed(2)})`,
        `Breakdown below ₹${recentLow.toFixed(1)} · bearish reversal`,
      ],
      formedAt: new Date(last.time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  // Falling wedge: both slopes negative, |hSlope| > |lSlope| (convergent), breakout up
  if (hSlope < 0 && lSlope < 0 && Math.abs(hSlope) > Math.abs(lSlope) * 1.3 && last.close > recentHigh) {
    const height = recentHigh - recentLow
    const target = +(last.close + height).toFixed(2)
    const sl = +(recentLow * 0.99).toFixed(2)
    return {
      symbol, pattern: 'Falling Wedge', direction: 'BUY', timeframe: tf,
      entry: +last.close.toFixed(2), stopLoss: sl, target1: target, target2: null,
      expectedMovePct: +((height / last.close) * 100).toFixed(1),
      confidence: 'MED', patternHeight: +height.toFixed(2),
      reasoning: [
        `Falling wedge — converging trendlines`,
        `Breakout above ₹${recentHigh.toFixed(1)} · bullish reversal`,
      ],
      formedAt: new Date(last.time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  return null
}

// — Candlestick patterns (the last 1-3 bars) —
// Bullish Engulfing, Bearish Engulfing, Hammer, Shooting Star, Morning Star,
// Evening Star, Three White Soldiers, Three Black Crows.
function detectCandle(candles: Candle[], symbol: string, tf: Timeframe): PatternHit | null {
  if (candles.length < 5) return null
  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const prev2 = candles[candles.length - 3]
  const atr = atr14(candles)
  if (atr === 0) return null

  const body = (c: Candle): number => Math.abs(c.close - c.open)
  const upperWick = (c: Candle): number => c.high - Math.max(c.open, c.close)
  const lowerWick = (c: Candle): number => Math.min(c.open, c.close) - c.low
  const isBull = (c: Candle): boolean => c.close > c.open
  const isBear = (c: Candle): boolean => c.close < c.open

  // Bullish Engulfing
  if (isBear(prev) && isBull(last) && last.open < prev.close && last.close > prev.open) {
    const height = body(last) * 2
    const entry = +last.close.toFixed(2)
    return {
      symbol, pattern: 'Bullish Engulfing', direction: 'BUY', timeframe: tf,
      entry, stopLoss: +(last.low * 0.99).toFixed(2),
      target1: +(entry + height).toFixed(2), target2: +(entry + height * 1.5).toFixed(2),
      expectedMovePct: +((height / entry) * 100).toFixed(1),
      confidence: body(last) > atr * 1.5 ? 'HIGH' : 'MED',
      patternHeight: +height.toFixed(2),
      reasoning: ['Today\'s bull body engulfs yesterday\'s bear body', 'Reversal signal at potential support'],
      formedAt: new Date(last.time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  // Bearish Engulfing
  if (isBull(prev) && isBear(last) && last.open > prev.close && last.close < prev.open) {
    const height = body(last) * 2
    const entry = +last.close.toFixed(2)
    return {
      symbol, pattern: 'Bearish Engulfing', direction: 'SHORT', timeframe: tf,
      entry, stopLoss: +(last.high * 1.01).toFixed(2),
      target1: +(entry - height).toFixed(2), target2: +(entry - height * 1.5).toFixed(2),
      expectedMovePct: +((height / entry) * 100).toFixed(1),
      confidence: body(last) > atr * 1.5 ? 'HIGH' : 'MED',
      patternHeight: +height.toFixed(2),
      reasoning: ['Today\'s bear body engulfs yesterday\'s bull body', 'Reversal signal at potential resistance'],
      formedAt: new Date(last.time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  // Hammer — small body, lower wick ≥ 2× body, near top of bar, at potential support
  if (lowerWick(last) >= body(last) * 2 && upperWick(last) < body(last) * 0.5 && body(last) > 0) {
    // Require prior downtrend
    const prevTrend = prev2.close > prev.close && prev.close > last.open
    if (prevTrend) {
      const height = lowerWick(last)
      const entry = +last.close.toFixed(2)
      return {
        symbol, pattern: 'Hammer', direction: 'BUY', timeframe: tf,
        entry, stopLoss: +(last.low * 0.99).toFixed(2),
        target1: +(entry + height * 1.5).toFixed(2), target2: null,
        expectedMovePct: +((height * 1.5 / entry) * 100).toFixed(1),
        confidence: 'MED', patternHeight: +height.toFixed(2),
        reasoning: ['Long lower wick + small body after downtrend', 'Bullish reversal signal'],
        formedAt: new Date(last.time).toISOString().slice(0, 10),
        capturedAt: new Date().toISOString(),
      }
    }
  }
  // Shooting Star — mirror of hammer at top
  if (upperWick(last) >= body(last) * 2 && lowerWick(last) < body(last) * 0.5 && body(last) > 0) {
    const prevTrend = prev2.close < prev.close && prev.close < last.open
    if (prevTrend) {
      const height = upperWick(last)
      const entry = +last.close.toFixed(2)
      return {
        symbol, pattern: 'Shooting Star', direction: 'SHORT', timeframe: tf,
        entry, stopLoss: +(last.high * 1.01).toFixed(2),
        target1: +(entry - height * 1.5).toFixed(2), target2: null,
        expectedMovePct: +((height * 1.5 / entry) * 100).toFixed(1),
        confidence: 'MED', patternHeight: +height.toFixed(2),
        reasoning: ['Long upper wick + small body after uptrend', 'Bearish reversal signal'],
        formedAt: new Date(last.time).toISOString().slice(0, 10),
        capturedAt: new Date().toISOString(),
      }
    }
  }
  // Three White Soldiers — 3 consecutive bull bars, each closing higher
  if (isBull(candles[candles.length - 3]) && isBull(prev) && isBull(last) &&
      prev.close > candles[candles.length - 3].close && last.close > prev.close &&
      body(candles[candles.length - 3]) > atr * 0.5 && body(prev) > atr * 0.5 && body(last) > atr * 0.5) {
    const height = last.close - candles[candles.length - 3].open
    const entry = +last.close.toFixed(2)
    return {
      symbol, pattern: 'Three White Soldiers', direction: 'BUY', timeframe: tf,
      entry, stopLoss: +(candles[candles.length - 3].low * 0.98).toFixed(2),
      target1: +(entry + height).toFixed(2), target2: null,
      expectedMovePct: +((height / entry) * 100).toFixed(1),
      confidence: 'HIGH', patternHeight: +height.toFixed(2),
      reasoning: ['3 consecutive bullish bars · each closing higher', 'Strong momentum continuation'],
      formedAt: new Date(last.time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  // Three Black Crows — mirror
  if (isBear(candles[candles.length - 3]) && isBear(prev) && isBear(last) &&
      prev.close < candles[candles.length - 3].close && last.close < prev.close &&
      body(candles[candles.length - 3]) > atr * 0.5 && body(prev) > atr * 0.5 && body(last) > atr * 0.5) {
    const height = candles[candles.length - 3].open - last.close
    const entry = +last.close.toFixed(2)
    return {
      symbol, pattern: 'Three Black Crows', direction: 'SHORT', timeframe: tf,
      entry, stopLoss: +(candles[candles.length - 3].high * 1.02).toFixed(2),
      target1: +(entry - height).toFixed(2), target2: null,
      expectedMovePct: +((height / entry) * 100).toFixed(1),
      confidence: 'HIGH', patternHeight: +height.toFixed(2),
      reasoning: ['3 consecutive bearish bars · each closing lower', 'Strong distribution continuation'],
      formedAt: new Date(last.time).toISOString().slice(0, 10),
      capturedAt: new Date().toISOString(),
    }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────
// SCAN — iterate universe × timeframes × detectors
// ─────────────────────────────────────────────────────────────────────

export async function scanChartPatterns(opts?: { minConcurrency?: number; topN?: number }): Promise<PatternHit[]> {
  const concurrency = opts?.minConcurrency ?? 6
  const topN = opts?.topN ?? 200

  const { NIFTY_500_CORE } = await import('../screeners/universe')
  const universe: string[] = NIFTY_500_CORE
  log.info('CHART-PATTERN', `Scanning ${universe.length} symbols × 2 timeframes (DAILY, WEEKLY) × 8 detectors...`)

  const detectors = [
    detectHeadAndShoulders, detectInverseHeadAndShoulders,
    detectDoubleTop, detectDoubleBottom,
    detectTriangle, detectFlag, detectCupAndHandle, detectWedge,
    detectCandle,
  ]

  const hits: PatternHit[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      try {
        const daily = await getCandles(sym, '1D' as any, 150)
        if (daily && daily.length >= 30) {
          for (const det of detectors) {
            const hit = det(daily, sym, 'DAILY')
            if (hit) hits.push(hit)
          }
        }
        // Weekly = downsample daily into weekly buckets
        if (daily && daily.length >= 150) {
          const weekly = downsampleToWeekly(daily)
          if (weekly.length >= 30) {
            for (const det of detectors) {
              const hit = det(weekly, sym, 'WEEKLY')
              if (hit) hits.push(hit)
            }
          }
        }
      } catch { /* skip per-symbol */ }
    }
  }))

  // Sort: confidence × expected move
  const confScore: Record<string, number> = { HIGH: 3, MED: 2, LOW: 1 }
  hits.sort((a, b) => (confScore[b.confidence] * b.expectedMovePct) - (confScore[a.confidence] * a.expectedMovePct))
  const top = hits.slice(0, topN)
  log.ok('CHART-PATTERN', `Found ${hits.length} pattern hits · top ${top.length} kept`)
  return top
}

function downsampleToWeekly(daily: Candle[]): Candle[] {
  const weekly: Candle[] = []
  let bucket: Candle[] = []
  for (const c of daily) {
    const d = new Date(c.time)
    if (d.getDay() === 1 && bucket.length > 0) {       // start of new week (Monday)
      weekly.push(combineWeek(bucket))
      bucket = []
    }
    bucket.push(c)
  }
  if (bucket.length > 0) weekly.push(combineWeek(bucket))
  return weekly
}
function combineWeek(bars: Candle[]): Candle {
  return {
    time: bars[0].time,
    open: bars[0].open,
    high: Math.max(...bars.map(b => b.high)),
    low: Math.min(...bars.map(b => b.low)),
    close: bars[bars.length - 1].close,
    volume: bars.reduce((s, b) => s + b.volume, 0),
  }
}

export async function runAndPublishChartPatterns(): Promise<{ generatedAt: string; total: number; byPattern: Record<string, number>; rows: PatternHit[] }> {
  const rows = await scanChartPatterns()
  const byPattern: Record<string, number> = {}
  for (const r of rows) byPattern[r.pattern] = (byPattern[r.pattern] ?? 0) + 1
  const out = {
    generatedAt: new Date().toISOString(),
    criterion: 'Chart-pattern scan over NIFTY-500 universe × DAILY + WEEKLY timeframes',
    note: 'PILOT MODE — patterns + measured-move targets are output for review. Cross-check before sizing.',
    total: rows.length,
    byPattern,
    rows,
  }
  await fs.mkdir(SNAP_DIR, { recursive: true })
  await fs.writeFile(path.join(SNAP_DIR, 'chart-patterns.json'), JSON.stringify(out, null, 2))
  log.ok('CHART-PATTERN', `Published: ${rows.length} pattern hits · ${Object.keys(byPattern).length} distinct patterns`)
  return out
}
