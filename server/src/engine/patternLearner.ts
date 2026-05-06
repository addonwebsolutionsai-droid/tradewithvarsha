import fs from 'fs/promises'
import path from 'path'
import * as data from '../data'
import { resolveUniverse } from '../screeners/universe'
import { ema, lastATR, lastRSI } from '../indicators'
import { log } from '../util/logger'

/**
 * Daily pattern learner.
 *
 * Goal: find what a "real" pre-move setup looked like by reverse-engineering
 * stocks that just moved 10–25 % in the last 5 sessions, then capturing the
 * snapshot of that stock 5/10/15 trading days BEFORE the move began.
 *
 * Each captured snapshot becomes a "learned signature": volume ratio, RSI,
 * % from 52W high, EMA stack state, 20d return. Over time the JSON file
 * builds a corpus of empirical pre-move fingerprints that the Pro Screener
 * can use to score future candidates against.
 *
 * Output: server/data/learned-patterns.json
 *
 *   {
 *     lastRunAt: ISO timestamp,
 *     totalSignatures: number,
 *     centroids: {                       // mean of each feature across all wins
 *       volRatio20: number,
 *       rsi: number,
 *       distFrom52wHighPct: number,
 *       above50EMA: 0..1 (fraction),
 *       above200EMA: 0..1,
 *       ret20dPct: number,
 *     },
 *     signatures: [                       // last 500 signatures kept on disk
 *       { symbol, gainPct, lookbackDays, capturedAt, features: { ... } },
 *       ...
 *     ],
 *   }
 *
 * Scheduled by the cron in index.ts: daily at 16:30 IST after the post-close
 * scanner sweep, so live data is freshest.
 */

const DATA_DIR = path.resolve(__dirname, '../../data')
const PATTERNS_FILE = path.join(DATA_DIR, 'learned-patterns.json')

const MIN_GAIN_PCT = 10                      // only mine clear winners
const LOOKBACKS_DAYS = [5, 10, 15]            // capture pre-move snapshot at these offsets
const MAX_SIGNATURES_KEPT = 500              // rolling window
const SCAN_LIMIT = 600                       // symbols per daily run

export interface PreMoveFeatures {
  volRatio20: number
  volRatio60: number
  rsi: number
  distFrom52wHighPct: number      // negative (e.g. -8 = 8% below high)
  above50EMA: boolean
  above200EMA: boolean
  emaStackBull: boolean
  ret5dPct: number
  ret20dPct: number
  range5dPct: number
}

export interface LearnedSignature {
  symbol: string
  gainPct: number
  lookbackDays: number
  capturedAt: string              // ISO date the snapshot represents
  detectedAt: string              // ISO date the learner ran
  features: PreMoveFeatures
}

export interface LearnedCentroid {
  volRatio20: number
  rsi: number
  distFrom52wHighPct: number
  above50EMA: number
  above200EMA: number
  ret20dPct: number
}

export interface LearnedPatterns {
  lastRunAt: string
  totalSignatures: number
  centroids: LearnedCentroid
  signatures: LearnedSignature[]
}

async function loadPatterns(): Promise<LearnedPatterns> {
  try {
    const raw = await fs.readFile(PATTERNS_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {
      lastRunAt: '',
      totalSignatures: 0,
      centroids: { volRatio20: 0, rsi: 0, distFrom52wHighPct: 0, above50EMA: 0, above200EMA: 0, ret20dPct: 0 },
      signatures: [],
    }
  }
}

async function savePatterns(p: LearnedPatterns): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(PATTERNS_FILE, JSON.stringify(p, null, 2), 'utf8')
}

/** Compute centroid (per-feature mean) over the rolling signature window. */
function computeCentroid(signatures: LearnedSignature[]): LearnedCentroid {
  if (!signatures.length) {
    return { volRatio20: 0, rsi: 0, distFrom52wHighPct: 0, above50EMA: 0, above200EMA: 0, ret20dPct: 0 }
  }
  const n = signatures.length
  return {
    volRatio20: +(signatures.reduce((s, x) => s + x.features.volRatio20, 0) / n).toFixed(2),
    rsi: +(signatures.reduce((s, x) => s + x.features.rsi, 0) / n).toFixed(1),
    distFrom52wHighPct: +(signatures.reduce((s, x) => s + x.features.distFrom52wHighPct, 0) / n).toFixed(1),
    above50EMA: +(signatures.filter(x => x.features.above50EMA).length / n).toFixed(2),
    above200EMA: +(signatures.filter(x => x.features.above200EMA).length / n).toFixed(2),
    ret20dPct: +(signatures.reduce((s, x) => s + x.features.ret20dPct, 0) / n).toFixed(1),
  }
}

const max = (a: number[]) => (a.length ? Math.max(...a) : 0)
const min = (a: number[]) => (a.length ? Math.min(...a) : 0)
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0)
const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100)

/** Extract the snapshot of `symbol` as it stood `lookbackDays` ago. */
function snapshotAt(candles: import('../types').Candle[], cutoffIdx: number): PreMoveFeatures | null {
  if (cutoffIdx < 60) return null
  const window = candles.slice(0, cutoffIdx + 1)
  const today = window[window.length - 1]
  const yest = window[window.length - 2] ?? today

  const e50 = ema(window, 50)
  const e200 = ema(window, 200)
  const e20 = ema(window, 20)
  const e9 = ema(window, 9)
  const lastE50 = e50[e50.length - 1]
  const lastE200 = e200[e200.length - 1]
  const lastE20 = e20[e20.length - 1]
  const lastE9 = e9[e9.length - 1]

  const vols20 = window.slice(-21, -1).map(c => c.volume)
  const vols60 = window.slice(-61, -1).map(c => c.volume)
  const volAvg20 = avg(vols20)
  const volAvg60 = avg(vols60)

  const last252 = window.slice(-252)
  const high52w = max(last252.map(c => c.high))

  const last5 = window.slice(-5)
  const range5dHigh = max(last5.map(c => c.high))
  const range5dLow = min(last5.map(c => c.low))
  const range5dMid = (range5dHigh + range5dLow) / 2

  const ret5dRef = window[window.length - 6]?.close ?? today.close
  const ret20dRef = window[window.length - 21]?.close ?? today.close

  return {
    volRatio20: volAvg20 > 0 ? +(today.volume / volAvg20).toFixed(2) : 0,
    volRatio60: volAvg60 > 0 ? +(today.volume / volAvg60).toFixed(2) : 0,
    rsi: +(lastRSI(window, 14) ?? 50).toFixed(1),
    distFrom52wHighPct: +pct(today.close, high52w).toFixed(1),
    above50EMA: !!(lastE50 && today.close > lastE50),
    above200EMA: !!(lastE200 && today.close > lastE200),
    emaStackBull: !!(lastE20 && lastE50 && lastE200 && lastE20 > lastE50 && lastE50 > lastE200 && lastE9 > lastE20),
    ret5dPct: +pct(today.close, ret5dRef).toFixed(1),
    ret20dPct: +pct(today.close, ret20dRef).toFixed(1),
    range5dPct: range5dMid > 0 ? +(((range5dHigh - range5dLow) / range5dMid) * 100).toFixed(1) : 100,
  }
}

/** Run the full learner cycle. Designed for daily cron. */
export async function runPatternLearner(): Promise<LearnedPatterns> {
  log.info('LEARN', 'Pattern learner starting...')
  const patterns = await loadPatterns()
  const universe = (await resolveUniverse('NSE_ALL')).slice(0, SCAN_LIMIT)
  const newSigs: LearnedSignature[] = []

  // Throttle: 3 concurrent fetches
  let cursor = 0
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      try {
        const candles = await data.getCandles(sym, '1D', 300)
        if (candles.length < 80) continue

        const today = candles[candles.length - 1]
        const ref5 = candles[candles.length - 6] ?? today
        const gain5d = pct(today.close, ref5.close)
        if (gain5d < MIN_GAIN_PCT) continue

        // Real winner — capture snapshots BEFORE the move began
        for (const lb of LOOKBACKS_DAYS) {
          const cutoff = candles.length - 1 - 5 - lb       // 5d ago = move start, then back lb more days
          const features = snapshotAt(candles, cutoff)
          if (!features) continue
          newSigs.push({
            symbol: sym,
            gainPct: +gain5d.toFixed(1),
            lookbackDays: lb,
            capturedAt: new Date(candles[cutoff].time).toISOString().slice(0, 10),
            detectedAt: new Date().toISOString(),
            features,
          })
        }
      } catch (e) {
        // common at this scale — just skip
      }
    }
  }))

  // Merge + roll the window
  const merged = [...newSigs, ...patterns.signatures].slice(0, MAX_SIGNATURES_KEPT)
  const updated: LearnedPatterns = {
    lastRunAt: new Date().toISOString(),
    totalSignatures: merged.length,
    centroids: computeCentroid(merged),
    signatures: merged,
  }
  await savePatterns(updated)
  log.ok('LEARN', `Pattern learner done — ${newSigs.length} new signatures (total ${merged.length})`)
  return updated
}

/** Read the current learned-patterns file (for the API). */
export async function getLearnedPatterns(): Promise<LearnedPatterns> {
  return loadPatterns()
}

/** Score how well a candidate snapshot matches the learned-winner centroid (0..1). */
export function matchScore(features: PreMoveFeatures, centroids: LearnedCentroid): number {
  if (centroids.volRatio20 === 0) return 0   // not enough data yet
  // Normalised distance — closer to centroid = higher score
  const volDelta = Math.abs(features.volRatio20 - centroids.volRatio20) / Math.max(centroids.volRatio20, 1)
  const rsiDelta = Math.abs(features.rsi - centroids.rsi) / 50
  const distDelta = Math.abs(features.distFrom52wHighPct - centroids.distFrom52wHighPct) / 30
  const emaDelta = Math.abs((features.above50EMA ? 1 : 0) - centroids.above50EMA)
  const retDelta = Math.abs(features.ret20dPct - centroids.ret20dPct) / 30
  const dist = (volDelta + rsiDelta + distDelta + emaDelta + retDelta) / 5
  return Math.max(0, Math.min(1, 1 - dist))
}
