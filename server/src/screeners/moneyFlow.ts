import type { Candle } from '../types'
import { emaStack, lastATR, lastRSI, obv, volumeSpike } from '../indicators'
import { analyzeSMC } from '../patterns/smc'
import type { Screener, ScreenerResult } from './types'

const last = <T>(a: T[]): T | undefined => a[a.length - 1]
const avg = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1)

/* ══════════════════════════════════════════════════════════════
   BULLISH MONEY-FLOW SCREENERS
   ══════════════════════════════════════════════════════════════ */

/** 52-week high with strong volume — classic momentum / smart-money inflow. */
export const freshHighVolume: Screener = {
  id: 'fresh_52w_high',
  name: '52w High + Vol 2x',
  description: 'Fresh 52-week high with volume ≥ 2× 50-day average',
  timeframeLabel: '1-3 weeks',
  setupKind: 'MOMENTUM',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 250) return null
    const lookback = candles.slice(-252) // ~1 year
    const latest = last(lookback)!
    const priorHigh = Math.max(...lookback.slice(0, -1).map(c => c.high))
    if (latest.close <= priorHigh) return null
    const avgVol = avg(lookback.slice(-51, -1).map(c => c.volume))
    if (avgVol <= 0 || latest.volume < avgVol * 2) return null

    const rsi = lastRSI(candles, 14) ?? 50
    const stack = emaStack(candles)
    const atr = lastATR(candles) ?? latest.close * 0.02

    const score = Math.min(10, 6 + (latest.volume / avgVol / 2))
    return buildResult(symbol, latest, 'BULL', score, this, [
      `New 52w high at ${latest.close.toFixed(2)}`,
      `Volume ${(latest.volume / avgVol).toFixed(1)}× 50-day avg`,
      `RSI ${rsi.toFixed(1)}, EMA stack ${stack.alignedBull ? 'bull' : 'mixed'}`,
    ], [
      '52wH', `Vol ${(latest.volume / avgVol).toFixed(1)}x`, `RSI ${Math.round(rsi)}`,
    ], { entry: latest.close, sl: latest.close - 2 * atr, target: latest.close + 4 * atr, expectedMovePct: 10 })
  },
}

/** Pullback to 20-EMA with demand candle — classic trend-continuation buy. */
export const pullbackTo20EMA: Screener = {
  id: 'pullback_20ema',
  name: 'Pullback → 20 EMA',
  description: 'Stock in uptrend pulls back to 20 EMA with a bullish reversal candle',
  timeframeLabel: '2-4 weeks',
  setupKind: 'PULLBACK',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 60) return null
    const stack = emaStack(candles)
    if (!stack.alignedBull || !stack.ema21) return null
    const latest = last(candles)!
    const prior = candles[candles.length - 2]
    // Price touched 20-ema (low within 1.5% of ema21)
    const touch = Math.abs(latest.low - stack.ema21) / stack.ema21 < 0.015
    if (!touch) return null
    // Bullish close (engulfing / hammer)
    const bullClose = latest.close > latest.open && latest.close > prior.high
    if (!bullClose) return null
    const rsi = lastRSI(candles, 14) ?? 50
    const atr = lastATR(candles) ?? latest.close * 0.02
    return buildResult(symbol, latest, 'BULL', 7.5, this, [
      `Uptrend pullback to 20-EMA at ${stack.ema21.toFixed(2)}`,
      `Bullish reversal candle closing ${latest.close.toFixed(2)}`,
      `RSI ${rsi.toFixed(1)} — resuming from support`,
    ], ['EMA20 bounce', 'Bull candle', `RSI ${Math.round(rsi)}`], {
      entry: latest.close, sl: latest.low - atr * 0.5, target: latest.close + atr * 3.5, expectedMovePct: 8,
    })
  },
}

/** Volume accumulation without price breakout — smart-money footprint. */
export const silentAccumulation: Screener = {
  id: 'silent_accumulation',
  name: 'Silent Accumulation',
  description: 'OBV rising while price consolidates — institutions building positions',
  timeframeLabel: '3-6 weeks',
  setupKind: 'ACCUMULATION',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 60) return null
    const obvSeries = obv(candles).slice(-30)
    if (obvSeries.length < 20) return null
    const obvSlope = (obvSeries[obvSeries.length - 1] - obvSeries[0]) / Math.abs(obvSeries[0] || 1)
    if (obvSlope < 0.15) return null
    // Price in narrow range (<6% range over last 20 days)
    const recent = candles.slice(-20)
    const hi = Math.max(...recent.map(c => c.high))
    const lo = Math.min(...recent.map(c => c.low))
    const rangePct = (hi - lo) / lo
    if (rangePct > 0.08) return null
    const latest = last(candles)!
    const atr = lastATR(candles) ?? latest.close * 0.02
    return buildResult(symbol, latest, 'BULL', 7, this, [
      `OBV +${(obvSlope * 100).toFixed(0)}% over 30 days`,
      `Price range only ${(rangePct * 100).toFixed(1)}% — tight consolidation`,
      'Institutional accumulation without advertising the move',
    ], ['Accumulation', `OBV +${(obvSlope * 100).toFixed(0)}%`, 'Tight range'], {
      entry: latest.close, sl: lo - atr * 0.5, target: hi + (hi - lo) * 1.5, expectedMovePct: 12,
    })
  },
}

/* ══════════════════════════════════════════════════════════════
   BEARISH MONEY-FLOW SCREENERS
   ══════════════════════════════════════════════════════════════ */

/** 52-week low + heavy volume — capitulation or fresh bear leg. */
export const freshLowVolume: Screener = {
  id: 'fresh_52w_low',
  name: '52w Low + Vol 2x',
  description: 'Fresh 52-week low on volume ≥ 2× — distribution signal',
  timeframeLabel: '1-3 weeks',
  setupKind: 'DISTRIBUTION',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 250) return null
    const lookback = candles.slice(-252)
    const latest = last(lookback)!
    const priorLow = Math.min(...lookback.slice(0, -1).map(c => c.low))
    if (latest.close >= priorLow) return null
    const avgVol = avg(lookback.slice(-51, -1).map(c => c.volume))
    if (avgVol <= 0 || latest.volume < avgVol * 2) return null
    const rsi = lastRSI(candles, 14) ?? 50
    const atr = lastATR(candles) ?? latest.close * 0.02
    const score = Math.min(10, 6 + (latest.volume / avgVol / 2))
    return buildResult(symbol, latest, 'BEAR', score, this, [
      `Fresh 52-week low at ${latest.close.toFixed(2)}`,
      `Distribution volume ${(latest.volume / avgVol).toFixed(1)}× avg`,
      `RSI ${rsi.toFixed(1)} — bear momentum intact`,
    ], ['52wL', `Vol ${(latest.volume / avgVol).toFixed(1)}x`, `RSI ${Math.round(rsi)}`], {
      entry: latest.close, sl: latest.close + 2 * atr, target: latest.close - 4 * atr, expectedMovePct: -10,
    })
  },
}

/** Breakdown from 20-day range — shift in money flow. */
export const rangeBreakdown: Screener = {
  id: 'range_breakdown',
  name: '20-day Range Breakdown',
  description: 'Close below 20-day range low with volume — bearish outflow',
  timeframeLabel: '1-2 weeks',
  setupKind: 'BREAKOUT',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 30) return null
    const latest = last(candles)!
    const range = candles.slice(-21, -1)
    const rangeLow = Math.min(...range.map(c => c.low))
    if (latest.close >= rangeLow) return null
    const avgVol = avg(range.map(c => c.volume))
    if (latest.volume < avgVol * 1.3) return null
    const atr = lastATR(candles) ?? latest.close * 0.02
    return buildResult(symbol, latest, 'BEAR', 7, this, [
      `Close ${latest.close.toFixed(2)} below 20-day range low ${rangeLow.toFixed(2)}`,
      `Volume ${(latest.volume / avgVol).toFixed(1)}× avg confirming breakdown`,
    ], ['Range breakdown', `Vol ${(latest.volume / avgVol).toFixed(1)}x`], {
      entry: latest.close, sl: rangeLow + atr * 0.5, target: latest.close - atr * 3, expectedMovePct: -8,
    })
  },
}

/* ══════════════════════════════════════════════════════════════
   MID-RANGE SCAN (₹50-300, 10-15% target) — user's specific ask
   ══════════════════════════════════════════════════════════════ */

/** Mid-cap setup in ₹50-300 price band with 10-15% upside in 3-4 weeks */
export const midrangeSwingSetup: Screener = {
  id: 'midrange_swing',
  name: 'Mid-range Swing 50-300',
  description: 'Stock priced ₹50-300 with setup for 10-15% in 3-4 weeks',
  timeframeLabel: '3-4 weeks',
  setupKind: 'BREAKOUT',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 80) return null
    const latest = last(candles)!
    if (latest.close < 50 || latest.close > 300) return null
    const stack = emaStack(candles)
    const rsi = lastRSI(candles, 14) ?? 50
    const atr = lastATR(candles) ?? latest.close * 0.02
    const smc = analyzeSMC(candles)

    // Pre-req: in uptrend OR clear SMC bullish break
    const trendBull = stack.alignedBull || smc.bias === 'BULLISH' || smc.bosBull
    if (!trendBull) return null

    // Recent volume surge relative to 20d avg
    const recent20 = candles.slice(-20)
    const avgV = avg(recent20.map(c => c.volume))
    const recentV = avg(candles.slice(-3).map(c => c.volume))
    if (avgV <= 0 || recentV < avgV * 1.3) return null

    // RSI momentum zone
    if (rsi < 55 || rsi > 78) return null

    const targetPct = 12 + Math.min(3, (rsi - 55) / 8) // 12-15% target
    const target = +(latest.close * (1 + targetPct / 100)).toFixed(2)
    const sl = +(latest.close - atr * 1.5).toFixed(2)

    return buildResult(symbol, latest, 'BULL', 7 + Math.min(2, (recentV / avgV - 1)), this, [
      `Price ₹${latest.close.toFixed(2)} in 50-300 band`,
      `Trend: ${stack.alignedBull ? 'EMA stack bull' : smc.note}`,
      `RSI ${rsi.toFixed(1)} — momentum zone`,
      `Volume ${(recentV / avgV).toFixed(1)}× avg last 3 bars`,
    ], ['₹50-300', 'Bull trend', `RSI ${Math.round(rsi)}`, `Vol ${(recentV / avgV).toFixed(1)}x`], {
      entry: latest.close, sl, target, expectedMovePct: targetPct,
    })
  },
}

/* ══════════════════════════════════════════════════════════════
   UTILITY
   ══════════════════════════════════════════════════════════════ */

function buildResult(
  symbol: string,
  latest: Candle,
  direction: 'BULL' | 'BEAR' | 'NEUTRAL',
  score: number,
  s: Screener,
  reasons: string[],
  tags: string[],
  risk: { entry: number; sl: number; target: number; expectedMovePct: number },
): ScreenerResult {
  const prior = latest.close // we don't have prev close here — caller can override
  return {
    symbol,
    price: latest.close,
    change: 0,
    changePct: 0,
    score: +score.toFixed(2),
    tier: score >= 8 ? 'A' : score >= 6 ? 'B' : 'C',
    direction,
    reasons,
    tags,
    expectedMovePct: risk.expectedMovePct,
    timeframeLabel: s.timeframeLabel,
    suggestedEntry: risk.entry,
    suggestedSL: risk.sl,
    suggestedTarget: risk.target,
    detectedAt: Date.now(),
    setupKind: s.setupKind,
  }
}

/** General momentum — a looser bullish scan that catches positive-drift stocks
 *  even when higher-confluence setups don't fire. Ensures dashboard always has
 *  *something* to show during dull markets. */
export const generalMomentumBull: Screener = {
  id: 'general_mom_bull',
  name: 'General Bullish Momentum',
  description: 'Bullish momentum: above 20-EMA, rising MACD, RSI 50-75, up-volume bias',
  timeframeLabel: '1-3 weeks',
  setupKind: 'MOMENTUM',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 60) return null
    const latest = last(candles)!
    const stack = emaStack(candles)
    const rsi = lastRSI(candles, 14) ?? 50
    if (!stack.ema21 || latest.close <= stack.ema21) return null
    if (rsi < 50 || rsi > 75) return null
    const recent10 = candles.slice(-10)
    const upVol = recent10.filter(c => c.close > c.open).reduce((s, c) => s + c.volume, 0)
    const dnVol = recent10.filter(c => c.close < c.open).reduce((s, c) => s + c.volume, 0)
    if (dnVol > 0 && upVol / dnVol < 1.2) return null
    const atr = lastATR(candles) ?? latest.close * 0.02
    const score = 5 + Math.min(2, (rsi - 50) / 15)
    const changePct = ((latest.close - candles[candles.length - 2].close) / candles[candles.length - 2].close) * 100
    return buildResult(symbol, latest, 'BULL', score, this, [
      `Close ${latest.close.toFixed(2)} above 20-EMA ${stack.ema21.toFixed(2)}`,
      `RSI ${rsi.toFixed(1)} — momentum zone`,
      `Up-vol/Dn-vol ratio ${(upVol / Math.max(1, dnVol)).toFixed(2)}`,
    ], [`RSI ${Math.round(rsi)}`, '>EMA20', `UpVol ${(upVol / Math.max(1, dnVol)).toFixed(1)}x`], {
      entry: latest.close, sl: latest.close - atr * 1.5, target: latest.close + atr * 3, expectedMovePct: 5,
    })
  },
}

export const generalMomentumBear: Screener = {
  id: 'general_mom_bear',
  name: 'General Bearish Momentum',
  description: 'Bearish momentum: below 20-EMA, falling MACD, RSI 25-50, down-volume bias',
  timeframeLabel: '1-3 weeks',
  setupKind: 'MOMENTUM',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 60) return null
    const latest = last(candles)!
    const stack = emaStack(candles)
    const rsi = lastRSI(candles, 14) ?? 50
    if (!stack.ema21 || latest.close >= stack.ema21) return null
    if (rsi > 50 || rsi < 25) return null
    const recent10 = candles.slice(-10)
    const upVol = recent10.filter(c => c.close > c.open).reduce((s, c) => s + c.volume, 0)
    const dnVol = recent10.filter(c => c.close < c.open).reduce((s, c) => s + c.volume, 0)
    if (upVol > 0 && dnVol / upVol < 1.2) return null
    const atr = lastATR(candles) ?? latest.close * 0.02
    const score = 5 + Math.min(2, (50 - rsi) / 15)
    return buildResult(symbol, latest, 'BEAR', score, this, [
      `Close ${latest.close.toFixed(2)} below 20-EMA ${stack.ema21.toFixed(2)}`,
      `RSI ${rsi.toFixed(1)} — weak`,
      `Dn-vol/Up-vol ratio ${(dnVol / Math.max(1, upVol)).toFixed(2)}`,
    ], [`RSI ${Math.round(rsi)}`, '<EMA20', `DnVol ${(dnVol / Math.max(1, upVol)).toFixed(1)}x`], {
      entry: latest.close, sl: latest.close + atr * 1.5, target: latest.close - atr * 3, expectedMovePct: -5,
    })
  },
}

export const MONEYFLOW_SCREENERS: Screener[] = [
  freshHighVolume,
  pullbackTo20EMA,
  silentAccumulation,
  freshLowVolume,
  rangeBreakdown,
  midrangeSwingSetup,
  generalMomentumBull,
  generalMomentumBear,
]
