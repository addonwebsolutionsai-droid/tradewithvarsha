import type { Confluence, Signal, SignalType, StrategyContext } from '../types'
import { analyzeSMC, smcSignal } from '../patterns/smc'
import { detectPatterns, patternsToSignal } from '../patterns/chart'
import { emaStack, lastRSI, lastATR, macd, adx } from '../indicators'
import { scoreConfluence, gradeFromScore } from '../engine/scoring'
import { computeSLAndTargets, riskPct, rewardPct, riskReward } from '../engine/risk'
import { buildTradePlan } from '../engine/tradePlan'
import { addDays } from '../util/time'

/**
 * Gold / Crude commodity strategy.
 * Special astro-sensitivity: Venus-Jupiter for gold, Mars-Saturn for crude.
 */
export function commoditySignal(ctx: StrategyContext): Signal | null {
  const { symbol, candles } = ctx
  if (candles.length < 40) return null

  const last = candles[candles.length - 1]
  const smc = analyzeSMC(candles)
  const smcSig = smcSignal(smc)
  const stack = emaStack(candles)
  const rsi = lastRSI(candles, 14) ?? 50
  const m = macd(candles)
  const chartPatterns = detectPatterns(candles)
  const patternSig = patternsToSignal(chartPatterns)

  let direction: 'BUY' | 'SELL' | null = null
  if (smcSig.bull && stack.alignedBull) direction = 'BUY'
  else if (smcSig.bear && stack.alignedBear) direction = 'SELL'
  else if (patternSig.bull > patternSig.bear + 0.5) direction = 'BUY'
  else if (patternSig.bear > patternSig.bull + 0.5) direction = 'SELL'

  // Snapshot fallback — surface bias card even when commodity tape is flat.
  if (!direction && ctx.relaxed) {
    if (stack.ema21 != null) direction = last.close >= stack.ema21 ? 'BUY' : 'SELL'
  }
  if (!direction) return null

  // Regime filter — commodities chop hard around news. Block ADX<18.
  if (!ctx.relaxed) {
    const a = adx(candles, 14)
    if (!a || a.adx < 18) return null
  }

  const bull = direction === 'BUY'
  const confluence: Confluence = {
    smc: bull ? smcSig.bull : smcSig.bear,
    trend: bull ? stack.alignedBull : stack.alignedBear,
    rsi: bull ? rsi > 48 : rsi < 52,
    pattern: bull ? patternSig.bull > 0.5 : patternSig.bear > 0.5,
    supertrend: m ? (bull ? m.histogram > 0 : m.histogram < 0) : false,
  }
  if (ctx.gannBias) confluence.gann = ctx.gannBias.timeCycleHit || ctx.gannBias.priceAtGannLevel
  if (ctx.astroBias) {
    const astroAligned = bull ? ctx.astroBias.bullish : ctx.astroBias.bearish
    confluence.astro = astroAligned
  }
  if (ctx.flowDirection) {
    confluence.flow = (bull && ctx.flowDirection === 'BULL') || (!bull && ctx.flowDirection === 'BEAR')
  }

  const { score, count } = scoreConfluence(confluence)
  const minCount = ctx.relaxed ? 2 : 4   // tightened: 4/5 live, 2/5 snapshot
  if (count < minCount) return null
  const grade = gradeFromScore(score)

  const entry = +last.close.toFixed(2)
  const type: SignalType = 'COMMODITY'
  const { stopLoss, target1, target2 } = computeSLAndTargets(candles, entry, direction, type)

  const reasons: string[] = [
    `SMC ${bull ? 'bullish' : 'bearish'}: ${smc.note}`,
    `RSI ${rsi.toFixed(1)}`,
  ]
  if (m) reasons.push(`MACD hist ${m.histogram.toFixed(3)}`)
  if (chartPatterns.length) reasons.push(`Pattern: ${chartPatterns[0].name}`)
  if (ctx.gannBias) reasons.push(`Gann: ${ctx.gannBias.note}`)
  if (ctx.astroBias) reasons.push(`Astro: ${ctx.astroBias.note}`)

  const tradePlan = buildTradePlan({
    type, entry, target2, direction,
    asOf: new Date(last.time).toISOString(),
    candles,
  })
  return {
    id: `commodity-${symbol}-${Date.now()}`,
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
    type,
    reasons,
    gannNote: ctx.gannBias?.note ?? 'Gann neutral',
    astroNote: ctx.astroBias?.note ?? 'Astro neutral',
    oiNote: 'N/A — commodity',
    pattern: chartPatterns.map(p => p.name).join(', ') || smc.note,
    expiresAt: addDays(new Date(), 10).toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    confluence,
    confluenceCount: count,
    source: 'commodity',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: {
      ema9: stack.ema9, ema21: stack.ema21, ema50: stack.ema50,
      atr: lastATR(candles, 14),
      rsi,
      pattern: chartPatterns[0]?.name,
      timeframe: '1D',
    },
    tradePlan,
  }
}
