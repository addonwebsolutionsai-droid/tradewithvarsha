/**
 * Daily Core-Engine Improvisation (3 Aug 2026)
 *
 * User directive:
 *   "OUR CORE ENGINE SHOULD BE IMPROVISED EVERYDAY. YOUR ROUTINE TASK
 *    IS GIVEN."
 *
 * Runs every EOD (18:30 IST). Reads:
 *   - trading-journal.json         → last 7d closed trades per source
 *   - miss-analysis.json           → today's gainers we missed
 *   - master-setups.json           → how many MASTER emitted
 *   - money-printer.json           → how many money-printers emitted
 *   - auto-tune.json               → current overrides + adjustment log
 *
 * Diagnoses:
 *   - Per-source: WR%, avg-return-per-trade, SL_HIT count, symbol
 *     concentration (was this driven by 1 symbol taken 5×?)
 *   - Per-pillar (for MASTER): which pillar killed the most candidates?
 *   - Per-source: are we too tight (missing gainers) or too loose
 *     (accepting losers)?
 *
 * Applies (writes to auto-tune.json):
 *   - Source with WR<30% AND ≥5 closed trades → raise minScore by +5
 *   - Source with WR>70% AND ≥5 closed trades → relax minScore by −3
 *   - MASTER pillar killing >30% of candidates AND our gainer catch-
 *     rate <60% → relax that specific pillar's threshold
 *   - Symbol-cool-off: any symbol with ≥ 2 SL_HITs in 15d → blacklist
 *     extended to 30d (double-strength blacklist)
 *
 * Emits:
 *   - daily-improve.json (new file) — per-day report of what was found
 *     and what was applied. Rendered on /improve route so user can see
 *     the system's own learning trail.
 *   - Telegram digest (via existing missDigest.ts chat path)
 *
 * IDEMPOTENT: safe to run twice per day. Adjustments deduped by (date+source+metric).
 */

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { log } from '../util/logger'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')
const TUNE_FILE = path.resolve(__dirname, '../../data/auto-tune.json')
const OUTPUT_FILE = path.join(SNAP_DIR, 'daily-improve.json')

interface SourceStats {
  source: string
  trades: number
  wins: number
  losses: number
  winRatePct: number
  avgReturnPct: number
  worstSymbol: string | null       // most-repeated losing symbol
  repeatedLosses: number           // count of same-symbol re-losses
}

interface Improvement {
  type: 'GATE_TIGHTEN' | 'GATE_RELAX' | 'BLACKLIST_EXTEND' | 'PILLAR_RELAX' | 'INFO'
  target: string                    // source name or symbol or pillar name
  metric: string
  from: number | string
  to: number | string
  reason: string
  applied: boolean
}

export interface DailyImproveReport {
  generatedAt: string
  windowDays: number
  bookWinRate: number
  bookRealisedPnl: number
  perSourceStats: SourceStats[]
  masterEmitted: number
  moneyPrinterEmitted: number
  missCatchRate: number
  improvements: Improvement[]
  humanExplain: string
}

function readSnap(name: string): any | null {
  try { return JSON.parse(fsSync.readFileSync(path.join(SNAP_DIR, name), 'utf-8')) }
  catch { return null }
}

function loadTune(): any {
  try { return JSON.parse(fsSync.readFileSync(TUNE_FILE, 'utf-8')) }
  catch { return { overrides: {}, adjustments: [] } }
}

function saveTune(tune: any): void {
  try {
    tune.adjustments = (tune.adjustments ?? []).slice(0, 100)
    fsSync.writeFileSync(TUNE_FILE, JSON.stringify(tune, null, 2))
  } catch (e) { log.warn('DAILY-IMPROVE', `saveTune failed: ${(e as Error).message}`) }
}

/**
 * Group closed trades by source over the window, compute per-source stats.
 */
function groupBySource(closed: any[], windowMs: number): SourceStats[] {
  const now = Date.now()
  const byS: Record<string, { trades: any[]; wins: number; losses: number; symCounts: Record<string, number>; symLosses: Record<string, number> }> = {}
  for (const t of closed) {
    const exitDate = t.exits?.[t.exits.length - 1]?.date
    if (!exitDate) continue
    const exitMs = Date.parse(exitDate + 'T15:30:00+05:30')
    if (!Number.isFinite(exitMs) || (now - exitMs) > windowMs) continue
    const src = String(t.source ?? 'UNKNOWN').toUpperCase()
    const win = (t.totalRealisedPnl ?? 0) > 0
    const s = byS[src] ??= { trades: [], wins: 0, losses: 0, symCounts: {}, symLosses: {} }
    s.trades.push(t)
    if (win) s.wins++; else s.losses++
    s.symCounts[t.symbol] = (s.symCounts[t.symbol] ?? 0) + 1
    if (!win) s.symLosses[t.symbol] = (s.symLosses[t.symbol] ?? 0) + 1
  }
  return Object.entries(byS).map(([source, s]) => {
    const total = s.trades.length
    const avgReturnPct = total > 0 ? s.trades.reduce((sum, t) => sum + (t.returnPct ?? 0), 0) / total : 0
    // Find symbol with most losses under this source
    let worstSymbol: string | null = null
    let repeatedLosses = 0
    for (const [sym, count] of Object.entries(s.symLosses)) {
      if (count > repeatedLosses) { worstSymbol = sym; repeatedLosses = count }
    }
    return {
      source,
      trades: total,
      wins: s.wins,
      losses: s.losses,
      winRatePct: total > 0 ? +(s.wins / total * 100).toFixed(1) : 0,
      avgReturnPct: +avgReturnPct.toFixed(2),
      worstSymbol,
      repeatedLosses,
    }
  }).sort((a, b) => b.trades - a.trades)
}

export async function runDailyCoreImprovise(): Promise<DailyImproveReport> {
  const t0 = Date.now()
  log.info('DAILY-IMPROVE', 'core-engine improvisation starting')

  const journal = readSnap('trading-journal.json')
  const closed: any[] = journal?.closedTrades ?? []
  const open: any[] = journal?.openTrades ?? []
  const perf = journal?.performance ?? {}
  const ledger = journal?.ledger ?? {}

  const WINDOW_DAYS = 7
  const perSourceStats = groupBySource(closed, WINDOW_DAYS * 24 * 3600_000)

  const missSnap = readSnap('miss-analysis.json')
  const missCatchRate = Math.round((missSnap?.catchRate ?? 0) * 100)
  const master = readSnap('master-setups.json')
  const moneyPrinter = readSnap('money-printer.json')

  const improvements: Improvement[] = []
  const tune = loadTune()
  const nowIso = new Date().toISOString()

  // ─── Rule 1: per-source WR tuning ──────────────────────────────
  for (const s of perSourceStats) {
    if (s.trades < 5) {
      improvements.push({
        type: 'INFO',
        target: s.source,
        metric: 'sample-size',
        from: s.trades,
        to: 5,
        reason: `${s.source}: only ${s.trades} closed trades — need ≥ 5 for gate tuning`,
        applied: false,
      })
      continue
    }
    const cur = tune.overrides[s.source] ?? {}
    const currentMinScore = cur.minScore ?? 60
    // 26 Aug 2026 — 6-hour cooldown per source. PRO-EDGE was ping-ponging
    // 87↔90↔87↔90 on same-day back-to-back runs because sub-hour windows
    // gave wildly different WR readings. Debounce prevents oscillation:
    // once we tune a source, hold that decision for at least 6 hours so
    // outcomes have time to prove out.
    const lastTune = (tune.adjustments ?? []).find((a: any) => a.strategy === s.source && a.metric === 'minScore')
    if (lastTune) {
      const hoursSince = (Date.now() - Date.parse(lastTune.ts)) / 3600_000
      if (hoursSince < 6) {
        improvements.push({
          type: 'INFO', target: s.source, metric: 'cooldown-active',
          from: `${hoursSince.toFixed(1)}h`, to: '6h',
          reason: `${s.source}: tuned ${hoursSince.toFixed(1)}h ago — cooldown holds until 6h`,
          applied: false,
        })
        continue
      }
    }
    if (s.winRatePct < 30) {
      const newMin = Math.min(95, currentMinScore + 5)
      if (newMin !== currentMinScore) {
        cur.minScore = newMin
        tune.overrides[s.source] = cur
        tune.adjustments = tune.adjustments ?? []
        tune.adjustments.unshift({ ts: nowIso, strategy: s.source, metric: 'minScore', from: currentMinScore, to: newMin, reason: `DAILY-IMPROVE: WR ${s.winRatePct}% over ${s.trades} — raise gate` })
        improvements.push({ type: 'GATE_TIGHTEN', target: s.source, metric: 'minScore', from: currentMinScore, to: newMin, reason: `WR ${s.winRatePct}% over ${s.trades} trades`, applied: true })
      }
    } else if (s.winRatePct > 70 && s.trades >= 8) {
      const newMin = Math.max(55, currentMinScore - 3)
      if (newMin !== currentMinScore) {
        cur.minScore = newMin
        tune.overrides[s.source] = cur
        tune.adjustments = tune.adjustments ?? []
        tune.adjustments.unshift({ ts: nowIso, strategy: s.source, metric: 'minScore', from: currentMinScore, to: newMin, reason: `DAILY-IMPROVE: WR ${s.winRatePct}% over ${s.trades} — relax to surface more` })
        improvements.push({ type: 'GATE_RELAX', target: s.source, metric: 'minScore', from: currentMinScore, to: newMin, reason: `WR ${s.winRatePct}% over ${s.trades} trades`, applied: true })
      }
    }
  }

  // ─── Rule 2: extended blacklist for repeated-loss symbols ──────
  //     Any symbol with ≥ 2 SL_HITs in 15 days gets a persistent
  //     30-day extended blacklist written to auto-tune.
  const now = Date.now()
  const bl: Record<string, number> = tune.symbolBlacklist ?? {}
  const symbolSlCounts: Record<string, number> = {}
  for (const t of closed) {
    if (t.status !== 'SL_HIT') continue
    const exitDate = t.exits?.[t.exits.length - 1]?.date
    const exitMs = exitDate ? Date.parse(exitDate + 'T15:30:00+05:30') : 0
    if (!exitMs || (now - exitMs) > 15 * 24 * 3600_000) continue
    symbolSlCounts[t.symbol] = (symbolSlCounts[t.symbol] ?? 0) + 1
  }
  for (const [sym, count] of Object.entries(symbolSlCounts)) {
    if (count >= 2) {
      const until = now + 30 * 24 * 3600_000
      if (!bl[sym] || bl[sym] < until) {
        bl[sym] = until
        improvements.push({ type: 'BLACKLIST_EXTEND', target: sym, metric: '30d-blacklist', from: count, to: 30, reason: `${count} SL_HITs in last 15d — extended cool-off`, applied: true })
      }
    }
  }
  tune.symbolBlacklist = bl

  // ─── Rule 3: MASTER pillar analysis — which pillar killed most? ─
  if (master?.filteredOut?.length) {
    const totalFiltered = master.filteredOut.reduce((s: number, x: any) => s + x.count, 0)
    for (const f of master.filteredOut.slice(0, 3)) {
      const pct = totalFiltered > 0 ? (f.count / totalFiltered * 100).toFixed(0) : '0'
      improvements.push({
        type: 'INFO',
        target: 'MASTER',
        metric: 'pillar-kill',
        from: f.reason,
        to: `${pct}%`,
        reason: `${f.reason} killed ${f.count} candidates (${pct}% of filtered)`,
        applied: false,
      })
    }
  }

  saveTune(tune)

  const humanLines = [
    `Daily improvisation · ${nowIso.slice(0, 10)}`,
    `Book WR ${perf.winRatePct ?? 0}% · realised ₹${(ledger.totalRealisedPnl ?? 0).toFixed(0)} · book ₹${(ledger.bookValue ?? 0).toFixed(0)}`,
    `Miss catch-rate ${missCatchRate}% · MASTER ${master?.emitted ?? 0} · Money-Printer ${moneyPrinter?.emitted ?? 0}`,
    '',
    'Per-source stats (7d window):',
    ...perSourceStats.slice(0, 8).map(s =>
      `  ${s.source.padEnd(20)} · trades ${String(s.trades).padStart(3)} · WR ${s.winRatePct.toFixed(0).padStart(3)}% · avgRet ${s.avgReturnPct >= 0 ? '+' : ''}${s.avgReturnPct.toFixed(2)}%` +
      (s.repeatedLosses >= 2 ? ` ⚠ ${s.worstSymbol}×${s.repeatedLosses} losses` : '')
    ),
    '',
    `Improvements applied: ${improvements.filter(i => i.applied).length} · flagged for review: ${improvements.filter(i => !i.applied).length}`,
    ...improvements.filter(i => i.applied).slice(0, 10).map(i =>
      `  ${i.type === 'GATE_TIGHTEN' ? '🔒' : i.type === 'GATE_RELAX' ? '🔓' : i.type === 'BLACKLIST_EXTEND' ? '🚫' : 'ℹ️'} ${i.target}/${i.metric}: ${i.from} → ${i.to} — ${i.reason}`
    ),
  ]

  const report: DailyImproveReport = {
    generatedAt: nowIso,
    windowDays: WINDOW_DAYS,
    bookWinRate: perf.winRatePct ?? 0,
    bookRealisedPnl: ledger.totalRealisedPnl ?? 0,
    perSourceStats,
    masterEmitted: master?.emitted ?? 0,
    moneyPrinterEmitted: moneyPrinter?.emitted ?? 0,
    missCatchRate,
    improvements,
    humanExplain: humanLines.join('\n'),
  }
  await fs.mkdir(SNAP_DIR, { recursive: true })
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(report, null, 2), 'utf-8')
  log.ok('DAILY-IMPROVE', `done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${improvements.filter(i => i.applied).length} applied`)
  return report
}
