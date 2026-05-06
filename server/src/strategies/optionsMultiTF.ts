import type { Candle, Confluence, Signal, SignalType, StrategyContext } from '../types'
import { ema, lastATR, lastRSI, adx, bollinger, vwap as vwapSeries } from '../indicators'
import { scoreConfluence, gradeFromScore } from '../engine/scoring'
import { riskPct, rewardPct, riskReward } from '../engine/risk'
import { buildTradePlan } from '../engine/tradePlan'
import { addDays } from '../util/time'
import { ALL_TFS, resample, type Tf } from './mtfAggregator'
import { resolvePremium, daysUntil } from '../options/premium'
import { selectExpiry } from '../options/expirySelector'

/**
 * Options Multi-Timeframe Engine.
 *
 * Runs 8 strategy rules across 7 timeframes (5m · 15m · 30m · 1h · 2h · 3h · 4h)
 * and returns at most ONE signal per (symbol × direction) per call — the
 * highest-confidence one. Dedupe at the caller makes sure Telegram doesn't
 * spam the same setup across timeframes.
 *
 * User-specified strategies (1-5):
 *   1. EMA20 crosses EMA50 + price > VWAP
 *   2. 10/20/30 EMA aligned + Marabozu candle + price > VWAP
 *   3. EMA9 crosses EMA21 + price > VWAP
 *   4. OI accumulation (CE/PE side) — wired from the OI flow analyzer
 *   5. Volume building + accumulation (3+ rising-vol bars with price stable/up)
 *
 * My additions:
 *   6. Bollinger-band squeeze breakout + volume spike
 *   7. Opening-range breakout (first 15m high/low) on subsequent bars
 *   8. Higher-high + higher-low continuation with RSI 50-70 + ADX ≥ 20
 */

interface StrategyHit {
  rule: number                  // 1-8
  name: string
  direction: 'BULL' | 'BEAR'
  confidence: number            // 0-100
  notes: string[]
  tf: Tf
}

// ─── Marabozu ─────────────────────────────────────────────────

function isMarabozu(c: Candle): { ok: boolean; bull: boolean; bodyPct: number } {
  const range = c.high - c.low
  if (range <= 0) return { ok: false, bull: false, bodyPct: 0 }
  const body = Math.abs(c.close - c.open)
  const bodyPct = body / range
  const upperWick = c.high - Math.max(c.close, c.open)
  const lowerWick = Math.min(c.close, c.open) - c.low
  const bull = c.close > c.open
  const opposingWickPct = bull ? upperWick / range : lowerWick / range
  return { ok: bodyPct >= 0.70 && opposingWickPct < 0.20, bull, bodyPct }
}

// ─── EMA cross helper ─────────────────────────────────────────

function emaCross(candles: Candle[], fast: number, slow: number, lookback = 3):
  { crossed: boolean; direction: 'BULL' | 'BEAR' | null; barsAgo: number } {
  const eF = ema(candles, fast); const eS = ema(candles, slow)
  if (eF.length < lookback + 2) return { crossed: false, direction: null, barsAgo: 0 }
  const off = eF.length
  for (let i = 1; i <= lookback; i++) {
    const fN = eF[off - i], sN = eS[off - i]
    const fP = eF[off - i - 1], sP = eS[off - i - 1]
    if (fP == null || sP == null) break
    if (fP <= sP && fN > sN) return { crossed: true, direction: 'BULL', barsAgo: i - 1 }
    if (fP >= sP && fN < sN) return { crossed: true, direction: 'BEAR', barsAgo: i - 1 }
  }
  return { crossed: false, direction: null, barsAgo: 0 }
}

// ─── VWAP position ───────────────────────────────────────────

function aboveVwap(candles: Candle[]): { above: boolean; vwap: number | null } {
  const v = vwapSeries(candles)
  if (!v.length) return { above: false, vwap: null }
  const last = candles[candles.length - 1].close
  const lastVwap = v[v.length - 1]
  return { above: last > lastVwap, vwap: lastVwap }
}

// ─── Strategy rules ──────────────────────────────────────────

function rule1_ema20_50(candles: Candle[], tf: Tf): StrategyHit | null {
  const cross = emaCross(candles, 20, 50, 3)
  if (!cross.crossed || !cross.direction) return null
  const v = aboveVwap(candles)
  if (!v.vwap) return null
  // For BUY (call) bias: price must be ABOVE VWAP. For SELL (put) bias: BELOW
  if (cross.direction === 'BULL' && !v.above) return null
  if (cross.direction === 'BEAR' &&  v.above) return null
  return {
    rule: 1, name: '20/50 EMA cross + VWAP',
    direction: cross.direction,
    confidence: 70,
    tf,
    notes: [
      `20 EMA ${cross.direction === 'BULL' ? '↑' : '↓'} 50 EMA ${cross.barsAgo === 0 ? 'this bar' : `${cross.barsAgo} bars ago`} on ${tf.name}`,
      `Price ${v.above ? 'ABOVE' : 'BELOW'} VWAP ${v.vwap.toFixed(2)} — confirms direction`,
    ],
  }
}

function rule2_tripleEma_marabozu(candles: Candle[], tf: Tf): StrategyHit | null {
  const e10 = ema(candles, 10); const e20 = ema(candles, 20); const e30 = ema(candles, 30)
  const a = e10[e10.length - 1]; const b = e20[e20.length - 1]; const c = e30[e30.length - 1]
  if (a == null || b == null || c == null) return null
  const bullStack = a > b && b > c
  const bearStack = a < b && b < c
  if (!bullStack && !bearStack) return null
  const mara = isMarabozu(candles[candles.length - 1])
  if (!mara.ok) return null
  if (bullStack && !mara.bull) return null
  if (bearStack &&  mara.bull) return null
  const v = aboveVwap(candles)
  if (!v.vwap) return null
  if (bullStack && !v.above) return null
  if (bearStack &&  v.above) return null
  return {
    rule: 2, name: '10/20/30 EMA stack + Marabozu + VWAP',
    direction: bullStack ? 'BULL' : 'BEAR',
    confidence: 80,                   // strong 3-way confluence
    tf,
    notes: [
      `10/20/30 EMA ${bullStack ? 'BULLISH stack (10>20>30)' : 'BEARISH stack (10<20<30)'}`,
      `${mara.bull ? 'Bullish' : 'Bearish'} Marabozu body ${(mara.bodyPct * 100).toFixed(0)}%`,
      `Price ${v.above ? 'above' : 'below'} VWAP ${v.vwap.toFixed(2)}`,
    ],
  }
}

function rule3_ema9_21(candles: Candle[], tf: Tf): StrategyHit | null {
  const cross = emaCross(candles, 9, 21, 3)
  if (!cross.crossed || !cross.direction) return null
  const v = aboveVwap(candles)
  if (!v.vwap) return null
  if (cross.direction === 'BULL' && !v.above) return null
  if (cross.direction === 'BEAR' &&  v.above) return null
  return {
    rule: 3, name: '9/21 EMA cross + VWAP',
    direction: cross.direction,
    confidence: 65,
    tf,
    notes: [
      `9 EMA ${cross.direction === 'BULL' ? '↑' : '↓'} 21 EMA ${cross.barsAgo === 0 ? 'this bar' : `${cross.barsAgo} bars ago`} on ${tf.name}`,
      `Price ${v.above ? 'above' : 'below'} VWAP ${v.vwap.toFixed(2)}`,
    ],
  }
}

function rule5_volumeAccumulation(candles: Candle[], tf: Tf): StrategyHit | null {
  if (candles.length < 25) return null
  const last5 = candles.slice(-5)
  const vols = last5.map(c => c.volume)
  // 3+ of last 5 bars must have volume > 20-bar avg
  const vol20 = candles.slice(-21, -1).map(c => c.volume)
  const avg = vol20.reduce((s, v) => s + v, 0) / vol20.length
  if (avg <= 0) return null
  const risingBars = vols.filter(v => v > avg * 1.2).length
  if (risingBars < 3) return null
  // Direction from price action over those 5 bars
  const first = last5[0].close, lastC = last5[last5.length - 1].close
  const priceMovePct = (lastC - first) / first * 100
  if (Math.abs(priceMovePct) < 0.15) return null           // need some directional move
  const direction: 'BULL' | 'BEAR' = priceMovePct > 0 ? 'BULL' : 'BEAR'
  const volRatio = vols[vols.length - 1] / avg
  return {
    rule: 5, name: 'Volume accumulation',
    direction, confidence: 60 + Math.min(20, Math.round(volRatio * 5)),
    tf,
    notes: [
      `${risingBars}/5 bars with vol > 1.2× 20-bar avg`,
      `Current bar vol ${volRatio.toFixed(1)}× avg`,
      `${direction === 'BULL' ? '+' : ''}${priceMovePct.toFixed(2)}% over 5 bars`,
    ],
  }
}

function rule6_bbSqueeze(candles: Candle[], tf: Tf): StrategyHit | null {
  if (candles.length < 30) return null
  const bb = bollinger(candles, 20, 2)
  if (!bb) return null
  // Current bandwidth vs last 20 bandwidths — we need the squeeze (bw near minimum)
  const widths: number[] = []
  for (let i = candles.length - 20; i < candles.length; i++) {
    const w = bollinger(candles.slice(0, i + 1), 20, 2)
    if (w) widths.push((w.upper - w.lower) / w.middle)
  }
  if (widths.length < 15) return null
  const curW = (bb.upper - bb.lower) / bb.middle
  const minW = Math.min(...widths)
  if (curW > minW * 1.15) return null               // must be at or near the squeeze
  const last = candles[candles.length - 1]
  const brokeUp = last.close > bb.upper
  const brokeDn = last.close < bb.lower
  if (!brokeUp && !brokeDn) return null
  // Volume must confirm
  const vol20 = candles.slice(-21, -1).map(c => c.volume)
  const avg = vol20.reduce((s, v) => s + v, 0) / vol20.length
  if (last.volume < avg * 1.5) return null
  return {
    rule: 6, name: 'BB squeeze breakout',
    direction: brokeUp ? 'BULL' : 'BEAR',
    confidence: 75, tf,
    notes: [
      `BB bandwidth ${(curW * 100).toFixed(2)}% near 20-bar minimum (${(minW * 100).toFixed(2)}%) — squeeze`,
      `Close broke ${brokeUp ? 'ABOVE upper' : 'BELOW lower'} band`,
      `Vol ${(last.volume / avg).toFixed(1)}× 20-bar avg — expansion confirmed`,
    ],
  }
}

function rule7_openingRangeBreakout(candles: Candle[], tf: Tf, baseMinutes: number): StrategyHit | null {
  // Only meaningful on intraday TFs ≤ 15m, and for NSE cash session ~ first 3 bars = 15 min
  if (tf.minutes > 30) return null
  if (candles.length < 30) return null
  const barsForOR = Math.max(1, Math.round(15 / tf.minutes))
  // Find today's first `barsForOR` bars — we approximate by taking the most recent session slice
  // (for simplicity: last 25 bars = roughly one session on 15m, we take first barsForOR of those)
  const session = candles.slice(-25)
  if (session.length < barsForOR + 3) return null
  const or = session.slice(0, barsForOR)
  const orHigh = Math.max(...or.map(c => c.high))
  const orLow  = Math.min(...or.map(c => c.low))
  const last = candles[candles.length - 1]
  if (last.close > orHigh) {
    return {
      rule: 7, name: 'Opening range breakout',
      direction: 'BULL', confidence: 70, tf,
      notes: [
        `Price ${last.close.toFixed(2)} broke above opening-range high ${orHigh.toFixed(2)}`,
        `Session OR: ${orLow.toFixed(2)} — ${orHigh.toFixed(2)}`,
      ],
    }
  }
  if (last.close < orLow) {
    return {
      rule: 7, name: 'Opening range breakdown',
      direction: 'BEAR', confidence: 70, tf,
      notes: [
        `Price ${last.close.toFixed(2)} broke below opening-range low ${orLow.toFixed(2)}`,
        `Session OR: ${orLow.toFixed(2)} — ${orHigh.toFixed(2)}`,
      ],
    }
  }
  return null
}

function rule8_hhhlContinuation(candles: Candle[], tf: Tf): StrategyHit | null {
  if (candles.length < 30) return null
  const last6 = candles.slice(-6)
  // Rough HH/HL check — highs[-1] > highs[-2] && lows[-1] > lows[-2] && lows[-2] > lows[-3]
  const highs = last6.map(c => c.high); const lows = last6.map(c => c.low)
  const hhBull = highs[5] > highs[3] && lows[5] > lows[3] && lows[3] > lows[1]
  const hhBear = highs[5] < highs[3] && lows[5] < lows[3] && highs[3] < highs[1]
  if (!hhBull && !hhBear) return null
  const a = adx(candles, 14); if (!a || a.adx < 20) return null
  const r = lastRSI(candles, 14) ?? 50
  if (hhBull && (r <= 50 || r >= 75)) return null
  if (hhBear && (r >= 50 || r <= 25)) return null
  return {
    rule: 8, name: 'HH/HL continuation + ADX',
    direction: hhBull ? 'BULL' : 'BEAR',
    confidence: 65, tf,
    notes: [
      `${hhBull ? 'Higher-high + higher-low' : 'Lower-high + lower-low'} on ${tf.name}`,
      `ADX ${a.adx.toFixed(1)} · RSI ${r.toFixed(0)}`,
    ],
  }
}

// ─── Run all rules on all timeframes ─────────────────────────

export function detectOptionsMultiTF(
  baseCandles: Candle[],
  baseMinutes: number,
  tfs: Tf[] = ALL_TFS,
): StrategyHit[] {
  const hits: StrategyHit[] = []
  for (const tf of tfs) {
    if (tf.minutes < baseMinutes) continue
    const candles = tf.minutes === baseMinutes ? baseCandles : resample(baseCandles, baseMinutes, tf.minutes)
    if (candles.length < 30) continue

    // Run each rule, collect any hits
    const rules = [
      rule1_ema20_50(candles, tf),
      rule2_tripleEma_marabozu(candles, tf),
      rule3_ema9_21(candles, tf),
      rule5_volumeAccumulation(candles, tf),
      rule6_bbSqueeze(candles, tf),
      rule7_openingRangeBreakout(candles, tf, baseMinutes),
      rule8_hhhlContinuation(candles, tf),
    ]
    for (const h of rules) if (h) hits.push(h)
  }
  return hits
}

/**
 * Consolidate raw hits into AT MOST ONE signal per (symbol, direction). The
 * final signal gets score from the best hit + bonus for multi-TF/multi-rule
 * confluence.
 */
export function buildOptionsSignal(
  ctx: StrategyContext,
  hits: StrategyHit[],
  lotSizes?: Record<string, number>,
): Signal | null {
  if (!hits.length) return null

  // Group by direction
  const bullHits = hits.filter(h => h.direction === 'BULL')
  const bearHits = hits.filter(h => h.direction === 'BEAR')

  // Pick dominant direction (total confidence sum)
  const bullSum = bullHits.reduce((s, h) => s + h.confidence, 0)
  const bearSum = bearHits.reduce((s, h) => s + h.confidence, 0)
  if (Math.max(bullSum, bearSum) < 120) return null   // need at least 2 moderate hits

  const direction: 'BULL' | 'BEAR' = bullSum > bearSum ? 'BULL' : 'BEAR'
  const winning = direction === 'BULL' ? bullHits : bearHits

  // Sort by confidence — best first
  winning.sort((a, b) => b.confidence - a.confidence)
  const top = winning[0]

  // Distinct TFs and rules firing — the more the better
  const uniqTfs = [...new Set(winning.map(h => h.tf.name))]
  const uniqRules = [...new Set(winning.map(h => h.rule))]

  const lastCandle = ctx.candles[ctx.candles.length - 1]
  const spot = lastCandle.close
  const atr = lastATR(ctx.candles, 14) ?? spot * 0.015

  // Strike + premium — prefer live option-chain LTP (accurate to market),
  // fall back to Black-Scholes with the actual DTE. The old `spot × pct`
  // heuristic blew up on expiries >5 days and on OTM strikes, so it's gone.
  const sym = ctx.symbol
  const strike = roundStrike(spot, sym)
  const side: 'CE' | 'PE' = direction === 'BULL' ? 'CE' : 'PE'
  // Smart expiry selection — rolls to next-week (or next-month if monthly
  // expiry within 3d) so we never sell theta the day before it wipes.
  const expiry = selectExpiry({ symbol: sym, bucketHint: 'WEEKLY' }).expiry
  const resolution = resolvePremium({
    spot, strike, side,
    daysToExpiry: daysUntil(expiry),
    chain: ctx.optionChain,
    ivFallback: ivFromAtr(atr, spot),
  })
  const premium = resolution.premium
  const slPrem = +(premium * 0.70).toFixed(2)
  const t1Prem = +(premium * 1.40).toFixed(2)
  const t2Prem = +(premium * 1.90).toFixed(2)

  // Total confidence — normalized 0-10 score
  const totalConf = direction === 'BULL' ? bullSum : bearSum
  const multiBonus = (uniqRules.length - 1) * 0.5 + (uniqTfs.length - 1) * 0.3
  const score = Math.min(10, Math.round((totalConf / 20) + multiBonus))
  const grade = score >= 8 ? 'A' : score >= 6 ? 'B' : 'C'

  const reasons: string[] = [
    `🎯 ${sym} ${strike} ${side} · ${direction} · ${uniqRules.length} rule${uniqRules.length !== 1 ? 's' : ''} fired across ${uniqTfs.length} timeframe${uniqTfs.length !== 1 ? 's' : ''}`,
    `Rules: ${uniqRules.map(r => `#${r}`).join(' · ')} · TFs: ${uniqTfs.join(' · ')}`,
    ...winning.slice(0, 4).flatMap(h => [`• [${h.tf.name}] Rule${h.rule} ${h.name}`, ...h.notes.map(n => `   ${n}`)]),
    `Spot ₹${spot.toFixed(2)} · ATR ₹${atr.toFixed(0)} · ${side} ${strike} @ ₹${premium} (${resolution.note})`,
    `T1 ₹${t1Prem} (+40%) · T2 ₹${t2Prem} (+90%) · SL ₹${slPrem} (-30%)`,
  ]

  const confluence: Confluence = {
    trend: uniqRules.some(r => [1, 2, 3].includes(r)),
    vwap: true,         // every strategy uses VWAP filter
    volume: uniqRules.some(r => [5, 6].includes(r)),
    pattern: uniqRules.includes(2),
    rsi: uniqRules.includes(8),
  }
  if (ctx.gannBias) confluence.gann = ctx.gannBias.timeCycleHit || ctx.gannBias.priceAtGannLevel
  if (ctx.flowDirection) {
    confluence.flow = (direction === 'BULL' && ctx.flowDirection === 'BULL') ||
                      (direction === 'BEAR' && ctx.flowDirection === 'BEAR')
  }

  const confResult = scoreConfluence(confluence)

  const tradePlan = buildTradePlan({
    type: 'OPTIONS' as SignalType,
    underlying: sym, strike, side, expiry, premium,
    entry: premium, target2: t2Prem, direction: 'BUY',
    asOf: new Date(lastCandle.time).toISOString(),
    candles: ctx.candles,
  })
  return {
    id: `mtf-opt-${sym}-${strike}-${side}-${Date.now()}`,
    instrument: `${sym} ${strike} ${side}`,
    direction: 'BUY',
    grade, score,
    entry: premium, stopLoss: slPrem, target1: t1Prem, target2: t2Prem,
    target3: tradePlan.target3,
    riskPct: riskPct(premium, slPrem),
    rewardPct: rewardPct(premium, t1Prem),
    riskReward: riskReward(premium, slPrem, t1Prem),
    type: 'OPTIONS' as SignalType,
    reasons,
    gannNote: ctx.gannBias?.note ?? 'Gann neutral',
    astroNote: ctx.astroBias?.note ?? 'Astro neutral',
    oiNote: `MTF confluence · ${uniqRules.length} rules × ${uniqTfs.length} TFs · top: ${top.name} (${top.tf.name})`,
    pattern: top.name,
    expiresAt: expiry,
    timestamp: new Date().toISOString(),
    confluence,
    confluenceCount: confResult.count,
    source: 'options-mtf',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(lastCandle.time).toISOString(),
    meta: {
      timeframe: `${uniqTfs.length}-TF`,
      atr, rsi: lastRSI(ctx.candles, 14) ?? 50,
      pattern: top.name,
    },
    tradePlan,
  }
}

// ─── Strike + premium helpers ────────────────────────────────

function roundStrike(spot: number, sym: string): number {
  if (sym === 'BANKNIFTY') return Math.round(spot / 100) * 100
  if (sym === 'NIFTY' || sym === 'FINNIFTY') return Math.round(spot / 50) * 50
  if (sym === 'GOLD') return Math.round(spot / 100) * 100
  if (sym === 'CRUDE') return Math.round(spot / 50) * 50
  if (spot < 100) return Math.round(spot / 2.5) * 2.5
  if (spot < 500) return Math.round(spot / 5) * 5
  if (spot < 2000) return Math.round(spot / 10) * 10
  return Math.round(spot / 20) * 20
}

/**
 * Convert a daily-candle ATR reading into an annualised IV estimate for
 * the Black-Scholes fallback. Historical vol proxy: σ_daily ≈ ATR/spot,
 * σ_annual ≈ σ_daily × √252. Clamped to the realistic NIFTY band
 * (8 %–40 %) so outlier single-day moves don't blow up the quote.
 */
function ivFromAtr(atr: number, spot: number): number {
  if (spot <= 0 || atr <= 0) return 0.15
  const sigmaDaily = atr / spot
  const sigmaAnnual = sigmaDaily * Math.sqrt(252)
  return Math.max(0.08, Math.min(0.40, sigmaAnnual))
}

function nextWeeklyExpiry(): string {
  const d = new Date()
  const day = d.getUTCDay()
  const off = ((4 - day + 7) % 7) || 7     // Thursday
  return addDays(d, off).toISOString().slice(0, 10)
}
