import type { Confluence, Signal, SignalType, StrategyContext } from '../types'
import { analyzeSMC, smcSignal } from '../patterns/smc'
import { emaStack, lastRSI, lastVWAP, volumeSpike, adx, lastATR } from '../indicators'
import { interpretOI, suggestOptionLeg } from '../options/oiAnalyzer'
import { scoreConfluence, gradeFromScore } from '../engine/scoring'
import { riskPct, rewardPct, riskReward } from '../engine/risk'
import { buildTradePlan } from '../engine/tradePlan'
import { addDays } from '../util/time'

/**
 * Options momentum strategy.
 *
 * Live mode: needs a real option chain (Angel/NSE) — recommends near-ATM
 * CE/PE with 30-50 % target, 4–5 confluence factors aligned including OI.
 *
 * Snapshot mode (market closed OR chain fetch failed): synthesises an ATM
 * leg from the underlying spot + heuristic premium so the Options tab is
 * never empty. Tagged tier='WATCH' — never auto-alerted.
 */
export function optionsSignal(ctx: StrategyContext): Signal | null {
  const { symbol, candles, optionChain } = ctx
  if (candles.length < 30) return null
  if (!optionChain && !ctx.relaxed) return null

  const last = candles[candles.length - 1]
  const smc = analyzeSMC(candles)
  const smcSig = smcSignal(smc)
  const stack = emaStack(candles)
  const rsi = lastRSI(candles, 14) ?? 50
  const vwap = lastVWAP(candles)
  const volSpike = volumeSpike(candles, 20, 1.6)
  const oi = optionChain ? interpretOI(optionChain) : null

  // Direction
  let direction: 'BUY' | 'SELL' | null = null
  if (oi) {
    if (smcSig.bull && (oi.bias === 'BULLISH' || oi.bias === 'NEUTRAL')) direction = 'BUY'
    else if (smcSig.bear && (oi.bias === 'BEARISH' || oi.bias === 'NEUTRAL')) direction = 'SELL'
    else if (oi.bias === 'BULLISH' && stack.alignedBull) direction = 'BUY'
    else if (oi.bias === 'BEARISH' && stack.alignedBear) direction = 'SELL'
  } else {
    if (smcSig.bull && stack.alignedBull) direction = 'BUY'
    else if (smcSig.bear && stack.alignedBear) direction = 'SELL'
  }
  // Snapshot fallback — surface a card per (NIFTY/BANKNIFTY) so the Options
  // tab is never empty. Bias = (oi if available) > SMC bias > price-vs-EMA21.
  if (!direction && ctx.relaxed) {
    if (oi && oi.bias === 'BULLISH') direction = 'BUY'
    else if (oi && oi.bias === 'BEARISH') direction = 'SELL'
    else if (smc.bias === 'BULLISH') direction = 'BUY'
    else if (smc.bias === 'BEARISH') direction = 'SELL'
    else if (stack.ema21 != null) direction = last.close >= stack.ema21 ? 'BUY' : 'SELL'
  }
  if (!direction) return null

  // Regime gate (live only)
  if (!ctx.relaxed) {
    const a = adx(candles, 14)
    if (!a || a.adx < 22) return null
  }

  // Resolve the option leg — real chain leg in live mode, synthetic ATM in snapshot
  const leg = oi
    ? suggestOptionLeg(optionChain!, direction)
    : synthesiseAtmLeg(symbol, last.close, direction)
  if (!leg || leg.ltp <= 0) return null

  const bull = direction === 'BUY'
  // In snapshot mode, count soft alignments (SMC bias, price vs EMA21) so a
  // WATCH card can still meet the floor even when the strict SMC/EMA stack
  // doesn't agree.
  const softSmc = ctx.relaxed && (bull ? smc.bias === 'BULLISH' : smc.bias === 'BEARISH')
  const softTrend = ctx.relaxed && stack.ema21 != null && (bull ? last.close >= stack.ema21 : last.close < stack.ema21)
  const confluence: Confluence = {
    smc: (bull ? smcSig.bull : smcSig.bear) || softSmc,
    trend: (bull ? stack.alignedBull : stack.alignedBear) || softTrend,
    vwap: bull ? !!vwap && last.close > vwap : !!vwap && last.close < vwap,
    volume: volSpike,
    rsi: bull ? rsi > 50 && rsi < 72 : rsi < 50 && rsi > 28,
    oi: oi ? (bull ? oi.bias === 'BULLISH' : oi.bias === 'BEARISH') : false,
    pattern: false,
  }
  if (ctx.gannBias) confluence.gann = ctx.gannBias.timeCycleHit || ctx.gannBias.priceAtGannLevel
  if (ctx.astroBias) confluence.astro = bull ? ctx.astroBias.bullish : ctx.astroBias.bearish
  if (ctx.flowDirection) {
    confluence.flow = (bull && ctx.flowDirection === 'BULL') || (!bull && ctx.flowDirection === 'BEAR')
  }
  if (ctx.fundamentalsFactorFires) confluence.fundamentals = true

  const { score, count } = scoreConfluence(confluence)
  // Snapshot mode without a live chain loses the OI factor automatically,
  // so the floor drops to 2/5 to keep the Options tab populated. Live mode
  // still demands 5/5 for an alert-worthy setup.
  const minCount = ctx.relaxed ? (oi ? 3 : 2) : 5
  if (count < minCount) return null
  const grade = gradeFromScore(score)

  const entry = leg.ltp
  const stopLoss = +(entry * 0.8).toFixed(2)
  const target1 = +(entry * 1.35).toFixed(2)
  const target2 = +(entry * 1.8).toFixed(2)
  const instrument = `${symbol} ${leg.strike} ${leg.side}`
  const type: SignalType = 'OPTIONS'
  const expiry = (oi && optionChain?.expiry) || addDays(new Date(), 7).toISOString().slice(0, 10)

  const reasons: string[] = []
  reasons.push(`Underlying SMC ${bull ? 'bull' : 'bear'} ${oi ? '+ ' + oi.note : '(snapshot — no live chain)'}`)
  if (oi) {
    if (confluence.oi) reasons.push(`OI: ${oi.bias} — ${bull ? 'put writing' : 'call writing'} at key strikes`)
    if (oi.putUnwinding.length && bull) reasons.push(`Put unwinding @ ${oi.putUnwinding[0].strike}`)
    if (oi.callWriting.length && !bull) reasons.push(`Call writing @ ${oi.callWriting[0].strike}`)
    reasons.push(`PCR ${oi.pcr.toFixed(2)} (${oi.pcrRegime.replace('_', ' ')})`)
    reasons.push(`Max Pain ${oi.maxPain} vs spot ${optionChain!.spot}`)
  } else {
    reasons.push(`ATM ${leg.strike} ${leg.side} · spot ₹${last.close.toFixed(2)} · est premium ₹${leg.ltp.toFixed(2)}`)
  }
  if (confluence.volume) reasons.push('Volume spike on underlying')
  if (confluence.gann && ctx.gannBias) reasons.push(`Gann: ${ctx.gannBias.note}`)
  if (confluence.astro && ctx.astroBias) reasons.push(`Astro: ${ctx.astroBias.note}`)

  const tradePlan = buildTradePlan({
    type,
    underlying: symbol,
    strike: leg.strike,
    side: leg.side,
    expiry,
    premium: leg.ltp,
    entry, target2, direction,
    asOf: new Date(last.time).toISOString(),
    candles,
  })
  return {
    id: `options-${symbol}-${leg.strike}-${Date.now()}`,
    instrument,
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
    oiNote: oi?.note ?? 'snapshot — chain unavailable, ATM heuristic used',
    pattern: smc.note,
    expiresAt: expiry,
    timestamp: new Date().toISOString(),
    confluence,
    confluenceCount: count,
    source: 'options',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: {
      ema9: stack.ema9, ema21: stack.ema21, ema50: stack.ema50,
      atr: lastATR(candles, 14),
      rsi,
      vwap: vwap ?? undefined,
      timeframe: '15m',
    },
    tradePlan,
  }
}

/**
 * Synthetic ATM leg for snapshot mode when the live option chain is
 * unavailable. Strike is rounded to the standard step (50 for NIFTY,
 * 100 for BANKNIFTY) and the premium is a rough heuristic of 1 % of spot
 * for an ATM weekly — enough for the WATCH card to be informative without
 * pretending to be a real quote.
 */
function synthesiseAtmLeg(
  underlying: string,
  spot: number,
  direction: 'BUY' | 'SELL',
): { strike: number; side: 'CE' | 'PE'; ltp: number } {
  const step = underlying === 'BANKNIFTY' ? 100 : 50
  const strike = Math.round(spot / step) * step
  const side: 'CE' | 'PE' = direction === 'BUY' ? 'CE' : 'PE'
  const ltp = +(spot * 0.01).toFixed(2)   // ~1% of spot for weekly ATM
  return { strike, side, ltp }
}
