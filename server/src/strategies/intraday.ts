import type { Candle, Confluence, Signal, SignalType, StrategyContext } from '../types'
import { analyzeSMC, smcSignal } from '../patterns/smc'
import { detectCandlePatterns } from '../patterns/candlestick'
import { detectPatterns, patternsToSignal } from '../patterns/chart'
import { emaStack, lastRSI, lastVWAP, lastSuperTrend, volumeSpike, adx, lastATR } from '../indicators'
import { scoreConfluence, gradeFromScore } from '../engine/scoring'
import { computeSLAndTargets, riskPct, rewardPct, riskReward } from '../engine/risk'
import { buildTradePlan } from '../engine/tradePlan'

/**
 * Intraday SMC + VWAP + volume strategy.
 * Target: 0.5 – 1% on the underlying.
 * Minimum 3/5 confluence signals required.
 */
export function intradaySignal(ctx: StrategyContext): Signal | null {
  const { symbol, candles } = ctx
  if (candles.length < 30) return null

  const last = candles[candles.length - 1]
  const smc = analyzeSMC(candles)
  const smcSig = smcSignal(smc)
  const stack = emaStack(candles)
  const rsi = lastRSI(candles, 14) ?? 50
  const vwap = lastVWAP(candles)
  const st = lastSuperTrend(candles, 10, 3)
  const volSpike = volumeSpike(candles, 20, 1.6)
  const candlePatterns = detectCandlePatterns(candles)
  const chartPatterns = detectPatterns(candles)
  const patternSig = patternsToSignal(chartPatterns)

  // Decide direction from SMC + EMA stack
  let direction: 'BUY' | 'SELL' | null = null
  if (smcSig.bull && stack.alignedBull) direction = 'BUY'
  else if (smcSig.bear && stack.alignedBear) direction = 'SELL'
  else if (smc.chochBull || smc.liquiditySweepBull) direction = 'BUY'
  else if (smc.chochBear || smc.liquiditySweepBear) direction = 'SELL'

  // Snapshot fallback — when market is closed we still want every symbol to
  // surface a directional bias card. Use price vs EMA21 as the soft tilt.
  if (!direction && ctx.relaxed) {
    if (stack.ema21 != null) direction = last.close >= stack.ema21 ? 'BUY' : 'SELL'
  }
  if (!direction) return null

  // Regime filter — skip choppy intraday tape unless we're in snapshot mode.
  // Requires (a) ADX>=20 OR (b) 5-bar move >= 0.5×ATR in trade direction.
  if (!ctx.relaxed) {
    const a = adx(candles, 14)
    const atrV = lastATR(candles, 14) ?? 0
    const back5 = candles[candles.length - 6]?.close ?? last.close
    const move5 = direction === 'BUY' ? last.close - back5 : back5 - last.close
    const trendOk = (a && a.adx >= 20) || (atrV > 0 && move5 >= 0.5 * atrV)
    if (!trendOk) return null
  }

  const bull = direction === 'BUY'
  const confluence: Confluence = {
    smc: bull ? smcSig.bull : smcSig.bear,
    trend: bull ? stack.alignedBull : stack.alignedBear,
    vwap: bull ? !!vwap && last.close > vwap : !!vwap && last.close < vwap,
    volume: volSpike,
    rsi: bull ? rsi > 50 && rsi < 72 : rsi < 50 && rsi > 28,
    supertrend: !!st && (bull ? st.trend === 'UP' : st.trend === 'DOWN'),
    pattern: bull
      ? candlePatterns.some(p => p.direction === 'BULL') || patternSig.bull > 0.5
      : candlePatterns.some(p => p.direction === 'BEAR') || patternSig.bear > 0.5,
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
  const minCount = ctx.relaxed ? 2 : 4   // tightened: 4/5 for live, 2/5 for snapshot
  if (count < minCount) return null
  const grade = gradeFromScore(score)

  const entry = +last.close.toFixed(2)
  const type: SignalType = 'INTRADAY'
  const { stopLoss, target1, target2 } = computeSLAndTargets(candles, entry, direction, type)

  // Skip scalp setups — user explicitly doesn't want 2-3-point trades that
  // get eaten by brokerage + STT. Minimum T1 distance required:
  //   - indices (NIFTY/BANKNIFTY): ≥ 0.5 % (≈ 50+ Nifty pts / 200+ BankNifty pts)
  //   - stocks: ≥ 1.5 % move to T1
  //   - commodities: ≥ 0.5 %
  // (snapshot/WATCH cards skip this filter so the dashboard stays populated)
  if (!ctx.relaxed) {
    const t1Pct = Math.abs((target1 - entry) / entry) * 100
    const isIndex = symbol === 'NIFTY' || symbol === 'BANKNIFTY' || symbol === 'FINNIFTY'
    const isCommodity = symbol === 'GOLD' || symbol === 'CRUDE'
    const minT1Pct = isIndex ? 0.5 : isCommodity ? 0.5 : 1.5
    if (t1Pct < minT1Pct) return null
  }

  const reasons: string[] = []
  if (smc.note) reasons.push(`SMC: ${smc.note}`)
  if (confluence.trend) reasons.push(`EMA 9/21/50 stacked ${bull ? 'bull' : 'bear'}`)
  if (confluence.vwap) reasons.push(`Price ${bull ? 'above' : 'below'} VWAP (${vwap?.toFixed(2)})`)
  if (confluence.volume) reasons.push(`Volume spike — ${candles[candles.length - 1].volume.toLocaleString()} vs 20-bar avg`)
  if (confluence.rsi) reasons.push(`RSI ${rsi.toFixed(1)} — favorable range`)
  if (confluence.supertrend && st) reasons.push(`SuperTrend ${st.trend} @ ${st.value.toFixed(2)}`)
  if (confluence.pattern) {
    const p = [...candlePatterns, ...chartPatterns.map(x => ({ name: x.name, direction: x.direction }))]
    reasons.push(`Patterns: ${p.map(x => x.name).slice(0, 3).join(', ')}`)
  }
  if (confluence.gann && ctx.gannBias) reasons.push(`Gann: ${ctx.gannBias.note}`)
  if (confluence.astro && ctx.astroBias) reasons.push(`Astro: ${ctx.astroBias.note}`)

  const tradePlan = buildTradePlan({
    type, entry, target2, direction,
    asOf: new Date(candles[candles.length - 1].time).toISOString(),
    candles,
  })
  return {
    id: `intraday-${symbol}-${Date.now()}`,
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
    oiNote: 'N/A — intraday equity/index',
    pattern: chartPatterns.map(p => p.name).join(', ') || candlePatterns.map(p => p.name).join(', ') || 'Price action',
    expiresAt: endOfSessionIST(),
    timestamp: new Date().toISOString(),
    confluence,
    confluenceCount: count,
    source: 'intraday',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: {
      ema9: stack.ema9, ema21: stack.ema21, ema50: stack.ema50,
      atr: lastATR(candles, 14),
      rsi,
      vwap: vwap ?? undefined,
      pattern: chartPatterns[0]?.name ?? candlePatterns[0]?.name,
      timeframe: '15m',
    },
    tradePlan,
  }
}

function endOfSessionIST(): string {
  const d = new Date()
  // 15:30 IST = 10:00 UTC
  const istClose = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0, 0))
  if (istClose.getTime() < d.getTime()) istClose.setUTCDate(istClose.getUTCDate() + 1)
  return istClose.toISOString()
}
