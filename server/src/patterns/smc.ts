import type { Candle } from '../types'

/**
 * Smart Money Concepts — simplified but functional.
 *
 * Structure:
 *   Higher High (HH), Higher Low (HL)  → bullish market structure
 *   Lower High (LH), Lower Low (LL)    → bearish market structure
 *
 * Break of Structure (BOS):
 *   Bullish BOS: price closes above previous swing high in an uptrend
 *   Bearish BOS: price closes below previous swing low in a downtrend
 *
 * Change of Character (CHoCH):
 *   First BOS against the prior trend — signals reversal
 *
 * Liquidity grab / sweep:
 *   A spike beyond a prior high/low followed by an immediate reversal —
 *   institutional "stop hunt". Strong reversal signal when confirmed.
 *
 * Order Block (OB):
 *   The last opposite-direction candle before a strong move — institutional
 *   footprint, tends to act as support/resistance on retest.
 */

export interface SwingPoint {
  idx: number
  price: number
  kind: 'HIGH' | 'LOW'
  time: number
}

/** Detect swing highs/lows via pivot method (needs `left` + `right` confirmation candles). */
export function findSwings(candles: Candle[], left = 2, right = 2): SwingPoint[] {
  const swings: SwingPoint[] = []
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i]
    let isHigh = true
    let isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      if (candles[j].high >= c.high) isHigh = false
      if (candles[j].low <= c.low) isLow = false
    }
    if (isHigh) swings.push({ idx: i, price: c.high, kind: 'HIGH', time: c.time })
    else if (isLow) swings.push({ idx: i, price: c.low, kind: 'LOW', time: c.time })
  }
  return swings
}

export type SMCBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL'

export interface SMCAnalysis {
  bias: SMCBias
  lastSwingHigh?: SwingPoint
  lastSwingLow?: SwingPoint
  bosBull: boolean    // price broke previous swing high
  bosBear: boolean    // price broke previous swing low
  chochBull: boolean  // bullish change of character (first break up after down-trend)
  chochBear: boolean
  liquiditySweepBull: boolean  // swept low + closed above
  liquiditySweepBear: boolean  // swept high + closed below
  lastOrderBlock?: { kind: 'BULLISH' | 'BEARISH'; high: number; low: number; idx: number }
  note: string
}

export function analyzeSMC(candles: Candle[]): SMCAnalysis {
  if (candles.length < 20) {
    return {
      bias: 'NEUTRAL',
      bosBull: false, bosBear: false,
      chochBull: false, chochBear: false,
      liquiditySweepBull: false, liquiditySweepBear: false,
      note: 'Not enough data for SMC',
    }
  }
  const swings = findSwings(candles, 3, 3)
  const highs = swings.filter(s => s.kind === 'HIGH').slice(-3)
  const lows = swings.filter(s => s.kind === 'LOW').slice(-3)
  const lastSwingHigh = highs[highs.length - 1]
  const lastSwingLow = lows[lows.length - 1]

  // Structure: last two highs and last two lows
  const hh = highs.length >= 2 && highs[highs.length - 1].price > highs[highs.length - 2].price
  const hl = lows.length >= 2 && lows[lows.length - 1].price > lows[lows.length - 2].price
  const lh = highs.length >= 2 && highs[highs.length - 1].price < highs[highs.length - 2].price
  const ll = lows.length >= 2 && lows[lows.length - 1].price < lows[lows.length - 2].price

  let bias: SMCBias = 'NEUTRAL'
  if (hh && hl) bias = 'BULLISH'
  else if (lh && ll) bias = 'BEARISH'

  const last = candles[candles.length - 1]
  const prior = candles[candles.length - 2]

  // BOS: did the latest close break the preceding swing?
  const bosBull = !!(lastSwingHigh && last.close > lastSwingHigh.price && prior.close <= lastSwingHigh.price)
  const bosBear = !!(lastSwingLow && last.close < lastSwingLow.price && prior.close >= lastSwingLow.price)

  // CHoCH = BOS in opposite direction of the previous trend
  const chochBull = bosBull && bias !== 'BULLISH'
  const chochBear = bosBear && bias !== 'BEARISH'

  // Liquidity sweep: wick pierces prior swing but body closes back inside
  let liquiditySweepBull = false
  let liquiditySweepBear = false
  if (lastSwingLow && last.low < lastSwingLow.price && last.close > lastSwingLow.price) {
    liquiditySweepBull = true
  }
  if (lastSwingHigh && last.high > lastSwingHigh.price && last.close < lastSwingHigh.price) {
    liquiditySweepBear = true
  }

  // Order block: last opposite-colored candle before a big move (>1.5x ATR equivalent)
  let lastOrderBlock: SMCAnalysis['lastOrderBlock']
  for (let i = candles.length - 3; i >= Math.max(0, candles.length - 25); i--) {
    const a = candles[i]
    const b = candles[i + 1]
    const aBull = a.close > a.open
    const bBull = b.close > b.open
    const move = Math.abs(b.close - b.open)
    const avg = (a.high - a.low + Math.abs(a.close - a.open)) / 2
    if (move > avg * 1.8) {
      if (!aBull && bBull) {
        lastOrderBlock = { kind: 'BULLISH', high: a.high, low: a.low, idx: i }
        break
      } else if (aBull && !bBull) {
        lastOrderBlock = { kind: 'BEARISH', high: a.high, low: a.low, idx: i }
        break
      }
    }
  }

  const notes: string[] = []
  if (bias !== 'NEUTRAL') notes.push(`${bias} structure`)
  if (bosBull) notes.push('BOS↑')
  if (bosBear) notes.push('BOS↓')
  if (chochBull) notes.push('CHoCH↑ — bullish reversal')
  if (chochBear) notes.push('CHoCH↓ — bearish reversal')
  if (liquiditySweepBull) notes.push('Liquidity swept low — institutional buy')
  if (liquiditySweepBear) notes.push('Liquidity swept high — institutional sell')
  if (lastOrderBlock) notes.push(`${lastOrderBlock.kind} OB @ ${lastOrderBlock.low.toFixed(2)}-${lastOrderBlock.high.toFixed(2)}`)

  return {
    bias,
    lastSwingHigh,
    lastSwingLow,
    bosBull,
    bosBear,
    chochBull,
    chochBear,
    liquiditySweepBull,
    liquiditySweepBear,
    lastOrderBlock,
    note: notes.join(' · ') || 'Ranging',
  }
}

/** Did SMC fire a signal-worthy event in the latest bar? */
export function smcSignal(smc: SMCAnalysis): { bull: boolean; bear: boolean; strength: number; reason: string } {
  let strength = 0
  const reasons: string[] = []
  if (smc.chochBull) { strength += 2; reasons.push('CHoCH bullish') }
  else if (smc.bosBull) { strength += 1; reasons.push('BOS bullish') }
  if (smc.liquiditySweepBull) { strength += 1.5; reasons.push('Liquidity sweep bullish') }
  if (smc.chochBear) { strength -= 2; reasons.push('CHoCH bearish') }
  else if (smc.bosBear) { strength -= 1; reasons.push('BOS bearish') }
  if (smc.liquiditySweepBear) { strength -= 1.5; reasons.push('Liquidity sweep bearish') }
  return {
    bull: strength > 0,
    bear: strength < 0,
    strength: Math.abs(strength),
    reason: reasons.join(' + '),
  }
}
