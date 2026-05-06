import { addDays, daysBetween } from '../util/time'

/**
 * Gann Time Cycles — common cycle lengths and anniversaries.
 *
 * Key cycles: 30, 45, 60, 90, 120, 144, 180, 270, 360 days
 *   (also half / quarter fractions of these).
 *
 * Anniversaries of previous major highs and lows are high-probability
 * reversal / acceleration windows.
 */

export const GANN_CYCLES_DAYS = [30, 45, 60, 90, 120, 144, 180, 270, 360]

export interface CycleSeed {
  name: string
  date: Date
  kind: 'HIGH' | 'LOW'
  importance: 'HIGH' | 'MED' | 'LOW'
}

export interface CycleHit {
  name: string
  date: string
  daysAway: number
  importance: 'HIGH' | 'MED' | 'LOW'
  cycleDays: number
  seedDate: string
}

/** Project forward — which cycles from these seeds fall within the next `windowDays`? */
export function projectCycles(
  seeds: CycleSeed[],
  today: Date,
  windowDays = 90,
): CycleHit[] {
  const hits: CycleHit[] = []
  for (const seed of seeds) {
    const daysSince = daysBetween(today, seed.date)
    for (const cd of GANN_CYCLES_DAYS) {
      // Next multiple of cd after `today`
      const rem = daysSince % cd
      const daysAway = rem === 0 ? 0 : cd - rem
      if (daysAway <= windowDays) {
        const hitDate = addDays(today, daysAway)
        const cycleLabel = cd >= 360 ? '360d' : `${cd}d`
        hits.push({
          name: `${cycleLabel} from ${seed.name}`,
          date: hitDate.toISOString().slice(0, 10),
          daysAway,
          importance: cd >= 90 ? seed.importance : (seed.importance === 'HIGH' ? 'MED' : 'LOW'),
          cycleDays: cd,
          seedDate: seed.date.toISOString().slice(0, 10),
        })
      }
    }
  }
  return hits
    .sort((a, b) => a.daysAway - b.daysAway)
    .filter((h, i, arr) => arr.findIndex(x => x.date === h.date) === i) // dedupe by date
}

/** Preset seed dates for Nifty (major swings since 2020). */
export const NIFTY_SEEDS: CycleSeed[] = [
  { name: 'Mar 2020 COVID low', date: new Date('2020-03-24'), kind: 'LOW', importance: 'HIGH' },
  { name: 'Oct 2021 high', date: new Date('2021-10-19'), kind: 'HIGH', importance: 'HIGH' },
  { name: 'Jun 2022 low', date: new Date('2022-06-17'), kind: 'LOW', importance: 'HIGH' },
  { name: 'Dec 2022 high', date: new Date('2022-12-01'), kind: 'HIGH', importance: 'MED' },
  { name: 'Mar 2023 low', date: new Date('2023-03-20'), kind: 'LOW', importance: 'MED' },
  { name: 'Sep 2024 high', date: new Date('2024-09-27'), kind: 'HIGH', importance: 'HIGH' },
  { name: 'Jun 2025 low', date: new Date('2025-06-05'), kind: 'LOW', importance: 'HIGH' },
  { name: 'Jan 2026 low', date: new Date('2026-01-15'), kind: 'LOW', importance: 'HIGH' },
]

export const BANKNIFTY_SEEDS: CycleSeed[] = [
  { name: 'Mar 2020 low', date: new Date('2020-03-24'), kind: 'LOW', importance: 'HIGH' },
  { name: 'Oct 2021 high', date: new Date('2021-10-25'), kind: 'HIGH', importance: 'HIGH' },
  { name: 'Jun 2022 low', date: new Date('2022-06-20'), kind: 'LOW', importance: 'HIGH' },
  { name: 'Sep 2024 high', date: new Date('2024-09-25'), kind: 'HIGH', importance: 'HIGH' },
]

export const GOLD_SEEDS: CycleSeed[] = [
  { name: 'Aug 2020 high', date: new Date('2020-08-07'), kind: 'HIGH', importance: 'HIGH' },
  { name: 'Nov 2022 low', date: new Date('2022-11-03'), kind: 'LOW', importance: 'MED' },
  { name: 'Oct 2023 low', date: new Date('2023-10-06'), kind: 'LOW', importance: 'HIGH' },
  { name: 'Apr 2025 major low', date: new Date('2025-04-12'), kind: 'LOW', importance: 'HIGH' },
]

export const CRUDE_SEEDS: CycleSeed[] = [
  { name: 'Apr 2020 low', date: new Date('2020-04-20'), kind: 'LOW', importance: 'HIGH' },
  { name: 'Mar 2022 high', date: new Date('2022-03-08'), kind: 'HIGH', importance: 'HIGH' },
  { name: 'May 2023 low', date: new Date('2023-05-04'), kind: 'LOW', importance: 'MED' },
]

export function seedsFor(symbol: string): CycleSeed[] {
  const s = symbol.toUpperCase()
  if (s.includes('NIFTY') && s.includes('BANK')) return BANKNIFTY_SEEDS
  if (s.includes('NIFTY')) return NIFTY_SEEDS
  if (s.includes('GOLD')) return GOLD_SEEDS
  if (s.includes('CRUDE')) return CRUDE_SEEDS
  return NIFTY_SEEDS
}
