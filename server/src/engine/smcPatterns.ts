/**
 * SMART MONEY CONCEPT (SMC) PATTERN DETECTORS — criterion 19.
 *
 * Algorithmic implementation of the standard SMC primitives. Concepts are
 * algorithmic / mathematical (not copyrightable). Attribution: terminology
 * is widely associated with ICT (Inner Circle Trader) and SMC trading
 * communities; the math below is our own implementation.
 *
 * Detected primitives:
 *   - Fair Value Gap (FVG)     — 3-bar imbalance (a price range that price
 *                                 left unfilled, gets revisited later as S/R)
 *   - Order Block (OB)         — last opposing candle before a Break of
 *                                 Structure; institutional accumulation zone
 *   - Break of Structure (BoS) — price clears the most recent swing high
 *                                 (bullish) or low (bearish)
 *   - Liquidity Sweep          — fake-out wick beyond a prior swing then
 *                                 reclaim (stop-hunt)
 *
 * Scoring (returned as a CriterionResult so it slots into the 20-criteria
 * scorecard):
 *   pass = TRUE if at least 2 of the 4 primitives fire in the candidate's
 *   direction.
 *   score = sum of contributing primitive scores, capped at 10.
 */
import type { Candle } from '../types'
import type { CriterionResult } from './fnoFutures12Criteria'

interface PrimitiveHit {
  name: 'FVG' | 'OB' | 'BoS' | 'LiquiditySweep'
  bullish: boolean
  detail: string
}

// — Fair Value Gap (FVG) —
// On three consecutive bars (i-2, i-1, i), if candle i-1 is a strong
// impulse and the high of i-2 is BELOW the low of i (or vice versa), the
// gap between high[i-2] and low[i] is an unfilled imbalance.
function detectFVG(candles: Candle[]): PrimitiveHit | null {
  if (candles.length < 4) return null
  // Look at the last 10 bars for the most recent unfilled FVG
  for (let i = candles.length - 2; i >= Math.max(3, candles.length - 10); i--) {
    const c2 = candles[i - 2], c1 = candles[i - 1], c0 = candles[i]
    // Bullish FVG: gap between c2.high and c0.low (c1 is impulse up)
    if (c2.high < c0.low && c1.close > c1.open && (c1.high - c1.low) > 0) {
      const gapTop = c0.low, gapBot = c2.high
      // Check if gap remains unfilled by subsequent bars
      let unfilled = true
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].low <= gapBot) { unfilled = false; break }
      }
      if (unfilled) {
        return { name: 'FVG', bullish: true, detail: `bullish FVG ₹${gapBot.toFixed(1)}–${gapTop.toFixed(1)}` }
      }
    }
    // Bearish FVG: gap between c2.low and c0.high (c1 is impulse down)
    if (c2.low > c0.high && c1.close < c1.open && (c1.high - c1.low) > 0) {
      const gapTop = c2.low, gapBot = c0.high
      let unfilled = true
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].high >= gapTop) { unfilled = false; break }
      }
      if (unfilled) {
        return { name: 'FVG', bullish: false, detail: `bearish FVG ₹${gapBot.toFixed(1)}–${gapTop.toFixed(1)}` }
      }
    }
  }
  return null
}

// — Order Block (OB) —
// Last bearish candle before a bullish impulse that breaks the prior
// swing high = bullish OB (institutional buying zone).
// Mirror for bearish.
function detectOrderBlock(candles: Candle[]): PrimitiveHit | null {
  if (candles.length < 15) return null
  const last20 = candles.slice(-20)
  // Find the most recent strong impulse (≥1.5× ATR)
  let atrAvg = 0
  for (let i = 1; i < last20.length; i++) atrAvg += last20[i].high - last20[i].low
  atrAvg /= (last20.length - 1)

  for (let i = last20.length - 1; i >= 3; i--) {
    const bar = last20[i]
    const body = Math.abs(bar.close - bar.open)
    const isImpulse = body >= atrAvg * 1.5
    if (!isImpulse) continue
    const bullImpulse = bar.close > bar.open
    // Walk backward to find last opposite-color candle
    for (let j = i - 1; j >= 0; j--) {
      const c = last20[j]
      const isOpposite = bullImpulse ? c.close < c.open : c.close > c.open
      if (isOpposite) {
        // Verify the impulse broke the OB candle's high/low (real BoS)
        const broke = bullImpulse ? bar.close > c.high : bar.close < c.low
        if (broke) {
          const obLow = Math.min(c.open, c.close)
          const obHigh = Math.max(c.open, c.close)
          return {
            name: 'OB',
            bullish: bullImpulse,
            detail: `${bullImpulse ? 'bullish' : 'bearish'} OB zone ₹${obLow.toFixed(1)}–${obHigh.toFixed(1)}`,
          }
        }
        break
      }
    }
  }
  return null
}

// — Break of Structure (BoS) —
// Most recent close clears the highest swing high of the last 20 bars
// (bullish BoS) or breaks the lowest swing low (bearish BoS).
function detectBoS(candles: Candle[]): PrimitiveHit | null {
  if (candles.length < 22) return null
  const window = candles.slice(-22, -1)        // exclude the latest bar's high/low itself
  const swingHigh = Math.max(...window.map(c => c.high))
  const swingLow = Math.min(...window.map(c => c.low))
  const last = candles[candles.length - 1]
  if (last.close > swingHigh) {
    return { name: 'BoS', bullish: true, detail: `bullish BoS — close ${last.close.toFixed(1)} > 20d swing high ${swingHigh.toFixed(1)}` }
  }
  if (last.close < swingLow) {
    return { name: 'BoS', bullish: false, detail: `bearish BoS — close ${last.close.toFixed(1)} < 20d swing low ${swingLow.toFixed(1)}` }
  }
  return null
}

// — Liquidity Sweep (stop-hunt) —
// Recent bar's wick pierced a prior swing low/high but the close reclaimed
// inside the prior range. The textbook "fake-out" before a reversal.
function detectLiquiditySweep(candles: Candle[]): PrimitiveHit | null {
  if (candles.length < 22) return null
  const lookback = candles.slice(-22, -3)
  const swingHigh = Math.max(...lookback.map(c => c.high))
  const swingLow = Math.min(...lookback.map(c => c.low))
  // Check the last 3 bars for a sweep
  for (let i = candles.length - 3; i < candles.length; i++) {
    const c = candles[i]
    // Bullish sweep: wick below swingLow, close above
    if (c.low < swingLow && c.close > swingLow) {
      const wickSize = (swingLow - c.low) / swingLow * 100
      return {
        name: 'LiquiditySweep',
        bullish: true,
        detail: `bullish sweep — wick ${wickSize.toFixed(1)}% below ${swingLow.toFixed(1)} then reclaimed`,
      }
    }
    // Bearish sweep: wick above swingHigh, close below
    if (c.high > swingHigh && c.close < swingHigh) {
      const wickSize = (c.high - swingHigh) / swingHigh * 100
      return {
        name: 'LiquiditySweep',
        bullish: false,
        detail: `bearish sweep — wick ${wickSize.toFixed(1)}% above ${swingHigh.toFixed(1)} then rejected`,
      }
    }
  }
  return null
}

/**
 * Criterion 19: SMC composite. Sums primitive hits aligned with the
 * candidate's direction.
 */
export function criterion19SMC(candles: Candle[], side: 'LONG' | 'SHORT'): CriterionResult {
  const wantBullish = side === 'LONG'
  const hits: PrimitiveHit[] = []
  const fvg = detectFVG(candles); if (fvg && fvg.bullish === wantBullish) hits.push(fvg)
  const ob = detectOrderBlock(candles); if (ob && ob.bullish === wantBullish) hits.push(ob)
  const bos = detectBoS(candles); if (bos && bos.bullish === wantBullish) hits.push(bos)
  const ls = detectLiquiditySweep(candles); if (ls && ls.bullish === wantBullish) hits.push(ls)

  const pointTable: Record<string, number> = { FVG: 3, OB: 3, BoS: 3, LiquiditySweep: 4 }
  const score = Math.min(10, hits.reduce((s, h) => s + (pointTable[h.name] ?? 2), 0))
  const pass = hits.length >= 2
  const detail = hits.length > 0
    ? hits.map(h => `${h.name}: ${h.detail}`).join(' · ')
    : 'no aligned SMC primitives'
  return {
    key: 'smc',
    label: 'SMC (FVG/OB/BoS/Sweep)',
    pass,
    score,
    detail,
  }
}
