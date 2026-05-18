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
    bucket: r.bucket ?? 'FIRST_BASE',     // FIRST_BASE | WAVE_2
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

/**
 * Build the unified Top Trades stream — pulls high-conviction picks from
 * weekly + daily, dedupes by (symbol, direction), sorts no-brainer first
 * then by conviction descending. Master Setup intentionally omitted from
 * the public snapshot since those are intraday-fluid and don't survive a
 * 30-min snapshot cycle gracefully.
 */
function buildTopTrades(opts: { weeklyPick: any | null; dailyPick: any | null; minConv: number; limit: number }): any[] {
  interface UnifiedRow {
    symbol: string
    source: 'WEEKLY' | 'DAILY'
    direction: string
    conviction: number
    ltp: number
    entryDate: string
    entryPrice: number
    entryPriceLow: number
    entryPriceHigh: number
    stopLoss: number
    target1: number; target1Date: string
    target2: number; target2Date: string
    target3: number; target3Date: string
    noBrainer: boolean
    shareholdingNote: string
    reasoning: string
    lifecycleStatus?: string
  }
  const rows: UnifiedRow[] = []
  const seen = new Set<string>()
  const push = (r: UnifiedRow) => {
    if (r.conviction < opts.minConv) return
    const k = `${r.symbol}|${r.direction}`
    if (seen.has(k)) return
    seen.add(k)
    rows.push(r)
  }
  // Prefer lifecycle view (with statuses) when available, else raw rows.
  const weeklySource: any[] = opts.weeklyPick?.lifecycle?.length
    ? opts.weeklyPick.lifecycle.filter((e: any) => e.status === 'ACTIVE')
    : (opts.weeklyPick?.rows ?? [])
  for (const r of weeklySource) push({
    symbol: r.symbol, source: 'WEEKLY', direction: r.direction,
    conviction: r.conviction, ltp: r.ltp,
    entryDate: r.entryDate ?? '', entryPrice: r.entryPrice,
    entryPriceLow: r.entryPriceLow ?? r.entryPrice,
    entryPriceHigh: r.entryPriceHigh ?? r.entryPrice,
    stopLoss: r.stopLoss,
    target1: r.target1, target1Date: r.target1Date ?? '',
    target2: r.target2, target2Date: r.target2Date ?? '',
    target3: r.target3, target3Date: r.target3Date ?? '',
    noBrainer: !!(r.noBrainerBet ?? r.noBrainer),
    shareholdingNote: r.shareholdingNote ?? '',
    reasoning: r.flowNote ?? r.reasoning ?? '',
    lifecycleStatus: r.status ?? r.lifecycleStatus ?? 'ACTIVE',
  })
  for (const r of (opts.dailyPick?.rows ?? [])) push({
    symbol: r.symbol, source: 'DAILY', direction: r.direction,
    conviction: r.conviction, ltp: r.ltp,
    entryDate: r.entryDate ?? '', entryPrice: r.entryPrice,
    entryPriceLow: r.entryPriceLow ?? r.entryPrice,
    entryPriceHigh: r.entryPriceHigh ?? r.entryPrice,
    stopLoss: r.stopLoss,
    target1: r.target1, target1Date: r.target1Date ?? '',
    target2: r.target2, target2Date: r.target2Date ?? '',
    target3: r.target3, target3Date: r.target3Date ?? '',
    noBrainer: false,
    shareholdingNote: r.shareholdingNote ?? '',
    reasoning: (r.reasons || []).slice(0, 2).join(' · '),
  })
  rows.sort((a, b) => {
    if (a.noBrainer !== b.noBrainer) return a.noBrainer ? -1 : 1
    return b.conviction - a.conviction
  })
  return rows.slice(0, opts.limit)
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

  // 1. Weekly pick — emit the LIFECYCLE merged view (active + superseded +
  // hits within last 21 days) so the dashboard can render strike-through
  // rows. Falls back to plain `rows` if lifecycle isn't attached yet.
  if (opts.weeklyPick) {
    let wRows: any[]
    if (opts.weeklyPick.lifecycle?.length) {
      // Lifecycle view: each entry already has full shape; project to public schema
      wRows = opts.weeklyPick.lifecycle.map(e => ({
        symbol: e.symbol,
        direction: e.direction,
        conviction: e.conviction,
        ltp: e.ltp,
        entryDate: e.entryDate,
        entryPriceLow: e.entryPriceLow,
        entryPriceHigh: e.entryPriceHigh,
        entryPrice: e.entryPrice,
        stopLoss: e.stopLoss,
        target1: e.target1, target1Date: e.target1Date,
        target2: e.target2, target2Date: e.target2Date,
        target3: e.target3, target3Date: e.target3Date,
        noBrainerBet: e.noBrainerBet,
        shareholdingNote: e.shareholdingNote,
        flowNote: e.reasoning,
        bucket: (e as any).bucket ?? 'FIRST_BASE',    // FIRST_BASE | WAVE_2
        // Lifecycle metadata for the frontend
        lifecycleStatus: e.status,                 // ACTIVE / SUPERSEDED / T1_HIT / etc
        lifecycleId: e.id,
        lifecycleReason: e.statusReason,
        lifecycleHitPrice: e.hitPrice,
        lifecycleHitAt: e.hitAt,
        firstSeenAt: e.firstSeenAt,
        lastSeenAt: e.lastSeenAt,
        statusChangedAt: e.statusChangedAt,
        convictionPrev: e.convictionPrev,
      }))
    } else {
      wRows = publicWeeklyRows(opts.weeklyPick.rows ?? [])
    }
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

  // 7. Accuracy report (system-wide hit-rate, R-multiple, by source/tier)
  // 2026-05-18: published as a separate snapshot for the dashboard strip.
  let accuracy: any = null
  try {
    const { buildAccuracyReport } = await import('./signalLifecycle')
    accuracy = await Promise.race<any>([
      buildAccuracyReport({ source: 'ALL', daysBack: 30 }),
      new Promise<any>(r => setTimeout(() => r(null), 6000)),
    ])
  } catch { /* skip */ }
  const accOut = { generatedAt: ts, daysBack: 30, ...accuracy }
  await fs.writeFile(path.join(SNAP_DIR, 'accuracy.json'), JSON.stringify(accOut, null, 2))
  files.push('accuracy.json')

  // 8. Top Trades (curated elite-only stream — conviction ≥ 85 across all sources)
  // 2026-05-10: Promoted to a public tab so the Vercel deploy gets the same
  // single-stream high-signal view as localhost. Dedup by (symbol, direction).
  const topRows = buildTopTrades({
    weeklyPick: opts.weeklyPick,
    dailyPick: opts.dailyPick,
    minConv: 85,
    limit: 30,
  })
  const topOut = { generatedAt: ts, filterMinConv: 85, totalAvailable: topRows.length, rows: topRows }
  await fs.writeFile(path.join(SNAP_DIR, 'top-trades.json'), JSON.stringify(topOut, null, 2))
  files.push('top-trades.json')

  log.ok('PUBLIC-SNAP', `Wrote ${files.length} files: ${publicWeeklyRows(opts.weeklyPick?.rows ?? []).length} weekly · ${publicDailyRows(opts.dailyPick?.rows ?? []).length} daily · ${preMoveOut.rows.length} premove · ${optionsOut.rows.length} options · ${intraOut.rows.length} intraday · ${hitOut.entries.length} hits`)
  return { files, ts }
}
