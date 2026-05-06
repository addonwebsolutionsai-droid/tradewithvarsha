/**
 * Fib + LRC (Linear Regression Candles) confluence detector.
 *
 * Why this exists (2026-05-02):
 * The user's TradingView chart on XAUUSD picked a long at 4564 → 4633 using a
 * Linear Regression Candles indicator (LR length 11, smoothing 11, ATR 100,
 * key value 1) AND the level was the 0.786 Fib retracement of the prior swing.
 * Pure Turtle Soup never fires on this — there's no liquidity sweep, just a
 * Fib bounce confirmed by LRC turning bullish. So we add a separate detector
 * that runs alongside Turtle Soup on the same TFs and catches this pattern.
 *
 * Algorithm:
 *   1. Build a Linear Regression Candles (LRC) series:
 *        For each bar i, fit y = m*x + c on the last `lrLen` closes ending at
 *        i, evaluate at x=lrLen-1 to get the regression close. Same for open
 *        (using prior close), high (using high series), low (using low).
 *        Then EMA-smooth each of (open, high, low, close) by `smoothing`.
 *   2. Determine LRC colour: green if smoothedClose > smoothedOpen, red else.
 *   3. Find the most recent N-bar swing high → swing low (for BUY) or swing
 *      low → swing high (for SELL).
 *   4. Compute Fib levels at 0.382 / 0.5 / 0.618 / 0.786 / 0.886.
 *   5. BUY trigger: latest 1-3 bars touched within `tolerance` of any Fib
 *      level AND the latest bar flipped LRC green AFTER being red on the
 *      tag bar.
 *   6. SELL trigger: mirror.
 *   7. Trade plan:
 *        Entry  = LRC flip bar's close + tickBuf
 *        SL     = swing low (BUY) - ATR * 0.5  /  swing high (SELL) + ATR * 0.5
 *        T1     = 0.382 Fib retracement of the SL→entry leg in the move direction
 *        T2     = swing high (BUY) / swing low (SELL)
 *        T3     = 1.272 Fib extension of the leg
 */

import type { Candle } from '../types'
import { lastATR } from '../indicators'

export type Direction = 'BUY' | 'SELL'

export interface FibLrcSignal {
  symbol: string
  timeframe: string
  detectedAt: string         // ISO of the trigger bar
  ltp: number
  direction: Direction

  // Swing context
  swingHigh: number
  swingLow: number
  swingHighTime: string
  swingLowTime: string

  // Fib level that was tagged
  fibLevel: number           // 0.382 / 0.5 / 0.618 / 0.786 / 0.886
  fibPrice: number           // price at that level
  tagPrice: number           // actual wick that touched the level
  tagDistancePct: number     // |tagPrice - fibPrice| / fibPrice * 100

  // LRC state
  lrcWasRed: boolean         // pre-trigger red bar
  lrcNowGreen: boolean       // trigger bar flipped green (BUY) — mirror for SELL
  lrcOpen: number; lrcHigh: number; lrcLow: number; lrcClose: number

  // Trade plan
  entry: number
  stopLoss: number
  target1: number; target2: number; target3: number
  riskReward: number

  // Confidence (0-100)
  confidence: number

  // Reasoning
  reasons: string[]
}

export interface DetectorOpts {
  lrLen?: number             // default 11
  smoothing?: number         // default 11
  swingLookback?: number     // default 50 bars
  pivotStrength?: number     // default 3
  fibTolerancePct?: number   // default 0.4 % from level
  maxBarsSinceTag?: number   // default 3
}

const DEFAULT_FIBS = [0.382, 0.5, 0.618, 0.786, 0.886] as const

// ── Linear Regression Candles ──────────────────────────────────

function linRegAtEnd(values: number[], len: number): number {
  // Fit y = m*x + c over the last `len` points and return y(len-1).
  if (values.length < len) return values[values.length - 1]
  const slice = values.slice(-len)
  const n = slice.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) { sx += i; sy += slice[i]; sxx += i * i; sxy += i * slice[i] }
  const denom = n * sxx - sx * sx
  if (denom === 0) return slice[n - 1]
  const m = (n * sxy - sx * sy) / denom
  const c = (sy - m * sx) / n
  return m * (n - 1) + c
}

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]
  for (const v of values) { prev = v * k + prev * (1 - k); out.push(prev) }
  return out
}

interface LrcBar { open: number; high: number; low: number; close: number; isGreen: boolean }

export function computeLRC(candles: Candle[], lrLen = 11, smoothing = 11): LrcBar[] {
  const closes = candles.map(c => c.close)
  const opens = candles.map(c => c.open)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)
  const lrClose: number[] = []
  const lrOpen: number[] = []
  const lrHigh: number[] = []
  const lrLow: number[] = []
  for (let i = 0; i < candles.length; i++) {
    lrClose.push(linRegAtEnd(closes.slice(0, i + 1), lrLen))
    lrOpen.push(linRegAtEnd(opens.slice(0, i + 1), lrLen))
    lrHigh.push(linRegAtEnd(highs.slice(0, i + 1), lrLen))
    lrLow.push(linRegAtEnd(lows.slice(0, i + 1), lrLen))
  }
  const so = emaSeries(lrOpen, smoothing)
  const sh = emaSeries(lrHigh, smoothing)
  const sl = emaSeries(lrLow, smoothing)
  const sc = emaSeries(lrClose, smoothing)
  return candles.map((_, i) => ({
    open: so[i], high: sh[i], low: sl[i], close: sc[i],
    isGreen: sc[i] > so[i],
  }))
}

// ── Swing detection ────────────────────────────────────────────

function findSwingPivots(candles: Candle[], strength: number) {
  const highs: { idx: number; price: number; time: number }[] = []
  const lows: { idx: number; price: number; time: number }[] = []
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i]
    let isH = true, isL = true
    for (let j = 1; j <= strength; j++) {
      if (c.high <= candles[i - j].high || c.high <= candles[i + j].high) isH = false
      if (c.low >= candles[i - j].low || c.low >= candles[i + j].low) isL = false
    }
    if (isH) highs.push({ idx: i, price: c.high, time: c.time })
    if (isL) lows.push({ idx: i, price: c.low, time: c.time })
  }
  return { highs, lows }
}

// ── Detector ───────────────────────────────────────────────────

export function detectFibLrc(
  symbol: string,
  timeframe: string,
  candles: Candle[],
  opts: DetectorOpts = {},
): FibLrcSignal | null {
  const lrLen = opts.lrLen ?? 11
  const smoothing = opts.smoothing ?? 11
  const swingLook = opts.swingLookback ?? 50
  const strength = opts.pivotStrength ?? 3
  const tolPct = (opts.fibTolerancePct ?? 0.4) / 100
  const maxBarsSinceTag = opts.maxBarsSinceTag ?? 3

  if (candles.length < Math.max(swingLook + 5, lrLen + smoothing + 5)) return null

  const lrc = computeLRC(candles, lrLen, smoothing)
  const last = candles[candles.length - 1]
  const lastLrc = lrc[lrc.length - 1]
  const window = candles.slice(-swingLook - strength)
  const { highs, lows } = findSwingPivots(window, strength)
  if (!highs.length || !lows.length) return null

  // Most recent swing in each direction
  const lastHigh = highs[highs.length - 1]
  const lastLow = lows[lows.length - 1]
  const atrVal = lastATR(candles, 14) ?? last.close * 0.01

  // ── BUY: pullback to a Fib of (lastLow → lastHigh) where high came AFTER low ──
  if (lastHigh.idx > lastLow.idx) {
    const swingRange = lastHigh.price - lastLow.price
    if (swingRange <= 0) return null
    const fibPrices = DEFAULT_FIBS.map(f => ({ f, p: lastHigh.price - swingRange * f }))

    // Look at the last (maxBarsSinceTag + 1) candles for a Fib touch
    const recent = candles.slice(-(maxBarsSinceTag + 1))
    const recentLrc = lrc.slice(-(maxBarsSinceTag + 1))
    let tagged: { fib: number; fibPrice: number; tagPrice: number; barOffset: number } | null = null
    for (let bi = 0; bi < recent.length - 1; bi++) {       // not the latest bar
      const c = recent[bi]
      for (const { f, p } of fibPrices) {
        if (Math.abs(c.low - p) / p <= tolPct) {
          tagged = { fib: f, fibPrice: p, tagPrice: c.low, barOffset: bi }
          break
        }
      }
      if (tagged) break
    }
    if (!tagged) return null

    // The flip: tag-bar LRC red, latest LRC green
    const tagLrc = recentLrc[tagged.barOffset]
    const flipped = !tagLrc.isGreen && lastLrc.isGreen
    if (!flipped) return null

    // Trade plan
    const tickBuf = Math.max(last.close * 0.0005, 0.05)
    const entry = +(last.close + tickBuf).toFixed(2)
    const stopLoss = +(Math.min(tagged.tagPrice, lastLow.price) - atrVal * 0.5).toFixed(2)
    const risk = entry - stopLoss
    if (risk <= 0) return null
    const target1 = +(entry + risk * 1.5).toFixed(2)
    const target2 = +lastHigh.price.toFixed(2)
    const target3 = +(lastLow.price + swingRange * 1.272).toFixed(2)
    const reward = target1 - entry
    const distPct = Math.abs(tagged.tagPrice - tagged.fibPrice) / tagged.fibPrice * 100

    const confidence = Math.min(95, Math.round(
      55
      + (tagged.fib >= 0.618 ? 15 : 5)              // deeper retracement = higher conviction
      + (distPct < 0.15 ? 10 : 0)
      + (lastLrc.close > lastLrc.open + atrVal * 0.05 ? 8 : 0),
    ))

    return {
      symbol, timeframe,
      detectedAt: new Date(last.time).toISOString(),
      ltp: +last.close.toFixed(2),
      direction: 'BUY',
      swingHigh: +lastHigh.price.toFixed(2),
      swingLow: +lastLow.price.toFixed(2),
      swingHighTime: new Date(lastHigh.time).toISOString(),
      swingLowTime: new Date(lastLow.time).toISOString(),
      fibLevel: tagged.fib,
      fibPrice: +tagged.fibPrice.toFixed(2),
      tagPrice: +tagged.tagPrice.toFixed(2),
      tagDistancePct: +distPct.toFixed(3),
      lrcWasRed: !tagLrc.isGreen,
      lrcNowGreen: lastLrc.isGreen,
      lrcOpen: +lastLrc.open.toFixed(2),
      lrcHigh: +lastLrc.high.toFixed(2),
      lrcLow: +lastLrc.low.toFixed(2),
      lrcClose: +lastLrc.close.toFixed(2),
      entry, stopLoss, target1, target2, target3,
      riskReward: +(reward / risk).toFixed(2),
      confidence,
      reasons: [
        `Swing leg ${lastLow.price.toFixed(2)} → ${lastHigh.price.toFixed(2)} (range ${swingRange.toFixed(2)})`,
        `Fib ${(tagged.fib * 100).toFixed(1)}% @ ${tagged.fibPrice.toFixed(2)} tagged at ${tagged.tagPrice.toFixed(2)} (${distPct.toFixed(2)}% off)`,
        `LRC flipped GREEN: prev red, now ${lastLrc.close.toFixed(2)} > ${lastLrc.open.toFixed(2)}`,
        `Entry ${entry} · SL ${stopLoss} · T1 ${target1} · T2 ${target2} · T3 ${target3}`,
      ],
    }
  }

  // ── SELL: rally to a Fib of (lastHigh → lastLow) where low came AFTER high ──
  if (lastLow.idx > lastHigh.idx) {
    const swingRange = lastHigh.price - lastLow.price
    if (swingRange <= 0) return null
    const fibPrices = DEFAULT_FIBS.map(f => ({ f, p: lastLow.price + swingRange * f }))
    const recent = candles.slice(-(maxBarsSinceTag + 1))
    const recentLrc = lrc.slice(-(maxBarsSinceTag + 1))
    let tagged: { fib: number; fibPrice: number; tagPrice: number; barOffset: number } | null = null
    for (let bi = 0; bi < recent.length - 1; bi++) {
      const c = recent[bi]
      for (const { f, p } of fibPrices) {
        if (Math.abs(c.high - p) / p <= tolPct) {
          tagged = { fib: f, fibPrice: p, tagPrice: c.high, barOffset: bi }
          break
        }
      }
      if (tagged) break
    }
    if (!tagged) return null

    const tagLrc = recentLrc[tagged.barOffset]
    const flipped = tagLrc.isGreen && !lastLrc.isGreen
    if (!flipped) return null

    const tickBuf = Math.max(last.close * 0.0005, 0.05)
    const entry = +(last.close - tickBuf).toFixed(2)
    const stopLoss = +(Math.max(tagged.tagPrice, lastHigh.price) + atrVal * 0.5).toFixed(2)
    const risk = stopLoss - entry
    if (risk <= 0) return null
    const target1 = +(entry - risk * 1.5).toFixed(2)
    const target2 = +lastLow.price.toFixed(2)
    const target3 = +(lastHigh.price - swingRange * 1.272).toFixed(2)
    const reward = entry - target1
    const distPct = Math.abs(tagged.tagPrice - tagged.fibPrice) / tagged.fibPrice * 100

    const confidence = Math.min(95, Math.round(
      55
      + (tagged.fib >= 0.618 ? 15 : 5)
      + (distPct < 0.15 ? 10 : 0)
      + (lastLrc.open > lastLrc.close + atrVal * 0.05 ? 8 : 0),
    ))

    return {
      symbol, timeframe,
      detectedAt: new Date(last.time).toISOString(),
      ltp: +last.close.toFixed(2),
      direction: 'SELL',
      swingHigh: +lastHigh.price.toFixed(2),
      swingLow: +lastLow.price.toFixed(2),
      swingHighTime: new Date(lastHigh.time).toISOString(),
      swingLowTime: new Date(lastLow.time).toISOString(),
      fibLevel: tagged.fib,
      fibPrice: +tagged.fibPrice.toFixed(2),
      tagPrice: +tagged.tagPrice.toFixed(2),
      tagDistancePct: +distPct.toFixed(3),
      lrcWasRed: tagLrc.isGreen,
      lrcNowGreen: lastLrc.isGreen,
      lrcOpen: +lastLrc.open.toFixed(2),
      lrcHigh: +lastLrc.high.toFixed(2),
      lrcLow: +lastLrc.low.toFixed(2),
      lrcClose: +lastLrc.close.toFixed(2),
      entry, stopLoss, target1, target2, target3,
      riskReward: +(reward / risk).toFixed(2),
      confidence,
      reasons: [
        `Swing leg ${lastHigh.price.toFixed(2)} → ${lastLow.price.toFixed(2)} (range ${swingRange.toFixed(2)})`,
        `Fib ${(tagged.fib * 100).toFixed(1)}% @ ${tagged.fibPrice.toFixed(2)} tagged at ${tagged.tagPrice.toFixed(2)} (${distPct.toFixed(2)}% off)`,
        `LRC flipped RED: prev green, now ${lastLrc.close.toFixed(2)} < ${lastLrc.open.toFixed(2)}`,
        `Entry ${entry} · SL ${stopLoss} · T1 ${target1} · T2 ${target2} · T3 ${target3}`,
      ],
    }
  }

  return null
}
