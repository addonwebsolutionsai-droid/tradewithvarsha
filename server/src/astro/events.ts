import { SearchMoonPhase, type AstroTime, MakeTime } from 'astronomy-engine'
import { computePlanetaryPositions } from './ephemeris'

/**
 * Future astronomical events that historically coincide with market reversals:
 *
 *   - Planetary stations (retrograde ↔ direct)
 *   - New Moon / Full Moon
 *   - Sign ingresses (planet entering new zodiac sign)
 *   - Hard aspects (Saturn, Mars — challenging aspects)
 */

export interface AstroEvent {
  date: string        // ISO date
  daysAway: number
  kind: 'STATION' | 'LUNAR' | 'INGRESS' | 'ASPECT'
  title: string
  detail: string
  importance: 'HIGH' | 'MED' | 'LOW'
}

/**
 * Planetary stations: find dates in the next N days where a planet's
 * longitude reverses direction (daily longitude derivative changes sign).
 */
export function findStations(today: Date, windowDays: number): AstroEvent[] {
  const events: AstroEvent[] = []
  // Only outer planets + Mercury matter for stations (Moon/Sun don't retrograde)
  const planets = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto']
  // Sample daily longitudes
  const samples: Record<string, number[]> = {}
  for (const p of planets) samples[p] = []
  for (let d = 0; d <= windowDays; d++) {
    const date = new Date(today.getTime() + d * 86_400_000)
    const positions = computePlanetaryPositions(date)
    for (const p of planets) {
      const pos = positions.find(x => x.name === p)
      samples[p].push(pos ? pos.tropical : 0)
    }
  }
  // Detect sign change in day-to-day delta (ignoring 360° wrap)
  for (const p of planets) {
    const s = samples[p]
    for (let i = 2; i < s.length - 1; i++) {
      const d1 = wrapDelta(s[i] - s[i - 1])
      const d2 = wrapDelta(s[i + 1] - s[i])
      if (d1 * d2 < 0 && Math.abs(d1) > 0.01 && Math.abs(d2) > 0.01) {
        const date = new Date(today.getTime() + i * 86_400_000)
        const kind = d1 > 0 ? 'retrograde' : 'direct' // slowing then reversing → just entered retro
        events.push({
          date: date.toISOString().slice(0, 10),
          daysAway: i,
          kind: 'STATION',
          title: `${p} station ${kind}`,
          detail: `${p} reverses motion — historically a turning-point catalyst`,
          importance: ['Saturn', 'Jupiter', 'Mars', 'Mercury'].includes(p) ? 'HIGH' : 'MED',
        })
      }
    }
  }
  return events
}

function wrapDelta(d: number): number {
  if (d > 180) return d - 360
  if (d < -180) return d + 360
  return d
}

/** New / Full moon dates within the next N days. */
export function findLunarPhases(today: Date, windowDays: number): AstroEvent[] {
  const events: AstroEvent[] = []
  try {
    for (const targetPhase of [0, 180] as const) {
      // Walk forward in ~29-day chunks to find each occurrence
      let cursor: Date = today
      for (let n = 0; n < 4; n++) {
        const hit = SearchMoonPhase(targetPhase, MakeTime(cursor), windowDays + 1) as AstroTime | null
        if (!hit) break
        const d = hit.date
        const daysAway = Math.round((d.getTime() - today.getTime()) / 86_400_000)
        if (daysAway > windowDays) break
        events.push({
          date: d.toISOString().slice(0, 10),
          daysAway,
          kind: 'LUNAR',
          title: targetPhase === 0 ? 'New Moon' : 'Full Moon',
          detail: targetPhase === 0
            ? 'New Moon — contracts, market often shifts bias'
            : 'Full Moon — climactic, highs/lows often print ±1 day',
          importance: 'MED',
        })
        cursor = new Date(d.getTime() + 86_400_000)
      }
    }
  } catch { /* ignore */ }
  return events.sort((a, b) => a.daysAway - b.daysAway)
}

/** Sign ingress: when a planet moves from one 30° zodiac sign to the next. */
export function findIngresses(today: Date, windowDays: number): AstroEvent[] {
  const events: AstroEvent[] = []
  const planets = ['Sun', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']
  // Snapshot at day 0 and day N — if sign changed, binary-search the crossing day
  for (const p of planets) {
    const p0 = computePlanetaryPositions(today).find(x => x.name === p)
    if (!p0) continue
    const sign0 = p0.sign
    // Fast check: sample every ~3 days
    let lastDay = 0
    let lastSign = sign0
    for (let d = 3; d <= windowDays; d += 3) {
      const date = new Date(today.getTime() + d * 86_400_000)
      const pos = computePlanetaryPositions(date).find(x => x.name === p)
      if (!pos) continue
      if (pos.sign !== lastSign) {
        // Binary search for exact crossing day
        let lo = lastDay, hi = d
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2)
          const midDate = new Date(today.getTime() + mid * 86_400_000)
          const midPos = computePlanetaryPositions(midDate).find(x => x.name === p)
          if (midPos && midPos.sign === lastSign) lo = mid
          else hi = mid
        }
        const crossDate = new Date(today.getTime() + hi * 86_400_000)
        events.push({
          date: crossDate.toISOString().slice(0, 10),
          daysAway: hi,
          kind: 'INGRESS',
          title: `${p} enters ${pos.sign}`,
          detail: `${p} ingresses ${lastSign} → ${pos.sign}`,
          importance: ['Jupiter', 'Saturn'].includes(p) ? 'HIGH' : 'MED',
        })
        lastSign = pos.sign
      }
      lastDay = d
    }
  }
  return events.sort((a, b) => a.daysAway - b.daysAway)
}

/** All astronomical events in a window, combined + sorted by date. */
export function gatherAstroEvents(today: Date, windowDays = 60): AstroEvent[] {
  const stations = findStations(today, windowDays)
  const lunars = findLunarPhases(today, windowDays)
  const ingresses = findIngresses(today, windowDays)
  const all = [...stations, ...lunars, ...ingresses]
  // Dedupe close duplicates (same date + same kind)
  const seen = new Set<string>()
  const out: AstroEvent[] = []
  for (const e of all.sort((a, b) => a.daysAway - b.daysAway)) {
    const k = `${e.date}-${e.kind}-${e.title}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}
