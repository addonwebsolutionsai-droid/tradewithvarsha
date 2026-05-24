import fs from 'fs/promises'
import path from 'path'
import * as data from '../data'
import { ema, lastATR, lastRSI } from '../indicators'
import { analyzeSMC } from '../patterns/smc'
import { resolveUniverse } from '../screeners/universe'
import { getLearnedPatterns, matchScore, type PreMoveFeatures } from './patternLearner'
import { getMarketRegime } from './marketRegime'
import { addDays } from '../util/time'
import { log } from '../util/logger'
import { sessionHoras, horaAt } from '../astro/parashariHora'
import { logSignal } from './signalLogger'
import type { Candle, Signal } from '../types'

/**
 * Daily Pick Engine — autonomous "10–20% in 5–15 sessions" stock picker.
 *
 * Distinct from the existing tabs:
 *   - Pre-Move tab        → 1-3 day moves (BB squeeze, coiled range)
 *   - Movers tab          → POST-move history (last week's gainers/losers)
 *   - Pro Screener tab    → 12 strict queries, technical-only, often <5 matches
 *   - Weekly Pick tab     → 6-week horizon (28 sessions), watchlist + curated
 *   - Daily Pick (THIS)   → 5-15 day horizon, broad NSE sweep, hybrid scoring
 *
 * Hybrid scorer combines TWO signals into one ranking — a stock qualifies if
 * EITHER pattern fires:
 *
 *   1. MOMENTUM signal — classic breakout / continuation patterns:
 *      volume burst, EMA stack, near 52W high, RSI 55–72, BOS in SMC.
 *
 *   2. REBOUND signal — fingerprint of NSE winners learned from real data:
 *      RSI ~38, 30–55% off 52W high, below EMAs, recent volume pickup,
 *      reclaim of EMA20 within 3 sessions. (See PatternLearner centroid.)
 *
 * Output: ranked list of 20–30 candidates with entry/SL/T1/T2 + projected
 * dates (T1 ≈ 5 sessions, T2 ≈ 12 sessions). Auto-runs every 30 min during
 * market hours and at 16:15 IST post-close.
 */

const DATA_DIR = path.resolve(__dirname, '../../data')
const PICKS_DIR = path.join(DATA_DIR, 'daily-picks')
const SCAN_LIMIT_BOOT = 300
const SCAN_LIMIT_FULL = 800
const MAX_CANDIDATES = 30
const T1_PCT = 10
const T2_PCT = 20
const T3_PCT = 32        // extended swing target — matches weekly-pick 22% over 28d
const STOP_ATR_MULT = 2.0
const T1_DAYS = 5
const T2_DAYS = 12
const T3_DAYS = 20

export type Direction = 'BUY' | 'SHORT'
export type Pattern = 'MOMENTUM' | 'REBOUND' | 'BOTH'

export interface DailyPickRow {
  symbol: string
  ltp: number
  direction: Direction
  pattern: Pattern
  conviction: number              // 0–100
  // Trade plan — mirrors the Weekly Pick shape so every tab renders a
  // consistent "best entry day / time / price + T1 / T2 / T3 with dates" card.
  entryPrice: number
  entryPriceLow: number           // buy-zone low (BUY) / sell-zone low (SHORT)
  entryPriceHigh: number          // buy-zone high / sell-zone high
  entryDate: string               // next trading day
  entryNote: string               // human-readable entry guidance
  bestEntryTimeIST: string        // HH:MM-HH:MM — hora-aligned slot for the entry date
  horaLord: string                // Jupiter / Sun / Mars / Saturn / ...
  horaNote: string                // one-line bias reason
  stopLoss: number
  target1: number; target1Date: string
  target2: number; target2Date: string
  target3: number; target3Date: string
  expectedReturnPct: number       // T3 % from entry
  riskReward: number
  // Reasoning
  momentumScore: number           // 0-100
  reboundScore: number            // 0-100 (similarity to learned-winner centroid)
  reasons: string[]
  meta: {
    rsi: number
    distFrom52WH: number
    volRatio: number
    aboveEma50: boolean
    aboveEma200: boolean
    ret5dPct: number
  }
  detectedAt: string
}

export interface DailyPick {
  generatedAt: string
  marketState: string             // OPEN | CLOSED
  regime: string
  totalScanned: number
  rows: DailyPickRow[]
  notes: string[]
  newSinceLastRun: string[]       // symbols that weren't in the previous run
}

let inMemoryLatest: DailyPick | null = null
let lastRunSymbols = new Set<string>()

// ─── Helpers ──────────────────────────────────────────────────

const max = (a: number[]) => (a.length ? Math.max(...a) : 0)
const min = (a: number[]) => (a.length ? Math.min(...a) : 0)
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)
const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100)

interface Snapshot {
  symbol: string
  candles: Candle[]
  price: number
  prevClose: number
  ema9?: number; ema21?: number; ema50?: number; ema200?: number
  rsi: number
  atr: number
  volRatio20: number
  volRatio60: number
  vol5dAvg: number; vol60dAvg: number     // for "rising volume" detection
  high52w: number; low52w: number
  high3m: number; high6m: number
  prevDayHigh: number; prevWeekHigh: number
  ret5dPct: number; ret20dPct: number
  range5dPct: number
  pricePctOf52wHigh: number
  drawdownFrom52wHighPct: number
  fullStackBull: boolean
  reclaimedEma21: boolean         // crossed up through EMA21 in last 3 sessions
}

function snapshot(candles: Candle[], symbol: string, liveLtp: number | null = null): Snapshot | null {
  if (candles.length < 60) return null
  const lastCandle = candles[candles.length - 1]
  // Daily candles don't tick intraday — using `lastCandle.close` mid-session
  // shows yesterday's close as "current price". When a live LTP is available
  // we splice a synthetic "today" candle (don't mutate the cached array,
  // which is shared with other consumers).
  const today: Candle = liveLtp != null && liveLtp > 0
    ? { ...lastCandle, close: liveLtp, high: Math.max(lastCandle.high, liveLtp), low: Math.min(lastCandle.low, liveLtp) }
    : lastCandle
  const yest = candles[candles.length - 2] ?? today

  const e9Series = ema(candles, 9)
  const e21Series = ema(candles, 21)
  const e50Series = ema(candles, 50)
  const e200Series = ema(candles, 200)
  const e9 = e9Series[e9Series.length - 1]
  const e21 = e21Series[e21Series.length - 1]
  const e50 = e50Series[e50Series.length - 1]
  const e200 = e200Series[e200Series.length - 1]

  const last5 = candles.slice(-5)
  const range5dHigh = max(last5.map(c => c.high))
  const range5dLow = min(last5.map(c => c.low))
  const range5dMid = (range5dHigh + range5dLow) / 2

  const last63 = candles.slice(-63)
  const last126 = candles.slice(-126)
  const last252 = candles.slice(-252)
  const high52w = max(last252.map(c => c.high))
  const low52w = min(last252.map(c => c.low))
  const high3m = max(last63.slice(0, -1).map(c => c.high))
  const high6m = max(last126.slice(0, -1).map(c => c.high))
  const prevWeekHigh = max(candles.slice(-11, -6).map(c => c.high))

  const vols20 = candles.slice(-21, -1).map(c => c.volume)
  const vols60 = candles.slice(-61, -1).map(c => c.volume)
  const vols5  = candles.slice(-5).map(c => c.volume)
  const volAvg20 = avg(vols20); const volAvg60 = avg(vols60); const vol5dAvg = avg(vols5)

  const ret5dRef = candles[candles.length - 6]?.close ?? today.close
  const ret20dRef = candles[candles.length - 21]?.close ?? today.close

  const fullStackBull = !!(e9 && e21 && e50 && e200 && e9 > e21 && e21 > e50 && e50 > e200)

  // Reclaimed EMA21 — was below 3 sessions ago AND is above today
  const cls3ago = candles[candles.length - 4]?.close
  const e21_3ago = e21Series[e21Series.length - 4]
  const reclaimedEma21 = !!(cls3ago != null && e21_3ago != null && cls3ago < e21_3ago && e21 != null && today.close > e21)

  return {
    symbol,
    candles,
    price: +today.close.toFixed(2),
    prevClose: +yest.close.toFixed(2),
    ema9: e9, ema21: e21, ema50: e50, ema200: e200,
    rsi: +(lastRSI(candles, 14) ?? 50).toFixed(1),
    atr: lastATR(candles, 14) ?? today.close * 0.02,
    volRatio20: volAvg20 > 0 ? +(today.volume / volAvg20).toFixed(2) : 0,
    volRatio60: volAvg60 > 0 ? +(today.volume / volAvg60).toFixed(2) : 0,
    vol5dAvg, vol60dAvg: volAvg60,
    high52w, low52w,
    high3m: +high3m.toFixed(2), high6m: +high6m.toFixed(2),
    prevDayHigh: +yest.high.toFixed(2), prevWeekHigh: +prevWeekHigh.toFixed(2),
    ret5dPct: +pct(today.close, ret5dRef).toFixed(2),
    ret20dPct: +pct(today.close, ret20dRef).toFixed(2),
    range5dPct: range5dMid > 0 ? +(((range5dHigh - range5dLow) / range5dMid) * 100).toFixed(2) : 100,
    pricePctOf52wHigh: high52w > 0 ? +(today.close / high52w).toFixed(3) : 0,
    drawdownFrom52wHighPct: +pct(today.close, high52w).toFixed(2),
    fullStackBull,
    reclaimedEma21,
  }
}

// ─── Score: MOMENTUM (classic breakout patterns) ───────────────

function momentumScore(s: Snapshot): { score: number; direction: Direction; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  let direction: Direction = 'BUY'

  // 2026-05-07: HARD FILTER — skip stocks that have ALREADY moved. User
  // complaint: daily pick fires AFTER 5-8% move done, which is too late to
  // enter at attractive risk. We refuse picks where the run is already in
  // progress and rely on the PRE_BREAKOUT path below to catch them earlier.
  if (s.ret5dPct > 6) {
    return { score: 0, direction: 'BUY', reasons: ['ALREADY MOVED — skipped (ret5d > 6%)'] }
  }
  if (s.ret20dPct > 18) {
    return { score: 0, direction: 'BUY', reasons: ['EXTENDED — skipped (ret20d > 18%)'] }
  }

  // PRE-BREAKOUT cluster (Minervini VCP signature) — fires BEFORE the move:
  //   • In uptrend (above EMA50 + EMA200) but NOT yet at 52W high (5-15% off)
  //   • 5-day return small (< 3%) — still consolidating, not yet running
  //   • Tight range (range5dPct < 4%) — volatility contraction
  //   • Volume DRYING UP (volRatio20 < 0.9) — supply absorbed
  //   • RSI neutral 48-62 — not overbought, ready to expand
  // This catches the COILED setup right before the breakout.
  const inUptrend = !!(s.ema50 && s.ema200 && s.price > s.ema50 && s.ema50 > s.ema200)
  const drawdownOk = s.pricePctOf52wHigh >= 0.85 && s.pricePctOf52wHigh < 0.95
  const consolidating = s.ret5dPct >= -2 && s.ret5dPct < 3
  const tightRange = s.range5dPct < 4
  const volDryUp = s.volRatio20 < 0.9 && s.volRatio20 > 0.3
  const rsiNeutral = s.rsi >= 48 && s.rsi <= 62
  if (inUptrend && drawdownOk && consolidating && tightRange && volDryUp && rsiNeutral) {
    score += 70
    reasons.push('🎯 PRE-BREAKOUT: uptrend + base + vol-dry-up')
    reasons.push(`Range ${s.range5dPct.toFixed(1)}% · vol ${s.volRatio20.toFixed(2)}× · RSI ${s.rsi.toFixed(0)}`)
  }

  // Bullish momentum cluster (CAPPED — used to be the dominant signal)
  if (s.fullStackBull) { score += 15; reasons.push('EMA 9>21>50>200 stacked') }
  if (s.pricePctOf52wHigh >= 0.95) { score += 10; reasons.push('Within 5% of 52W high') }
  else if (s.price > s.high3m) { score += 12; reasons.push('Above 3-month high') }
  else if (s.price > s.prevWeekHigh) { score += 8; reasons.push('Above previous-week high') }
  // Volume now scored MUCH lower — a 3× spike means the move is HAPPENING,
  // not pre-emptive. Reward early-stage volume rises (1.2-1.8×) more.
  if (s.volRatio20 >= 1.2 && s.volRatio20 <= 1.8) { score += 10; reasons.push(`Vol pickup ${s.volRatio20.toFixed(2)}× — early stage`) }
  else if (s.volRatio20 >= 1.8 && s.volRatio20 < 2.5) { score += 6; reasons.push(`Vol ${s.volRatio20.toFixed(1)}× — moving`) }
  else if (s.volRatio20 >= 2.5) { score += 2; reasons.push(`Vol ${s.volRatio20.toFixed(1)}× — already running`) }
  if (s.rsi >= 50 && s.rsi <= 65) { score += 12; reasons.push(`RSI ${s.rsi.toFixed(0)} entry zone`) }
  else if (s.rsi > 65 && s.rsi <= 72) { score += 5; reasons.push(`RSI ${s.rsi.toFixed(0)} — extended`) }
  if (s.range5dPct < 5 && s.pricePctOf52wHigh > 0.85) { score += 10; reasons.push('Tight 5d base near highs') }

  // Bearish momentum cluster — score it as SHORT direction with same magnitude logic
  let bearScore = 0
  const e9Below = s.ema9 != null && s.ema21 != null && s.ema50 != null && s.ema9 < s.ema21 && s.ema21 < s.ema50
  if (e9Below && s.ema200 != null && s.ema50! < s.ema200) { bearScore += 20 }
  if (s.price < s.low52w * 1.05) { bearScore += 25 }
  if (s.volRatio20 >= 3 && s.ret5dPct < -3) { bearScore += 25 }
  if (s.rsi <= 35 && s.ret5dPct < -2) { bearScore += 10 }     // capitulation
  if (bearScore > score) {
    return {
      score: bearScore,
      direction: 'SHORT',
      reasons: [
        e9Below ? 'EMA stack bearish' : '',
        s.price < s.low52w * 1.05 ? 'Near 52W low' : '',
        s.volRatio20 >= 3 ? `Vol ${s.volRatio20.toFixed(1)}× on red` : '',
      ].filter(Boolean),
    }
  }
  return { score: Math.min(100, score), direction, reasons }
}

// ─── Score: REBOUND (oversold bottoming, learned-centroid driven) ──

function reboundFeatures(s: Snapshot): PreMoveFeatures {
  return {
    volRatio20: s.volRatio20,
    volRatio60: s.volRatio60,
    rsi: s.rsi,
    distFrom52wHighPct: s.drawdownFrom52wHighPct,
    above50EMA: !!(s.ema50 && s.price > s.ema50),
    above200EMA: !!(s.ema200 && s.price > s.ema200),
    emaStackBull: s.fullStackBull,
    ret5dPct: s.ret5dPct,
    ret20dPct: s.ret20dPct,
    range5dPct: s.range5dPct,
  }
}

async function reboundScoreFor(s: Snapshot): Promise<{ score: number; reasons: string[] }> {
  const learned = await getLearnedPatterns()
  const reasons: string[] = []
  // Hard pre-filter — rebound requires being BELOW or near major MA, not at 52WH
  if (s.drawdownFrom52wHighPct > -8) return { score: 0, reasons: [] }
  if (s.rsi > 55) return { score: 0, reasons: [] }

  const features = reboundFeatures(s)
  const learnedMatch = matchScore(features, learned.centroids) * 100      // 0–100

  // Layer additional rebound boosters that the learner doesn't capture
  let boost = 0
  if (s.reclaimedEma21) { boost += 15; reasons.push('Reclaimed EMA21 in last 3 sessions') }
  if (s.vol5dAvg > s.vol60dAvg * 1.2) { boost += 10; reasons.push(`5d avg vol ${(s.vol5dAvg / s.vol60dAvg).toFixed(1)}× 60d`) }
  if (s.rsi >= 30 && s.rsi <= 45) { boost += 10; reasons.push(`RSI ${s.rsi.toFixed(0)} oversold-recovery zone`) }
  if (s.drawdownFrom52wHighPct > -50 && s.drawdownFrom52wHighPct < -25) {
    boost += 10
    reasons.push(`${s.drawdownFrom52wHighPct.toFixed(0)}% off 52WH (sweet rebound zone)`)
  }
  if (s.ret5dPct > 2 && s.ret20dPct < -10) {
    boost += 15
    reasons.push(`Snapping back: 5d ${s.ret5dPct.toFixed(1)}% but 20d ${s.ret20dPct.toFixed(1)}%`)
  }

  const score = Math.min(100, learnedMatch * 0.5 + boost)
  if (learnedMatch >= 60) reasons.unshift(`${learnedMatch.toFixed(0)}% match to learned-winner centroid`)

  return { score, reasons }
}

// ─── Trade plan ────────────────────────────────────────────────

function projectBusinessDate(from: Date, days: number): string {
  let d = new Date(from)
  let added = 0
  while (added < days) {
    d = addDays(d, 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d.toISOString().slice(0, 10)
}

interface DailyPlan {
  entryPrice: number
  entryPriceLow: number
  entryPriceHigh: number
  entryDate: string
  entryNote: string
  bestEntryTimeIST: string
  horaLord: string
  horaNote: string
  stopLoss: number
  target1: number; target1Date: string
  target2: number; target2Date: string
  target3: number; target3Date: string
  riskReward: number
}

function buildPlan(s: Snapshot, direction: Direction): DailyPlan {
  // For swing-style picks we prefer entering on a pullback to EMA21 (BUY)
  // or a rally into EMA21 (SHORT) rather than chasing the close — this is
  // the same logic the Weekly Pick uses and the user validated it for
  // Marksans/Moschip/Moldtek.
  const cmp = +s.price.toFixed(2)
  const e21 = s.ema21 ?? cmp
  const entryPrice = direction === 'BUY'
    ? +Math.min(cmp, Math.max(e21, cmp * 0.985)).toFixed(2)
    : +Math.max(cmp, Math.min(e21, cmp * 1.015)).toFixed(2)
  const band = Math.max(entryPrice * 0.005, 0.5)     // ±0.5% band
  const entryPriceLow  = +(direction === 'BUY' ? entryPrice - band : entryPrice).toFixed(2)
  const entryPriceHigh = +(direction === 'BUY' ? entryPrice : entryPrice + band).toFixed(2)

  const sign = direction === 'BUY' ? 1 : -1
  const target1 = +(entryPrice * (1 + sign * T1_PCT / 100)).toFixed(2)
  const target2 = +(entryPrice * (1 + sign * T2_PCT / 100)).toFixed(2)
  const target3 = +(entryPrice * (1 + sign * T3_PCT / 100)).toFixed(2)
  const stopLoss = direction === 'BUY'
    ? +(entryPrice - STOP_ATR_MULT * s.atr).toFixed(2)
    : +(entryPrice + STOP_ATR_MULT * s.atr).toFixed(2)
  const risk = Math.abs(entryPrice - stopLoss)
  const reward = Math.abs(target1 - entryPrice)

  const today = new Date()
  const entryDate = projectBusinessDate(today, 1)     // next session

  // Hora-based precise entry time on entryDate. For daily picks we default
  // to whichever session hora matches direction first — the trader then
  // executes the limit order in that 30-60 min window, not at the open.
  const entryDay = new Date(entryDate + 'T04:00:00.000Z')     // ~09:30 IST anchor
  const horas = sessionHoras(entryDay)
  const wantsBull = direction === 'BUY'
  const aligned = horas.find(h => wantsBull ? h.bias === 'BULLISH' : h.bias === 'BEARISH')
  const pick = aligned ?? horas.find(h => h.bias === 'VOLATILE') ?? horas[0] ?? horaAt(entryDay)
  const bestEntryTimeIST = `${pick.startIST}-${pick.endIST}`
  const horaLord = pick.lord
  const horaNote = `${pick.lord} hora · ${pick.bias}`

  const entryNote = direction === 'BUY'
    ? `Buy ${entryPriceLow}–${entryPriceHigh} on pullback (≈ EMA21). Trigger window ${bestEntryTimeIST} IST.`
    : `Short ${entryPriceLow}–${entryPriceHigh} on rally (≈ EMA21). Trigger window ${bestEntryTimeIST} IST.`

  return {
    entryPrice, entryPriceLow, entryPriceHigh,
    entryDate, entryNote,
    bestEntryTimeIST, horaLord, horaNote,
    stopLoss,
    target1, target1Date: projectBusinessDate(today, T1_DAYS),
    target2, target2Date: projectBusinessDate(today, T2_DAYS),
    target3, target3Date: projectBusinessDate(today, T3_DAYS),
    riskReward: +(reward / Math.max(risk, 0.01)).toFixed(2),
  }
}

// ─── Main scan ─────────────────────────────────────────────────

export async function runDailyPick(opts: { limit?: number; reason?: string } = {}): Promise<DailyPick> {
  const limit = opts.limit ?? SCAN_LIMIT_FULL
  const reason = opts.reason ?? 'manual'
  log.info('DAILYPICK', `Scan starting (${reason}, ${limit} symbols)`)
  const today = new Date()
  const universe = (await resolveUniverse('NSE_ALL')).slice(0, limit)
  const regime = await getMarketRegime().catch(() => null)

  const candidates: DailyPickRow[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      try {
        // Daily candles + live LTP in parallel — see weeklyManagerPick for
        // why we splice a synthetic "today" candle from the live quote.
        const [candles, quote] = await Promise.all([
          data.getCandles(sym, '1D', 300),
          data.getQuote(sym).catch(() => null),
        ])
        const s = snapshot(candles, sym, quote?.price ?? null); if (!s) continue

        const mom = momentumScore(s)
        const reb = await reboundScoreFor(s)

        // Take whichever fired stronger; need at least one above 50
        const useMom = mom.score >= reb.score
        const winningScore = useMom ? mom.score : reb.score
        if (winningScore < 50) continue

        const direction: Direction = useMom ? mom.direction : 'BUY'   // rebound is always BUY
        const pattern: Pattern = mom.score >= 50 && reb.score >= 50 ? 'BOTH' : useMom ? 'MOMENTUM' : 'REBOUND'

        // Liquidity gate
        if (s.vol60dAvg < 5_000) continue
        if (s.price < 5) continue       // skip penny scrips

        const plan = buildPlan(s, direction)
        const reasons = useMom ? mom.reasons : reb.reasons
        if (pattern === 'BOTH') reasons.push('🎯 Both momentum AND rebound triggered')

        candidates.push({
          symbol: sym,
          ltp: s.price,
          direction, pattern,
          conviction: Math.round(winningScore),
          ...plan,
          expectedReturnPct: T3_PCT * (direction === 'BUY' ? 1 : -1),
          momentumScore: Math.round(mom.score),
          reboundScore: Math.round(reb.score),
          reasons,
          meta: {
            rsi: s.rsi,
            distFrom52WH: +s.drawdownFrom52wHighPct.toFixed(1),
            volRatio: s.volRatio20,
            aboveEma50: !!(s.ema50 && s.price > s.ema50),
            aboveEma200: !!(s.ema200 && s.price > s.ema200),
            ret5dPct: s.ret5dPct,
          },
          detectedAt: today.toISOString(),
        })
      } catch { /* skip */ }
    }
  }))

  // 2026-05-25: Quality floor — drop sub-65 conviction picks before slicing
  // top-N. Live lifecycle showed Daily at 69% WR; sub-60s dominated the SL
  // bucket. Cap also halved (30→15) so dispatch focuses on elite only.
  candidates.sort((a, b) => b.conviction - a.conviction)
  const elite = candidates.filter(c => c.conviction >= 65)
  const rows = elite.slice(0, 15)

  // Newness — symbols not in the previous run
  const currentSymbols = new Set(rows.map(r => r.symbol))
  const newSinceLastRun = [...currentSymbols].filter(s => !lastRunSymbols.has(s))
  lastRunSymbols = currentSymbols

  const notes: string[] = []
  if (regime) notes.push(`Regime: ${regime.regime} — ${regime.recommendation}`)
  notes.push(`Hybrid scoring: max(MOMENTUM, REBOUND). Rebound uses centroid from ${(await getLearnedPatterns()).totalSignatures} learned winner signatures.`)
  notes.push(`Targets: T1 +${T1_PCT}% (~${T1_DAYS}d) · T2 +${T2_PCT}% (~${T2_DAYS}d) · T3 +${T3_PCT}% (~${T3_DAYS}d). Stop ${STOP_ATR_MULT}× ATR. Entry band ±0.5% around EMA21 · Parashari-hora trigger window per row.`)
  if (newSinceLastRun.length) notes.push(`🆕 ${newSinceLastRun.length} new since last run: ${newSinceLastRun.slice(0, 6).join(', ')}${newSinceLastRun.length > 6 ? '…' : ''}`)

  const pick: DailyPick = {
    generatedAt: today.toISOString(),
    marketState: 'UNKNOWN',     // filled by caller via /api/health if needed
    regime: regime?.regime ?? 'UNKNOWN',
    totalScanned: universe.length,
    rows,
    notes,
    newSinceLastRun,
  }

  inMemoryLatest = pick
  await fs.mkdir(PICKS_DIR, { recursive: true })
  const stamp = today.toISOString().replace(/[:.]/g, '-').slice(0, 16)
  await fs.writeFile(path.join(PICKS_DIR, `${stamp}.json`), JSON.stringify(pick, null, 2), 'utf8')

  // Log every Daily Pick row to signals.csv so the Backtest Results tab
  // covers them. Without this the audit journal misses the picks the user
  // actually trades from.
  for (const r of rows) {
    void logSignal(dailyRowToSignal(r), 'daily-pick').catch(() => undefined)
  }

  // 2026-05-11: register each pick in the signal-lifecycle store as PENDING
  // so the periodic checker tracks entry/SL/target. Accuracy report (/api/accuracy)
  // surfaces hit-rate per source.
  try {
    const { appendSignal } = await import('./signalLifecycle')
    for (const r of rows) {
      await appendSignal({
        source: 'DAILY',
        symbol: r.symbol,
        direction: r.direction === 'BUY' ? 'BUY' : 'SHORT',
        ltp: r.ltp,
        entryPrice: r.entryPrice,
        entryPriceLow: r.entryPriceLow ?? r.entryPrice,
        entryPriceHigh: r.entryPriceHigh ?? r.entryPrice,
        stopLoss: r.stopLoss,
        target1: r.target1, target1Date: r.target1Date,
        target2: r.target2, target2Date: r.target2Date,
        target3: r.target3, target3Date: r.target3Date,
        conviction: r.conviction,
        reasoning: (r.reasons ?? []).slice(0, 2).join(' · '),
      })
    }
  } catch (e) { log.warn('DAILYPICK', `lifecycle append: ${(e as Error).message}`) }

  log.ok('DAILYPICK', `${rows.length} candidates (${rows.filter(r => r.pattern === 'MOMENTUM').length} momentum / ${rows.filter(r => r.pattern === 'REBOUND').length} rebound / ${rows.filter(r => r.pattern === 'BOTH').length} both) · ${newSinceLastRun.length} new`)
  return pick
}

/** Adapt a DailyPickRow to Signal so logSignal can persist it. */
function dailyRowToSignal(r: DailyPickRow): Signal {
  const direction = r.direction === 'SHORT' ? 'SELL' : 'BUY'
  const grade = r.conviction >= 80 ? 'A' : r.conviction >= 65 ? 'B' : r.conviction >= 50 ? 'C' : 'D'
  const score = +(r.conviction / 10).toFixed(1)
  return {
    id: `daily-${r.symbol}-${(r.entryDate || r.detectedAt.slice(0, 10)).replace(/-/g, '')}`,
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
    riskReward: r.riskReward,
    type: 'SWING',
    reasons: [r.entryNote, ...(r.reasons ?? [])].filter(Boolean),
    gannNote: 'N/A',
    astroNote: r.horaNote ?? 'N/A',
    oiNote: 'N/A',
    pattern: r.pattern,
    expiresAt: r.target3Date ?? r.target2Date,
    timestamp: r.detectedAt,
    confluence: {},
    confluenceCount: 0,
    source: `daily-pick-${r.pattern.toLowerCase()}`,
    tier: 'LIVE',
  }
}

export function getLatestDailyPick(): DailyPick | null { return inMemoryLatest }

export async function loadLatestDailyPick(): Promise<DailyPick | null> {
  if (inMemoryLatest) return inMemoryLatest
  try {
    const files = await fs.readdir(PICKS_DIR).catch(() => [] as string[])
    if (!files.length) return null
    files.sort()
    const newest = files[files.length - 1]
    const raw = await fs.readFile(path.join(PICKS_DIR, newest), 'utf8')
    inMemoryLatest = JSON.parse(raw)
    return inMemoryLatest
  } catch { return null }
}

export const DAILY_PICK_CONFIG = {
  T1_PCT, T2_PCT, T3_PCT, T1_DAYS, T2_DAYS, T3_DAYS,
  STOP_ATR_MULT, MAX_CANDIDATES,
  SCAN_LIMIT_BOOT, SCAN_LIMIT_FULL,
}
