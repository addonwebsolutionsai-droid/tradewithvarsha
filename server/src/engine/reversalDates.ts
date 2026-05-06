import { projectCycles, seedsFor } from '../gann'
import { gatherAstroEvents, type AstroEvent } from '../astro/events'
import { anniversaryNear, numerologyOf } from './numerology'
import { addDays } from '../util/time'

/**
 * Reversal Date Projector — combines:
 *   - Gann time cycles (30/45/60/90/120/144/180/270/360 days from major pivots)
 *   - Vedic astrology: planetary stations, sign ingresses
 *   - Mundane astrology: lunar phases (New/Full moon)
 *   - Numerology: power days (3/7/9/11/22)
 *   - Anniversaries of famous market turns
 *
 * A date scores higher the more sources converge on it ±2 days.
 */

export interface ReversalCandidate {
  date: string
  daysAway: number
  score: number
  kind: 'HIGH' | 'MED' | 'LOW'
  bias: 'TOP' | 'BOTTOM' | 'EITHER'
  sources: string[]
}

export interface ReversalReport {
  asOf: string
  symbol: string
  candidates: ReversalCandidate[]
  topPicks: ReversalCandidate[]
  narrative: string[]
}

export function projectReversals(symbol: string, today: Date = new Date(), windowDays = 60): ReversalReport {
  const candidates: Map<string, ReversalCandidate> = new Map()

  const touch = (dateStr: string, weight: number, source: string, bias: 'TOP' | 'BOTTOM' | 'EITHER' = 'EITHER') => {
    if (!candidates.has(dateStr)) {
      const daysAway = Math.round((new Date(dateStr + 'T00:00:00Z').getTime() - today.getTime()) / 86_400_000)
      candidates.set(dateStr, {
        date: dateStr,
        daysAway,
        score: 0,
        kind: 'LOW',
        bias: 'EITHER',
        sources: [],
      })
    }
    const c = candidates.get(dateStr)!
    c.score += weight
    c.sources.push(source)
    // Bias prefers TOP if coming from HIGH seed, BOTTOM from LOW seed
    if (bias !== 'EITHER' && c.bias === 'EITHER') c.bias = bias
  }

  // ─── Gann cycles ──────────────────────────────────────────────
  const seeds = seedsFor(symbol)
  const cycles = projectCycles(seeds, today, windowDays)
  for (const c of cycles) {
    const weight = c.importance === 'HIGH' ? 3 : c.importance === 'MED' ? 2 : 1
    const seed = seeds.find(s => c.name.includes(s.name))
    const bias: 'TOP' | 'BOTTOM' | 'EITHER' = seed ? (seed.kind === 'HIGH' ? 'TOP' : 'BOTTOM') : 'EITHER'
    touch(c.date, weight, `${c.cycleDays}d Gann from ${seed?.kind ?? ''} ${seed?.name ?? ''}`, bias)
  }

  // ─── Astro events ─────────────────────────────────────────────
  const events: AstroEvent[] = gatherAstroEvents(today, windowDays)
  for (const e of events) {
    const w = e.importance === 'HIGH' ? 2.5 : e.importance === 'MED' ? 1.5 : 1
    touch(e.date, w, e.title, 'EITHER')
  }

  // ─── Numerology + Anniversaries ───────────────────────────────
  for (let d = 1; d <= windowDays; d++) {
    const date = addDays(today, d)
    const n = numerologyOf(date)
    if (n.kind === 'POWER') {
      // Numerology alone is weak; only reinforces dates that already have something
      const key = date.toISOString().slice(0, 10)
      if (candidates.has(key)) {
        touch(key, 0.75, `numerology ${n.lifePath}/${n.dayNumber} — ${n.note.split(' · ')[0]}`)
      }
    }
    const ann = anniversaryNear(date, 1)
    if (ann) {
      touch(ann.date, 1.5, `anniversary: ${ann.label}`)
    }
  }

  // ─── Cluster nearby dates (±1 day) for mutual reinforcement ──
  const all = [...candidates.values()].sort((a, b) => a.daysAway - b.daysAway)
  for (let i = 0; i < all.length - 1; i++) {
    if (all[i + 1].daysAway - all[i].daysAway === 1) {
      const bonus = Math.min(all[i].score, all[i + 1].score) * 0.3
      all[i].score += bonus
      all[i + 1].score += bonus
    }
  }

  for (const c of all) {
    c.kind = c.score >= 5 ? 'HIGH' : c.score >= 3 ? 'MED' : 'LOW'
    // Determine bias by majority in sources
    const tops = c.sources.filter(s => /HIGH|top|Sun|retrograde|Full/i.test(s)).length
    const bots = c.sources.filter(s => /LOW|bottom|New|direct|bull/i.test(s)).length
    if (c.bias === 'EITHER') {
      if (tops > bots) c.bias = 'TOP'
      else if (bots > tops) c.bias = 'BOTTOM'
    }
  }

  // Rank by score, then soonest
  const ranked = all.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.daysAway - b.daysAway
  })
  const topPicks = ranked.filter(c => c.kind !== 'LOW').slice(0, 6)

  const narrative = topPicks.map(c =>
    `${icon(c)} *${c.date}* (${c.daysAway}d, ${c.bias}) — score ${c.score.toFixed(1)}`,
  )

  return {
    asOf: today.toISOString().slice(0, 10),
    symbol,
    candidates: all,
    topPicks,
    narrative,
  }
}

function icon(c: ReversalCandidate): string {
  if (c.kind === 'HIGH') return c.bias === 'TOP' ? '🔴' : c.bias === 'BOTTOM' ? '🟢' : '🟠'
  if (c.kind === 'MED') return c.bias === 'TOP' ? '🟥' : c.bias === 'BOTTOM' ? '🟩' : '🟨'
  return '⚪'
}
