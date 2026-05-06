/**
 * Public Snapshot Publisher — writes ONLY the 3 user-facing tabs to flat JSON
 * files that the Vercel-deployed frontend can fetch (free of any backend).
 *
 * Outputs to:  server/data/public-snapshots/
 *   weekly-pick.json   — top 50 weekly picks (curated, with stake summary)
 *   options.json       — currentSignals filtered to OPTIONS type, conv ≥ 90
 *   intraday.json      — currentSignals filtered to INTRADAY, today only
 *
 * Workflow:
 *   1. Local backend writes these every 30 min (cron in index.ts)
 *   2. User commits + pushes server/data/public-snapshots/ to a public GitHub
 *      repo (via the publish.sh helper script)
 *   3. Vercel-deployed frontend fetches via:
 *        https://raw.githubusercontent.com/<user>/<repo>/main/public-snapshots/weekly-pick.json
 *
 * Optionally, a GitHub Action on a schedule can `git pull && git commit` the
 * snapshots automatically — but the simplest manual flow is to add a cron on
 * the local machine that runs the publish.sh script after each refresh.
 */

import fs from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import type { Signal } from '../types'

const DATA_DIR = path.resolve(__dirname, '../../data')
const SNAP_DIR = path.join(DATA_DIR, 'public-snapshots')

async function ensureDir(): Promise<void> {
  await fs.mkdir(SNAP_DIR, { recursive: true }).catch(() => {})
}

/**
 * Slim-down weekly-pick rows to the public-safe subset (no internal scoring
 * details, no flow notes that mention internal infrastructure).
 */
function publicWeeklyRows(rows: any[]): any[] {
  return rows.slice(0, 50).map(r => ({
    symbol: r.symbol,
    direction: r.direction,
    conviction: r.conviction,
    ltp: r.ltp,
    entryDate: r.entryDate,
    entryPriceLow: r.entryPriceLow,
    entryPriceHigh: r.entryPriceHigh,
    entryPrice: r.entryPrice,
    stopLoss: r.stopLoss,
    target1: r.target1, target1Date: r.target1Date,
    target2: r.target2, target2Date: r.target2Date,
    target3: r.target3, target3Date: r.target3Date,
    expectedReturnPct: r.expectedReturnPct,
    riskRewardRatio: r.riskRewardRatio,
    noBrainerBet: r.noBrainerBet,
    shareholdingNote: r.shareholdingNote,
    bestEntryTimeIST: r.bestEntryTimeIST,
    horaLord: r.horaLord,
    horaNote: r.horaNote,
    flowNote: r.flowNote,
  }))
}

function publicOptions(signals: Signal[]): any[] {
  return signals
    .filter(s => s.type === 'OPTIONS' && s.score >= 9)
    .slice(0, 30)
    .map(s => ({
      timestamp: s.timestamp,
      instrument: s.instrument,
      direction: s.direction,
      score: s.score,
      grade: s.grade,
      entry: s.entry,
      stopLoss: s.stopLoss,
      target1: s.target1,
      target2: s.target2,
      riskReward: s.riskReward,
      reasons: (s.reasons || []).slice(0, 3),
      source: s.source,
    }))
}

function publicIntraday(signals: Signal[]): any[] {
  const todayStart = new Date().setHours(0, 0, 0, 0)
  return signals
    .filter(s => s.type === 'INTRADAY' && new Date(s.timestamp).getTime() >= todayStart && s.score >= 7)
    .slice(0, 30)
    .map(s => ({
      timestamp: s.timestamp,
      instrument: s.instrument,
      direction: s.direction,
      score: s.score,
      grade: s.grade,
      entry: s.entry,
      stopLoss: s.stopLoss,
      target1: s.target1,
      target2: s.target2,
      riskReward: s.riskReward,
      reasons: (s.reasons || []).slice(0, 3),
      source: s.source,
    }))
}

export interface PublishOptions {
  weeklyPick: any | null         // shape: WeeklyPick (engine output)
  signals: Signal[]              // currentSignals from index.ts
}

export async function publishPublicSnapshots(opts: PublishOptions): Promise<{ files: string[]; ts: string }> {
  await ensureDir()
  const ts = new Date().toISOString()
  const files: string[] = []

  // 1. Weekly pick
  if (opts.weeklyPick) {
    const out = {
      generatedAt: ts,
      weekOf: opts.weeklyPick.weekOf,
      regime: opts.weeklyPick.regime,
      rows: publicWeeklyRows(opts.weeklyPick.rows ?? []),
    }
    const f = path.join(SNAP_DIR, 'weekly-pick.json')
    await fs.writeFile(f, JSON.stringify(out, null, 2))
    files.push('weekly-pick.json')
  }

  // 2. Options
  const optionsOut = {
    generatedAt: ts,
    rows: publicOptions(opts.signals),
  }
  const fOpts = path.join(SNAP_DIR, 'options.json')
  await fs.writeFile(fOpts, JSON.stringify(optionsOut, null, 2))
  files.push('options.json')

  // 3. Intraday
  const intraOut = {
    generatedAt: ts,
    rows: publicIntraday(opts.signals),
  }
  const fIntra = path.join(SNAP_DIR, 'intraday.json')
  await fs.writeFile(fIntra, JSON.stringify(intraOut, null, 2))
  files.push('intraday.json')

  log.ok('PUBLIC-SNAP', `Wrote ${files.join(', ')} (${publicWeeklyRows(opts.weeklyPick?.rows ?? []).length} weekly · ${optionsOut.rows.length} options · ${intraOut.rows.length} intraday)`)
  return { files, ts }
}
