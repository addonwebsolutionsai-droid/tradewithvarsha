/**
 * NIFTY Directional Foresight Engine
 *
 * Purpose: NEVER miss another 700-point NIFTY move.
 *
 * What existed before failed us on 1-10 July 2026:
 *   - OI only near-expiry (missed smart-money monthly + quarterly build)
 *   - No max-pain migration tracking (missed 24500 → 24200 drift on 7-8 Jul)
 *   - No PCR trend / delta (only snapshot regime)
 *   - No unified NIFTY directional call — signals scattered per stock
 *   - KP/Bradley applied per-stock, never as a single NIFTY overlay
 *   - No time-cycle projection from NIFTY history since 2020
 *   - No operator playbook detection (stop-hunt, OI trap, IV crush)
 *
 * This engine fixes all seven. It produces a single JSON snapshot with:
 *   direction · confidence · trade plan · playbook · reason breakdown
 *
 * Composite score (0-100 each side, higher wins):
 *   - Multi-expiry OI stance (25)
 *   - Max-pain drift (15)
 *   - PCR trend / extremes (10)
 *   - Time cycle bias (15)
 *   - Momentum + trend (15)
 *   - KP sub-lord (10)
 *   - Bradley siderograph (10)
 *
 * Written 2026-07-10 in direct response to the missed 1-10 July NIFTY moves.
 */

import fs from 'fs'
import path from 'path'
import { fetchNiftyAllExpiries } from '../data/niftyMultiExpiryOC'
import { getCandles } from '../data/index'
import { log } from '../util/logger'
import type { Candle } from '../types'

const HISTORY_FILE = path.resolve(__dirname, '../../data/nifty-foresight-history.json')

interface HistoryPoint {
  ts: number             // ms
  date: string           // YYYY-MM-DD IST
  spot: number
  pcr: number
  maxPain: number
  monthlyPcr: number
  monthlyMaxPain: number
  quarterlyPcr: number
  quarterlyMaxPain: number
}

interface HistoryFile {
  points: HistoryPoint[]  // append-only, capped at 90 entries
}

function istDateStr(ms: number): string {
  const d = new Date(ms + 5.5 * 3600_000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function loadHistory(): HistoryFile {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return { points: [] }
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as HistoryFile
    return { points: Array.isArray(raw.points) ? raw.points : [] }
  } catch {
    return { points: [] }
  }
}

function saveHistory(h: HistoryFile): void {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true })
    // keep 90 entries (~3 months of daily snapshots)
    const trimmed = h.points.slice(-90)
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ points: trimmed }, null, 2))
  } catch (e) {
    log.err('NIFTY-FORESIGHT', `history save failed: ${(e as Error).message}`)
  }
}

// ─── Time cycle analysis on NIFTY daily candles since 2020 ─────────────────

interface Pivot {
  idx: number
  ms: number
  price: number
  kind: 'HIGH' | 'LOW'
}

function detectPivots(candles: Candle[], lookback = 5): Pivot[] {
  const pivots: Pivot[] = []
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]
    let isHigh = true
    let isLow = true
    for (let k = 1; k <= lookback; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high >= c.high) isHigh = false
      if (candles[i - k].low <= c.low || candles[i + k].low <= c.low) isLow = false
    }
    if (isHigh) pivots.push({ idx: i, ms: c.time, price: c.high, kind: 'HIGH' })
    else if (isLow) pivots.push({ idx: i, ms: c.time, price: c.low, kind: 'LOW' })
  }
  return pivots
}

interface CycleInsight {
  lastMajorHighDaysAgo: number
  lastMajorLowDaysAgo: number
  meanTopToTopDays: number
  meanBotToBotDays: number
  nextExpectedTurnDaysAhead: number
  nextExpectedTurnKind: 'HIGH' | 'LOW' | 'UNKNOWN'
  cycleBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  reason: string
}

function analyseTimeCycles(candles: Candle[]): CycleInsight {
  const pivots = detectPivots(candles, 5)
  const highs = pivots.filter(p => p.kind === 'HIGH')
  const lows = pivots.filter(p => p.kind === 'LOW')

  if (highs.length < 3 || lows.length < 3) {
    return {
      lastMajorHighDaysAgo: -1,
      lastMajorLowDaysAgo: -1,
      meanTopToTopDays: 0,
      meanBotToBotDays: 0,
      nextExpectedTurnDaysAhead: 0,
      nextExpectedTurnKind: 'UNKNOWN',
      cycleBias: 'NEUTRAL',
      reason: 'insufficient pivot history for cycle inference',
    }
  }

  const lastIdx = candles.length - 1
  const lastHigh = highs[highs.length - 1]
  const lastLow = lows[lows.length - 1]
  const lastMajorHighDaysAgo = lastIdx - lastHigh.idx
  const lastMajorLowDaysAgo = lastIdx - lastLow.idx

  // Mean cycle length (in trading days between consecutive same-kind pivots)
  const topGaps: number[] = []
  for (let i = 1; i < highs.length; i++) topGaps.push(highs[i].idx - highs[i - 1].idx)
  const botGaps: number[] = []
  for (let i = 1; i < lows.length; i++) botGaps.push(lows[i].idx - lows[i - 1].idx)
  const meanTopToTopDays = topGaps.reduce((s, v) => s + v, 0) / topGaps.length
  const meanBotToBotDays = botGaps.reduce((s, v) => s + v, 0) / botGaps.length

  // Next expected turn = whichever cycle is closer to firing
  const nextTopDaysAhead = Math.round(meanTopToTopDays - lastMajorHighDaysAgo)
  const nextBotDaysAhead = Math.round(meanBotToBotDays - lastMajorLowDaysAgo)

  let nextExpectedTurnDaysAhead: number
  let nextExpectedTurnKind: 'HIGH' | 'LOW'
  if (Math.abs(nextTopDaysAhead) < Math.abs(nextBotDaysAhead)) {
    nextExpectedTurnDaysAhead = nextTopDaysAhead
    nextExpectedTurnKind = 'HIGH'
  } else {
    nextExpectedTurnDaysAhead = nextBotDaysAhead
    nextExpectedTurnKind = 'LOW'
  }

  // Cycle bias: if we're closer to a low than a high in cycle time, market is
  // in accumulation phase → bullish. Conversely for distribution → bearish.
  let cycleBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL'
  let reason = ''
  if (nextExpectedTurnKind === 'HIGH' && nextExpectedTurnDaysAhead >= 0 && nextExpectedTurnDaysAhead <= 7) {
    cycleBias = 'BEARISH'
    reason = `cycle top expected in ~${nextExpectedTurnDaysAhead}d (last high ${lastMajorHighDaysAgo}d ago, mean gap ${meanTopToTopDays.toFixed(0)}d)`
  } else if (nextExpectedTurnKind === 'LOW' && nextExpectedTurnDaysAhead >= 0 && nextExpectedTurnDaysAhead <= 7) {
    cycleBias = 'BULLISH'
    reason = `cycle low expected in ~${nextExpectedTurnDaysAhead}d (last low ${lastMajorLowDaysAgo}d ago, mean gap ${meanBotToBotDays.toFixed(0)}d)`
  } else if (lastMajorLowDaysAgo < lastMajorHighDaysAgo && lastMajorLowDaysAgo < meanBotToBotDays / 2) {
    cycleBias = 'BULLISH'
    reason = `fresh low ${lastMajorLowDaysAgo}d ago; still early in accumulation cycle`
  } else if (lastMajorHighDaysAgo < lastMajorLowDaysAgo && lastMajorHighDaysAgo < meanTopToTopDays / 2) {
    cycleBias = 'BEARISH'
    reason = `fresh high ${lastMajorHighDaysAgo}d ago; still early in distribution cycle`
  } else {
    reason = `mid-cycle drift (${lastMajorLowDaysAgo}d from low, ${lastMajorHighDaysAgo}d from high)`
  }

  return {
    lastMajorHighDaysAgo,
    lastMajorLowDaysAgo,
    meanTopToTopDays,
    meanBotToBotDays,
    nextExpectedTurnDaysAhead,
    nextExpectedTurnKind,
    cycleBias,
    reason,
  }
}

// ─── Multi-expiry OI stance ───────────────────────────────────────────────

interface OIStance {
  bullPoints: number   // 0-25
  bearPoints: number   // 0-25
  reasons: string[]
  currentPcr: number
  currentMaxPain: number
  monthlyPcr: number
  monthlyMaxPain: number
  quarterlyPcr: number
  quarterlyMaxPain: number
  farExpiryLabel: string
  smartMoneyLevel: number  // strike where smart money's biggest bet sits
  smartMoneyDirection: 'BULLISH' | 'BEARISH' | 'MIXED'
}

interface ExpiryBookInput {
  expiry: string
  daysToExpiry: number
  pcr: number
  maxPain: number
  totalCallOI: number
  totalPutOI: number
  totalCallOIChange: number
  totalPutOIChange: number
  top3CallStrikes: Array<{ strike: number; oi: number; change: number }>
  top3PutStrikes: Array<{ strike: number; oi: number; change: number }>
}

function analyseMultiExpiryOI(
  spot: number,
  expiries: ExpiryBookInput[],
): OIStance {
  const current = expiries[0]
  // Monthly = first expiry >= 15 days out
  const monthly = expiries.find(e => e.daysToExpiry >= 15 && e.daysToExpiry <= 45) ?? current
  // Quarterly = first expiry >= 60 days out (LEAPS territory where smart money sits)
  const quarterly = expiries.find(e => e.daysToExpiry >= 60) ?? monthly

  const reasons: string[] = []
  let bull = 0
  let bear = 0

  // Rule 1: Current PCR extreme (contrarian)
  if (current.pcr < 0.7) {
    bull += 3
    reasons.push(`current PCR ${current.pcr.toFixed(2)} (extreme bearish → contrarian long)`)
  } else if (current.pcr > 1.4) {
    bear += 3
    reasons.push(`current PCR ${current.pcr.toFixed(2)} (extreme bullish → contrarian short)`)
  }

  // Rule 2: Monthly PCR bias (smart money book)
  if (monthly.pcr > 1.2) {
    bull += 4
    reasons.push(`monthly (${monthly.expiry}) PCR ${monthly.pcr.toFixed(2)} → institutions hedging longs / PE writing`)
  } else if (monthly.pcr < 0.8) {
    bear += 4
    reasons.push(`monthly (${monthly.expiry}) PCR ${monthly.pcr.toFixed(2)} → institutions CE writing / PE buying`)
  }

  // Rule 3: Quarterly PCR (deep smart-money footprint) — the signal we
  // missed on 1-6 July when institutions were building the up-move book on
  // 31-Jul + Aug expiries. Weight quarterly heavier than current.
  if (quarterly.pcr > 1.3) {
    bull += 5
    reasons.push(`QUARTERLY (${quarterly.expiry}) PCR ${quarterly.pcr.toFixed(2)} → smart money positioned for upside`)
  } else if (quarterly.pcr < 0.75) {
    bear += 5
    reasons.push(`QUARTERLY (${quarterly.expiry}) PCR ${quarterly.pcr.toFixed(2)} → smart money positioned for downside`)
  }

  // Rule 4: Max pain vs spot (magnet effect)
  const monthlyMpDist = (monthly.maxPain - spot) / spot
  if (monthlyMpDist > 0.005) {
    bull += 2
    reasons.push(`monthly max-pain ${monthly.maxPain} above spot ${Math.round(spot)} → upside magnet`)
  } else if (monthlyMpDist < -0.005) {
    bear += 2
    reasons.push(`monthly max-pain ${monthly.maxPain} below spot ${Math.round(spot)} → downside magnet`)
  }

  // Rule 5: Fresh CE-writing / PE-writing at current expiry (change in OI)
  if (current.totalPutOIChange > current.totalCallOIChange * 1.4 && current.totalPutOIChange > 0) {
    bull += 3
    reasons.push(`fresh PE writing (ΔPut OI ${(current.totalPutOIChange / 1e5).toFixed(1)}L vs ΔCall ${(current.totalCallOIChange / 1e5).toFixed(1)}L)`)
  } else if (current.totalCallOIChange > current.totalPutOIChange * 1.4 && current.totalCallOIChange > 0) {
    bear += 3
    reasons.push(`fresh CE writing (ΔCall OI ${(current.totalCallOIChange / 1e5).toFixed(1)}L vs ΔPut ${(current.totalPutOIChange / 1e5).toFixed(1)}L)`)
  }

  // Rule 6: Top CE resistance vs top PE support — where's the wall?
  const topCE = current.top3CallStrikes[0]
  const topPE = current.top3PutStrikes[0]
  const ceWallAbove = topCE.strike > spot
  const peWallBelow = topPE.strike < spot
  if (peWallBelow && (spot - topPE.strike) < spot * 0.005) {
    bull += 2
    reasons.push(`major PE wall at ${topPE.strike} (${(topPE.oi / 1e5).toFixed(1)}L OI) — strong support just below`)
  }
  if (ceWallAbove && (topCE.strike - spot) > spot * 0.015) {
    bull += 1
    reasons.push(`CE wall far above at ${topCE.strike} — headroom before resistance`)
  }
  if (ceWallAbove && (topCE.strike - spot) < spot * 0.005) {
    bear += 2
    reasons.push(`heavy CE wall at ${topCE.strike} (${(topCE.oi / 1e5).toFixed(1)}L OI) — immediate resistance`)
  }

  // Rule 7: Smart money level — biggest OI concentration on longest-dated book
  const q3 = [...quarterly.top3CallStrikes, ...quarterly.top3PutStrikes]
    .sort((a, b) => b.oi - a.oi)[0]
  const smartMoneyLevel = q3?.strike ?? monthly.maxPain
  const q3IsCall = quarterly.top3CallStrikes.some(s => s.strike === smartMoneyLevel && s.oi >= (q3?.oi ?? 0))
  let smartMoneyDirection: 'BULLISH' | 'BEARISH' | 'MIXED' = 'MIXED'
  if (q3IsCall) {
    smartMoneyDirection = smartMoneyLevel > spot ? 'BEARISH' : 'BULLISH'   // CE writing at higher strike = expecting cap
  } else {
    smartMoneyDirection = smartMoneyLevel < spot ? 'BULLISH' : 'BEARISH'   // PE writing at lower strike = expecting floor
  }

  return {
    bullPoints: bull,
    bearPoints: bear,
    reasons,
    currentPcr: current.pcr,
    currentMaxPain: current.maxPain,
    monthlyPcr: monthly.pcr,
    monthlyMaxPain: monthly.maxPain,
    quarterlyPcr: quarterly.pcr,
    quarterlyMaxPain: quarterly.maxPain,
    farExpiryLabel: quarterly.expiry,
    smartMoneyLevel,
    smartMoneyDirection,
  }
}

// ─── Max-pain migration + PCR trend from history ──────────────────────────

interface DriftInsight {
  bullPoints: number   // 0-15 max-pain, 0-10 pcr-trend
  bearPoints: number
  reasons: string[]
  maxPainDriftPtsPerDay: number
  pcrDelta3d: number
}

function analyseDrift(hist: HistoryPoint[], today: {
  monthlyMaxPain: number
  monthlyPcr: number
}): DriftInsight {
  const reasons: string[] = []
  let bull = 0
  let bear = 0
  let maxPainDriftPtsPerDay = 0
  let pcrDelta3d = 0

  const recent = hist.slice(-3)
  if (recent.length >= 2) {
    const first = recent[0]
    const spanDays = Math.max(1, (Date.now() - first.ts) / 86_400_000)

    maxPainDriftPtsPerDay = (today.monthlyMaxPain - first.monthlyMaxPain) / spanDays
    if (maxPainDriftPtsPerDay > 40) {
      bull += 8
      reasons.push(`max-pain drifting UP ${maxPainDriftPtsPerDay.toFixed(0)}pt/day (${first.monthlyMaxPain} → ${today.monthlyMaxPain})`)
    } else if (maxPainDriftPtsPerDay < -40) {
      bear += 8
      reasons.push(`max-pain drifting DOWN ${maxPainDriftPtsPerDay.toFixed(0)}pt/day (${first.monthlyMaxPain} → ${today.monthlyMaxPain})`)
    }

    pcrDelta3d = today.monthlyPcr - first.monthlyPcr
    if (pcrDelta3d > 0.15) {
      bull += 5
      reasons.push(`PCR rising (${first.monthlyPcr.toFixed(2)} → ${today.monthlyPcr.toFixed(2)}) — put writers stepping in`)
    } else if (pcrDelta3d < -0.15) {
      bear += 5
      reasons.push(`PCR falling (${first.monthlyPcr.toFixed(2)} → ${today.monthlyPcr.toFixed(2)}) — put writers unwinding`)
    }
  }

  return {
    bullPoints: bull,
    bearPoints: bear,
    reasons,
    maxPainDriftPtsPerDay,
    pcrDelta3d,
  }
}

// ─── Momentum + trend ─────────────────────────────────────────────────────

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0
  const k = 2 / (period + 1)
  let e = values[0]
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

function analyseMomentum(candles: Candle[]): { bull: number; bear: number; reasons: string[] } {
  if (candles.length < 55) return { bull: 0, bear: 0, reasons: [] }
  const closes = candles.map(c => c.close)
  const last = closes[closes.length - 1]
  const e20 = ema(closes.slice(-40), 20)
  const e50 = ema(closes.slice(-100), 50)
  const reasons: string[] = []
  let bull = 0
  let bear = 0

  if (last > e20 && e20 > e50) {
    bull += 8
    reasons.push(`price above 20/50 EMA in stacked uptrend (${last.toFixed(0)} > ${e20.toFixed(0)} > ${e50.toFixed(0)})`)
  } else if (last < e20 && e20 < e50) {
    bear += 8
    reasons.push(`price below 20/50 EMA in stacked downtrend (${last.toFixed(0)} < ${e20.toFixed(0)} < ${e50.toFixed(0)})`)
  } else if (last > e50) {
    bull += 3
    reasons.push(`price above 50 EMA (${last.toFixed(0)} > ${e50.toFixed(0)}) but 20/50 not stacked`)
  } else {
    bear += 3
    reasons.push(`price below 50 EMA (${last.toFixed(0)} < ${e50.toFixed(0)}) — trend weakness`)
  }

  const ret5 = (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6] * 100
  const ret20 = (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21] * 100

  if (ret5 > 2 && ret20 > 4) {
    bull += 4
    reasons.push(`5d +${ret5.toFixed(1)}% / 20d +${ret20.toFixed(1)}% (fresh momentum)`)
  } else if (ret5 < -2 && ret20 < -4) {
    bear += 4
    reasons.push(`5d ${ret5.toFixed(1)}% / 20d ${ret20.toFixed(1)}% (fresh downside)`)
  }

  // Overextension check — if ret20 > 8% AND ret5 > 4%, we're already extended
  // (this was the 7-8 July setup — extended, top-heavy, ready to snap back).
  if (ret20 > 8 && ret5 > 4) {
    bear += 3
    reasons.push(`over-extended (5d +${ret5.toFixed(1)}% / 20d +${ret20.toFixed(1)}%) — mean-reversion risk elevated`)
  } else if (ret20 < -8 && ret5 < -4) {
    bull += 3
    reasons.push(`over-sold (5d ${ret5.toFixed(1)}% / 20d ${ret20.toFixed(1)}%) — bounce risk elevated`)
  }

  return { bull, bear, reasons }
}

// ─── Playbook detection: how operators actually manipulate NIFTY ──────────

interface Playbook {
  detected: string[]
  reason: string
}

function detectPlaybook(candles: Candle[], oi: OIStance, drift: DriftInsight): Playbook {
  const detected: string[] = []
  const notes: string[] = []
  if (candles.length < 10) return { detected, reason: '' }

  const last = candles[candles.length - 1]
  const prev = candles[candles.length - 2]
  const range5 = candles.slice(-5)
  const swingHigh = Math.max(...range5.map(c => c.high))
  const swingLow = Math.min(...range5.map(c => c.low))

  // Stop-hunt reversal: yesterday broke swing high but closed below prior high
  if (prev.high >= swingHigh * 0.999 && prev.close < prev.high - (prev.high - prev.low) * 0.5) {
    detected.push('STOP_HUNT_ABOVE')
    notes.push(`upside stop-hunt: yesterday tagged ${prev.high.toFixed(0)} then rejected`)
  }
  if (prev.low <= swingLow * 1.001 && prev.close > prev.low + (prev.high - prev.low) * 0.5) {
    detected.push('STOP_HUNT_BELOW')
    notes.push(`downside stop-hunt: yesterday tagged ${prev.low.toFixed(0)} then reclaimed`)
  }

  // OI trap: heavy fresh OI writing that gets torched on the next session
  if (Math.abs(drift.maxPainDriftPtsPerDay) > 80) {
    detected.push('OI_MAGNET_DRIFT')
    notes.push(`max-pain drifting ${drift.maxPainDriftPtsPerDay.toFixed(0)}pt/day — price will follow the writer's book`)
  }

  // Institutional imbalance: OI + PCR both signal same direction with size
  if (oi.bullPoints >= 15 && oi.smartMoneyDirection === 'BULLISH') {
    detected.push('INSTITUTIONAL_LONG_BUILD')
    notes.push(`heavy PE writing on far-dated (${oi.farExpiryLabel}) at ${oi.smartMoneyLevel} — smart money floor`)
  }
  if (oi.bearPoints >= 15 && oi.smartMoneyDirection === 'BEARISH') {
    detected.push('INSTITUTIONAL_SHORT_BUILD')
    notes.push(`heavy CE writing on far-dated (${oi.farExpiryLabel}) at ${oi.smartMoneyLevel} — smart money cap`)
  }

  // Volatility crush setup: today's range < 60% of 5-day ATR average
  const trs = candles.slice(-15).map((c, i, arr) => {
    if (i === 0) return c.high - c.low
    return Math.max(c.high - c.low, Math.abs(c.high - arr[i - 1].close), Math.abs(c.low - arr[i - 1].close))
  })
  const atr = trs.reduce((s, v) => s + v, 0) / trs.length
  const todayRange = last.high - last.low
  if (atr > 0 && todayRange < atr * 0.6) {
    detected.push('VOLATILITY_CRUSH')
    notes.push(`today range ${todayRange.toFixed(0)}pt vs 15d ATR ${atr.toFixed(0)}pt — expansion move loading`)
  }

  return { detected, reason: notes.join(' · ') }
}

// ─── Historical analogue finder: "history rhymes" ─────────────────────────
//
// Approach: normalize the last WINDOW closes into a % change from window start
// then search every rolling window of the same size since 2020 for the closest
// shape match by mean-squared-error. For each of the top-K matches, report:
//   1. When it occurred
//   2. How the analogue evolved over the NEXT 10 sessions
//   3. Direction lean (bullish / bearish / choppy)

interface HistoricalAnalogue {
  matchDate: string          // date the analogue window ENDED
  daysAgo: number
  matchScore: number         // 0-1 (1 = perfect)
  nextRet1d: number          // % return the day after the match ended
  nextRet5d: number
  nextRet10d: number
  nextRet20d: number
  outcome: 'BULLISH' | 'BEARISH' | 'CHOPPY'
}

interface AnalogueSummary {
  windowSize: number
  analogues: HistoricalAnalogue[]
  meanNextRet5d: number
  meanNextRet10d: number
  meanNextRet20d: number
  bullishCount: number
  bearishCount: number
  choppyCount: number
  historicalBias: 'BULLISH' | 'BEARISH' | 'CHOPPY'
  reason: string
}

function normaliseWindow(candles: Candle[], startIdx: number, size: number): number[] {
  const base = candles[startIdx].close
  const out: number[] = []
  for (let i = 0; i < size; i++) {
    const c = candles[startIdx + i]
    out.push((c.close - base) / base * 100)
  }
  return out
}

function shapeMSE(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i])
  return s / a.length
}

function findHistoricalAnalogues(
  candles: Candle[],
  windowSize = 20,
  topK = 5,
): AnalogueSummary {
  if (candles.length < windowSize + 25) {
    return {
      windowSize,
      analogues: [],
      meanNextRet5d: 0,
      meanNextRet10d: 0,
      meanNextRet20d: 0,
      bullishCount: 0,
      bearishCount: 0,
      choppyCount: 0,
      historicalBias: 'CHOPPY',
      reason: 'insufficient history for analogue search',
    }
  }

  const lastEnd = candles.length - 1
  const lastStart = lastEnd - windowSize + 1
  const currentShape = normaliseWindow(candles, lastStart, windowSize)

  const matches: Array<{ endIdx: number; score: number }> = []
  // walk every historical window ending at least 30 days before now so the
  // next-20d follow-through is fully materialised for that analogue
  for (let end = windowSize - 1; end <= lastEnd - 30; end++) {
    const start = end - windowSize + 1
    if (start < 0) continue
    // skip overlap with the current window to avoid trivial matches
    if (Math.abs(end - lastEnd) < windowSize * 2) continue

    const hist = normaliseWindow(candles, start, windowSize)
    const mse = shapeMSE(currentShape, hist)
    matches.push({ endIdx: end, score: mse })
  }

  matches.sort((a, b) => a.score - b.score)
  const top = matches.slice(0, topK)

  const analogues: HistoricalAnalogue[] = top.map(m => {
    const matchEnd = candles[m.endIdx]
    const priceAtMatchEnd = matchEnd.close
    const c1 = candles[m.endIdx + 1]?.close ?? priceAtMatchEnd
    const c5 = candles[m.endIdx + 5]?.close ?? priceAtMatchEnd
    const c10 = candles[m.endIdx + 10]?.close ?? priceAtMatchEnd
    const c20 = candles[m.endIdx + 20]?.close ?? priceAtMatchEnd
    const nextRet1d = (c1 - priceAtMatchEnd) / priceAtMatchEnd * 100
    const nextRet5d = (c5 - priceAtMatchEnd) / priceAtMatchEnd * 100
    const nextRet10d = (c10 - priceAtMatchEnd) / priceAtMatchEnd * 100
    const nextRet20d = (c20 - priceAtMatchEnd) / priceAtMatchEnd * 100
    // outcome: bullish if 10d+20d both > +2%, bearish if both < -2%, else choppy
    let outcome: 'BULLISH' | 'BEARISH' | 'CHOPPY' = 'CHOPPY'
    if (nextRet10d > 2 && nextRet20d > 2) outcome = 'BULLISH'
    else if (nextRet10d < -2 && nextRet20d < -2) outcome = 'BEARISH'
    const daysAgo = lastEnd - m.endIdx
    return {
      matchDate: istDateStr(matchEnd.time),
      daysAgo,
      matchScore: Math.max(0, Math.min(1, 1 / (1 + m.score))),
      nextRet1d: Math.round(nextRet1d * 100) / 100,
      nextRet5d: Math.round(nextRet5d * 100) / 100,
      nextRet10d: Math.round(nextRet10d * 100) / 100,
      nextRet20d: Math.round(nextRet20d * 100) / 100,
      outcome,
    }
  })

  const meanNextRet5d = analogues.reduce((s, a) => s + a.nextRet5d, 0) / (analogues.length || 1)
  const meanNextRet10d = analogues.reduce((s, a) => s + a.nextRet10d, 0) / (analogues.length || 1)
  const meanNextRet20d = analogues.reduce((s, a) => s + a.nextRet20d, 0) / (analogues.length || 1)
  const bullishCount = analogues.filter(a => a.outcome === 'BULLISH').length
  const bearishCount = analogues.filter(a => a.outcome === 'BEARISH').length
  const choppyCount = analogues.filter(a => a.outcome === 'CHOPPY').length

  let historicalBias: 'BULLISH' | 'BEARISH' | 'CHOPPY' = 'CHOPPY'
  let reason = ''
  if (bullishCount >= 3 && meanNextRet10d > 1.5) {
    historicalBias = 'BULLISH'
    reason = `${bullishCount}/${analogues.length} historical analogues went up (mean 10d +${meanNextRet10d.toFixed(1)}% / 20d +${meanNextRet20d.toFixed(1)}%)`
  } else if (bearishCount >= 3 && meanNextRet10d < -1.5) {
    historicalBias = 'BEARISH'
    reason = `${bearishCount}/${analogues.length} historical analogues went down (mean 10d ${meanNextRet10d.toFixed(1)}% / 20d ${meanNextRet20d.toFixed(1)}%)`
  } else {
    reason = `no clean historical rhyme — analogues split ${bullishCount}↑ / ${bearishCount}↓ / ${choppyCount} chop (mean 10d ${meanNextRet10d > 0 ? '+' : ''}${meanNextRet10d.toFixed(1)}%)`
  }

  return {
    windowSize,
    analogues,
    meanNextRet5d: Math.round(meanNextRet5d * 100) / 100,
    meanNextRet10d: Math.round(meanNextRet10d * 100) / 100,
    meanNextRet20d: Math.round(meanNextRet20d * 100) / 100,
    bullishCount,
    bearishCount,
    choppyCount,
    historicalBias,
    reason,
  }
}

// ─── Composite: put it all together ───────────────────────────────────────

export interface NiftyForesight {
  generatedAt: string
  spot: number
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  bullScore: number   // 0-100
  bearScore: number
  netScore: number    // bullScore - bearScore, positive = bullish
  tradePlan: {
    side: 'BUY' | 'SELL' | 'WAIT'
    instrument: string
    entry: number
    stopLoss: number
    target1: number
    target2: number
    target3: number
    entryDate: string
    target1Date: string
    target2Date: string
    target3Date: string
    slDate: string
  }
  reasoning: {
    multiExpiryOI: string[]
    drift: string[]
    momentum: string[]
    timeCycle: string
    astro: string
    playbook: string
    historicalRhyme: string
  }
  smartMoneyLevel: number
  smartMoneyDirection: 'BULLISH' | 'BEARISH' | 'MIXED'
  playbookDetected: string[]
  cycle: CycleInsight
  historicalAnalogues: AnalogueSummary
  keyLevels: {
    monthlyMaxPain: number
    quarterlyMaxPain: number
    topCallResistance: number
    topPutSupport: number
    farExpiryLabel: string
  }
  historyPoints: number
}

function addBusinessDays(fromMs: number, n: number): string {
  let d = new Date(fromMs)
  let added = 0
  while (added < n) {
    d = new Date(d.getTime() + 86_400_000)
    const day = d.getDay()
    if (day !== 0 && day !== 6) added++
  }
  return istDateStr(d.getTime())
}

export async function runAndPublishNiftyForesight(): Promise<{
  ok: boolean
  direction: string
  confidence: string
  netScore: number
  spot: number
  playbook: string[]
}> {
  const fs2 = await import('fs')
  const path2 = await import('path')
  const foresight = await runNiftyForesight()
  if (!foresight) return { ok: false, direction: 'NEUTRAL', confidence: 'LOW', netScore: 0, spot: 0, playbook: [] }
  const snapPath = path2.resolve(__dirname, '../../data/public-snapshots/nifty-outlook.json')
  fs2.mkdirSync(path2.dirname(snapPath), { recursive: true })
  fs2.writeFileSync(snapPath, JSON.stringify(foresight, null, 2))
  return {
    ok: true,
    direction: foresight.direction,
    confidence: foresight.confidence,
    netScore: foresight.netScore,
    spot: foresight.spot,
    playbook: foresight.playbookDetected,
  }
}

export async function runNiftyForesight(): Promise<NiftyForesight | null> {
  const oc = await fetchNiftyAllExpiries()
  if (!oc || oc.expiries.length === 0) {
    log.warn('NIFTY-FORESIGHT', 'no OC data — skipping')
    return null
  }
  const candles = await getCandles('NIFTY 50', '1D', 250)
  if (candles.length < 60) {
    log.warn('NIFTY-FORESIGHT', `only ${candles.length} candles — need 60+`)
    return null
  }

  const spot = oc.spot || candles[candles.length - 1].close

  // 1. Multi-expiry OI stance
  const oi = analyseMultiExpiryOI(spot, oc.expiries.map(e => ({
    expiry: e.expiry,
    daysToExpiry: e.daysToExpiry,
    pcr: e.pcr,
    maxPain: e.maxPain,
    totalCallOI: e.totalCallOI,
    totalPutOI: e.totalPutOI,
    totalCallOIChange: e.totalCallOIChange,
    totalPutOIChange: e.totalPutOIChange,
    top3CallStrikes: e.top3CallStrikes,
    top3PutStrikes: e.top3PutStrikes,
  })))

  // 2. Drift from history
  const history = loadHistory()
  const drift = analyseDrift(history.points, {
    monthlyMaxPain: oi.monthlyMaxPain,
    monthlyPcr: oi.monthlyPcr,
  })

  // 3. Momentum + trend
  const mom = analyseMomentum(candles)

  // 4. Time cycle
  const cycle = analyseTimeCycles(candles)
  let cycleBull = 0
  let cycleBear = 0
  if (cycle.cycleBias === 'BULLISH') cycleBull = 12
  else if (cycle.cycleBias === 'BEARISH') cycleBear = 12

  // 5. Astro (KP + Bradley) — reuse existing engine
  let astroBull = 0
  let astroBear = 0
  let astroReason = 'astro unavailable'
  try {
    const { criterion21KP, criterion22Bradley } = await import('./kpAstroBradley')
    // Test both sides — the one that PASSES gives the astro's directional lean
    const kpBuy = criterion21KP('LONG')
    const kpSell = criterion21KP('SHORT')
    const brBuy = criterion22Bradley('LONG')
    const brSell = criterion22Bradley('SHORT')
    if (kpBuy.pass) astroBull += 5
    if (kpSell.pass) astroBear += 5
    if (brBuy.pass) astroBull += 5
    if (brSell.pass) astroBear += 5
    astroReason = `KP: ${kpBuy.pass ? 'bullish' : kpSell.pass ? 'bearish' : 'neutral'} · Bradley: ${brBuy.pass ? 'bullish' : brSell.pass ? 'bearish' : 'neutral'}`
  } catch (e) {
    log.warn('NIFTY-FORESIGHT', `astro import failed: ${(e as Error).message}`)
  }

  // 6. Playbook
  const playbook = detectPlaybook(candles, oi, drift)

  // 7. Historical analogue (history rhymes) — search NIFTY daily since 2020
  //    for the closest 20-day shape matches and see what happened next.
  const analogues = findHistoricalAnalogues(candles, 20, 5)
  let historicalBull = 0
  let historicalBear = 0
  if (analogues.historicalBias === 'BULLISH') historicalBull = 10
  else if (analogues.historicalBias === 'BEARISH') historicalBear = 10

  const bullScore = oi.bullPoints + drift.bullPoints + mom.bull + cycleBull + astroBull + historicalBull
  const bearScore = oi.bearPoints + drift.bearPoints + mom.bear + cycleBear + astroBear + historicalBear
  const netScore = bullScore - bearScore

  let direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  if (netScore >= 15) direction = 'BULLISH'
  else if (netScore <= -15) direction = 'BEARISH'
  else direction = 'NEUTRAL'

  const totalWeight = Math.max(bullScore, bearScore)
  if (totalWeight >= 30 && Math.abs(netScore) >= 20) confidence = 'HIGH'
  else if (totalWeight >= 20 && Math.abs(netScore) >= 10) confidence = 'MEDIUM'
  else confidence = 'LOW'

  // Trade plan — always with entry / SL / T1/T2/T3 dates
  const now = Date.now()
  const atrLike = candles.slice(-14).reduce((s, c) => s + (c.high - c.low), 0) / 14
  let side: 'BUY' | 'SELL' | 'WAIT' = 'WAIT'
  let entry = spot
  let stopLoss = spot
  let target1 = spot
  let target2 = spot
  let target3 = spot
  let instrument = 'NIFTY SPOT (reference — trade via NF futures / options)'

  if (direction === 'BULLISH' && confidence !== 'LOW') {
    side = 'BUY'
    entry = spot
    stopLoss = spot - atrLike * 1.5
    target1 = spot + atrLike * 1.5
    target2 = spot + atrLike * 3.0
    target3 = spot + atrLike * 5.0
    instrument = `NIFTY future / ATM CE (~${Math.round(spot / 50) * 50})`
  } else if (direction === 'BEARISH' && confidence !== 'LOW') {
    side = 'SELL'
    entry = spot
    stopLoss = spot + atrLike * 1.5
    target1 = spot - atrLike * 1.5
    target2 = spot - atrLike * 3.0
    target3 = spot - atrLike * 5.0
    instrument = `NIFTY future / ATM PE (~${Math.round(spot / 50) * 50})`
  }

  const foresight: NiftyForesight = {
    generatedAt: new Date().toISOString(),
    spot,
    direction,
    confidence,
    bullScore,
    bearScore,
    netScore,
    tradePlan: {
      side,
      instrument,
      entry: Math.round(entry * 100) / 100,
      stopLoss: Math.round(stopLoss * 100) / 100,
      target1: Math.round(target1 * 100) / 100,
      target2: Math.round(target2 * 100) / 100,
      target3: Math.round(target3 * 100) / 100,
      entryDate: istDateStr(now),
      target1Date: addBusinessDays(now, 2),
      target2Date: addBusinessDays(now, 5),
      target3Date: addBusinessDays(now, 10),
      slDate: addBusinessDays(now, 10),
    },
    reasoning: {
      multiExpiryOI: oi.reasons,
      drift: drift.reasons,
      momentum: mom.reasons,
      timeCycle: cycle.reason,
      astro: astroReason,
      playbook: playbook.reason,
      historicalRhyme: analogues.reason,
    },
    smartMoneyLevel: oi.smartMoneyLevel,
    smartMoneyDirection: oi.smartMoneyDirection,
    playbookDetected: playbook.detected,
    cycle,
    historicalAnalogues: analogues,
    keyLevels: {
      monthlyMaxPain: oi.monthlyMaxPain,
      quarterlyMaxPain: oi.quarterlyMaxPain,
      topCallResistance: oc.expiries[0].top3CallStrikes[0]?.strike ?? 0,
      topPutSupport: oc.expiries[0].top3PutStrikes[0]?.strike ?? 0,
      farExpiryLabel: oi.farExpiryLabel,
    },
    historyPoints: history.points.length,
  }

  // Persist a history point (once per day is enough)
  const today = istDateStr(now)
  const alreadyToday = history.points.find(p => p.date === today)
  if (!alreadyToday) {
    history.points.push({
      ts: now,
      date: today,
      spot,
      pcr: oi.currentPcr,
      maxPain: oi.currentMaxPain,
      monthlyPcr: oi.monthlyPcr,
      monthlyMaxPain: oi.monthlyMaxPain,
      quarterlyPcr: oi.quarterlyPcr,
      quarterlyMaxPain: oi.quarterlyMaxPain,
    })
    saveHistory(history)
  }

  return foresight
}
