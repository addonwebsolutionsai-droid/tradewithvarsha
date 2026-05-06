import type { Candle } from '../types'

/**
 * ICT Turtle Soup — pure liquidity-sweep reversal pattern.
 *
 * Self-contained price-action module. Per the user's directive (2026-04-29)
 * this strategy does NOT mix in any other indicator (RSI / EMA / MACD / SMC /
 * OI / Gann / astro) — only swing pivots, range identification, and
 * sweep-and-reclaim mechanics.
 *
 * Algorithm (full spec in `.claude/STRATEGIES_TURTLE_SOUP.md`):
 *
 *   1. Window = last (rangeLookback + 2*pivotStrength) bars.
 *   2. Establish RANGE: high/low of window EXCLUDING the trailing
 *      (maxBarsSinceSweep+1) bars — prevents the sweep itself from
 *      becoming the range extreme we're testing against.
 *   3. Determine HTF order flow from the last 2-3 swing pivots:
 *        HH + HL → BULLISH
 *        LH + LL → BEARISH
 *        else    → RANGING
 *   4. Look for sweep + reclaim in the trailing window:
 *        BUY  setup: low < RangeLow AND close > RangeLow + a confirm bar
 *                    closes above the sweep bar's high. HTF must be
 *                    BULLISH or RANGING.
 *        SELL setup: mirror.
 *   5. Build trade plan:
 *        Entry = confirm-bar close
 *        SL    = swept wick ± 5% of range size
 *        T1    = range mid (first liquidity pool)
 *        T2    = opposite range extreme
 *        T3    = T2 ± 50% of range size (range expansion target)
 */

export type Direction = 'BUY' | 'SELL'
export type HtfFlow = 'BULLISH' | 'BEARISH' | 'RANGING'

export interface TurtleSoupSignal {
  symbol: string
  timeframe: string
  detectedAt: string         // ISO of the confirm bar
  ltp: number                // last close (live price proxy)
  direction: Direction

  // Range
  rangeHigh: number
  rangeLow: number
  rangeMidpoint: number
  rangeSize: number

  // Liquidity sweep
  sweptLevel: number         // the high or low that was raided (= rangeLow / rangeHigh)
  sweepWickPrice: number     // exact wick low (BUY) or wick high (SELL)
  sweepCloseBack: number     // sweep bar's close (back inside the range)
  sweepBarTime: string       // ISO

  // HTF context
  htfOrderFlow: HtfFlow

  // Trade plan
  entry: number
  stopLoss: number
  target1: number; target2: number; target3: number
  riskReward: number         // (T1 distance) / (entry - SL)

  // Confidence proxy (0-100)
  confidence: number

  // Reasoning
  reasons: string[]
}

export interface DetectorOpts {
  /** Bars to scan for the range. Default 50. */
  rangeLookback?: number
  /** Pivot strength: bars on each side that must be lower/higher. Default 3. */
  swingPivotStrength?: number
  /** Pattern must complete within N bars from the sweep. Default 5. */
  maxBarsSinceSweep?: number
  /** SL buffer beyond the swept wick, as % of range size. Default 0.05 (5%). */
  slBufferPctOfRange?: number
}

interface SwingPoint {
  index: number
  price: number
  time: number
}

function findSwingHighs(candles: Candle[], strength: number): SwingPoint[] {
  const out: SwingPoint[] = []
  for (let i = strength; i < candles.length - strength; i++) {
    const hi = candles[i].high
    let isPivot = true
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue
      if (candles[j].high >= hi) { isPivot = false; break }
    }
    if (isPivot) out.push({ index: i, price: hi, time: candles[i].time })
  }
  return out
}

function findSwingLows(candles: Candle[], strength: number): SwingPoint[] {
  const out: SwingPoint[] = []
  for (let i = strength; i < candles.length - strength; i++) {
    const lo = candles[i].low
    let isPivot = true
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue
      if (candles[j].low <= lo) { isPivot = false; break }
    }
    if (isPivot) out.push({ index: i, price: lo, time: candles[i].time })
  }
  return out
}

function detectOrderFlow(candles: Candle[], strength: number): HtfFlow {
  const highs = findSwingHighs(candles, strength).slice(-3)
  const lows = findSwingLows(candles, strength).slice(-3)
  if (highs.length < 2 || lows.length < 2) return 'RANGING'
  const lastH = highs[highs.length - 1].price
  const prevH = highs[highs.length - 2].price
  const lastL = lows[lows.length - 1].price
  const prevL = lows[lows.length - 2].price
  const hh = lastH > prevH
  const hl = lastL > prevL
  const lh = lastH < prevH
  const ll = lastL < prevL
  if (hh && hl) return 'BULLISH'
  if (lh && ll) return 'BEARISH'
  return 'RANGING'
}

/**
 * Run the pure Turtle Soup detector on a single (symbol, timeframe, candle-series).
 * Returns the most-recent qualifying signal or null.
 */
export function detectTurtleSoup(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  opts: DetectorOpts = {},
): TurtleSoupSignal | null {
  const lookback = opts.rangeLookback ?? 50
  const strength = opts.swingPivotStrength ?? 3
  const maxBarsSinceSweep = opts.maxBarsSinceSweep ?? 5
  const slBufferPct = opts.slBufferPctOfRange ?? 0.05

  const minBars = lookback + strength * 2 + maxBarsSinceSweep + 2
  if (candles.length < minBars) return null

  const window = candles.slice(-lookback - strength * 2)
  const last = candles[candles.length - 1]

  // Range: exclude the trailing maxBarsSinceSweep + 1 bars so the sweep
  // itself doesn't redefine the level we're testing against.
  const rangeWindow = window.slice(0, Math.max(strength * 2, window.length - maxBarsSinceSweep - 1))
  if (rangeWindow.length < strength * 2 + 2) return null
  const rangeHigh = Math.max(...rangeWindow.map(c => c.high))
  const rangeLow = Math.min(...rangeWindow.map(c => c.low))
  const rangeSize = rangeHigh - rangeLow
  if (rangeSize <= 0) return null
  const rangeMid = (rangeHigh + rangeLow) / 2

  const htfFlow = detectOrderFlow(window, strength)

  // Sweep window = the trailing bars (most recent maxBarsSinceSweep + 1 bars).
  // Need at least 2 bars: one sweep + one confirm.
  const sweepWindowSize = Math.min(maxBarsSinceSweep + 1, candles.length - 1)
  const sweepWindow = candles.slice(-sweepWindowSize)

  // ── BULLISH SETUP: sweep below rangeLow + reclaim ──
  // FAST-ENTRY (2026-05-02): the prior rule waited for a SUBSEQUENT bar to
  // close above the sweep bar's HIGH — on a 1h chart that wastes 60-100+
  // points before entry. New rule: as soon as the sweep bar itself closes
  // back above rangeLow (= reclaim), we enter at min(rangeLow + tickBuffer,
  // sweep bar close). The confirmation bar is now optional and only used
  // to LIFT confidence if it materialises.
  // 2026-05-05: relax HTF killswitch on short timeframes. On 5m/15m a sweep+
  // reclaim is a valid scalp-mean-reversion even when HTF is bearish — the
  // 4499→4650 XAUUSD move was just this. We still BLOCK counter-HTF entries
  // on 1h+ where a daily downtrend would invalidate the swing.
  const isShortTF = timeframe === '5m' || timeframe === '15m' || timeframe === '30m'
  for (let i = 0; i < sweepWindow.length; i++) {
    const sweepBar = sweepWindow[i]
    if (sweepBar.low >= rangeLow) continue
    if (sweepBar.close <= rangeLow) continue   // didn't reclaim → no signal yet
    if (htfFlow === 'BEARISH' && !isShortTF) continue   // HTF veto only on 1h+

    const after = sweepWindow.slice(i + 1)
    const confirmBarIdxLocal = after.findIndex(c => c.close > sweepBar.high)
    const hasConfirm = confirmBarIdxLocal >= 0
    const confirmBar = hasConfirm ? after[confirmBarIdxLocal] : sweepBar
    // Tick-buffer for entry — 0.05 % of range or 2× ATR-of-range minimum
    const tickBuf = Math.max(rangeSize * 0.0005, 0.05)
    const reclaimEntry = Math.min(sweepBar.close, rangeLow + rangeSize * 0.02) + tickBuf
    const entry = +reclaimEntry.toFixed(2)
    const stopLoss = +(sweepBar.low - rangeSize * slBufferPct).toFixed(2)
    const target1 = +rangeMid.toFixed(2)
    const target2 = +rangeHigh.toFixed(2)
    const target3 = +(rangeHigh + rangeSize * 0.5).toFixed(2)
    const risk = entry - stopLoss
    const reward = target1 - entry
    if (risk <= 0 || reward <= 0) continue

    const confidence = computeConfidence(rangeSize, sweepBar.low, rangeLow, htfFlow, 'BUY')

    return {
      symbol, timeframe,
      detectedAt: new Date(confirmBar.time).toISOString(),
      ltp: +last.close.toFixed(2),
      direction: 'BUY',
      rangeHigh: +rangeHigh.toFixed(2),
      rangeLow: +rangeLow.toFixed(2),
      rangeMidpoint: +rangeMid.toFixed(2),
      rangeSize: +rangeSize.toFixed(2),
      sweptLevel: +rangeLow.toFixed(2),
      sweepWickPrice: +sweepBar.low.toFixed(2),
      sweepCloseBack: +sweepBar.close.toFixed(2),
      sweepBarTime: new Date(sweepBar.time).toISOString(),
      htfOrderFlow: htfFlow,
      entry, stopLoss, target1, target2, target3,
      riskReward: +(reward / risk).toFixed(2),
      confidence: confidence + (hasConfirm ? 8 : 0),
      reasons: [
        `Range ${rangeLow.toFixed(2)} – ${rangeHigh.toFixed(2)} (${(rangeSize / rangeMid * 100).toFixed(2)}% wide)`,
        `External liquidity SWEPT below ${rangeLow.toFixed(2)} → wick ${sweepBar.low.toFixed(2)}`,
        `Sweep bar reclaimed: closed ${sweepBar.close.toFixed(2)} (back inside range)`,
        hasConfirm
          ? `Confirmation: subsequent close > sweep high (${sweepBar.high.toFixed(2)}) → reversal validated`
          : `Fast-entry mode: trigger fires on reclaim bar itself — confirm pending`,
        `HTF order flow: ${htfFlow}${htfFlow === 'BULLISH' ? ' (aligned)' : htfFlow === 'RANGING' ? ' (range play)' : ''}`,
      ],
    }
  }

  // ── BEARISH SETUP: sweep above rangeHigh + reclaim ──
  for (let i = 0; i < sweepWindow.length; i++) {
    const sweepBar = sweepWindow[i]
    if (sweepBar.high <= rangeHigh) continue
    if (sweepBar.close >= rangeHigh) continue
    if (htfFlow === 'BULLISH' && !isShortTF) continue   // HTF veto only on 1h+ (parity with bull side)

    const after = sweepWindow.slice(i + 1)
    const confirmBarIdxLocal = after.findIndex(c => c.close < sweepBar.low)
    const hasConfirm = confirmBarIdxLocal >= 0
    const confirmBar = hasConfirm ? after[confirmBarIdxLocal] : sweepBar
    const tickBuf = Math.max(rangeSize * 0.0005, 0.05)
    const reclaimEntry = Math.max(sweepBar.close, rangeHigh - rangeSize * 0.02) - tickBuf
    const entry = +reclaimEntry.toFixed(2)
    const stopLoss = +(sweepBar.high + rangeSize * slBufferPct).toFixed(2)
    const target1 = +rangeMid.toFixed(2)
    const target2 = +rangeLow.toFixed(2)
    const target3 = +(rangeLow - rangeSize * 0.5).toFixed(2)
    const risk = stopLoss - entry
    const reward = entry - target1
    if (risk <= 0 || reward <= 0) continue

    const confidence = computeConfidence(rangeSize, sweepBar.high, rangeHigh, htfFlow, 'SELL')

    return {
      symbol, timeframe,
      detectedAt: new Date(confirmBar.time).toISOString(),
      ltp: +last.close.toFixed(2),
      direction: 'SELL',
      rangeHigh: +rangeHigh.toFixed(2),
      rangeLow: +rangeLow.toFixed(2),
      rangeMidpoint: +rangeMid.toFixed(2),
      rangeSize: +rangeSize.toFixed(2),
      sweptLevel: +rangeHigh.toFixed(2),
      sweepWickPrice: +sweepBar.high.toFixed(2),
      sweepCloseBack: +sweepBar.close.toFixed(2),
      sweepBarTime: new Date(sweepBar.time).toISOString(),
      htfOrderFlow: htfFlow,
      entry, stopLoss, target1, target2, target3,
      riskReward: +(reward / risk).toFixed(2),
      confidence: confidence + (hasConfirm ? 8 : 0),
      reasons: [
        `Range ${rangeLow.toFixed(2)} – ${rangeHigh.toFixed(2)} (${(rangeSize / rangeMid * 100).toFixed(2)}% wide)`,
        `External liquidity SWEPT above ${rangeHigh.toFixed(2)} → wick ${sweepBar.high.toFixed(2)}`,
        `Sweep bar reclaimed: closed ${sweepBar.close.toFixed(2)} (back inside range)`,
        hasConfirm
          ? `Confirmation: subsequent close < sweep low (${sweepBar.low.toFixed(2)}) → reversal validated`
          : `Fast-entry mode: trigger fires on reclaim bar itself — confirm pending`,
        `HTF order flow: ${htfFlow}${htfFlow === 'BEARISH' ? ' (aligned)' : htfFlow === 'RANGING' ? ' (range play)' : ''}`,
      ],
    }
  }

  return null
}

/**
 * Confidence score 0-100. Inputs are intentionally minimal — only the sweep
 * geometry and HTF alignment, no other indicators. Higher when:
 *   - sweep wick depth > 30% of range (clean stop-hunt vs micro-poke)
 *   - HTF flow is aligned with the trade direction (vs RANGING)
 */
function computeConfidence(
  rangeSize: number, sweepPrice: number, sweptLevel: number,
  htfFlow: HtfFlow, direction: Direction,
): number {
  const depth = Math.abs(sweepPrice - sweptLevel)
  const depthRatio = rangeSize > 0 ? depth / rangeSize : 0
  let score = 50
  if (depthRatio >= 0.05) score += 10
  if (depthRatio >= 0.10) score += 10
  if (depthRatio >= 0.20) score += 5
  if ((direction === 'BUY' && htfFlow === 'BULLISH') ||
      (direction === 'SELL' && htfFlow === 'BEARISH')) score += 20
  else if (htfFlow === 'RANGING') score += 10
  return Math.min(100, Math.round(score))
}
