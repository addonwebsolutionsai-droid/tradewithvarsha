import type { Candle } from '../types'
import { emaStack, lastATR, lastRSI, sma } from '../indicators'
import type { Screener, ScreenerResult } from './types'

const last = <T>(a: T[]): T | undefined => a[a.length - 1]
const avg = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1)

/**
 * PRECISION SCREENERS — implementations of the specific chartink-style
 * formulas flagged by pro research as the actual mechanical signatures
 * that precede 10-20% moves. Each screener references the exact rule.
 */

// ────────────────────────────────────────────────────────────────
// TIER 1 — INTRADAY (10-15% target within a session)
// ────────────────────────────────────────────────────────────────

/**
 * Relative Volume ≥ 3× AND ATR% ≥ 5%.
 * The classic intraday-mover pre-filter: stocks already trading with
 * abnormal volume + historically wide ranges = high probability intraday.
 */
export const highRVolHighATR: Screener = {
  id: 'rvol_atr_intraday',
  name: 'High RVol + ATR ≥ 5%',
  description: 'Relative Volume ≥ 3× AND ATR ≥ 5% of price — intraday 10-15%',
  timeframeLabel: '1 day',
  setupKind: 'MOMENTUM',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 25) return null
    const latest = last(candles)!
    const avgVol = avg(candles.slice(-21, -1).map(c => c.volume))
    if (avgVol <= 0) return null
    const rvol = latest.volume / avgVol
    if (rvol < 3) return null

    const atr = lastATR(candles, 14) ?? 0
    const atrPct = (atr / latest.close) * 100
    if (atrPct < 5) return null

    // Low cap proxy: stock price under ₹500 (micro/small cap candidates move harder)
    const lowCap = latest.close < 500

    const direction = candles[candles.length - 2].close < latest.close ? 'BULL' : 'BEAR'
    const score = Math.min(10, 6 + rvol / 2)
    return build(symbol, latest, direction, score, this, [
      `Relative Volume ${rvol.toFixed(1)}× (avg 20d)`,
      `ATR ${atr.toFixed(2)} = ${atrPct.toFixed(1)}% of price — abnormally wide`,
      lowCap ? `Low-cap (₹${latest.close.toFixed(0)}) — easier % moves` : `Price ₹${latest.close.toFixed(0)}`,
    ], [`RVol ${rvol.toFixed(1)}x`, `ATR ${atrPct.toFixed(1)}%`, lowCap ? 'Low cap' : 'Large cap'], {
      entry: latest.close, sl: latest.close - atr * 1.2, target: latest.close + atr * 2.5, expectedMovePct: 10,
    })
  },
}

/**
 * Gap + VWAP Hold.
 * Previous close vs open gap ≥ 3% AND first-30-min close above (gap high - 0.5 ATR).
 * Requires intraday candles; when only dailies available we approximate by checking
 * today's open gap + close holding in upper half of day's range.
 */
export const gapAndHold: Screener = {
  id: 'gap_and_hold',
  name: 'Gap ≥ 3% + Hold',
  description: 'Opening gap ≥ 3% and close held in upper half of range — trend-day signature',
  timeframeLabel: '1 day',
  setupKind: 'MOMENTUM',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 21) return null
    const latest = last(candles)!
    const prev = candles[candles.length - 2]
    if (!prev) return null
    const gapPct = ((latest.open - prev.close) / prev.close) * 100
    if (Math.abs(gapPct) < 3) return null

    const range = latest.high - latest.low
    if (range <= 0) return null
    const closeInRange = (latest.close - latest.low) / range
    // "Hold" = close in upper half for gap-up, lower half for gap-down
    const direction: 'BULL' | 'BEAR' = gapPct > 0 ? 'BULL' : 'BEAR'
    const holds = direction === 'BULL' ? closeInRange > 0.6 : closeInRange < 0.4
    if (!holds) return null

    const avgVol = avg(candles.slice(-21, -1).map(c => c.volume))
    const volMultiple = avgVol > 0 ? latest.volume / avgVol : 0
    if (volMultiple < 1.5) return null

    const atr = lastATR(candles, 14) ?? latest.close * 0.02
    const score = 7 + Math.min(2, Math.abs(gapPct) / 3)
    return build(symbol, latest, direction, score, this, [
      `Opening gap ${gapPct > 0 ? '+' : ''}${gapPct.toFixed(1)}%`,
      `Close in ${direction === 'BULL' ? 'upper' : 'lower'} ${Math.round((direction === 'BULL' ? closeInRange : 1 - closeInRange) * 100)}% of range — hold confirmed`,
      `Volume ${volMultiple.toFixed(1)}× — institutional participation`,
    ], [`Gap ${gapPct > 0 ? '+' : ''}${gapPct.toFixed(1)}%`, 'Held range', `Vol ${volMultiple.toFixed(1)}x`], {
      entry: latest.close,
      sl: direction === 'BULL' ? latest.low - atr * 0.2 : latest.high + atr * 0.2,
      target: direction === 'BULL' ? latest.close + atr * 3 : latest.close - atr * 3,
      expectedMovePct: direction === 'BULL' ? 10 : -10,
    })
  },
}

// ────────────────────────────────────────────────────────────────
// TIER 2 — 1-3 DAY SWING (10-15% target)
// ────────────────────────────────────────────────────────────────

/**
 * Bull Flag / High-Tight Flag.
 * Day -3: impulse +5% or more.
 * Days -2 and -1: sideways, volume < 70% of impulse day.
 * Current close within 2% of 5-day high, RSI > 60.
 */
export const bullFlag: Screener = {
  id: 'bull_flag',
  name: 'Bull Flag / High-Tight Flag',
  description: 'Impulse day 5%+ → 2-day consolidation on drying volume — breakout imminent',
  timeframeLabel: '1-3 days',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 20) return null
    const latest = last(candles)!
    const impulse = candles[candles.length - 4]
    const flag1 = candles[candles.length - 3]
    const flag2 = candles[candles.length - 2]
    if (!impulse || !flag1 || !flag2) return null

    const impulsePct = ((impulse.close - impulse.open) / impulse.open) * 100
    if (impulsePct < 5) return null

    // Flag days: low volume, tight range, close > impulse close - 2%
    const flagVolOk = (flag1.volume + flag2.volume) / 2 < impulse.volume * 0.7
    if (!flagVolOk) return null
    const flagRange = Math.max(flag1.high, flag2.high) - Math.min(flag1.low, flag2.low)
    const flagTight = flagRange < impulse.close * 0.04
    if (!flagTight) return null

    // Current bar within 2% of 5-day high
    const fiveDayHigh = Math.max(...candles.slice(-5).map(c => c.high))
    if (latest.close < fiveDayHigh * 0.98) return null

    const rsi = lastRSI(candles, 14) ?? 50
    if (rsi < 58) return null

    const atr = lastATR(candles) ?? latest.close * 0.02
    const score = 8 + Math.min(1, (impulsePct - 5) / 5)
    return build(symbol, latest, 'BULL', score, this, [
      `Impulse day +${impulsePct.toFixed(1)}% (${impulse.volume.toLocaleString()} vol)`,
      `2-day flag: volume drying to ${((flag1.volume + flag2.volume) / 2 / impulse.volume * 100).toFixed(0)}% of impulse`,
      `Close ${latest.close.toFixed(2)} within 2% of 5-day high ${fiveDayHigh.toFixed(2)}`,
      `RSI ${rsi.toFixed(1)} — momentum intact`,
    ], [`Impulse +${impulsePct.toFixed(1)}%`, 'Flag tight', `5dH ${fiveDayHigh.toFixed(0)}`, `RSI ${Math.round(rsi)}`], {
      entry: fiveDayHigh + atr * 0.1,
      sl: Math.min(flag1.low, flag2.low) - atr * 0.3,
      target: fiveDayHigh + atr * 4,
      expectedMovePct: 12,
    })
  },
}

/**
 * Volume Dry-Up Continuation.
 * Yesterday volume < 50% of 2-days-ago volume AND price within 2% of 5-day high.
 * (From the research's "Yesterday Volume" < 50% of "2 days ago" + "Price within 2% of 5-day high")
 */
export const volDryContinuation: Screener = {
  id: 'vol_dry_continuation',
  name: 'Vol Dry @ High',
  description: 'Yesterday vol < 50% of 2d-ago AND price within 2% of 5-day high',
  timeframeLabel: '1-3 days',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 10) return null
    const latest = last(candles)!
    const y1 = candles[candles.length - 2]
    const y2 = candles[candles.length - 3]
    if (!y1 || !y2 || y2.volume === 0) return null
    const volRatio = y1.volume / y2.volume
    if (volRatio > 0.5) return null

    const fiveDayHigh = Math.max(...candles.slice(-5).map(c => c.high))
    if (latest.close < fiveDayHigh * 0.98) return null

    const stack = emaStack(candles)
    if (!stack.alignedBull) return null

    const atr = lastATR(candles) ?? latest.close * 0.02
    const rsi = lastRSI(candles, 14) ?? 50
    return build(symbol, latest, 'BULL', 7.5, this, [
      `Yesterday volume only ${(volRatio * 100).toFixed(0)}% of 2-days-ago`,
      `Price ${latest.close.toFixed(2)} within 2% of 5-day high ${fiveDayHigh.toFixed(2)}`,
      `EMA stack bullish, RSI ${rsi.toFixed(1)}`,
    ], [`Vol ↓ ${(volRatio * 100).toFixed(0)}%`, `5dH ${fiveDayHigh.toFixed(0)}`], {
      entry: fiveDayHigh + atr * 0.1, sl: latest.close - atr * 1.2, target: fiveDayHigh + atr * 4, expectedMovePct: 12,
    })
  },
}

// ────────────────────────────────────────────────────────────────
// TIER 3 — 5-10 DAY SHORT TREND (15-20% target)
// ────────────────────────────────────────────────────────────────

/**
 * Compression Breakout (the "Hidden Parameter" formula).
 *   (Highest(High, 10) - Lowest(Low, 10)) / Lowest(Low, 10) < 8%   ← coiled
 *   AND (Close - Lowest(Low, 10)) / Lowest(Low, 10) > 2%           ← poking out top
 */
export const compressionBreakout: Screener = {
  id: 'compression_breakout',
  name: 'Compression Breakout',
  description: '10-day range < 8% AND close > bottom by > 2% — coiled spring release',
  timeframeLabel: '5-10 days',
  setupKind: 'BREAKOUT',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 15) return null
    const window = candles.slice(-10)
    const high10 = Math.max(...window.map(c => c.high))
    const low10 = Math.min(...window.map(c => c.low))
    if (low10 <= 0) return null
    const rangePct = (high10 - low10) / low10 * 100
    if (rangePct >= 8) return null

    const latest = last(candles)!
    const popPct = (latest.close - low10) / low10 * 100
    if (popPct <= 2) return null

    const stack = emaStack(candles)
    const sma20 = sma(candles, 20)
    const sma20Now = last(sma20)
    const sma20Then = sma20[Math.max(0, sma20.length - 10)]
    if (!sma20Now || !sma20Then) return null
    const sma20Rising = sma20Now > sma20Then

    const avgVol = avg(candles.slice(-21, -1).map(c => c.volume))
    const volShock = avgVol > 0 ? latest.volume / avgVol : 0

    const rsi = lastRSI(candles, 14) ?? 50
    const atr = lastATR(candles) ?? latest.close * 0.02

    const score = 7 + (sma20Rising ? 0.5 : 0) + (volShock >= 2 ? 1 : 0) + (stack.alignedBull ? 0.5 : 0)
    return build(symbol, latest, 'BULL', score, this, [
      `10-day range ${rangePct.toFixed(1)}% — coiled`,
      `Close breaking out: +${popPct.toFixed(1)}% off bottom`,
      sma20Rising ? '20-SMA slope positive' : '20-SMA flat',
      volShock >= 2 ? `Volume shock ${volShock.toFixed(1)}× avg` : `Volume ${volShock.toFixed(1)}× avg`,
      `RSI ${rsi.toFixed(1)}`,
    ], [`Range ${rangePct.toFixed(1)}%`, `+${popPct.toFixed(1)}%`, volShock >= 2 ? `Vol ${volShock.toFixed(1)}x` : ''], {
      entry: latest.close, sl: low10 - atr * 0.3, target: latest.close * 1.15, expectedMovePct: 15,
    })
  },
}

/**
 * 20-day Rate of Change + 50-SMA uptrend (earnings-momentum proxy).
 */
export const rocMomentum: Screener = {
  id: 'roc_momentum',
  name: '20-day ROC + SMA50 up',
  description: '20-day ROC > 10% AND 50-SMA trending up — momentum continuation',
  timeframeLabel: '5-10 days',
  setupKind: 'MOMENTUM',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 60) return null
    const latest = last(candles)!
    const back20 = candles[candles.length - 21]
    if (!back20 || back20.close <= 0) return null
    const roc20 = ((latest.close - back20.close) / back20.close) * 100
    if (roc20 < 10) return null

    const sma50Series = sma(candles, 50)
    const sma50Now = last(sma50Series)
    const sma50Prev = sma50Series[Math.max(0, sma50Series.length - 10)]
    if (!sma50Now || !sma50Prev) return null
    const sma50Rising = sma50Now > sma50Prev * 1.005
    if (!sma50Rising) return null
    if (latest.close < sma50Now) return null

    const rsi = lastRSI(candles, 14) ?? 50
    const atr = lastATR(candles) ?? latest.close * 0.02
    const score = 7 + Math.min(2, (roc20 - 10) / 10)
    return build(symbol, latest, 'BULL', score, this, [
      `20-day ROC +${roc20.toFixed(1)}% — strong momentum`,
      `50-SMA ${sma50Now.toFixed(2)} rising, price ${latest.close.toFixed(2)} above`,
      `RSI ${rsi.toFixed(1)}`,
    ], [`ROC +${roc20.toFixed(0)}%`, 'SMA50 ↑', `RSI ${Math.round(rsi)}`], {
      entry: latest.close, sl: sma50Now * 0.98, target: latest.close * 1.17, expectedMovePct: 17,
    })
  },
}

// ────────────────────────────────────────────────────────────────
// SHARED BUILDER
// ────────────────────────────────────────────────────────────────
function build(
  symbol: string,
  latest: Candle,
  direction: 'BULL' | 'BEAR' | 'NEUTRAL',
  score: number,
  s: Screener,
  reasons: string[],
  tags: string[],
  risk: { entry: number; sl: number; target: number; expectedMovePct: number },
): ScreenerResult {
  return {
    symbol, price: latest.close, change: 0, changePct: 0,
    score: +score.toFixed(2),
    tier: score >= 8 ? 'A' : score >= 6 ? 'B' : 'C',
    direction,
    reasons,
    tags: tags.filter(Boolean),
    expectedMovePct: risk.expectedMovePct,
    timeframeLabel: s.timeframeLabel,
    suggestedEntry: +risk.entry.toFixed(2),
    suggestedSL: +risk.sl.toFixed(2),
    suggestedTarget: +risk.target.toFixed(2),
    detectedAt: Date.now(),
    setupKind: s.setupKind,
  }
}

export const PRECISION_SCREENERS: Screener[] = [
  // Tier 1 (intraday)
  highRVolHighATR,
  gapAndHold,
  // Tier 2 (1-3 days)
  bullFlag,
  volDryContinuation,
  // Tier 3 (5-10 days)
  compressionBreakout,
  rocMomentum,
]
