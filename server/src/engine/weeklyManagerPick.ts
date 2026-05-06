import fs from 'fs/promises'
import path from 'path'
import * as data from '../data'
import { ema, lastATR, lastRSI, adx, macd } from '../indicators'
import { analyzeSMC } from '../patterns/smc'
import { gannBiasFor } from '../gann'
import { astroBiasFor } from '../astro'
import { getMarketRegime } from './marketRegime'
import { addDays } from '../util/time'
import { log } from '../util/logger'
import { sessionHoras, horaAt } from '../astro/parashariHora'
import { logSignal } from './signalLogger'
import type { Signal } from '../types'

/**
 * Weekly Manager Pick.
 *
 * Curates a 6-week trading list (target ≥20% by end of horizon) by combining:
 *   1. Smart Money Concept (BOS / CHoCH / order-block / liquidity sweeps)
 *   2. Time Cycle (Gann date hits within the next 30 sessions)
 *   3. Gann Cycle (price-at-Square-of-9 levels)
 *   4. Vedic / Mundane Astro bias (Jupiter/Saturn/Mars cycles)
 *   5. Order-flow proxy (volume burst vs 60-day avg + EMA stack)
 *
 * Inputs:  watchlist (user-supplied) + universe override (default NIFTY100)
 * Output:  ranked picks with entry zone + 3 targets + target dates
 *
 * Persistence: server/data/weekly-picks/<YYYY-MM-DD-week>.json
 * Cron: every Sunday 18:00 IST
 */

const DATA_DIR = path.resolve(__dirname, '../../data')
const PICKS_DIR = path.join(DATA_DIR, 'weekly-picks')
const WATCHLIST_FILE = path.join(DATA_DIR, 'weekly-watchlist.json')
const HORIZON_TRADING_DAYS = 28               // ~6 weeks
const TARGET1_PCT = 8
const TARGET2_PCT = 14
const TARGET3_PCT = 22
const STOP_ATR_MULT = 2.0

// Default user-supplied watchlist (can be edited via the dashboard)
// 2026-05-03: User clarified they NEVER set a watchlist — the prior names
// here were us auto-pinning past movers, which fossilises stale picks. Empty
// list means every weekly pick is 100% fresh-discovery from the full market
// scan. The auto-rebuilder writes to the persisted file; if the user wants to
// pin names manually they edit data/weekly-watchlist.json.
const DEFAULT_WATCHLIST: string[] = []

export interface PickRow {
  symbol: string
  ltp: number
  ltpSource: 'live' | 'eod'        // 'live' = live quote API · 'eod' = stale daily close
  ltpAsOf: string                  // ISO timestamp of the LTP
  conviction: number              // 0-100
  direction: 'BUY' | 'SHORT'
  // Entry plan
  entryPrice: number
  entryPriceLow: number
  entryPriceHigh: number
  entryDate: string               // YYYY-MM-DD — best time-window start
  entryNote: string               // "buy on dip to ₹X" / "buy at open Mon"
  bestEntryTimeIST: string        // HH:MM-HH:MM — hora-aligned intraday slot
  horaLord: string                // Jupiter / Sun / Saturn / ...
  horaNote: string                // "Jupiter hora · BULLISH"
  // Targets
  target1: number; target1Date: string
  target2: number; target2Date: string
  target3: number; target3Date: string
  expectedReturnPct: number       // T3 % from entry
  // Risk
  stopLoss: number
  riskRewardRatio: number
  // Reasoning (each strand of the 5 lenses)
  smcNote: string
  trendNote: string
  gannNote: string
  astroNote: string
  flowNote: string                // order-flow proxy summary
  // 2026-05-03: per-lens score breakdown so user can audit WHY a stock made
  // the cut (transparency vs black-box conviction number).
  smcScore: number                // 0-25
  trendScore: number              // 0-20
  gannScore: number               // 0-15 (or vol-profile for micro-caps)
  astroScore: number              // 0-15 (or RS-rating for micro-caps)
  flowScore: number               // 0-25
  // Pump-and-dump risk surfaced explicitly so user can skip names like
  // Gensol Engineering before they blow up.
  pumpRisk: number                // 0-100
  pumpRiskReasons: string[]
  // 2026-05-04: NO-BRAINER anchor — fires when FII infusing + promoter
  // stable/up + pledge < 5%. Surfaces with ⭐ in dispatch + sorts to top.
  noBrainerBet: boolean
  shareholdingNote: string        // human-readable summary for dashboard
  // Source
  source: 'WATCHLIST' | 'CURATED'
}

export interface WeeklyPick {
  weekOf: string                 // ISO date of the Monday this list applies to
  generatedAt: string
  regime: string
  watchlistInput: string[]
  rows: PickRow[]
  notes: string[]                // top-level commentary lines
}

// ─── Watchlist persistence ─────────────────────────────────────

export async function getWatchlist(): Promise<string[]> {
  try {
    const raw = await fs.readFile(WATCHLIST_FILE, 'utf8')
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.every(s => typeof s === 'string')) return arr
  } catch { /* not yet saved */ }
  return DEFAULT_WATCHLIST
}

export async function setWatchlist(symbols: string[]): Promise<string[]> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const cleaned = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))]
  await fs.writeFile(WATCHLIST_FILE, JSON.stringify(cleaned, null, 2), 'utf8')
  return cleaned
}

/**
 * Auto-rebuild watchlist from yesterday's top momentum movers.
 *
 * Why (2026-05-02): the hard-coded 17-name DEFAULT_WATCHLIST is months-stale
 * — none of the 25%-movers in the user's 20-30 Apr screenshot were on it.
 * This routine pulls the top N gainers (≥3% daily, ≥₹2cr median turnover)
 * from NSE_ALL and persists them as the new watchlist. Keeps the user's
 * manually-pinned names (the prefix in the existing file) and appends the
 * fresh momentum names up to a 50-symbol cap.
 */
export async function autoRebuildWatchlist(opts: {
  pinned?: string[]                  // user's existing names to keep
  minDailyPct?: number               // default 3
  minMedianTurnoverCr?: number       // default 2 (₹2cr)
  cap?: number                       // default 50
} = {}): Promise<string[]> {
  const minPct = opts.minDailyPct ?? 3
  const minTurnoverCr = opts.minMedianTurnoverCr ?? 2
  const cap = opts.cap ?? 50
  const { resolveUniverse } = await import('../screeners/universe')
  const universe = await resolveUniverse('NSE_ALL')

  type Mover = { sym: string; pct: number; medTurnover: number }
  const movers: Mover[] = []
  let cursor = 0
  const dataMod = await import('../data')
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      try {
        const c = await dataMod.getCandles(sym, '1D', 30)
        if (c.length < 25) continue
        const last = c[c.length - 1]
        const prev = c[c.length - 2]
        const pct = ((last.close - prev.close) / prev.close) * 100
        if (Math.abs(pct) < minPct) continue
        const turnovers = c.slice(-20).map(b => (b.volume * b.close) / 1e7)   // ₹cr
          .filter(t => t > 0).sort((a, b) => a - b)
        const medT = turnovers[Math.floor(turnovers.length / 2)] ?? 0
        if (medT < minTurnoverCr) continue
        movers.push({ sym, pct, medTurnover: medT })
      } catch { /* skip */ }
    }
  }))
  movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
  const fresh = movers.slice(0, cap).map(m => m.sym)
  const pinned = opts.pinned ?? []
  const merged = [...new Set([...pinned, ...fresh])].slice(0, cap)
  await setWatchlist(merged)
  log.ok('PICK', `Watchlist auto-rebuilt: ${merged.length} names (${pinned.length} pinned + ${merged.length - pinned.length} momentum). Top movers: ${fresh.slice(0, 5).join(', ')}`)
  return merged
}

// ─── Pick generation ──────────────────────────────────────────

/** Date helpers — IST trading-day projection. Weekends skipped naively. */
function projectBusinessDate(from: Date, tradingDays: number): string {
  let d = new Date(from)
  let added = 0
  while (added < tradingDays) {
    d = addDays(d, 1)
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) added++
  }
  return d.toISOString().slice(0, 10)
}

function weekOfMonday(d: Date = new Date()): string {
  const x = new Date(d)
  const dow = x.getUTCDay()
  const monOffset = dow === 0 ? 1 : (1 - dow + 7) % 7   // next Monday
  x.setUTCDate(x.getUTCDate() + monOffset)
  return x.toISOString().slice(0, 10)
}

interface ScoreParts {
  smc: number
  trend: number
  gann: number
  astro: number
  flow: number
  total: number
  notes: { smc: string; trend: string; gann: string; astro: string; flow: string }
  // 2026-05-03: emit direction directly from the scorer so the cross-check
  // guard doesn't need to re-derive it from smc.bias (which the scoreSymbol
  // function returns, not just stores in notes).
  direction: 'BUY' | 'SHORT'
  // Pump-and-dump risk score (0-100). Higher = more likely a pump (parabolic
  // run, low float, no fundamentals, vol spike on retail flow). Surfaced on
  // the pick row so the user can vet quality.
  pumpRisk: number
  pumpRiskReasons: string[]
}

/**
 * Micro-cap detection: anything outside the curated NIFTY_500_CORE list (the
 * 500 large/mid-caps we trust for the 5-lens). For names like Adisoft,
 * Cemindia Projects, Mach Conferences, MTAR — Gann/Astro lenses contribute
 * near-zero (those are designed for liquid index/large-cap), so we swap them
 * for a Volume-Profile + Relative-Strength momentum lens that actually fires
 * on the right universe. Threshold to qualify for the curated list is also
 * lower (45 vs 60) since the alt-lens is more conservatively scored.
 */
function isMicroCap(symbol: string): boolean {
  // Lazy require to avoid the universe loading before SCAN module is ready
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NIFTY_500_CORE } = require('../screeners/universe')
  return !NIFTY_500_CORE.includes(symbol.toUpperCase())
}

function scoreSymbol(symbol: string, candlesD: import('../types').Candle[], today: Date): ScoreParts | null {
  if (candlesD.length < 80) return null
  const last = candlesD[candlesD.length - 1]
  const e9 = ema(candlesD, 9)[ema(candlesD, 9).length - 1]
  const e21 = ema(candlesD, 21)[ema(candlesD, 21).length - 1]
  const e50 = ema(candlesD, 50)[ema(candlesD, 50).length - 1]
  const e200 = ema(candlesD, 200)[ema(candlesD, 200).length - 1]
  const r = lastRSI(candlesD, 14) ?? 50
  const a = adx(candlesD, 14)
  const m = macd(candlesD)
  const smc = analyzeSMC(candlesD)

  // Volume burst as order-flow proxy
  const vol1 = last.volume
  const vol60Avg = candlesD.slice(-61, -1).reduce((s, c) => s + c.volume, 0) / 60
  const volRatio = vol60Avg > 0 ? vol1 / vol60Avg : 0

  // 1) SMC (max 25)
  let smcScore = 0
  let smcNote = `bias ${smc.bias.toLowerCase()}`
  if (smc.bias === 'BULLISH') { smcScore += 15; smcNote = `BULLISH ${smc.note}` }
  else if (smc.bias === 'BEARISH') { smcScore += 15; smcNote = `BEARISH ${smc.note}` }
  if (smc.bosBull || smc.bosBear) { smcScore += 5; smcNote += ' · BOS' }
  if (smc.chochBull || smc.chochBear) { smcScore += 5; smcNote += ' · CHoCH' }

  // 2) Trend stack (max 20).
  // 2026-05-03 tuning: stackBear bonus dropped 15 → 10 because the Indian
  // market has a structural bull bias — symmetric weighting was issuing too
  // many false-positive SHORTs (verify-vs-movers showed 25% SHORT hit rate
  // vs 75% BUY hit rate). Bears must clear a higher bar to qualify.
  let trendScore = 0
  const stackBull = e9 > e21 && e21 > e50 && e50 > e200
  const stackBear = e9 < e21 && e21 < e50 && e50 < e200
  let trendNote = ''
  if (stackBull) { trendScore += 15; trendNote = 'EMA 9>21>50>200 stacked bullish' }
  else if (stackBear) { trendScore += 10; trendNote = 'EMA 9<21<50<200 stacked bearish (capped)' }
  else trendNote = `EMA mixed (price ${last.close > e50 ? '>' : '<'} 50-EMA)`
  if (a && a.adx >= 22) { trendScore += 5; trendNote += ` · ADX ${a.adx.toFixed(0)} strong` }
  if (m && Math.abs(m.histogram) > 0) trendScore += 0   // already implicit via stack
  if (r >= 55 && r <= 70) trendScore += 0   // counted under flow

  // 3 & 4) For LARGE-CAPS (NIFTY 500 core): Gann + Astro lenses (max 15 each).
  //        For MICRO/SME caps: substitute Volume-Profile high-concentration +
  //        Relative-Strength rating + 20d momentum — those actually score on
  //        names like Adisoft / MTAR / Meesho that Gann+Astro miss entirely.
  const microCap = isMicroCap(symbol)
  let gannScore = 0, astroScore = 0
  let gannNote = '', astroNote = ''

  if (!microCap) {
    // Standard 5-lens: Gann
    const gann = gannBiasFor(symbol, last.close, today)
    const next30dCycles = (gann.nextCycles ?? []).filter(c => c.daysAway >= 0 && c.daysAway <= 30)
    if (next30dCycles.length) { gannScore += 10 }
    if (gann.timeCycleHit) gannScore += 5
    if (gann.priceAtGannLevel) gannScore += 5
    gannNote = next30dCycles.length
      ? `Gann cycle ${next30dCycles[0].name} in ${next30dCycles[0].daysAway}d (${next30dCycles[0].importance})`
      : 'No Gann cycle within 30 days'

    // Astro
    const astro = astroBiasFor(today)
    if (astro.bullish) astroScore += 10
    else if (astro.bearish) astroScore += 10
    if (Math.abs(astro.strength) > 0.4) astroScore += 5
    astroNote = astro.note
  } else {
    // MICRO/SME alt-lens: Volume-Profile (POC concentration) + RS rating
    // ── Volume-Profile lens (max 15): how concentrated is recent volume
    //    near the current price? Tight POC + price holding above POC = strong
    //    institutional accumulation. We bucket the last 60 daily highs/lows
    //    into 30 price slots and find the slot with most volume (POC).
    const recent = candlesD.slice(-60)
    const minP = Math.min(...recent.map(c => c.low))
    const maxP = Math.max(...recent.map(c => c.high))
    const slot = (maxP - minP) / 30
    const buckets = new Array<number>(30).fill(0)
    for (const c of recent) {
      const mid = (c.high + c.low) / 2
      const idx = Math.max(0, Math.min(29, Math.floor((mid - minP) / Math.max(slot, 1e-6))))
      buckets[idx] += c.volume
    }
    const totalVol = buckets.reduce((s, v) => s + v, 0)
    const pocIdx = buckets.reduce((bi, v, i, a) => v > a[bi] ? i : bi, 0)
    const pocVol = buckets[pocIdx]
    const pocConcentration = totalVol > 0 ? pocVol / totalVol : 0
    const pocPrice = minP + (pocIdx + 0.5) * slot
    if (pocConcentration >= 0.18) gannScore += 10            // tight POC = institutional zone
    else if (pocConcentration >= 0.12) gannScore += 6
    if (last.close >= pocPrice * 0.99) gannScore += 5         // holding above POC
    gannNote = `POC ${pocPrice.toFixed(2)} (${(pocConcentration * 100).toFixed(0)}% vol) · ${last.close >= pocPrice ? 'above' : 'below'}`

    // ── Relative-Strength lens (max 15): 20d return vs Nifty equivalent.
    //    Without a benchmark candle handy, we use the symbol's own 60d
    //    median return as a proxy: stocks running far ahead of their own
    //    median have very high RS. Plus 20-day price acceleration.
    const ref20 = candlesD[candlesD.length - 21]?.close ?? last.close
    const ret20 = (last.close - ref20) / ref20
    const med60Ret = (() => {
      const rets: number[] = []
      for (let i = candlesD.length - 60; i < candlesD.length; i++) {
        const a = candlesD[i - 1]?.close ?? candlesD[i].close
        rets.push((candlesD[i].close - a) / a)
      }
      rets.sort((a, b) => a - b)
      return rets[Math.floor(rets.length / 2)] ?? 0
    })()
    const rsZ = (ret20 - med60Ret * 20) / Math.max(0.005, Math.abs(med60Ret * 20) || 0.05)
    if (rsZ >= 1.5) astroScore += 10
    else if (rsZ >= 0.8) astroScore += 6
    else if (rsZ <= -1.5) astroScore += 10                    // shortable RS-laggard
    if (Math.abs(ret20) >= 0.10) astroScore += 5              // 10%+ in 20d = real run
    astroNote = `RS-z ${rsZ.toFixed(2)} · 20d ${(ret20 * 100).toFixed(1)}% (med60 ${(med60Ret * 100 * 20).toFixed(1)}%)`
  }

  // 5) Order-flow proxy (max 25): volume burst + RSI in zone + price acceleration
  let flowScore = 0
  if (volRatio >= 2.0) flowScore += 15
  else if (volRatio >= 1.5) flowScore += 10
  else if (volRatio >= 1.2) flowScore += 5
  if (r >= 55 && r <= 72) flowScore += 5
  else if (r >= 30 && r <= 45) flowScore += 5     // potential reversal zone
  // 5-day momentum
  const ref5 = candlesD[candlesD.length - 6]?.close ?? last.close
  const mom5 = ((last.close - ref5) / ref5) * 100
  if (Math.abs(mom5) >= 3) flowScore += 5
  const flowNote = `vol ${volRatio.toFixed(1)}× 60d · RSI ${r.toFixed(0)} · 5d ${mom5 >= 0 ? '+' : ''}${mom5.toFixed(1)}%`

  const total = Math.min(100, smcScore + trendScore + gannScore + astroScore + flowScore)

  // Direction: BEARISH SMC + below EMA50 = SHORT, otherwise BUY.
  const direction: 'BUY' | 'SHORT' = (smc.bias === 'BEARISH' || (!stackBull && last.close < e50))
    ? 'SHORT' : 'BUY'

  // ── PUMP-AND-DUMP RISK SCORER ──
  // 2026-05-03: user concern after Gensol-class blowup risk. Flag pumps with:
  //   1. Parabolic 5d return (>40% in 5 sessions = late-stage pump)
  //   2. 30d return >100% (multi-week pump - exhausted)
  //   3. Single-day gap >12% on volume spike (FOMO / news pump)
  //   4. RSI >85 (extreme overbought, mean-reversion imminent)
  //   5. Penny-stock + thin avg volume <50k (manipulation-prone)
  //   6. Distance from 50-EMA >35% (parabolic detachment)
  //   7. Last bar's range >2.5× ATR + close in lower 1/3 (climactic top)
  let pumpRisk = 0
  const pumpReasons: string[] = []
  if (mom5 > 40) { pumpRisk += 25; pumpReasons.push(`parabolic +${mom5.toFixed(0)}% in 5d`) }
  const ref30 = candlesD[candlesD.length - 31]?.close
  if (ref30) {
    const mom30 = ((last.close - ref30) / ref30) * 100
    if (mom30 > 100) { pumpRisk += 20; pumpReasons.push(`30d +${mom30.toFixed(0)}% (exhaustion zone)`) }
  }
  const prevBar = candlesD[candlesD.length - 2]
  if (prevBar) {
    const gapPct = ((last.close - prevBar.close) / prevBar.close) * 100
    if (gapPct > 12 && volRatio > 3) { pumpRisk += 15; pumpReasons.push(`+${gapPct.toFixed(1)}% gap on ${volRatio.toFixed(1)}× vol`) }
  }
  if (r > 85) { pumpRisk += 15; pumpReasons.push(`RSI ${r.toFixed(0)} extreme`) }
  if (last.close < 20 && vol60Avg < 50_000) { pumpRisk += 10; pumpReasons.push(`penny stock, thin avg vol ${(vol60Avg/1000).toFixed(0)}k`) }
  if (e50 && last.close > e50 * 1.35) { pumpRisk += 15; pumpReasons.push(`+${(((last.close/e50)-1)*100).toFixed(0)}% above 50-EMA (parabolic)`) }
  const atrV = last.high - last.low
  if (atrV > 0) {
    // crude bar ATR — see if today's range is climactic
    const atr14sum = candlesD.slice(-15, -1).reduce((s, c) => s + (c.high - c.low), 0) / 14
    const lowerThird = last.low + (last.high - last.low) / 3
    if (atrV > 2.5 * atr14sum && last.close < lowerThird) {
      pumpRisk += 20; pumpReasons.push('climactic-top bar (range 2.5× ATR + close in lower 3rd)')
    }
  }
  pumpRisk = Math.min(100, pumpRisk)

  return {
    smc: smcScore, trend: trendScore, gann: gannScore, astro: astroScore, flow: flowScore, total,
    notes: { smc: smcNote, trend: trendNote, gann: gannNote, astro: astroNote, flow: flowNote },
    direction, pumpRisk, pumpRiskReasons: pumpReasons,
  }
}

function buildPickRow(
  symbol: string,
  candlesD: import('../types').Candle[],
  scoring: ScoreParts,
  source: PickRow['source'],
  today: Date,
  liveLtp: number | null,           // live quote — overrides stale daily close
): PickRow {
  const last = candlesD[candlesD.length - 1]
  // CRITICAL: daily candles only tick at EOD. During the session, the latest
  // daily "close" is yesterday's close. Use the live LTP from the quote API
  // when available; fall back to the daily close only when offline.
  const ltp = liveLtp != null && liveLtp > 0 ? +liveLtp.toFixed(2) : +last.close.toFixed(2)
  const atr = lastATR(candlesD, 14) ?? ltp * 0.02
  const e21 = ema(candlesD, 21)[ema(candlesD, 21).length - 1]

  // Direction from SMC bias + EMA stack
  const smc = analyzeSMC(candlesD)
  const e9 = ema(candlesD, 9)[ema(candlesD, 9).length - 1]
  const e50 = ema(candlesD, 50)[ema(candlesD, 50).length - 1]
  const stackBull = e9 > e21 && e21 > e50
  const direction: 'BUY' | 'SHORT' = (smc.bias === 'BEARISH' || (!stackBull && ltp < e50))
    ? 'SHORT'
    : 'BUY'

  // Entry — preferred at pullback to EMA21 if price > EMA21 (bull) or rally to EMA21 (bear)
  const entryPrice = direction === 'BUY'
    ? +Math.min(ltp, Math.max(e21, ltp * 0.985)).toFixed(2)
    : +Math.max(ltp, Math.min(e21, ltp * 1.015)).toFixed(2)
  const band = Math.max(entryPrice * 0.005, 0.5)
  const entryPriceLow = +(direction === 'BUY' ? entryPrice - band : entryPrice).toFixed(2)
  const entryPriceHigh = +(direction === 'BUY' ? entryPrice : entryPrice + band).toFixed(2)

  // Targets in % terms (mirrored for SHORT)
  const sign = direction === 'BUY' ? 1 : -1
  const t1 = +(entryPrice * (1 + sign * TARGET1_PCT / 100)).toFixed(2)
  const t2 = +(entryPrice * (1 + sign * TARGET2_PCT / 100)).toFixed(2)
  const t3 = +(entryPrice * (1 + sign * TARGET3_PCT / 100)).toFixed(2)
  // ── SL placement — TIER-AWARE Wyckoff-aware buffer ──
  // 2026-05-04: 8% blanket cap was too wide for liquid mid/large-caps where
  // 4-5% is normal swing-trade SL. New rules:
  //   • NIFTY-500 / mid-large cap: SL cap 5% (tight, matches institutional
  //     swing-trade discipline; momentum reversal on liquid names rarely
  //     exceeds 5% before invalidating)
  //   • Liquid small-cap (≥₹2 Cr/day turnover): cap 6.5%
  //   • Micro-cap: cap 8% (volatility tolerance)
  //
  // Base SL still uses max(1.8× ATR, recent 5-bar low - 1%). Just clamps
  // tighter for liquid names so R:R is respectable on swing horizons.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NIFTY_500_CORE: NIFTY_500_CORE_FOR_SL } = require('../screeners/universe')
  const inN500 = NIFTY_500_CORE_FOR_SL.includes(symbol.toUpperCase())
  const avgTurnoverCr = candlesD.slice(-60).reduce((s, c) => s + c.close * c.volume, 0) / 60 / 1e7
  const slCapPct = inN500 ? 0.05
    : avgTurnoverCr >= 2 ? 0.065
    : 0.08
  const cluster5Low = Math.min(...candlesD.slice(-5).map(c => c.low))
  const cluster5High = Math.max(...candlesD.slice(-5).map(c => c.high))
  const wideStopBuy = Math.min(
    entryPrice - 1.8 * atr,                // tightened from 2.2× to 1.8× ATR
    cluster5Low * 0.99,                    // 1% below recent 5-bar low (was 1.5%)
  )
  const wideStopShort = Math.max(
    entryPrice + 1.8 * atr,
    cluster5High * 1.01,
  )
  const maxSlDist = entryPrice * slCapPct
  const slRaw = direction === 'BUY' ? wideStopBuy : wideStopShort
  const slClamped = direction === 'BUY'
    ? Math.max(slRaw, entryPrice - maxSlDist)
    : Math.min(slRaw, entryPrice + maxSlDist)
  const stopLoss = +slClamped.toFixed(2)
  const risk = Math.abs(entryPrice - stopLoss)
  const reward1 = Math.abs(t1 - entryPrice)
  const rr = +(reward1 / Math.max(risk, 0.01)).toFixed(2)

  // Date projection — T1 ~10 days, T2 ~20 days, T3 ~28 days
  const entryDate = projectBusinessDate(today, 1)
  const target1Date = projectBusinessDate(today, 10)
  const target2Date = projectBusinessDate(today, 20)
  const target3Date = projectBusinessDate(today, HORIZON_TRADING_DAYS)

  // Parashari hora for the entry day. Gives a concrete 30-60 min slot the
  // trader can target (matches the styling the user validated for Marksans
  // / Moschip / Moldtek).
  const entryDayDate = new Date(entryDate + 'T04:00:00.000Z')    // ~09:30 IST
  const horas = sessionHoras(entryDayDate)
  const wantsBull = direction === 'BUY'
  const aligned = horas.find(h => wantsBull ? h.bias === 'BULLISH' : h.bias === 'BEARISH')
  const pick = aligned ?? horas.find(h => h.bias === 'VOLATILE') ?? horas[0] ?? horaAt(entryDayDate)
  const bestEntryTimeIST = `${pick.startIST}-${pick.endIST}`
  const horaLord = pick.lord
  const horaNote = `${pick.lord} hora · ${pick.bias}`

  const ltpSource: 'live' | 'eod' = liveLtp != null && liveLtp > 0 ? 'live' : 'eod'
  const ltpAsOf = ltpSource === 'live'
    ? new Date().toISOString()
    : new Date(last.time).toISOString()

  return {
    symbol,
    ltp,
    ltpSource,
    ltpAsOf,
    conviction: scoring.total,
    direction,
    entryPrice,
    entryPriceLow,
    entryPriceHigh,
    entryDate,
    entryNote: direction === 'BUY'
      ? `Buy ${entryPriceLow}–${entryPriceHigh} on dip (≈ EMA21). Trigger ${bestEntryTimeIST} IST.`
      : `Short ${entryPriceLow}–${entryPriceHigh} on rally (≈ EMA21). Trigger ${bestEntryTimeIST} IST.`,
    bestEntryTimeIST, horaLord, horaNote,
    target1: t1, target1Date,
    target2: t2, target2Date,
    target3: t3, target3Date,
    expectedReturnPct: TARGET3_PCT * sign,
    stopLoss,
    riskRewardRatio: rr,
    smcNote: scoring.notes.smc,
    trendNote: scoring.notes.trend,
    gannNote: scoring.notes.gann,
    astroNote: scoring.notes.astro,
    flowNote: scoring.notes.flow,
    smcScore: scoring.smc,
    trendScore: scoring.trend,
    gannScore: scoring.gann,
    astroScore: scoring.astro,
    flowScore: scoring.flow,
    pumpRisk: scoring.pumpRisk,
    pumpRiskReasons: scoring.pumpRiskReasons,
    // Defaults — overwritten by enrichWithShareholding() after the async
    // NSE fetch completes. Synchronous buildPickRow can't await network calls.
    noBrainerBet: false,
    shareholdingNote: '',
    source,
  }
}

/** Run the full weekly pick — watchlist (always evaluated) + curated NIFTY100 sweep. */
export async function runWeeklyPick(extraUniverseKey?: 'NIFTY100' | 'CNX500' | 'NSE_ALL' | 'MARKET_ALL'): Promise<WeeklyPick> {
  log.info('PICK', 'Weekly Manager Pick starting...')
  const today = new Date()
  const watchlist = await getWatchlist()
  const regime = await getMarketRegime().catch(() => null)

  const rows: PickRow[] = []
  const seenSymbols = new Set<string>()

  // Always include the user watchlist — even if conviction < 50, we score
  // every name so the user sees their chosen names with reasoning. Mark
  // source='WATCHLIST'.
  for (const sym of watchlist) {
    seenSymbols.add(sym)
    try {
      // Fetch daily candles + live LTP in parallel. Live LTP overrides the
      // stale daily-close in `buildPickRow` so the table reflects market.
      const [candlesD, quote] = await Promise.all([
        data.getCandles(sym, '1D', 300),
        data.getQuote(sym).catch(() => null),
      ])
      if (candlesD.length < 80) {
        log.warn('PICK', `${sym}: only ${candlesD.length} daily candles, skipped`)
        continue
      }
      const scoring = scoreSymbol(sym, candlesD, today)
      if (!scoring) continue
      rows.push(buildPickRow(sym, candlesD, scoring, 'WATCHLIST', today, quote?.price ?? null))
    } catch (e) {
      log.warn('PICK', `${sym}: ${(e as Error).message}`)
    }
  }

  // Curated sweep. 2026-05-02 widening: default universe is now NSE_ALL
  // (~1,900 names) so Adisoft / MTAR / Meesho / RPGLIFE-class movers can
  // surface — those weren't even visible to the prior NIFTY100 default.
  // To keep cost down we PRE-RANK the universe by 5-day momentum × volume
  // burst (cheap — uses the daily candles we already fetch) and only run the
  // expensive 5-lens scorer on the top 250 candidates.
  // 2026-05-03: default widened from NSE_ALL → MARKET_ALL (NSE + BSE merged
  // ScripMaster). The user's 25%-mover list (Adisoft, Cemindia, Pentokey,
  // BCC Fuba, Yunik, Saakshi, Roni, Mauria, Vani, Hathway-Bhawani etc.) is
  // mostly BSE-listed micro/small-caps that NSE_ALL never reached.
  const { resolveUniverse } = await import('../screeners/universe')
  const universeKey = extraUniverseKey ?? 'MARKET_ALL'
  const fullUniverse = (universeKey === 'NIFTY100')
    ? await resolveUniverse('NIFTY50').then(async n50 => [...n50, ...await resolveUniverse('NEXT50')])
    : await resolveUniverse(universeKey)

  // ── Pre-rank pass (cheap, daily-only) ──
  log.info('PICK', `Pre-ranking ${fullUniverse.length} symbols (universe=${universeKey})`)
  type Prerank = { symbol: string; mom5: number; volBurst: number; rank: number; candles: import('../types').Candle[] }
  const prerank: Prerank[] = []
  let pCursor = 0
  // Bump shortlist cap with universe size: 250 for curated, 500 for NSE_ALL,
  // 800 for MARKET_ALL — matches the ~3× bigger universe.
  const TOP_N = universeKey === 'MARKET_ALL' ? 800
    : universeKey === 'NSE_ALL' ? 500
    : Math.min(250, fullUniverse.length)
  // 2026-05-04: bias prerank to NIFTY 500 (institutional-grade names) — user
  // feedback was "none of these are well-known companies, no investment
  // discussion anywhere." Pure-momentum ranking surfaces obscure micro-caps
  // (CELLA, NATHUEC etc.) over recognised mid-caps. Solution: 2× rank
  // multiplier for NIFTY-500 members so they dominate the top-800 shortlist
  // unless a microcap is genuinely exploding. ALSO require ₹2Cr+ daily
  // turnover — that's the floor for institutional liquidity / executable size.
  const { NIFTY_500_CORE } = require('../screeners/universe')
  const nifty500Set = new Set<string>(NIFTY_500_CORE.map((s: string) => s.toUpperCase()))
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pCursor < fullUniverse.length) {
      const sym = fullUniverse[pCursor++]
      if (seenSymbols.has(sym)) continue
      try {
        const candlesD = await data.getCandles(sym, '1D', 80)
        if (candlesD.length < 60) continue
        const last = candlesD[candlesD.length - 1]
        const ref5 = candlesD[candlesD.length - 6]?.close ?? last.close
        const mom5 = ((last.close - ref5) / ref5) * 100
        const v60 = candlesD.slice(-61, -1).reduce((s, c) => s + c.volume, 0) / 60
        const volBurst = v60 > 0 ? last.volume / v60 : 0
        // Avg daily turnover (close × volume) over last 60 sessions — this is
        // what institutional desks look at: ₹2 Cr+ means the position can be
        // executed without moving the price. Below ₹50L is operator territory.
        const avgTurnoverCr = candlesD.slice(-60).reduce((s, c) => s + c.close * c.volume, 0) / 60 / 1e7
        if (last.volume < 1_000) continue
        if (avgTurnoverCr < 0.5) continue              // ₹50L floor (was none)
        const baseRank = Math.abs(mom5) * 0.6 + volBurst * 4
        // 2× rank for NIFTY-500 names, 1.3× for liquid (₹5Cr+ turnover),
        // 1× for everyone else. Microcap with massive momentum still ranks
        // but has to clear a higher bar than a NIFTY-500 name with moderate
        // momentum.
        const visibilityMult = nifty500Set.has(sym.toUpperCase()) ? 2.0
          : avgTurnoverCr >= 5 ? 1.3
          : 1.0
        const rank = baseRank * visibilityMult
        prerank.push({ symbol: sym, mom5, volBurst, rank, candles: candlesD, avgTurnoverCr } as any)
      } catch { /* skip */ }
    }
  }))
  prerank.sort((a, b) => b.rank - a.rank)
  const shortlist = prerank.slice(0, TOP_N)
  log.ok('PICK', `Shortlist: top ${shortlist.length} by 5d-mom × vol-burst (e.g. ${shortlist.slice(0, 5).map(p => `${p.symbol}+${p.mom5.toFixed(1)}%`).join(', ')})`)

  // ── 5-lens scoring on shortlist (with screener cross-check guard) ──
  // 2026-05-03: verify-vs-movers showed 25% SHORT hit rate vs 75% BUY hit
  // rate. Root cause: the conviction scorer issued SHORT calls while the
  // pre-move screener set fired BULLISH patterns on the same bar (SCPL had
  // darvas_box + ema50_reclaim, PAISALO had rsi_positive_reversal +
  // range_expansion_breakout). The screeners were right.
  // Fix: before accepting any pick, replay all advanced pre-move screeners
  // on the candles and INVALIDATE picks that disagree directionally.
  const { ADVANCED_PREMOVE_SCREENERS } = await import('../screeners/preMoveAdvanced')
  const curatedCandidates: PickRow[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < shortlist.length) {
      const cand = shortlist[cursor++]
      const sym = cand.symbol
      try {
        const candlesD = cand.candles.length >= 200
          ? cand.candles
          : await data.getCandles(sym, '1D', 300)
        const quote = await data.getQuote(sym).catch(() => null)
        if (candlesD.length < 80) continue
        const scoring = scoreSymbol(sym, candlesD, today)
        if (!scoring) continue

        // 2026-05-03: SHORT floor raised 60 → 70 (Indian market has structural
        // bull bias; SHORTs need stronger confluence). BUY floor unchanged.
        const isMc = isMicroCap(sym)
        const buyFloor = isMc ? 45 : 60
        const shortFloor = isMc ? 55 : 70
        const direction = scoring.direction
        const minScore = direction === 'SHORT' ? shortFloor : buyFloor
        if (scoring.total < minScore) continue

        // PUMP-AND-DUMP GUARD — drop BUY picks with pumpRisk >= 50.
        // SHORTs with high pump-risk are FINE (it means the pump is
        // unsustainable — that's the whole point of shorting one).
        if (direction === 'BUY' && scoring.pumpRisk >= 50) continue

        // SCREENER CROSS-CHECK — only on SHORTs (the directional miss problem
        // was SHORT-side: SCPL/PAISALO/KRONOX). For SHORTs, count BULL votes
        // from advanced pre-move screeners; if 3+ bull screeners fire on the
        // same bar, drop the SHORT (the pre-move setup is bullish, not bearish).
        // BUYs are NOT cross-checked because most screeners are bull-biased
        // and the false-positive rate would cripple the pick list.
        if (direction === 'SHORT') {
          let bullVotes = 0
          for (const s of ADVANCED_PREMOVE_SCREENERS) {
            try {
              const r = s.scan(candlesD, sym)
              if (r?.direction === 'BULL') bullVotes++
            } catch { /* defensive */ }
          }
          if (bullVotes >= 3) continue
        }

        curatedCandidates.push(buildPickRow(sym, candlesD, scoring, 'CURATED', today, quote?.price ?? null))
      } catch { /* skip */ }
    }
  }))
  curatedCandidates.sort((a, b) => b.conviction - a.conviction)
  // 2026-05-03: bumped 25 → 50 picks so the long tail of high-momentum micro/
  // small-caps gets surfaced. Telegram dispatch still pushes only top-5 by
  // conviction; the full 50 is for the dashboard so user can browse near-misses.
  // (Final cap applied after shareholding enrichment + soft well-known bias.)

  // ── SHAREHOLDING ANCHOR + STAKE SUMMARY + WELL-KNOWN FILTER ──
  // 2026-05-04: enrich top-50 with screener.in shareholding + market cap.
  // Three things happen here:
  //   (a) STAKE SUMMARY — every pick gets a one-line "FII X% (+ΔQ) · P Y%
  //       (+ΔQ) · Pledge Z% · MC ₹A Cr" so user can see ownership at a glance
  //   (b) NO-BRAINER BADGE — FII↑ + promoter stable + pledge<5% → ⭐, conv +5
  //   (c) WELL-KNOWN FILTER — drop micro-caps (MC < ₹500Cr) UNLESS they're
  //       NO-BRAINER tagged. User feedback: "none of these are well-known" —
  //       this filter ensures every survivor is institutional-grade OR has
  //       verified institutional accumulation.
  const { scoreShareholding } = await import('../data/shareholding')
  // Enrich a wider net (top 80) so we have replacements after the well-known
  // filter culls obscure names. The final list is still capped at 50.
  const top80 = curatedCandidates.slice(0, 80)
  let shCursor = 0
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (shCursor < top80.length) {
      const i = shCursor++
      const r = top80[i]
      try {
        const verdict = await scoreShareholding(r.symbol)
        r.noBrainerBet = verdict.isNoBrainer
        // Always populate stake summary — concise one-liner for dashboard column.
        if (verdict.shp) {
          const shp = verdict.shp
          const fiiArrow = shp.fiiDeltaQoQ > 0.1 ? '↑' : shp.fiiDeltaQoQ < -0.1 ? '↓' : '→'
          const pArrow = shp.promoterDeltaQoQ > 0.1 ? '↑' : shp.promoterDeltaQoQ < -0.1 ? '↓' : '→'
          const mcStr = shp.marketCapCr >= 1000
            ? `${(shp.marketCapCr / 1000).toFixed(1)}KCr`
            : shp.marketCapCr > 0 ? `${shp.marketCapCr.toFixed(0)}Cr` : '?'
          r.shareholdingNote = `FII ${shp.fiiPct.toFixed(1)}%${fiiArrow} · P ${shp.promoterPct.toFixed(1)}%${pArrow} · Pledge ${shp.promoterPledgePct.toFixed(1)}% · MC ₹${mcStr}`
        } else {
          r.shareholdingNote = 'shareholding data unavailable'
        }
        if (verdict.isNoBrainer) {
          r.conviction = Math.min(100, r.conviction + 5)
          r.flowNote = `⭐ NO-BRAINER · ${verdict.reasons[0]}`
        }
      } catch { /* best-effort */ }
    }
  }))

  // WELL-KNOWN BONUS (SOFT) — boost conviction +3 for NIFTY-500 names and
  // +5 for ≥₹1,000 Cr market cap. Don't HARD-cull — that breaks discovery
  // of legitimate high-momentum mid/small-caps that happen to lack screener.in
  // data. The prerank multiplier (2× for NIFTY-500) already biases the
  // shortlist heavily toward known names.
  for (const r of top80) {
    const mcMatch = (r.shareholdingNote || '').match(/MC\s*₹\s*([\d.]+)\s*(K?Cr)/i)
    let mcCr = 0
    if (mcMatch) {
      mcCr = parseFloat(mcMatch[1])
      if (mcMatch[2].toUpperCase() === 'KCR') mcCr *= 1000
    }
    if (mcCr >= 1000) r.conviction = Math.min(100, r.conviction + 5)
    else if (mcCr >= 500) r.conviction = Math.min(100, r.conviction + 3)
    if (nifty500Set.has(r.symbol.toUpperCase())) r.conviction = Math.min(100, r.conviction + 3)
  }

  // Re-sort after no-brainer bonus + well-known soft bias
  top80.sort((a, b) => {
    if (a.noBrainerBet !== b.noBrainerBet) return a.noBrainerBet ? -1 : 1
    return b.conviction - a.conviction
  })
  rows.push(...top80.slice(0, 50))

  // Sort final list: watchlist first (preserved order by conviction), then curated
  rows.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'WATCHLIST' ? -1 : 1
    return b.conviction - a.conviction
  })

  const notes: string[] = []
  if (regime) {
    notes.push(`Regime: ${regime.regime} (${regime.greenCount}/${regime.checklist.length} green) — ${regime.recommendation}`)
  }
  notes.push(`Horizon: ${HORIZON_TRADING_DAYS} sessions (≈6 weeks). Targets: T1 +${TARGET1_PCT}% / T2 +${TARGET2_PCT}% / T3 +${TARGET3_PCT}%.`)
  notes.push(`Stop: ${STOP_ATR_MULT}× ATR. Position-size = (capital × 0.5%) / risk-per-share for ≤0.5% portfolio risk per name.`)

  const pick: WeeklyPick = {
    weekOf: weekOfMonday(today),
    generatedAt: today.toISOString(),
    regime: regime?.regime ?? 'UNKNOWN',
    watchlistInput: watchlist,
    rows,
    notes,
  }

  await fs.mkdir(PICKS_DIR, { recursive: true })
  await fs.writeFile(path.join(PICKS_DIR, `${pick.weekOf}.json`), JSON.stringify(pick, null, 2), 'utf8')

  // Log every Weekly Pick row to the signals.csv audit journal so the
  // Backtest Results tab can show its full lineage. Previously these rows
  // weren't logged — meaning a 23-Apr EPACK BUY the user took was invisible
  // to the audit and looked "missing" when the engine later flipped views.
  for (const r of rows) {
    void logSignal(weeklyRowToSignal(r), 'weekly-pick').catch(() => undefined)
  }

  log.ok('PICK', `Weekly pick done — ${rows.length} rows (${rows.filter(r => r.source === 'WATCHLIST').length} watchlist + ${rows.filter(r => r.source === 'CURATED').length} curated)`)
  return pick
}

/** Adapt a PickRow to the Signal shape so logSignal can persist it. */
function weeklyRowToSignal(r: PickRow): Signal {
  const direction = r.direction === 'SHORT' ? 'SELL' : 'BUY'
  const grade = r.conviction >= 80 ? 'A' : r.conviction >= 60 ? 'B' : r.conviction >= 50 ? 'C' : 'D'
  const score = +(r.conviction / 10).toFixed(1)
  return {
    id: `weekly-${r.symbol}-${(r.entryDate || '').replace(/-/g, '')}`,
    instrument: r.symbol,
    direction,
    grade,
    score,
    entry: r.entryPrice,
    stopLoss: r.stopLoss,
    target1: r.target1,
    target2: r.target2,
    target3: r.target3,
    riskPct: 0,
    rewardPct: r.expectedReturnPct,
    riskReward: r.riskRewardRatio,
    type: 'SWING',
    reasons: [
      r.entryNote,
      r.smcNote, r.trendNote, r.gannNote, r.astroNote, r.flowNote,
    ].filter(Boolean),
    gannNote: r.gannNote,
    astroNote: r.astroNote,
    oiNote: 'N/A',
    pattern: 'Weekly conviction composite',
    expiresAt: r.target3Date,
    timestamp: new Date().toISOString(),
    confluence: {},
    confluenceCount: 0,
    source: r.source === 'WATCHLIST' ? 'weekly-pick-watchlist' : 'weekly-pick-curated',
    tier: 'LIVE',
  }
}

export async function getLatestPick(): Promise<WeeklyPick | null> {
  try {
    const files = await fs.readdir(PICKS_DIR).catch(() => [] as string[])
    if (!files.length) return null
    files.sort()
    const newest = files[files.length - 1]
    const raw = await fs.readFile(path.join(PICKS_DIR, newest), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}
