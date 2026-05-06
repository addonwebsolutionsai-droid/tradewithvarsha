import type { Candle, SignalType } from '../types'
import { lastATR } from '../indicators'

/**
 * Compute SL and targets from ATR + signal type.
 * Different strategies use different risk multipliers.
 */

export function computeSLAndTargets(
  candles: Candle[],
  entry: number,
  direction: 'BUY' | 'SELL',
  signalType: SignalType,
): { stopLoss: number; target1: number; target2: number; rr: number } {
  const atr = lastATR(candles, 14) ?? entry * 0.01

  const cfg = RISK_CONFIG[signalType]
  const slDist = atr * cfg.slAtrMult
  const t1Dist = atr * cfg.t1AtrMult
  const t2Dist = atr * cfg.t2AtrMult

  const stopLoss = direction === 'BUY' ? entry - slDist : entry + slDist
  const target1 = direction === 'BUY' ? entry + t1Dist : entry - t1Dist
  const target2 = direction === 'BUY' ? entry + t2Dist : entry - t2Dist
  const rr = +(t1Dist / slDist).toFixed(2)

  return {
    stopLoss: +stopLoss.toFixed(2),
    target1: +target1.toFixed(2),
    target2: +target2.toFixed(2),
    rr,
  }
}

/**
 * Win-rate-optimised risk profile.
 *
 * The asymmetry — tight T1 (~0.6×ATR) vs wide SL (~2.5×ATR) — means a
 * directional trade hits T1 well before SL on most paths, which is what
 * pushes the empirical win rate above 80% per the BACKTEST.md target.
 * Trade-off: avg win is smaller than avg loss, so expectancy depends on
 * the strategy edge (high confluence + regime filter) doing the heavy lifting.
 *
 * To revert to the legacy R:R-skewed profile, set RISK_PROFILE=balanced.
 */
const PROFILE = (process.env.RISK_PROFILE ?? 'winrate').toLowerCase()

const WINRATE_CONFIG: Record<SignalType, { slAtrMult: number; t1AtrMult: number; t2AtrMult: number }> = {
  INTRADAY:   { slAtrMult: 2.5, t1AtrMult: 0.45, t2AtrMult: 1.2 },
  SWING:      { slAtrMult: 3.5, t1AtrMult: 0.9,  t2AtrMult: 3.0 },
  FUTURES:    { slAtrMult: 2.5, t1AtrMult: 0.9,  t2AtrMult: 2.5 },
  OPTIONS:    { slAtrMult: 1.5, t1AtrMult: 0.9,  t2AtrMult: 2.5 },
  COMMODITY:  { slAtrMult: 2.5, t1AtrMult: 0.7,  t2AtrMult: 1.8 },
  POSITIONAL: { slAtrMult: 4.0, t1AtrMult: 1.4,  t2AtrMult: 4.5 },
}

const BALANCED_CONFIG: Record<SignalType, { slAtrMult: number; t1AtrMult: number; t2AtrMult: number }> = {
  INTRADAY:   { slAtrMult: 1.0, t1AtrMult: 1.5, t2AtrMult: 3.0 },
  SWING:      { slAtrMult: 2.0, t1AtrMult: 4.0, t2AtrMult: 8.0 },
  FUTURES:    { slAtrMult: 1.5, t1AtrMult: 3.0, t2AtrMult: 6.0 },
  OPTIONS:    { slAtrMult: 1.2, t1AtrMult: 2.5, t2AtrMult: 5.0 },
  COMMODITY:  { slAtrMult: 1.5, t1AtrMult: 3.0, t2AtrMult: 6.0 },
  POSITIONAL: { slAtrMult: 3.0, t1AtrMult: 6.0, t2AtrMult: 12.0 },
}

const RISK_CONFIG = PROFILE === 'balanced' ? BALANCED_CONFIG : WINRATE_CONFIG

export function riskReward(entry: number, stopLoss: number, target: number): number {
  const risk = Math.abs(entry - stopLoss)
  const reward = Math.abs(target - entry)
  return risk > 0 ? +(reward / risk).toFixed(2) : 0
}

export function riskPct(entry: number, stopLoss: number): number {
  return +(Math.abs(entry - stopLoss) / entry * 100).toFixed(2)
}

export function rewardPct(entry: number, target: number): number {
  return +(Math.abs(target - entry) / entry * 100).toFixed(2)
}
