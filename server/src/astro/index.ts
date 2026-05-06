import type { AstroBias } from '../types'
import { computePlanetaryPositions, toPlanetPositions } from './ephemeris'
import { detectAspects, interpretAspects } from './aspects'

export { computePlanetaryPositions, planetSign, toPlanetPositions } from './ephemeris'
export { detectAspects, interpretAspects } from './aspects'

/**
 * Produce a consolidated AstroBias for the signal engine.
 * Combines aspect scoring with Mercury-retrograde and Saturn-sign flags.
 */
export function astroBiasFor(date: Date = new Date()): AstroBias {
  const planets = computePlanetaryPositions(date)
  const aspects = detectAspects(planets)
  const { score, notes } = interpretAspects(aspects)

  const merc = planets.find(p => p.name === 'Mercury')
  const mars = planets.find(p => p.name === 'Mars')
  const jup = planets.find(p => p.name === 'Jupiter')

  let adjusted = score
  if (merc?.retrograde) { adjusted -= 0.3; notes.push('Mercury retrograde — communication/tech caution') }
  if (jup?.retrograde) { adjusted -= 0.2 }
  // Mars in water signs tends to fuel volatility in emotionally-driven rallies
  if (mars && ['Cancer', 'Scorpio', 'Pisces'].includes(mars.sign)) {
    notes.push(`Mars in ${mars.sign} — emotional / news-driven volatility`)
  }

  const strength = Math.max(-2, Math.min(2, adjusted)) / 2 // -1 to 1
  const bullish = strength > 0.2
  const bearish = strength < -0.2
  const volatile = Math.abs(strength) < 0.2 && aspects.some(a => a.nature === 'challenging' && a.orb < 3)

  return {
    bullish,
    bearish,
    volatile,
    strength,
    note: notes.slice(0, 3).join(' · ') || 'Neutral planetary conditions',
    aspects: aspects.slice(0, 5).map(a => `${a.p1} ${a.aspect} ${a.p2} (orb ${a.orb.toFixed(1)}°)`),
    planets: toPlanetPositions(planets),
  }
}
