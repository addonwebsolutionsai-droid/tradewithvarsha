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
 * Publish-time enricher — for any row whose shareholdingNote is missing,
 * empty, or the 'unavailable' fallback, attempt to fetch from the disk
 * cache. Runs in parallel with rate limit. After this returns, every row
 * has SOMETHING in shareholdingNote (real data if cached, fallback otherwise).
 */
async function enrichShareholdingNotes(rows: any[]): Promise<void> {
  const { getShareholding } = await import('../data/shareholding')
  const needsFetch = rows.filter(r => !r.shareholdingNote || r.shareholdingNote.includes('unavailable'))
  let cursor = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < needsFetch.length) {
      const r = needsFetch[cursor++]
      try {
        const shp = await getShareholding(r.symbol)
        if (!shp) continue                  // leave fallback in place
        const fiiArr = shp.fiiDeltaQoQ > 0.1 ? '↑' : shp.fiiDeltaQoQ < -0.1 ? '↓' : '→'
        const pArr = shp.promoterDeltaQoQ > 0.1 ? '↑' : shp.promoterDeltaQoQ < -0.1 ? '↓' : '→'
        const dArr = shp.diiDeltaQoQ > 0.1 ? '↑' : shp.diiDeltaQoQ < -0.1 ? '↓' : '→'
        const mc = shp.marketCapCr >= 1000
          ? `${(shp.marketCapCr / 1000).toFixed(1)}KCr`
          : shp.marketCapCr > 0 ? `${shp.marketCapCr.toFixed(0)}Cr` : '?'
        r.shareholdingNote = `FII ${shp.fiiPct.toFixed(1)}%${fiiArr} · DII ${shp.diiPct.toFixed(1)}%${dArr} · P ${shp.promoterPct.toFixed(1)}%${pArr} · Pledge ${shp.promoterPledgePct.toFixed(1)}% · MC ₹${mc}`
      } catch { /* skip — fallback stays */ }
    }
  }))
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
  dailyPick: any | null          // shape: DailyPick (engine output)
  preMoveResults: any[] | null   // ScreenerResult[] from premove scan
  hitLogEntries: any[] | null    // ScorecardEntry[] from pickJournal
  signals: Signal[]              // currentSignals from index.ts
}

function publicDailyRows(rows: any[]): any[] {
  return (rows ?? []).slice(0, 30).map(r => ({
    symbol: r.symbol,
    direction: r.direction,
    pattern: r.pattern,
    conviction: r.conviction,
    ltp: r.ltp,
    entryPrice: r.entryPrice,
    stopLoss: r.stopLoss,
    target1: r.target1, target1Date: r.target1Date,
    target2: r.target2, target2Date: r.target2Date,
    target3: r.target3, target3Date: r.target3Date,
    riskReward: r.riskReward,
    shareholdingNote: r.shareholdingNote ?? '',     // populated by enricher below
  }))
}

function publicPreMoveRows(rows: any[]): any[] {
  return (rows ?? [])
    .filter(r => r.score >= 7)
    .slice(0, 40)
    .map(r => ({
      symbol: r.symbol,
      price: r.price,
      direction: r.direction,
      tier: r.tier,
      score: r.score,
      tags: r.tags ?? [],
      suggestedEntry: r.suggestedEntry,
      suggestedSL: r.suggestedSL,
      suggestedTarget: r.suggestedTarget,
      expectedMovePct: r.expectedMovePct,
      timeframeLabel: r.timeframeLabel,
    }))
}

function publicHitLog(entries: any[]): any[] {
  // Keep only completed outcomes (T1/T2/T3/SL/EXPIRED) and sort newest-first.
  return (entries ?? [])
    .filter(e => e.outcome && e.outcome !== 'PENDING')
    .sort((a, b) => (b.takenAt < a.takenAt ? -1 : 1))
    .slice(0, 30)
    .map(e => ({
      symbol: e.symbol,
      direction: e.direction,
      conviction: e.conviction,
      takenAt: e.takenAt,
      entryPrice: e.entryPrice,
      currentPrice: e.currentPrice,
      realisedPct: e.realisedPct,
      outcome: e.outcome,
      daysSince: e.daysSince,
    }))
}

export async function publishPublicSnapshots(opts: PublishOptions): Promise<{ files: string[]; ts: string }> {
  await ensureDir()
  const ts = new Date().toISOString()
  const files: string[] = []

  // 1. Weekly pick — enrich shareholding from disk cache before serializing.
  if (opts.weeklyPick) {
    const wRows = publicWeeklyRows(opts.weeklyPick.rows ?? [])
    await enrichShareholdingNotes(wRows)
    const out = { generatedAt: ts, weekOf: opts.weeklyPick.weekOf, regime: opts.weeklyPick.regime, rows: wRows }
    await fs.writeFile(path.join(SNAP_DIR, 'weekly-pick.json'), JSON.stringify(out, null, 2))
    files.push('weekly-pick.json')
  }

  // 2. Daily pick — same enrichment.
  if (opts.dailyPick) {
    const dRows = publicDailyRows(opts.dailyPick.rows ?? [])
    await enrichShareholdingNotes(dRows)
    const out = { generatedAt: ts, regime: opts.dailyPick.regime ?? '', rows: dRows }
    await fs.writeFile(path.join(SNAP_DIR, 'daily-pick.json'), JSON.stringify(out, null, 2))
    files.push('daily-pick.json')
  } else {
    await fs.writeFile(path.join(SNAP_DIR, 'daily-pick.json'), JSON.stringify({ generatedAt: ts, regime: '', rows: [] }, null, 2))
    files.push('daily-pick.json')
  }

  // 3. Pre-move
  const preMoveOut = { generatedAt: ts, rows: publicPreMoveRows(opts.preMoveResults ?? []) }
  await fs.writeFile(path.join(SNAP_DIR, 'pre-move.json'), JSON.stringify(preMoveOut, null, 2))
  files.push('pre-move.json')

  // 4. Options
  const optionsOut = { generatedAt: ts, rows: publicOptions(opts.signals) }
  await fs.writeFile(path.join(SNAP_DIR, 'options.json'), JSON.stringify(optionsOut, null, 2))
  files.push('options.json')

  // 5. Intraday
  const intraOut = { generatedAt: ts, rows: publicIntraday(opts.signals) }
  await fs.writeFile(path.join(SNAP_DIR, 'intraday.json'), JSON.stringify(intraOut, null, 2))
  files.push('intraday.json')

  // 6. Hit log (target accuracy tracker)
  const hitOut = { generatedAt: ts, entries: publicHitLog(opts.hitLogEntries ?? []) }
  await fs.writeFile(path.join(SNAP_DIR, 'hit-log.json'), JSON.stringify(hitOut, null, 2))
  files.push('hit-log.json')

  log.ok('PUBLIC-SNAP', `Wrote ${files.length} files: ${publicWeeklyRows(opts.weeklyPick?.rows ?? []).length} weekly · ${publicDailyRows(opts.dailyPick?.rows ?? []).length} daily · ${preMoveOut.rows.length} premove · ${optionsOut.rows.length} options · ${intraOut.rows.length} intraday · ${hitOut.entries.length} hits`)
  return { files, ts }
}
