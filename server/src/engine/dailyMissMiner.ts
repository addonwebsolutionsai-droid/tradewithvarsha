/**
 * Daily Miss-Miner — runs every market day post-close (18:00 IST).
 *
 * The complaint Pattern-Learner doesn't address: it only mines our WINNERS
 * (the 10%+ movers we caught). It learns NOTHING from the movers we MISSED.
 * That asymmetry is exactly why our pick list keeps surfacing the same kind
 * of names while the actual market keeps producing winners we didn't predict.
 *
 * What this miner does, daily:
 *   1. Read past 7 days of pick-journal snapshots (what we predicted)
 *   2. Run mover-backfill for the same window (what actually moved 5%+)
 *   3. Bucket each mover into HIT (was in our pick list) or MISS (was not)
 *   4. For each MISS, snapshot its pre-move features at our prediction date
 *   5. Compare HIT centroid vs MISS centroid → delta vector tells us which
 *      features distinguished the winners we missed from the ones we caught
 *   6. Persist learning to data/learning/miss-deltas-YYYY-MM-DD.json
 *   7. Telegram digest: top 5 missed movers + the 3 features most over-weighted
 *      in misses vs hits (so the user knows what we should learn next)
 *
 * Future runs of weekly-pick read these miss-deltas and pre-rank candidates
 * whose feature vector is closer to the MISS centroid (not just the WIN
 * centroid) — actively closing blind spots.
 */
import fs from 'fs/promises'
import path from 'path'
import * as data from '../data'
import { ema, lastRSI, lastATR } from '../indicators'
import { log } from '../util/logger'
import type { Candle } from '../types'

const DATA_DIR = path.resolve(__dirname, '../../data')
const LEARNING_DIR = path.join(DATA_DIR, 'learning')

export interface MissFeatures {
  volRatio60: number
  rsi: number
  distFrom52wHighPct: number
  above50EMA: boolean
  above200EMA: boolean
  ret5dPct: number
  ret20dPct: number
  atrPct: number
  bbWidthPct: number              // bollinger band squeeze proxy
  daysSinceLastSwingHigh: number  // freshness of recent swing
}

export interface MinerReport {
  ranAt: string
  windowFrom: string
  windowTo: string
  totalMovers: number
  hits: number                    // movers we DID predict
  misses: number                  // movers we did NOT predict
  hitCentroid: MissFeatures | null
  missCentroid: MissFeatures | null
  topDeltas: Array<{ feature: string; hitMean: number; missMean: number; delta: number; interpretation: string }>
  topMissedSymbols: Array<{ symbol: string; movePct: number; features: MissFeatures }>
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(LEARNING_DIR, { recursive: true }).catch(() => {})
}

function snapshotFeatures(candles: Candle[], cutoffIdx: number): MissFeatures | null {
  if (cutoffIdx < 60 || cutoffIdx >= candles.length) return null
  const slice = candles.slice(0, cutoffIdx + 1)
  const last = slice[slice.length - 1]
  const v60 = slice.slice(-61, -1).reduce((s, c) => s + c.volume, 0) / 60
  const ref5 = slice[slice.length - 6]?.close ?? last.close
  const ref20 = slice[slice.length - 21]?.close ?? last.close
  const e50 = ema(slice, 50)[ema(slice, 50).length - 1]
  const e200 = ema(slice, 200)[ema(slice, 200).length - 1] ?? e50
  const high52 = Math.max(...slice.slice(-252).map(c => c.high))
  const rsi = lastRSI(slice, 14) ?? 50
  const atr = lastATR(slice, 14) ?? last.close * 0.02
  // Bollinger width proxy: stddev(close, 20) / sma(close, 20)
  const last20 = slice.slice(-20).map(c => c.close)
  const sma20 = last20.reduce((s, x) => s + x, 0) / 20
  const variance = last20.reduce((s, x) => s + (x - sma20) ** 2, 0) / 20
  const std20 = Math.sqrt(variance)
  // Find last swing high (highest high in last 20 days)
  const last20High = Math.max(...slice.slice(-20).map(c => c.high))
  const swingIdx = slice.slice(-20).findIndex(c => c.high === last20High)
  return {
    volRatio60: v60 > 0 ? last.volume / v60 : 0,
    rsi,
    distFrom52wHighPct: ((last.close - high52) / high52) * 100,
    above50EMA: last.close > e50,
    above200EMA: last.close > e200,
    ret5dPct: ((last.close - ref5) / ref5) * 100,
    ret20dPct: ((last.close - ref20) / ref20) * 100,
    atrPct: (atr / last.close) * 100,
    bbWidthPct: sma20 > 0 ? (4 * std20 / sma20) * 100 : 0,
    daysSinceLastSwingHigh: 19 - swingIdx,
  }
}

function computeCentroid(features: MissFeatures[]): MissFeatures | null {
  if (!features.length) return null
  const n = features.length
  return {
    volRatio60: features.reduce((s, f) => s + f.volRatio60, 0) / n,
    rsi: features.reduce((s, f) => s + f.rsi, 0) / n,
    distFrom52wHighPct: features.reduce((s, f) => s + f.distFrom52wHighPct, 0) / n,
    above50EMA: features.filter(f => f.above50EMA).length / n > 0.5,
    above200EMA: features.filter(f => f.above200EMA).length / n > 0.5,
    ret5dPct: features.reduce((s, f) => s + f.ret5dPct, 0) / n,
    ret20dPct: features.reduce((s, f) => s + f.ret20dPct, 0) / n,
    atrPct: features.reduce((s, f) => s + f.atrPct, 0) / n,
    bbWidthPct: features.reduce((s, f) => s + f.bbWidthPct, 0) / n,
    daysSinceLastSwingHigh: features.reduce((s, f) => s + f.daysSinceLastSwingHigh, 0) / n,
  }
}

function describeDelta(feature: string, hitMean: number, missMean: number): string {
  const d = missMean - hitMean
  switch (feature) {
    case 'volRatio60':
      return d > 0.3 ? `Misses had ${d.toFixed(1)}× higher vol burst — we under-weight volume spike` : `Hits had higher vol — already captured`
    case 'rsi':
      return d > 5 ? `Misses had RSI ${d.toFixed(0)}pp higher — we exit too early on RSI extremes` : d < -5 ? `Misses had RSI ${(-d).toFixed(0)}pp lower — we miss oversold reversals` : 'RSI roughly aligned'
    case 'distFrom52wHighPct':
      return d > 5 ? `Misses were closer to 52w highs — we shy away from breakouts` : d < -5 ? `Misses were further from highs — we over-weight near-high names` : 'aligned'
    case 'ret5dPct':
      return d > 3 ? `Misses already had +${d.toFixed(1)}% momentum — we wait too long to enter` : 'aligned'
    case 'ret20dPct':
      return d > 5 ? `Misses had +${d.toFixed(1)}% 20d momentum — favor longer trend confirmation` : 'aligned'
    case 'atrPct':
      return d > 0.5 ? `Misses had +${d.toFixed(2)}pp higher volatility — we under-pick volatile names` : 'aligned'
    case 'bbWidthPct':
      return d < -1 ? `Misses had ${(-d).toFixed(1)}pp tighter Bollinger — squeeze breakouts under-detected` : 'aligned'
    case 'daysSinceLastSwingHigh':
      return d < -2 ? `Misses had a recent swing high (${(-d).toFixed(1)} days closer) — fresh-high momentum missed` : 'aligned'
    default: return ''
  }
}

export async function runDailyMissMiner(daysBack = 7): Promise<MinerReport> {
  log.info('MINER', `Daily miss-mining starting (${daysBack}d window)...`)
  await ensureDir()
  const today = new Date()
  const from = new Date(today.getTime() - daysBack * 86_400_000).toISOString().slice(0, 10)
  const to = today.toISOString().slice(0, 10)

  // 1. Movers in window
  const { runMoverBackfill } = await import('../screeners/moverBackfill')
  const back = await runMoverBackfill({ from, to, minPct: 5, universeKey: 'CNX500', limitSymbols: 500 })
  const moverSyms = new Set([...back.caught, ...back.missed].map(m => m.symbol))

  // 2. Read past 7 days of pick-journal snapshots → set of symbols we predicted
  const journalDir = path.join(DATA_DIR, 'pick-journal')
  const journalFiles = await fs.readdir(journalDir).catch(() => [] as string[])
  const cutoffMs = today.getTime() - daysBack * 86_400_000
  const predicted = new Set<string>()
  for (const f of journalFiles) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(path.join(journalDir, f), 'utf8')
      const snap = JSON.parse(raw)
      if (new Date(snap.takenAt).getTime() < cutoffMs) continue
      for (const r of snap.rows) predicted.add(r.symbol)
    } catch { /* skip */ }
  }

  // 3. Bucket movers + snapshot pre-move features
  const hitFeatures: MissFeatures[] = []
  const missFeatures: MissFeatures[] = []
  const missDetails: Array<{ symbol: string; movePct: number; features: MissFeatures }> = []
  for (const m of [...back.caught, ...back.missed]) {
    try {
      const candles = await data.getCandles(m.symbol, '1D', 320)
      const moveStartTs = new Date(m.fromDate).getTime()
      const cutIdx = candles.findIndex(c => c.time >= moveStartTs)
      if (cutIdx < 60) continue
      const features = snapshotFeatures(candles, cutIdx - 1)
      if (!features) continue
      if (predicted.has(m.symbol)) {
        hitFeatures.push(features)
      } else {
        missFeatures.push(features)
        missDetails.push({ symbol: m.symbol, movePct: m.movePct, features })
      }
    } catch { /* skip */ }
  }

  const hitCentroid = computeCentroid(hitFeatures)
  const missCentroid = computeCentroid(missFeatures)

  // 4. Compute top feature deltas (numeric only)
  const topDeltas: MinerReport['topDeltas'] = []
  if (hitCentroid && missCentroid) {
    const numericKeys: (keyof MissFeatures)[] = [
      'volRatio60', 'rsi', 'distFrom52wHighPct', 'ret5dPct', 'ret20dPct',
      'atrPct', 'bbWidthPct', 'daysSinceLastSwingHigh',
    ]
    for (const k of numericKeys) {
      const h = hitCentroid[k] as number
      const m = missCentroid[k] as number
      const delta = m - h
      topDeltas.push({
        feature: k,
        hitMean: +h.toFixed(2),
        missMean: +m.toFixed(2),
        delta: +delta.toFixed(2),
        interpretation: describeDelta(k, h, m),
      })
    }
    topDeltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  }

  missDetails.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct))
  const report: MinerReport = {
    ranAt: new Date().toISOString(),
    windowFrom: from,
    windowTo: to,
    totalMovers: back.totalMovers,
    hits: hitFeatures.length,
    misses: missFeatures.length,
    hitCentroid,
    missCentroid,
    topDeltas: topDeltas.slice(0, 6),
    topMissedSymbols: missDetails.slice(0, 10),
  }

  const outFile = path.join(LEARNING_DIR, `miss-deltas-${to}.json`)
  await fs.writeFile(outFile, JSON.stringify(report, null, 2))
  log.ok('MINER', `Miss-miner done: ${hitFeatures.length} hits, ${missFeatures.length} misses, top delta: ${topDeltas[0]?.feature}`)
  return report
}

export async function getLatestMissReport(): Promise<MinerReport | null> {
  await ensureDir()
  const files = await fs.readdir(LEARNING_DIR).catch(() => [] as string[])
  const reports = files.filter(f => f.startsWith('miss-deltas-')).sort().reverse()
  if (!reports.length) return null
  try {
    const raw = await fs.readFile(path.join(LEARNING_DIR, reports[0]), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}
