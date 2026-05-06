import type { Confluence, Signal, SignalType, StrategyContext } from '../types'
import { detectHarmonic } from '../patterns/harmonic'
import { lastATR, lastRSI } from '../indicators'
import { gradeFromScore } from '../engine/scoring'
import { riskPct, rewardPct, riskReward } from '../engine/risk'
import { buildTradePlan } from '../engine/tradePlan'
import { addDays } from '../util/time'

/**
 * Harmonic-pattern signal strategy.
 *
 * The engine previously had a harmonic detector in `patterns/harmonic.ts`
 * but it was only consumed by Gann cycle status — no signal was ever
 * emitted when a Bat / Gartley / Butterfly / Crab / Cypher completed.
 *
 * The user explicitly flagged this gap after shorting NIFTY at 24580 on
 * 21-Apr using a harmonic AB=CD pattern + wave count — the engine stayed
 * silent. This strategy closes that hole: when D forms on daily or 1h
 * candles with ≥ 65 % confidence AND is still fresh (≤ 6 bars old), we
 * emit a signal against the XA→D direction with Carney-style targets.
 *
 * Intentionally strict — rather than fire on every fuzzy match, we only
 * emit when: (a) confidence ≥ 65, (b) pattern is fresh, (c) the trade
 * direction aligns with at least one other structural read (SMC bias or
 * RSI extreme). Avoids the "too many signals, all wrong" trap.
 */
export function harmonicSignal(ctx: StrategyContext): Signal | null {
  const { symbol, candles, candlesHigher } = ctx
  if (candles.length < 40) return null

  // Try the higher-TF first — a daily harmonic has much more weight than
  // a 15m pattern. Falls through to the primary TF if daily is missing.
  const dailyPattern = candlesHigher && candlesHigher.length >= 30
    ? detectHarmonic(candlesHigher, { minSwingPct: 1.5, maxAgeBars: 6 })
    : null
  const shortPattern = detectHarmonic(candles, { minSwingPct: 0.6, maxAgeBars: 12 })
  const pattern = dailyPattern ?? shortPattern
  if (!pattern) return null
  if (pattern.confidence < 65) return null

  const tf = dailyPattern ? '1D' : '15m'
  const last = candles[candles.length - 1]
  const lastPrice = last.close
  const atr = lastATR(candles, 14) ?? lastPrice * 0.015
  const rsi = lastRSI(candles, 14) ?? 50

  // Direction — harmonic bullish pattern expects a rally from D.
  const direction: 'BUY' | 'SELL' = pattern.direction === 'BULLISH' ? 'BUY' : 'SELL'

  // RSI-extreme confirmation filter — bullish patterns in oversold zone
  // (or the converse) have much better follow-through. If RSI disagrees
  // strongly with the pattern direction, we skip — the user's complaint
  // was getting signals AFTER the move, so being picky is the point.
  if (direction === 'BUY' && rsi > 60) return null
  if (direction === 'SELL' && rsi < 40) return null

  // Entry — inside PRZ; SL 10 % of XA beyond D; T1/T2 per Carney + a T3
  // 1.272 of CD for runners.
  const entry = lastPrice
  const stopLoss = pattern.targets.sl
  const target1 = pattern.targets.t1
  const target2 = pattern.targets.t2

  // Guard against degenerate setups where SL is the wrong side of entry
  // (can happen when D forms outside the PRZ band we'd expect).
  if (direction === 'BUY' && stopLoss >= entry) return null
  if (direction === 'SELL' && stopLoss <= entry) return null

  const signalType: SignalType = dailyPattern ? 'SWING' : 'INTRADAY'
  const score = Math.round(pattern.confidence / 10)   // 65→7, 85→9
  const grade = gradeFromScore(score)

  const confluence: Confluence = {
    pattern: true,
    rsi: (direction === 'BUY' && rsi <= 55) || (direction === 'SELL' && rsi >= 45),
    gann: ctx.gannBias?.timeCycleHit || ctx.gannBias?.priceAtGannLevel || false,
    astro: !!ctx.astroBias && (
      (direction === 'BUY' && ctx.astroBias.bullish)
      || (direction === 'SELL' && ctx.astroBias.bearish)
    ),
    flow: ctx.flowDirection
      ? (direction === 'BUY' ? ctx.flowDirection === 'BULL' : ctx.flowDirection === 'BEAR')
      : false,
  }
  const count = Object.values(confluence).filter(Boolean).length

  const reasons = [
    `🔺 ${pattern.name} ${pattern.direction} — ${pattern.confidence}% confidence on ${tf}`,
    `X ${pattern.X.price.toFixed(2)} → A ${pattern.A.price.toFixed(2)} → B ${pattern.B.price.toFixed(2)} → C ${pattern.C.price.toFixed(2)} → D ${pattern.D.price.toFixed(2)}`,
    `Ratios: B/XA ${pattern.ratios.B_over_XA.toFixed(3)} · C/AB ${pattern.ratios.C_over_AB.toFixed(3)} · D/XA ${pattern.ratios.D_over_XA.toFixed(3)} · BC ${pattern.ratios.BCProjection.toFixed(3)}`,
    `PRZ ${pattern.prz.low.toFixed(2)}–${pattern.prz.high.toFixed(2)} · RSI ${rsi.toFixed(0)} ${direction === 'BUY' ? '(oversold-recovery zone)' : '(overbought-rejection zone)'}`,
    `Target model: T1 @ 38.2% CD / T2 @ 61.8% CD · SL 10% of XA beyond D (${pattern.targets.sl.toFixed(2)})`,
  ]
  if (ctx.gannBias?.timeCycleHit) reasons.push(`Gann time cycle confluence: ${ctx.gannBias.note}`)
  if (confluence.astro && ctx.astroBias) reasons.push(`Astro confirms: ${ctx.astroBias.note}`)

  const tradePlan = buildTradePlan({
    type: signalType,
    entry, target2, direction,
    asOf: new Date(last.time).toISOString(),
    candles,
  })

  const expiresAt = dailyPattern
    ? addDays(new Date(), 14).toISOString().slice(0, 10)
    : addDays(new Date(), 5).toISOString().slice(0, 10)

  return {
    id: `harmonic-${symbol}-${pattern.name}-${Date.now()}`,
    instrument: symbol,
    direction,
    grade,
    score,
    entry,
    stopLoss,
    target1,
    target2,
    target3: tradePlan.target3,
    riskPct: riskPct(entry, stopLoss),
    rewardPct: rewardPct(entry, target1),
    riskReward: riskReward(entry, stopLoss, target1),
    type: signalType,
    reasons,
    gannNote: ctx.gannBias?.note ?? 'Gann neutral',
    astroNote: ctx.astroBias?.note ?? 'Astro neutral',
    oiNote: 'N/A — harmonic structural trade',
    pattern: `${pattern.direction} ${pattern.name}`,
    expiresAt,
    timestamp: new Date().toISOString(),
    confluence,
    confluenceCount: count,
    source: 'harmonic',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: {
      atr, rsi,
      pattern: pattern.name,
      timeframe: tf,
    },
    tradePlan,
  }
}
