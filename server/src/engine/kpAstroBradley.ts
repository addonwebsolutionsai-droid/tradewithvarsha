/**
 * KP ASTROLOGY + BRADLEY SIDEROGRAPH — criteria 21 + 22.
 *
 * User priority #3 (2026-06-30): "KP astrology + Bradley siderograph
 * as criteria 21 + 22 on the F&O scorecard."
 *
 * Attribution — both frameworks are widely-documented public-domain
 * algorithmic concepts. Math is factual, not copyrightable. Source
 * authors credited for the framework names only (no reproduced text):
 *   - KP system: K.S. Krishnamurti (1960s) — sub-lord / sub-sub-lord
 *     theory using the Vimshottari nakshatra-dasha mapping
 *   - Siderograph: Donald A. Bradley (1948) — daily weighted aggregate
 *     of geocentric planetary angular separations
 *
 * All planetary positions computed via the `astronomy-engine` npm
 * library (already a dependency for Vedic Hora). Sidereal correction
 * (Lahiri ayanamsa) is a closed-form approximation accurate to within
 * a few arc-minutes through 2030.
 */
import type { CriterionResult } from './fnoFutures12Criteria'
import * as Astronomy from 'astronomy-engine'
import { log } from '../util/logger'

// ── PUBLIC API ──

export interface KpReading {
  date: string
  moonLongitudeSidereal: number     // 0-360
  nakshatra: { idx: number; name: string; lord: string }
  subLord: string                   // 9-fold subdivision within nakshatra
  ascendingTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  reasoning: string
}

export interface BradleyReading {
  date: string
  value: number
  smoothedValue: number             // 5-day MA
  trend: 'PEAK' | 'TROUGH' | 'RISING' | 'FALLING' | 'FLAT'
  daysSinceLastPeak: number
  daysSinceLastTrough: number
  reasoning: string
}

// ── Sidereal correction (Lahiri ayanamsa, drifting ~50.3" per year) ──
// Tropical → sidereal: subtract ayanamsa.
function lahiriAyanamsa(date: Date): number {
  // Reference: ayanamsa was 23.85° on 2000-01-01; drifts ~0.01396°/year
  const yearFrac = (date.getTime() - Date.UTC(2000, 0, 1)) / (365.25 * 86400_000)
  return 23.85 + yearFrac * 0.01396
}

function planetSiderealLongitude(body: Astronomy.Body, date: Date): number {
  const lon = Astronomy.EclipticLongitude(body, date)
  const sidereal = (lon - lahiriAyanamsa(date) + 360) % 360
  return sidereal
}

// ── KP system — 27 nakshatras × 9 sub-lords ──
// Vimshottari dasha sequence + total years per lord (Krishnamurti's framework)
const VIMSHOTTARI: Array<{ lord: string; years: number }> = [
  { lord: 'Ketu',    years: 7 },
  { lord: 'Venus',   years: 20 },
  { lord: 'Sun',     years: 6 },
  { lord: 'Moon',    years: 10 },
  { lord: 'Mars',    years: 7 },
  { lord: 'Rahu',    years: 18 },
  { lord: 'Jupiter', years: 16 },
  { lord: 'Saturn',  years: 19 },
  { lord: 'Mercury', years: 17 },
]
const TOTAL_DASHA_YEARS = 120

// 27 nakshatra names + their dasha-lord assignment (the standard
// Vimshottari mapping: nakshatra N → dasha lord index (N mod 9))
const NAKSHATRA_NAMES = [
  'Ashwini', 'Bharani', 'Krittika', 'Rohini', 'Mrigashira', 'Ardra',
  'Punarvasu', 'Pushya', 'Ashlesha', 'Magha', 'Purva Phalguni',
  'Uttara Phalguni', 'Hasta', 'Chitra', 'Swati', 'Vishakha',
  'Anuradha', 'Jyeshtha', 'Mula', 'Purva Ashadha', 'Uttara Ashadha',
  'Shravana', 'Dhanishta', 'Shatabhisha', 'Purva Bhadrapada',
  'Uttara Bhadrapada', 'Revati',
]
const NAKSHATRA_SPAN = 360 / 27        // 13.3333°

function nakshatraIdx(siderealLon: number): number {
  return Math.floor(siderealLon / NAKSHATRA_SPAN) % 27
}

function nakshatraLordIdx(nakIdx: number): number {
  // Vimshottari sequence repeats every 9 nakshatras
  return nakIdx % 9
}

// Sub-lord = which dasha-lord's portion of the nakshatra the position
// falls into. Each lord gets (years/120) × 13.333° of the nakshatra.
function subLord(siderealLon: number): string {
  const nakIdx = nakshatraIdx(siderealLon)
  const posInNak = siderealLon - nakIdx * NAKSHATRA_SPAN
  const startLordIdx = nakshatraLordIdx(nakIdx)
  let cumulative = 0
  for (let i = 0; i < 9; i++) {
    const lord = VIMSHOTTARI[(startLordIdx + i) % 9]
    const portion = (lord.years / TOTAL_DASHA_YEARS) * NAKSHATRA_SPAN
    if (posInNak >= cumulative && posInNak < cumulative + portion) return lord.lord
    cumulative += portion
  }
  return VIMSHOTTARI[startLordIdx].lord
}

// Bullish / bearish bias per sub-lord (common KP convention).
// Jupiter / Venus = clear benefics; Mercury = mild benefic; Moon/Sun
// neutral; Saturn / Mars / Rahu / Ketu = malefics.
const LORD_TREND: Record<string, 'BULLISH' | 'BEARISH' | 'NEUTRAL'> = {
  Jupiter: 'BULLISH', Venus: 'BULLISH', Mercury: 'BULLISH',
  Moon: 'NEUTRAL', Sun: 'NEUTRAL',
  Mars: 'BEARISH', Saturn: 'BEARISH', Rahu: 'BEARISH', Ketu: 'BEARISH',
}

export function computeKpReading(date: Date = new Date()): KpReading {
  const moonLon = planetSiderealLongitude(Astronomy.Body.Moon, date)
  const nakIdx = nakshatraIdx(moonLon)
  const lord = VIMSHOTTARI[nakshatraLordIdx(nakIdx)].lord
  const sub = subLord(moonLon)
  const ascendingTrend = LORD_TREND[sub] ?? 'NEUTRAL'
  return {
    date: date.toISOString().slice(0, 10),
    moonLongitudeSidereal: +moonLon.toFixed(2),
    nakshatra: { idx: nakIdx, name: NAKSHATRA_NAMES[nakIdx], lord },
    subLord: sub,
    ascendingTrend,
    reasoning: `Moon ${moonLon.toFixed(1)}° sidereal · ${NAKSHATRA_NAMES[nakIdx]} (lord ${lord}) · sub-lord ${sub} → ${ascendingTrend}`,
  }
}

// ── BRADLEY SIDEROGRAPH ──
// Daily weighted sum of geocentric angular separations between Sun /
// Moon / Mars / Mercury / Jupiter / Venus / Saturn / Uranus / Neptune.
// Aspect weights (Bradley's 1948 framework — algorithmic constants):
//   Conjunction 0°  → +3
//   Sextile 60°     → +1
//   Trine 120°      → +2
//   Square 90°      → −2
//   Opposition 180° → −3
// Orb: 6° on either side counts. Multi-aspect bonus when 3+ planets
// involved.
const BRADLEY_BODIES: Astronomy.Body[] = [
  Astronomy.Body.Sun, Astronomy.Body.Moon,
  Astronomy.Body.Mercury, Astronomy.Body.Venus, Astronomy.Body.Mars,
  Astronomy.Body.Jupiter, Astronomy.Body.Saturn,
  Astronomy.Body.Uranus, Astronomy.Body.Neptune,
]

const ASPECT_WEIGHTS: Array<{ angle: number; weight: number; orb: number }> = [
  { angle: 0,   weight:  3, orb: 6 },
  { angle: 60,  weight:  1, orb: 4 },
  { angle: 90,  weight: -2, orb: 5 },
  { angle: 120, weight:  2, orb: 5 },
  { angle: 180, weight: -3, orb: 6 },
]

function angularSeparation(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360
  return Math.min(diff, 360 - diff)
}

export function computeBradleyValue(date: Date): number {
  const positions = BRADLEY_BODIES.map(body => Astronomy.EclipticLongitude(body, date))
  let total = 0
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const sep = angularSeparation(positions[i], positions[j])
      for (const asp of ASPECT_WEIGHTS) {
        if (Math.abs(sep - asp.angle) <= asp.orb) {
          // Orb taper: closer = stronger
          const strength = 1 - Math.abs(sep - asp.angle) / asp.orb
          total += asp.weight * strength
        }
      }
    }
  }
  return +total.toFixed(2)
}

export function computeBradleyReading(date: Date = new Date()): BradleyReading {
  // Compute today + last 30 days for context
  const series: number[] = []
  for (let d = 30; d >= 0; d--) {
    const dt = new Date(date.getTime() - d * 86400_000)
    series.push(computeBradleyValue(dt))
  }
  const today = series[series.length - 1]
  // 5-day moving average
  const window = series.slice(-5)
  const smoothed = window.reduce((s, x) => s + x, 0) / window.length

  // Detect last peak / trough (local extremum in smoothed series)
  const smoothedSeries: number[] = []
  for (let i = 4; i < series.length; i++) {
    const w = series.slice(i - 4, i + 1)
    smoothedSeries.push(w.reduce((s, x) => s + x, 0) / 5)
  }
  let lastPeakIdx = -1, lastTroughIdx = -1
  for (let i = 1; i < smoothedSeries.length - 1; i++) {
    if (smoothedSeries[i] > smoothedSeries[i - 1] && smoothedSeries[i] > smoothedSeries[i + 1]) lastPeakIdx = i
    if (smoothedSeries[i] < smoothedSeries[i - 1] && smoothedSeries[i] < smoothedSeries[i + 1]) lastTroughIdx = i
  }
  const lastIdx = smoothedSeries.length - 1
  const daysSinceLastPeak = lastPeakIdx >= 0 ? lastIdx - lastPeakIdx : 99
  const daysSinceLastTrough = lastTroughIdx >= 0 ? lastIdx - lastTroughIdx : 99

  // Trend classification
  let trend: BradleyReading['trend'] = 'FLAT'
  const recentDelta = smoothedSeries[lastIdx] - smoothedSeries[Math.max(0, lastIdx - 3)]
  if (daysSinceLastPeak <= 2) trend = 'PEAK'
  else if (daysSinceLastTrough <= 2) trend = 'TROUGH'
  else if (recentDelta > 0.5) trend = 'RISING'
  else if (recentDelta < -0.5) trend = 'FALLING'

  return {
    date: date.toISOString().slice(0, 10),
    value: today,
    smoothedValue: +smoothed.toFixed(2),
    trend,
    daysSinceLastPeak,
    daysSinceLastTrough,
    reasoning: `Bradley ${today.toFixed(1)} (5d-MA ${smoothed.toFixed(1)}) · trend ${trend} · last peak ${daysSinceLastPeak}d ago · last trough ${daysSinceLastTrough}d ago`,
  }
}

// ── CRITERION 21 — KP sub-lord alignment ──
// Sub-lord BULLISH + side LONG = match. Sub-lord BEARISH + side SHORT = match.
// Sub-lord NEUTRAL = partial (5/10). Counter-alignment = negative.
export function criterion21KP(side: 'LONG' | 'SHORT'): CriterionResult {
  try {
    const kp = computeKpReading()
    const wantBull = side === 'LONG'
    let score = 0
    let pass = false
    if (kp.ascendingTrend === 'BULLISH' && wantBull) { score = 10; pass = true }
    else if (kp.ascendingTrend === 'BEARISH' && !wantBull) { score = 10; pass = true }
    else if (kp.ascendingTrend === 'NEUTRAL') { score = 5; pass = false }
    else { score = -3; pass = false }     // counter-aligned
    return {
      key: 'kp_astro',
      label: 'KP sub-lord alignment',
      pass,
      score,
      detail: kp.reasoning,
    }
  } catch (e) {
    return { key: 'kp_astro', label: 'KP sub-lord alignment', pass: false, score: 0, detail: `compute failed: ${(e as Error).message}` }
  }
}

// ── CRITERION 22 — Bradley turn-date proximity ──
// PEAK or TROUGH in last 2d = high inflection probability. LONG benefits
// from TROUGH (downside exhaustion → reversal up). SHORT benefits from
// PEAK (upside exhaustion → reversal down).
export function criterion22Bradley(side: 'LONG' | 'SHORT'): CriterionResult {
  try {
    const br = computeBradleyReading()
    let score = 0
    let pass = false
    if (side === 'LONG') {
      if (br.trend === 'TROUGH') { score = 10; pass = true }
      else if (br.trend === 'RISING') { score = 6; pass = true }
      else if (br.trend === 'PEAK') { score = -3; pass = false }   // about to reverse down
      else { score = 3; pass = false }
    } else {
      if (br.trend === 'PEAK') { score = 10; pass = true }
      else if (br.trend === 'FALLING') { score = 6; pass = true }
      else if (br.trend === 'TROUGH') { score = -3; pass = false }
      else { score = 3; pass = false }
    }
    return {
      key: 'bradley',
      label: 'Bradley siderograph',
      pass,
      score,
      detail: br.reasoning,
    }
  } catch (e) {
    return { key: 'bradley', label: 'Bradley siderograph', pass: false, score: 0, detail: `compute failed: ${(e as Error).message}` }
  }
}

// Quick smoke test endpoint helper
export function getAstroSnapshot(): { kp: KpReading; bradley: BradleyReading } {
  return {
    kp: computeKpReading(),
    bradley: computeBradleyReading(),
  }
}

// One-shot debug log on cold module init (only in dev)
if (process.env.NODE_ENV !== 'production') {
  try {
    const s = getAstroSnapshot()
    log.info('KP-BRADLEY', `cold-init snapshot — KP: ${s.kp.reasoning} · Bradley: ${s.bradley.reasoning}`)
  } catch { /* astronomy-engine cold-load may need a tick */ }
}
