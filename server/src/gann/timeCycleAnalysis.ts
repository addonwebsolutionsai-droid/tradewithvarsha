import { GANN_CYCLES_DAYS, seedsFor, type CycleSeed } from './timeCycles'
import { daysBetween, addDays } from '../util/time'

/**
 * Deep time-cycle state analysis.
 *
 * Question: "Given today's date, what Gann cycle am I in, and is the next
 * pivot likely bullish or bearish?"
 *
 * Method:
 *   - From each major pivot (swing high/low), compute days elapsed and
 *     modulo each key cycle length (30/45/60/90/120/144/180/270/360).
 *   - Phase within cycle:
 *       0–30%  early (continuation of prior move)
 *       30–70% mid   (trend mature, watch for pivots)
 *       70–100% late (expect reversal — confluence matters)
 *   - From a LOW pivot: early-phase = bull continuation; late-phase = bull exhaustion.
 *   - From a HIGH pivot: early-phase = bear continuation; late-phase = bear exhaustion.
 *   - The NEXT cycle hit is the date when the modulo wraps to 0 again.
 */

export interface CyclePosition {
  fromSeedName: string
  fromSeedDate: string
  fromSeedKind: 'HIGH' | 'LOW'
  cycleDays: number
  daysInCycle: number         // e.g., "day 23 of 45"
  phase: 'early' | 'mid' | 'late'
  phasePct: number            // 0-100
  nextHitDate: string
  daysToNext: number
  biasNow: 'BULL' | 'BEAR' | 'NEUTRAL'
  biasNext: 'BULL' | 'BEAR' | 'NEUTRAL'
  importance: 'HIGH' | 'MED' | 'LOW'
  note: string
}

export interface TimeCycleReport {
  asOf: string
  symbol: string
  positions: CyclePosition[]
  dominantBiasNow: 'BULL' | 'BEAR' | 'NEUTRAL'
  nearestPivotDate: string
  nearestPivotBias: 'BULL' | 'BEAR' | 'NEUTRAL'
  summary: string
}

function biasFromSeed(kind: 'HIGH' | 'LOW', phase: 'early' | 'mid' | 'late'): 'BULL' | 'BEAR' | 'NEUTRAL' {
  if (kind === 'LOW') {
    if (phase === 'early') return 'BULL'
    if (phase === 'mid') return 'BULL'
    if (phase === 'late') return 'NEUTRAL' // exhaustion — bias shifts
  } else {
    if (phase === 'early') return 'BEAR'
    if (phase === 'mid') return 'BEAR'
    if (phase === 'late') return 'NEUTRAL'
  }
  return 'NEUTRAL'
}

function nextBiasFromSeed(kind: 'HIGH' | 'LOW', phase: 'early' | 'mid' | 'late'): 'BULL' | 'BEAR' | 'NEUTRAL' {
  // At cycle completion, the prevailing trend typically exhausts and reverses.
  if (phase === 'late') return kind === 'LOW' ? 'BEAR' : 'BULL'
  // Early/mid: next cycle is usually a continuation pivot (small pullback, not reversal)
  return kind === 'LOW' ? 'BULL' : 'BEAR'
}

export function analyzeTimeCycles(symbol: string, today: Date = new Date()): TimeCycleReport {
  const seeds = seedsFor(symbol)
  const positions: CyclePosition[] = []

  for (const seed of seeds) {
    const elapsed = daysBetween(today, seed.date)
    // Only consider seeds within 2 years — older ones get noisy
    if (elapsed > 730) continue

    for (const cd of GANN_CYCLES_DAYS) {
      const daysInCycle = elapsed % cd
      const daysToNext = cd - daysInCycle
      // Skip trivially far away cycles (more than 60 days out)
      if (daysToNext > 60) continue
      const phasePct = (daysInCycle / cd) * 100
      const phase: 'early' | 'mid' | 'late' =
        phasePct < 30 ? 'early' : phasePct < 70 ? 'mid' : 'late'
      const nextHit = addDays(today, daysToNext)
      const importance =
        cd >= 180 ? (seed.importance === 'HIGH' ? 'HIGH' : 'MED')
        : cd >= 90 ? seed.importance
        : (seed.importance === 'HIGH' ? 'MED' : 'LOW')
      const biasNow = biasFromSeed(seed.kind, phase)
      const biasNext = nextBiasFromSeed(seed.kind, phase)

      positions.push({
        fromSeedName: seed.name,
        fromSeedDate: seed.date.toISOString().slice(0, 10),
        fromSeedKind: seed.kind,
        cycleDays: cd,
        daysInCycle,
        phase,
        phasePct: +phasePct.toFixed(1),
        nextHitDate: nextHit.toISOString().slice(0, 10),
        daysToNext,
        biasNow,
        biasNext,
        importance,
        note: describePosition(seed, cd, daysInCycle, phase, daysToNext),
      })
    }
  }

  // Score & sort: HIGH importance + soonest + largest cycle
  positions.sort((a, b) => {
    const impOrder = { HIGH: 0, MED: 1, LOW: 2 }
    const di = impOrder[a.importance] - impOrder[b.importance]
    if (di !== 0) return di
    if (a.daysToNext !== b.daysToNext) return a.daysToNext - b.daysToNext
    return b.cycleDays - a.cycleDays
  })
  const top = positions.slice(0, 8)

  const biasVotes = top.reduce(
    (acc, p) => {
      if (p.biasNow === 'BULL') acc.bull += p.importance === 'HIGH' ? 2 : 1
      if (p.biasNow === 'BEAR') acc.bear += p.importance === 'HIGH' ? 2 : 1
      return acc
    },
    { bull: 0, bear: 0 },
  )
  const dominantBiasNow: 'BULL' | 'BEAR' | 'NEUTRAL' =
    biasVotes.bull > biasVotes.bear + 1 ? 'BULL'
    : biasVotes.bear > biasVotes.bull + 1 ? 'BEAR'
    : 'NEUTRAL'

  const nearest = top[0]
  return {
    asOf: today.toISOString().slice(0, 10),
    symbol,
    positions: top,
    dominantBiasNow,
    nearestPivotDate: nearest?.nextHitDate ?? '—',
    nearestPivotBias: nearest?.biasNext ?? 'NEUTRAL',
    summary: buildSummary(symbol, dominantBiasNow, top),
  }
}

function describePosition(seed: CycleSeed, cd: number, daysIn: number, phase: string, daysToNext: number): string {
  return `${daysIn}d of ${cd}d cycle from ${seed.kind} (${seed.name}) — ${phase}, next hit in ${daysToNext}d`
}

function buildSummary(symbol: string, dominantBias: string, top: CyclePosition[]): string {
  const lines: string[] = []
  lines.push(`${symbol} bias now: *${dominantBias}* (by cycle confluence)`)
  if (top[0]) {
    lines.push(`Next key cycle pivot: *${top[0].nextHitDate}* (${top[0].daysToNext}d) — likely ${top[0].biasNext}`)
  }
  return lines.join(' · ')
}
