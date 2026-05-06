import type { Candle } from '../types'
import { bollinger, emaStack, lastATR, lastRSI, obv } from '../indicators'
import { analyzeSMC } from '../patterns/smc'
import type { Screener, ScreenerResult } from './types'

const last = <T>(a: T[]): T | undefined => a[a.length - 1]
const avg = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1)

/**
 * Pre-move detection — setups that usually resolve into directional moves
 * within 1-3 trading days. Fire these as Telegram alerts BEFORE the move.
 *
 *   1. Bollinger squeeze  — bandwidth at multi-week low + volume rising
 *   2. Coiled price       — 5-day range < 50% of 20-day avg range
 *   3. Resistance kiss    — 3+ closes within 0.5% of a clear resistance
 *   4. Rising OBV, flat price — institutional pre-positioning
 */

export const bollingerSqueeze: Screener = {
  id: 'bb_squeeze',
  name: 'Bollinger Squeeze',
  description: 'BB bandwidth at 20-day low — breakout imminent',
  timeframeLabel: '1-3 days',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 40) return null
    // Compute BB bandwidth series
    const widths: number[] = []
    for (let i = 20; i <= candles.length; i++) {
      const slice = candles.slice(0, i)
      const bb = bollinger(slice, 20, 2)
      if (bb) widths.push((bb.upper - bb.lower) / bb.middle)
    }
    if (widths.length < 25) return null
    const nowW = widths[widths.length - 1]
    const lookbackMin = Math.min(...widths.slice(-20))
    // Squeeze: at or near 20-day low and abnormally tight (<0.08 of price)
    if (nowW > lookbackMin * 1.05 || nowW > 0.08) return null

    const latest = last(candles)!
    const recentVol = avg(candles.slice(-3).map(c => c.volume))
    const avgVol = avg(candles.slice(-20).map(c => c.volume))
    const volRising = avgVol > 0 && recentVol > avgVol * 1.1

    const stack = emaStack(candles)
    const direction = stack.alignedBull ? 'BULL' : stack.alignedBear ? 'BEAR' : 'NEUTRAL'
    const atr = lastATR(candles) ?? latest.close * 0.02

    return {
      symbol,
      price: latest.close,
      change: 0, changePct: 0,
      score: 7.5 + (volRising ? 1 : 0),
      tier: 'B',
      direction,
      reasons: [
        `BB width ${(nowW * 100).toFixed(1)}% — at 20-day low`,
        volRising ? `Volume rising ${(recentVol / avgVol).toFixed(1)}×` : 'Volume quiet',
        `EMA bias: ${direction}`,
      ],
      tags: ['BB Squeeze', volRising ? 'Vol up' : 'Vol flat', direction === 'BULL' ? 'bias↑' : direction === 'BEAR' ? 'bias↓' : '—'],
      expectedMovePct: direction === 'BULL' ? 4 : direction === 'BEAR' ? -4 : 0,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: latest.close,
      suggestedSL: direction === 'BULL' ? latest.close - atr * 1 : latest.close + atr * 1,
      suggestedTarget: direction === 'BULL' ? latest.close + atr * 3 : latest.close - atr * 3,
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

export const coiledRange: Screener = {
  id: 'coiled_range',
  name: 'Coiled Range',
  description: 'Price compressing — 5d range < 50% of prior 20d avg range',
  timeframeLabel: '1-2 days',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 30) return null
    const recent5 = candles.slice(-5)
    const prior20 = candles.slice(-25, -5)
    const r5 = Math.max(...recent5.map(c => c.high)) - Math.min(...recent5.map(c => c.low))
    const r20avg = avg(prior20.map(c => c.high - c.low))
    if (r20avg <= 0 || r5 > r20avg * 0.5) return null

    const latest = last(candles)!
    const stack = emaStack(candles)
    const direction = stack.alignedBull ? 'BULL' : stack.alignedBear ? 'BEAR' : 'NEUTRAL'
    const atr = lastATR(candles) ?? latest.close * 0.02

    return {
      symbol,
      price: latest.close,
      change: 0, changePct: 0,
      score: 7,
      tier: 'B',
      direction,
      reasons: [
        `5-day range ${r5.toFixed(2)} vs 20-day avg range ${r20avg.toFixed(2)} — coiled`,
        `Trend bias: ${direction}`,
      ],
      tags: ['Coiled', `r5/r20 ${(r5 / r20avg).toFixed(2)}`],
      expectedMovePct: direction === 'BULL' ? 3 : direction === 'BEAR' ? -3 : 0,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: latest.close,
      suggestedSL: direction === 'BULL' ? latest.close - atr : latest.close + atr,
      suggestedTarget: direction === 'BULL' ? latest.close + atr * 3 : latest.close - atr * 3,
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

export const resistanceKiss: Screener = {
  id: 'resistance_kiss',
  name: 'Resistance Kiss',
  description: '3+ consecutive closes kissing resistance — breakout next day',
  timeframeLabel: '1-2 days',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 40) return null
    const recent = candles.slice(-5)
    const prior = candles.slice(-40, -5)
    const resistance = Math.max(...prior.map(c => c.high))
    const kissing = recent.every(c => Math.abs(c.high - resistance) / resistance < 0.008)
    if (!kissing) return null
    const latest = last(candles)!
    const atr = lastATR(candles) ?? latest.close * 0.02
    return {
      symbol,
      price: latest.close,
      change: 0, changePct: 0,
      score: 7,
      tier: 'B',
      direction: 'BULL',
      reasons: [
        `Close kissing resistance at ${resistance.toFixed(2)} for ${recent.length} bars`,
        `ATR ${atr.toFixed(2)} → expected breakout size`,
      ],
      tags: ['Kissing R', `R ${resistance.toFixed(0)}`],
      expectedMovePct: 4,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: +(resistance + atr * 0.1).toFixed(2),
      suggestedSL: +(resistance - atr * 1).toFixed(2),
      suggestedTarget: +(resistance + atr * 3).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

export const preAccumulationDivergence: Screener = {
  id: 'pre_accum_div',
  name: 'OBV Divergence (flat price)',
  description: 'OBV surging while price flat — smart money pre-positioning',
  timeframeLabel: '2-5 days',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 40) return null
    const obvSeries = obv(candles).slice(-15)
    const prices = candles.slice(-15).map(c => c.close)
    if (obvSeries.length < 10) return null
    const obvChange = (obvSeries[obvSeries.length - 1] - obvSeries[0]) / Math.abs(obvSeries[0] || 1)
    const priceChange = (prices[prices.length - 1] - prices[0]) / prices[0]
    if (obvChange <= 0.1) return null
    if (Math.abs(priceChange) > 0.02) return null // price truly flat
    const latest = last(candles)!
    const atr = lastATR(candles) ?? latest.close * 0.02
    return {
      symbol,
      price: latest.close,
      change: 0, changePct: 0,
      score: 7.5,
      tier: 'B',
      direction: 'BULL',
      reasons: [
        `OBV +${(obvChange * 100).toFixed(0)}% while price moved only ${(priceChange * 100).toFixed(1)}%`,
        'Institutional accumulation — move likely within days',
      ],
      tags: ['Silent accum', `OBV +${(obvChange * 100).toFixed(0)}%`],
      expectedMovePct: 5,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: latest.close,
      suggestedSL: +(latest.close - atr).toFixed(2),
      suggestedTarget: +(latest.close + atr * 3).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

export const PREMOVE_SCREENERS: Screener[] = [
  bollingerSqueeze,
  coiledRange,
  resistanceKiss,
  preAccumulationDivergence,
]
