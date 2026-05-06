import type { Candle, Confluence, Signal, SignalType, StrategyContext } from '../types'
import { analyzeSMC } from '../patterns/smc'
import { detectCandlePatterns } from '../patterns/candlestick'
import { adx, ema, lastATR, lastRSI, lastVWAP, volumeSpike } from '../indicators'
import { scoreConfluence, gradeFromScore } from '../engine/scoring'
import { riskPct, rewardPct, riskReward } from '../engine/risk'
import { buildTradePlan } from '../engine/tradePlan'
import { addDays } from '../util/time'
import { resolvePremium, daysUntil } from '../options/premium'

/**
 * Intraday Reversal Detector.
 *
 * Catches the kind of move the trend-following F&O advisor misses:
 *   → bearish rejection at resistance  → PE setup (CE writing / put buying)
 *   → bullish rejection at support     → CE setup
 *
 * Example this is designed to catch: NIFTY at 24,400 resistance with a
 * shooting-star candle on the 15m, RSI rolling over from 70, volume fading
 * on the rally → PE signal BEFORE the put premium expands 40-60%.
 *
 * Generates PAIRED legs (futures direction + options leg). Runs on 15-min
 * candles of NIFTY/BANKNIFTY + liquid F&O stocks.
 *
 * Unlike the F&O advisor which needs trend agreement, this fires WITHIN a
 * trend when structure breaks down. That's the whole point — reversals.
 */

const STOCK_OPTION_LOT_SIZES: Record<string, number> = {
  NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 25,
  RELIANCE: 250, TCS: 175, HDFCBANK: 550, INFY: 400, ICICIBANK: 700, SBIN: 750,
  AXISBANK: 625, ITC: 1600, LT: 300, BHARTIARTL: 475, BAJFINANCE: 125,
}

function lotSizeFor(sym: string): number {
  return STOCK_OPTION_LOT_SIZES[sym] ?? 1
}

function isIndex(sym: string): boolean {
  return sym === 'NIFTY' || sym === 'BANKNIFTY' || sym === 'FINNIFTY'
}

function roundStrike(price: number, sym: string): number {
  if (sym === 'BANKNIFTY') return Math.round(price / 100) * 100
  if (sym === 'NIFTY' || sym === 'FINNIFTY') return Math.round(price / 50) * 50
  if (price < 100) return Math.round(price / 2.5) * 2.5
  if (price < 500) return Math.round(price / 5) * 5
  if (price < 2000) return Math.round(price / 10) * 10
  return Math.round(price / 20) * 20
}

function nextThursday(d: Date): string {
  const day = d.getUTCDay()
  const offset = ((4 - day + 7) % 7) || 7
  return addDays(d, offset).toISOString().slice(0, 10)
}

/** Annualised IV estimate from daily ATR, clamped to a realistic band. */
function ivFromAtr(atr: number, spot: number): number {
  if (spot <= 0 || atr <= 0) return 0.15
  const sigmaAnnual = (atr / spot) * Math.sqrt(252)
  return Math.max(0.08, Math.min(0.40, sigmaAnnual))
}

/**
 * Detect key intraday levels that price might reject at:
 *   - previous day high/low
 *   - current session VWAP
 *   - prior swing highs/lows within last 3 sessions
 *   - round-number psychological levels (for indices)
 */
function keyLevels(candles: Candle[], bull: boolean): { resistance: number[]; support: number[] } {
  if (candles.length < 26) return { resistance: [], support: [] }
  // Previous day — assuming 25 × 15min candles per session ≈ 6.25h → we use last-25 as proxy
  const prevDay = candles.slice(-50, -25)
  const prevHigh = Math.max(...prevDay.map(c => c.high))
  const prevLow  = Math.min(...prevDay.map(c => c.low))
  // Last 3 sessions swings
  const recent = candles.slice(-75)
  const swingHighs: number[] = []
  const swingLows: number[] = []
  for (let i = 2; i < recent.length - 2; i++) {
    const c = recent[i]
    if (c.high > recent[i - 1].high && c.high > recent[i - 2].high &&
        c.high > recent[i + 1].high && c.high > recent[i + 2].high) swingHighs.push(c.high)
    if (c.low < recent[i - 1].low && c.low < recent[i - 2].low &&
        c.low < recent[i + 1].low && c.low < recent[i + 2].low) swingLows.push(c.low)
  }
  const resistance = [prevHigh, ...swingHighs].sort((a, b) => b - a).slice(0, 4)
  const support    = [prevLow,  ...swingLows ].sort((a, b) => a - b).slice(0, 4)
  return { resistance, support }
}

export function intradayReversalSignals(ctx: StrategyContext): Signal[] {
  const { symbol, candles } = ctx
  if (candles.length < 40) return []

  const last  = candles[candles.length - 1]
  const prev  = candles[candles.length - 2]
  const vwap  = lastVWAP(candles)
  const rsi   = lastRSI(candles, 14) ?? 50
  const atr   = lastATR(candles, 14) ?? last.close * 0.015
  const a     = adx(candles, 14)
  const smc   = analyzeSMC(candles)
  const e9S   = ema(candles, 9); const e21S = ema(candles, 21)
  const e9    = e9S[e9S.length - 1]; const e21 = e21S[e21S.length - 1]
  const candlePatterns = detectCandlePatterns(candles)

  // Level proximity — price must be within 0.4% of a key level to count as "at the level"
  const levels = keyLevels(candles, true)
  const distTo = (p: number, level: number) => Math.abs((p - level) / p) * 100
  const nearResistance = levels.resistance.find(r => distTo(last.close, r) <= 0.4 && last.high >= r * 0.998)
  const nearSupport    = levels.support.find(s    => distTo(last.close, s) <= 0.4 && last.low  <= s * 1.002)

  // Volume fade check — current candle volume < 80% of prior 3-bar avg
  const vol3 = (candles[candles.length - 2].volume + candles[candles.length - 3].volume + candles[candles.length - 4].volume) / 3
  const volFading = last.volume < vol3 * 0.85

  const signals: Signal[] = []

  // ─── BEARISH REVERSAL (PE setup) ─────────────────────────────
  // Price touches resistance, rejects with bearish candle, RSI rolling over.
  if (nearResistance) {
    const bearishCandle =
      candlePatterns.some(p => p.direction === 'BEAR') ||
      (last.close < last.open && last.high > prev.high && (last.high - Math.max(last.close, last.open)) > atr * 0.4) // shooting star / wick rejection
    const rsiRolling = rsi > 60 && rsi < 78 && rsi < (lastRSI(candles.slice(0, -1), 14) ?? rsi)
    const belowVWAP = vwap != null && last.close < vwap
    const adxOk = !ctx.relaxed ? (a != null && a.adx >= 15) : true    // any trend strength

    if (bearishCandle && (rsiRolling || belowVWAP) && adxOk) {
      const conf: Confluence = {
        smc: smc.chochBear || smc.bosBear,
        trend: e21 != null && last.close < e21,
        vwap: belowVWAP,
        volume: volFading,
        rsi: rsiRolling,
        pattern: bearishCandle,
      }
      if (ctx.gannBias) conf.gann = ctx.gannBias.timeCycleHit || ctx.gannBias.priceAtGannLevel
      if (ctx.astroBias) conf.astro = ctx.astroBias.bearish
      if (ctx.flowDirection === 'BEAR') conf.flow = true

      const { score, count } = scoreConfluence(conf)
      const minCount = ctx.relaxed ? 2 : 3
      if (count >= minCount) {
        signals.push(...buildReversalSignals(symbol, 'SELL', last, atr, nearResistance, conf, score, count, gradeFromScore(score), candles, ctx))
      }
    }
  }

  // ─── BULLISH REVERSAL (CE setup) ─────────────────────────────
  if (nearSupport) {
    const bullishCandle =
      candlePatterns.some(p => p.direction === 'BULL') ||
      (last.close > last.open && last.low < prev.low && (Math.min(last.close, last.open) - last.low) > atr * 0.4) // hammer / lower-wick rejection
    const rsiTurning = rsi > 25 && rsi < 45 && rsi > (lastRSI(candles.slice(0, -1), 14) ?? rsi)
    const aboveVWAP = vwap != null && last.close > vwap
    const adxOk = !ctx.relaxed ? (a != null && a.adx >= 15) : true

    if (bullishCandle && (rsiTurning || aboveVWAP) && adxOk) {
      const conf: Confluence = {
        smc: smc.chochBull || smc.bosBull,
        trend: e21 != null && last.close > e21,
        vwap: aboveVWAP,
        volume: volFading,
        rsi: rsiTurning,
        pattern: bullishCandle,
      }
      if (ctx.gannBias) conf.gann = ctx.gannBias.timeCycleHit || ctx.gannBias.priceAtGannLevel
      if (ctx.astroBias) conf.astro = ctx.astroBias.bullish
      if (ctx.flowDirection === 'BULL') conf.flow = true

      const { score, count } = scoreConfluence(conf)
      const minCount = ctx.relaxed ? 2 : 3
      if (count >= minCount) {
        signals.push(...buildReversalSignals(symbol, 'BUY', last, atr, nearSupport, conf, score, count, gradeFromScore(score), candles, ctx))
      }
    }
  }

  return signals
}

/** Build paired OPTIONS + FUTURES signals for the reversal. */
function buildReversalSignals(
  symbol: string, direction: 'BUY' | 'SELL', last: Candle,
  atr: number, keyLevel: number, conf: Confluence, score: number, count: number, grade: any,
  candles: Candle[], ctx: StrategyContext,
): Signal[] {
  const bull = direction === 'BUY'
  const sign = bull ? 1 : -1
  const expiry = isIndex(symbol) ? nextThursday(new Date()) : nextThursday(new Date())

  // Futures-leg entry/SL/T1/T2 — tighter than the trend advisor (reversal moves are faster)
  const futEntry = +last.close.toFixed(2)
  const futStop  = bull
    ? +Math.min(futEntry - 1.0 * atr, keyLevel - 0.2 * atr).toFixed(2)
    : +Math.max(futEntry + 1.0 * atr, keyLevel + 0.2 * atr).toFixed(2)
  const futT1    = +(futEntry + sign * 1.5 * atr).toFixed(2)
  const futT2    = +(futEntry + sign * 3.0 * atr).toFixed(2)

  const reasons: string[] = [
    `${bull ? '🟢 BULLISH' : '🔴 BEARISH'} reversal at ${bull ? 'support' : 'resistance'} ₹${keyLevel.toFixed(2)}`,
    `RSI ${(lastRSI(candles, 14) ?? 50).toFixed(1)} · ATR ₹${atr.toFixed(2)} · ${conf.vwap ? 'VWAP confirms' : 'no VWAP confirm'}`,
    `Confluence ${count} factors: ${Object.entries(conf).filter(([, v]) => v).map(([k]) => k).join(', ')}`,
  ]
  if (conf.pattern) reasons.push('Candle pattern confirms rejection')
  if (conf.volume)  reasons.push('Volume fading on failed move — distribution')

  const futPlanType = (isIndex(symbol) ? 'FUTURES' : 'INTRADAY') as SignalType
  const futPlan = buildTradePlan({
    type: futPlanType,
    entry: futEntry, target2: futT2, direction,
    asOf: new Date(last.time).toISOString(),
    candles,
  })
  const futSignal: Signal = {
    id: `rev-fut-${symbol}-${Date.now()}`,
    instrument: isIndex(symbol) ? `${symbol} FUT (${expiry})` : symbol,
    direction,
    grade, score,
    entry: futEntry, stopLoss: futStop, target1: futT1, target2: futT2,
    target3: futPlan.target3,
    riskPct: riskPct(futEntry, futStop),
    rewardPct: rewardPct(futEntry, futT1),
    riskReward: riskReward(futEntry, futStop, futT1),
    type: (isIndex(symbol) ? 'FUTURES' : 'INTRADAY') as SignalType,
    reasons,
    gannNote: ctx.gannBias?.note ?? 'Gann neutral',
    astroNote: ctx.astroBias?.note ?? 'Astro neutral',
    oiNote: 'Intraday reversal — level rejection',
    pattern: `Reversal at ${bull ? 'support' : 'resistance'}`,
    expiresAt: expiry,
    timestamp: new Date().toISOString(),
    confluence: conf,
    confluenceCount: count,
    source: 'intraday-reversal',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: {
      ema9: ema(candles, 9)[ema(candles, 9).length - 1],
      ema21: ema(candles, 21)[ema(candles, 21).length - 1],
      atr, rsi: lastRSI(candles, 14) ?? 50,
      vwap: lastVWAP(candles) ?? undefined,
      timeframe: '15m',
    },
    tradePlan: futPlan,
  }

  // Options leg — OPPOSITE direction to underlying (bearish underlying → BUY PE)
  const strike = roundStrike(last.close, symbol)
  const side: 'CE' | 'PE' = bull ? 'CE' : 'PE'
  const optResolution = resolvePremium({
    spot: last.close, strike, side,
    daysToExpiry: daysUntil(expiry),
    chain: ctx.optionChain,
    ivFallback: ivFromAtr(atr, last.close),
  })
  const premium = optResolution.premium
  const premSL = +(premium * 0.7).toFixed(2)       // -30 %
  const premT1 = +(premium * 1.4).toFixed(2)       // +40 %
  const premT2 = +(premium * 1.8).toFixed(2)       // +80 %

  const optReasons: string[] = [
    `${symbol} ${strike} ${side} (ATM) — premium ₹${premium} (${optResolution.note})`,
    `Underlying reversal at ${bull ? 'support ₹' : 'resistance ₹'}${keyLevel.toFixed(2)}`,
    `Expect premium expansion +40 % if ${symbol} reaches ₹${futT1.toFixed(2)} (${(1.5 * atr / last.close * 100).toFixed(1)}% move)`,
    `Expect +80 % at ₹${futT2.toFixed(2)} — reversal target`,
  ]
  if (conf.pattern) optReasons.push('Candle rejection on prior bar confirms')

  const optPlan = buildTradePlan({
    type: 'OPTIONS' as SignalType,
    underlying: symbol, strike, side, expiry, premium,
    entry: premium, target2: premT2, direction: 'BUY',
    asOf: new Date(last.time).toISOString(),
    candles,
  })
  const optSignal: Signal = {
    id: `rev-opt-${symbol}-${strike}-${side}-${Date.now()}`,
    instrument: `${symbol} ${strike} ${side}`,
    direction: 'BUY',                                 // long the option
    grade, score,
    entry: premium, stopLoss: premSL, target1: premT1, target2: premT2,
    target3: optPlan.target3,
    riskPct: riskPct(premium, premSL),
    rewardPct: rewardPct(premium, premT1),
    riskReward: riskReward(premium, premSL, premT1),
    type: 'OPTIONS' as SignalType,
    reasons: optReasons,
    gannNote: ctx.gannBias?.note ?? 'Gann neutral',
    astroNote: ctx.astroBias?.note ?? 'Astro neutral',
    oiNote: 'ATM synthetic — intraday reversal scalp',
    pattern: `${bull ? 'Support' : 'Resistance'} rejection`,
    expiresAt: expiry,
    timestamp: new Date().toISOString(),
    confluence: conf,
    confluenceCount: count,
    source: 'intraday-reversal',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: futSignal.meta,
    tradePlan: optPlan,
  }

  return [futSignal, optSignal]
}
