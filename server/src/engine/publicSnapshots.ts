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
  const dataMod = await import('../data')
  // 2026-05-26: also enrich with vol5dRatio + smartMoneyUp + raw deltas
  // (per user request: "Last 5 Days volume higher than weekly/monthly AND
  // FII & Promoters increasing stakes"). Done in one pass over all rows.
  let cursor = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < rows.length) {
      const r = rows[cursor++]
      // Volume — only if missing
      if (r.vol5dRatio == null) {
        try {
          const candles = await dataMod.getCandles(r.symbol, '1D', 25)
          if (candles.length >= 20) {
            const v20 = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20
            const v5 = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5
            r.vol5dRatio = v20 > 0 ? +(v5 / v20).toFixed(2) : 1
          }
        } catch { /* skip */ }
      }
      // Shareholding — both note + deltas + smart-money flag
      try {
        const shp = await getShareholding(r.symbol)
        if (!shp) continue
        r.fiiDelta = +shp.fiiDeltaQoQ.toFixed(2)
        r.promoterDelta = +shp.promoterDeltaQoQ.toFixed(2)
        r.diiDelta = +shp.diiDeltaQoQ.toFixed(2)
        r.smartMoneyUp = r.fiiDelta > 0.3 && r.promoterDelta >= -0.2
        if (!r.shareholdingNote || r.shareholdingNote.includes('unavailable')) {
          const fiiArr = shp.fiiDeltaQoQ > 0.1 ? '↑' : shp.fiiDeltaQoQ < -0.1 ? '↓' : '→'
          const pArr = shp.promoterDeltaQoQ > 0.1 ? '↑' : shp.promoterDeltaQoQ < -0.1 ? '↓' : '→'
          const dArr = shp.diiDeltaQoQ > 0.1 ? '↑' : shp.diiDeltaQoQ < -0.1 ? '↓' : '→'
          const mc = shp.marketCapCr >= 1000
            ? `${(shp.marketCapCr / 1000).toFixed(1)}KCr`
            : shp.marketCapCr > 0 ? `${shp.marketCapCr.toFixed(0)}Cr` : '?'
          r.shareholdingNote = `FII ${shp.fiiPct.toFixed(1)}%${fiiArr} · DII ${shp.diiPct.toFixed(1)}%${dArr} · P ${shp.promoterPct.toFixed(1)}%${pArr} · Pledge ${shp.promoterPledgePct.toFixed(1)}% · MC ₹${mc}`
        }
      } catch { /* skip */ }
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
    // 2026-05-26: new money-flow fields per user request.
    vol5dRatio: r.vol5dRatio,
    smartMoneyUp: r.smartMoneyUp,
    fiiDelta: r.fiiDelta,
    promoterDelta: r.promoterDelta,
    diiDelta: r.diiDelta,
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
    // 2026-05-26: money-flow fields
    vol5dRatio: r.vol5dRatio,
    smartMoneyUp: r.smartMoneyUp,
    fiiDelta: r.fiiDelta,
    promoterDelta: r.promoterDelta,
    diiDelta: r.diiDelta,
  }))
}

function publicPreMoveRows(rows: any[]): any[] {
  // 2026-05-27: DEDUP by symbol. The pre-move scan emits one row per
  // screener hit, so a stock matching 3 patterns (e.g. JSWSTEEL) showed 3×.
  // Collapse to ONE row per symbol — keep the highest-score hit and merge
  // the distinct pattern tags so the user still sees every signal that fired.
  const bySym = new Map<string, any>()
  for (const r of (rows ?? []).filter(r => r.score >= 7)) {
    const prev = bySym.get(r.symbol)
    if (!prev) { bySym.set(r.symbol, { ...r, tags: [...(r.tags ?? [])] }); continue }
    // merge tags (dedup), keep the higher-score row's trade plan
    const mergedTags = Array.from(new Set([...(prev.tags ?? []), ...(r.tags ?? [])]))
    if (r.score > prev.score) bySym.set(r.symbol, { ...r, tags: mergedTags })
    else prev.tags = mergedTags
  }
  return Array.from(bySym.values())
    .sort((a, b) => b.score - a.score)
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
      shareholdingNote: r.shareholdingNote ?? '',
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
      // 2026-05-27: DEDUP + FILTER. The lifecycle array accumulates every
      // historical entry (1355 rows: 497 superseded + 511 pending + dupes —
      // AIAENG appeared 5×). Weekly Pick must show ONE row per symbol and
      // must NOT show SUPERSEDED/EXPIRED (those live in Track Record's
      // Superseded tab). Keep the most relevant entry per symbol by status
      // priority: T*_HIT/ACTIVE > PENDING > terminal, then most-recent.
      const STATUS_RANK: Record<string, number> = {
        T3_HIT: 9, T2_HIT: 8, T1_HIT: 7, ACTIVE: 6, PENDING: 5,
        SL_HIT: 2, EXPIRED: 1, SUPERSEDED: 0, INVALIDATED: 0,
      }
      const newestTs = (e: any): string =>
        [e.statusChangedAt, e.lastSeenAt, e.firstSeenAt].filter(Boolean).sort().slice(-1)[0] ?? ''
      // Dedup by SYMBOL ONLY — a stock must never appear as both BUY and
      // SHORT. When stale opposite-direction signals collide, pick the best
      // by: status rank → conviction → recency.
      const bestPerSym = new Map<string, any>()
      for (const e of opts.weeklyPick.lifecycle) {
        const key = e.symbol
        const prev = bestPerSym.get(key)
        if (!prev) { bestPerSym.set(key, e); continue }
        const rNew = STATUS_RANK[e.status] ?? 3
        const rOld = STATUS_RANK[prev.status] ?? 3
        const better =
          rNew !== rOld ? rNew > rOld :
          (e.conviction ?? 0) !== (prev.conviction ?? 0) ? (e.conviction ?? 0) > (prev.conviction ?? 0) :
          newestTs(e) > newestTs(prev)
        if (better) bestPerSym.set(key, e)
      }
      // Drop superseded/expired/invalidated from the active Weekly Pick feed.
      const HIDE = new Set(['SUPERSEDED', 'EXPIRED', 'INVALIDATED'])
      const deduped = Array.from(bestPerSym.values()).filter(e => !HIDE.has(e.status))
      wRows = deduped.map(e => ({
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

  // 6.5 — Signals History (every signal with full outcome trail for the
  // public Track Record page). Strips internal IDs but keeps symbol, direction,
  // entry/SL/targets, status (PENDING/ACTIVE/T1_HIT/...), realised %, reason.
  // 2026-05-20: built so users can verify accuracy of past calls publicly.
  try {
    const { loadStore } = await import('./signalLifecycle')
    const lcStore = await loadStore()
    // 2026-05-27: DEDUP. The store accumulates a fresh lifecycle entry every
    // time an engine re-emits the same setup (weekly pick reruns hourly), so
    // KIMS/BAJAJ-AUTO etc. piled up 6-9× each. Collapse to ONE record per
    // (symbol | direction | source), keeping the most-recently-updated entry.
    // An entry counts as "newer" by max(statusChangedAt, lastSeenAt,
    // firstSeenAt). The superseded duplicates are dropped from the feed —
    // but the LATEST entry retains its real status (incl. SUPERSEDED) so the
    // new Superseded tab still has data.
    const newestTs = (e: any): string => {
      const ts = [e.statusChangedAt, e.lastSeenAt, e.firstSeenAt].filter(Boolean) as string[]
      return ts.sort().slice(-1)[0] ?? e.firstSeenAt ?? ''
    }
    const dedup = new Map<string, any>()
    for (const e of Object.values(lcStore.entries)) {
      const key = `${e.symbol}|${e.direction}|${e.source}`
      const prev = dedup.get(key)
      if (!prev || newestTs(e) > newestTs(prev)) dedup.set(key, e)
    }
    const entries = Array.from(dedup.values())
      .sort((a, b) => (newestTs(a) < newestTs(b) ? 1 : -1))         // newest first
      .slice(0, 500)
      .map(e => {
        const isTerminal = ['T1_HIT', 'T2_HIT', 'T3_HIT', 'SL_HIT', 'EXPIRED', 'INVALIDATED'].includes(e.status)
        const realisedPct = (() => {
          if (!isTerminal || e.hitPrice == null) return null
          const sign = e.direction === 'BUY' ? 1 : -1
          return +(sign * ((e.hitPrice - e.entryPrice) / e.entryPrice) * 100).toFixed(2)
        })()
        return {
          symbol: e.symbol,
          source: e.source,
          direction: e.direction,
          bucket: (e as any).bucket ?? null,
          generatedAt: e.firstSeenAt,
          ltp: e.ltp,
          entry: e.entryPrice,
          entryLow: e.entryPriceLow,
          entryHigh: e.entryPriceHigh,
          stopLoss: e.stopLoss,
          target1: e.target1, target2: e.target2, target3: e.target3,
          status: e.status,
          statusChangedAt: e.statusChangedAt,
          hitPrice: e.hitPrice ?? null,
          hitAt: e.hitAt ?? null,
          realisedPct,
          conviction: e.conviction,
          shareholdingNote: (e as any).shareholdingNote ?? '',
          reason: e.reasoning || e.statusReason || '',
        }
      })
    const histOut = { generatedAt: ts, total: entries.length, signals: entries }
    await fs.writeFile(path.join(SNAP_DIR, 'signals-history.json'), JSON.stringify(histOut, null, 2))
    files.push('signals-history.json')
  } catch (e) {
    log.warn('PUBLIC-SNAP', `signals-history: ${(e as Error).message}`)
  }

  // 6.5 Pre-Move Identifier (8-signal composite scorer for 5–20% moves)
  // 2026-05-26: published as its own snapshot so the public Vercel page
  // and localhost share the same data. Best-effort — if no run yet, file
  // is omitted (page falls back to empty state).
  try {
    const { getLatestPreMoveRun } = await import('./preMoveIdentifier')
    const pm = await getLatestPreMoveRun()
    if (pm) {
      await fs.writeFile(path.join(SNAP_DIR, 'pre-move-identifier.json'), JSON.stringify(pm, null, 2))
      files.push('pre-move-identifier.json')
    }
  } catch (e) {
    log.warn('PUBLIC-SNAP', `pre-move-identifier: ${(e as Error).message}`)
  }

  // 6.6 F&O OI Build-up — NIFTY option-chain flow analysis (long buildup,
  // short covering, writing). 2026-05-31: published so Vercel can show
  // real-time-ish institutional positioning. Source = oiMonitor.tickOiMonitor
  // (already running on the live cron). We project to a public schema with
  // entry/SL/T1 levels derived from the spot + ATR proxy for each flow row.
  try {
    const { getLatestOiAnalysis, tickOiMonitor } = await import('./oiMonitor')
    let oi = getLatestOiAnalysis()
    // Cold-start path: if no cached analysis exists yet (server just booted,
    // or first run before the cron has fired) run a tick now so we at least
    // populate lastSnap → parked-OI flows in getLatestOiAnalysis().
    if (!Object.values(oi).some(v => v && (v as any).strikeFlows?.length)) {
      try { await tickOiMonitor() } catch { /* fall through */ }
      oi = getLatestOiAnalysis()
    }
    const buildupRows: any[] = []
    for (const [underlying, a] of Object.entries(oi)) {
      if (!a) continue
      // Combine top bullish + bearish flows; cap strength at 100 and only emit
      // signals with strength ≥ 35 (filters out noise from minor strikes).
      let flows = [...(a.top3Bullish ?? []), ...(a.top3Bearish ?? [])]
        .filter((f: any) => (f?.strength ?? 0) >= 35)
        .slice(0, 8)
      // 2026-06-01 fallback: when no delta-driven flows exist (cold start,
      // weekend, before first market tick), surface the strikes with the
      // largest *absolute* OI — i.e. where institutions are currently
      // parked. CE-heavy strikes above spot = resistance (bearish bias);
      // PE-heavy strikes below spot = support (bullish bias).
      if (flows.length === 0 && (a as any).strikeFlows && (a as any).strikeFlows.length) {
        const all = (a as any).strikeFlows as any[]
        const ceHeavy = all
          .filter(f => f.side === 'CE' && f.strike >= a.spot)
          .sort((x, y) => (y.currentOI ?? 0) - (x.currentOI ?? 0))
          .slice(0, 3)
          .map(f => ({ ...f, bias: 'BEARISH', kind: f.kind || 'CE_PARKED', strength: Math.max(f.strength ?? 0, 35), note: f.note || `Heavy CE writing parked at ${f.strike} — institutional resistance` }))
        const peHeavy = all
          .filter(f => f.side === 'PE' && f.strike <= a.spot)
          .sort((x, y) => (y.currentOI ?? 0) - (x.currentOI ?? 0))
          .slice(0, 3)
          .map(f => ({ ...f, bias: 'BULLISH', kind: f.kind || 'PE_PARKED', strength: Math.max(f.strength ?? 0, 35), note: f.note || `Heavy PE writing parked at ${f.strike} — institutional support` }))
        flows = [...peHeavy, ...ceHeavy]
      }
      for (const f of flows) {
        // ATR proxy: 0.5 % of spot for NIFTY. Used to size SL/T1/T2 around
        // the strike since OI flows imply mean-reversion or breakout zones.
        const atrProxy = a.spot * 0.005
        const bullish = f.bias === 'BULLISH'
        // 2026-06-02 — trade leg must MATCH the bias, not the institutional
        // writing side. PE_WRITING at 23200 (bias=BULLISH) means spot stays
        // above 23200, so the directional trade is BUY ATM CE — NOT buy the
        // PE that institutions are writing (that's the opposite bet).
        const tradeSide: 'CE' | 'PE' = bullish ? 'CE' : 'PE'
        const tradeStrike = (a as any).atmStrike ?? Math.round(a.spot / 50) * 50
        const tradeLtp = bullish
          ? ((a as any).atmCeLtp ?? +(a.spot * 0.01).toFixed(2))
          : ((a as any).atmPeLtp ?? +(a.spot * 0.01).toFixed(2))
        const entry = +tradeLtp.toFixed(2)
        // Underlying-level move targets — what the trader actually watches.
        const spotEntry = a.spot
        const spotSL = bullish ? +(spotEntry - atrProxy * 2).toFixed(2) : +(spotEntry + atrProxy * 2).toFixed(2)
        const spotT1 = bullish ? +(spotEntry + atrProxy * 2).toFixed(2) : +(spotEntry - atrProxy * 2).toFixed(2)
        const spotT2 = bullish ? +(spotEntry + atrProxy * 4).toFixed(2) : +(spotEntry - atrProxy * 4).toFixed(2)
        buildupRows.push({
          underlying,
          strike: f.strike,
          side: f.side,                   // institutional writing side (informational)
          kind: f.kind,                   // AGGR_CE_BUY / PE_WRITING / CE_COVERING / etc.
          bias: f.bias,                   // BULLISH | BEARISH
          strength: Math.round(f.strength ?? 0),
          oiChange: f.oiChange,
          oiChangePct: f.currentOI > 0 ? +(f.oiChange / f.currentOI * 100).toFixed(1) : null,
          ltpChange: f.ltpChange,
          ltpChangePct: f.ltpChangePct,
          currentOI: f.currentOI,
          currentLTP: f.currentLTP,
          currentIV: f.currentIV,
          currentVol: f.currentVol,
          spot: a.spot,
          pcr: a.pcr,
          maxPain: a.maxPain,
          note: f.note,
          // Trade plan — bias-aligned (BULLISH → BUY ATM CE; BEARISH → BUY ATM PE)
          tradeSide,
          tradeStrike,
          tradeInstrument: `${underlying} ${tradeStrike} ${tradeSide}`,
          tradeAction: `BUY ${underlying} ${tradeStrike} ${tradeSide}`,
          entry,
          stopLoss: +(entry * 0.7).toFixed(2),     // 30% premium SL
          target1:  +(entry * 1.4).toFixed(2),     // 40% premium gain
          target2:  +(entry * 1.8).toFixed(2),     // 80% premium gain
          // Spot-level levels (for futures / spot directional trade)
          spotEntry, spotSL, spotT1, spotT2,
        })
      }
    }
    // 2026-05-31: dataMode tag + last-known-good preservation.
    // After market hours (or on weekends) the OI feed has no fresh delta,
    // so buildupRows is empty. Instead of overwriting the page with "no
    // data", we preserve the LAST snapshot that had real rows (which
    // captures end-of-day positioning) and tag the dataMode so the UI
    // knows whether to show "Live" or "End-of-Day" labels.
    const istNow = new Date(Date.now() + 5.5 * 3600_000)
    const istDow = istNow.getUTCDay()   // 0=Sun, 6=Sat
    const istHour = istNow.getUTCHours()
    const istMin = istNow.getUTCMinutes()
    const minOfDay = istHour * 60 + istMin
    // NSE F&O hours: 09:15–15:30 IST. Mon-Fri only.
    const isMarketHours = istDow >= 1 && istDow <= 5 && minOfDay >= 9 * 60 + 15 && minOfDay < 15 * 60 + 30
    const summary = Object.entries(oi).filter(([, a]) => a).map(([u, a]: any) => ({
      underlying: u,
      spot: a.spot, pcr: a.pcr, maxPain: a.maxPain,
      dominantBias: a.dominantBias,
      summary: a.summary,
      biasBreakdown: a.biasBreakdown,
    }))
    // dataMode rules:
    //   LIVE        — market is currently open AND we have real deltas
    //   PRE_OPEN    — market is open but no deltas yet (waiting for first tick)
    //   END_OF_DAY  — market is closed (data shown is from last session)
    const hasLiveDeltas = buildupRows.some(r => Math.abs(r.oiChange ?? 0) > 0)
    let dataMode: 'LIVE' | 'END_OF_DAY' | 'PRE_OPEN'
    if (isMarketHours) dataMode = hasLiveDeltas ? 'LIVE' : 'PRE_OPEN'
    else dataMode = 'END_OF_DAY'
    let lastFlowAt: string | null = hasLiveDeltas ? ts : null
    let rowsOut = buildupRows
    let summaryOut = summary
    if (buildupRows.length === 0) {
      // Try to preserve the last non-empty snapshot from disk.
      try {
        const prevRaw = await fs.readFile(path.join(SNAP_DIR, 'oi-buildup.json'), 'utf8')
        const prev = JSON.parse(prevRaw)
        if ((prev.rows ?? []).length > 0) {
          rowsOut = prev.rows
          summaryOut = prev.summary ?? summary
          lastFlowAt = prev.lastFlowAt ?? prev.generatedAt
        }
      } catch { /* no prior file → keep empty */ }
    } else if (!hasLiveDeltas) {
      // Synthetic parked-OI rows present. Preserve the lastFlowAt from prior
      // non-empty snapshot if available so the UI can show "Last live capture".
      try {
        const prevRaw = await fs.readFile(path.join(SNAP_DIR, 'oi-buildup.json'), 'utf8')
        const prev = JSON.parse(prevRaw)
        if (prev.lastFlowAt) lastFlowAt = prev.lastFlowAt
      } catch { /* ignore */ }
    }
    const oiOut = {
      generatedAt: ts,
      dataMode,
      isMarketHours,
      lastFlowAt,
      symbols: Object.keys(oi).filter(k => oi[k]),
      summary: summaryOut,
      rows: rowsOut,
    }
    await fs.writeFile(path.join(SNAP_DIR, 'oi-buildup.json'), JSON.stringify(oiOut, null, 2))
    files.push('oi-buildup.json')
  } catch (e) {
    log.warn('PUBLIC-SNAP', `oi-buildup: ${(e as Error).message}`)
  }

  // 7. Accuracy report (system-wide hit-rate, R-multiple, by source/tier)
  // 2026-05-18: published as a separate snapshot for the dashboard strip.
  // 2026-05-25: also includes catch-rate (% of NSE top-gainers our pre-move
  // screeners caught on T-1 over the last 30 days). This is the user's
  // primary KPI — "did we catch the move BEFORE it happened".
  let accuracy: any = null
  try {
    const { buildAccuracyReport } = await import('./signalLifecycle')
    accuracy = await Promise.race<any>([
      buildAccuracyReport({ source: 'ALL', daysBack: 30 }),
      new Promise<any>(r => setTimeout(() => r(null), 6000)),
    ])
  } catch { /* skip */ }
  let catchRate: any = null
  try {
    const { getLatestCatchReport, getCatchRateRolling } = await import('./dailyCatchAnalyzer')
    const latest = await getLatestCatchReport()
    const rolling = await getCatchRateRolling(30)
    if (latest || rolling.runs > 0) catchRate = { latest, rolling }
  } catch { /* skip */ }
  const accOut = { generatedAt: ts, daysBack: 30, ...accuracy, catchRate }
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
