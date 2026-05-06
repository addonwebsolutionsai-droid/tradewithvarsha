import type { Candle } from '../types'
import { lastATR, lastRSI, emaStack } from '../indicators'
import type { Screener, ScreenerResult } from './types'

/**
 * Weekly movers — finds stocks that have moved ≥ 5 % over the last 5 trading
 * sessions. Designed for the long tail (small/microcaps that were invisible
 * to the curated NIFTY500_CORE list). Run over NSE_ALL.
 *
 * Bullish (BULL): up ≥ 5 % week-on-week — surfaces names like Jinkushal,
 * Speciality Medicines, Sharp India that gained 10-20 % in a week.
 * Bearish (BEAR): down ≥ 5 % week-on-week — short candidates / blow-ups.
 *
 * Tier:  A (≥15 % move) · B (8-15 %) · C (5-8 %)
 */
export const weeklyMovers: Screener = {
  id: 'weekly_movers',
  name: 'Weekly Movers',
  description: 'Stocks that moved ≥ 5% over the last 5 sessions, ranked by magnitude',
  timeframeLabel: 'last 5 sessions',
  setupKind: 'MOMENTUM',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 30) return null
    const last = candles[candles.length - 1]
    const ref = candles[candles.length - 6] ?? candles[0]
    const week = ((last.close - ref.close) / ref.close) * 100
    if (Math.abs(week) < 5) return null

    // Liquidity gate — skip ultra-illiquid names (median 20-day vol < 5k)
    const vols = candles.slice(-20).map(c => c.volume).filter(v => v > 0).sort((a, b) => a - b)
    const medianVol = vols.length ? vols[Math.floor(vols.length / 2)] : 0
    if (medianVol < 5_000) return null

    const direction: 'BULL' | 'BEAR' = week > 0 ? 'BULL' : 'BEAR'
    const mag = Math.abs(week)
    const tier: 'A' | 'B' | 'C' = mag >= 15 ? 'A' : mag >= 8 ? 'B' : 'C'

    const rsi = lastRSI(candles, 14) ?? 50
    const atr = lastATR(candles, 14) ?? last.close * 0.02
    const stack = emaStack(candles)
    const aboveEma50 = stack.ema50 != null && last.close >= stack.ema50

    // Day change (today vs yesterday close)
    const prev = candles[candles.length - 2] ?? last
    const dayChange = last.close - prev.close
    const dayChangePct = (dayChange / prev.close) * 100

    // Volume burst — today vs 20-day median
    const volBurst = medianVol > 0 ? last.volume / medianVol : 1

    const reasons: string[] = [
      `${direction === 'BULL' ? '+' : ''}${week.toFixed(1)}% over last 5 sessions`,
      `Day change ${dayChangePct >= 0 ? '+' : ''}${dayChangePct.toFixed(2)}%`,
      `RSI ${rsi.toFixed(0)} · ${aboveEma50 ? 'above' : 'below'} EMA50`,
      volBurst > 1.5 ? `Volume burst ${volBurst.toFixed(1)}× median` : `Volume normal`,
    ]

    const tags: string[] = [
      `${week >= 0 ? '+' : ''}${week.toFixed(0)}% (5d)`,
      `RSI ${rsi.toFixed(0)}`,
    ]
    if (volBurst >= 2) tags.push(`Vol ${volBurst.toFixed(1)}×`)
    if (mag >= 15) tags.push('Big move')

    // Suggested entry/SL/T — entry on next pullback to last close, SL = 1.5×ATR
    const suggestedEntry = +last.close.toFixed(2)
    const slDist = 1.5 * atr
    const tDist = 2.5 * atr
    const suggestedSL = direction === 'BULL'
      ? +(suggestedEntry - slDist).toFixed(2)
      : +(suggestedEntry + slDist).toFixed(2)
    const suggestedTarget = direction === 'BULL'
      ? +(suggestedEntry + tDist).toFixed(2)
      : +(suggestedEntry - tDist).toFixed(2)
    const expectedMovePct = ((tDist / suggestedEntry) * 100) * (direction === 'BULL' ? 1 : -1)

    return {
      symbol,
      price: +last.close.toFixed(2),
      change: +dayChange.toFixed(2),
      changePct: +dayChangePct.toFixed(2),
      score: Math.min(10, 5 + mag / 3),
      tier,
      direction,
      reasons,
      tags,
      expectedMovePct: +expectedMovePct.toFixed(1),
      timeframeLabel: '3-10 sessions',
      suggestedEntry,
      suggestedSL,
      suggestedTarget,
      detectedAt: Date.now(),
      setupKind: 'MOMENTUM',
    }
  },
}

export const MOVERS_SCREENERS: Screener[] = [weeklyMovers]
