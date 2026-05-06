import type { PlanetLongitude } from './ephemeris'

/**
 * Vedic/Western aspect detection.
 *
 * We use tropical longitudes for aspects (Western astrology convention)
 * because aspects are angular relationships — unaffected by ayanamsa choice.
 *
 * Major aspects (with orbs in degrees):
 *   Conjunction  0°   (orb 8°)
 *   Opposition   180° (orb 8°)
 *   Trine        120° (orb 6°)
 *   Square       90°  (orb 6°)  — challenging
 *   Sextile      60°  (orb 4°)
 */

export type AspectName = 'Conjunction' | 'Opposition' | 'Trine' | 'Square' | 'Sextile'

const ASPECTS: { name: AspectName; angle: number; orb: number; nature: 'harmonious' | 'challenging' | 'neutral' }[] = [
  { name: 'Conjunction', angle: 0,   orb: 8, nature: 'neutral' },
  { name: 'Opposition',  angle: 180, orb: 8, nature: 'challenging' },
  { name: 'Trine',       angle: 120, orb: 6, nature: 'harmonious' },
  { name: 'Square',      angle: 90,  orb: 6, nature: 'challenging' },
  { name: 'Sextile',     angle: 60,  orb: 4, nature: 'harmonious' },
]

export interface AspectHit {
  p1: string
  p2: string
  aspect: AspectName
  nature: 'harmonious' | 'challenging' | 'neutral'
  exact: number       // actual angular separation
  orb: number         // how far from exact (degrees)
}

export function detectAspects(planets: PlanetLongitude[]): AspectHit[] {
  const out: AspectHit[] = []
  for (let i = 0; i < planets.length; i++) {
    for (let j = i + 1; j < planets.length; j++) {
      const a = planets[i], b = planets[j]
      let diff = Math.abs(a.tropical - b.tropical)
      if (diff > 180) diff = 360 - diff
      for (const asp of ASPECTS) {
        const orb = Math.abs(diff - asp.angle)
        if (orb <= asp.orb) {
          out.push({
            p1: a.name,
            p2: b.name,
            aspect: asp.name,
            nature: asp.nature,
            exact: diff,
            orb,
          })
        }
      }
    }
  }
  return out.sort((a, b) => a.orb - b.orb)
}

/** Financial astrology interpretation. Returns a score: positive = bullish. */
export function interpretAspects(aspects: AspectHit[]): { score: number; notes: string[] } {
  const notes: string[] = []
  let score = 0

  for (const a of aspects) {
    const pair = [a.p1, a.p2].sort().join('-')
    const close = a.orb < 2 ? 1.0 : a.orb < 4 ? 0.6 : 0.3

    // Jupiter involvement = bullish (expansion, abundance)
    if (pair.includes('Jupiter')) {
      if (a.nature === 'harmonious') { score += 1.0 * close; notes.push(`${pair} ${a.aspect} (+Jupiter benefic)`) }
      else if (a.nature === 'challenging') { score -= 0.3 * close }
    }
    // Saturn = restriction, fear
    if (pair.includes('Saturn')) {
      if (a.nature === 'challenging') { score -= 0.8 * close; notes.push(`${pair} ${a.aspect} (−Saturn restriction)`) }
      else if (a.nature === 'harmonious') { score += 0.2 * close }
    }
    // Mars = volatility, sharp moves
    if (pair.includes('Mars')) {
      if (a.nature === 'challenging') { score -= 0.5 * close; notes.push(`${pair} ${a.aspect} (Mars volatility)`) }
    }
    // Venus-Jupiter = major bullish for gold, metals, luxury
    if (pair === 'Jupiter-Venus') {
      score += 1.2 * close
      notes.push('Venus-Jupiter conjunction/aspect — classically bullish for metals')
    }
    // Sun-Saturn = market pessimism
    if (pair === 'Saturn-Sun' && a.nature === 'challenging') {
      score -= 0.6 * close
      notes.push('Sun-Saturn hard aspect — cautious sentiment')
    }
    // Rahu involvement = extremes, speculation
    if (pair.includes('Rahu')) {
      notes.push(`${pair} ${a.aspect} — speculative / extreme moves likely`)
    }
    // Mercury retro already handled in ephemeris influence
  }

  return { score, notes: notes.slice(0, 6) }
}
