import {
  Body,
  SunPosition,
  GeoMoon,
  GeoVector,
  Ecliptic,
  type EclipticCoordinates,
  type Vector,
} from 'astronomy-engine'
import type { PlanetPosition } from '../types'

/**
 * Planetary positions via pure-JS astronomy-engine.
 *
 * We compute TROPICAL (Western zodiac) apparent GEOCENTRIC longitudes, then
 * subtract the Lahiri ayanamsa to convert to SIDEREAL (Vedic).
 *
 * Lahiri ayanamsa: ~23.85° at J2000, drifting +50.3" / year.
 */

const VEDIC_SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer',
  'Leo', 'Virgo', 'Libra', 'Scorpio',
  'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
]

function lahiriAyanamsa(date: Date): number {
  const j2000 = new Date('2000-01-01T12:00:00Z').getTime()
  const yearsSince = (date.getTime() - j2000) / (365.25 * 86_400_000)
  return 23.85 + yearsSince * (50.3 / 3600)
}

function normalize360(x: number): number {
  let n = x % 360
  if (n < 0) n += 360
  return n
}

function signAndDegree(longitude: number): { sign: string; degree: number } {
  const n = normalize360(longitude)
  const signIdx = Math.floor(n / 30)
  return { sign: VEDIC_SIGNS[signIdx], degree: n - signIdx * 30 }
}

export interface PlanetLongitude {
  name: string
  tropical: number
  sidereal: number
  sign: string
  degree: number
  retrograde: boolean
}

/** Geocentric apparent ecliptic longitude (tropical) for any body. */
function geocentricEclipticLon(body: Body, date: Date): number {
  if (body === Body.Sun) {
    const s: EclipticCoordinates = SunPosition(date)
    return s.elon
  }
  if (body === Body.Moon) {
    const v: Vector = GeoMoon(date)
    return Ecliptic(v).elon
  }
  const v: Vector = GeoVector(body, date, true)
  return Ecliptic(v).elon
}

const PLANETS: { name: string; body: Body }[] = [
  { name: 'Sun', body: Body.Sun },
  { name: 'Moon', body: Body.Moon },
  { name: 'Mercury', body: Body.Mercury },
  { name: 'Venus', body: Body.Venus },
  { name: 'Mars', body: Body.Mars },
  { name: 'Jupiter', body: Body.Jupiter },
  { name: 'Saturn', body: Body.Saturn },
  { name: 'Uranus', body: Body.Uranus },
  { name: 'Neptune', body: Body.Neptune },
  { name: 'Pluto', body: Body.Pluto },
]

export function computePlanetaryPositions(date: Date = new Date()): PlanetLongitude[] {
  const ay = lahiriAyanamsa(date)
  const out: PlanetLongitude[] = []
  for (const p of PLANETS) {
    let trop: number
    try {
      trop = normalize360(geocentricEclipticLon(p.body, date))
    } catch {
      continue // skip any body the engine can't compute (shouldn't happen for these)
    }
    const sid = normalize360(trop - ay)
    const sd = signAndDegree(sid)
    // Retrograde: compare longitude now vs 1 day later
    let retrograde = false
    if (p.body !== Body.Sun && p.body !== Body.Moon) {
      try {
        const future = new Date(date.getTime() + 86_400_000)
        const tropFuture = normalize360(geocentricEclipticLon(p.body, future))
        let delta = tropFuture - trop
        if (delta > 180) delta -= 360
        if (delta < -180) delta += 360
        retrograde = delta < 0
      } catch { /* skip */ }
    }
    out.push({ name: p.name, tropical: trop, sidereal: sid, sign: sd.sign, degree: sd.degree, retrograde })
  }
  // Rahu (mean lunar north node): linear approximation
  const daysSinceJ2000 = (date.getTime() - new Date('2000-01-01T12:00:00Z').getTime()) / 86_400_000
  const rahuTrop = normalize360(125.1228 - 0.0529539 * daysSinceJ2000)
  const rahuSid = normalize360(rahuTrop - ay)
  const rsd = signAndDegree(rahuSid)
  out.push({ name: 'Rahu', tropical: rahuTrop, sidereal: rahuSid, sign: rsd.sign, degree: rsd.degree, retrograde: true })
  const ketuSid = normalize360(rahuSid + 180)
  const ksd = signAndDegree(ketuSid)
  out.push({ name: 'Ketu', tropical: normalize360(rahuTrop + 180), sidereal: ketuSid, sign: ksd.sign, degree: ksd.degree, retrograde: true })
  return out
}

export function planetSign(name: string, date: Date = new Date()): { sign: string; degree: number; retrograde: boolean } | null {
  const all = computePlanetaryPositions(date)
  const p = all.find(x => x.name.toLowerCase() === name.toLowerCase())
  return p ? { sign: p.sign, degree: p.degree, retrograde: p.retrograde } : null
}

export function toPlanetPositions(all: PlanetLongitude[]): PlanetPosition[] {
  return all.map(p => ({
    planet: p.name,
    sign: p.sign,
    degree: p.degree,
    retrograde: p.retrograde,
    influence: baseInfluence(p),
  }))
}

function baseInfluence(p: PlanetLongitude): PlanetPosition['influence'] {
  if (p.name === 'Jupiter') return p.retrograde ? 'Cautious' : 'Bullish'
  if (p.name === 'Saturn') return p.retrograde ? 'Volatile' : 'Cautious'
  if (p.name === 'Mars') return 'Mixed'
  if (p.name === 'Rahu' || p.name === 'Ketu') return 'Volatile'
  if (p.name === 'Venus') return 'Bullish'
  if (p.name === 'Mercury') return p.retrograde ? 'Volatile' : 'Neutral'
  if (p.name === 'Moon') return 'Neutral'
  return 'Neutral'
}
