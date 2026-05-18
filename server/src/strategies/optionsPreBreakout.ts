/**
 * Options PRE-BREAKOUT signal — catches CE/PE BEFORE the strict engine fires.
 *
 * Background (2026-05-14 user incident): At 10:25 AM IST Nifty was at 23430.
 * The strict engine (niftyOptionsStrict) requires EMA 9/21 cross + triple EMA
 * stack + marubozu + ADX≥20 + volume burst — ALL six confluences. By the time
 * all 6 align, the move is already 1-2% in. Nifty ran +347 points to 23777
 * BEFORE the strict CE buy fired. Mathematically guaranteed to be LATE.
 *
 * This screener detects the SETUP BEFORE the break: tight coiled range +
 * volume dry-up + near key level + institutional time window + RSI 40-60 +
 * ADX < 22. When subsequent bar breaks the range high (or low), fires CE
 * (or PE) 10-30 minutes earlier than the strict engine.
 *
 * Signal tier: WATCH if 4 of 5 setup conditions are met without confirmed
 * break · LIVE if break is confirmed by a 15m close beyond the range.
 *
 * Free-tier discipline: zero new deps, reuses existing indicator helpers.
 */
import type { Candle, Signal, SignalType, StrategyContext } from '../types'
import { ema, lastATR, lastRSI, adx } from '../indicators'
import { selectIndexExpiry } from '../options/expirySelector'
import { resolvePremium, daysUntil } from '../options/premium'

// ── Setup conditions ───────────────────────────────────────────
interface SetupCheck {
  coiled: boolean              // last 8 bars range < 0.4% of price
  volDryUp: boolean            // last 8 vol < 80% of 60-bar avg
  nearKeyLevel: boolean        // within 0.3% of prior day H/L, daily pivot, or 20-EMA
  goodTimeWindow: boolean      // 9:30-11:00 OR 13:00-14:30 IST
  rsiCoiled: boolean           // 40 <= RSI <= 60
  adxLow: boolean              // ADX < 22 (consolidation)
}

function checkSetup(candles: Candle[], now: Date): SetupCheck {
  const last = candles[candles.length - 1]
  const last8 = candles.slice(-8)
  const last60 = candles.slice(-61, -1)
  // Coiled range
  const rangeHi = Math.max(...last8.map(c => c.high))
  const rangeLo = Math.min(...last8.map(c => c.low))
  const rangePct = ((rangeHi - rangeLo) / last.close) * 100
  const coiled = rangePct < 0.4
  // Volume dry-up
  const v8 = last8.reduce((s, c) => s + c.volume, 0) / 8
  const v60 = last60.length ? last60.reduce((s, c) => s + c.volume, 0) / last60.length : 0
  const volDryUp = v60 === 0 || v8 < v60 * 0.8
  // Near key level: prior day H/L, daily pivot, 20-EMA
  const prevDayHigh = Math.max(...candles.slice(-30, -8).map(c => c.high))
  const prevDayLow = Math.min(...candles.slice(-30, -8).map(c => c.low))
  const pivot = (prevDayHigh + prevDayLow + last.close) / 3
  const e20 = ema(candles, 20)
  const ema20Last = e20[e20.length - 1]
  const tol = last.close * 0.003          // 0.3%
  const nearKeyLevel = (
    Math.abs(last.close - prevDayHigh) < tol ||
    Math.abs(last.close - prevDayLow) < tol ||
    Math.abs(last.close - pivot) < tol ||
    Math.abs(last.close - ema20Last) < tol
  )
  // Time-of-day (IST). now is server time; convert to IST.
  const istMs = now.getTime() + 5.5 * 3600_000
  const istMin = new Date(istMs).getUTCHours() * 60 + new Date(istMs).getUTCMinutes()
  // 9:30-11:00 = 570-660 · 13:00-14:30 = 780-870
  const goodTimeWindow = (istMin >= 570 && istMin <= 660) || (istMin >= 780 && istMin <= 870)
  // RSI coiled
  const r = lastRSI(candles, 14) ?? 50
  const rsiCoiled = r >= 40 && r <= 60
  // ADX low
  const a = adx(candles, 14)
  const adxLow = !a || a.adx < 22
  return { coiled, volDryUp, nearKeyLevel, goodTimeWindow, rsiCoiled, adxLow }
}

function countMet(s: SetupCheck): number {
  return [s.coiled, s.volDryUp, s.nearKeyLevel, s.goodTimeWindow, s.rsiCoiled, s.adxLow]
    .filter(Boolean).length
}

/**
 * Detect a NIFTY/FINNIFTY pre-breakout. Returns:
 *   - LIVE signal if 5+ setup conditions met AND last bar broke range
 *   - WATCH signal if 4+ conditions met (anticipation, no break yet)
 *   - null otherwise
 *
 * BANKNIFTY is excluded per user standing directive.
 */
export function optionsPreBreakoutSignal(ctx: StrategyContext): Signal | null {
  const { symbol, candles } = ctx
  if (symbol !== 'NIFTY' && symbol !== 'FINNIFTY') return null
  if (candles.length < 60) return null
  const last = candles[candles.length - 1]
  const now = new Date()
  const setup = checkSetup(candles, now)
  const met = countMet(setup)
  if (met < 4) return null                  // not enough confluence yet

  // Range high/low from last 8 bars (excluding current bar to detect break)
  const last8 = candles.slice(-9, -1)
  const rangeHi = Math.max(...last8.map(c => c.high))
  const rangeLo = Math.min(...last8.map(c => c.low))

  // Direction: did the current bar break the range?
  let direction: 'BULL' | 'BEAR' | null = null
  let confirmed = false
  if (last.close > rangeHi) { direction = 'BULL'; confirmed = true }
  else if (last.close < rangeLo) { direction = 'BEAR'; confirmed = true }
  else {
    // No confirmed break yet — anticipate direction by close-to-mid bias
    const mid = (rangeHi + rangeLo) / 2
    const r = lastRSI(candles, 14) ?? 50
    if (last.close > mid && r > 50) direction = 'BULL'
    else if (last.close < mid && r < 50) direction = 'BEAR'
    else return null                        // no clear bias yet
  }
  // WATCH if only 4 met OR break not confirmed; LIVE if 5+ AND confirmed
  const isLive = met >= 5 && confirmed
  const tier: 'LIVE' | 'WATCH' = isLive ? 'LIVE' : 'WATCH'

  // Strike + expiry
  const strikeRound = symbol === 'NIFTY' ? 50 : 50
  const strike = Math.round(last.close / strikeRound) * strikeRound
  const side: 'CE' | 'PE' = direction === 'BULL' ? 'CE' : 'PE'
  const expiryChoice = selectIndexExpiry(now)
  const dte = daysUntil(expiryChoice.expiry)
  const premRes = resolvePremium({ spot: last.close, strike, side, daysToExpiry: dte })
  const premium = +(premRes?.premium ?? Math.max(1, last.close * 0.012)).toFixed(2)

  // Premium-based SL / targets (option scaling)
  const slPrem = +(premium * 0.75).toFixed(2)    // 25% premium SL
  const t1Prem = +(premium * 1.35).toFixed(2)    // +35%
  const t2Prem = +(premium * 1.70).toFixed(2)    // +70%
  const t3Prem = +(premium * 2.20).toFixed(2)    // +120%

  const reasonsArr: string[] = []
  if (setup.coiled) reasonsArr.push('Coiled range < 0.4%')
  if (setup.volDryUp) reasonsArr.push('Volume dry-up vs 60-bar avg')
  if (setup.nearKeyLevel) reasonsArr.push('At key level (prev H/L / pivot / 20-EMA)')
  if (setup.goodTimeWindow) reasonsArr.push('Institutional entry window')
  if (setup.rsiCoiled) reasonsArr.push('RSI 40-60 (coiled, not extended)')
  if (setup.adxLow) reasonsArr.push('ADX < 22 (consolidation)')
  if (confirmed) reasonsArr.push(`${direction === 'BULL' ? 'Break UP' : 'Break DOWN'} confirmed`)
  else reasonsArr.push('Anticipating break (WATCH)')

  const atrVal = lastATR(candles, 14) ?? last.close * 0.005
  const score = 7 + Math.min(2.5, met * 0.4)
  const grade: 'A' | 'B' | 'C' = met >= 5 ? 'A' : met >= 4 ? 'B' : 'C'

  return {
    id: `${symbol.toLowerCase()}-prebreak-${strike}-${side}-${Date.now()}`,
    instrument: `${symbol} ${strike} ${side}`,
    direction: 'BUY',
    grade,
    score: +score.toFixed(1),
    entry: premium,
    stopLoss: slPrem,
    target1: t1Prem,
    target2: t2Prem,
    target3: t3Prem,
    riskPct: ((premium - slPrem) / premium) * 100,
    rewardPct: ((t1Prem - premium) / premium) * 100,
    riskReward: +(((t1Prem - premium) / (premium - slPrem))).toFixed(2),
    type: 'OPTIONS' as SignalType,
    reasons: reasonsArr,
    gannNote: ctx.gannBias?.note ?? '',
    astroNote: ctx.astroBias?.note ?? '',
    oiNote: 'Pre-breakout: catches setup BEFORE EMA-cross + marubozu confluence',
    pattern: `Pre-Breakout ${direction} (${met}/6 setup, ${confirmed ? 'confirmed' : 'anticipated'})`,
    expiresAt: expiryChoice.expiry,
    timestamp: new Date().toISOString(),
    confluence: {
      smc: false, trend: false, vwap: setup.nearKeyLevel,
      volume: setup.volDryUp, rsi: setup.rsiCoiled, pattern: confirmed,
    },
    confluenceCount: met,
    source: 'options-prebreakout',
    tier,
    asOf: new Date(last.time).toISOString(),
    meta: {
      rangeHi, rangeLo, atr: atrVal,
      rsi: lastRSI(candles, 14) ?? 50,
      adx: adx(candles, 14)?.adx ?? 0,
      setupCount: met,
      confirmed,
      timeframe: '15m',
    },
  } as Signal
}
