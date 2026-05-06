import { addDays, daysBetween } from '../util/time'
import {
  GANN_CYCLES_DAYS, type CycleSeed, seedsFor,
  NIFTY_SEEDS, BANKNIFTY_SEEDS, GOLD_SEEDS, CRUDE_SEEDS,
} from './timeCycles'
import { squareOf9Levels, nearestGannLevels, type GannLevel } from './squareOf9'
import type { Candle } from '../types'
import { detectHarmonic, type HarmonicPattern } from '../patterns/harmonic'
import { getElliottContext, type ElliottContext } from '../patterns/elliott'

/**
 * Comprehensive Gann cycle analysis.
 *
 * For any symbol + price, this returns:
 *   - which cycle we're currently inside (per cycle length)
 *   - days elapsed / days remaining / % through the cycle
 *   - the next reversal date for each cycle
 *   - bucketed view: minor (≤60d) · major (90-180d) · larger (≥270d)
 *   - Square-of-9 support/resistance levels
 *   - 1×1 / 2×1 / 1×2 angle projections
 *   - degree (price-time squaring) status
 *
 * Reference: W.D. Gann's "How to Make Profits in Commodities" + Square of 9
 * methodology. Cycles are anchored to historical major swings (high/low
 * pivots) — see timeCycles.ts seed lists.
 */

export type CycleBucket = 'MINOR' | 'MAJOR' | 'LARGER'

export interface ActiveCycle {
  bucket: CycleBucket
  cycleDays: number
  cycleLabel: string             // "90d" / "144d" / "1-year"
  seedName: string               // e.g. "Mar 2020 COVID low"
  seedDate: string               // ISO date
  seedKind: 'HIGH' | 'LOW'
  importance: 'HIGH' | 'MED' | 'LOW'
  cycleStart: string             // ISO — when this cycle iteration started
  cycleEnd: string               // ISO — when it ends (next reversal date)
  daysElapsed: number
  daysRemaining: number
  pctComplete: number            // 0-100
}

export interface ReversalDate {
  date: string                   // ISO
  daysAway: number               // negative for past, 0 for today, positive future
  cycleDays: number
  cycleLabel: string
  seedName: string
  seedDate: string
  importance: 'HIGH' | 'MED' | 'LOW'
  bucket: CycleBucket
  type: 'CYCLE_END'              // future-proofed for adding "ASTRO" / "GANN_DEGREE" later
}

export interface SquareOf9Snapshot {
  seed: number
  seedLabel: string
  currentPrice: number
  support: GannLevel[]
  resistance: GannLevel[]
  nearest: { price: number; label: string; angle: number; distancePct: number } | null
}

export interface GannAngleLevel {
  /** Angle ratio (e.g. "1×1" = 1 unit of price per 1 unit of time) */
  ratio: string
  slope: number                  // price units per day (per chart scale)
  startDate: string
  startPrice: number
  currentLine: number            // projected line value at today
  distancePct: number            // % distance of price from this line
}

export interface GannCycleStatus {
  symbol: string
  asOf: string
  currentPrice: number
  /** All cycles currently in progress, sorted by % complete ascending. */
  activeCycles: ActiveCycle[]
  /** Aggregated by bucket — easy UI rendering. */
  byBucket: Record<CycleBucket, ActiveCycle[]>
  /** All upcoming reversal hits within the lookahead window. */
  reversals: ReversalDate[]
  /** Highest-importance reversal in the next 30 sessions. */
  nextMajorReversal: ReversalDate | null
  /** Square-of-9 levels around current price. */
  squareOf9: SquareOf9Snapshot
  /** Gann angle projections from the most recent significant pivot. */
  angles: GannAngleLevel[]
  /** Degree analysis — is price-time squared? */
  degreeStatus: {
    daysFromSeed: number
    sqrtSeedPrice: number
    expectedTimeSquare: number   // days where time = sqrt(seed price) * harmonic
    isSquared: boolean           // current day matches a harmonic of sqrt(price)
    note: string
  }
}

const MINOR_DAYS = [30, 45, 60]
const MAJOR_DAYS = [90, 120, 144, 180]
const LARGER_DAYS = [270, 360]

function bucketFor(cd: number): CycleBucket {
  if (cd <= 60) return 'MINOR'
  if (cd <= 180) return 'MAJOR'
  return 'LARGER'
}

function labelFor(cd: number): string {
  if (cd === 360) return '1-year (360d)'
  if (cd === 270) return '9-month (270d)'
  if (cd === 180) return '6-month (180d)'
  if (cd === 144) return 'Gann 144d'
  if (cd === 120) return '4-month (120d)'
  if (cd === 90) return 'Quarter (90d)'
  return `${cd}d`
}

/**
 * For each (seed, cycleDays) pair, compute the current iteration:
 * the most recent "anchor day" (seed + N×cycleDays) and the next.
 */
function computeActiveCycles(seeds: CycleSeed[], today: Date): ActiveCycle[] {
  const out: ActiveCycle[] = []
  const todayMs = today.getTime()
  for (const seed of seeds) {
    const daysSince = daysBetween(today, seed.date)
    if (daysSince <= 0) continue
    for (const cd of GANN_CYCLES_DAYS) {
      // Current iteration N = floor(daysSince / cd)
      const n = Math.floor(daysSince / cd)
      const cycleStart = addDays(seed.date, n * cd)
      const cycleEnd = addDays(seed.date, (n + 1) * cd)
      const elapsed = Math.max(0, Math.floor((todayMs - cycleStart.getTime()) / 86_400_000))
      const remaining = Math.max(0, Math.floor((cycleEnd.getTime() - todayMs) / 86_400_000))
      out.push({
        bucket: bucketFor(cd),
        cycleDays: cd,
        cycleLabel: labelFor(cd),
        seedName: seed.name,
        seedDate: seed.date.toISOString().slice(0, 10),
        seedKind: seed.kind,
        importance: seed.importance,
        cycleStart: cycleStart.toISOString().slice(0, 10),
        cycleEnd: cycleEnd.toISOString().slice(0, 10),
        daysElapsed: elapsed,
        daysRemaining: remaining,
        pctComplete: Math.round((elapsed / cd) * 100),
      })
    }
  }
  return out.sort((a, b) => a.pctComplete - b.pctComplete)
}

function computeReversals(seeds: CycleSeed[], today: Date, windowDays = 120): ReversalDate[] {
  const out: ReversalDate[] = []
  for (const seed of seeds) {
    const daysSince = daysBetween(today, seed.date)
    for (const cd of GANN_CYCLES_DAYS) {
      const rem = daysSince % cd
      const daysAway = rem === 0 ? 0 : cd - rem
      if (daysAway > windowDays) continue
      const hitDate = addDays(today, daysAway)
      out.push({
        date: hitDate.toISOString().slice(0, 10),
        daysAway,
        cycleDays: cd,
        cycleLabel: labelFor(cd),
        seedName: seed.name,
        seedDate: seed.date.toISOString().slice(0, 10),
        importance: cd >= 90 ? seed.importance : (seed.importance === 'HIGH' ? 'MED' : 'LOW'),
        bucket: bucketFor(cd),
        type: 'CYCLE_END',
      })
    }
  }
  return out.sort((a, b) => a.daysAway - b.daysAway)
}

function computeSquareOf9(price: number, seeds: CycleSeed[]): SquareOf9Snapshot {
  // Pick the most-significant recent seed price as the anchor. We use the
  // most recent HIGH-importance pivot whose date is older than 30 days.
  const recent = [...seeds]
    .filter(s => s.importance === 'HIGH')
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0] ?? seeds[0]

  // Use 100 as the seed value if we don't have an explicit price for the
  // pivot — the level grid is anchored to price space (Gann's original
  // method uses the actual pivot price).
  const seedPrice = (recent as any).price ?? price * 0.85
  const { support, resistance } = nearestGannLevels(price, seedPrice)
  const all = squareOf9Levels(seedPrice, 3)
  const nearest = all
    .map(l => ({ ...l, distancePct: Math.abs((l.price - price) / price) * 100 }))
    .sort((a, b) => a.distancePct - b.distancePct)[0]
  return {
    seed: seedPrice,
    seedLabel: recent.name,
    currentPrice: price,
    support,
    resistance,
    nearest: nearest ? { price: nearest.price, label: nearest.label, angle: nearest.angle, distancePct: nearest.distancePct } : null,
  }
}

function computeAngles(seeds: CycleSeed[], price: number, today: Date): GannAngleLevel[] {
  const recent = [...seeds]
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0]
  if (!recent) return []
  const startPrice = (recent as any).price ?? price * 0.85
  const startDate = recent.date
  const daysFromStart = Math.max(1, daysBetween(today, startDate))
  // 1×1 = ATR-scale unit per day. Without a true price unit, we use 1% of
  // start price per day as the canonical 1×1 reference (a common trader
  // convention for software adaptations of Gann angles on percentage charts).
  const oneUnit = startPrice * 0.01
  const ratios: { ratio: string; mult: number }[] = [
    { ratio: '1×1', mult: 1 }, { ratio: '2×1', mult: 2 }, { ratio: '4×1', mult: 4 },
    { ratio: '1×2', mult: 0.5 }, { ratio: '1×4', mult: 0.25 },
  ]
  return ratios.map(r => {
    const slope = oneUnit * r.mult
    const currentLine = startPrice + slope * daysFromStart * (recent.kind === 'LOW' ? 1 : -1)
    return {
      ratio: r.ratio,
      slope,
      startDate: startDate.toISOString().slice(0, 10),
      startPrice,
      currentLine: +currentLine.toFixed(2),
      distancePct: +(((price - currentLine) / price) * 100).toFixed(2),
    }
  })
}

function computeDegree(seeds: CycleSeed[], price: number, today: Date): GannCycleStatus['degreeStatus'] {
  // Gann's price-time squaring: when (days from seed) ≈ √(seed price) ×
  // harmonic, the move is "squared" and prone to reversal.
  const recent = [...seeds]
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0]
  if (!recent) {
    return { daysFromSeed: 0, sqrtSeedPrice: 0, expectedTimeSquare: 0, isSquared: false, note: 'No seed available' }
  }
  const seedPrice = (recent as any).price ?? price * 0.85
  const sqrt = Math.sqrt(seedPrice)
  const daysFromSeed = daysBetween(today, recent.date)
  const harmonics = [sqrt, sqrt * 2, sqrt * 4, sqrt * 8, sqrt * 16]
  // Find closest harmonic
  let closest = harmonics[0]; let bestDiff = Infinity
  for (const h of harmonics) {
    const diff = Math.abs(daysFromSeed - h)
    if (diff < bestDiff) { closest = h; bestDiff = diff }
  }
  const isSquared = bestDiff <= 5         // within 5 days of a harmonic
  return {
    daysFromSeed,
    sqrtSeedPrice: +sqrt.toFixed(2),
    expectedTimeSquare: +closest.toFixed(0),
    isSquared,
    note: isSquared
      ? `Price-time SQUARED — ${daysFromSeed} days from ${recent.name} ≈ √${seedPrice.toFixed(0)} × harmonic. High reversal probability.`
      : `Price-time NOT squared — ${Math.round(bestDiff)} days from next harmonic at day ${Math.round(closest)}.`,
  }
}

export function getGannCycleStatus(symbol: string, currentPrice: number, today: Date = new Date()): GannCycleStatus {
  const seeds = seedsFor(symbol)
  const active = computeActiveCycles(seeds, today)
  const reversals = computeReversals(seeds, today, 120)
  const nextMajor = reversals.find(r => r.importance === 'HIGH' && r.bucket !== 'MINOR' && r.daysAway <= 30) ?? null
  const sq9 = computeSquareOf9(currentPrice, seeds)
  const angles = computeAngles(seeds, currentPrice, today)
  const degree = computeDegree(seeds, currentPrice, today)

  const byBucket: Record<CycleBucket, ActiveCycle[]> = { MINOR: [], MAJOR: [], LARGER: [] }
  for (const c of active) byBucket[c.bucket].push(c)
  for (const k of Object.keys(byBucket) as CycleBucket[]) {
    byBucket[k].sort((a, b) => b.importance.localeCompare(a.importance) || a.daysRemaining - b.daysRemaining)
  }

  return {
    symbol,
    asOf: today.toISOString(),
    currentPrice,
    activeCycles: active,
    byBucket,
    reversals,
    nextMajorReversal: nextMajor,
    squareOf9: sq9,
    angles,
    degreeStatus: degree,
  }
}

/**
 * Actionable trade plan derived from the strongest active cycle. Picks the
 * highest-importance MAJOR/LARGER cycle nearest its end date, infers
 * direction from the seed (cycle anchored to LOW → expect rally at end;
 * HIGH → expect decline), and uses Square-of-9 levels to define entry, SL,
 * T1, T2.
 */
export interface BestCycleTrade {
  cycle: ActiveCycle                        // which cycle we're trading around
  direction: 'BUY' | 'SELL'
  rationale: string                          // plain-English reasoning
  entry: number
  stopLoss: number
  target1: number
  target2: number
  entryByDate: string                        // when to enter (today, or the reversal date)
  exitByDate: string                         // cycle end or next major reversal
  holdDays: number
  riskReward: number
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  confidenceNotes: string[]
  /** Bias from each lens — used to spot conflicts. Set when daily candles are passed. */
  cycleBias?: 'BUY' | 'SELL'                // direction the cycle alone suggested
  harmonic?: HarmonicPattern | null         // best fresh harmonic on the daily (if any)
  elliott?: ElliottContext                  // wave-structure context
  conflicts?: string[]                       // human-readable conflicts forcing override / downgrade
  overridden?: boolean                       // true if cycle bias was flipped by harmonic+wave consensus
}

export function getBestCycleTrade(
  status: GannCycleStatus,
  today: Date = new Date(),
  candlesD?: Candle[],            // daily for Elliott + larger harmonics
  candlesShort?: Candle[],        // 1h/2h for fresher harmonic completions (the kind on TradingView intraday)
): BestCycleTrade | null {
  // Pick the MAJOR/LARGER, HIGH-importance cycle closest to end date.
  const candidates = status.activeCycles
    .filter(c => c.bucket !== 'MINOR' && c.importance !== 'LOW')
    .sort((a, b) => {
      // Prefer HIGH importance; among equal importance, prefer ending soonest
      const wA = a.importance === 'HIGH' ? 0 : 1
      const wB = b.importance === 'HIGH' ? 0 : 1
      if (wA !== wB) return wA - wB
      return a.daysRemaining - b.daysRemaining
    })
  const best = candidates[0]
  if (!best) return null

  // Cycle anchored to LOW: bearish iteration tops out ≈ end → expect decline
  //                      but often the next cycle starts with a rally anchor
  // We use the Gann convention: LOW-seed cycles project trend-day highs at
  // harmonic end; HIGH-seed project lows. For a simple "trade it now"
  // decision we flip by the seed kind AND the % complete of the cycle:
  //   - If cycle is in early phase (<30 %) and seed=LOW → bull setup
  //   - If cycle is in late phase (>70 %) and seed=LOW → reversal setup (short)
  //   - Seed=HIGH: reverse.
  const seedIsLow = best.seedKind === 'LOW'
  const earlyPhase = best.pctComplete < 40
  const latePhase  = best.pctComplete > 65
  let direction: 'BUY' | 'SELL' =
    (seedIsLow && earlyPhase) || (!seedIsLow && latePhase) ? 'BUY'
    : (seedIsLow && latePhase) || (!seedIsLow && earlyPhase) ? 'SELL'
    : seedIsLow ? 'BUY' : 'SELL'

  // Build entry / SL / T1 / T2 from Square-of-9 levels — but CAP the
  // distance so the trade plan is tradeable. Gann levels can be far away
  // from spot; for an intraday/short-swing execution we respect a:
  //   - max SL distance of 2.5 % (cycle-trade hurdle)
  //   - T1 within 3–5 % (realistic for a 5–15 day hold)
  //   - T2 within 6–10 %
  // When a Gann level is closer than the cap we use it; otherwise we use
  // the cap so R:R stays favourable.
  const resistance = status.squareOf9.resistance
  const support = status.squareOf9.support
  const spot = status.currentPrice

  // Cycle-trade execution limits:
  //   SL ≤ 2.5 % from entry (hurdle for cycle trading)
  //   T1 = 3–4 % · T2 = 6–8 % — realistic for 5-15 day cycle moves
  const maxSLpct = 2.5, maxT1pct = 4, maxT2pct = 8
  const capSL   = direction === 'BUY' ? spot * (1 - maxSLpct / 100) : spot * (1 + maxSLpct / 100)
  const capT1   = direction === 'BUY' ? spot * (1 + maxT1pct / 100) : spot * (1 - maxT1pct / 100)
  const capT2   = direction === 'BUY' ? spot * (1 + maxT2pct / 100) : spot * (1 - maxT2pct / 100)

  // SL picks the TIGHTER of (nearest-Gann-support, 2.5 % cap).
  // T1/T2 pick the CLOSER of (nearest-Gann-resistance, 4 %/8 % cap) — never
  // let a distant Gann level push the target beyond a realistic move window.
  const nearestSupport    = support[0]?.price
  const nextSupport       = support[1]?.price
  const nearestResistance = resistance[0]?.price
  const nextResistance    = resistance[1]?.price

  let entry = spot, stopLoss: number, target1: number, target2: number
  if (direction === 'BUY') {
    stopLoss = +Math.max(nearestSupport ?? 0, capSL).toFixed(2)
    target1  = +Math.min(nearestResistance ?? Infinity, capT1).toFixed(2)
    target2  = +Math.min(nextResistance    ?? Infinity, capT2).toFixed(2)
  } else {
    stopLoss = +Math.min(nearestResistance ?? Infinity, capSL).toFixed(2)
    target1  = +Math.max(nearestSupport    ?? 0, capT1).toFixed(2)
    target2  = +Math.max(nextSupport       ?? 0, capT2).toFixed(2)
  }
  // Safety: ensure direction-consistent ordering
  if (direction === 'BUY' && target1 <= entry) target1 = +(entry * 1.03).toFixed(2)
  if (direction === 'BUY' && target2 <= target1) target2 = +(entry * 1.06).toFixed(2)
  if (direction === 'SELL' && target1 >= entry) target1 = +(entry * 0.97).toFixed(2)
  if (direction === 'SELL' && target2 >= target1) target2 = +(entry * 0.94).toFixed(2)
  const risk = Math.abs(entry - stopLoss)
  const reward = Math.abs(target1 - entry)
  const rr = risk > 0 ? +(reward / risk).toFixed(2) : 0

  // Entry date — if a HIGH reversal is ≤3 days away, wait for it; else now
  const upcomingReversal = status.reversals.find(r => r.daysAway > 0 && r.daysAway <= 3 && r.importance === 'HIGH')
  const entryByDate = upcomingReversal ? upcomingReversal.date : today.toISOString().slice(0, 10)

  // Exit date — cycle end OR earliest high-importance reversal after entry
  const exitByDate = status.nextMajorReversal?.date ?? best.cycleEnd

  const holdDaysLookup = (a: string, b: string) =>
    Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)
  const holdDays = Math.max(1, holdDaysLookup(entryByDate, exitByDate))

  // Confidence
  const notes: string[] = []
  let confidenceScore = 0
  if (best.importance === 'HIGH') { confidenceScore += 2; notes.push('HIGH-importance pivot anchor') }
  if (best.bucket === 'LARGER') { confidenceScore += 1; notes.push(`${best.cycleLabel} larger cycle (${best.daysRemaining}d left)`) }
  if (status.degreeStatus.isSquared) { confidenceScore += 2; notes.push('Price–time SQUARED — elevated reversal probability') }
  if (upcomingReversal) { confidenceScore += 1; notes.push(`High reversal date ${upcomingReversal.date} (${upcomingReversal.cycleLabel}) confirms timing`) }
  if (rr >= 2) { confidenceScore += 1; notes.push(`R:R ${rr}:1 to T1 — favourable`) }
  if (status.squareOf9.nearest && status.squareOf9.nearest.distancePct < 1) {
    confidenceScore += 1
    notes.push(`Price within ${status.squareOf9.nearest.distancePct.toFixed(2)}% of Square-of-9 ${status.squareOf9.nearest.label} — key reaction zone`)
  }
  let confidence: BestCycleTrade['confidence'] =
    confidenceScore >= 5 ? 'HIGH' : confidenceScore >= 3 ? 'MEDIUM' : 'LOW'

  const phaseLabel = earlyPhase ? 'early phase' : latePhase ? 'late phase' : 'mid phase'
  const rationale =
    `${best.cycleLabel} cycle from ${best.seedName} is at ${best.pctComplete}% (${phaseLabel}). ` +
    `Seed was a ${best.seedKind}. With ${best.daysRemaining} days remaining and a ${direction} bias, ` +
    `Square-of-9 levels define entry at ₹${entry.toFixed(2)}, ` +
    `target ₹${target1.toFixed(2)} (${Math.abs(reward / entry * 100).toFixed(1)}% move). ` +
    (upcomingReversal
      ? `HIGH reversal date ${upcomingReversal.date} is the preferred entry window.`
      : `Enter today — no reversal dates within 3 sessions.`)

  // ─── Harmonic + Elliott confluence check ──────────────────────
  // The cycle scorer alone can suggest a direction that the price-structure
  // contradicts. Run harmonic detection + Elliott context on the daily
  // candles (if provided) and: (a) flag conflicts, (b) flip direction when
  // BOTH harmonic AND wave context contradict the cycle, (c) downgrade
  // confidence on partial conflicts.
  let cycleBias = direction
  const conflicts: string[] = []
  let overridden = false
  let harmonic: HarmonicPattern | null = null
  let elliott: ElliottContext | undefined

  if (candlesD && candlesD.length >= 30) {
    // Look for harmonic on BOTH timeframes — daily (larger structures) and
    // hourly (intraday completions like the user's 2h chart pattern). Take
    // the highest-confidence fresh one.
    const hDaily = detectHarmonic(candlesD, { minSwingPct: 1.5, maxAgeBars: 12 })
    const hShort = candlesShort && candlesShort.length >= 30
      ? detectHarmonic(candlesShort, { minSwingPct: 0.6, maxAgeBars: 24 })   // tighter swings for 1h
      : null
    const candidatesH = [hDaily, hShort].filter(Boolean) as HarmonicPattern[]
    candidatesH.sort((a, b) => (b.confidence - a.confidence) || (a.ageBars - b.ageBars))
    harmonic = candidatesH[0] ?? null
    elliott = getElliottContext(candlesD, 1.5)

    const harmonicSays: 'BUY' | 'SELL' | null = harmonic
      ? (harmonic.direction === 'BULLISH' ? 'BUY' : 'SELL')
      : null
    const elliottSays: 'BUY' | 'SELL' | null = elliott
      ? (elliott.phase === 'IMPULSE_UP' || elliott.phase === 'BOTTOMING' ? 'BUY'
         : elliott.phase === 'IMPULSE_DOWN' || elliott.phase === 'TOPPING' ? 'SELL'
         : null)
      : null

    if (harmonicSays && harmonicSays !== direction) {
      conflicts.push(
        `${harmonic!.name} ${harmonic!.direction} pattern (${harmonic!.confidence}% match) — ` +
        `D point at ₹${harmonic!.D.price.toFixed(2)}, says ${harmonicSays}`,
      )
    }
    if (elliottSays && elliottSays !== direction) {
      conflicts.push(`Elliott context: ${elliott!.phase.replace('_', ' ').toLowerCase()} (${elliott!.confidence}) — says ${elliottSays}`)
    }

    // OVERRIDE: both harmonic AND elliott contradict cycle → flip
    if (harmonicSays && elliottSays && harmonicSays === elliottSays && harmonicSays !== direction) {
      direction = harmonicSays
      overridden = true
      conflicts.unshift(`OVERRIDE: harmonic + Elliott both say ${harmonicSays} — cycle direction flipped`)
      // Recompute SL/T at new direction with same caps
      const capSL2 = direction === 'BUY' ? entry * 0.975 : entry * 1.025
      const capT1_ = direction === 'BUY' ? entry * 1.03  : entry * 0.97
      const capT2_ = direction === 'BUY' ? entry * 1.06  : entry * 0.94
      if (direction === 'BUY') {
        stopLoss = +Math.max(status.squareOf9.support[0]?.price ?? 0, capSL2).toFixed(2)
        target1  = +Math.min(status.squareOf9.resistance[0]?.price ?? Infinity, capT1_).toFixed(2)
        target2  = +Math.min(status.squareOf9.resistance[1]?.price ?? Infinity, capT2_).toFixed(2)
      } else {
        stopLoss = +Math.min(status.squareOf9.resistance[0]?.price ?? Infinity, capSL2).toFixed(2)
        target1  = +Math.max(status.squareOf9.support[0]?.price ?? 0, capT1_).toFixed(2)
        target2  = +Math.max(status.squareOf9.support[1]?.price ?? 0, capT2_).toFixed(2)
      }
      // If direction flipped, prefer using harmonic targets (closer to D) over Gann caps
      if (harmonic) {
        target1 = +(direction === 'BUY' ? Math.max(harmonic.targets.t1, target1) : Math.min(harmonic.targets.t1, target1)).toFixed(2)
        target2 = +(direction === 'BUY' ? Math.max(harmonic.targets.t2, target2) : Math.min(harmonic.targets.t2, target2)).toFixed(2)
        // Use harmonic SL — tighter than 2.5 % when it's nearby
        stopLoss = direction === 'BUY' ? +Math.min(stopLoss, harmonic.targets.sl).toFixed(2) : +Math.max(stopLoss, harmonic.targets.sl).toFixed(2)
      }
    }

    // Downgrade confidence on any unresolved conflict
    let confLevel = confidence
    if (conflicts.length && !overridden) {
      confLevel = confLevel === 'HIGH' ? 'MEDIUM' : 'LOW'
      notes.push(`Direction conflict — confidence downgraded to ${confLevel}`)
    }
    if (overridden) {
      confLevel = harmonic && harmonic.confidence >= 75 && elliott?.confidence === 'HIGH' ? 'HIGH' : 'MEDIUM'
      notes.unshift(`Cycle bias was ${cycleBias}; harmonic + Elliott consensus → ${direction}`)
    }
    confidence = confLevel
  }

  // Recompute risk-reward with possibly-updated targets
  const finalRisk = Math.abs(entry - stopLoss)
  const finalReward = Math.abs(target1 - entry)
  const finalRR = finalRisk > 0 ? +(finalReward / finalRisk).toFixed(2) : 0

  return {
    cycle: best,
    direction,
    rationale,
    entry: +entry.toFixed(2),
    stopLoss: +stopLoss.toFixed(2),
    target1: +target1.toFixed(2),
    target2: +target2.toFixed(2),
    entryByDate,
    exitByDate,
    holdDays,
    riskReward: finalRR,
    confidence,
    confidenceNotes: notes,
    cycleBias,
    harmonic,
    elliott,
    conflicts,
    overridden,
  }
}

/** Lighter-weight time-cycle-only response (no Square-of-9, no angles). */
export function getTimeCycleStatus(symbol: string, today: Date = new Date()) {
  const seeds = seedsFor(symbol)
  const active = computeActiveCycles(seeds, today)
  const reversals = computeReversals(seeds, today, 180)
  const byBucket: Record<CycleBucket, ActiveCycle[]> = { MINOR: [], MAJOR: [], LARGER: [] }
  for (const c of active) byBucket[c.bucket].push(c)
  // Anniversaries — same calendar date, prior years
  const anniversaries: { yearsAgo: number; date: string; seedName: string; seedDate: string }[] = []
  for (const seed of seeds) {
    const yearsAgo = today.getUTCFullYear() - seed.date.getUTCFullYear()
    if (yearsAgo > 0) {
      anniversaries.push({
        yearsAgo,
        date: seed.date.toISOString().slice(0, 10),
        seedName: seed.name,
        seedDate: seed.date.toISOString().slice(0, 10),
      })
    }
  }
  return {
    symbol,
    asOf: today.toISOString(),
    activeCycles: active,
    byBucket,
    reversals,
    anniversaries: anniversaries.sort((a, b) => a.yearsAgo - b.yearsAgo),
  }
}
