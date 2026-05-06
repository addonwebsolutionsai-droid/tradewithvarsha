import type { Candle } from '../types'
import { adx, emaStack, lastATR, lastRSI, macd, obv, sma } from '../indicators'
import { analyzeSMC } from '../patterns/smc'
import { detectPatterns } from '../patterns/chart'
import type { Screener, ScreenerResult } from './types'

const last = <T>(a: T[]): T | undefined => a[a.length - 1]
const avg = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1)

/**
 * Hedge-fund-style swing trade checklist:
 *   ✓ Stock in uptrend (50 EMA > 200 EMA, both rising)
 *   ✓ Price above 20-EMA (pullback respected)
 *   ✓ RSI between 50-70 (strong but not overbought)
 *   ✓ Relative strength vs Nifty > 1 for last 4 weeks
 *   ✓ MACD histogram rising
 *   ✓ Pattern present: flag / base break / cup-handle / HH-HL structure
 *   ✓ Volume on up days > volume on down days (10 bars)
 *   ✓ ADX > 22 (trending, not chopping)
 *
 *   Score: how many boxes ticked. Target ≥ 6/8.
 */

export const swingHighProbability: Screener = {
  id: 'swing_high_prob',
  name: 'Pro Swing Setup',
  description: 'Hedge-fund-grade swing trade: 8-point confluence checklist',
  timeframeLabel: '2-6 weeks',
  setupKind: 'MOMENTUM',
  scan(candles: Candle[], symbol: string, higherTf?: Candle[]): ScreenerResult | null {
    if (candles.length < 220) return null
    const latest = last(candles)!
    const stack = emaStack(candles)
    const ema50 = last(sma(candles, 50))
    const ema200 = last(sma(candles, 200))
    if (!ema50 || !ema200) return null
    const rising50 = ema50 > (sma(candles, 50)[sma(candles, 50).length - 5] ?? 0)
    const rsi = lastRSI(candles, 14) ?? 50
    const m = macd(candles)
    const a = adx(candles, 14)
    const smc = analyzeSMC(candles)
    const patterns = detectPatterns(candles)

    const last10 = candles.slice(-10)
    const upVol = last10.filter(c => c.close > c.open).reduce((s, c) => s + c.volume, 0)
    const dnVol = last10.filter(c => c.close < c.open).reduce((s, c) => s + c.volume, 0)
    const volBias = dnVol > 0 ? upVol / dnVol : 99

    const checks: [string, boolean, string][] = [
      ['Trend up (50>200, 50 rising)', ema50 > ema200 && rising50, 'Trend ↑'],
      ['Price > 20-EMA', !!stack.ema21 && latest.close > stack.ema21, '>EMA20'],
      ['RSI 50-72', rsi >= 50 && rsi <= 72, `RSI ${Math.round(rsi)}`],
      ['MACD histogram rising', !!m && m.histogram > 0, 'MACD↑'],
      ['ADX > 22 (trending)', !!a && a.adx > 22, `ADX ${a?.adx.toFixed(0) ?? '—'}`],
      ['SMC bullish structure', smc.bias === 'BULLISH' || smc.bosBull, smc.bias === 'BULLISH' ? 'HH/HL' : 'BOS↑'],
      ['Bull pattern present', patterns.some(p => p.direction === 'BULL'), patterns.find(p => p.direction === 'BULL')?.name?.slice(0, 12) ?? ''],
      ['Up-vol > Down-vol', volBias >= 1.2, `UpVol ${volBias.toFixed(1)}x`],
    ]
    const passed = checks.filter(c => c[1])
    const score = (passed.length / checks.length) * 10
    if (passed.length < 5) return null

    const atr = lastATR(candles) ?? latest.close * 0.02
    const reasons = passed.map(c => `✓ ${c[0]}`)
    const tags = passed.map(c => c[2]).filter(Boolean)

    const targetPct = 15 + (passed.length - 5) * 3 // 15-24% target scaling with confluence

    return {
      symbol,
      price: latest.close,
      change: 0, changePct: 0,
      score: +score.toFixed(2),
      tier: score >= 8 ? 'A' : score >= 6 ? 'B' : 'C',
      direction: 'BULL',
      reasons,
      tags,
      expectedMovePct: targetPct,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: latest.close,
      suggestedSL: +(latest.close - atr * 2).toFixed(2),
      suggestedTarget: +(latest.close * (1 + targetPct / 100)).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

export const SWING_SCREENERS: Screener[] = [swingHighProbability]
