/**
 * Master public-snapshot cron entry point.
 *
 * Same rationale as `oiBuildupWriter.ts` and `sectorRotationWriter.ts` —
 * `publishPublicSnapshots()` in `publicSnapshots.ts` takes 5 in-memory
 * inputs that are only assembled on the localhost cron (index.ts).
 * On GH Actions runners those inputs are never built, so 18 classic-tab
 * snapshots — weekly-pick, daily-pick, top-trades, pre-move, options,
 * sl-trap-alerts, ad-divergence, superstar-picks, signals-history,
 * hit-log, archive, intraday, old-weekly-pick, multi-strike-oi, etc. —
 * were frozen at 2026-07-10.
 *
 * This module builds all 5 inputs freshly, then invokes
 * publishPublicSnapshots. Wired into `scripts/gh-tick-eod.ts` so every
 * trading day the classic surfaces refresh alongside the newer engines.
 *
 * Kept intentionally light: the on-demand runs use tight budgets (weekly
 * pick capped at ~4 min, pre-move at ~3 min) so the whole EOD job stays
 * inside the GH Actions 60-min cap.
 */

import path from 'path'
import fs from 'fs/promises'
import { log } from '../util/logger'
import { publishPublicSnapshots } from './publicSnapshots'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

async function readIfExists(file: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(path.join(SNAP_DIR, file), 'utf-8')
    return JSON.parse(raw)
  } catch { return null }
}

export async function runMasterPublish(): Promise<{
  weeklyRows: number
  dailyRows: number
  preMoveRows: number
  hitLog: number
  files: string[]
}> {
  const t0 = Date.now()
  let weeklyPick: any = null
  let dailyPick: any = null
  let preMoveResults: any[] = []
  let hitLogEntries: any[] = []

  // ── 1. Weekly Pick ─────────────────────────────────────────────────
  try {
    const { runWeeklyPick } = await import('./weeklyManagerPick')
    weeklyPick = await Promise.race<any>([
      runWeeklyPick('MARKET_ALL', { preRankMode: 'pre-breakout' }),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error('weekly-pick timeout')), 300_000)),
    ])
    log.ok('MASTER-PUB', `weekly-pick: ${weeklyPick?.rows?.length ?? 0} rows`)
  } catch (e) {
    log.warn('MASTER-PUB', `weekly-pick failed: ${(e as Error).message}`)
  }

  // ── 2. Daily Pick ──────────────────────────────────────────────────
  try {
    const { runDailyPick } = await import('./dailyPickEngine')
    dailyPick = await Promise.race<any>([
      runDailyPick({ reason: 'gh-tick-eod' }),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error('daily-pick timeout')), 180_000)),
    ])
    log.ok('MASTER-PUB', `daily-pick: ${dailyPick?.rows?.length ?? 0} rows`)
  } catch (e) {
    log.warn('MASTER-PUB', `daily-pick failed: ${(e as Error).message}`)
  }

  // ── 3. Pre-Move screener ───────────────────────────────────────────
  try {
    const { runPreMoveIdentifier } = await import('./preMoveIdentifier')
    const preRun = await Promise.race<any>([
      runPreMoveIdentifier({ universe: 'MARKET_ALL', maxRuntimeMs: 180_000 }),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error('pre-move timeout')), 210_000)),
    ])
    preMoveResults = preRun?.results ?? preRun?.rows ?? []
    log.ok('MASTER-PUB', `pre-move: ${preMoveResults.length} results`)
  } catch (e) {
    log.warn('MASTER-PUB', `pre-move failed: ${(e as Error).message}`)
  }

  // ── 4. Hit log — read latest scorecard from journal ────────────────
  try {
    const { buildScorecard } = await import('./pickJournal')
    const sc = await Promise.race<any>([
      buildScorecard(30),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error('scorecard timeout')), 20_000)),
    ])
    hitLogEntries = sc?.entries ?? []
    log.ok('MASTER-PUB', `hit-log: ${hitLogEntries.length} entries`)
  } catch (e) {
    log.warn('MASTER-PUB', `hit-log failed: ${(e as Error).message}`)
  }

  // ── 5. Live signals — approximate from HQS + PRO-EDGE snapshots ────
  // On GH Actions the in-memory `currentSignals` array from index.ts
  // doesn't exist. Best proxy is the already-written HQS + PRO-EDGE
  // rows (fresh, same-run of the EOD cron).
  const signals: any[] = []
  const hqs = await readIfExists('high-quality-setups.json')
  const proEdge = await readIfExists('pro-edge.json')
  for (const src of [hqs, proEdge].filter(Boolean)) {
    for (const r of (src.rows ?? [])) {
      signals.push({
        symbol: r.symbol,
        direction: r.direction ?? 'LONG',
        type: 'INTRADAY',
        conviction: r.conviction ?? r.score ?? 0,
        entry: r.entry ?? r.entryPrice,
        stopLoss: r.stopLoss,
        target1: r.target1, target2: r.target2, target3: r.target3,
        source: r.source ?? 'HQS',
        pattern: r.pattern ?? '',
        ltp: r.ltp,
        timestamp: r.entryDate ?? new Date().toISOString(),
      })
    }
  }
  log.info('MASTER-PUB', `signals proxy: ${signals.length} rows from HQS+PRO-EDGE`)

  // ── 6. Publish all classic tabs ────────────────────────────────────
  const result = await publishPublicSnapshots({
    weeklyPick, dailyPick, preMoveResults, hitLogEntries, signals: signals as any,
  })

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  log.ok('MASTER-PUB', `wrote ${result.files.length} snapshot files in ${elapsed}s`)
  return {
    weeklyRows: weeklyPick?.rows?.length ?? 0,
    dailyRows: dailyPick?.rows?.length ?? 0,
    preMoveRows: preMoveResults.length,
    hitLog: hitLogEntries.length,
    files: result.files,
  }
}
