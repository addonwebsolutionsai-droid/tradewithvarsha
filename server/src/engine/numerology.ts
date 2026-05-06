/**
 * Numerology for market-timing (W.D. Gann + Chaldean tradition).
 *
 *   - Sum all digits of a date (DDMMYYYY) → single digit via Pythagorean reduction.
 *   - Key "power" numbers for markets: 3, 7, 9, 11, 22 (master numbers).
 *   - Anniversary dates of major turns also carry weight.
 *   - Fadic = sum of numerological digit of DD + MM + YYYY (Chaldean day-number).
 */

export interface NumerologyTag {
  date: string
  lifePath: number     // reduced to 1-9 (master numbers 11/22 preserved)
  dayNumber: number    // reduced DD only
  kind: 'POWER' | 'ANNIVERSARY' | 'NEUTRAL'
  note: string
}

function reduce(n: number, preserveMasters = true): number {
  while (n > 9) {
    if (preserveMasters && (n === 11 || n === 22 || n === 33)) return n
    n = String(n).split('').reduce((s, c) => s + Number(c), 0)
  }
  return n
}

export function numerologyOf(date: Date): NumerologyTag {
  const dd = date.getUTCDate()
  const mm = date.getUTCMonth() + 1
  const yyyy = date.getUTCFullYear()
  const lifePath = reduce(reduce(dd) + reduce(mm) + reduce(yyyy))
  const dayNumber = reduce(dd)

  const isPower = [3, 7, 9, 11, 22].includes(lifePath) || [3, 7, 9].includes(dayNumber)
  const notes: string[] = []
  if (lifePath === 9) notes.push('Completion (9) — endings often fall on 9-days')
  if (lifePath === 3) notes.push('Expansion (3) — Gann-favored pivot day')
  if (lifePath === 7) notes.push('Spiritual (7) — historically volatile')
  if (lifePath === 11) notes.push('Master (11) — amplified sentiment')
  if (dayNumber === 3 || dayNumber === 7 || dayNumber === 9) notes.push(`Day-number ${dayNumber}`)

  return {
    date: date.toISOString().slice(0, 10),
    lifePath,
    dayNumber,
    kind: isPower ? 'POWER' : 'NEUTRAL',
    note: notes.join(' · ') || '—',
  }
}

/**
 * Well-known anniversary dates — crashes / tops / bottoms that tend to
 * "echo" year over year in world markets.
 */
export const MARKET_ANNIVERSARIES: { month: number; day: number; label: string }[] = [
  { month: 10, day: 19, label: '1987 Black Monday (-22.6%)' },
  { month: 10, day: 29, label: '1929 Black Tuesday' },
  { month: 9, day: 15,  label: '2008 Lehman collapse' },
  { month: 3,  day: 9,  label: '2009 bear-market bottom' },
  { month: 3,  day: 23, label: '2020 COVID low' },
  { month: 1,  day: 14, label: '2022 Nifty local top' },
  { month: 6,  day: 17, label: '2022 Nifty low' },
  { month: 9,  day: 27, label: '2024 Nifty record high' },
]

export function anniversaryNear(date: Date, windowDays = 2): { date: string; daysOff: number; label: string } | null {
  const mm = date.getUTCMonth() + 1
  const dd = date.getUTCDate()
  const yr = date.getUTCFullYear()
  for (const a of MARKET_ANNIVERSARIES) {
    const diffDays = Math.abs((new Date(Date.UTC(yr, a.month - 1, a.day)).getTime() - date.getTime()) / 86_400_000)
    if (diffDays <= windowDays) {
      return {
        date: new Date(Date.UTC(yr, a.month - 1, a.day)).toISOString().slice(0, 10),
        daysOff: Math.round(diffDays),
        label: a.label,
      }
    }
  }
  return null
}
