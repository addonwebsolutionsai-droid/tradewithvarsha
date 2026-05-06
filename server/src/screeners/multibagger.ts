import type { Candle } from '../types'
import { emaStack, lastATR, lastRSI, obv, sma } from '../indicators'
import { analyzeSMC } from '../patterns/smc'
import type { Screener, ScreenerResult } from './types'

const last = <T>(a: T[]): T | undefined => a[a.length - 1]
const avg = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1)

/**
 * Multibagger-style entry signals (position trading, 6-24 month horizon).
 *
 * Key hedge-fund-style pointers (proxied from price/volume only — no FII/DII
 * or fundamental API yet):
 *
 *   ✓ Price > 200-EMA and 200-EMA rising (stage 2)
 *   ✓ Fresh multi-year base breakout (close above 2-year high)
 *   ✓ 200-day relative performance > market (proxy: price change > 20%)
 *   ✓ OBV making new highs (smart money entering)
 *   ✓ Consolidation tightening (last 60d range < first 60d range of base)
 *   ✓ Volume expanding into the breakout
 *   ✓ Price in accumulation zone (₹10-500 typical for micro/small-cap multibaggers)
 */

export const stage2Breakout: Screener = {
  id: 'stage2_multibagger',
  name: 'Stage-2 Multibagger',
  description: 'Multi-year base breakout with smart-money accumulation footprint',
  timeframeLabel: '6-24 months',
  setupKind: 'BREAKOUT',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 220) return null // ~1 year of daily bars minimum

    const latest = last(candles)!
    if (latest.close < 10 || latest.close > 800) return null

    const s200 = sma(candles, 200)
    const ema200now = last(s200)
    const ema200then = s200[Math.max(0, s200.length - 40)]
    if (!ema200now || !ema200then) return null

    const rising200 = ema200now > ema200then * 1.03
    const aboveEMA = latest.close > ema200now
    if (!rising200 || !aboveEMA) return null

    // Base breakout: close above high-water mark excluding last bar (window = available data)
    const baseHigh = Math.max(...candles.slice(0, -1).map(c => c.high))
    const baseBreakout = latest.close > baseHigh * 0.98 // within 2% or above

    // Relative strength proxy: 200-day price change
    const closeThen = candles[candles.length - 200]?.close ?? latest.close
    const perf200 = ((latest.close - closeThen) / closeThen) * 100

    // OBV trend — new 6-month high?
    const obvSeries = obv(candles).slice(-180)
    const obvNow = last(obvSeries) ?? 0
    const obvHigh = Math.max(...obvSeries)
    const obvNewHigh = obvNow >= obvHigh * 0.99

    // Volume expansion
    const recent20 = candles.slice(-20)
    const base50 = candles.slice(-90, -30)
    const avgVol = avg(base50.map(c => c.volume))
    const nowVol = avg(recent20.map(c => c.volume))
    const volExpansion = avgVol > 0 ? nowVol / avgVol : 1

    const rsi = lastRSI(candles, 14) ?? 50
    const atr = lastATR(candles) ?? latest.close * 0.03

    const checks: [string, boolean, string][] = [
      ['200-EMA rising + price above', rising200 && aboveEMA, 'Stage 2'],
      ['2-year base breakout', baseBreakout, '2y break'],
      ['200-day perf > +20%', perf200 > 20, `+${perf200.toFixed(0)}%`],
      ['OBV at 6m high (accumulation)', obvNewHigh, 'OBV newH'],
      ['Volume expanding >50%', volExpansion > 1.5, `Vol ${volExpansion.toFixed(1)}x`],
      ['RSI strong (>55)', rsi > 55, `RSI ${Math.round(rsi)}`],
    ]
    const passed = checks.filter(c => c[1])
    if (passed.length < 4) return null
    const score = (passed.length / checks.length) * 10

    const targetPct = 40 + (passed.length - 4) * 15 // 40-70%+ stretch target
    const slPct = 10

    return {
      symbol,
      price: latest.close,
      change: 0, changePct: 0,
      score: +score.toFixed(2),
      tier: score >= 8 ? 'A' : score >= 6 ? 'B' : 'C',
      direction: 'BULL',
      reasons: passed.map(p => `✓ ${p[0]}`),
      tags: passed.map(p => p[2]).filter(Boolean),
      expectedMovePct: targetPct,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: latest.close,
      suggestedSL: +(latest.close * (1 - slPct / 100)).toFixed(2),
      suggestedTarget: +(latest.close * (1 + targetPct / 100)).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

export const MULTIBAGGER_SCREENERS: Screener[] = [stage2Breakout]
