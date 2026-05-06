/**
 * Pick Journal — snapshots today's weekly-pick list and scores it
 * retroactively at +5 / +10 / +20 trading days. Lets the user answer:
 *
 *   1. "Of last week's picks, how many actually delivered the predicted move?"
 *   2. "What's our average T1/T2/T3 hit rate by conviction tier?"
 *   3. "Which screener combinations have the best hit rate?"
 *
 * Storage: server/data/pick-journal/<YYYY-MM-DD>.json — one snapshot file per
 * day. The scorecard endpoint walks all files within a window and computes
 * realised return per pick using current daily candles.
 */

import fs from 'fs/promises'
import path from 'path'
import * as data from '../data'
import { log } from '../util/logger'
import type { WeeklyPick, PickRow } from './weeklyManagerPick'

const DATA_DIR = path.resolve(__dirname, '../../data')
const JOURNAL_DIR = path.join(DATA_DIR, 'pick-journal')

export interface JournalSnapshot {
  takenAt: string                  // ISO timestamp
  weekOf: string                   // pick.weekOf
  regime: string
  rows: Array<{
    symbol: string
    direction: 'BUY' | 'SHORT'
    conviction: number
    entryPrice: number
    stopLoss: number
    target1: number
    target2: number
    target3: number
    pumpRisk: number
    noBrainerBet: boolean
    shareholdingNote: string
    smcScore: number
    trendScore: number
    flowScore: number
  }>
}

export interface ScorecardEntry {
  symbol: string
  direction: 'BUY' | 'SHORT'
  conviction: number
  noBrainerBet: boolean
  takenAt: string
  entryPrice: number
  daysSince: number
  currentPrice: number | null
  realisedPct: number | null         // signed move from entry → today (in pick direction)
  hitT1: boolean
  hitT2: boolean
  hitT3: boolean
  hitSL: boolean
  outcome: 'PENDING' | 'T1' | 'T2' | 'T3' | 'SL' | 'EXPIRED'
}

export interface Scorecard {
  windowStart: string
  windowEnd: string
  totalSnapshots: number
  totalRows: number
  // Aggregate stats
  hitRateT1: number                  // % of picks that touched T1
  hitRateT3: number
  slRate: number                     // % that hit SL first
  averageRealisedPct: number
  // By conviction tier
  byTier: Record<'80+' | '70-79' | '60-69', { count: number; hitT1: number; hitT3: number; sl: number; avgPct: number }>
  // No-brainer subset
  noBrainerHitRate: number
  // Per-row detail
  entries: ScorecardEntry[]
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(JOURNAL_DIR, { recursive: true }).catch(() => {})
}

/** Snapshot today's pick list to disk. Idempotent — overwrites today's file. */
export async function snapshotPick(pick: WeeklyPick): Promise<string> {
  await ensureDir()
  const today = new Date().toISOString().slice(0, 10)
  const file = path.join(JOURNAL_DIR, `${today}.json`)
  const snap: JournalSnapshot = {
    takenAt: new Date().toISOString(),
    weekOf: pick.weekOf,
    regime: pick.regime,
    rows: pick.rows.map(r => ({
      symbol: r.symbol,
      direction: r.direction,
      conviction: r.conviction,
      entryPrice: r.entryPrice,
      stopLoss: r.stopLoss,
      target1: r.target1,
      target2: r.target2,
      target3: r.target3,
      pumpRisk: r.pumpRisk ?? 0,
      noBrainerBet: r.noBrainerBet ?? false,
      shareholdingNote: r.shareholdingNote ?? '',
      smcScore: r.smcScore ?? 0,
      trendScore: r.trendScore ?? 0,
      flowScore: r.flowScore ?? 0,
    })),
  }
  await fs.writeFile(file, JSON.stringify(snap, null, 2))
  log.ok('JOURNAL', `Snapshot ${pick.rows.length} picks → ${path.basename(file)}`)
  return file
}

/** Read all snapshots in a date window. */
async function readSnapshots(daysBack: number): Promise<JournalSnapshot[]> {
  await ensureDir()
  const files = await fs.readdir(JOURNAL_DIR).catch(() => [] as string[])
  const cutoff = Date.now() - daysBack * 86_400_000
  const out: JournalSnapshot[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const raw = await fs.readFile(path.join(JOURNAL_DIR, f), 'utf8')
      const snap = JSON.parse(raw) as JournalSnapshot
      if (new Date(snap.takenAt).getTime() >= cutoff) out.push(snap)
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => a.takenAt < b.takenAt ? -1 : 1)
}

/**
 * Build a scorecard for the past N days. For each row in each snapshot, fetch
 * current daily candles and check which targets were touched between snapshot
 * date and today.
 */
export async function buildScorecard(daysBack = 30): Promise<Scorecard> {
  const snaps = await readSnapshots(daysBack)
  const entries: ScorecardEntry[] = []
  const seen = new Set<string>()                  // dedup symbol per snapshot date
  for (const snap of snaps) {
    for (const r of snap.rows) {
      const key = `${snap.takenAt.slice(0, 10)}|${r.symbol}`
      if (seen.has(key)) continue
      seen.add(key)
      const candles = await data.getCandles(r.symbol, '1D', 60).catch(() => [])
      if (!candles.length) {
        entries.push({
          symbol: r.symbol, direction: r.direction, conviction: r.conviction,
          noBrainerBet: r.noBrainerBet, takenAt: snap.takenAt, entryPrice: r.entryPrice,
          daysSince: 0, currentPrice: null, realisedPct: null,
          hitT1: false, hitT2: false, hitT3: false, hitSL: false, outcome: 'PENDING',
        })
        continue
      }
      const takenTs = new Date(snap.takenAt).getTime()
      const daysSince = Math.floor((Date.now() - takenTs) / 86_400_000)
      const since = candles.filter(c => c.time >= takenTs)
      if (!since.length) { continue }
      const latestPrice = since[since.length - 1].close
      const entry = r.entryPrice
      const sign = r.direction === 'BUY' ? 1 : -1
      const realisedPct = sign * ((latestPrice - entry) / entry) * 100
      // Walk the bars in chronological order; first event (T1/T2/T3 or SL) wins
      let outcome: ScorecardEntry['outcome'] = daysSince >= 28 ? 'EXPIRED' : 'PENDING'
      let hitT1 = false, hitT2 = false, hitT3 = false, hitSL = false
      for (const c of since) {
        if (r.direction === 'BUY') {
          if (c.low <= r.stopLoss) { hitSL = true; if (outcome === 'PENDING' || outcome === 'EXPIRED') outcome = 'SL'; break }
          if (c.high >= r.target1) hitT1 = true
          if (c.high >= r.target2) hitT2 = true
          if (c.high >= r.target3) { hitT3 = true; outcome = 'T3'; break }
        } else {
          if (c.high >= r.stopLoss) { hitSL = true; if (outcome === 'PENDING' || outcome === 'EXPIRED') outcome = 'SL'; break }
          if (c.low <= r.target1) hitT1 = true
          if (c.low <= r.target2) hitT2 = true
          if (c.low <= r.target3) { hitT3 = true; outcome = 'T3'; break }
        }
      }
      if (outcome === 'PENDING' && hitT2) outcome = 'T2'
      else if (outcome === 'PENDING' && hitT1) outcome = 'T1'
      entries.push({
        symbol: r.symbol, direction: r.direction, conviction: r.conviction,
        noBrainerBet: r.noBrainerBet, takenAt: snap.takenAt, entryPrice: entry,
        daysSince, currentPrice: latestPrice, realisedPct: +realisedPct.toFixed(2),
        hitT1, hitT2, hitT3, hitSL, outcome,
      })
    }
  }

  // Aggregate
  const tierBucket = (c: number): '80+' | '70-79' | '60-69' => c >= 80 ? '80+' : c >= 70 ? '70-79' : '60-69'
  const byTier = { '80+': { count: 0, hitT1: 0, hitT3: 0, sl: 0, avgPct: 0 }, '70-79': { count: 0, hitT1: 0, hitT3: 0, sl: 0, avgPct: 0 }, '60-69': { count: 0, hitT1: 0, hitT3: 0, sl: 0, avgPct: 0 } }
  for (const e of entries) {
    if (e.realisedPct == null) continue
    const t = tierBucket(e.conviction)
    byTier[t].count++
    if (e.hitT1) byTier[t].hitT1++
    if (e.hitT3) byTier[t].hitT3++
    if (e.hitSL) byTier[t].sl++
    byTier[t].avgPct += e.realisedPct
  }
  for (const t of Object.keys(byTier) as Array<keyof typeof byTier>) {
    if (byTier[t].count) byTier[t].avgPct = +(byTier[t].avgPct / byTier[t].count).toFixed(2)
  }
  const completed = entries.filter(e => e.realisedPct != null)
  const noBrainerEntries = completed.filter(e => e.noBrainerBet)
  const hitRateT1 = completed.length ? +(completed.filter(e => e.hitT1).length / completed.length * 100).toFixed(1) : 0
  const hitRateT3 = completed.length ? +(completed.filter(e => e.hitT3).length / completed.length * 100).toFixed(1) : 0
  const slRate = completed.length ? +(completed.filter(e => e.hitSL).length / completed.length * 100).toFixed(1) : 0
  const avgPct = completed.length ? +(completed.reduce((s, e) => s + (e.realisedPct ?? 0), 0) / completed.length).toFixed(2) : 0
  const noBrainerHitRate = noBrainerEntries.length ? +(noBrainerEntries.filter(e => e.hitT1).length / noBrainerEntries.length * 100).toFixed(1) : 0

  const ws = entries[0]?.takenAt.slice(0, 10) ?? new Date().toISOString().slice(0, 10)
  const we = new Date().toISOString().slice(0, 10)
  return {
    windowStart: ws, windowEnd: we,
    totalSnapshots: snaps.length, totalRows: entries.length,
    hitRateT1, hitRateT3, slRate, averageRealisedPct: avgPct,
    byTier, noBrainerHitRate,
    entries,
  }
}
