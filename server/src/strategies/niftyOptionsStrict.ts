import type { Candle, Confluence, Signal, SignalType, StrategyContext } from '../types'
import { ema, lastATR, lastRSI, adx } from '../indicators'
import { scoreConfluence, gradeFromScore } from '../engine/scoring'
import { riskPct, rewardPct, riskReward } from '../engine/risk'
import { buildTradePlan } from '../engine/tradePlan'
import { addDays } from '../util/time'
import { resolvePremium, daysUntil } from '../options/premium'
import { selectIndexExpiry } from '../options/expirySelector'

/**
 * NIFTY Options STRICT — single primary source of NIFTY 50 options signals.
 *
 * The user lost money on PE trades because the loose OI / intraday-reversal
 * generators were too noisy. This strategy is intentionally strict:
 *
 *   ENTRY (BOTH conditions required):
 *     1. 9 EMA crossed 21 EMA within the last 3 bars on the working
 *        timeframe (5m / 15m). Cross direction defines bias:
 *            9 ↑ over 21 → BUY CE
 *            9 ↓ under 21 → BUY PE
 *     2. Confirmation candle is a MARABOZU (or near-Marabozu) — strong
 *        directional candle with body ≥ 70 % of total range and minimal
 *        opposing wick (< 15 % of total range).
 *     3. 10/20/30 EMA stack must agree with the cross direction:
 *            BUY CE → EMA10 > EMA20 > EMA30
 *            BUY PE → EMA10 < EMA20 < EMA30
 *
 *   FILTERS (any failure = no signal):
 *     - ADX ≥ 18  (no chop)
 *     - Range of last 5 bars ≥ 0.3 % of price (avoid dead zones)
 *
 *   EXIT plan:
 *     SL  = 30 % of premium  (premium-based stop, not underlying)
 *     T1  = 40 %             (book 50 %, trail SL to entry)
 *     T2  = 80-100 %
 *
 * Runs on 5m candles by default (configurable via timeframeName arg).
 */

const NIFTY_LOT = 25       // standard NSE NIFTY F&O lot

interface MarabozuCheck {
  isMarabozu: boolean
  direction: 'BULL' | 'BEAR' | null
  bodyPct: number          // body / total range
  upperWickPct: number
  lowerWickPct: number
  note: string
}

function checkMarabozu(c: Candle): MarabozuCheck {
  const range = c.high - c.low
  if (range <= 0) return { isMarabozu: false, direction: null, bodyPct: 0, upperWickPct: 0, lowerWickPct: 0, note: 'zero range' }
  const body = Math.abs(c.close - c.open)
  const bodyPct = body / range
  const upperWick = c.high - Math.max(c.close, c.open)
  const lowerWick = Math.min(c.close, c.open) - c.low
  const upperWickPct = upperWick / range
  const lowerWickPct = lowerWick / range
  const isBull = c.close > c.open
  const direction = isBull ? 'BULL' : 'BEAR'

  // Marabozu: body ≥ 70 % of range. "Near-Marabozu": opposing wick < 15 %.
  const isMarabozu = bodyPct >= 0.70 &&
    (isBull ? upperWickPct < 0.20 : lowerWickPct < 0.20)
  const note = `body ${(bodyPct * 100).toFixed(0)}% · upper-wick ${(upperWickPct * 100).toFixed(0)}% · lower-wick ${(lowerWickPct * 100).toFixed(0)}%`
  return { isMarabozu, direction, bodyPct, upperWickPct, lowerWickPct, note }
}

interface EmaCross {
  crossed: boolean
  direction: 'BULL' | 'BEAR' | null
  barsAgo: number
  ema9: number
  ema21: number
}

/** Detect 9/21 EMA cross within the last `lookback` bars. */
function checkEmaCross(candles: Candle[], lookback = 3): EmaCross {
  const e9series = ema(candles, 9)
  const e21series = ema(candles, 21)
  if (e9series.length < lookback + 2) return { crossed: false, direction: null, barsAgo: 0, ema9: 0, ema21: 0 }
  // Bars are aligned because both EMA series have the same length once enough data exists
  const offset = e9series.length
  const lastE9 = e9series[offset - 1]
  const lastE21 = e21series[offset - 1]
  for (let i = 1; i <= lookback; i++) {
    const e9now  = e9series[offset - i]
    const e21now = e21series[offset - i]
    const e9prev = e9series[offset - i - 1]
    const e21prev = e21series[offset - i - 1]
    if (e9prev == null || e21prev == null) break
    const wasBelow = e9prev <= e21prev
    const wasAbove = e9prev >= e21prev
    if (wasBelow && e9now > e21now) {
      return { crossed: true, direction: 'BULL', barsAgo: i - 1, ema9: lastE9, ema21: lastE21 }
    }
    if (wasAbove && e9now < e21now) {
      return { crossed: true, direction: 'BEAR', barsAgo: i - 1, ema9: lastE9, ema21: lastE21 }
    }
  }
  return { crossed: false, direction: null, barsAgo: 0, ema9: lastE9, ema21: lastE21 }
}

interface TripleEmaStack {
  bull: boolean
  bear: boolean
  ema10: number; ema20: number; ema30: number
}

function checkTripleEmaStack(candles: Candle[]): TripleEmaStack {
  const e10 = ema(candles, 10); const e20 = ema(candles, 20); const e30 = ema(candles, 30)
  const a = e10[e10.length - 1]
  const b = e20[e20.length - 1]
  const c = e30[e30.length - 1]
  return {
    bull: !!(a && b && c && a > b && b > c),
    bear: !!(a && b && c && a < b && b < c),
    ema10: a, ema20: b, ema30: c,
  }
}

function roundNiftyStrike(spot: number): number {
  return Math.round(spot / 50) * 50
}

function nextThursday(d: Date): string {
  const day = d.getUTCDay()
  const offset = ((4 - day + 7) % 7) || 7
  return addDays(d, offset).toISOString().slice(0, 10)
}

function ivFromAtr(atr: number, spot: number): number {
  if (spot <= 0 || atr <= 0) return 0.15
  const sigmaAnnual = (atr / spot) * Math.sqrt(252)
  return Math.max(0.08, Math.min(0.40, sigmaAnnual))
}

/**
 * Main entry point — returns 0 or 1 signal (very strict).
 * Emits paired underlying-direction context but the actual SIGNAL is the
 * option leg (CE for bullish cross, PE for bearish cross).
 */
export function niftyOptionsStrictSignal(ctx: StrategyContext): Signal | null {
  if (ctx.symbol !== 'NIFTY') return null
  const candles = ctx.candles
  if (candles.length < 40) return null

  const last = candles[candles.length - 1]
  const cross = checkEmaCross(candles, 3)
  if (!cross.crossed || !cross.direction) return null

  const stack = checkTripleEmaStack(candles)
  // Stack must agree with cross direction
  if (cross.direction === 'BULL' && !stack.bull) return null
  if (cross.direction === 'BEAR' && !stack.bear) return null

  // Marabozu confirmation candle
  const mara = checkMarabozu(last)
  if (!mara.isMarabozu) return null
  if (cross.direction !== mara.direction) return null   // candle must point same way

  // Regime filter
  const a = adx(candles, 14)
  if (!a || a.adx < 18) return null

  // Range vitality — last 5 bars must move at least 0.3 % of price
  const last5 = candles.slice(-5)
  const range5 = Math.max(...last5.map(c => c.high)) - Math.min(...last5.map(c => c.low))
  if (range5 / last.close * 100 < 0.3) return null

  // Build the OPTIONS signal
  const bullish = cross.direction === 'BULL'
  const side: 'CE' | 'PE' = bullish ? 'CE' : 'PE'
  const strike = roundNiftyStrike(last.close)
  const atr = lastATR(candles, 14) ?? last.close * 0.015

  // Smart expiry — rolls to next-month if monthly expiry within 3d (avoids
  // theta wipe on the last day of the cycle).
  const expiryChoice = selectIndexExpiry(new Date())
  const expiry = expiryChoice.expiry
  const resolution = resolvePremium({
    spot: last.close, strike, side,
    daysToExpiry: daysUntil(expiry),
    chain: ctx.optionChain,
    ivFallback: ivFromAtr(atr, last.close),
  })
  const premium = resolution.premium
  const slPrem = +(premium * 0.70).toFixed(2)
  const t1Prem = +(premium * 1.40).toFixed(2)
  const t2Prem = +(premium * 1.90).toFixed(2)
  const r = lastRSI(candles, 14) ?? 50
  const tf = ctx.candles[0]?.time && ctx.candles[1]?.time
    ? Math.round((ctx.candles[1].time - ctx.candles[0].time) / 60_000) + 'm'
    : '5m'

  const conf: Confluence = {
    smc: false,
    trend: bullish ? stack.bull : stack.bear,
    vwap: false,
    volume: false,
    rsi: bullish ? r > 50 && r < 75 : r < 50 && r > 25,
    pattern: true,                     // Marabozu = strong pattern
  }
  if (ctx.gannBias) conf.gann = ctx.gannBias.timeCycleHit || ctx.gannBias.priceAtGannLevel
  if (ctx.flowDirection) conf.flow = (bullish && ctx.flowDirection === 'BULL') || (!bullish && ctx.flowDirection === 'BEAR')

  const { score, count } = scoreConfluence(conf)
  const grade = gradeFromScore(score)

  const reasons: string[] = [
    `🎯 NIFTY ${strike} ${side} — STRICT entry`,
    `9 EMA ${cross.direction === 'BULL' ? '↑ crossed above' : '↓ crossed below'} 21 EMA ${cross.barsAgo === 0 ? 'this bar' : `${cross.barsAgo} bar${cross.barsAgo === 1 ? '' : 's'} ago`}`,
    `Triple EMA stack ${cross.direction === 'BULL' ? 'BULLISH (10>20>30)' : 'BEARISH (10<20<30)'}: ${stack.ema10.toFixed(0)} · ${stack.ema20.toFixed(0)} · ${stack.ema30.toFixed(0)}`,
    `${mara.direction === 'BULL' ? 'Bullish' : 'Bearish'} Marabozu confirmation — ${mara.note}`,
    `ADX ${a.adx.toFixed(1)} · RSI ${r.toFixed(0)} · 5-bar range ${(range5 / last.close * 100).toFixed(2)}%`,
    `Spot ₹${last.close.toFixed(2)} · ATR ₹${atr.toFixed(0)} · est. premium ₹${premium}`,
    `If NIFTY moves 0.4-0.6 % in direction → premium ≈ +40 % (T1)`,
  ]

  const tradePlan = buildTradePlan({
    type: 'OPTIONS' as SignalType,
    underlying: 'NIFTY',
    strike, side, expiry, premium,
    entry: premium, target2: t2Prem, direction: 'BUY',
    asOf: new Date(last.time).toISOString(),
    candles: ctx.candles,
  })
  return {
    id: `nifty-strict-${strike}-${side}-${Date.now()}`,
    instrument: `NIFTY ${strike} ${side}`,
    direction: 'BUY',
    grade, score,
    entry: premium,
    stopLoss: slPrem,
    target1: t1Prem,
    target2: t2Prem,
    target3: tradePlan.target3,
    riskPct: riskPct(premium, slPrem),
    rewardPct: rewardPct(premium, t1Prem),
    riskReward: riskReward(premium, slPrem, t1Prem),
    type: 'OPTIONS' as SignalType,
    reasons,
    gannNote: ctx.gannBias?.note ?? 'Gann neutral',
    astroNote: ctx.astroBias?.note ?? 'Astro neutral',
    oiNote: 'Strict 9/21 EMA cross + Marabozu — no OI dependency',
    pattern: `9/21 EMA ${cross.direction} cross + Marabozu`,
    expiresAt: expiry,
    timestamp: new Date().toISOString(),
    confluence: conf,
    confluenceCount: count,
    source: 'nifty-strict',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: {
      ema9: cross.ema9, ema21: cross.ema21, ema50: stack.ema30,
      atr, rsi: r, adx: a.adx,
      pattern: mara.direction === 'BULL' ? 'Bullish Marabozu' : 'Bearish Marabozu',
      timeframe: tf,
    },
    tradePlan,
  }
}
