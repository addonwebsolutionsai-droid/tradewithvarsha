import type { Candle, Confluence, Signal, SignalType, StrategyContext } from '../types'
import { analyzeSMC, smcSignal } from '../patterns/smc'
import { adx, ema, lastATR, lastRSI, lastVWAP, volumeSpike } from '../indicators'
import { scoreConfluence, gradeFromScore } from '../engine/scoring'
import { riskPct, rewardPct, riskReward } from '../engine/risk'
import { buildTradePlan } from '../engine/tradePlan'
import { addDays } from '../util/time'
import { resolvePremium, daysUntil } from '../options/premium'

/**
 * Futures + Options Advisor.
 *
 * Generates an F&O setup whenever a strong directional move is forming on
 * an instrument that has F&O turnover. Two outputs per qualifying setup:
 *
 *   1. FUTURES leg — entry/SL/T1/T2 in the underlying, sized to a futures lot
 *   2. OPTIONS leg — near-ATM CE/PE with premium ladder
 *
 * Designed to fire MORE often than the strict OptionsSignal (which needs an
 * option chain + 5/5 confluence). This one fires on:
 *   - Strong direction (4/9 confluence in live, 3/9 in snapshot)
 *   - Expected move ≥ 2 % (so the options premium has room to expand 30%+)
 *   - Liquidity gate (60-day avg vol ≥ 100k)
 *
 * Stock options are synthesised since we don't have stock option chains:
 *   strike = round(spot, step)  ·  premium ≈ 2.5 % of spot for ATM weekly
 *
 * Output type = OPTIONS (two-row generation: see signalEngine wire-up).
 */

const STOCK_OPTION_LOT_SIZES: Record<string, number> = {
  // Index F&O lot sizes
  NIFTY: 25, BANKNIFTY: 15, FINNIFTY: 25,
  // Common stock F&O lot sizes (subset — Angel ScripMaster has the full list)
  RELIANCE: 250, TCS: 175, HDFCBANK: 550, INFY: 400, ICICIBANK: 700, SBIN: 750,
  AXISBANK: 625, ITC: 1600, LT: 300, BHARTIARTL: 475, BAJFINANCE: 125,
  KOTAKBANK: 400, MARUTI: 50, ASIANPAINT: 200, TATAMOTORS: 1425, TATASTEEL: 5500,
  ONGC: 3850, HCLTECH: 350, WIPRO: 3000, ULTRACEMCO: 50, NTPC: 1500,
  POWERGRID: 1900, ADANIENT: 300, ADANIPORTS: 1250, BAJAJFINSV: 500,
  M_M: 700, JSWSTEEL: 675, HINDUNILVR: 300, NESTLEIND: 50, COALINDIA: 1700,
  INDUSINDBK: 900, SUNPHARMA: 700, EICHERMOT: 175, HEROMOTOCO: 300,
  BRITANNIA: 200, DRREDDY: 125, GRASIM: 475, TITAN: 175, DIVISLAB: 200,
  BPCL: 1800, CIPLA: 650, IOC: 9750, VEDL: 1550, SAIL: 9500, HAL: 350,
  TATAPOWER: 6750, CANBK: 2700, BANKBARODA: 5400, IRCTC: 1000, IRFC: 8000,
  PFC: 1700, RECLTD: 2200, ADANIPOWER: 3300,
}

function lotSizeFor(symbol: string): number {
  // Some scrips use - or _ in our maps
  const k = symbol.replace(/-/g, '_').toUpperCase()
  return STOCK_OPTION_LOT_SIZES[k] ?? STOCK_OPTION_LOT_SIZES[symbol] ?? 1
}

function isIndex(sym: string): boolean {
  return sym === 'NIFTY' || sym === 'BANKNIFTY' || sym === 'FINNIFTY'
}

/** Round to the nearest valid options strike step. */
function roundStrike(price: number, sym: string): number {
  if (sym === 'BANKNIFTY') return Math.round(price / 100) * 100
  if (sym === 'NIFTY' || sym === 'FINNIFTY') return Math.round(price / 50) * 50
  if (price < 100)   return Math.round(price / 2.5) * 2.5
  if (price < 500)   return Math.round(price / 5)   * 5
  if (price < 2000)  return Math.round(price / 10)  * 10
  return Math.round(price / 20) * 20
}

/** Annualised IV estimate from daily ATR, clamped to the realistic band. */
function ivFromAtr(atr: number, spot: number): number {
  if (spot <= 0 || atr <= 0) return 0.15
  const sigmaAnnual = (atr / spot) * Math.sqrt(252)
  return Math.max(0.08, Math.min(0.40, sigmaAnnual))
}

/**
 * Returns up to 2 signals per call — a FUTURES leg and an OPTIONS leg —
 * when the underlying setup justifies F&O exposure.
 */
export function futuresOptionsAdvisor(ctx: StrategyContext): Signal[] {
  const { symbol, candles } = ctx
  if (candles.length < 60) return []

  const last = candles[candles.length - 1]
  const smc = analyzeSMC(candles)
  const smcSig = smcSignal(smc)
  const e9 = ema(candles, 9); const e21 = ema(candles, 21); const e50 = ema(candles, 50)
  const e9L = e9[e9.length - 1]; const e21L = e21[e21.length - 1]; const e50L = e50[e50.length - 1]
  const stackBull = e9L > e21L && e21L > e50L
  const stackBear = e9L < e21L && e21L < e50L
  const r = lastRSI(candles, 14) ?? 50
  const a = adx(candles, 14)
  const vwap = lastVWAP(candles)
  const volSpike = volumeSpike(candles, 20, 1.5)
  const atr = lastATR(candles, 14) ?? last.close * 0.02

  // Direction logic
  let direction: 'BUY' | 'SELL' | null = null
  if (smcSig.bull && stackBull) direction = 'BUY'
  else if (smcSig.bear && stackBear) direction = 'SELL'
  else if (smc.bias === 'BULLISH' && stackBull) direction = 'BUY'
  else if (smc.bias === 'BEARISH' && stackBear) direction = 'SELL'
  else if (ctx.relaxed && e21L != null) direction = last.close >= e21L ? 'BUY' : 'SELL'
  if (!direction) return []

  const bull = direction === 'BUY'

  // Liquidity gate — futures + options need volume to fill
  const vol60Avg = candles.slice(-61, -1).reduce((s, c) => s + c.volume, 0) / 60
  if (vol60Avg < 100_000 && !isIndex(symbol)) return []

  // Regime gate — F&O premium decays without trend
  if (!ctx.relaxed) {
    if (!a || a.adx < 20) return []
  }

  // Build confluence
  const confluence: Confluence = {
    smc: bull ? smcSig.bull : smcSig.bear,
    trend: bull ? stackBull : stackBear,
    vwap: bull ? !!vwap && last.close > vwap : !!vwap && last.close < vwap,
    volume: volSpike,
    rsi: bull ? r > 52 && r < 75 : r < 48 && r > 25,
    pattern: false,
  }
  if (ctx.gannBias) confluence.gann = ctx.gannBias.timeCycleHit || ctx.gannBias.priceAtGannLevel
  if (ctx.astroBias) confluence.astro = bull ? ctx.astroBias.bullish : ctx.astroBias.bearish
  if (ctx.flowDirection) {
    confluence.flow = (bull && ctx.flowDirection === 'BULL') || (!bull && ctx.flowDirection === 'BEAR')
  }
  if (ctx.fundamentalsFactorFires) confluence.fundamentals = true

  const { score, count } = scoreConfluence(confluence)
  const minCount = ctx.relaxed ? 3 : 4
  if (count < minCount) return []
  const grade = gradeFromScore(score)

  // Expected move sizing — projected ~7 sessions out at 1.5 × ATR
  const projectedMove = 1.5 * atr
  const projectedMovePct = (projectedMove / last.close) * 100
  // For options to be worthwhile (premium expands 30%+) need ~2% underlying move
  if (!ctx.relaxed && projectedMovePct < 2) return []

  const sign = bull ? 1 : -1
  const futEntry = +last.close.toFixed(2)
  const futStop  = +(futEntry - sign * 1.5 * atr).toFixed(2)
  const futT1    = +(futEntry + sign * 2.5 * atr).toFixed(2)
  const futT2    = +(futEntry + sign * 5.0 * atr).toFixed(2)
  const expiry = nextWeeklyOrMonthlyExpiry(symbol)

  // ── FUTURES leg ────────────────────────────────────────────
  const futLot = lotSizeFor(symbol)
  const futReasons: string[] = [
    `Strong ${bull ? 'bull' : 'bear'} setup — SMC ${smc.bias.toLowerCase()}, EMA stack ${bull ? 'bull' : 'bear'}, ADX ${a?.adx.toFixed(0) ?? '—'}`,
    `Projected move ≈ ${projectedMovePct.toFixed(1)}% over ~7 sessions (1.5 × ATR)`,
    `Lot size ${futLot} · risk per lot ₹${(Math.abs(futEntry - futStop) * futLot).toFixed(0)}`,
  ]
  const futPlan = buildTradePlan({
    type: 'FUTURES' as SignalType,
    entry: futEntry, target2: futT2, direction,
    asOf: new Date(last.time).toISOString(),
    candles: ctx.candles,
  })
  const futSignal: Signal = {
    id: `fno-fut-${symbol}-${Date.now()}`,
    instrument: `${symbol} FUT (${expiry})`,
    direction,
    grade,
    score,
    entry: futEntry,
    stopLoss: futStop,
    target1: futT1,
    target2: futT2,
    target3: futPlan.target3,
    riskPct: riskPct(futEntry, futStop),
    rewardPct: rewardPct(futEntry, futT1),
    riskReward: riskReward(futEntry, futStop, futT1),
    type: 'FUTURES' as SignalType,
    reasons: futReasons,
    gannNote: ctx.gannBias?.note ?? 'Gann neutral',
    astroNote: ctx.astroBias?.note ?? 'Astro neutral',
    oiNote: 'Futures — no chain context',
    pattern: smc.note,
    expiresAt: expiry,
    timestamp: new Date().toISOString(),
    confluence,
    confluenceCount: count,
    source: 'fno-advisor',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: {
      ema9: e9L, ema21: e21L, ema50: e50L,
      atr, rsi: r, adx: a?.adx,
      vwap: vwap ?? undefined,
      timeframe: '15m',
    },
    tradePlan: futPlan,
  }

  // ── OPTIONS leg ────────────────────────────────────────────
  const strike = roundStrike(last.close, symbol)
  const side: 'CE' | 'PE' = bull ? 'CE' : 'PE'
  const optResolution = resolvePremium({
    spot: last.close, strike, side,
    daysToExpiry: daysUntil(expiry),
    chain: ctx.optionChain,
    ivFallback: ivFromAtr(atr, last.close),
  })
  const premium = optResolution.premium
  // Premium math — premium expands ~10× the underlying-move multiple for ATM
  // weekly options. Cap T1 at 30% / T2 at 80% of premium.
  const premSL = +(premium * 0.7).toFixed(2)        // tight 30 % SL
  const premT1 = +(premium * 1.4).toFixed(2)        // 40 % gain
  const premT2 = +(premium * 2.0).toFixed(2)        // 100 % gain
  const optReasons: string[] = [
    `${symbol} ${strike} ${side} (ATM weekly) — premium ₹${premium} (${optResolution.note})`,
    `Underlying ${bull ? 'bull' : 'bear'} thesis: ${(futReasons[0] ?? '').replace(/^Strong /, '')}`,
    `If underlying hits ₹${futT1.toFixed(2)} (${(2.5 * atr / last.close * 100).toFixed(1)}%), premium ≈ +40% → ₹${premT1}`,
    `If underlying hits ₹${futT2.toFixed(2)} (${(5.0 * atr / last.close * 100).toFixed(1)}%), premium ≈ +100% → ₹${premT2}`,
  ]
  if (count >= 5) optReasons.push(`High confluence ${count}/12 factors aligned · grade ${grade}`)
  if (ctx.flowDirection) optReasons.push(`FII/DII flow ${ctx.flowDirection.toLowerCase()}`)

  const optPlan = buildTradePlan({
    type: 'OPTIONS' as SignalType,
    underlying: symbol, strike, side, expiry, premium,
    entry: premium, target2: premT2, direction: 'BUY',
    asOf: new Date(last.time).toISOString(),
    candles: ctx.candles,
  })
  const optSignal: Signal = {
    id: `fno-opt-${symbol}-${strike}-${side}-${Date.now()}`,
    instrument: `${symbol} ${strike} ${side}`,
    direction: 'BUY',                                 // long the option leg
    grade,
    score,
    entry: premium,
    stopLoss: premSL,
    target1: premT1,
    target2: premT2,
    target3: optPlan.target3,
    riskPct: riskPct(premium, premSL),
    rewardPct: rewardPct(premium, premT1),
    riskReward: riskReward(premium, premSL, premT1),
    type: 'OPTIONS' as SignalType,
    reasons: optReasons,
    gannNote: ctx.gannBias?.note ?? 'Gann neutral',
    astroNote: ctx.astroBias?.note ?? 'Astro neutral',
    oiNote: 'Synthetic ATM — chain not available',
    pattern: smc.note,
    expiresAt: expiry,
    timestamp: new Date().toISOString(),
    confluence,
    confluenceCount: count,
    source: 'fno-advisor',
    tier: ctx.relaxed ? 'WATCH' : 'LIVE',
    asOf: new Date(last.time).toISOString(),
    meta: {
      ema9: e9L, ema21: e21L, ema50: e50L,
      atr, rsi: r, adx: a?.adx,
      vwap: vwap ?? undefined,
      timeframe: '15m',
    },
    tradePlan: optPlan,
  }

  return [futSignal, optSignal]
}

/** Next Thursday for indices, last-Thursday-of-month for stocks. */
function nextWeeklyOrMonthlyExpiry(symbol: string): string {
  const d = new Date()
  if (isIndex(symbol)) {
    // Next Thursday
    const day = d.getUTCDay()
    const offset = ((4 - day + 7) % 7) || 7
    return addDays(d, offset).toISOString().slice(0, 10)
  }
  // Last Thursday of current month — naive implementation
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  while (lastDay.getUTCDay() !== 4) lastDay.setUTCDate(lastDay.getUTCDate() - 1)
  // If already past, jump to next month's last Thursday
  if (lastDay.getTime() < d.getTime()) {
    const nm = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0))
    while (nm.getUTCDay() !== 4) nm.setUTCDate(nm.getUTCDate() - 1)
    return nm.toISOString().slice(0, 10)
  }
  return lastDay.toISOString().slice(0, 10)
}
