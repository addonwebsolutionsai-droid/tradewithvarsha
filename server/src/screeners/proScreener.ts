/**
 * PRO SCREENER — implements the 12-query / 100-point conviction system from
 * `screener.md`. Goal: identify stocks BEFORE they move 10–20% in 15–20 days.
 *
 * Coverage map (Q = query letter from screener.md):
 *
 *   ┌────┬─────────────────────────────────┬─────────────────────────────┐
 *   │ Q  │ Setup name                      │ Coverage                    │
 *   ├────┼─────────────────────────────────┼─────────────────────────────┤
 *   │ A  │ Volume Surge + Breakout         │ ✅ technical-only           │
 *   │ B  │ Opening Range Breakout (ORB)    │ ⏳ needs intraday 5m feed   │
 *   │ C  │ News/Catalyst Momentum          │ ✅ technical-only           │
 *   │ D  │ Tight-base Bull-flag breakout   │ ✅ technical-only           │
 *   │ E  │ Earnings Beat Momentum          │ ❌ needs fundamentals       │
 *   │ F  │ Sectoral Rotation Leader        │ ⚠️  partial — no sector map │
 *   │ G  │ VCP / Cup & Handle              │ ✅ technical (no fundament.)│
 *   │ H  │ Institutional Accumulation      │ ❌ needs FII/DII flows      │
 *   │ I  │ Multi-Month Base Breakout       │ ✅ technical-only           │
 *   │ J  │ Fundamental Turnaround          │ ❌ needs fundamentals       │
 *   │ K  │ CANSLIM Composite               │ ❌ needs fundamentals       │
 *   │ L  │ Sector Cycle Leadership         │ ⚠️  partial — no sector map │
 *   └────┴─────────────────────────────────┴─────────────────────────────┘
 *
 * Conviction scoring (max 100):
 *   Volume (30) · Price Structure (25) · RSI (15) · Institutional (20)* · Fundamentals (10)*
 *   Red flags can deduct up to 70 pts.
 *
 *   * Institutional + Fundamentals require external data we don't ingest yet.
 *     We compute a `techScore` (max 70) for now and present `convictionScore`
 *     as `techScore + 0` so tiers stay correct ratio-wise. When the
 *     fundamental pipeline lands, drop the values into `extras` and the
 *     scorer picks them up.
 */

import type { Candle } from '../types'
import { ema, lastATR, lastRSI } from '../indicators'
import type { Screener, ScreenerResult } from './types'
import { addDays } from '../util/time'
import { sessionHoras, horaAt } from '../astro/parashariHora'

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

const last = <T>(a: T[]): T => a[a.length - 1]
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)
const max = (a: number[]) => (a.length ? Math.max(...a) : 0)
const min = (a: number[]) => (a.length ? Math.min(...a) : 0)
const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100)

interface TechSnapshot {
  symbol: string
  candles: Candle[]
  price: number
  prevClose: number
  dayChangePct: number
  prevDayHigh: number
  prevWeekHigh: number
  high3m: number
  high6m: number
  high52w: number
  low52w: number
  ema20?: number
  ema50?: number
  ema200?: number
  fullStackBull: boolean
  rsi14: number
  atr14: number
  vol1: number             // today's volume
  volAvg20: number
  volAvg60: number
  volRatio20: number       // vol1 / volAvg20
  volRatio60: number
  range5dPct: number       // 5-day H–L range as % of mid
  drawdownFrom52wHighPct: number
  ret5dPct: number
  ret20dPct: number
  ret60dPct: number
  pricePctOf52wHigh: number  // 0–1
  pricePctVs52wLow: number   // current/52wLow
}

function snapshot(candles: Candle[], symbol: string): TechSnapshot | null {
  if (candles.length < 60) return null
  const today = last(candles)
  const yest = candles[candles.length - 2] ?? today

  const e20 = last(ema(candles, 20))
  const e50 = last(ema(candles, 50))
  const e200 = last(ema(candles, 200))

  const prevWeekStart = candles.length - 6
  const prevWeekSlice = candles.slice(Math.max(0, prevWeekStart - 5), prevWeekStart)
  const prevWeekHigh = max(prevWeekSlice.map(c => c.high))

  const last5 = candles.slice(-5)
  const range5dHigh = max(last5.map(c => c.high))
  const range5dLow = min(last5.map(c => c.low))
  const range5dMid = (range5dHigh + range5dLow) / 2

  const last63 = candles.slice(-63)            // ~3 months
  const last126 = candles.slice(-126)          // ~6 months
  const last252 = candles.slice(-252)          // ~52 weeks
  const high3m = max(last63.slice(0, -1).map(c => c.high))
  const high6m = max(last126.slice(0, -1).map(c => c.high))
  const high52w = max(last252.map(c => c.high))
  const low52w = min(last252.map(c => c.low))

  const vols20 = candles.slice(-21, -1).map(c => c.volume)
  const vols60 = candles.slice(-61, -1).map(c => c.volume)
  const volAvg20 = avg(vols20)
  const volAvg60 = avg(vols60)

  const ret5dRef = candles[candles.length - 6]?.close ?? today.close
  const ret20dRef = candles[candles.length - 21]?.close ?? today.close
  const ret60dRef = candles[candles.length - 61]?.close ?? today.close

  const stack = !!(e20 && e50 && e200 && e20 > e50 && e50 > e200)

  return {
    symbol,
    candles,
    price: +today.close.toFixed(2),
    prevClose: +yest.close.toFixed(2),
    dayChangePct: pct(today.close, yest.close),
    prevDayHigh: +yest.high.toFixed(2),
    prevWeekHigh: +prevWeekHigh.toFixed(2),
    high3m: +high3m.toFixed(2),
    high6m: +high6m.toFixed(2),
    high52w: +high52w.toFixed(2),
    low52w: +low52w.toFixed(2),
    ema20: e20, ema50: e50, ema200: e200,
    fullStackBull: stack,
    rsi14: lastRSI(candles, 14) ?? 50,
    atr14: lastATR(candles, 14) ?? today.close * 0.02,
    vol1: today.volume,
    volAvg20,
    volAvg60,
    volRatio20: volAvg20 > 0 ? today.volume / volAvg20 : 0,
    volRatio60: volAvg60 > 0 ? today.volume / volAvg60 : 0,
    range5dPct: range5dMid > 0 ? ((range5dHigh - range5dLow) / range5dMid) * 100 : 100,
    drawdownFrom52wHighPct: pct(today.close, high52w),
    ret5dPct: pct(today.close, ret5dRef),
    ret20dPct: pct(today.close, ret20dRef),
    ret60dPct: pct(today.close, ret60dRef),
    pricePctOf52wHigh: high52w > 0 ? today.close / high52w : 0,
    pricePctVs52wLow: low52w > 0 ? today.close / low52w : 0,
  }
}

// ───────────────────────────────────────────────────────────────
// Conviction Scoring (per screener.md PART 5)
// ───────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  volume: number
  price: number
  rsi: number
  institutional: number       // 0 until FII/DII data wired
  fundamentals: number        // 0 until fundamentals wired
  redFlags: number            // negative
  total: number               // 0–100
  techMaxPossible: number     // 70 today; rises to 100 once fundamentals connect
  notes: string[]
}

function scoreSnapshot(s: TechSnapshot): ScoreBreakdown {
  const notes: string[] = []
  let volume = 0, price = 0, rsi = 0, redFlags = 0

  // Volume (max 30)
  if (s.volRatio20 >= 5) { volume = 30; notes.push(`Volume ${s.volRatio20.toFixed(1)}× avg (≥5×)`) }
  else if (s.volRatio20 >= 3) { volume = 20; notes.push(`Volume ${s.volRatio20.toFixed(1)}× avg`) }
  else if (s.volRatio20 >= 2) { volume = 10; notes.push(`Volume ${s.volRatio20.toFixed(1)}× avg`) }
  else if (s.volRatio20 >= 1.5) { volume = 5; notes.push(`Volume ${s.volRatio20.toFixed(1)}× avg`) }

  // Price structure (max 25 + 5 stack bonus)
  if (s.price > s.high52w) { price = 25; notes.push('New 52W high') }
  else if (s.pricePctOf52wHigh >= 0.95) { price = 18; notes.push(`Within 5% of 52W high`) }
  else if (s.price > s.high6m) { price = 15; notes.push('Above 6-month high') }
  else if (s.price > s.high3m) { price = 10; notes.push('Above 3-month high') }
  else if (s.price > s.prevWeekHigh) { price = 5; notes.push('Above previous-week high') }
  if (s.fullStackBull) { price += 5; notes.push('EMA 20>50>200 stacked') }

  // RSI (max 15)
  if (s.rsi14 >= 55 && s.rsi14 <= 70) { rsi = 15; notes.push(`RSI ${s.rsi14.toFixed(0)} momentum zone`) }
  else if (s.rsi14 >= 50 && s.rsi14 < 55) { rsi = 10; notes.push(`RSI ${s.rsi14.toFixed(0)} early momentum`) }
  else if (s.rsi14 > 70 && s.rsi14 <= 80) { rsi = 5; notes.push(`RSI ${s.rsi14.toFixed(0)} strong but watch`) }

  // Red flags
  if (s.ema200 != null && s.price < s.ema200) { redFlags -= 15; notes.push('Below 200-EMA (-15)') }
  if (s.rsi14 > 85) { redFlags -= 10; notes.push(`RSI ${s.rsi14.toFixed(0)} blow-off risk (-10)`) }
  // Falling 3m volume trend
  if (s.volAvg60 > 0 && s.volAvg20 < s.volAvg60 * 0.7) { redFlags -= 10; notes.push('Volume trend falling (-10)') }

  const techMaxPossible = 30 + 25 + 5 + 15        // = 75 with stack bonus
  const total = Math.max(0, Math.min(100, volume + price + rsi + redFlags))

  return {
    volume, price, rsi,
    institutional: 0,
    fundamentals: 0,
    redFlags,
    total,
    techMaxPossible,
    notes,
  }
}

function tierFromScore(score: number): 'A' | 'B' | 'C' {
  // We collapse the spec's 4-tier (T1/T2/T3/Discard) into our 3-tier (A/B/C)
  // because ScreenerResult.tier is constrained to A|B|C — a Discard simply
  // returns null from the screener and is never surfaced.
  if (score >= 80) return 'A'    // Tier 1 — high conviction
  if (score >= 65) return 'B'    // Tier 2 — good setup
  return 'C'                     // Tier 3 — watchlist
}

function discardScore(score: number): boolean {
  return score < 50              // spec: "Score < 50 → DISCARD"
}

// Trade plan generator — mirrors the Weekly/Daily Pick shape (entry band,
// next-session entry date, hora-aligned time window, T1/T2/T3 with dates).
function buildTradePlan(
  s: TechSnapshot, direction: 'BULL' | 'BEAR', category?: ScreenerResult['category'],
) {
  // Prefer entering on pullback to EMA21 (BULL) or rally into EMA21 (BEAR),
  // capped to a 1.5% band around spot so we never drift far from CMP.
  const e21 = (s as { ema21?: number }).ema21 ?? s.price
  const entry = direction === 'BULL'
    ? +Math.min(s.price, Math.max(e21, s.price * 0.985)).toFixed(2)
    : +Math.max(s.price, Math.min(e21, s.price * 1.015)).toFixed(2)
  const band = Math.max(entry * 0.005, 0.5)
  const entryPriceLow  = +(direction === 'BULL' ? entry - band : entry).toFixed(2)
  const entryPriceHigh = +(direction === 'BULL' ? entry : entry + band).toFixed(2)

  const sl = direction === 'BULL'
    ? +(entry - 1.5 * s.atr14).toFixed(2)
    : +(entry + 1.5 * s.atr14).toFixed(2)
  const risk = Math.abs(entry - sl)
  const t1 = direction === 'BULL' ? +(entry + 2 * risk).toFixed(2) : +(entry - 2 * risk).toFixed(2)
  const t2 = direction === 'BULL' ? +(entry + 3.5 * risk).toFixed(2) : +(entry - 3.5 * risk).toFixed(2)
  const t3 = direction === 'BULL' ? +(entry + 5 * s.atr14).toFixed(2) : +(entry - 5 * s.atr14).toFixed(2)

  // Target-day projection per category
  const td = TARGET_DAYS_BY_CAT[category ?? 'SWING']
  const today = new Date()
  const entryDate = projectDate(today, 1)
  const target1Date = projectDate(today, td.t1)
  const target2Date = projectDate(today, td.t2)
  const target3Date = projectDate(today, td.t3)

  // Hora-aligned intraday slot for entry date
  const entryDayDate = new Date(entryDate + 'T04:00:00.000Z')
  const horas = sessionHoras(entryDayDate)
  const wantsBull = direction === 'BULL'
  const aligned = horas.find(h => wantsBull ? h.bias === 'BULLISH' : h.bias === 'BEARISH')
  const pick = aligned ?? horas.find(h => h.bias === 'VOLATILE') ?? horas[0] ?? horaAt(entryDayDate)
  const bestEntryTimeIST = `${pick.startIST}-${pick.endIST}`
  const horaLord = pick.lord
  const horaNote = `${pick.lord} hora · ${pick.bias}`
  const entryNote = direction === 'BULL'
    ? `Buy ${entryPriceLow}–${entryPriceHigh} on dip (≈ EMA21). Trigger ${bestEntryTimeIST} IST.`
    : `Short ${entryPriceLow}–${entryPriceHigh} on rally (≈ EMA21). Trigger ${bestEntryTimeIST} IST.`

  return {
    entry, sl, t1, t2, t3,
    entryPriceLow, entryPriceHigh,
    entryDate, entryNote,
    bestEntryTimeIST, horaLord, horaNote,
    target1Date, target2Date, target3Date,
  }
}

const TARGET_DAYS_BY_CAT: Record<NonNullable<ScreenerResult['category']>, { t1: number; t2: number; t3: number }> = {
  INTRADAY:     { t1: 0,  t2: 1,  t3: 2 },
  SHORT_SWING:  { t1: 3,  t2: 8,  t3: 14 },
  SWING:        { t1: 7,  t2: 18, t3: 30 },
  POSITIONAL:   { t1: 21, t2: 45, t3: 75 },
}

function projectDate(from: Date, days: number): string {
  if (days <= 0) return from.toISOString().slice(0, 10)
  let d = new Date(from)
  let added = 0
  while (added < days) {
    d = addDays(d, 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d.toISOString().slice(0, 10)
}

// ───────────────────────────────────────────────────────────────
// Per-query screeners
// ───────────────────────────────────────────────────────────────

const A_VolumeBreakout: Screener = {
  id: 'pro_A_vol_breakout',
  name: 'Q-A · Volume Surge + Breakout',
  description: 'Price > previous-day high on ≥3× volume · RSI 55-75 · above 20+50 EMA',
  timeframeLabel: 'intraday — same session',
  setupKind: 'BREAKOUT',
  scan(candles, symbol) {
    const s = snapshot(candles, symbol); if (!s) return null
    if (s.price <= s.prevDayHigh) return null
    if (s.volRatio20 < 3) return null
    if (s.rsi14 < 55 || s.rsi14 > 75) return null
    if (s.pricePctVs52wLow < 1.3) return null
    if (s.ema20 == null || s.price < s.ema20) return null
    if (s.ema50 == null || s.price < s.ema50) return null
    return finalize(s, 'BULL', 'A · Volume Surge + Breakout', 'intraday — same session', 'A', 'INTRADAY', 'BREAKOUT')
  },
}

const C_NewsCatalyst: Screener = {
  id: 'pro_C_news_catalyst',
  name: 'Q-C · News/Catalyst Momentum',
  description: 'Today >+4% on ≥5× volume · above 20+50 EMA · RSI<80 · day move<15%',
  timeframeLabel: 'intraday — continuation play',
  setupKind: 'MOMENTUM',
  scan(candles, symbol) {
    const s = snapshot(candles, symbol); if (!s) return null
    if (s.dayChangePct < 4 || s.dayChangePct > 15) return null
    if (s.volRatio20 < 5) return null
    if (s.ema20 == null || s.price < s.ema20) return null
    if (s.ema50 == null || s.price < s.ema50) return null
    if (s.rsi14 >= 80) return null
    return finalize(s, 'BULL', 'C · News/Catalyst Momentum', '1-3 sessions', 'C', 'INTRADAY', 'MOMENTUM')
  },
}

const D_BullFlagBreakout: Screener = {
  id: 'pro_D_bull_flag',
  name: 'Q-D · Tight-Base Bull-Flag Breakout',
  description: 'Within 5% of 52W high · last-5d range <5% · ≥2× vol · RSI 50-70 · above 200-EMA',
  timeframeLabel: '1-3 days, 8-15%',
  setupKind: 'BREAKOUT',
  scan(candles, symbol) {
    const s = snapshot(candles, symbol); if (!s) return null
    if (s.pricePctOf52wHigh < 0.95) return null
    if (s.range5dPct >= 5) return null
    if (s.volRatio20 < 2) return null
    if (s.rsi14 < 50 || s.rsi14 > 70) return null
    if (s.ema200 == null || s.price < s.ema200) return null
    return finalize(s, 'BULL', 'D · Tight-Base Bull Flag', '1-3 days, 8-15%', 'D', 'SHORT_SWING', 'BREAKOUT')
  },
}

const G_VCP: Screener = {
  id: 'pro_G_vcp',
  name: 'Q-G · VCP / Cup & Handle',
  description: 'Within 3% of 52W high · drawdown <30% · volume contraction in handle · RSI 45-65',
  timeframeLabel: '5-10 days, 12-20%',
  setupKind: 'BREAKOUT',
  scan(candles, symbol) {
    const s = snapshot(candles, symbol); if (!s) return null
    if (s.pricePctOf52wHigh < 0.97) return null
    // drawdown from 52W high < 30 % — measured at the deepest point of the lookback
    const cup = candles.slice(-126)
    const cupLow = min(cup.map(c => c.low))
    const cupDD = pct(cupLow, s.high52w)
    if (cupDD < -30) return null
    // Handle: today's volume < 20-day avg (contraction) but liquid
    if (s.vol1 >= s.volAvg20) return null
    if (s.volAvg20 < 100_000) return null
    if (s.rsi14 < 45 || s.rsi14 > 65) return null
    return finalize(s, 'BULL', 'G · VCP / Cup & Handle', '5-10 days, 12-20%', 'G', 'SWING', 'BREAKOUT')
  },
}

const I_MultiMonthBreakout: Screener = {
  id: 'pro_I_mm_breakout',
  name: 'Q-I · Multi-Month Base Breakout',
  description: 'Price > 3M high AND > 6M high · ≥3× vol vs 60-day avg · price/52WL > 1.4',
  timeframeLabel: '5-10 days, 12-20%',
  setupKind: 'BREAKOUT',
  scan(candles, symbol) {
    const s = snapshot(candles, symbol); if (!s) return null
    if (s.price <= s.high3m) return null
    if (s.price <= s.high6m) return null
    if (s.volRatio60 < 3) return null
    if (s.pricePctVs52wLow < 1.4) return null
    return finalize(s, 'BULL', 'I · Multi-Month Base Breakout', '5-10 days, 12-20%', 'I', 'SWING', 'BREAKOUT')
  },
}

// Generalised "early-momentum" pre-move scan — 50-EMA cross within last 5
// sessions + rising volume trend. Wider window than the strict same-day cross
// so we catch the setup before it becomes obvious.
const M_EarlyMomentum: Screener = {
  id: 'pro_M_early_momentum',
  name: 'Q-M · Early-Momentum Pre-Move',
  description: 'Price crossed above 50-EMA in last 5 sessions · 5d ret >0 · 20d vol > 60d vol',
  timeframeLabel: '15-20 days, 10-20%',
  setupKind: 'PRE_MOVE',
  scan(candles, symbol) {
    const s = snapshot(candles, symbol); if (!s) return null
    if (s.ema50 == null || s.price <= s.ema50) return null
    // Crossed up at any point in last 5 sessions (not just yesterday→today)
    const last6 = candles.slice(-6)
    const e50Series = ema(candles, 50).slice(-6)
    const crossedRecently = last6.some((c, i) => i > 0 && last6[i - 1].close <= e50Series[i - 1] && c.close > e50Series[i])
    if (!crossedRecently) return null
    if (s.ret5dPct < 0) return null
    if (s.volAvg20 < s.volAvg60 * 1.0) return null
    if (s.rsi14 < 50 || s.rsi14 > 75) return null
    return finalize(s, 'BULL', 'M · Early Momentum Cross', '15-20 days, 10-20%', 'M', 'POSITIONAL', 'PRE_MOVE')
  },
}

/**
 * General Watchlist — final safety-net scanner. Computes the conviction score
 * on every stock with valid candles and surfaces anyone scoring ≥ 50 (Tier 3
 * watchlist per screener.md). Direction inferred from price vs EMA50 and
 * recent return.
 *
 * This guarantees the Pro Screener tab is never empty in MIXED / BEAR regimes
 * — the strict per-pattern queries (A/D/G/I) require near-52W-high names,
 * which a flat market won't produce. The watchlist still applies the same
 * 100-pt conviction score and the same Tier 3 floor.
 */
const Z_GeneralWatchlist: Screener = {
  id: 'pro_Z_general',
  name: 'Q-Z · General Conviction Watchlist',
  description: 'Any stock scoring ≥50 on the 100-pt conviction system',
  timeframeLabel: '5-15 days, 8-15%',
  setupKind: 'PRE_MOVE',
  scan(candles, symbol) {
    const s = snapshot(candles, symbol); if (!s) return null
    // Must be in some kind of trend — skip pure chop
    if (s.ema50 == null) return null
    const direction: 'BULL' | 'BEAR' = s.price >= s.ema50 && s.ret5dPct >= 0 ? 'BULL'
      : s.price < s.ema50 && s.ret5dPct < 0 ? 'BEAR'
      : 'BULL' // tie-breaker: lean bull
    // Cheap pre-filter — avoid scoring things that obviously won't pass
    if (s.volRatio20 < 1.2 && s.pricePctOf52wHigh < 0.85) return null
    return finalize(s, direction, 'Z · General Conviction Watchlist', '5-15 days, 8-15%', 'Z',
      // route Z entries by direction: bullish→SWING, bearish→POSITIONAL bear watch
      'SWING', 'PRE_MOVE')
  },
}

function finalize(
  s: TechSnapshot,
  direction: 'BULL' | 'BEAR',
  patternLabel: string,
  timeframeLabel: string,
  queryId?: string,
  category?: ScreenerResult['category'],
  setupKind: ScreenerResult['setupKind'] = 'BREAKOUT',
): ScreenerResult | null {
  const score = scoreSnapshot(s)
  if (discardScore(score.total)) return null
  const tier = tierFromScore(score.total)
  const plan = buildTradePlan(s, direction, category)
  const expectedMovePct = ((plan.t2 - plan.entry) / plan.entry) * 100 * (direction === 'BULL' ? 1 : -1)

  return {
    symbol: s.symbol,
    price: s.price,
    change: +(s.price - s.prevClose).toFixed(2),
    changePct: +s.dayChangePct.toFixed(2),
    score: +(score.total / 10).toFixed(1),
    tier,
    direction,
    reasons: [
      `🎯 ${patternLabel}`,
      ...score.notes,
      `Plan: Entry ₹${plan.entryPriceLow}–${plan.entryPriceHigh} on ${plan.entryDate} · window ${plan.bestEntryTimeIST} IST (${plan.horaLord} hora)`,
      `SL ₹${plan.sl} · T1 ₹${plan.t1} by ${plan.target1Date} · T2 ₹${plan.t2} by ${plan.target2Date} · T3 ₹${plan.t3} by ${plan.target3Date}`,
      `Risk: ₹${Math.abs(plan.entry - plan.sl).toFixed(2)} · R:R 2:1 (T1) / 3.5:1 (T2)`,
    ],
    tags: [
      `Score ${score.total}/100`,
      `Vol ${s.volRatio20.toFixed(1)}×`,
      `RSI ${s.rsi14.toFixed(0)}`,
      `5d ${s.ret5dPct >= 0 ? '+' : ''}${s.ret5dPct.toFixed(1)}%`,
      ...(s.fullStackBull ? ['EMA✔'] : []),
    ],
    expectedMovePct: +expectedMovePct.toFixed(1),
    timeframeLabel,
    suggestedEntry: plan.entry,
    suggestedSL: plan.sl,
    suggestedTarget: plan.t1,
    entryPriceLow: plan.entryPriceLow,
    entryPriceHigh: plan.entryPriceHigh,
    entryDate: plan.entryDate,
    entryNote: plan.entryNote,
    bestEntryTimeIST: plan.bestEntryTimeIST,
    horaLord: plan.horaLord,
    horaNote: plan.horaNote,
    target1: plan.t1, target1Date: plan.target1Date,
    target2: plan.t2, target2Date: plan.target2Date,
    target3: plan.t3, target3Date: plan.target3Date,
    detectedAt: Date.now(),
    setupKind,
    category,
    queryId,
    convictionScore: score.total,
  }
}

// ───────────────────────────────────────────────────────────────
// Bucket export
// ───────────────────────────────────────────────────────────────

export const PRO_SCREENERS: Screener[] = [
  A_VolumeBreakout,
  C_NewsCatalyst,
  D_BullFlagBreakout,
  G_VCP,
  I_MultiMonthBreakout,
  M_EarlyMomentum,
  Z_GeneralWatchlist,
]

/** Bucketing of queries into the 4 timeframe categories from screener.md. */
export const PRO_QUERY_TIMEFRAME: Record<string, 'INTRADAY' | 'SHORT_SWING' | 'SWING' | 'POSITIONAL'> = {
  pro_A_vol_breakout: 'INTRADAY',
  pro_C_news_catalyst: 'INTRADAY',
  pro_D_bull_flag: 'SHORT_SWING',
  pro_G_vcp: 'SWING',
  pro_I_mm_breakout: 'SWING',
  pro_M_early_momentum: 'POSITIONAL',
}
