import type { Confluence, Signal, SignalType, StrategyContext } from '../types'
import { analyzeSMC, smcSignal } from '../patterns/smc'
import { detectPatterns, patternsToSignal } from '../patterns/chart'
import { emaStack, lastRSI, macd, adx } from '../indicators'
import { scoreConfluence, gradeFromScore } from '../engine/scoring'
import { computeSLAndTargets, riskPct, rewardPct, riskReward } from '../engine/risk'
import { buildTradePlan } from '../engine/tradePlan'
import { lastATR } from '../indicators'
import { addDays } from '../util/time'

/**
 * Swing strategy — 1-4 weeks, min 20% target per CLAUDE.md.
 * Uses daily candles, confluence of SMC + higher-timeframe EMA stack + MACD + ADX.
 */
export function swingSignal(ctx: StrategyContext): Signal | null {
  const { symbol, candles, candlesHigher } = ctx
  if (candles.length < 60) return null

  const last = candles[candles.length - 1]
  const smc = analyzeSMC(candles)
  const smcSig = smcSignal(smc)
  const stack = emaStack(candles)
  const higherStack = candlesHigher ? emaStack(candlesHigher) : stack
  const rsi = lastRSI(candles, 14) ?? 50
  const m = macd(candles)
  const a = adx(candles)
  const chartPatterns = detectPatterns(candles)
  const patternSig = patternsToSignal(chartPatterns)

  let direction: 'BUY' | 'SELL' | null = null
  if (smc.bias === 'BULLISH' && stack.alignedBull && higherStack.alignedBull) direction = 'BUY'
  else if (smc.bias === 'BEARISH' && stack.alignedBear && higherStack.alignedBear) direction = 'SELL'
  else if (smcSig.bull && patternSig.bull > patternSig.bear) direction = 'BUY'
  else if (smcSig.bear && patternSig.bear > patternSig.bull) direction = 'SELL'

  // Snapshot fallback — when market is closed we still surface a card per
  // symbol. Use SMC bias first, then EMA50 cross as soft tilt.
  if (!direction && ctx.relaxed) {
    if (smc.bias === 'BULLISH') direction = 'BUY'
    else if (smc.bias === 'BEARISH') direction = 'SELL'
    else if (stack.ema50 != null) direction = last.close >= stack.ema50 ? 'BUY' : 'SELL'
  }
  if (!direction) return null

  // Regime filter — block flat / chop tape (ADX<20). Skip in snapshot mode
  // because we still want the dashboard to show a directional bias card.
  if (!ctx.relaxed) {
    if (!a || a.adx < 20) return null
    if (direction === 'BUY' && a.pdi < a.mdi) return null
    if (direction === 'SELL' && a.mdi < a.pdi) return null
  }

  const bull = direction === 'BUY'
  const confluence: Confluence = {
    smc: bull ? smc.bias === 'BULLISH' || smcSig.bull : smc.bias === 'BEARISH' || smcSig.bear,
    trend: bull ? stack.alignedBull : stack.alignedBear,
    rsi: bull ? rsi > 48 && rsi < 75 : rsi < 52 && rsi > 25,
    pattern: bull ? patternSig.bull > patternSig.bear && patternSig.bull > 0.5
                   : patternSig.bear > patternSig.bull && patternSig.bear > 0.5,
    volume: false, // daily vol-spike less reliable; we ignore here
  }
  if (m) {
    confluence.supertrend = bull ? m.macd > m.signal && m.histogram > 0 : m.macd < m.signal && m.histogram < 0
  }
  if (a && a.adx > 22) {
    confluence.vwap = bull ? a.pdi > a.mdi : a.mdi > a.pdi
  }
  if (ctx.gannBias) {
    confluence.gann = ctx.gannBias.timeCycleHit || ctx.gannBias.priceAtGannLevel
  }
  if (ctx.astroBias) {
    confluence.astro = bull ? ctx.astroBias.bullish : ctx.astroBias.bearish
  }
  if (ctx.flowDirection) {
    confluence.flow = (bull && ctx.flowDirection === 'BULL') || (!bull && ctx.flowDirection === 'BEAR')
  }
  if (ctx.fundamentalsFactorFires) confluence.fundamentals = true

  const { score, count } = scoreConfluence(confluence)
  const minCount = ctx.relaxed ? 3 : 5   // tightened: 5/5 live, 3/5 snapshot
  if (count < minCount) return null
  const grade = gradeFromScore(score)

  const entry = +last.close.toFixed(2)
  const type: SignalType = 'SWING'
  const { stopLoss, target1, target2 } = computeSLAndTargets(candles, entry, direction, type)

  // Skip swing setups whose T1 doesn't clear the brokerage hurdle (≥ 3 % on
  // a 1-4 week horizon). Snapshot/WATCH cards skip this filter.
  if (!ctx.relaxed) {
    const t1Pct = Math.abs((target1 - entry) / entry) * 100
    if (t1Pct < 3) return null
  }

  const reasons: string[] = []
  reasons.push(`SMC bias ${smc.bias}`)
  if (stack.alignedBull || stack.alignedBear) reasons.push(`Daily EMA 9/21/50 stacked ${bull ? 'bull' : 'bear'}`)
  if (higherStack.alignedBull || higherStack.alignedBear) reasons.push(`Weekly EMA alignment ${bull ? 'bull' : 'bear'}`)
  if (m) reasons.push(`MACD ${m.macd.toFixed(2)} vs signal ${m.signal.toFixed(2)} (${m.histogram > 0 ? 'bullish' : 'bearish'})`)
  if (a) reasons.push(`ADX ${a.adx.toFixed(1)} — trend ${a.adx > 25 ? 'strong' : 'weak'}`)
  if (rsi) reasons.push(`Daily RSI ${rsi.toFixed(1)}`)
  if (chartPatterns.length) reasons.push(`Patterns: ${chartPatterns.map(p => p.name).slice(0, 2).join(', ')}`)
  if (ctx.gannBias) reasons.push(`Gann: ${ctx.gannBias.note}`)

  const tradePlan = buildTradePlan({
    type, entry, target2, direction,
    asOf: new Date(last.time).toISOString(),
  })
  return {
    id: `swing-${symbol}-${Date.now()}`,
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
    oiNote: 'N/A — cash equity',
    pattern: chartPatterns.map(p => p.name).join(', ') || 'Structural trend',
    expiresAt: addDays(new Date(), 21).toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    confluence,
    confluenceCount: count,
    source: 'swing',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: {
      ema9: stack.ema9, ema21: stack.ema21, ema50: stack.ema50, ema200: stack.ema200,
      atr: lastATR(candles, 14),
      rsi,
      adx: a?.adx,
      pattern: chartPatterns[0]?.name,
      timeframe: '1D',
    },
    tradePlan,
  }
}
