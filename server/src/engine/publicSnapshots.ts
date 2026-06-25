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
export async function enrichShareholdingNotes(rows: any[]): Promise<void> {
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
          // 2026-06-04: matches new Weekly Pick format — bracketed QoQ delta.
          const fmtDelta = (d: number) => {
            if (d > 0.1) return ` (${d.toFixed(2)}%↑)`
            if (d < -0.1) return ` (${Math.abs(d).toFixed(2)}%↓)`
            return '→'
          }
          const mc = shp.marketCapCr >= 1000
            ? `${(shp.marketCapCr / 1000).toFixed(1)}KCr`
            : shp.marketCapCr > 0 ? `${shp.marketCapCr.toFixed(0)}Cr` : '?'
          r.shareholdingNote = `FII ${shp.fiiPct.toFixed(1)}%${fmtDelta(shp.fiiDeltaQoQ)} · DII ${shp.diiPct.toFixed(1)}%${fmtDelta(shp.diiDeltaQoQ)} · P ${shp.promoterPct.toFixed(1)}%${fmtDelta(shp.promoterDeltaQoQ)} · Pledge ${shp.promoterPledgePct.toFixed(1)}% · MC ₹${mc}`
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

// F&O futures scan — async/throttled. Min 25 min between scans so we don't
// re-scan every snapshot publish (those run every 30 min anyway).
let fnoScanInflight: Promise<void> | null = null
let fnoLastScanAt = 0
const FNO_SCAN_MIN_INTERVAL_MS = 25 * 60_000

// Gainer Postmortem — for every gainer (NSE500 + 5 Kotak Neo pages + 3
// other sites), backward-simulates our pre-breakout rule and reports
// when our scanner WOULD have fired, plus diagnoses why we missed.
// Auto-tune feedback loop for daily self-improvement towards 85% goal.
// Throttled to 1× per 120 min (heavy: scrapes 8 sites + 60 candle fetches).
let postmortemInflight: Promise<void> | null = null
let postmortemLastAt = 0
const POSTMORTEM_MIN_MS = 120 * 60_000

async function triggerGainerPostmortem(): Promise<void> {
  if (postmortemInflight) return postmortemInflight
  if (Date.now() - postmortemLastAt < POSTMORTEM_MIN_MS) return
  postmortemInflight = (async () => {
    try {
      const { runGainerPostmortem } = await import('./gainerPostmortem')
      const r = await runGainerPostmortem()
      await fs.writeFile(path.join(SNAP_DIR, 'gainer-postmortem.json'), JSON.stringify(r, null, 2))
      postmortemLastAt = Date.now()
      log.ok('PUBLIC-SNAP', `gainer-postmortem: ${r.totalGainers} analysed · caught ${r.caughtCount} · would-have-caught ${r.wouldHaveCaughtCount} more`)
    } catch (e) {
      log.warn('PUBLIC-SNAP', `gainer-postmortem async: ${(e as Error).message}`)
    } finally {
      postmortemInflight = null
    }
  })()
}

// Superstar scanner — for the ~60 stocks held by India's top 10 investors
// (Rekha Jhunjhunwala / Damani / Mukul Agrawal / Kacholia / Kedia / Dolly
// Khanna / Anil Goel / Sunil Singhania / Madhusudan Kela / Porinju), run
// our Weekly Pick scoring. Surface when both forces agree.
// Throttled 25min — cheap (60 candle fetches).
let superstarInflight: Promise<void> | null = null
let superstarLastAt = 0
const SUPERSTAR_MIN_MS = 25 * 60_000

async function triggerSuperstarScan(): Promise<void> {
  if (superstarInflight) return superstarInflight
  if (Date.now() - superstarLastAt < SUPERSTAR_MIN_MS) return
  superstarInflight = (async () => {
    const startedAt = new Date().toISOString()
    try {
      const { scanSuperstarPicks } = await import('./superstarPicksScanner')
      const { SUPERSTAR_INVESTORS } = await import('../data/superstarHoldings')
      const rows = await scanSuperstarPicks()
      const out = {
        generatedAt: startedAt,
        investorCount: SUPERSTAR_INVESTORS.length,
        investors: SUPERSTAR_INVESTORS.map(i => ({
          name: i.name, alias: i.alias, category: i.category, bio: i.bio,
          trackRecord: i.trackRecord, asOfQuarter: i.asOfQuarter,
          holdingCount: i.holdings.length,
        })),
        total: rows.length,
        activelyLoadingCount: rows.filter(r => r.newOrIncreasedCount > 0).length,
        rows,
      }
      await fs.writeFile(path.join(SNAP_DIR, 'superstar-picks.json'), JSON.stringify(out, null, 2))
      superstarLastAt = Date.now()
      log.ok('PUBLIC-SNAP', `superstar-picks: ${rows.length} scored · ${out.activelyLoadingCount} actively loading`)
    } catch (e) {
      log.warn('PUBLIC-SNAP', `superstar-picks async: ${(e as Error).message}`)
    } finally {
      superstarInflight = null
    }
  })()
}

// 2026-06-25: EARLY MOMENTUM scanner — user-specific ₹50-500 radar for
// 10-20%-in-a-week candidates. Heavy (~2-3 min over NSE_ALL); throttled
// 90-min so each publish cycle picks up at most one fresh run.
let earlyMomInflight: Promise<void> | null = null
let earlyMomLastAt = 0
const EARLY_MOM_MIN_MS = 90 * 60_000

async function triggerEarlyMomentumScan(): Promise<void> {
  if (earlyMomInflight) return earlyMomInflight
  if (Date.now() - earlyMomLastAt < EARLY_MOM_MIN_MS) return
  earlyMomInflight = (async () => {
    try {
      const { runAndPublishEarlyMomentum } = await import('./earlyMomentum')
      const out = await runAndPublishEarlyMomentum()
      earlyMomLastAt = Date.now()
      log.ok('PUBLIC-SNAP', `early-momentum: ${out.total} candidates (${out.tierCounts.EARLY} EARLY · ${out.tierCounts.WAVE_2} WAVE_2 · ${out.tierCounts.CONFIRMED} CONFIRMED)`)
    } catch (e) {
      log.warn('PUBLIC-SNAP', `early-momentum async: ${(e as Error).message}`)
    } finally {
      earlyMomInflight = null
    }
  })()
}

// NSE Bulk Deals tracker — the actual smart-money footprint feed per
// user directive ("there has to be some footprint of smart money...
// we have to identify this ahead of their taking move"). Free, daily
// EOD feed from NSE with buyer/seller names visible. Throttled 60-min
// (NSE updates once per session).
let bulkInflight: Promise<void> | null = null
let bulkLastAt = 0
const BULK_MIN_MS = 60 * 60_000

async function triggerBulkDealsScan(): Promise<void> {
  if (bulkInflight) return bulkInflight
  if (Date.now() - bulkLastAt < BULK_MIN_MS) return
  bulkInflight = (async () => {
    const startedAt = new Date().toISOString()
    try {
      const { fetchTodaysBulkDeals, aggregateBySymbol } = await import('../data/nseBulkDeals')
      const deals = await fetchTodaysBulkDeals()
      const bySymbol = aggregateBySymbol(deals)
      const out = {
        generatedAt: startedAt,
        totalDeals: deals.length,
        superstarDeals: deals.filter(d => d.category === 'SUPERSTAR').length,
        institutionDeals: deals.filter(d => d.category === 'INSTITUTION').length,
        strongAccumulationCount: bySymbol.filter(s => s.signal === 'STRONG_ACCUMULATION').length,
        strongDistributionCount: bySymbol.filter(s => s.signal === 'STRONG_DISTRIBUTION').length,
        rows: bySymbol.slice(0, 100),
        rawDeals: deals.slice(0, 200),
      }
      await fs.writeFile(path.join(SNAP_DIR, 'bulk-deals.json'), JSON.stringify(out, null, 2))
      bulkLastAt = Date.now()
      log.ok('PUBLIC-SNAP', `bulk-deals: ${deals.length} deals · ${out.strongAccumulationCount} strong-accum · ${out.strongDistributionCount} strong-dist`)
    } catch (e) {
      log.warn('PUBLIC-SNAP', `bulk-deals async: ${(e as Error).message}`)
    } finally {
      bulkInflight = null
    }
  })()
}

// Miss-analyzer — cross-references today's 5%+ gainers vs every scanner
// to surface what we missed and WHY. Auto-tune feedback loop for the
// daily self-improve cron. Throttled to 1× per 60 min (heavy: ~500
// candle fetches).
let missInflight: Promise<void> | null = null
let missLastAt = 0
const MISS_MIN_MS = 60 * 60_000

async function triggerMissAnalysis(): Promise<void> {
  if (missInflight) return missInflight
  if (Date.now() - missLastAt < MISS_MIN_MS) return
  missInflight = (async () => {
    try {
      const { runMissAnalysis } = await import('./missAnalyzer')
      const m = await runMissAnalysis()
      await fs.writeFile(path.join(SNAP_DIR, 'miss-analysis.json'), JSON.stringify(m, null, 2))
      missLastAt = Date.now()
      log.ok('PUBLIC-SNAP', `miss-analysis: caught ${m.caughtCount}/${m.totalGainers} (${(m.catchRate * 100).toFixed(1)}%)`)
    } catch (e) {
      log.warn('PUBLIC-SNAP', `miss-analysis async: ${(e as Error).message}`)
    } finally {
      missInflight = null
    }
  })()
}

// Accumulation/Distribution divergence scan — finds names where smart-money
// flow (OBV / A/D / CMF) DIVERGES from price action. Pre-move signal.
// Async/throttled (same pattern as fno scan), min 25 min between runs.
let adInflight: Promise<void> | null = null
let adLastScanAt = 0
const AD_MIN_INTERVAL_MS = 25 * 60_000

async function triggerAdDivergenceScan(): Promise<void> {
  if (adInflight) return adInflight
  if (Date.now() - adLastScanAt < AD_MIN_INTERVAL_MS) return
  adInflight = (async () => {
    const startedAt = new Date().toISOString()
    try {
      const { scanAccumulationDistribution } = await import('./accumulationDistribution')
      const { resolveUniverse } = await import('../screeners/universe')
      const symbols = await resolveUniverse('CNX500')
      const rows = await scanAccumulationDistribution(symbols)
      const out = {
        generatedAt: startedAt,
        universe: 'CNX500',
        universeSize: symbols.length,
        total: rows.length,
        accumulationCount: rows.filter(r => r.side === 'ACCUMULATION').length,
        distributionCount: rows.filter(r => r.side === 'DISTRIBUTION').length,
        rows,
      }
      await fs.writeFile(path.join(SNAP_DIR, 'ad-divergence.json'), JSON.stringify(out, null, 2))
      adLastScanAt = Date.now()
      log.ok('PUBLIC-SNAP', `ad-divergence: ${rows.length} picks · ${out.accumulationCount} accum · ${out.distributionCount} dist`)
    } catch (e) {
      log.warn('PUBLIC-SNAP', `ad-divergence async: ${(e as Error).message}`)
    } finally {
      adInflight = null
    }
  })()
}

// Old-WeeklyPick comparison scan — async/throttled. Min 25 min between
// scans. Runs the SAME engine with preRankMode='momentum-old' which
// restores the pre-4fca35e momentum-chasing prerank (rank = |mom5|×0.6 +
// volBurst×4) and removes the freshness-reject so the user can compare
// against current pre-breakout output side-by-side.
let oldWpInflight: Promise<void> | null = null
let oldWpLastScanAt = 0
const OLD_WP_MIN_INTERVAL_MS = 25 * 60_000

async function triggerOldWeeklyScan(): Promise<void> {
  if (oldWpInflight) return oldWpInflight
  if (Date.now() - oldWpLastScanAt < OLD_WP_MIN_INTERVAL_MS) return
  oldWpInflight = (async () => {
    const startedAt = new Date().toISOString()
    try {
      const { runWeeklyPick } = await import('./weeklyManagerPick')
      // CNX500 keeps the scan under ~4 min during market hours; matches
      // the universe used by the regular intraday-live cron so the two
      // tabs are comparing the same name pool with different prerank.
      const pick = await runWeeklyPick('CNX500', { preRankMode: 'momentum-old' })

      // Dedup by symbol — never show a stock twice in the same tab.
      // Pick the highest-conviction row per symbol; tie-break by recency.
      const bySym = new Map<string, any>()
      for (const r of pick.rows ?? []) {
        const prev = bySym.get(r.symbol)
        if (!prev || (r.conviction ?? 0) > (prev.conviction ?? 0)) {
          bySym.set(r.symbol, r)
        }
      }
      const dedupedRows = Array.from(bySym.values())
        .sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0))
      await enrichShareholdingNotes(dedupedRows)
      const out = {
        generatedAt: startedAt,
        weekOf: pick.weekOf,
        regime: pick.regime,
        universe: 'CNX500',
        preRankMode: 'momentum-old',
        rowCount: dedupedRows.length,
        rows: dedupedRows,
      }
      await fs.writeFile(path.join(SNAP_DIR, 'old-weekly-pick.json'), JSON.stringify(out, null, 2))
      oldWpLastScanAt = Date.now()
      log.ok('PUBLIC-SNAP', `old-weekly-pick: ${dedupedRows.length} unique picks written (async, momentum-old)`)
    } catch (e) {
      log.warn('PUBLIC-SNAP', `old-weekly-pick async: ${(e as Error).message}`)
    } finally {
      oldWpInflight = null
    }
  })()
}

async function triggerFnoScan(): Promise<void> {
  if (fnoScanInflight) return fnoScanInflight
  if (Date.now() - fnoLastScanAt < FNO_SCAN_MIN_INTERVAL_MS) return
  fnoScanInflight = (async () => {
    const startedAt = new Date().toISOString()
    try {
      const { scanFnoFutures } = await import('./fnoFuturesScanner')
      const rows = await scanFnoFutures({ limit: 25 })
      const out = {
        generatedAt: startedAt,
        universeSize: 211,
        total: rows.length,
        highConvCount: rows.filter(r => r.confidence === 'HIGH').length,
        medConvCount: rows.filter(r => r.confidence === 'MED').length,
        rows,
      }
      await fs.writeFile(path.join(SNAP_DIR, 'fno-futures.json'), JSON.stringify(out, null, 2))
      fnoLastScanAt = Date.now()
      log.ok('PUBLIC-SNAP', `fno-futures: ${rows.length} picks written (async)`)
    } catch (e) {
      log.warn('PUBLIC-SNAP', `fno-futures async: ${(e as Error).message}`)
    } finally {
      fnoScanInflight = null
    }
  })()
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
      // 2026-06-14: User flagged "I see SL hit trades as it is" — closed
      // trades (T1/T2/T3 booked or SL hit) should not pollute the live
      // Weekly Pick feed. They live in 🗄️ Archive tab. Live feed shows
      // ONLY actionable status (PENDING waiting entry, ACTIVE in-trade).
      const HIDE = new Set([
        'SUPERSEDED', 'EXPIRED', 'INVALIDATED',
        'T1_HIT', 'T2_HIT', 'T3_HIT',     // already booked
        'SL_HIT',                          // closed loss
      ])
      const deduped = Array.from(bestPerSym.values()).filter(e => !HIDE.has(e.status))
      // 2026-06-24: Merge fresh scan candidates (conv ≥ 65) that aren't yet
      // in lifecycle. Lifecycle floor (conv ≥ 70 + source ≠ WATCHLIST) protects
      // the accuracy denominator; public feed surfaces MORE quality setups so
      // users see real flow, not just a near-empty live book.
      const lcSymbols = new Set(deduped.map(e => e.symbol))
      const freshExtras = (opts.weeklyPick.rows ?? [])
        .filter((r: any) => (r.conviction ?? 0) >= 65 && !lcSymbols.has(r.symbol))
        .sort((a: any, b: any) => (b.conviction ?? 0) - (a.conviction ?? 0))
        .slice(0, Math.max(0, 50 - deduped.length))
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
      // Append the fresh-scan extras using the public projection so the
      // shape matches lifecycle rows. lifecycleStatus = 'FRESH' marks them
      // as not-yet-in-lifecycle (no statusChangedAt, no lifecycleId).
      if (freshExtras.length) {
        const projected = publicWeeklyRows(freshExtras).map(p => ({
          ...p, lifecycleStatus: 'FRESH', firstSeenAt: ts, lastSeenAt: ts,
        }))
        wRows = [...wRows, ...projected]
      }
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
          // 2026-06-03: expiry surfaced per-row so the OIFlowCard can show
          // "Expiry 8-Jun (5d)" and the user can verify it's not stale.
          expiry: (a as any).expiry ?? null,
          daysToExpiry: (a as any).daysToExpiry ?? null,
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
    // 2026-06-03: hard guard — if the analysis reports an expired expiry
    // (daysToExpiry < 0), drop the rows. Better to show "no data" than to
    // mislead the user with a dead chain. Per user directive.
    const expiredAnalysis: string[] = []
    for (const [u, a] of Object.entries(oi)) {
      if (a && typeof (a as any).daysToExpiry === 'number' && (a as any).daysToExpiry < 0) {
        expiredAnalysis.push(`${u}@${(a as any).expiry}`)
      }
    }
    if (expiredAnalysis.length) {
      log.warn('PUBLIC-SNAP', `oi-buildup: dropping expired chain(s): ${expiredAnalysis.join(', ')}`)
      // wipe rows whose underlying is in the expired set
      for (let i = buildupRows.length - 1; i >= 0; i--) {
        const r = buildupRows[i]
        if (expiredAnalysis.some(x => x.startsWith(r.underlying + '@'))) buildupRows.splice(i, 1)
      }
    }
    const summary = Object.entries(oi).filter(([, a]) => a).map(([u, a]: any) => ({
      underlying: u,
      expiry: a.expiry ?? null,
      daysToExpiry: a.daysToExpiry ?? null,
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

  // 6.6b Multi-strike OI surge — catches simultaneous CE 23300/23400/23500
  // accumulation that single-strike AGGR_CE_BUY misses. User's 12-Jun
  // missed-move query is exactly this pattern.
  try {
    const { detectMultiStrikeSurges } = await import('./multiStrikeOiSurge')
    const surges = await detectMultiStrikeSurges()
    const out = {
      generatedAt: ts,
      total: surges.length,
      bullishCount: surges.filter(s => s.bias === 'BULLISH').length,
      bearishCount: surges.filter(s => s.bias === 'BEARISH').length,
      rows: surges,
    }
    await fs.writeFile(path.join(SNAP_DIR, 'multi-strike-oi.json'), JSON.stringify(out, null, 2))
    files.push('multi-strike-oi.json')
  } catch (e) {
    log.warn('PUBLIC-SNAP', `multi-strike-oi: ${(e as Error).message}`)
  }

  // 6.6c Archive snapshot — EVERY signal lifecycle event over last 365 days.
  // 2026-06-24: per user audit ("you are removing all past signals... in
  // archive tab with date filter we should log EACH AND EVERY signal, target
  // hit, SL hit, or changed view, this will help in improvise").
  // Includes: T1/T2/T3 hits, SL hits, SUPERSEDED, EXPIRED, INVALIDATED.
  // UI filters by date — no server-side deletion.
  try {
    const histRaw = await fs.readFile(path.join(SNAP_DIR, 'signals-history.json'), 'utf8').catch(() => null)
    if (histRaw) {
      const hist = JSON.parse(histRaw)
      const cutoff = Date.now() - 365 * 86400_000
      // Every TERMINAL status — anything that's no longer ACTIVE/PENDING.
      const ARCHIVE_STATUS = new Set([
        'SUPERSEDED', 'EXPIRED', 'SL_HIT', 'INVALIDATED',
        'T1_HIT', 'T2_HIT', 'T3_HIT',
      ])
      const archive = (hist.signals ?? []).filter((s: any) => {
        if (!ARCHIVE_STATUS.has(s.status)) return false
        const changedAt = s.statusChangedAt ?? s.generatedAt
        const ts = changedAt ? new Date(changedAt).getTime() : 0
        return ts >= cutoff
      })
      // Strict dedup by (symbol, direction, status, statusChangedAt) — keep
      // a row for EACH lifecycle transition so the user sees the full audit.
      const seen = new Set<string>()
      const deduped = archive.filter((s: any) => {
        const k = `${s.symbol}|${s.direction}|${s.status}|${s.statusChangedAt ?? s.generatedAt ?? ''}`
        if (seen.has(k)) return false
        seen.add(k); return true
      }).sort((a: any, b: any) => {
        const ta = new Date(a.statusChangedAt ?? a.generatedAt ?? 0).getTime()
        const tb = new Date(b.statusChangedAt ?? b.generatedAt ?? 0).getTime()
        return tb - ta
      })
      const byStatus: Record<string, number> = {}
      for (const s of deduped) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1
      const out = {
        generatedAt: ts,
        windowDays: 365,
        total: deduped.length,
        byStatus,
        rows: deduped.slice(0, 2000),
      }
      await fs.writeFile(path.join(SNAP_DIR, 'archive.json'), JSON.stringify(out, null, 2))
      files.push('archive.json')
    }
  } catch (e) {
    log.warn('PUBLIC-SNAP', `archive: ${(e as Error).message}`)
  }

  // 6.7 F&O Stock-Futures pre-breakout scan (2026-06-03)
  // Heavy scan over ~211 underlyings — DECOUPLED from the synchronous
  // publish so the rest of the snapshot doesn't block. Fires async, writes
  // fno-futures.json on its own when done. The next publish already sees
  // the file. Throttled — only one scan in flight at a time.
  triggerFnoScan().catch(() => { /* logged inside */ })
  triggerOldWeeklyScan().catch(() => { /* logged inside */ })
  triggerAdDivergenceScan().catch(() => { /* logged inside */ })
  triggerMissAnalysis().catch(() => { /* logged inside */ })
  triggerGainerPostmortem().catch(() => { /* logged inside */ })
  triggerSuperstarScan().catch(() => { /* logged inside */ })
  triggerBulkDealsScan().catch(() => { /* logged inside */ })
  triggerEarlyMomentumScan().catch(() => { /* logged inside */ })

  // 6.8 Sector Rotation — 12 NIFTY sectoral indices ranked by relative
  // strength. Synchronous (only 12 candle fetches, fast).
  try {
    // Sector-rotation: reuses the existing `runSectorRotationScan` engine
    // (stock-basket based — 14 baskets) and remaps the rich output to a
    // simpler public schema. NIFTY sectoral index symbols (CNXBANK etc)
    // don't resolve through the unified data layer, so we use the
    // engine's stock-basket aggregation which is already proven.
    const { runSectorRotationScan } = await import('./sectorRotation')
    const snap = await Promise.race<any>([
      runSectorRotationScan(),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error('sector-rotation timeout')), 120_000)),
    ])
    const rows = (snap?.baskets ?? []).map((b: any) => {
      const trend = b.rotatingIn ? 'LEADING' :
        b.rotatingOut ? 'LAGGING' :
        (b.relStr5d > 0 && b.relStr20d > 0) ? 'IMPROVING' :
        (b.relStr5d < 0 && b.relStr20d < 0) ? 'WEAKENING' : 'NEUTRAL'
      const rotationScore = +(b.relStr20d * 0.5 + b.relStr5d * 0.3 + (b.pctAboveEma21 - 50) / 5).toFixed(1)
      return {
        index: b.key, label: b.label,
        ltp: 0,    // basket has no single LTP
        ret5d: b.ret5d, ret20d: b.ret20d, ret60d: 0,
        relStr5d: b.relStr5d, relStr20d: b.relStr20d,
        pctAboveEma21: b.pctAboveEma21, pctAboveEma50: b.pctAboveEma50,
        volRatio5_20: b.volRatio,
        rotationScore, trend,
        reasons: [
          `20d ${b.ret20d >= 0 ? '+' : ''}${b.ret20d.toFixed(1)}% (vs NIFTY ${b.relStr20d >= 0 ? '+' : ''}${b.relStr20d.toFixed(1)}%)`,
          `5d ${b.ret5d >= 0 ? '+' : ''}${b.ret5d.toFixed(1)}% (vs NIFTY ${b.relStr5d >= 0 ? '+' : ''}${b.relStr5d.toFixed(1)}%)`,
          `${b.pctAboveEma21.toFixed(0)}% above EMA21`,
          `vol ${b.volRatio.toFixed(2)}× 30d`,
        ],
        topMovers: b.topMovers ?? [],
        note: b.note,
      }
    }).sort((a: any, b: any) => b.rotationScore - a.rotationScore)
    const out = {
      generatedAt: ts,
      niftyRet5d: snap?.niftyRet5d ?? 0,
      niftyRet20d: snap?.niftyRet20d ?? 0,
      total: rows.length,
      leading: rows.filter((s: any) => s.trend === 'LEADING').map((s: any) => s.label),
      lagging: rows.filter((s: any) => s.trend === 'LAGGING').map((s: any) => s.label),
      oneLineSummary: snap?.oneLineSummary ?? '',
      rows,
    }
    await fs.writeFile(path.join(SNAP_DIR, 'sector-rotation.json'), JSON.stringify(out, null, 2))
    files.push('sector-rotation.json')
  } catch (e) {
    log.warn('PUBLIC-SNAP', `sector-rotation: ${(e as Error).message}`)
  }

  // 6.9 Cross-Engine Confluence — aggregates Weekly/Pre-Move/F&O Futures/
  // Daily/Old-Weekly snapshots into a single ULTRA list. Pure file read,
  // no API calls. Runs LAST so all upstream snapshots above are fresh.
  try {
    const { aggregateConfluence } = await import('./crossEngineConfluence')
    const conf = await aggregateConfluence()
    await fs.writeFile(path.join(SNAP_DIR, 'cross-confluence.json'), JSON.stringify(conf, null, 2))
    files.push('cross-confluence.json')
  } catch (e) {
    log.warn('PUBLIC-SNAP', `cross-confluence: ${(e as Error).message}`)
  }

  // 6.10 PRO Edge — strictest signal feed. Stacks: confluence ≥ 2 engines AND
  // smart-money same-side AND sector tailwind aligned AND conviction ≥ 85.
  // Targets 0-10 names/day. Reads existing snapshots above; zero new API calls.
  try {
    const { aggregateProEdge } = await import('./proEdge')
    const pro = await aggregateProEdge({ minConviction: 85 })
    await fs.writeFile(path.join(SNAP_DIR, 'pro-edge.json'), JSON.stringify(pro, null, 2))
    files.push('pro-edge.json')
  } catch (e) {
    log.warn('PUBLIC-SNAP', `pro-edge: ${(e as Error).message}`)
  }

  // 6.10b SL-Trap Detector — reads lifecycle SL_HITs + Smart Money snapshot
  // and tags suspected liquidity grabs (MOSCHIP / MARKSANS / FINPIPE-style).
  // Effective WR (with confirmed traps as wins) shown on PRO Edge banner.
  try {
    const { detectSlTraps } = await import('./slTrapDetector')
    const trap = await detectSlTraps()
    await fs.writeFile(path.join(SNAP_DIR, 'sl-trap-alerts.json'), JSON.stringify(trap, null, 2))
    files.push('sl-trap-alerts.json')
  } catch (e) {
    log.warn('PUBLIC-SNAP', `sl-trap-alerts: ${(e as Error).message}`)
  }

  // 6.11 NIFTY Options Pro — strict subset of the existing options snapshot.
  // Grade A only + score ≥ 9 + dedup by instrument. Live 30d WR from accuracy.
  try {
    const rawOpts = await fs.readFile(path.join(SNAP_DIR, 'options.json'), 'utf8').catch(() => null)
    let optionsLiveWr: number | null = null
    try {
      const accRaw = await fs.readFile(path.join(SNAP_DIR, 'accuracy.json'), 'utf8').catch(() => null)
      if (accRaw) {
        const acc = JSON.parse(accRaw)
        const opt = acc?.bySource?.OPTIONS
        if (opt?.winRate != null) {
          optionsLiveWr = opt.winRate > 1 ? opt.winRate / 100 : opt.winRate
        }
      }
    } catch { /* ignore */ }
    if (rawOpts) {
      const opts = JSON.parse(rawOpts)
      const all: any[] = opts.rows ?? []
      const elite = all.filter(r => (r.score ?? 0) >= 9 && r.grade === 'A')
      // Strict dedup by instrument symbol
      const seen = new Set<string>()
      const deduped = elite.filter(r => {
        const k = r.instrument || r.symbol
        if (seen.has(k)) return false
        seen.add(k); return true
      })
      const out = {
        generatedAt: ts,
        totalRaw: all.length,
        eliteCount: deduped.length,
        liveWinRate: optionsLiveWr,
        winRateWindowDays: 30,
        rows: deduped,
      }
      await fs.writeFile(path.join(SNAP_DIR, 'options-pro.json'), JSON.stringify(out, null, 2))
      files.push('options-pro.json')
    }
  } catch (e) {
    log.warn('PUBLIC-SNAP', `options-pro: ${(e as Error).message}`)
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
