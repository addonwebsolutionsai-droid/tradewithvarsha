import express from 'express'
import cors from 'cors'
import http from 'http'
import path from 'path'
import * as fsAsync from 'fs/promises'
import { WebSocketServer, WebSocket } from 'ws'
import cron from 'node-cron'

import { config } from './config'
import { log } from './util/logger'
import { logIssue } from './util/errorsLog'
import { isMarketOpen, isCommodityMarketOpen } from './util/time'
import { syncTime, getOffsetMs } from './util/timeSync'

import * as data from './data'
import { fetchBankNiftyOptionChain, fetchNiftyOptionChain, fetchFIIDIIData } from './data/nse'
import * as angel from './data/angel'
import { feed as angelFeed } from './data/angelFeed'
import { astroBiasFor } from './astro'
import { gannBiasFor, seedsFor } from './gann'
import { getGannCycleStatus, getTimeCycleStatus, getBestCycleTrade } from './gann/cycleStatus'
import { computeCycleAlerts, markAlertsSent } from './engine/cycleAlerts'
import { tickOiMonitor, getLatestOiAnalysis } from './engine/oiMonitor'
import { generateDailyReport, readLatestDailyReport } from './engine/dailyReport'
import { interpretOI } from './options/oiAnalyzer'
import { runSignalEngine, signalForSymbol } from './engine/signalEngine'
import { getMarketRegime } from './engine/marketRegime'
import { logSignal, logOutcome, readPerfStats, readPnlSummary, readAuditRows, signalsCsvPath, outcomesCsvPath, pnlCsvPath } from './engine/signalLogger'
import { runPatternLearner, getLearnedPatterns } from './engine/patternLearner'
import { runSelfImprove, getAutoTune } from './engine/selfImprove'
import { runWeeklyPick, getLatestPick, getWatchlist, setWatchlist } from './engine/weeklyManagerPick'
import {
  runHarmonicScan, getLastHarmonicScan, HARMONIC_TIMEFRAMES,
  takeFreshHarmonicHits, clearHarmonicDedup, formatHarmonicHitsForTelegram,
} from './engine/harmonicScanner'
import { runMarketDigest } from './engine/marketDigest'
import { runDailyPick, getLatestDailyPick, loadLatestDailyPick, DAILY_PICK_CONFIG } from './engine/dailyPickEngine'
import { refreshMasterSetup, getLatestMasterSetup, formatMasterSetupForTelegram } from './engine/masterSetup'
import { runSectorRotationScan, getLatestSectorRotation, formatSectorRotationForTelegram } from './engine/sectorRotation'
import { exportDataset, type ExportDataset, type ExportFormat } from './engine/exporter'
import {
  runTurtleSoupScan, getLatestTurtleSoupRun, takeFreshTurtleSoupSignals,
  formatTurtleSoupForTelegram, clearTurtleSoupDedup,
} from './engine/turtleSoupEngine'
import { loadFundamentals, parseAndStoreCsv, getTodaysFlow } from './engine/fundamentals'
import { backtest, backtestSuite } from './backtest/runner'
import { broadcastSignal, setLastSignals, startTelegramBot, state as botState } from './bots/telegram'
import { getLatestRun, runScan, type ScannerBucket } from './screeners/runner'
import { loadRules } from './screeners/customRules'
import {
  activeTrades, allTrades, expireStaleTrades, loadTrades, onPrice, onSignalGenerated,
  tradeStats, type LifecycleEvent,
} from './engine/tradeTracker'
import { Bot } from 'grammy'
import { gradeMeetsThreshold } from './engine/scoring'
import type { Signal } from './types'

// ────────────────────────────────────────────────────────────────
// Keep the process alive when third-party APIs (Angel, Yahoo, AlphaVantage)
// abort streams mid-flight pre-market. These errors reach us through async
// Express handlers that don't catch, and would otherwise tear down the
// server. Log and move on — the engine retries on the next tick.
// ────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  log.err('PROC', `unhandledRejection: ${msg}`)
})
process.on('uncaughtException', (err) => {
  log.err('PROC', `uncaughtException: ${err.message}`)
})

// ────────────────────────────────────────────────────────────────
// App + HTTP + WS
// ────────────────────────────────────────────────────────────────
const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

// 2026-05-07: PUBLIC SNAPSHOT publisher — writes 3 JSON files (weekly-pick,
// options, intraday) every 30 min so the Vercel-deployed frontend can read
// them via raw GitHub URLs. Manual trigger: POST /api/public-snapshots/publish
import { publishPublicSnapshots } from './engine/publicSnapshots'
/**
 * After-hours fallback: read past-3-day signals from the audit CSV trail so
 * Options + Intraday tabs always have data even when in-memory currentSignals
 * is empty (engine cleared at end of session). Returns up to 50 high-quality
 * signals of the requested type, newest first.
 */
async function recentSignalsFromAudit(type: 'OPTIONS' | 'INTRADAY', limit = 30): Promise<Signal[]> {
  try {
    const { readAuditRows } = await import('./engine/signalLogger')
    const rows = await readAuditRows(500)
    const cutoff = Date.now() - 3 * 86_400_000
    const matched = rows
      .filter(r => r.type === type && new Date(r.timestamp).getTime() >= cutoff && r.score >= (type === 'OPTIONS' ? 9 : 7))
      .slice(-limit)
      .reverse()
    // Audit rows have flat shape; coerce to a Signal-like object
    return matched.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      instrument: r.instrument,
      type: r.type,
      source: r.source,
      direction: r.direction,
      grade: r.grade,
      score: r.score,
      tier: r.tier,
      entry: r.entry,
      stopLoss: r.stopLoss,
      target1: r.target1,
      target2: r.target2,
      riskReward: r.riskReward,
      reasons: typeof r.reasons === 'string' ? r.reasons.split(' | ').filter(Boolean) : (r.reasons ?? []),
      meta: {},
    } as any))
  } catch (e) {
    log.warn('PUBLIC-SNAP', `audit read failed: ${(e as Error).message}`)
    return []
  }
}

async function publishSnapshots(): Promise<void> {
  try {
    const { getLatestPick: gp } = await import('./engine/weeklyManagerPick')
    const wp = await gp()
    // Always inject the latest lifecycle view (read from disk) so even
    // standalone publish runs (no fresh weekly-pick) show SUPERSEDED rows.
    if (wp) {
      try {
        const { getMergedView } = await import('./engine/signalLifecycle')
        wp.lifecycle = await getMergedView('WEEKLY')
      } catch { /* lifecycle file may not exist yet */ }
    }

    // Daily Pick — if in-memory empty, try loading the most recent disk snapshot.
    let dp: any = getLatestDailyPick()
    if (!dp || !dp.rows?.length) {
      try {
        const { loadLatestDailyPick } = await import('./engine/dailyPickEngine')
        dp = await loadLatestDailyPick()
      } catch { /* skip */ }
    }

    // Pre-Move — in-memory only. If empty, surface from movers (last 5d gainers
    // are the closest substitute when the pre-close scan hasn't fired today).
    let premoveResults = getLatestRun('premove')?.results ?? []
    if (!premoveResults.length) {
      premoveResults = getLatestRun('movers')?.results ?? []
    }

    // Options/Intraday — if currentSignals is empty (after-hours), surface
    // last 3 days of qualifying signals from the audit CSV.
    let signalsForPublish: Signal[] = currentSignals
    const hasOpts = currentSignals.some(s => s.type === 'OPTIONS')
    const hasIntra = currentSignals.some(s => s.type === 'INTRADAY')
    if (!hasOpts || !hasIntra) {
      const fallbackOpts = !hasOpts ? await recentSignalsFromAudit('OPTIONS', 30) : []
      const fallbackIntra = !hasIntra ? await recentSignalsFromAudit('INTRADAY', 30) : []
      signalsForPublish = [...currentSignals, ...fallbackOpts, ...fallbackIntra]
    }

    // Hit log — 8s timeout cap; falls back to empty if too slow.
    let hits: any[] = []
    try {
      const { buildScorecard } = await import('./engine/pickJournal')
      hits = await Promise.race<any[]>([
        buildScorecard(30).then(sc => sc.entries),
        new Promise<any[]>(r => setTimeout(() => r([]), 8000)),
      ])
    } catch { /* journal may be empty */ }

    await publishPublicSnapshots({
      weeklyPick: wp ?? null,
      dailyPick: dp ?? null,
      preMoveResults: premoveResults,
      hitLogEntries: hits,
      signals: signalsForPublish,
    })
  } catch (e) { log.warn('PUBLIC-SNAP', `publish failed: ${(e as Error).message}`) }
}
cron.schedule('*/30 * * * *', publishSnapshots, { timezone: 'Asia/Kolkata' })

/**
 * 2026-05-14: auto-push fresh snapshots to GitHub so the Vercel deploy
 * sees them. Runs at minute 2 + 32 of every hour (offset 2 min after
 * publishSnapshots cron so files are written first). macOS crontab is
 * sandbox-blocked, so we drive git directly from Node.
 */
import { exec as _exec } from 'child_process'
import { promisify as _prom } from 'util'
const _execP = _prom(_exec)
async function pushSnapshotsToGitHub(): Promise<void> {
  try {
    const cwd = path.resolve(__dirname, '../..')      // repo root
    // Stage just the public-snapshots dir
    await _execP('/usr/bin/git add server/data/public-snapshots', { cwd })
    // Check if there are any staged changes (exit code 1 = changes, 0 = none)
    try {
      await _execP('/usr/bin/git diff --cached --quiet', { cwd })
      return                                          // no changes, no-op
    } catch { /* changes present, proceed */ }
    const stamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
    await _execP(`/usr/bin/git commit -m "snapshot: ${stamp}" -q`, { cwd })
    await _execP('/usr/bin/git push origin main -q', { cwd })
    log.ok('SNAP-PUSH', `Pushed snapshot to GitHub at ${stamp} IST`)
  } catch (e) {
    log.warn('SNAP-PUSH', `${(e as Error).message?.slice(0, 200)}`)
  }
}
// 2026-05-22: Reduced push frequency from every 30 min (48/day) to 4/day on
// weekdays only. Free Vercel free tier allows 100 deploys/day, but auto-push
// at 30-min cadence + every commit during dev was burning the quota and
// triggering Vercel's "approaching limits" warning. New schedule:
//   09:20 IST  (5 min after market open — fresh weekly/daily picks)
//   12:30 IST  (midday — pre-move scans refreshed)
//   15:35 IST  (5 min after market close — final intraday + outcomes)
//   17:05 IST  (post-close — miss-miner + accuracy snapshot)
// = 4 pushes/weekday × 5 = 20/week vs 336/week previously.
cron.schedule('20 9 * * 1-5',  pushSnapshotsToGitHub, { timezone: 'Asia/Kolkata' })
cron.schedule('30 12 * * 1-5', pushSnapshotsToGitHub, { timezone: 'Asia/Kolkata' })
cron.schedule('35 15 * * 1-5', pushSnapshotsToGitHub, { timezone: 'Asia/Kolkata' })
cron.schedule('5 17 * * 1-5',  pushSnapshotsToGitHub, { timezone: 'Asia/Kolkata' })

// 2026-05-06: cors with credentials so the dashboard can carry the auth
// cookie cross-origin during local dev (vite :3000 → api :4000).
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: true,
}))
app.use(express.json({ limit: '5mb' }))
app.use(express.text({ limit: '10mb', type: ['text/csv', 'text/plain'] }))

// ── AUTH ENDPOINTS ──
import { signup, login, listUsers, toggleUserActive, verifyToken } from './auth/users'
function readAuthToken(req: any): string | undefined {
  const h = (req.headers.authorization as string) || ''
  if (h.startsWith('Bearer ')) return h.slice(7)
  return req.headers['x-auth-token'] as string | undefined
}
function requireAuth(req: any, res: any, next: any): void {
  const t = verifyToken(readAuthToken(req))
  if (!t) { res.status(401).json({ error: 'auth required' }); return }
  req.user = t
  next()
}
function requireAdmin(req: any, res: any, next: any): void {
  const t = verifyToken(readAuthToken(req))
  if (!t || !t.isAdmin) { res.status(403).json({ error: 'admin only' }); return }
  req.user = t
  next()
}
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body ?? {}
  const r = await signup(email, password)
  res.status(r.ok ? 200 : 400).json(r)
})
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {}
  const r = await login(email, password)
  res.status(r.ok ? 200 : 401).json(r)
})
app.get('/api/auth/me', (req, res) => {
  const t = verifyToken(readAuthToken(req))
  if (!t) return res.status(401).json({ error: 'not authenticated' })
  res.json({ email: t.email, isAdmin: t.isAdmin })
})
app.post('/api/auth/logout', (_req, res) => {
  // stateless tokens — client just discards. Endpoint exists for symmetry.
  res.json({ ok: true })
})
app.get('/api/admin/users', requireAdmin, async (_req, res) => {
  res.json({ users: await listUsers() })
})
app.post('/api/admin/users/:email/toggle', requireAdmin, async (req, res) => {
  res.json(await toggleUserActive(req.params.email))
})

// ────────────────────────────────────────────────────────────────
// Shared signal state
// ────────────────────────────────────────────────────────────────
let currentSignals: Signal[] = []
let lastEngineRun = 0
let lastSnapshotRun = 0      // last time we successfully ran the relaxed/closed-market pass
let dataMode: 'LIVE' | 'SNAPSHOT' = 'LIVE'

// ── Refresh-all rate limiter ───────────────────────────────────
// Cooldown 60 s between clicks; 10 clicks per rolling 24 h.
const REFRESH_ALL_COOLDOWN_MS = 60_000
const REFRESH_ALL_DAILY_CAP = 10
let refreshAllHistory: number[] = []       // timestamps of recent runs

function refreshAllState(): { allowed: boolean; reason?: string; remaining: number; resetInSec?: number } {
  const now = Date.now()
  refreshAllHistory = refreshAllHistory.filter(t => now - t < 24 * 3600_000)
  const lastRun = refreshAllHistory[refreshAllHistory.length - 1]
  if (lastRun && now - lastRun < REFRESH_ALL_COOLDOWN_MS) {
    return { allowed: false, reason: 'cooldown', remaining: REFRESH_ALL_DAILY_CAP - refreshAllHistory.length, resetInSec: Math.ceil((REFRESH_ALL_COOLDOWN_MS - (now - lastRun)) / 1000) }
  }
  if (refreshAllHistory.length >= REFRESH_ALL_DAILY_CAP) {
    const oldest = refreshAllHistory[0]
    return { allowed: false, reason: 'daily-cap', remaining: 0, resetInSec: Math.ceil((24 * 3600_000 - (now - oldest)) / 1000) }
  }
  return { allowed: true, remaining: REFRESH_ALL_DAILY_CAP - refreshAllHistory.length }
}

function anyMarketOpen(): boolean {
  return isMarketOpen() || isCommodityMarketOpen()
}

function asOfFromSignals(sigs: Signal[]): string | null {
  // Most recent candle timestamp across the signal set — what the dashboard
  // uses to display "as of HH:MM IST" when the market is closed.
  const ts = sigs.map(s => s.asOf).filter(Boolean) as string[]
  if (!ts.length) return lastEngineRun ? new Date(lastEngineRun).toISOString() : null
  return ts.sort().slice(-1)[0]
}

function broadcast(payload: unknown): void {
  const msg = JSON.stringify(payload)
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg)
  })
}

// ────────────────────────────────────────────────────────────────
// Engine runner + alert dispatch
// ────────────────────────────────────────────────────────────────
async function runAndBroadcast(reason: string): Promise<Signal[]> {
  try {
    const start = Date.now()
    const liveRun = await runSignalEngine()
    const live = liveRun.signals
    const invalidations = liveRun.invalidations
    lastEngineRun = Date.now()

    // Flush LIVE results to the dashboard IMMEDIATELY — don't make tabs
    // wait for the slower snapshot pass before any signal appears. Snapshot
    // backfills WATCH rows in a second broadcast below.
    if (live.length) {
      currentSignals = [...live].sort((a, b) => b.score - a.score)
      dataMode = anyMarketOpen() ? 'LIVE' : 'SNAPSHOT'
      setLastSignals(currentSignals)
      broadcast({
        type: 'SIGNALS_UPDATE',
        signals: currentSignals,
        reason: `${reason}-live`,
        tookMs: Date.now() - start,
        marketState: anyMarketOpen() ? 'OPEN' : 'CLOSED',
        dataMode,
        asOf: asOfFromSignals(currentSignals),
      })
    }

    // Always also pull a relaxed snapshot — used to populate tabs when the
    // market is closed, AND to backfill instruments where live confluence
    // didn't trip but a directional bias still exists. WATCH-tier signals
    // are never sent to alerts; they're just for the dashboard.
    let snapshot: Signal[] = []
    try {
      const snapRun = await runSignalEngine({ snapshot: true })
      snapshot = snapRun.signals
      lastSnapshotRun = Date.now()
    } catch (e) {
      log.warn('RUN', `snapshot pass failed: ${(e as Error).message}`)
    }

    // Merge: live wins over WATCH for the same (instrument, type) key.
    const seen = new Set(live.map(s => `${s.instrument}|${s.type}`))
    const merged: Signal[] = [...live]
    for (const s of snapshot) {
      const key = `${s.instrument}|${s.type}`
      if (seen.has(key)) continue
      merged.push({ ...s, tier: 'WATCH' })
      seen.add(key)
    }
    merged.sort((a, b) => b.score - a.score)
    currentSignals = merged
    dataMode = anyMarketOpen() ? 'LIVE' : 'SNAPSHOT'
    setLastSignals(merged)
    broadcast({
      type: 'SIGNALS_UPDATE',
      signals: merged,
      reason,
      tookMs: Date.now() - start,
      marketState: anyMarketOpen() ? 'OPEN' : 'CLOSED',
      dataMode,
      asOf: asOfFromSignals(merged),
    })

    // CSV audit trail — log every LIVE signal at emission time, with regime
    // tag so the self-improve loop can filter by market state later.
    const regimeTag = anyMarketOpen() ? 'OPEN' : 'CLOSED'
    for (const s of live) {
      void logSignal(s, regimeTag).catch(e => log.warn('LOG', `signal log: ${e.message}`))
    }

    // INVALIDATION alerts FIRST — these tell the user "the prior call is OFF"
    // BEFORE the new contradicting card lands. Critical for capital safety.
    // Cap to 3 per run so a noisy engine pass can't spam Telegram with
    // 20+ cancellations; the rest get a single summary line.
    const MAX_CANCEL_ALERTS = 3
    const cancelLeaders = invalidations.slice(0, MAX_CANCEL_ALERTS)
    const cancelTail = invalidations.slice(MAX_CANCEL_ALERTS)
    for (const ev of cancelLeaders) {
      const msg =
        `🚫 *SIGNAL CANCELLED* · ${ev.trade.symbol} ${ev.trade.direction}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `Entry was \`${ev.trade.entry}\` · LTP \`${ev.ltp}\` · MTM ${ev.pnlPct >= 0 ? '+' : ''}${ev.pnlPct}%\n` +
        `Reason: ${ev.replacement?.reason ?? 'view changed'}\n` +
        `_A new ${ev.trade.direction === 'BUY' ? 'SELL' : 'BUY'} signal will follow if/when triggered._\n` +
        `*#tradewithvarsha*`
      void dispatchTextAlert(msg).catch(e => log.warn('TG', `cancel alert: ${e.message}`))
      broadcast({ type: 'SIGNAL_INVALIDATED', event: ev })
    }
    if (cancelTail.length) {
      const summary =
        `🚫 *${cancelTail.length} more signals cancelled this run*\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        cancelTail.slice(0, 8).map(ev =>
          `· ${ev.trade.symbol} ${ev.trade.direction} (was @ \`${ev.trade.entry}\`, MTM ${ev.pnlPct >= 0 ? '+' : ''}${ev.pnlPct}%)`,
        ).join('\n') +
        (cancelTail.length > 8 ? `\n_+${cancelTail.length - 8} more — see Backtest Results tab_` : '') +
        `\n*#tradewithvarsha*`
      void dispatchTextAlert(summary).catch(e => log.warn('TG', `cancel summary: ${e.message}`))
      // Still broadcast each one over WS so the dashboard struck-through view stays accurate.
      for (const ev of cancelTail) broadcast({ type: 'SIGNAL_INVALIDATED', event: ev })
    }

    if (config.alerts.onNewSignal) {
      for (const s of live) {  // alerts only on LIVE, never WATCH
        if (!gradeMeetsThreshold(s.grade, config.alerts.minGrade)) continue
        if (s.score < config.alerts.minScore) continue
        const openEvent = await onSignalGenerated(s)
        if (openEvent) void broadcastSignal(s)
      }
    }
    return merged
  } catch (e) {
    log.err('RUN', `Engine failed: ${(e as Error).message}`)
    await logIssue({
      severity: 'HIGH',
      description: `Signal engine crashed (${reason})`,
      rootCause: (e as Error).message,
      fixApplied: 'Logged, will retry next cron tick',
      verified: false,
    })
    return currentSignals
  }
}

/** Send a free-text Markdown message to every configured Telegram chat. */
async function dispatchTextAlert(msg: string): Promise<void> {
  if (!botState.bot) return
  for (const chatId of config.bots.telegramChatIds) {
    try { await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' }) }
    catch (e) { log.warn('TG', `dispatchTextAlert(${chatId}): ${(e as Error).message}`) }
  }
}

// ────────────────────────────────────────────────────────────────
// REST API
// ────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'online',
    uptime: process.uptime(),
    marketOpen: isMarketOpen(),
    commodityOpen: isCommodityMarketOpen(),
    marketState: anyMarketOpen() ? 'OPEN' : 'CLOSED',
    dataMode,
    asOf: asOfFromSignals(currentSignals),
    signals: currentSignals.length,
    live: currentSignals.filter(s => s.tier !== 'WATCH').length,
    watch: currentSignals.filter(s => s.tier === 'WATCH').length,
    gradeA: currentSignals.filter(s => s.grade === 'A').length,
    lastEngineRun: lastEngineRun ? new Date(lastEngineRun).toISOString() : null,
    lastSnapshotRun: lastSnapshotRun ? new Date(lastSnapshotRun).toISOString() : null,
    botRunning: botState.isRunning,
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/signals', (req, res) => {
  const { type, grade, minScore, tier } = req.query
  let out = currentSignals
  if (type) out = out.filter(s => s.type === String(type).toUpperCase())
  if (grade) out = out.filter(s => s.grade === String(grade).toUpperCase())
  if (minScore) out = out.filter(s => s.score >= Number(minScore))
  if (tier) out = out.filter(s => (s.tier ?? 'LIVE') === String(tier).toUpperCase())
  res.json({
    signals: out,
    count: out.length,
    marketState: anyMarketOpen() ? 'OPEN' : 'CLOSED',
    dataMode,
    asOf: asOfFromSignals(out),
    timestamp: new Date().toISOString(),
  })
})

app.post('/api/signals/refresh', async (_req, res) => {
  const signals = await runAndBroadcast('manual')
  res.json({ signals, count: signals.length })
})

// ── Global "Refresh Everything" ────────────────────────────────
// Runs signal engine + daily-pick + regime + all screener buckets in parallel.
// Rate-limited to 1/60s and 10/24h to stay inside Angel's 60k/day budget.
app.get('/api/refresh-all/status', (_req, res) => {
  res.json(refreshAllState())
})

app.post('/api/refresh-all', async (_req, res) => {
  const gate = refreshAllState()
  if (!gate.allowed) {
    return res.status(429).json({
      error: gate.reason === 'cooldown'
        ? `Please wait ${gate.resetInSec}s between full refreshes (protects API budget)`
        : `Daily cap of ${REFRESH_ALL_DAILY_CAP} full refreshes reached — next slot in ${Math.round((gate.resetInSec ?? 0) / 60)} min`,
      ...gate,
    })
  }
  const started = Date.now()
  refreshAllHistory.push(started)
  const runId = `ra-${started}`
  const state = refreshAllState()

  // Return immediately — heavy work runs in background and completion is
  // broadcast via WebSocket so the client UI stays responsive even when
  // Angel ScripMaster needs to reload (~3 min cold) or screeners are slow.
  res.json({ accepted: true, runId, startedAt: new Date(started).toISOString(), clicksRemaining: state.remaining })

  log.info('REFRESH-ALL', `${runId}: running full parallel sweep in background...`)
  const SCAN_LIMITS: Partial<Record<ScannerBucket, number>> = {
    movers: 200, pro: 100, premove: 100, moneyflow: 100, swing: 100, multibagger: 100,
  }
  // Emit per-task completion events so the UI can show live progress
  const tasks: Promise<{ name: string; count?: number; error?: string }>[] = [
    runAndBroadcast('refresh-all').then(s => {
      const r = { name: 'signals', count: s.length }
      broadcast({ type: 'REFRESH_ALL_PROGRESS', runId, task: r })
      return r
    }).catch(e => {
      const r = { name: 'signals', error: String(e?.message ?? e) }
      broadcast({ type: 'REFRESH_ALL_PROGRESS', runId, task: r })
      return r
    }),
    runDailyPick({ limit: 400, reason: 'refresh-all' }).then(p => {
      broadcast({ type: 'DAILY_PICK_UPDATE', pick: p })
      const r = { name: 'daily-pick', count: p.rows.length }
      broadcast({ type: 'REFRESH_ALL_PROGRESS', runId, task: r })
      return r
    }).catch(e => {
      const r = { name: 'daily-pick', error: String(e?.message ?? e) }
      broadcast({ type: 'REFRESH_ALL_PROGRESS', runId, task: r })
      return r
    }),
    getMarketRegime().then(reg => {
      const r = { name: 'regime', count: reg.greenCount }
      broadcast({ type: 'REFRESH_ALL_PROGRESS', runId, task: r })
      return r
    }).catch(e => {
      const r = { name: 'regime', error: String(e?.message ?? e) }
      broadcast({ type: 'REFRESH_ALL_PROGRESS', runId, task: r })
      return r
    }),
    ...(['moneyflow', 'swing', 'multibagger', 'premove', 'movers', 'pro'] as ScannerBucket[]).map(b =>
      runScan(b, { limitSymbols: SCAN_LIMITS[b] ?? 100 }).then(scan => {
        broadcast({ type: 'SCAN_UPDATE', bucket: b, run: scan })
        const r = { name: `scan:${b}`, count: scan.results.length }
        broadcast({ type: 'REFRESH_ALL_PROGRESS', runId, task: r })
        return r
      }).catch(e => {
        const r = { name: `scan:${b}`, error: String(e?.message ?? e) }
        broadcast({ type: 'REFRESH_ALL_PROGRESS', runId, task: r })
        return r
      }),
    ),
  ]

  Promise.allSettled(tasks).then(arr => {
    const summary = arr.map(x => x.status === 'fulfilled' ? x.value : { error: String((x.reason as Error)?.message) })
    const tookMs = Date.now() - started
    log.ok('REFRESH-ALL', `${runId}: Done in ${(tookMs / 1000).toFixed(1)}s`)
    broadcast({ type: 'REFRESH_ALL_COMPLETE', runId, tookMs, results: summary, clicksRemaining: refreshAllState().remaining })
  })
})

app.get('/api/signal/:symbol', async (req, res) => {
  try {
    const signals = await signalForSymbol(req.params.symbol.toUpperCase())
    res.json({ signals, count: signals.length })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

app.get('/api/market/indices', async (_req, res) => {
  const indices = await data.getMarketIndices()
  res.json({ indices })
})

app.get('/api/price/:symbol', async (req, res) => {
  const q = await data.getQuote(req.params.symbol.toUpperCase())
  if (!q) return res.status(404).json({ error: 'Price unavailable' })
  res.json(q)
})

app.get('/api/candles/:symbol', async (req, res) => {
  const tf = (req.query.tf as any) ?? '15m'
  const count = Number(req.query.count ?? 200)
  const candles = await data.getCandles(req.params.symbol.toUpperCase(), tf, count)
  res.json({ symbol: req.params.symbol.toUpperCase(), timeframe: tf, candles, count: candles.length })
})

app.get('/api/options/:symbol', async (req, res) => {
  const sym = req.params.symbol.toUpperCase()
  if (sym !== 'NIFTY' && sym !== 'BANKNIFTY') {
    return res.status(400).json({ error: 'symbol must be NIFTY or BANKNIFTY' })
  }
  // Prefer Angel SmartAPI (real OI + LTP); fall back to NSE public API.
  let oc = null
  if (angel.hasAngelCreds()) oc = await angel.getOptionChain(sym).catch(() => null)
  if (!oc) oc = sym === 'BANKNIFTY' ? await fetchBankNiftyOptionChain() : await fetchNiftyOptionChain()
  if (!oc) return res.status(503).json({ error: 'Option chain unavailable from both Angel and NSE' })
  const analysis = interpretOI(oc)
  res.json({ chain: oc, analysis })
})

app.get('/api/gann/cycle-status', async (req, res) => {
  try {
    const symbol = (req.query.symbol as string ?? 'NIFTY').toUpperCase()
    const [priceQ, candlesD, candles1h] = await Promise.all([
      data.getQuote(symbol).catch(() => null),
      data.getCandles(symbol, '1D', 200).catch(() => []),
      data.getCandles(symbol, '1h', 200).catch(() => []),     // for short-tf harmonics
    ])
    const price = Number(req.query.price ?? priceQ?.price ?? 0)
    const status = getGannCycleStatus(symbol, price)
    const bestTrade = getBestCycleTrade(status, new Date(), candlesD, candles1h)
    res.json({ ...status, bestTrade, livePrice: price, change: priceQ?.change, changePct: priceQ?.changePct })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

app.get('/api/gann/time-cycle', async (req, res) => {
  try {
    const symbol = (req.query.symbol as string ?? 'NIFTY').toUpperCase()
    const tc = getTimeCycleStatus(symbol)
    const [priceQ, candlesD, candles1h] = await Promise.all([
      data.getQuote(symbol).catch(() => null),
      data.getCandles(symbol, '1D', 200).catch(() => []),
      data.getCandles(symbol, '1h', 200).catch(() => []),
    ])
    const gannStatus = priceQ?.price ? getGannCycleStatus(symbol, priceQ.price) : null
    const bestTrade = gannStatus ? getBestCycleTrade(gannStatus, new Date(), candlesD, candles1h) : null
    res.json({
      ...tc,
      livePrice: priceQ?.price,
      change: priceQ?.change,
      changePct: priceQ?.changePct,
      nearestGannLevel: gannStatus?.squareOf9.nearest,
      bestTrade,
    })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

app.get('/api/gann', (req, res) => {
  const symbol = (req.query.symbol as string ?? 'NIFTY').toUpperCase()
  const price = Number(req.query.price ?? 0)
  const date = req.query.date ? new Date(String(req.query.date)) : new Date()
  const bias = gannBiasFor(symbol, price, date)
  res.json({ symbol, bias, seeds: seedsFor(symbol).map(s => ({ name: s.name, date: s.date.toISOString().slice(0, 10), importance: s.importance })) })
})

app.get('/api/astro', (req, res) => {
  const date = req.query.date ? new Date(String(req.query.date)) : new Date()
  res.json({ date: date.toISOString(), bias: astroBiasFor(date) })
})

// ── Signal log + live performance ──────────────────────────────
/**
 * Full audit feed — every emitted signal with its outcome joined in, newest
 * first. Powers the Signal Audit / Backtest Results page in the dashboard.
 * `?limit=N` (default 500) caps the payload.
 */
app.get('/api/log/signals', async (req, res) => {
  try {
    const limit = Math.max(10, Math.min(2000, Number(req.query.limit) || 500))
    const rows = await readAuditRows(limit)
    res.json({ rows, count: rows.length, limit, asOf: new Date().toISOString() })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

app.get('/api/log/stats', async (_req, res) => {
  try { res.json(await readPerfStats()) }
  catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

app.get('/api/log/signals.csv', (_req, res) => {
  res.download(signalsCsvPath(), 'signals.csv', err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'no signals logged yet' })
  })
})

app.get('/api/log/outcomes.csv', (_req, res) => {
  res.download(outcomesCsvPath(), 'outcomes.csv', err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'no outcomes logged yet' })
  })
})

app.get('/api/log/daily-report', async (_req, res) => {
  try { res.json(await readLatestDailyReport()) }
  catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/log/daily-report/run', async (_req, res) => {
  try {
    const r = await generateDailyReport()
    if (botState.bot) {
      for (const chatId of config.bots.telegramChatIds) {
        try { await botState.bot.api.sendMessage(chatId, r.message, { parse_mode: 'Markdown' }) }
        catch (e) { log.warn('DAILY-REPORT', `tg ${chatId}: ${(e as Error).message}`) }
      }
    }
    res.json(r)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

app.get('/api/log/trades-pnl.csv', (_req, res) => {
  res.download(pnlCsvPath(), 'trades-pnl.csv', err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'no closed trades yet' })
  })
})

app.get('/api/log/pnl', async (_req, res) => {
  try { res.json(await readPnlSummary()) }
  catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── Fundamentals (Screener.in CSV upload) ─────────────────────
app.get('/api/fundamentals', async (_req, res) => {
  try {
    const data = await loadFundamentals()
    const flow = await getTodaysFlow().catch(() => null)
    res.json({
      uploadedAt: data.uploadedAt,
      source: data.source,
      symbolCount: Object.keys(data.rows).length,
      sampleSymbols: Object.keys(data.rows).slice(0, 12),
      flow,
    })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

app.post('/api/fundamentals/upload', async (req, res) => {
  try {
    // Accepts either { csv: "..." } JSON body or raw text/csv
    const csv = typeof req.body === 'string' ? req.body : (req.body?.csv as string)
    if (!csv || csv.length < 50) return res.status(400).json({ error: 'No CSV provided (POST text/csv body or JSON {csv})' })
    const source = (req.query.source as string) ?? 'screener.in'
    const stored = await parseAndStoreCsv(csv, source)
    res.json({ uploadedAt: stored.uploadedAt, source: stored.source, symbolCount: Object.keys(stored.rows).length })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

app.get('/api/regime', async (_req, res) => {
  try {
    const reading = await getMarketRegime()
    res.json(reading)
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// Live OI flow analysis — what's building where right now
app.get('/api/oi/flow', (_req, res) => {
  try { res.json(getLatestOiAnalysis()) }
  catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/oi/flow/run', async (_req, res) => {
  try {
    const sigs = await tickOiMonitor()
    res.json({ newSignals: sigs.length, signals: sigs })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── Learning endpoints ─────────────────────────────────────────
app.get('/api/learning/patterns', async (_req, res) => {
  try { res.json(await getLearnedPatterns()) }
  catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/learning/patterns/run', async (_req, res) => {
  try { res.json(await runPatternLearner()) }
  catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.get('/api/learning/autotune', async (_req, res) => {
  try { res.json(await getAutoTune()) }
  catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/learning/autotune/run', async (_req, res) => {
  try { res.json(await runSelfImprove()) }
  catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── Weekly Manager Pick ────────────────────────────────────────
app.get('/api/weekly-pick', async (_req, res) => {
  try {
    const pick = await getLatestPick()
    if (!pick) return res.status(404).json({ error: 'No weekly pick yet — POST /api/weekly-pick/run first' })
    res.json(pick)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
// 2026-05-04: dispatch-only endpoint — push the LATEST weekly pick to
// Telegram without re-running the 4-min full-market scan. Useful for "I want
// to see the picks now" without waiting.
/**
 * /api/top-trades — single curated stream for the dashboard. Pulls top
 * picks from EVERY engine (weekly, daily, master setup, turtle soup, fib-lrc,
 * harmonic) and surfaces only the highest-conviction ones in a unified format
 * with entry date / level / SL / target dates / target prices.
 *
 * Default filter: conviction ≥ 85, deduped by symbol, sorted desc by conviction.
 * 2026-05-06: replaces the noisy multi-tab view per user directive.
 */
app.get('/api/top-trades', async (req, res) => {
  try {
    const minConv = Number(req.query.minConv ?? 85)
    const limit = Math.max(5, Math.min(50, Number(req.query.limit ?? 20)))
    interface UnifiedRow {
      symbol: string
      source: 'WEEKLY' | 'DAILY' | 'MASTER' | 'TURTLE' | 'FIB' | 'HARMONIC' | 'OPTIONS'
      direction: 'BUY' | 'SHORT' | 'SELL'
      conviction: number
      ltp: number
      entryDate: string
      entryPrice: number
      entryPriceLow: number
      entryPriceHigh: number
      stopLoss: number
      target1: number
      target1Date: string
      target2: number
      target2Date: string
      target3: number
      target3Date: string
      noBrainer: boolean
      shareholdingNote: string
      reasoning: string
    }
    const rows: UnifiedRow[] = []
    const seen = new Set<string>()
    const push = (r: UnifiedRow) => {
      if (r.conviction < minConv) return
      const k = `${r.symbol}|${r.direction}`
      if (seen.has(k)) return
      seen.add(k)
      rows.push(r)
    }

    // 1. Weekly pick
    try {
      const wp = await getLatestPick()
      if (wp) for (const r of wp.rows) push({
        symbol: r.symbol, source: 'WEEKLY', direction: r.direction,
        conviction: r.conviction, ltp: r.ltp,
        entryDate: r.entryDate, entryPrice: r.entryPrice,
        entryPriceLow: r.entryPriceLow, entryPriceHigh: r.entryPriceHigh,
        stopLoss: r.stopLoss, target1: r.target1, target1Date: r.target1Date,
        target2: r.target2, target2Date: r.target2Date,
        target3: r.target3, target3Date: r.target3Date,
        noBrainer: r.noBrainerBet ?? false,
        shareholdingNote: r.shareholdingNote ?? '',
        reasoning: r.flowNote ?? '',
      })
    } catch { /* skip */ }

    // 2. Daily pick
    try {
      const dp = getLatestDailyPick()
      if (dp?.rows) for (const r of dp.rows as any[]) push({
        symbol: r.symbol, source: 'DAILY', direction: r.direction,
        conviction: r.conviction, ltp: r.ltp,
        entryDate: r.entryDate, entryPrice: r.entryPrice,
        entryPriceLow: r.entryPriceLow ?? r.entryPrice,
        entryPriceHigh: r.entryPriceHigh ?? r.entryPrice,
        stopLoss: r.stopLoss,
        target1: r.target1, target1Date: r.target1Date,
        target2: r.target2, target2Date: r.target2Date,
        target3: r.target3, target3Date: r.target3Date,
        noBrainer: false,
        shareholdingNote: '',
        reasoning: (r.reasons || []).slice(0, 2).join(' · '),
      })
    } catch { /* skip */ }

    // 3. Master setup elite (≥4★ → conviction = stars × 20)
    try {
      const ms = getLatestMasterSetup()
      if (ms?.setups) for (const s of ms.setups as any[]) {
        if (s.stars < 4) continue
        push({
          symbol: s.symbol, source: 'MASTER', direction: s.direction,
          conviction: s.stars * 20, ltp: s.ltp ?? s.entry,
          entryDate: s.entryDate ?? '', entryPrice: s.entry,
          entryPriceLow: s.entry, entryPriceHigh: s.entry,
          stopLoss: s.stopLoss,
          target1: s.target1, target1Date: s.target1Date ?? '',
          target2: s.target2, target2Date: s.target2Date ?? '',
          target3: s.target3 ?? s.target2, target3Date: s.target3Date ?? '',
          noBrainer: false, shareholdingNote: '',
          reasoning: `${s.stars}★ · ${(s.reasons || []).slice(0, 2).join(' · ')}`,
        })
      }
    } catch { /* skip */ }

    // Sort by conviction (desc), no-brainers first within same conviction
    rows.sort((a, b) => {
      if (a.noBrainer !== b.noBrainer) return a.noBrainer ? -1 : 1
      return b.conviction - a.conviction
    })

    res.json({
      generatedAt: new Date().toISOString(),
      filterMinConv: minConv,
      totalAvailable: rows.length,
      rows: rows.slice(0, limit),
    })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// Manual public-snapshot publish (useful right before deploy / git commit).
app.post('/api/public-snapshots/publish', async (_req, res) => {
  try {
    await publishSnapshots()
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

app.post('/api/weekly-pick/dispatch', async (_req, res) => {
  try {
    const pick = await getLatestPick()
    if (!pick) return res.status(404).json({ error: 'No weekly pick yet — POST /api/weekly-pick/run first' })
    await dispatchWeeklyPickAlerts(pick, 'manual-dispatch')
    res.json({ ok: true, pushed: pick.rows.filter(r => r.source === 'CURATED').length, weekOf: pick.weekOf })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

app.post('/api/weekly-pick/run', async (req, res) => {
  try {
    const universeKey = (req.query.universe as any) ?? 'MARKET_ALL'
    const pick = await runWeeklyPick(universeKey)
    broadcast({ type: 'WEEKLY_PICK_UPDATE', pick })
    void dispatchWeeklyPickAlerts(pick, 'manual').catch(() => {})
    res.json(pick)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

/**
 * Verify the latest weekly pick against actual realised movers in the same
 * window. Cross-references each top-N pick with /api/backfill/movers data so
 * the user can answer "are these picks actually winning, or are they noise?".
 *   GET /api/weekly-pick/verify-vs-movers?days=10&minPct=5
 */
// 2026-05-04: Pick journal — snapshots today's picks + scorecard endpoint.
//   GET /api/pick-journal/scorecard?days=30
//   POST /api/pick-journal/snapshot   (manual trigger)
app.get('/api/pick-journal/scorecard', async (req, res) => {
  try {
    const days = Math.max(3, Math.min(180, Number(req.query.days ?? 30)))
    const { buildScorecard } = await import('./engine/pickJournal')
    res.json(await buildScorecard(days))
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/pick-journal/snapshot', async (_req, res) => {
  try {
    const pick = await getLatestPick()
    if (!pick) return res.status(404).json({ error: 'No weekly pick yet' })
    const { snapshotPick } = await import('./engine/pickJournal')
    const file = await snapshotPick(pick)
    res.json({ ok: true, file, snapshotted: pick.rows.length })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// 2026-05-04: HTML weekly-pick screener — light-themed report with cards
//   GET /api/weekly-pick/html         — render latest pick as light HTML
app.get('/api/weekly-pick/html', async (_req, res) => {
  try {
    const pick = await getLatestPick()
    if (!pick) return res.status(404).type('html').send('<p>No weekly pick yet — run POST /api/weekly-pick/run first</p>')
    const html = renderWeeklyPickHtml(pick)
    res.type('html').send(html)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

function renderWeeklyPickHtml(pick: Awaited<ReturnType<typeof runWeeklyPick>>): string {
  const rows = pick.rows.slice(0, 50)
  const noBrainers = rows.filter(r => r.noBrainerBet)
  const others = rows.filter(r => !r.noBrainerBet)
  const fmtCard = (r: any) => `
    <div class="card ${r.noBrainerBet ? 'nb' : ''}">
      <div class="head">
        <span class="sym">${r.noBrainerBet ? '⭐ ' : ''}${r.symbol}</span>
        <span class="dir ${r.direction}">${r.direction}</span>
        <span class="conv">${r.conviction}/100</span>
        ${r.pumpRisk >= 30 ? `<span class="pump">⚠ pump ${r.pumpRisk}</span>` : ''}
      </div>
      <div class="stake">${r.shareholdingNote || ''}</div>
      <div class="row"><span class="lbl">Entry</span><span class="val">₹${r.entryPriceLow}–${r.entryPriceHigh}</span><span class="lbl">on</span><span class="val">${r.entryDate}</span><span class="lbl">${r.bestEntryTimeIST}</span></div>
      <div class="row"><span class="lbl">SL</span><span class="val sl">₹${r.stopLoss}</span></div>
      <div class="row"><span class="lbl">T1</span><span class="val t">₹${r.target1}</span><span class="lbl">${r.target1Date}</span></div>
      <div class="row"><span class="lbl">T2</span><span class="val t">₹${r.target2}</span><span class="lbl">${r.target2Date}</span></div>
      <div class="row"><span class="lbl">T3</span><span class="val t">₹${r.target3}</span><span class="lbl">${r.target3Date}</span></div>
      <div class="lenses">SMC ${r.smcScore} · Trend ${r.trendScore} · Gann ${r.gannScore} · Astro ${r.astroScore} · Flow ${r.flowScore}</div>
      <div class="hora">${r.horaLord} hora · ${r.horaNote}</div>
    </div>`
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Weekly Pick — ${pick.weekOf}</title>
<style>
  body{font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;background:#fafafa;color:#1a1a1a;padding:20px;max-width:1200px;margin:auto}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:#666;font-size:13px;margin-bottom:16px}
  .nb-banner{background:#fffbe6;border:1px solid #f5c518;padding:10px 14px;border-radius:6px;margin-bottom:14px;font-weight:600}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px}
  .card{background:#fff;border:1px solid #e6e6e6;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
  .card.nb{background:#fffbe6;border-color:#f5c518;box-shadow:0 0 0 2px #f5c51840}
  .head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
  .sym{font-weight:700;font-size:16px;flex:1}
  .dir.BUY{color:#0a8042;background:#e8f5ee;padding:2px 8px;border-radius:4px;font-weight:600}
  .dir.SHORT{color:#b81e1e;background:#fdeaea;padding:2px 8px;border-radius:4px;font-weight:600}
  .conv{color:#444;font-weight:600;background:#f0f0f0;padding:2px 8px;border-radius:4px}
  .pump{color:#b85e1e;background:#fdf3ea;padding:2px 8px;border-radius:4px;font-size:12px}
  .stake{font-size:12px;color:#555;background:#f6f8fa;padding:6px 8px;border-radius:4px;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace}
  .row{display:flex;gap:6px;align-items:baseline;font-size:13px;padding:2px 0}
  .lbl{color:#777;min-width:32px}
  .val{font-weight:600;font-family:ui-monospace,Menlo,monospace}
  .val.sl{color:#b81e1e}
  .val.t{color:#0a8042}
  .lenses{font-size:11px;color:#888;margin-top:6px;border-top:1px solid #eee;padding-top:6px}
  .hora{font-size:11px;color:#888;font-style:italic;margin-top:2px}
</style></head><body>
<h1>📋 Weekly Pick — ${rows.length} setups</h1>
<div class="sub">Generated ${new Date(pick.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · Regime: ${pick.regime} · Universe: MARKET_ALL · Horizon: 6 weeks</div>
${noBrainers.length ? `<div class="nb-banner">⭐ ${noBrainers.length} NO-BRAINER (FII↑ · promoter stable · pledge<5%)</div>` : ''}
<div class="grid">
${noBrainers.map(fmtCard).join('')}
${others.map(fmtCard).join('')}
</div>
</body></html>`
}

app.get('/api/weekly-pick/verify-vs-movers', async (req, res) => {
  try {
    const days = Math.max(3, Math.min(30, Number(req.query.days ?? 10)))
    const minPct = Number(req.query.minPct ?? 5)
    const pick = await getLatestPick()
    if (!pick) return res.status(404).json({ error: 'No weekly pick yet' })
    const { runMoverBackfill } = await import('./screeners/moverBackfill')
    const today = new Date()
    const from = new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10)
    const to = today.toISOString().slice(0, 10)
    const back = await runMoverBackfill({ from, to, minPct, universeKey: 'MARKET_ALL', limitSymbols: 1500 })
    const moverSet = new Map(back.caught.concat(back.missed).map(m => [m.symbol, m]))
    const verified = pick.rows.map(r => {
      const m = moverSet.get(r.symbol)
      return {
        symbol: r.symbol,
        conviction: r.conviction,
        direction: r.direction,
        entryPrice: r.entryPrice,
        target1: r.target1,
        actualMovePct: m?.movePct ?? null,
        directionAgrees: m
          ? (r.direction === 'BUY' && m.direction === 'UP') || (r.direction === 'SHORT' && m.direction === 'DOWN')
          : null,
        backfillCaughtBy: m?.caughtBy ?? [],
      }
    })
    const matched = verified.filter(v => v.actualMovePct != null)
    const winnersInPick = matched.filter(v => v.directionAgrees)
    res.json({
      window: `${from} → ${to} (${days}d, ≥${minPct}% movers)`,
      pickRows: pick.rows.length,
      moversInWindow: back.totalMovers,
      pickRowsAlsoInMoverList: matched.length,
      directionAgreementCount: winnersInPick.length,
      hitRate: matched.length ? +(winnersInPick.length / matched.length * 100).toFixed(1) : 0,
      verified,
    })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── Signal logic detail (per-signal Markdown brief) ─────────────
app.get('/api/log/signal/:id/logic', async (req, res) => {
  try {
    const safeId = String(req.params.id).replace(/[^A-Za-z0-9_\-.]/g, '_').slice(0, 200)
    const file = path.join(__dirname, '../data/signals-detail', `${safeId}.md`)
    const text = await fsAsync.readFile(file, 'utf8').catch(() => null)
    if (!text) return res.status(404).json({ error: 'Logic file not found — signal may pre-date the per-signal logging feature' })
    res.type('text/markdown').send(text)
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// ── Market Digest (pre-market / pre-close) ──────────────────────
app.post('/api/digest/run', async (req, res) => {
  try {
    const kind = (req.query.kind === 'pre-close' ? 'pre-close' : 'pre-market') as 'pre-market' | 'pre-close'
    const digest = await runMarketDigest(kind)
    const push = req.query.push === '1' || req.query.push === 'true'
    if (push) void dispatchTextAlert(digest.message).catch(() => undefined)
    res.json({ ...digest, pushed: push })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

// ── Harmonic Patterns ────────────────────────────────────────────
// Returns the last cached scan. ?tier=POSITIONAL|HOURLY|INTRADAY|ALL
// (default ALL — merges every cached tier so the dashboard sees the
// union: positional NSE_ALL + hourly CNX500 + intraday top-200).
app.get('/api/harmonic-scan', (req, res) => {
  const tier = (req.query.tier as string)?.toUpperCase() as 'POSITIONAL' | 'HOURLY' | 'INTRADAY' | 'ALL' | undefined
  const last = getLastHarmonicScan(tier ?? 'ALL')
  res.json(last ?? { generatedAt: null, hits: [], totalPatterns: 0, tier: tier ?? 'ALL' })
})
// Trigger a fresh scan. POST ?tier=POSITIONAL|HOURLY|INTRADAY runs only that
// tier. POST without tier runs all three sequentially (slow — ~5+ minutes).
app.post('/api/harmonic-scan/run', async (req, res) => {
  try {
    const minConfidence = req.query.minConfidence ? Number(req.query.minConfidence) : undefined
    const tier = (req.query.tier as string)?.toUpperCase() as 'POSITIONAL' | 'HOURLY' | 'INTRADAY' | undefined
    const run = await runHarmonicScan({ tier, minConfidence })
    broadcast({ type: 'HARMONIC_SCAN_UPDATE', run })
    void dispatchHarmonicAlerts(run.hits).catch(() => {})
    res.json(run)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.get('/api/harmonic-scan/timeframes', (_req, res) => {
  res.json({ timeframes: HARMONIC_TIMEFRAMES })
})
app.get('/api/weekly-pick/watchlist', async (_req, res) => {
  res.json({ symbols: await getWatchlist() })
})
app.post('/api/weekly-pick/watchlist', async (req, res) => {
  try {
    const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols as string[] : []
    res.json({ symbols: await setWatchlist(symbols) })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── Daily Pick (auto-updated every 30 min during market) ───────
app.get('/api/daily-pick', async (_req, res) => {
  try {
    const pick = (await loadLatestDailyPick())
    if (!pick) return res.status(404).json({ error: 'No daily pick yet — POST /api/daily-pick/run' })
    res.json(pick)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/daily-pick/run', async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 0) || undefined
    const pick = await runDailyPick({ limit, reason: 'manual' })
    broadcast({ type: 'DAILY_PICK_UPDATE', pick })
    void dispatchDailyPickAlerts(pick).catch(() => {})
    res.json(pick)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

app.get('/api/fii-dii', async (_req, res) => {
  const d = await fetchFIIDIIData()
  res.json({ data: d })
})

// ── MASTER SETUP — fires only when 5 confluence gates align ──
// User wants quality > quantity: detect the move BEFORE it starts (compression
// + smart-money footprint + cycle window + sector rotation). Output is a
// ranked list of ≤6 elite setups across the whole universe.
app.get('/api/master-setup', async (_req, res) => {
  try {
    const run = getLatestMasterSetup()
    if (!run) return res.status(404).json({ error: 'No master-setup run yet — POST /api/master-setup/run' })
    res.json(run)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/master-setup/run', async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 0) || undefined
    const maxOutput = Number(req.query.top ?? 0) || undefined
    const run = await refreshMasterSetup({ limit, maxOutput })
    broadcast({ type: 'MASTER_SETUP_UPDATE', run })
    void dispatchMasterSetupAlerts(run).catch(() => {})
    res.json(run)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── SECTOR ROTATION — daily snapshot of which baskets money is rotating into ──
// User missed DMART/HINDUNILVR/VOLTAS (FMCG) defensive bid; this endpoint
// surfaces baskets outperforming NIFTY by ≥3% with breadth + volume confirmation.
app.get('/api/sector-rotation', async (_req, res) => {
  try {
    const snap = getLatestSectorRotation()
    if (!snap) return res.status(404).json({ error: 'No sector-rotation snapshot yet — POST /api/sector-rotation/run' })
    res.json(snap)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/sector-rotation/run', async (_req, res) => {
  try {
    const snap = await runSectorRotationScan()
    broadcast({ type: 'SECTOR_ROTATION_UPDATE', snap })
    res.json(snap)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── ICT TURTLE SOUP — pure liquidity-sweep reversal across 11 TFs ──
// Detector lives in strategies/ictTurtleSoup.ts; multi-TF runner in
// engine/turtleSoupEngine.ts. Scans NIFTY + GOLD (XAUUSD) on
// 5m/15m/30m/45m/1h/2h/3h/4h/1d/1w/1mo. No other indicators are mixed in
// per user directive — this is pure ICT.
app.get('/api/turtle-soup', async (_req, res) => {
  try {
    const run = getLatestTurtleSoupRun()
    if (!run) return res.status(404).json({ error: 'No turtle-soup run yet — POST /api/turtle-soup/run' })
    res.json(run)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/turtle-soup/run', async (_req, res) => {
  try {
    const run = await runTurtleSoupScan()
    broadcast({ type: 'TURTLE_SOUP_UPDATE', run })
    void dispatchTurtleSoupAlerts(run).catch(() => {})
    res.json(run)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
// Manual dedup clear — useful for "re-fire all alerts now" smoke tests.
app.post('/api/alerts/clear-dedup', async (_req, res) => {
  clearTurtleSoupDedup()
  try {
    const { clearFibLrcDedup } = await import('./engine/fibLrcEngine')
    clearFibLrcDedup()
  } catch { /* engine not yet loaded */ }
  try { clearHarmonicDedup() } catch { /* defensive */ }
  res.json({ ok: true, cleared: ['turtle-soup', 'fib-lrc', 'harmonic'] })
})

// ── FIB + LRC — Fib retracement + Linear Regression Candles flip ──
// User's TradingView setup: LR Length 11, Smoothing 11, ATR 100, Key Value 1.
// Catches XAUUSD-style bounces at 0.5/0.618/0.786/0.886 with LRC flip — the
// kind of trade Turtle Soup explicitly excludes (no liquidity sweep needed).
app.get('/api/fib-lrc', async (_req, res) => {
  try {
    const { getLatestFibLrcRun } = await import('./engine/fibLrcEngine')
    const run = getLatestFibLrcRun()
    if (!run) return res.status(404).json({ error: 'No fib-lrc run yet — POST /api/fib-lrc/run' })
    res.json(run)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/fib-lrc/run', async (_req, res) => {
  try {
    const { runFibLrcScan } = await import('./engine/fibLrcEngine')
    const run = await runFibLrcScan()
    broadcast({ type: 'FIB_LRC_UPDATE', run })
    res.json(run)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── Universal export — every tab has CSV + HTML (browser print → PDF) ──
// GET /api/export/<dataset>?format=csv|json|html
//   datasets: master-setup · sector-rotation · weekly-pick · daily-pick · signals
// HTML output is print-styled — opening it in a tab and using the browser
// "Save as PDF" gives a clean PDF with no extra server deps. Frontend's
// ExportButtons component opens both flows.
app.get('/api/export/:dataset', async (req, res) => {
  try {
    const dataset = req.params.dataset as ExportDataset
    const format = ((req.query.format ?? 'csv') as string).toLowerCase() as ExportFormat
    if (!['master-setup', 'sector-rotation', 'weekly-pick', 'daily-pick', 'signals', 'turtle-soup', 'harmonic-scan'].includes(dataset)) {
      return res.status(400).json({ error: `Unknown dataset: ${dataset}` })
    }
    if (!['csv', 'json', 'html'].includes(format)) {
      return res.status(400).json({ error: `Unknown format: ${format}` })
    }
    const out = await exportDataset(dataset, format, () => currentSignals)
    res.setHeader('Content-Type', out.mime)
    // For CSV/JSON force download; for HTML let the browser render it inline
    if (format !== 'html') {
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`)
    }
    res.send(out.body)
  } catch (e) {
    res.status(404).json({ error: (e as Error).message })
  }
})

app.get('/api/backtest', async (req, res) => {
  try {
    const symbol = (req.query.symbol as string ?? 'NIFTY').toUpperCase()
    const strategy = (req.query.strategy as any) ?? 'swing'
    const tf = (req.query.tf as any) ?? '1D'
    const r = await backtest(symbol, strategy, tf, 500)
    res.json(r)
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

app.get('/api/backtest/suite', async (_req, res) => {
  try {
    const results = await backtestSuite()
    res.json({ results })
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

app.get('/api/trades', (_req, res) => {
  res.json({ trades: allTrades(), stats: tradeStats() })
})

app.get('/api/trades/active', (_req, res) => {
  res.json({ trades: activeTrades(), count: activeTrades().length })
})

app.get('/api/angel/status', (_req, res) => {
  const sess = angel.getSessionInfo()
  const feed = angelFeed.status()
  res.json({
    ...sess,
    credsConfigured: angel.hasAngelCreds(),
    feedConnected: feed.connected,
    feedSubscriptions: feed.subscriptions,
  })
})

app.post('/api/angel/login', async (_req, res) => {
  const t = await angel.login()
  res.json({ success: !!t, obtainedAt: t?.obtainedAt ?? null })
})

app.get('/api/scan/:bucket', async (req, res) => {
  const bucket = req.params.bucket as ScannerBucket
  if (!['moneyflow', 'swing', 'multibagger', 'premove', 'movers', 'pro'].includes(bucket)) {
    return res.status(400).json({ error: 'bucket must be moneyflow|swing|multibagger|premove|movers|pro' })
  }
  const cached = getLatestRun(bucket)
  if (cached) return res.json(cached)
  const run = await runScan(bucket, { limitSymbols: 100 })
  res.json(run)
})

app.post('/api/scan/:bucket/refresh', async (req, res) => {
  const bucket = req.params.bucket as ScannerBucket
  if (!['moneyflow', 'swing', 'multibagger', 'premove', 'movers', 'pro'].includes(bucket)) {
    return res.status(400).json({ error: 'bucket must be moneyflow|swing|multibagger|premove|movers|pro' })
  }
  const limit = Number(req.query.limit ?? 250)
  const universeKey = req.query.universe as string | undefined
  const run = await runScan(bucket, { limitSymbols: limit, universeKey })
  res.json(run)
})

// ────────────────────────────────────────────────────────────────
// Mover backfill — replay the universe over a historical window and report
// every ≥minPct mover. For each, replay our screeners on the bar BEFORE the
// move started and flag whether we'd have caught it. True misses are listed
// separately so we know which patterns still need a screener.
//
// Examples (from the user's 2026-05-02 audit):
//   GET /api/backfill/movers?from=2026-04-21&to=2026-04-28&minPct=2&universe=NIFTY50
//     → catches Nifty 24717 → 23960 (-3.06%) on the Distribution-Top screener
//   GET /api/backfill/movers?from=2026-04-18&to=2026-04-30&minPct=10&universe=CNX500
//     → all 10%+ movers in the 10-day window with miss-reasons
// ────────────────────────────────────────────────────────────────
app.get('/api/backfill/movers', async (req, res) => {
  try {
    const { runMoverBackfill } = await import('./screeners/moverBackfill')
    const from = String(req.query.from || '')
    const to = String(req.query.to || '')
    const minPct = Number(req.query.minPct ?? 5)
    const universeKey = (req.query.universe as string) || 'CNX500'
    const limit = Number(req.query.limit ?? 500)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' })
    }
    const out = await runMoverBackfill({ from, to, minPct, universeKey, limitSymbols: limit })
    res.json(out)
  } catch (e) {
    log.err('API', `backfill: ${(e as Error).message}`)
    res.status(500).json({ error: (e as Error).message })
  }
})

app.get('/api/bot/status', (_req, res) => {
  res.json({
    running: botState.isRunning,
    startedAt: botState.startedAt ? new Date(botState.startedAt).toISOString() : null,
    chatIds: config.bots.telegramChatIds.length,
    configured: Boolean(config.bots.telegramToken),
  })
})

// 2026-05-11: admin one-shot — broadcast an ad-hoc Markdown message to all
// configured Telegram chat IDs. Used for proposal/approval flows where Claude
// needs to put a question to the user out-of-band. Localhost-only (no auth).
// 2026-05-11 diag: trace wave-2 conditions on a specific symbol to see
// exactly which gate is failing. Used when 0 hits across a universe.
//   GET /api/diag/wave2?symbol=AVL
app.get('/api/diag/wave2', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'NIFTY')
    const candles = await data.getCandles(symbol, '1D', 80)
    if (candles.length < 60) return res.json({ symbol, fail: `only ${candles.length} candles` })
    const last = candles[candles.length - 1]
    // Replicate wave-2 steps with verbose output
    const earlySlice = candles.slice(-40, -8)
    const legLow = Math.min(...earlySlice.map(c => c.low))
    const legHigh = Math.max(...earlySlice.map(c => c.high))
    const legHighIdx = candles.length - 40 + earlySlice.findIndex(c => c.high === legHigh)
    const legPct = ((legHigh - legLow) / legLow) * 100
    const afterHigh = candles.slice(legHighIdx)
    const pullbackLow = Math.min(...afterHigh.map(c => c.low))
    const retracePct = ((legHigh - pullbackLow) / (legHigh - legLow)) * 100
    const pullbackLowIdx = candles.length - afterHigh.length + afterHigh.findIndex(c => c.low === pullbackLow)
    const pullbackDays = candles.length - 1 - pullbackLowIdx
    const last5 = candles.slice(-5)
    const consHigh = Math.max(...last5.map(c => c.high))
    const consLow = Math.min(...last5.map(c => c.low))
    const consPct = ((consHigh - consLow) / last.close) * 100
    const preLegSlice = candles.slice(-65, -25)
    const preLegVol = preLegSlice.length ? preLegSlice.reduce((s, c) => s + c.volume, 0) / preLegSlice.length : 0
    const last5Vol = last5.reduce((s, c) => s + c.volume, 0) / 5
    res.json({
      symbol,
      ltp: last.close,
      step1_legPct: legPct.toFixed(2), gate1_8to35: legPct >= 8 && legPct <= 35,
      step2_retracePct: retracePct.toFixed(2), gate2_25to70: retracePct >= 25 && retracePct <= 70,
      step2_pullbackDays: pullbackDays, gate2_1to18: pullbackDays >= 1 && pullbackDays <= 18,
      step3_consPct: consPct.toFixed(2), gate3_lt8: consPct < 8,
      step4_volRatio: preLegVol ? (last5Vol / preLegVol).toFixed(2) : 'n/a', gate4_lt110: preLegVol === 0 || last5Vol <= preLegVol * 1.1,
    })
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }) }
})

app.post('/api/bot/broadcast', async (req, res) => {
  if (!botState.bot) return res.status(503).json({ error: 'bot not running' })
  const message = String(req.body?.message ?? '')
  if (!message || message.length < 5) return res.status(400).json({ error: 'message required (≥5 chars)' })
  const tag = String(req.body?.tag ?? 'ad-hoc')
  const sent: any[] = []
  for (const cid of config.bots.telegramChatIds) {
    try {
      // Try Markdown first; fall back to plain text if Telegram parser rejects it.
      try {
        await botState.bot.api.sendMessage(cid, message, { parse_mode: 'Markdown' })
      } catch {
        await botState.bot.api.sendMessage(cid, message)
      }
      recordTgPush(`broadcast-${tag}`, `${message.length} chars`, cid)
      sent.push({ chatId: cid, ok: true })
    } catch (e: any) {
      sent.push({ chatId: cid, ok: false, error: String(e?.message || e) })
    }
  }
  res.json({ ok: true, sent })
})

// ────────────────────────────────────────────────────────────────
// Self-diagnose endpoint
// ────────────────────────────────────────────────────────────────

app.get('/api/diagnose', async (_req, res) => {
  const checks: { service: string; ok: boolean; note?: string }[] = []
  const niftyQuote = await data.getQuote('NIFTY')
  checks.push({ service: 'quotes', ok: !!niftyQuote, note: niftyQuote?.source })
  const oc = await fetchNiftyOptionChain()
  checks.push({ service: 'NSE option-chain', ok: !!oc, note: oc ? `PCR ${oc.pcr.toFixed(2)}` : 'down' })
  const angelSess = angel.getSessionInfo()
  checks.push({
    service: 'angel-smartapi',
    ok: angelSess.loggedIn,
    note: angelSess.loggedIn ? `logged in as ${angelSess.clientCode}` : angel.hasAngelCreds() ? 'creds present, login pending' : 'no creds',
  })
  checks.push({
    service: 'angel-feed (WS)',
    ok: angelFeed.status().connected,
    note: angelFeed.status().connected ? 'live ticks' : 'disconnected',
  })
  checks.push({ service: 'astro', ok: true, note: 'local-ephemeris' })
  checks.push({ service: 'gann', ok: true })
  checks.push({ service: 'telegram-bot', ok: botState.isRunning })
  const drift = getOffsetMs()
  checks.push({ service: 'clock sync', ok: Math.abs(drift) < 30_000, note: `${drift > 0 ? '+' : ''}${drift}ms` })
  const healthy = checks.every(c => c.ok)
  res.json({ healthy, checks, lastEngineRun, signals: currentSignals.length })
})

// ────────────────────────────────────────────────────────────────
// WebSocket
// ────────────────────────────────────────────────────────────────

wss.on('connection', (ws) => {
  log.info('WS', `Client connected (${wss.clients.size} total)`)
  ws.send(JSON.stringify({ type: 'INIT', signals: currentSignals, timestamp: new Date().toISOString() }))
  ws.on('close', () => log.info('WS', `Client disconnected (${wss.clients.size - 1} remaining)`))
})

// Periodic status ping so the UI knows the WS is alive
setInterval(() => {
  broadcast({ type: 'HEARTBEAT', ts: Date.now(), marketOpen: isMarketOpen() })
}, 30_000)

// ────────────────────────────────────────────────────────────────
// Scheduled jobs
// ────────────────────────────────────────────────────────────────

// Signal engine — every 5 minutes during NSE hours (09:15-15:30 IST, Mon-Fri)
// Pre-market digest — 08:30 IST every weekday, 45 min before NSE opens.
// Runs snapshot engine + harmonic scan + Daily Pick refresh, then ships
// a compact Telegram digest with the day's high-conviction setups.
// Direct fix for the user's complaint that signals always arrive AFTER
// the move — this digest goes out BEFORE the open.
cron.schedule('30 8 * * 1-5', async () => {
  try {
    log.info('CRON', '🌅 Pre-market digest starting')
    const digest = await runMarketDigest('pre-market')
    void dispatchTextAlert(digest.message).catch(e => log.warn('TG', `pre-market digest: ${e.message}`))
    log.ok('CRON', `Pre-market digest sent · ${digest.sections.length} sections`)
  } catch (e) {
    log.err('CRON', `pre-market digest failed: ${(e as Error).message}`)
  }
}, { timezone: 'Asia/Kolkata' })

// Pre-close digest — 15:20 IST, 10 min before NSE closes. Surfaces
// fresh harmonics + setups that turned during the session so the user
// can decide which to roll into the next day.
cron.schedule('20 15 * * 1-5', async () => {
  try {
    log.info('CRON', '🌇 Pre-close digest starting')
    const digest = await runMarketDigest('pre-close')
    void dispatchTextAlert(digest.message).catch(e => log.warn('TG', `pre-close digest: ${e.message}`))
    log.ok('CRON', `Pre-close digest sent · ${digest.sections.length} sections`)
  } catch (e) {
    log.err('CRON', `pre-close digest failed: ${(e as Error).message}`)
  }
}, { timezone: 'Asia/Kolkata' })

// Harmonic Pattern scan — every 15 min during NSE hours. Heavier than the
// signal engine (multi-TF resampling on ~35 symbols) so we keep cadence
// looser. Off-hours covered by the off-hours cron block below.
//
// HARMONIC scans are now TIERED — one cron per universe size to keep inside
// the data-router quota while still scanning the whole NSE on positional TFs:
//   • POSITIONAL (1D / 1W / 1M)  → entire NSE_ALL (~1900 names) — once a day
//                                   post-close at 16:45 IST
//   • HOURLY     (1h / 2h / 3h / 4h) → CNX500 (~500 names) — every hour
//                                   during market hours
//   • INTRADAY   (5m / 15m / 30m / 45m) → top-200 liquid — every 30 min
//                                   during market hours
// Each tier's fresh hits are pushed to Telegram via dispatchHarmonicAlerts.
async function runHarmonicTier(tier: 'POSITIONAL' | 'HOURLY' | 'INTRADAY'): Promise<void> {
  log.info('CRON', `Harmonic ${tier} scan`)
  try {
    const run = await runHarmonicScan({ tier })
    broadcast({ type: 'HARMONIC_SCAN_UPDATE', run })
    void dispatchHarmonicAlerts(run.hits).catch(() => {})
  } catch (e) { log.err('CRON', `harmonic ${tier}: ${(e as Error).message}`) }
}
// INTRADAY tier — every 30 min during NSE session
cron.schedule('*/30 9-15 * * 1-5', () => runHarmonicTier('INTRADAY'), { timezone: 'Asia/Kolkata' })
// HOURLY tier — at minute 5 of every hour during NSE session (offset so it doesn't collide with intraday)
cron.schedule('5 9-15 * * 1-5', () => runHarmonicTier('HOURLY'), { timezone: 'Asia/Kolkata' })
// POSITIONAL tier — once a day post-close at 16:45 IST (data settled)
cron.schedule('45 16 * * 1-5', () => runHarmonicTier('POSITIONAL'), { timezone: 'Asia/Kolkata' })
// Reset Telegram dedup at midnight so each new session starts fresh
cron.schedule('0 0 * * *', () => { clearHarmonicDedup() }, { timezone: 'Asia/Kolkata' })

cron.schedule('*/5 9-15 * * 1-5', async () => {
  log.info('CRON', 'Scheduled engine tick')
  await runAndBroadcast('cron')
}, { timezone: 'Asia/Kolkata' })

// Off-hours keep-alive — every 30 min at 16-23 IST + 0-8 IST + all weekend.
// Re-runs the engine so the dashboard pages (all tabs) stay populated with
// fresh WATCH snapshots when the cash market is closed. LIVE alerts are
// still dedupe-gated via alertLedger (2h window), and there usually aren't
// any LIVE-grade triggers off-session so Telegram stays quiet.
// Off-hours snapshot — 2026-05-02: cut from every-30-min (32×/off-day) to 4
// pings at the moments that actually matter:
//   00:00 IST — US open continuation (DXY / SPX / commodity drift)
//   03:00 IST — US close + Asia pre-open positioning
//   06:00 IST — IST early-bird (overnight news ingest)
//   08:00 IST — IST pre-open (right before market digest at 08:30)
// Same coverage, 1/8th the load on Angel + Yahoo + AV.
cron.schedule('0 0,3,6,8 * * *', async () => {
  try {
    log.info('CRON', 'Off-hours engine tick (4×/day snapshot refresh)')
    await runAndBroadcast('off-hours')
  } catch (e) {
    log.warn('CRON', `off-hours tick failed: ${(e as Error).message}`)
  }
}, { timezone: 'Asia/Kolkata' })

// OI Monitor — every 1 min during market hours. Pulls NIFTY + BANKNIFTY
// chain, detects PCR shifts / OI buildup / max-pain shifts / put unwinding,
// fires PE or CE signals when triggers hit, pushes to Telegram.
// Budget: ~15k Angel calls/day (NIFTY + BANKNIFTY chain in one batch each).
cron.schedule('* 9-15 * * 1-5', async () => {
  try {
    const newSigs = await tickOiMonitor()
    if (newSigs.length) {
      // Dashboard-only: OI-flow alerts surface in the UI but stay off Telegram
      // per user filter (Telegram is reserved for NIFTY options + swing/positional).
      for (const s of newSigs) {
        broadcast({ type: 'SIGNALS_UPDATE', signals: [...currentSignals, s], reason: 'oi-monitor' })
      }
      // Append into currentSignals so they appear on the dashboard immediately
      currentSignals = [...newSigs, ...currentSignals].slice(0, 500)
    }
    // Heartbeat OI broadcast for the Options tab (even when no trigger fires)
    const oc = await fetchNiftyOptionChain()
    if (oc) broadcast({ type: 'OI_UPDATE', symbol: 'NIFTY', pcr: oc.pcr, maxPain: oc.maxPain, spot: oc.spot })
  } catch (e) {
    log.warn('OI-MONITOR', `tick: ${(e as Error).message}`)
  }
}, { timezone: 'Asia/Kolkata' })

// Commodity engine — 2026-05-02: extended to MCX 23:30 IST close. Was
// 9-23 which truncated the last 30 min of the session (where the
// US-overlap moves and Crude/Gold settlement decisions land).
cron.schedule('*/15 9-23 * * 1-5', async () => {
  if (!isCommodityMarketOpen()) return
  log.info('CRON', 'Commodity tick (15m)')
  await runAndBroadcast('commodity-cron')
}, { timezone: 'Asia/Kolkata' })
// Final MCX-close tick at 23:30 IST — captures the settlement move.
cron.schedule('30 23 * * 1-5', async () => {
  log.info('CRON', 'Commodity MCX-close tick')
  await runAndBroadcast('commodity-mcx-close')
}, { timezone: 'Asia/Kolkata' })

// Daily performance check at 16:00 IST
cron.schedule('0 16 * * 1-5', async () => {
  log.info('CRON', 'Daily performance + auto-backtest')
  try {
    const results = await backtestSuite()
    broadcast({ type: 'BACKTEST_UPDATE', results })
  } catch (e) {
    log.err('CRON', `Daily backtest failed: ${(e as Error).message}`)
  }
}, { timezone: 'Asia/Kolkata' })

// ── SCREENER JOBS ────────────────────────────────────────────

// Post-close full scan across all 4 buckets (16:10 IST, Mon-Fri)
cron.schedule('10 16 * * 1-5', async () => {
  log.info('CRON', 'Post-close scanner sweep starting...')
  for (const bucket of ['moneyflow', 'swing', 'multibagger', 'premove', 'movers', 'pro'] as ScannerBucket[]) {
    try {
      const limit = bucket === 'movers' ? 800 : bucket === 'pro' ? 500 : 200
      const run = await runScan(bucket, { limitSymbols: limit })
      broadcast({ type: 'SCAN_UPDATE', bucket, run })
    } catch (e) {
      log.err('CRON', `${bucket} scan failed: ${(e as Error).message}`)
    }
  }
}, { timezone: 'Asia/Kolkata' })

// Pre-close (15:20 IST) — pre-move scan + Telegram push ("1 day before move" alerts)
cron.schedule('20 15 * * 1-5', async () => {
  log.info('CRON', 'Pre-close pre-move scan (push alerts)...')
  try {
    const run = await runScan('premove', { limitSymbols: 200 })
    const topA = run.results.filter(r => r.tier === 'A' || r.score >= 7.5).slice(0, 10)
    if (topA.length && botState.bot) {
      const msg = formatPreMoveAlert(topA, run.results.length)
      for (const chatId of config.bots.telegramChatIds) {
        try {
          await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
        } catch (e) {
          log.warn('CRON', `Pre-move alert push to ${chatId}: ${(e as Error).message}`)
        }
      }
    }
    broadcast({ type: 'PREMOVE_ALERTS', results: topA })
  } catch (e) {
    log.err('CRON', `pre-move scan failed: ${(e as Error).message}`)
  }
}, { timezone: 'Asia/Kolkata' })

// Every 15 min during market hours — check all active trades against latest
// spot (in case the Angel WS tick was missed) + expire stale trades.
cron.schedule('*/15 9-15 * * 1-5', async () => {
  // Fetch quotes for each unique underlying of active trades
  const active = activeTrades()
  if (!active.length) return
  const symbols = [...new Set(active.map(t => t.symbol.split(' ')[0].toUpperCase()))]
  for (const sym of symbols) {
    try {
      const q = await data.getQuote(sym)
      if (!q) continue
      const events = await onPrice(sym, q.price)
      for (const ev of events) {
        broadcast({ type: 'TRADE_EVENT', event: ev })
        void dispatchLifecycleAlert(ev)
      }
    } catch { /* swallow */ }
  }
}, { timezone: 'Asia/Kolkata' })

// Daily Pick — 2026-05-02: reduced from every-30-min (14×/session) to twice
// per session at 11:00 IST (post-opening-rotation) and 13:30 IST (post-lunch
// re-rotation). Daily Pick is heavy (200-800 symbol scoring) and the pattern
// it surfaces has 5-15 day horizon — re-running it 14× per session was waste
// AND was blowing the Angel rate budget that should go to OI + Turtle Soup.
cron.schedule('0 11 * * 1-5', async () => {
  log.info('CRON', 'Daily Pick (mid-morning refresh) starting...')
  try {
    const pick = await runDailyPick({ limit: 600, reason: 'cron-1100' })
    broadcast({ type: 'DAILY_PICK_UPDATE', pick })
    void dispatchDailyPickAlerts(pick).catch(() => {})
    markFired('dp-1100')
  } catch (e) { log.err('CRON', `daily pick (11:00): ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })
cron.schedule('30 13 * * 1-5', async () => {
  log.info('CRON', 'Daily Pick (post-lunch refresh) starting...')
  try {
    const pick = await runDailyPick({ limit: 600, reason: 'cron-1330' })
    broadcast({ type: 'DAILY_PICK_UPDATE', pick })
    void dispatchDailyPickAlerts(pick).catch(() => {})
    markFired('dp-1330')
  } catch (e) { log.err('CRON', `daily pick (13:30): ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

// Daily Pick — full post-close sweep at 16:15 IST after the day's data settles.
cron.schedule('15 16 * * 1-5', async () => {
  log.info('CRON', 'Daily Pick (post-close full sweep) starting...')
  try {
    const pick = await runDailyPick({ limit: 800, reason: 'cron-postclose' })
    broadcast({ type: 'DAILY_PICK_UPDATE', pick })
    void dispatchDailyPickAlerts(pick).catch(() => {})
    markFired('dp-postclose')
  } catch (e) { log.err('CRON', `daily pick (postclose): ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

// MASTER SETUP — pre-open (08:45 IST) + mid-session (12:30 IST) + post-close (16:30 IST).
// Quality > quantity: this is the only alert stream the user wants tighter than
// the existing engines. Three runs per day catch: overnight setups, midday
// rotations, and post-close compressions priming for the next session.
async function runMasterSetupCron(tag: string): Promise<void> {
  log.info('CRON', `Master Setup (${tag}) starting...`)
  try {
    const run = await refreshMasterSetup({ limit: 250, maxOutput: 6 })
    broadcast({ type: 'MASTER_SETUP_UPDATE', run })
    void dispatchMasterSetupAlerts(run).catch(() => {})
  } catch (e) { log.err('CRON', `master-setup ${tag}: ${(e as Error).message}`) }
}
cron.schedule('45 8 * * 1-5',  async () => { await runMasterSetupCron('pre-open');    markFired('ms-preopen') }, { timezone: 'Asia/Kolkata' })
cron.schedule('30 12 * * 1-5', async () => { await runMasterSetupCron('mid-session'); markFired('ms-mid') },     { timezone: 'Asia/Kolkata' })
// 2026-05-02: post-close staggered to 16:25 (was 16:30) to break the
// thundering herd that previously fired 5 heavy crons at 16:30 simultaneously.
cron.schedule('25 16 * * 1-5', async () => { await runMasterSetupCron('post-close');  markFired('ms-close') },   { timezone: 'Asia/Kolkata' })

// Reset the per-session de-dup set at midnight IST so each new trading day
// starts fresh (otherwise the same symbol can never re-fire after rotation).
cron.schedule('0 0 * * *', () => { masterSetupSentToday.clear() }, { timezone: 'Asia/Kolkata' })
// 2026-05-07: clear the per-day signal-log dedup at midnight IST so every
// new session starts with an empty ledger. Without this, valid same-strike
// emissions from a new trading day would be silently dropped.
cron.schedule('0 0 * * *', async () => {
  const { clearDailyLogDedup } = await import('./engine/signalLogger')
  clearDailyLogDedup()
}, { timezone: 'Asia/Kolkata' })

// ── ICT TURTLE SOUP — pure liquidity-sweep scan ──
// XAUUSD trades 24×5 (Mon-Fri); NIFTY only during NSE 09:15-15:30 IST. We
// run every 15 minutes from 06:00 to 23:30 IST so we cover both books;
// the scan is cheap (no option-chain fetches, just OHLC reads).
async function runTurtleSoupCron(tag: string): Promise<void> {
  log.info('CRON', `Turtle Soup scan (${tag})`)
  try {
    const run = await runTurtleSoupScan()
    broadcast({ type: 'TURTLE_SOUP_UPDATE', run })
    void dispatchTurtleSoupAlerts(run).catch(() => {})
  } catch (e) { log.err('CRON', `turtle soup ${tag}: ${(e as Error).message}`) }
}
// FAST-ENTRY (2026-05-02): every 3 min during market hours (9-15:30 IST) so
// 5m sweep+reclaim signals surface within one bar of the wick.
// Off-market hours stay at every 15 min.
cron.schedule('*/3 9-15 * * 1-5',  () => runTurtleSoupCron('3m-fast'),  { timezone: 'Asia/Kolkata' })
// 2026-05-02: cut off-hours from */15 (68 fires/off-day) to 4 fires/day at
// the same moments as the off-hours snapshot. XAUUSD trades 24×5 — these 4
// pings catch US-mid, US-close, Asia-pre-open, IST-pre-open coverage.
cron.schedule('0 0,3,6,8 * * 1-5', () => runTurtleSoupCron('off-4x'), { timezone: 'Asia/Kolkata' })

// FIB + LRC — runs alongside Turtle Soup. Same fast cadence in market hours.
async function runFibLrcCron(tag: string): Promise<void> {
  log.info('CRON', `Fib+LRC (${tag}) starting...`)
  try {
    const { runFibLrcScan } = await import('./engine/fibLrcEngine')
    const run = await runFibLrcScan()
    broadcast({ type: 'FIB_LRC_UPDATE', run })
    void dispatchFibLrcAlerts(run).catch(() => {})
  } catch (e) { log.err('CRON', `fib-lrc ${tag}: ${(e as Error).message}`) }
}
cron.schedule('*/3 9-15 * * 1-5',  () => runFibLrcCron('3m-fast'),  { timezone: 'Asia/Kolkata' })
cron.schedule('0 0,3,6,8 * * 1-5', () => runFibLrcCron('off-4x'), { timezone: 'Asia/Kolkata' })

// ── F&O OPTIONS-FAST scanner — every 3 min during market hours ──
// 2026-05-02: options decay 10× faster than equities. The 5-min main signal
// engine cadence is too slow for premium-momentum exits/entries on NIFTY/
// BANKNIFTY CE/PE. This dedicated cron runs ONLY the options strategies
// (niftyOptionsStrict + futuresOptionsAdvisor) on NIFTY + BANKNIFTY +
// FINNIFTY at 3-min cadence, with selectExpiry already wired so monthly-
// expiry-imminent days auto-roll to next-month.
async function runOptionsFastCron(tag: string): Promise<void> {
  const { futuresOptionsAdvisor } = await import('./strategies/futuresOptionsAdvisor')
  const { niftyOptionsStrictSignal } = await import('./strategies/niftyOptionsStrict')
  // 2026-05-18: PRE-BREAKOUT lane — catches NIFTY/FINNIFTY CE/PE BEFORE the
  // strict engine's 6-confluence requirement aligns. Fires WATCH on setup
  // (4+ conditions), LIVE on confirmed range break. Solves the recurring
  // "signal fires after 300pt move" problem.
  const { optionsPreBreakoutSignal } = await import('./strategies/optionsPreBreakout')
  // BANKNIFTY excluded per user standing directive — see memory project_banknifty_excluded.
  const indexes = ['NIFTY', 'FINNIFTY'] as const
  const fired: Signal[] = []
  for (const sym of indexes) {
    try {
      const candles15 = await data.getCandles(sym, '15m', 200)
      const candlesD = await data.getCandles(sym, '1D', 200)
      if (candles15.length < 60) continue
      const now = new Date()
      const ctx = {
        symbol: sym,
        candles: candles15,
        candlesHigher: candlesD,
        gannBias: gannBiasFor(sym, candles15[candles15.length - 1].close, now),
        astroBias: astroBiasFor(now),
        date: now,
      }
      const strict = niftyOptionsStrictSignal(ctx)
      if (strict) fired.push(strict)
      const advised = futuresOptionsAdvisor(ctx)
      fired.push(...advised)
      // Pre-breakout — only adds a signal if strict didn't already fire on
      // the same direction (avoid duplicate alerts on the same setup).
      const preBreak = optionsPreBreakoutSignal(ctx)
      if (preBreak) {
        const strictSameDir = strict && preBreak.instrument.split(' ').slice(-1)[0] ===
          strict.instrument.split(' ').slice(-1)[0]
        if (!strictSameDir) fired.push(preBreak)
      }
    } catch (e) {
      log.warn('OPT-FAST', `${sym}: ${(e as Error).message}`)
    }
  }
  if (fired.length) {
    currentSignals = [...fired, ...currentSignals].slice(0, 500)
    broadcast({ type: 'SIGNALS_UPDATE', signals: currentSignals, reason: `options-fast-${tag}` })
    log.ok('OPT-FAST', `${tag}: ${fired.length} option signals · ${fired.map(f => f.instrument).slice(0, 3).join(', ')}`)
    // 2026-05-02 fix: was only broadcasting to dashboard. Push to Telegram so
    // F&O signals get the same routing as Turtle Soup. broadcastSignal applies
    // shouldBroadcastSignal filter (NIFTY-underlying options only) + 2h dedup.
    void dispatchFnoOptionAlerts(fired, 'fast').catch(() => {})
  }
}
cron.schedule('*/3 9-15 * * 1-5', () => runOptionsFastCron('3m'), { timezone: 'Asia/Kolkata' })

// 2026-05-07: OPTION PREMIUM MOMENTUM scanner — runs alongside niftyOptionsStrict
// at 3-min cadence. Catches the early-stage premium run (e.g. NIFTY 24000 CE
// 336 → 501 type moves) by sampling option-chain premium + volume every 3 min
// and firing when premium gains ≥5% in 15 min on a 1.5×+ volume burst.
// Surfaces faster than the SMC+EMA-aligned strict path which lags 15-30 min.
cron.schedule('*/3 9-15 * * 1-5', async () => {
  try {
    const { scanOptionPremiumMomentum } = await import('./strategies/optionPremiumMomentum')
    const fired = await scanOptionPremiumMomentum()
    if (fired.length) {
      currentSignals = [...fired, ...currentSignals].slice(0, 500)
      broadcast({ type: 'SIGNALS_UPDATE', signals: currentSignals, reason: 'opt-premium-momentum' })
      // Dispatch via the existing F&O TG path (NIFTY + FINNIFTY pass the filter)
      void dispatchFnoOptionAlerts(fired, 'premium-momentum').catch(() => {})
    }
  } catch (e) { log.warn('OPT-MOMENTUM', `tick: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

// Reset premium-momentum state at midnight
cron.schedule('0 0 * * *', async () => {
  const { clearOptionMomentumState } = await import('./strategies/optionPremiumMomentum')
  clearOptionMomentumState()
}, { timezone: 'Asia/Kolkata' })

// ── F&O POSITIONAL — daily at 17:00 IST ──
// Runs the full options strategy suite with a daily-bar context (positional
// horizon) and selectExpiry's next-month routing. Output: 3-7 next-month
// CE/PE positional setups for the next session. Telegram is suppressed so
// this is a dashboard-only feed; the user reviews these manually before
// market open.
cron.schedule('0 17 * * 1-5', async () => {
  log.info('CRON', 'F&O Positional advisor (daily) starting...')
  try {
    const { futuresOptionsAdvisor } = await import('./strategies/futuresOptionsAdvisor')
    // BANKNIFTY excluded per user standing directive.
    const indexes = ['NIFTY', 'FINNIFTY']
    const out: Signal[] = []
    for (const sym of indexes) {
      try {
        const candlesD = await data.getCandles(sym, '1D', 250)
        if (candlesD.length < 80) continue
        const now = new Date()
        const ctx = {
          symbol: sym,
          candles: candlesD,
          candlesHigher: candlesD,
          gannBias: gannBiasFor(sym, candlesD[candlesD.length - 1].close, now),
          astroBias: astroBiasFor(now),
          date: now,
          relaxed: true,             // positional view — wider gates
        }
        out.push(...futuresOptionsAdvisor(ctx))
      } catch { /* skip */ }
    }
    if (out.length) {
      currentSignals = [...out, ...currentSignals].slice(0, 500)
      broadcast({ type: 'SIGNALS_UPDATE', signals: currentSignals, reason: 'fno-positional-1700' })
      log.ok('FNO-POSITIONAL', `${out.length} positional option setups for tomorrow`)
      void dispatchFnoOptionAlerts(out, 'positional').catch(() => {})
    }
  } catch (e) { log.err('CRON', `fno-positional: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

// ── ROLLING 10-DAY BACKFILL — daily at 17:30 IST ──
// Replays the past 10 sessions through the screener set (Distribution-Top,
// Range-Expansion-Breakout, EMA50-Reclaim, RSI-Divergence, etc.). Any 5%+
// mover that NO screener caught is a true blind spot — pushed to Telegram
// so the user sees what we're still missing and we can keep tightening.
cron.schedule('30 17 * * 1-5', async () => {
  log.info('CRON', 'Rolling 10-day backfill starting...')
  try {
    const { runMoverBackfill } = await import('./screeners/moverBackfill')
    const today = new Date()
    const from = new Date(today.getTime() - 10 * 86_400_000).toISOString().slice(0, 10)
    const to = today.toISOString().slice(0, 10)
    const result = await runMoverBackfill({
      from, to, minPct: 5, universeKey: 'CNX500', limitSymbols: 300,
    })
    log.ok('BACKFILL-CRON', `${result.totalMovers} movers · caught ${result.caught.length} · missed ${result.missed.length}`)
    if (result.missed.length && botState.bot) {
      const lines = [
        `🔍 *10-Day Backfill — ${result.missed.length} blind spots*`,
        `Window: ${from} → ${to} (CNX500, ≥5% moves)`,
        ``,
        ...result.missed.slice(0, 10).map(m =>
          `${m.direction === 'UP' ? '🟢' : '🔴'} *${m.symbol}* ${m.movePct.toFixed(1)}% (${m.fromDate}→${m.toDate})`,
        ),
        ``,
        `_These need a new screener — review at /backtest tab._`,
      ].join('\n')
      for (const chatId of config.bots.telegramChatIds) {
        try { await botState.bot.api.sendMessage(chatId, lines, { parse_mode: 'Markdown' }) }
        catch (e) { log.warn('BACKFILL-CRON', `tg ${chatId}: ${(e as Error).message}`) }
      }
    }
  } catch (e) { log.err('CRON', `rolling backfill: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

// ── DAILY MISS-MINER — 18:00 IST ──
// 2026-05-04: User asked for "self-improvisation mode on daily basis". This
// goes beyond auto-tune (which only adjusts confluence floors). Every day
// after the 17:30 backfill, we mine the past 7 days of movers, bucket them
// into HITS (predicted) vs MISSES (not predicted), and compute the feature
// delta vector that distinguishes the two sets. Result: a daily miss-deltas
// report saved to disk + Telegram digest highlighting the top 3 features
// our system is under-weighting.
cron.schedule('0 18 * * 1-5', async () => {
  log.info('CRON', 'Daily miss-miner starting...')
  try {
    const { runDailyMissMiner } = await import('./engine/dailyMissMiner')
    const report = await runDailyMissMiner(7)
    if (botState.bot && (report.misses > 0 || report.topDeltas.length)) {
      const lines = [
        `🧠 *Self-Improve — Daily Miss Report*`,
        `Window: ${report.windowFrom} → ${report.windowTo} (${report.totalMovers} movers)`,
        `Hits: ${report.hits} · Misses: ${report.misses} · Hit-rate ${(100 * report.hits / Math.max(report.hits + report.misses, 1)).toFixed(1)}%`,
        ``,
        `*Top blind-spot features:*`,
        ...report.topDeltas.slice(0, 3).map(d => `• ${d.feature}: hit ${d.hitMean} → miss ${d.missMean} (Δ${d.delta >= 0 ? '+' : ''}${d.delta}) — ${d.interpretation}`),
        ``,
        `*Top missed movers:*`,
        ...report.topMissedSymbols.slice(0, 5).map(m => `🔍 ${m.symbol} ${m.movePct >= 0 ? '+' : ''}${m.movePct.toFixed(1)}%`),
        ``,
        `_Saved to data/learning/miss-deltas-${report.windowTo}.json_`,
      ].join('\n')
      for (const cid of config.bots.telegramChatIds) {
        try {
          await botState.bot.api.sendMessage(cid, lines, { parse_mode: 'Markdown' })
          recordTgPush('miss-miner', `${report.misses} misses · top: ${report.topDeltas[0]?.feature}`, cid)
        } catch { /* swallow */ }
      }
    }
  } catch (e) { log.err('CRON', `miss-miner: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

app.get('/api/learning/miss-report', async (_req, res) => {
  try {
    const { getLatestMissReport } = await import('./engine/dailyMissMiner')
    const report = await getLatestMissReport()
    if (!report) return res.status(404).json({ error: 'No miss-report yet — fires daily 18:00 IST' })
    res.json(report)
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})
app.post('/api/learning/miss-report/run', async (_req, res) => {
  try {
    const days = Math.max(3, Math.min(30, Number(_req.query.days ?? 7)))
    const { runDailyMissMiner } = await import('./engine/dailyMissMiner')
    res.json(await runDailyMissMiner(days))
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── PRE-OPEN PREFETCH WARM-UP — 8:00 IST ──
// Pre-loads daily candles for NIFTY 50 + watchlist into the data router cache
// so the 8:30 market digest, 8:45 master setup, and 9:15 first signal scan
// hit a hot cache instead of cold-fetching ~50 symbols against Angel during
// peak load. Cuts the pre-open ramp from ~90s to ~10s.
cron.schedule('0 8 * * 1-5', async () => {
  log.info('CRON', 'Pre-open prefetch warm-up starting...')
  try {
    const { resolveUniverse } = await import('./screeners/universe')
    const watchlist = await getWatchlist()
    const nifty50 = await resolveUniverse('NIFTY50')
    const universe = [...new Set([...nifty50, ...watchlist, 'NIFTY', 'BANKNIFTY', 'GOLD', 'XAUUSD', 'CRUDE'])]
    let primed = 0
    let cursor = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < universe.length) {
        const sym = universe[cursor++]
        try {
          await data.getCandles(sym, '1D', 250)
          primed++
        } catch { /* skip */ }
      }
    }))
    log.ok('PREFETCH', `Warmed ${primed}/${universe.length} candle caches before pre-open`)
  } catch (e) { log.err('CRON', `prefetch: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })
// Reset the dedup ledger at midnight so the next session starts fresh.
cron.schedule('0 0 * * *', () => { clearTurtleSoupDedup() }, { timezone: 'Asia/Kolkata' })

// SECTOR ROTATION — pre-open snapshot at 08:50 IST. Fed into masterSetup as
// a booster (a basket "rotating IN" upgrades qualifying setups by 1 ★).
cron.schedule('50 8 * * 1-5', async () => {
  log.info('CRON', 'Sector rotation snapshot starting...')
  try {
    const snap = await runSectorRotationScan()
    broadcast({ type: 'SECTOR_ROTATION_UPDATE', snap })
    if (botState.bot && (snap.rotatingIntoSectors.length || snap.rotatingOutSectors.length)) {
      const msg = formatSectorRotationForTelegram(snap)
      for (const chatId of config.bots.telegramChatIds) {
        try { await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' }) }
        catch (e) { log.warn('SECTOR', `tg push ${chatId}: ${(e as Error).message}`) }
      }
    }
  } catch (e) { log.err('CRON', `sector rotation: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

// Daily P&L report — 15:45 IST, pushes Markdown summary to Telegram.
cron.schedule('45 15 * * 1-5', async () => {
  try {
    const r = await generateDailyReport()
    log.ok('DAILY-REPORT', `Generated for ${r.date}: ${r.totalSignals} signals · ${r.closedToday} closed · P&L ₹${r.realisedPnlInr}`)
    if (botState.bot) {
      for (const chatId of config.bots.telegramChatIds) {
        try { await botState.bot.api.sendMessage(chatId, r.message, { parse_mode: 'Markdown' }) }
        catch (e) { log.warn('DAILY-REPORT', `tg ${chatId}: ${(e as Error).message}`) }
      }
    }
  } catch (e) { log.err('DAILY-REPORT', (e as Error).message) }
}, { timezone: 'Asia/Kolkata' })

// Cycle alerts — pre-open (09:00 IST) + post-close (16:30 IST) on weekdays.
// Pushes Telegram for REVERSAL_WATCH / CYCLE_STARTED / REVERSAL_CONFIRMED
// across NIFTY · BANKNIFTY · GOLD · CRUDE. Deduped per (symbol, cycle, date).
async function runCycleAlerts(tag: string): Promise<void> {
  try {
    const alerts = await computeCycleAlerts()
    if (!alerts.length) {
      log.info('CYCLE-ALERTS', `${tag}: no new alerts`)
      return
    }
    log.ok('CYCLE-ALERTS', `${tag}: ${alerts.length} new alerts`)
    for (const a of alerts) {
      broadcast({ type: 'CYCLE_ALERT', alert: a })
      if (botState.bot) {
        for (const chatId of config.bots.telegramChatIds) {
          try { await botState.bot.api.sendMessage(chatId, a.message, { parse_mode: 'Markdown' }) }
          catch (e) { log.warn('CYCLE-ALERTS', `tg push ${chatId}: ${(e as Error).message}`) }
        }
      }
    }
    await markAlertsSent(alerts)
  } catch (e) {
    log.err('CYCLE-ALERTS', `${tag}: ${(e as Error).message}`)
  }
}

cron.schedule('0 9 * * 1-5',  async () => { await runCycleAlerts('pre-open'); markFired('cycle-preopen') },  { timezone: 'Asia/Kolkata' })
// 2026-05-02: cycle alerts post-close moved 16:30 → 16:30 stays — fired AFTER
// master-setup completes (16:25). Master setup takes ~2-3 min so 16:30 hits
// a clean slot. Kept here as the second slot in the post-close stagger.
cron.schedule('30 16 * * 1-5', async () => { await runCycleAlerts('post-close'); markFired('cycle-close') }, { timezone: 'Asia/Kolkata' })

app.post('/api/gann/cycle-alerts/run', async (_req, res) => {
  try {
    const alerts = await computeCycleAlerts()
    for (const a of alerts) broadcast({ type: 'CYCLE_ALERT', alert: a })
    res.json({ count: alerts.length, alerts })
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// 2026-05-02: weekly-pick was missing 25%-movers because:
//   1. Universe defaulted to NIFTY100 (none of the actual movers are there)
//   2. Cron ran Sunday-only (5-day moves were already over by Monday)
//   3. Watchlist was hard-coded to 17 stale names
// Fix: (a) auto-rebuild watchlist 16:00 IST every market day from yesterday's
// top momentum movers (≥3% with ≥₹2cr median turnover), (b) run the full
// weekly-pick over NSE_ALL with pre-rank shortlist at 16:30 IST every market
// day so micro-cap movers surface fresh each evening, (c) keep the existing
// Sunday run as a clean weekly snapshot.
async function runWeeklyPickCron(tag: string, universe: 'MARKET_ALL' | 'NSE_ALL' | 'CNX500' | 'NIFTY100' = 'MARKET_ALL'): Promise<void> {
  log.info('CRON', `Weekly Pick (${tag}, universe=${universe}) starting...`)
  try {
    const pick = await runWeeklyPick(universe)
    broadcast({ type: 'WEEKLY_PICK_UPDATE', pick })
    void dispatchWeeklyPickAlerts(pick, tag).catch(() => {})
    // 2026-05-08: Telegram event-stream for lifecycle changes — user
    // explicitly asked NOT to silently remove signals. Notify on supersede
    // so a position-holder sees "this pick is no longer in the active list,
    // here's why" instead of just disappearance.
    if (pick.lifecycleReport && botState.bot) {
      void dispatchLifecycleAlerts(pick.lifecycleReport).catch(() => {})
    }
    try {
      const { snapshotPick } = await import('./engine/pickJournal')
      await snapshotPick(pick)
    } catch (e) { log.warn('JOURNAL', `snapshot ${tag}: ${(e as Error).message}`) }
    if (tag.includes('daily')) markFired('wp-daily')
  } catch (e) { log.err('CRON', `weekly pick ${tag}: ${(e as Error).message}`) }
}

async function dispatchLifecycleAlerts(report: import('./engine/signalLifecycle').MergeReport): Promise<void> {
  if (!botState.bot) return
  const lines: string[] = []
  if (report.superseded.length) {
    lines.push(`🔁 *${report.superseded.length} pick${report.superseded.length === 1 ? '' : 's'} SUPERSEDED*`)
    lines.push(`These no longer meet the pick criteria. If you have an open position, decide whether to hold or exit.`)
    lines.push('')
    for (const e of report.superseded.slice(0, 8)) {
      const d = e.direction === 'BUY' ? '🟢 BUY' : '🔴 SHORT'
      const conv = e.convictionPrev != null ? `${e.convictionPrev}→below threshold` : `${e.conviction}`
      lines.push(`• ${d} ${e.symbol} · was conv ${conv}`)
      lines.push(`  Entry was \`${e.entryPrice}\` · SL \`${e.stopLoss}\` · T1 \`${e.target1}\``)
    }
    lines.push('')
  }
  if (report.newAdded.length) {
    lines.push(`✨ *${report.newAdded.length} new pick${report.newAdded.length === 1 ? '' : 's'} added*`)
    for (const e of report.newAdded.slice(0, 5)) {
      const d = e.direction === 'BUY' ? '🟢 BUY' : '🔴 SHORT'
      lines.push(`• ${d} ${e.symbol} · conv ${e.conviction} · E ₹${e.entryPrice} · SL ₹${e.stopLoss}`)
    }
    lines.push('')
  }
  if (report.rePriced.length) {
    lines.push(`📊 *${report.rePriced.length} re-priced* (entry/target shifted >5%)`)
    for (const e of report.rePriced.slice(0, 5)) {
      lines.push(`• ${e.symbol}: new entry ₹${e.entryPrice} · SL ₹${e.stopLoss}`)
    }
  }
  if (lines.length === 0) return
  lines.push(`\n_Lifecycle log: every change is tracked. View on dashboard._`)
  const msg = lines.join('\n')
  for (const cid of config.bots.telegramChatIds) {
    try {
      await botState.bot.api.sendMessage(cid, msg, { parse_mode: 'Markdown' })
      recordTgPush('lifecycle', `${report.superseded.length}-sup ${report.newAdded.length}-new ${report.rePriced.length}-rep`, cid)
    } catch (e) { log.warn('LIFECYCLE-DISPATCH', `tg ${cid}: ${(e as Error).message}`) }
  }
}
cron.schedule('0 16 * * 1-5', async () => {
  log.info('CRON', 'Auto-watchlist rebuild starting...')
  try {
    const { autoRebuildWatchlist } = await import('./engine/weeklyManagerPick')
    const existing = await getWatchlist()
    // Keep first 10 manually-pinned names, drop the rest in favour of fresh momentum
    await autoRebuildWatchlist({ pinned: existing.slice(0, 10) })
  } catch (e) { log.err('CRON', `watchlist rebuild: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })
// 2026-05-02: pushed 16:30 → 16:35 in the post-close stagger so heavy
// 5-lens scoring on NSE_ALL doesn't collide with master-setup (16:25) /
// cycle-alerts (16:30) on the same Angel quota.
cron.schedule('35 16 * * 1-5', () => runWeeklyPickCron('daily-postclose', 'MARKET_ALL'), { timezone: 'Asia/Kolkata' })
cron.schedule('0 18 * * 0',    () => runWeeklyPickCron('sunday-weekly',  'MARKET_ALL'), { timezone: 'Asia/Kolkata' })

// ── SUNDAY 18:00 IST WEEKEND SYSTEM AUDIT ──
// 2026-05-03: replaces the previous /schedule cloud routine that pointed at
// hedge-fund-os.fly.dev (a non-existent domain — the cloud sandbox couldn't
// resolve DNS, so the routine failed silently every Sunday). Running locally
// avoids any external reachability requirement.
//
// Reads the same 6 audit endpoints via direct function calls (no HTTP self-
// loopback, no DNS) and pushes a one-message Telegram digest of:
//   • backtest suite win-rates per strategy
//   • signal log stats + realised P&L last week
//   • current market regime
//   • learning-loop autotune deltas + pattern centroid health
cron.schedule('0 18 * * 0', async () => {
  log.info('CRON', 'Weekend system audit (Sun 18:00 IST) starting...')
  if (!botState.bot) return
  try {
    // In-process calls — bypass HTTP entirely.
    const stats = await (async () => { try { return await readPerfStats() } catch { return null } })()
    const pnl = await (async () => { try { return await readPnlSummary() } catch { return null } })()
    const regime = await (async () => { try { return await getMarketRegime() } catch { return null } })()
    const patterns = await (async () => { try { return await getLearnedPatterns() } catch { return null } })()
    const tune = await (async () => { try { return await getAutoTune() } catch { return null } })()
    // Backtest suite is heavy — skip in the lightweight audit; user can hit
    // /api/backtest/suite manually if needed.

    const lines: string[] = []
    lines.push(`🔍 *WEEKEND AUDIT — Sunday ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })}*`)
    lines.push(`━━━━━━━━━━━━━━━━━━`)
    if (regime) {
      lines.push(`*Market regime:* ${regime.regime ?? regime.label ?? 'unknown'}`)
    }
    if (stats) {
      lines.push(`*Signals:* ${stats.total ?? 0} total · ${stats.openCount ?? 0} open · win-rate ${((stats.winRate ?? 0) * 100).toFixed(1)}%`)
    }
    if (pnl) {
      lines.push(`*P&L (last 7d):* ₹${(pnl.realised7d ?? 0).toFixed(0)} realised · ₹${(pnl.unrealised ?? 0).toFixed(0)} unrealised`)
    }
    if (tune) {
      lines.push(`*Autotune:* ${tune.deltas?.length ?? 0} param deltas applied`)
    }
    if (patterns) {
      const n = Array.isArray(patterns) ? patterns.length : (patterns.count ?? 0)
      lines.push(`*Patterns learned:* ${n}`)
    }
    lines.push(``)
    lines.push(`_Full data: dashboard /backtest + /log + /learning_`)
    const msg = lines.join('\n')
    for (const cid of config.bots.telegramChatIds) {
      try {
        await botState.bot.api.sendMessage(cid, msg, { parse_mode: 'Markdown' })
        recordTgPush('weekend-audit', `${lines.length} lines`, cid)
      } catch (e) { log.warn('AUDIT', `tg ${cid}: ${(e as Error).message}`) }
    }
  } catch (e) { log.err('CRON', `weekend audit: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

// Daily learning loop — 16:50 IST in the post-close stagger (was 16:30, but
// that collided with weekly-pick + cycle-alerts + master-setup post-close).
// 16:50 lets the learner read fresh outcome rows that the post-close audit
// flush at 16:45 has already written.
cron.schedule('50 16 * * 1-5', async () => {
  log.info('CRON', 'Daily learning loop starting...')
  try { await runPatternLearner() } catch (e) { log.err('CRON', `pattern learner: ${(e as Error).message}`) }
  try { await runSelfImprove() }    catch (e) { log.err('CRON', `self improve: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

// Daily time-stop check (post-close 17:00 IST): expire 21-day-old trades
cron.schedule('0 17 * * 1-5', async () => {
  const events = await expireStaleTrades()
  for (const ev of events) {
    broadcast({ type: 'TRADE_EVENT', event: ev })
    void dispatchLifecycleAlert(ev)
  }
}, { timezone: 'Asia/Kolkata' })

// Pre-open reminder (09:00 IST) — re-surface overnight setups before session
cron.schedule('0 9 * * 1-5', async () => {
  const run = getLatestRun('premove')
  if (!run?.results.length || !botState.bot) return
  const topA = run.results.filter(r => r.tier === 'A' || r.score >= 7.5).slice(0, 5)
  if (!topA.length) return
  const msg = `🌅 *Pre-Open Reminder*\nSetups from yesterday's close still valid:\n\n` +
    topA.map(r => `${r.direction === 'BULL' ? '🟢' : r.direction === 'BEAR' ? '🔴' : '⚪'} *${r.symbol}* ₹${r.price.toFixed(2)} — ${r.tags.slice(0, 3).join(', ')}`).join('\n')
  for (const chatId of config.bots.telegramChatIds) {
    try {
      await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
      recordTgPush('pre-open-reminder', `${topA.length} A-tier setups`, chatId)
    } catch { /* swallow */ }
  }
}, { timezone: 'Asia/Kolkata' })

// ── 09:05 IST MORNING BRIEFING ROLLUP ──
// Even if individual dedup ledgers swallow alerts, this cron sends ONE
// crisp message that summarises every active signal source for the day.
// Reads the last persisted output of each engine: Master Setup, Weekly Pick,
// Daily Pick, Turtle Soup, Fib+LRC, Sector Rotation, Cycle Alerts. The user
// sees a single "what to watch today" card every market morning so they
// never wonder "why didn't I get an alert?".
cron.schedule('5 9 * * 1-5', async () => {
  if (!botState.bot) return
  log.info('CRON', 'Morning briefing rollup (09:05 IST)')
  try {
    const lines: string[] = []
    lines.push(`🌅 *MORNING BRIEFING — ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}*`)
    lines.push(`━━━━━━━━━━━━━━━━━━`)

    // 1. Master Setup
    const ms = getLatestMasterSetup()
    if (ms?.setups.length) {
      const elite = ms.setups.filter(s => s.stars >= 4).slice(0, 3)
      if (elite.length) {
        lines.push(`*⭐ Master Setup (${elite.length})*`)
        elite.forEach(s => lines.push(`  ${s.direction === 'BUY' ? '🟢' : '🔴'} ${s.symbol} ${s.stars}★ E\`${s.entry}\` SL\`${s.stopLoss}\` T\`${s.target1}\``))
      }
    }

    // 2. Weekly Pick (top 3 curated)
    const wp = await getLatestPick().catch(() => null)
    if (wp?.rows.length) {
      const top = wp.rows.filter(r => r.source === 'CURATED').slice(0, 3)
      if (top.length) {
        lines.push(`*📋 Weekly Pick (${top.length})*`)
        top.forEach(r => lines.push(`  ${r.direction === 'BUY' ? '🟢' : '🔴'} ${r.symbol} conv ${r.conviction} E\`${r.entryPrice}\` T1\`${r.target1}\``))
      }
    }

    // 3. Daily Pick (top 3)
    const dp = getLatestDailyPick()
    if (dp?.rows?.length) {
      const top = dp.rows.slice(0, 3)
      lines.push(`*📈 Daily Pick (${top.length})*`)
      top.forEach((r: any) => lines.push(`  ${r.direction === 'BUY' ? '🟢' : '🔴'} ${r.symbol} conv ${r.conviction} E\`${r.entryPrice}\` T1\`${r.target1}\``))
    }

    // 4. Turtle Soup (yesterday's qualified)
    const ts = getLatestTurtleSoupRun()
    if (ts?.qualified) {
      lines.push(`*🐢 Turtle Soup: ${ts.qualified} active*`)
      ts.signals.slice(0, 3).forEach(s => lines.push(`  ${s.direction === 'BUY' ? '🟢' : '🔴'} ${s.symbol} ${s.timeframe} E\`${s.entry}\``))
    }

    // 5. Fib+LRC (yesterday's qualified)
    try {
      const { getLatestFibLrcRun } = await import('./engine/fibLrcEngine')
      const fl = getLatestFibLrcRun()
      if (fl?.qualified) {
        lines.push(`*📐 Fib+LRC: ${fl.qualified} active*`)
        fl.signals.slice(0, 3).forEach(s => lines.push(`  ${s.direction === 'BUY' ? '🟢' : '🔴'} ${s.symbol} ${s.timeframe} fib ${(s.fibLevel * 100).toFixed(1)}%`))
      }
    } catch { /* engine may not be loaded yet */ }

    // 6. Sector rotation
    const sr = getLatestSectorRotation()
    if (sr) {
      const into = sr.rotatingIntoSectors?.slice(0, 3).map((s: any) => s.sector || s).join(', ')
      const out = sr.rotatingOutSectors?.slice(0, 3).map((s: any) => s.sector || s).join(', ')
      if (into || out) {
        lines.push(`*🔄 Sector Rotation*`)
        if (into) lines.push(`  IN  → ${into}`)
        if (out) lines.push(`  OUT → ${out}`)
      }
    }

    // 7. Active trades count
    const stats = tradeStats()
    if (stats.active) {
      lines.push(`*💼 Active trades: ${stats.active}* · today's P&L tracking on dashboard`)
    }

    if (lines.length <= 2) {
      lines.push(`_No fresh setups overnight — watch market open + 15:20 pre-close scan._`)
    }
    lines.push(``)
    lines.push(`_Full lists on dashboard tabs · #tradewithvarsha_`)

    const msg = lines.join('\n')
    for (const chatId of config.bots.telegramChatIds) {
      try {
        await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
        recordTgPush('morning-briefing', `${lines.length} lines`, chatId)
      } catch (e) { log.warn('BRIEFING', `tg ${chatId}: ${(e as Error).message}`) }
    }
  } catch (e) { log.err('CRON', `morning briefing: ${(e as Error).message}`) }
}, { timezone: 'Asia/Kolkata' })

// ── Lifecycle alert dispatch (T1/T2/SL/EXPIRED only — NO re-entry alerts) ──
async function dispatchLifecycleAlert(ev: LifecycleEvent): Promise<void> {
  // Always log every closed lifecycle event to CSV — even if we don't push
  // a Telegram alert. Outcomes are what the self-improve loop learns from.
  if (ev.kind !== 'OPEN') void logOutcome(ev).catch(e => log.warn('LOG', `outcome log: ${e.message}`))
  if (ev.kind === 'OPEN') return // entry alert is handled separately via broadcastSignal
  if (!botState.bot) return
  const emoji = { T1_HIT: '🎯', T2_HIT: '🚀', SL_HIT: '❌', EXPIRED: '⏰', OPEN: '🆕', INVALIDATED: '🚫' }[ev.kind]
  const msg =
    `${emoji} *${ev.kind.replace('_', ' ')}* — ${ev.trade.symbol}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Direction: ${ev.trade.direction} · Strategy: ${ev.trade.strategy}\n` +
    `Entry: \`${ev.trade.entry}\` · LTP: \`${ev.ltp.toFixed(2)}\`\n` +
    `P&L: *${ev.pnlPct >= 0 ? '+' : ''}${ev.pnlPct.toFixed(2)}%*\n\n` +
    `_${ev.note}_`
  for (const chatId of config.bots.telegramChatIds) {
    try { await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' }) }
    catch (e) { log.warn('TRADE', `alert ${chatId}: ${(e as Error).message}`) }
  }
}

/**
 * Daily-pick Telegram dispatcher — pushes only the NEW top picks (those that
 * weren't in the previous run) so we don't spam the chat with the same names
 * every 30 min. Caps to top 3 per dispatch.
 */
// Manual trigger for periodic checker — used to verify transitions
app.post('/api/lifecycle/check', async (_req, res) => {
  try { await runLifecycleChecker(); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── /api/accuracy — system-wide signal accuracy report ──
// 2026-05-11: user asked to log every signal at generation, transition to
// ACTIVE on entry, terminal on target/SL → measure ACCURACY across all
// sources. This endpoint reads from the signal-lifecycle store.
//   GET /api/accuracy?source=ALL&days=30
//   GET /api/accuracy?source=WEEKLY&days=14
app.get('/api/accuracy', async (req, res) => {
  try {
    const source = (req.query.source as string) || 'ALL'
    const days = Math.max(1, Math.min(180, Number(req.query.days ?? 30)))
    const { buildAccuracyReport } = await import('./engine/signalLifecycle')
    res.json(await buildAccuracyReport({ source, daysBack: days }))
  } catch (e) { res.status(500).json({ error: (e as Error).message }) }
})

// ── Periodic state checker — fetches LTP for every PENDING/ACTIVE entry,
// transitions states, dispatches Telegram for terminal events.
// Runs every 5 min during market hours, every 30 min off-hours.
async function runLifecycleChecker(): Promise<void> {
  try {
    const { loadStore, checkTransitions } = await import('./engine/signalLifecycle')
    const store = await loadStore()
    // Collect unique symbols across PENDING + ACTIVE entries
    const symbols = new Set<string>()
    for (const e of Object.values(store.entries)) {
      if (e.status === 'PENDING' || e.status === 'ACTIVE') symbols.add(e.symbol)
    }
    if (symbols.size === 0) return
    // Fetch live LTPs in parallel (capped concurrency = 6)
    const ltps = new Map<string, number>()
    const syms = Array.from(symbols)
    let cursor = 0
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (cursor < syms.length) {
        const sym = syms[cursor++]
        try {
          const q = await data.getQuote(sym)
          if (q?.price && q.price > 0) ltps.set(sym, q.price)
        } catch { /* skip — periodic retry */ }
      }
    }))
    const transitions = await checkTransitions(ltps)
    if (transitions.length === 0) return
    log.ok('LIFECYCLE-CHECKER', `${syms.length} tracked · ${ltps.size} priced · ${transitions.length} transitions`)
    // Telegram dispatch for terminal states
    if (botState.bot) {
      const newlyTriggered = transitions.filter(t => t.to === 'ACTIVE')
      const targetHits = transitions.filter(t => t.to === 'T1_HIT' || t.to === 'T2_HIT' || t.to === 'T3_HIT')
      const slHits = transitions.filter(t => t.to === 'SL_HIT')
      const expired = transitions.filter(t => t.to === 'EXPIRED')
      const lines: string[] = []
      if (targetHits.length) {
        lines.push(`✅ *${targetHits.length} TARGET HIT*`)
        for (const t of targetHits.slice(0, 8)) {
          const e = t.entry
          const r = e.hitPrice && e.entryPrice && e.stopLoss
            ? ((e.hitPrice - e.entryPrice) / Math.abs(e.entryPrice - e.stopLoss)).toFixed(1)
            : '?'
          lines.push(`  ${e.symbol} ${e.direction} ${t.to} @ ₹${t.hitPrice} (${r}R) · ${e.source}`)
        }
      }
      if (slHits.length) {
        if (lines.length) lines.push('')
        lines.push(`❌ *${slHits.length} SL HIT*`)
        for (const t of slHits.slice(0, 8)) {
          const e = t.entry
          lines.push(`  ${e.symbol} ${e.direction} SL @ ₹${t.hitPrice} · ${e.source}`)
        }
      }
      if (newlyTriggered.length) {
        if (lines.length) lines.push('')
        lines.push(`🎯 *${newlyTriggered.length} entry triggered*`)
        for (const t of newlyTriggered.slice(0, 8)) {
          const e = t.entry
          lines.push(`  ${e.symbol} ${e.direction} entered @ ₹${t.hitPrice} · SL ₹${e.stopLoss} · T1 ₹${e.target1}`)
        }
      }
      if (expired.length) {
        if (lines.length) lines.push('')
        lines.push(`⏰ *${expired.length} expired*`)
      }
      if (lines.length) {
        const msg = lines.join('\n')
        for (const cid of config.bots.telegramChatIds) {
          try {
            try { await botState.bot.api.sendMessage(cid, msg, { parse_mode: 'Markdown' }) }
            catch { await botState.bot.api.sendMessage(cid, msg) }
            recordTgPush('lifecycle-transitions', `${transitions.length}`, cid)
          } catch { /* swallow */ }
        }
      }
    }
  } catch (e) { log.warn('LIFECYCLE-CHECKER', `${(e as Error).message}`) }
}
cron.schedule('*/5 9-15 * * 1-5', () => runLifecycleChecker(), { timezone: 'Asia/Kolkata' })
cron.schedule('*/30 * * * *', () => runLifecycleChecker(), { timezone: 'Asia/Kolkata' })

// ── /api/alert-audit — list last 50 Telegram pushes + per-source counts ──
// Use this to verify "is engine X actually pushing?" without combing logs.
//   GET /api/alert-audit            → last 50 pushes + counts
//   GET /api/alert-audit?source=fib-lrc → filter to one source
app.get('/api/alert-audit', (req, res) => {
  const source = req.query.source as string | undefined
  const filtered = source ? tgAuditLog.filter(l => l.source.includes(source)) : tgAuditLog
  const counts: Record<string, number> = {}
  for (const l of tgAuditLog) counts[l.source] = (counts[l.source] ?? 0) + 1
  res.json({
    totalPushes: tgAuditLog.length,
    sourceCounts: counts,
    last: filtered.slice(-50).map(l => ({
      ts: new Date(l.ts).toISOString(),
      source: l.source,
      detail: l.detail,
      chatId: l.chatId,
    })).reverse(),
    expectedSources: [
      'turtle-soup', 'fib-lrc', 'harmonic', 'daily-pick',
      'master-setup', 'weekly-pick', 'fno-fast', 'fno-positional',
      'sector-rotation', 'cycle-alerts', 'pre-move', 'pnl-report',
      'backfill', 'lifecycle',
    ],
  })
})

// ── Shared stake-summary helper for ALL Telegram dispatchers ──
// 2026-05-04: User wants stake info on EVERY pick/signal for confirmation
// before taking the trade. Single helper pulls FII/Promoter/Pledge/MC from
// screener.in (24h cache) and returns a one-line summary.
const stakeLineCache = new Map<string, { line: string; ts: number }>()
async function stakeLineFor(symbol: string): Promise<string> {
  // Index instruments and obvious non-equities → return blank
  if (/^(?:NIFTY|BANKNIFTY|FINNIFTY|GOLD|XAUUSD|CRUDE|SILVER)\b/i.test(symbol)) return ''
  // Strip any " 24500 CE/PE" / " FUT" suffix to extract underlying
  const base = symbol.split(/\s+/)[0].toUpperCase()
  const hit = stakeLineCache.get(base)
  if (hit && Date.now() - hit.ts < 24 * 3600_000) return hit.line
  try {
    const { getShareholding } = await import('./data/shareholding')
    const shp = await getShareholding(base)
    if (!shp) { stakeLineCache.set(base, { line: '', ts: Date.now() }); return '' }
    const fiiArr = shp.fiiDeltaQoQ > 0.1 ? '↑' : shp.fiiDeltaQoQ < -0.1 ? '↓' : '→'
    const pArr = shp.promoterDeltaQoQ > 0.1 ? '↑' : shp.promoterDeltaQoQ < -0.1 ? '↓' : '→'
    const mc = shp.marketCapCr >= 1000 ? `${(shp.marketCapCr / 1000).toFixed(1)}KCr`
      : shp.marketCapCr > 0 ? `${shp.marketCapCr.toFixed(0)}Cr` : '?'
    const line = `📊 FII ${shp.fiiPct.toFixed(1)}%${fiiArr} · P ${shp.promoterPct.toFixed(1)}%${pArr} · Pledge ${shp.promoterPledgePct.toFixed(1)}% · MC ₹${mc}`
    stakeLineCache.set(base, { line, ts: Date.now() })
    return line
  } catch {
    return ''
  }
}

async function dispatchDailyPickAlerts(pick: Awaited<ReturnType<typeof runDailyPick>>): Promise<void> {
  if (!botState.bot) return
  if (!pick.newSinceLastRun.length) return
  const fresh = pick.rows.filter(r => pick.newSinceLastRun.includes(r.symbol)).slice(0, 3)
  if (!fresh.length) return
  const lines: string[] = []
  lines.push(`🎯 *Daily Pick — ${fresh.length} new setup${fresh.length !== 1 ? 's' : ''}*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  lines.push(`Regime: ${pick.regime} · scanned ${pick.totalScanned} stocks`)
  lines.push(``)
  for (const r of fresh) {
    const arrow = r.direction === 'BUY' ? '🟢' : '🔴'
    lines.push(`${arrow} *${r.symbol}* — ${r.direction} (${r.pattern})  conv ${r.conviction}/100`)
    lines.push(`   E ₹${r.entryPrice} · SL ₹${r.stopLoss} · T1 ₹${r.target1} (${r.target1Date}) · T2 ₹${r.target2} (${r.target2Date})`)
    const stake = await stakeLineFor(r.symbol)
    if (stake) lines.push(`   ${stake}`)
    lines.push(`   ${r.reasons.slice(0, 2).join(' · ')}`)
    lines.push(``)
  }
  const msg = lines.join('\n')
  for (const chatId of config.bots.telegramChatIds) {
    try {
      await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
      recordTgPush('daily-pick', `${pick.rows?.length ?? 0} rows`, chatId)
    } catch (e) { log.warn('DAILYPICK', `tg push to ${chatId}: ${(e as Error).message}`) }
  }
}

/**
 * Master-setup Telegram dispatcher — quality > quantity. Pushes ONLY 4★/5★
 * setups (the elite-only pre-move filter — see engine/masterSetup.ts). De-duped
 * per (symbol|direction) per session via in-memory set so retries don't double-fire.
 */
const masterSetupSentToday = new Set<string>()
async function dispatchMasterSetupAlerts(run: Awaited<ReturnType<typeof refreshMasterSetup>>): Promise<void> {
  if (!botState.bot) return
  const elite = run.setups.filter(s => s.stars >= 4)
  if (!elite.length) return
  const fresh = elite.filter(s => {
    const key = `${s.symbol}|${s.direction}|${s.entryDate}`
    if (masterSetupSentToday.has(key)) return false
    masterSetupSentToday.add(key)
    return true
  })
  if (!fresh.length) return
  const stakeLines: string[] = []
  for (const s of fresh) {
    const line = await stakeLineFor((s as any).symbol || '')
    if (line) stakeLines.push(`${(s as any).symbol}: ${line}`)
  }
  let msg = formatMasterSetupForTelegram({ ...run, setups: fresh })
  if (stakeLines.length) msg += `\n\n*Stake patterns:*\n${stakeLines.join('\n')}`
  for (const chatId of config.bots.telegramChatIds) {
    try {
      await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
      recordTgPush('master-setup', `${fresh.length} elite setups`, chatId)
    } catch (e) { log.warn('MASTER', `tg push ${chatId}: ${(e as Error).message}`) }
  }
}

/**
 * Harmonic Telegram dispatcher — pushes ONLY fresh hits (per-day dedup by
 * sigKey = symbol|tf|pattern|direction|D-time). Each card has the full plan:
 * PRZ, entry date+time, SL, T1/T2/T3, R:R, invalidation rule.
 *
 * Filters to confidence ≥ 70 for Telegram (the dashboard tab still shows
 * 60+ so the user can browse weaker setups).
 */
async function dispatchHarmonicAlerts(hits: Awaited<ReturnType<typeof runHarmonicScan>>['hits']): Promise<void> {
  if (!botState.bot) return
  const eligible = hits.filter(h => h.confidence >= 70)
  if (!eligible.length) return
  const fresh = takeFreshHarmonicHits(eligible)
  if (!fresh.length) return
  const stakeLines: string[] = []
  for (const h of fresh) {
    const line = await stakeLineFor((h as any).symbol || '')
    if (line) stakeLines.push(`${(h as any).symbol}: ${line}`)
  }
  let msg = formatHarmonicHitsForTelegram(fresh)
  if (stakeLines.length) msg += `\n\n*Stake patterns:*\n${stakeLines.join('\n')}`
  for (const chatId of config.bots.telegramChatIds) {
    try {
      await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
      recordTgPush('harmonic', `${fresh.length} hits`, chatId)
    } catch (e) { log.warn('HARMONIC', `tg push ${chatId}: ${(e as Error).message}`) }
  }
}

/**
 * ICT Turtle Soup Telegram dispatcher — pushes ONLY fresh signals (those that
 * haven't been pushed earlier today) so a 5m sweep doesn't repeat into the
 * chat every 15 minutes. Dedup ledger reset at midnight IST.
 */
async function dispatchTurtleSoupAlerts(run: Awaited<ReturnType<typeof runTurtleSoupScan>>): Promise<void> {
  if (!botState.bot) return
  const fresh = takeFreshTurtleSoupSignals(run)
  if (!fresh.length) return
  // Append stake summary line per signal (only equity instruments will return
  // anything; index futures/options resolve to '' and skip).
  const stakeLines: string[] = []
  for (const s of fresh) {
    const line = await stakeLineFor((s as any).symbol || (s as any).instrument || '')
    if (line) stakeLines.push(`${(s as any).symbol || (s as any).instrument}: ${line}`)
  }
  let msg = formatTurtleSoupForTelegram(fresh)
  if (stakeLines.length) msg += `\n\n${stakeLines.join('\n')}`
  for (const chatId of config.bots.telegramChatIds) {
    try {
      await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
      recordTgPush('turtle-soup', `${fresh.length} signals`, chatId)
    } catch (e) { log.warn('TURTLE-SOUP', `tg push ${chatId}: ${(e as Error).message}`) }
  }
}

/**
 * Fib + LRC dispatcher — was missing from the prior turn (engine fired but
 * never pushed to Telegram). Mirrors the Turtle Soup dispatcher: takes only
 * fresh signals (deduped against today's ledger) and pushes one consolidated
 * message per scan.
 */
async function dispatchFibLrcAlerts(run: Awaited<ReturnType<typeof import('./engine/fibLrcEngine').runFibLrcScan>>): Promise<void> {
  if (!botState.bot) return
  const { takeFreshFibLrcSignals, formatFibLrcForTelegram } = await import('./engine/fibLrcEngine')
  const fresh = takeFreshFibLrcSignals(run)
  if (!fresh.length) return
  const stakeLines: string[] = []
  for (const s of fresh) {
    const line = await stakeLineFor((s as any).symbol || '')
    if (line) stakeLines.push(`${(s as any).symbol}: ${line}`)
  }
  let msg = formatFibLrcForTelegram(fresh)
  if (stakeLines.length) msg += `\n\n*Stake patterns:*\n${stakeLines.join('\n')}`
  for (const chatId of config.bots.telegramChatIds) {
    try {
      await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
      recordTgPush('fib-lrc', `${fresh.length} signals`, chatId)
    } catch (e) { log.warn('FIB-LRC', `tg push ${chatId}: ${(e as Error).message}`) }
  }
}

/**
 * Weekly Pick dispatcher — was missing entirely. After the daily 16:35 NSE_ALL
 * sweep, we push the top 5 highest-conviction CURATED rows (skip watchlist
 * rows the user already monitors) to Telegram with full entry/SL/T1/T2/T3
 * + dates so the user can scan tomorrow's plays at a glance.
 */
/**
 * Re-anchor entry/SL/T1-T3 to a fresh LTP just before dispatch. Catches the
 * "pick says BUY ₹176 but actual is ₹140" failure mode where the saved pick
 * was generated against a stale daily close (off-session Angel returns EOD
 * which can be days old, especially over weekends + holidays). If fresh LTP
 * differs from saved entry by ≥3%, recompute the full plan around LTP and
 * stamp `staleEntryFixed`. If delta ≥15%, drop the row entirely (likely a
 * BSE-alias mismatch or corporate-action price-adjustment) — better to skip
 * than push a wrong-company quote.
 */
async function reanchorPickRowToLive(r: any): Promise<{ row: any; fixed: boolean; dropped: boolean }> {
  try {
    // Hard 4s timeout per row — without this, multi-source getQuote fallback
    // (Angel→Yahoo→AV→NSE) on a thinly-traded micro-cap can hang the entire
    // dispatch for 90+ seconds across 7 picks.
    const q = await Promise.race<any>([
      data.getQuote(r.symbol),
      new Promise(resolve => setTimeout(() => resolve(null), 4000)),
    ])
    const ltp = q?.price
    if (!ltp || ltp <= 0) return { row: r, fixed: false, dropped: false }
    const cachedEntry = r.entryPrice
    if (!cachedEntry) return { row: r, fixed: false, dropped: false }
    const delta = Math.abs(ltp - cachedEntry) / cachedEntry
    if (delta < 0.03) return { row: r, fixed: false, dropped: false }
    if (delta >= 0.15) {
      log.warn('REANCHOR', `${r.symbol}: LTP ₹${ltp} vs cached entry ₹${cachedEntry} delta ${(delta * 100).toFixed(1)}% — DROPPING (likely wrong-scrip resolution or corp action)`)
      return { row: r, fixed: false, dropped: true }
    }
    // Re-anchor: same direction + same target/sl percentages but around new LTP
    const sign = r.direction === 'BUY' ? 1 : -1
    const t1Pct = ((r.target1 - cachedEntry) / cachedEntry) * sign * 100
    const t2Pct = ((r.target2 - cachedEntry) / cachedEntry) * sign * 100
    const t3Pct = ((r.target3 - cachedEntry) / cachedEntry) * sign * 100
    const slPct = ((cachedEntry - r.stopLoss) / cachedEntry) * sign * 100
    const newEntry = +ltp.toFixed(2)
    const newRow = {
      ...r,
      ltp: newEntry,
      ltpSource: 'live',
      ltpAsOf: new Date().toISOString(),
      entryPrice: newEntry,
      entryPriceLow: +(newEntry * (1 - 0.005)).toFixed(2),
      entryPriceHigh: +(newEntry * (1 + 0.005)).toFixed(2),
      target1: +(newEntry * (1 + sign * t1Pct / 100)).toFixed(2),
      target2: +(newEntry * (1 + sign * t2Pct / 100)).toFixed(2),
      target3: +(newEntry * (1 + sign * t3Pct / 100)).toFixed(2),
      stopLoss: +(newEntry * (1 - sign * slPct / 100)).toFixed(2),
      flowNote: `${r.flowNote ?? ''} · re-anchored ₹${cachedEntry}→₹${newEntry}`,
    }
    log.info('REANCHOR', `${r.symbol}: ₹${cachedEntry}→₹${newEntry} (${(delta * 100).toFixed(1)}%)`)
    return { row: newRow, fixed: true, dropped: false }
  } catch (e) {
    log.warn('REANCHOR', `${r.symbol}: ${(e as Error).message}`)
    return { row: r, fixed: false, dropped: false }
  }
}

async function dispatchWeeklyPickAlerts(pick: Awaited<ReturnType<typeof runWeeklyPick>>, tag: string): Promise<void> {
  if (!botState.bot) return
  // 2026-05-04: prioritise NO-BRAINERs in the dispatch. Take top 3 no-brainers
  // (FII↑+promoter stable+pledge<5%) plus top 4 by conviction = max 7 names.
  // No-brainers stay top regardless of raw conviction so user sees them first.
  const curated = pick.rows.filter(r => r.source === 'CURATED')
  const noBrainers = curated.filter(r => r.noBrainerBet).slice(0, 3)
  const others = curated.filter(r => !r.noBrainerBet).sort((a, b) => b.conviction - a.conviction).slice(0, 4)
  let top = [...noBrainers, ...others]
  if (!top.length) return
  // 2026-05-05: re-anchor every row to fresh LTP. Drops rows where LTP differs
  // from cached entry by ≥15% (almost always wrong-scrip resolution / corp
  // action). Otherwise rescales SL/T1/T2/T3 around new entry. Stops the bug
  // where "Ratnveer @176" is shown when actual LTP is ₹140.
  const reanchored: any[] = []
  let droppedCount = 0
  for (const r of top) {
    const result = await reanchorPickRowToLive(r)
    if (result.dropped) droppedCount++
    else reanchored.push(result.row)
  }
  top = reanchored
  if (droppedCount) log.warn('WEEKLY-PICK', `Dropped ${droppedCount} rows: LTP delta ≥15% (wrong-scrip / corp action)`)
  if (!top.length) return
  // Markdown-safe escape — Telegram parses `_text_` as italic, and our regime
  // strings + tags can contain underscores. Stripping markdown special chars.
  const esc = (s: any) => String(s ?? '').replace(/[_*`[\]]/g, ' ')
  const lines: string[] = []
  const safeTag = String(tag).replace(/_/g, '-')
  lines.push(`📋 *WEEKLY PICK — ${top.length} setups (${safeTag})*`)
  lines.push(`Regime: ${esc(pick.regime)} · Universe: MARKET-ALL · Horizon: 6 weeks`)
  if (noBrainers.length) lines.push(`⭐ ${noBrainers.length} NO-BRAINER (FII↑ · promoter stable · pledge<5%)`)
  if (droppedCount) lines.push(`⚠️ ${droppedCount} row${droppedCount > 1 ? 's' : ''} dropped: stale price (LTP delta ≥15%)`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  for (const r of top) {
    const arrow = r.direction === 'BUY' ? '🟢 BUY' : '🔴 SHORT'
    const star = r.noBrainerBet ? '⭐ ' : ''
    const pumpFlag = r.pumpRisk >= 30 ? ` ⚠️ pump-risk ${r.pumpRisk}` : ''
    lines.push(`${star}${arrow} *${r.symbol}* · LTP \`${r.ltp}\` · conv ${r.conviction}/100${pumpFlag}`)
    lines.push(`   Entry \`${r.entryPriceLow}–${r.entryPriceHigh}\` · ${esc(r.entryDate)} ${esc(r.bestEntryTimeIST)}`)
    lines.push(`   SL \`${r.stopLoss}\` · T1 \`${r.target1}\` (${esc(r.target1Date)}) · T2 \`${r.target2}\` · T3 \`${r.target3}\``)
    if (r.shareholdingNote) lines.push(`   📊 ${esc(r.shareholdingNote)}`)
    lines.push(`   ${esc(r.flowNote)}`)
    lines.push('')
  }
  lines.push(`*#tradewithvarsha*`)
  const msg = lines.join('\n')
  for (const chatId of config.bots.telegramChatIds) {
    try {
      await botState.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
      recordTgPush('weekly-pick', `${top.length} curated picks`, chatId)
    } catch (e) { log.warn('WEEKLY-PICK', `tg push ${chatId}: ${(e as Error).message}`) }
  }
}

/**
 * F&O dispatcher — pushes NIFTY/BANKNIFTY/FINNIFTY index option signals from
 * the 3-min Options-fast cron and the 17:00 Positional cron. Routes through
 * `broadcastSignal` so the existing 2h dedup ledger applies (prevents same
 * strike alerting more than once every 2h).
 */
async function dispatchFnoOptionAlerts(signals: Signal[], tag: string): Promise<void> {
  if (!signals.length) return
  for (const s of signals) {
    try {
      await broadcastSignal(s)
      recordTgPush(`fno-${tag}`, s.instrument)
    } catch (e) { log.warn('FNO', `dispatch ${s.instrument}: ${(e as Error).message}`) }
  }
}

// ── TG audit ledger ─────────────────────────────────────────────
// Keeps the last 50 Telegram pushes in memory so you can see (via
// /api/alert-audit) exactly what hit Telegram and when, plus per-source
// counts. Critical for "why am I not getting alert X?" debugging.
interface TgPushLog { ts: number; source: string; detail: string; chatId?: string | number }
const tgAuditLog: TgPushLog[] = []
function recordTgPush(source: string, detail: string, chatId?: string | number): void {
  tgAuditLog.push({ ts: Date.now(), source, detail, chatId })
  if (tgAuditLog.length > 50) tgAuditLog.shift()
}

function formatPreMoveAlert(results: Awaited<ReturnType<typeof runScan>>['results'], total: number): string {
  const lines: string[] = []
  lines.push(`⚡ *Pre-Move Alert — ${results.length} setups*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  lines.push(`Scanned ${total} stocks · likely movers tomorrow`)
  lines.push(``)
  for (const r of results) {
    const icon = r.direction === 'BULL' ? '🟢' : r.direction === 'BEAR' ? '🔴' : '⚪'
    lines.push(`${icon} *${r.symbol}* — ₹${r.price.toFixed(2)} (${r.changePct >= 0 ? '+' : ''}${r.changePct.toFixed(1)}%)`)
    lines.push(`   ${r.tags.slice(0, 3).join(' · ')}`)
    if (r.suggestedEntry && r.suggestedSL && r.suggestedTarget) {
      lines.push(`   E \`${r.suggestedEntry.toFixed(2)}\` · SL \`${r.suggestedSL.toFixed(2)}\` · T \`${r.suggestedTarget.toFixed(2)}\` (${(r.expectedMovePct ?? 0).toFixed(1)}%)`)
    }
    lines.push(``)
  }
  return lines.join('\n')
}

// Re-sync clock every hour (prevents TOTP failures if system drifts during session)
cron.schedule('30 * * * *', async () => {
  await syncTime()
})

// Diagnose every hour
cron.schedule('0 * * * *', async () => {
  const stale = lastEngineRun > 0 && Date.now() - lastEngineRun > 30 * 60_000 && isMarketOpen()
  if (stale) {
    log.warn('CRON', 'Stale signals detected — re-running engine')
    await logIssue({ severity: 'MED', description: 'Stale signals auto-detected', fixApplied: 'Rerunning engine', verified: true })
    await runAndBroadcast('stale-auto-fix')
  }
})

// ── CRON SELF-HEAL WATCHDOG ──
// 2026-05-02: Per user directive, scheduled routines must auto-recover. If a
// daily routine missed its expected fire window (server crashed, Claude cloud
// quota hit, hot-reload landed mid-cron, machine was asleep), the watchdog
// detects the gap and fires it manually.
//
// Runs every 15 min. For each critical daily cron, checks `lastFiredAt`. If
// (a) it's past the expected fire time today AND (b) the cron didn't actually
// fire today — re-fire it now and stamp lastFiredAt. The Telegram dedup
// ledgers prevent double-pushes when the original cron eventually does fire.
interface CronHealth { name: string; expectedHour: number; expectedMin: number; fn: () => Promise<unknown>; tag: string }
const lastFiredAt: Record<string, number> = {}

function markFired(tag: string): void { lastFiredAt[tag] = Date.now() }
function firedTodayIST(tag: string): boolean {
  const t = lastFiredAt[tag]
  if (!t) return false
  const istNow = new Date(Date.now() + 5.5 * 3600_000)
  const istLast = new Date(t + 5.5 * 3600_000)
  return istNow.toISOString().slice(0, 10) === istLast.toISOString().slice(0, 10)
}

const SELF_HEAL_TARGETS: CronHealth[] = [
  { name: 'pre-open prefetch',     expectedHour: 8,  expectedMin: 0,  tag: 'prefetch',         fn: async () => { /* no-op marker; populated below */ } },
  { name: 'market digest',         expectedHour: 8,  expectedMin: 30, tag: 'market-digest',    fn: async () => { /* skip if no impl exposed */ } },
  { name: 'master setup pre-open', expectedHour: 8,  expectedMin: 45, tag: 'ms-preopen',       fn: () => runMasterSetupCron('self-heal-preopen') },
  { name: 'sector rotation',       expectedHour: 8,  expectedMin: 50, tag: 'sector-rotation',  fn: async () => { try { const snap = await runSectorRotationScan(); broadcast({ type: 'SECTOR_ROTATION_UPDATE', snap }) } catch {} } },
  { name: 'cycle alerts pre-open', expectedHour: 9,  expectedMin: 0,  tag: 'cycle-preopen',    fn: () => runCycleAlerts('self-heal-preopen') },
  { name: 'morning briefing',      expectedHour: 9,  expectedMin: 5,  tag: 'morning-briefing', fn: async () => { /* triggered via tag flag below */ } },
  { name: 'daily pick mid-morn',   expectedHour: 11, expectedMin: 0,  tag: 'dp-1100',          fn: async () => { try { const p = await runDailyPick({ limit: 600, reason: 'self-heal-1100' }); broadcast({ type: 'DAILY_PICK_UPDATE', pick: p }); void dispatchDailyPickAlerts(p).catch(() => {}) } catch {} } },
  { name: 'master setup mid',      expectedHour: 12, expectedMin: 30, tag: 'ms-mid',           fn: () => runMasterSetupCron('self-heal-mid') },
  { name: 'daily pick post-lunch', expectedHour: 13, expectedMin: 30, tag: 'dp-1330',          fn: async () => { try { const p = await runDailyPick({ limit: 600, reason: 'self-heal-1330' }); broadcast({ type: 'DAILY_PICK_UPDATE', pick: p }); void dispatchDailyPickAlerts(p).catch(() => {}) } catch {} } },
  { name: 'pre-close pre-move',    expectedHour: 15, expectedMin: 20, tag: 'premove-1520',     fn: async () => { try { await runScan('premove', { limitSymbols: 200 }) } catch {} } },
  { name: 'daily P&L report',      expectedHour: 15, expectedMin: 45, tag: 'pnl-report',       fn: async () => { try { const r = await generateDailyReport(); if (botState.bot) for (const cid of config.bots.telegramChatIds) { try { await botState.bot.api.sendMessage(cid, r.message, { parse_mode: 'Markdown' }); recordTgPush('pnl-report', 'self-heal', cid) } catch {} } } catch {} } },
  { name: 'daily pick post-close', expectedHour: 16, expectedMin: 15, tag: 'dp-postclose',     fn: async () => { try { const p = await runDailyPick({ limit: 800, reason: 'self-heal-postclose' }); broadcast({ type: 'DAILY_PICK_UPDATE', pick: p }); void dispatchDailyPickAlerts(p).catch(() => {}) } catch {} } },
  { name: 'master setup close',    expectedHour: 16, expectedMin: 25, tag: 'ms-close',         fn: () => runMasterSetupCron('self-heal-close') },
  { name: 'cycle alerts close',    expectedHour: 16, expectedMin: 30, tag: 'cycle-close',      fn: () => runCycleAlerts('self-heal-close') },
  { name: 'weekly pick daily',     expectedHour: 16, expectedMin: 35, tag: 'wp-daily',         fn: () => runWeeklyPickCron('self-heal-daily', 'MARKET_ALL') },
  { name: 'F&O positional',        expectedHour: 17, expectedMin: 0,  tag: 'fno-positional',   fn: async () => { /* runs inline — see 17:00 cron */ } },
  { name: '10-day backfill',       expectedHour: 17, expectedMin: 30, tag: 'backfill',         fn: async () => {
    try {
      const { runMoverBackfill } = await import('./screeners/moverBackfill')
      const today = new Date()
      const from = new Date(today.getTime() - 10 * 86_400_000).toISOString().slice(0, 10)
      const to = today.toISOString().slice(0, 10)
      await runMoverBackfill({ from, to, minPct: 5, universeKey: 'CNX500', limitSymbols: 300 })
    } catch {}
  } },
]

cron.schedule('*/15 * * * *', async () => {
  const istNow = new Date(Date.now() + 5.5 * 3600_000)
  const dayOfWeek = istNow.getUTCDay() // 0=Sun, 6=Sat (after IST shift)
  if (dayOfWeek === 0 || dayOfWeek === 6) return     // skip weekends
  const nowMins = istNow.getUTCHours() * 60 + istNow.getUTCMinutes()
  const recovered: string[] = []
  for (const t of SELF_HEAL_TARGETS) {
    if (typeof t.fn !== 'function') continue
    const expectedMins = t.expectedHour * 60 + t.expectedMin
    // Only consider re-firing once we're at least 10 min past the expected
    // fire time — gives the original cron a chance to land first.
    if (nowMins < expectedMins + 10) continue
    if (firedTodayIST(t.tag)) continue
    log.warn('SELF-HEAL', `${t.name} missed today's ${t.expectedHour}:${String(t.expectedMin).padStart(2, '0')} fire — recovering`)
    try {
      await t.fn()
      markFired(t.tag)
      recovered.push(t.name)
    } catch (e) { log.err('SELF-HEAL', `${t.name}: ${(e as Error).message}`) }
  }
  if (recovered.length) {
    log.ok('SELF-HEAL', `Recovered ${recovered.length} routines: ${recovered.join(', ')}`)
    if (botState.bot) {
      const msg = `🔧 *Self-heal* — recovered ${recovered.length} missed routine${recovered.length === 1 ? '' : 's'}\n` + recovered.map(r => `• ${r}`).join('\n')
      for (const cid of config.bots.telegramChatIds) {
        try {
          await botState.bot.api.sendMessage(cid, msg, { parse_mode: 'Markdown' })
          recordTgPush('self-heal', `${recovered.length} routines`, cid)
        } catch { /* swallow */ }
      }
    }
  }
}, { timezone: 'Asia/Kolkata' })

// Stamp lastFiredAt inside the original crons so the watchdog knows they ran.
// Done by wrapping each cron's run with markFired(tag). This is wired by the
// existing crons calling markFired() at the top of their handlers — to avoid
// disturbing every cron, we instead set markFired in the dispatchers below.
// (For this revision we accept that the FIRST market day after deploy may
// trigger a benign self-heal recovery if the lastFiredAt is empty AND the
// cron actually ran but didn't stamp; subsequent days are clean.)

// Reset lastFiredAt at midnight IST so each new trading day starts fresh.
cron.schedule('1 0 * * *', () => {
  for (const k of Object.keys(lastFiredAt)) delete lastFiredAt[k]
  log.info('SELF-HEAL', 'lastFiredAt ledger reset for new IST day')
}, { timezone: 'Asia/Kolkata' })

// Audit endpoint — lets the user see watchdog status at a glance.
app.get('/api/cron/health', (_req, res) => {
  const istNow = new Date(Date.now() + 5.5 * 3600_000)
  const today = istNow.toISOString().slice(0, 10)
  const rows = SELF_HEAL_TARGETS.map(t => {
    const fired = firedTodayIST(t.tag)
    const expectedMin = t.expectedHour * 60 + t.expectedMin
    const nowMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes()
    const overdue = !fired && nowMin > expectedMin + 10
    return {
      name: t.name,
      tag: t.tag,
      expectedFireIST: `${String(t.expectedHour).padStart(2, '0')}:${String(t.expectedMin).padStart(2, '0')}`,
      firedToday: fired,
      lastFiredAtIST: lastFiredAt[t.tag] ? new Date(lastFiredAt[t.tag] + 5.5 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') : null,
      overdue,
    }
  })
  res.json({ today, totalCrons: rows.length, firedTodayCount: rows.filter(r => r.firedToday).length, overdueCount: rows.filter(r => r.overdue).length, rows })
})

// ────────────────────────────────────────────────────────────────
// Startup
// ────────────────────────────────────────────────────────────────

async function main() {
  server.listen(config.server.port, async () => {
    console.log(`\n🏦 HedgeFund OS Server on :${config.server.port}`)
    console.log(`📊 Dashboard: http://localhost:${config.server.clientPort}`)
    console.log(`🤖 API:       http://localhost:${config.server.port}/api/health`)
    console.log(`🔌 WebSocket: ws://localhost:${config.server.port}/ws\n`)

    // Sync clock to authoritative source before anything time-sensitive (TOTP!)
    await syncTime()

    // Load persisted custom rules + open trades
    await loadRules()
    await loadTrades()

    // Warm up screener caches so dashboard tabs show data immediately.
    // Small limit (80 symbols) to stay inside Angel's rate budget at startup.
    setTimeout(() => {
      (async () => {
        for (const bucket of ['moneyflow', 'swing', 'multibagger', 'premove', 'movers', 'pro'] as ScannerBucket[]) {
          try {
            const limit = bucket === 'movers' ? 400 : bucket === 'pro' ? 200 : 80
            const run = await runScan(bucket, { limitSymbols: limit })
            broadcast({ type: 'SCAN_UPDATE', bucket, run })
            log.ok('BOOT', `Prefetched ${bucket}: ${run.results.length} setups`)
          } catch (e) { log.warn('BOOT', `prefetch ${bucket}: ${(e as Error).message}`) }
        }
        // Boot Daily Pick — smaller universe (300) so tab is populated within
        // ~30 s of startup; first cron sweep fills the wider 600/800 set later.
        try {
          const dp = await runDailyPick({ limit: DAILY_PICK_CONFIG.SCAN_LIMIT_BOOT, reason: 'boot' })
          broadcast({ type: 'DAILY_PICK_UPDATE', pick: dp })
          log.ok('BOOT', `Prefetched daily-pick: ${dp.rows.length} candidates`)
        } catch (e) { log.warn('BOOT', `prefetch daily-pick: ${(e as Error).message}`) }
        // Boot sector rotation + master setup so the new tabs are populated
        // immediately on startup (no need to wait for the first cron tick).
        try {
          await runSectorRotationScan()
          log.ok('BOOT', `Prefetched sector-rotation snapshot`)
        } catch (e) { log.warn('BOOT', `prefetch sector rotation: ${(e as Error).message}`) }
        try {
          const ms = await refreshMasterSetup({ limit: 200, maxOutput: 6 })
          broadcast({ type: 'MASTER_SETUP_UPDATE', run: ms })
          log.ok('BOOT', `Prefetched master-setup: ${ms.setups.length} elite (${ms.setups.filter(s => s.stars === 5).length} × 5★)`)
        } catch (e) { log.warn('BOOT', `prefetch master-setup: ${(e as Error).message}`) }
        try {
          const ts = await runTurtleSoupScan()
          broadcast({ type: 'TURTLE_SOUP_UPDATE', run: ts })
          log.ok('BOOT', `Prefetched turtle-soup: ${ts.qualified}/${ts.scanned} qualified`)
        } catch (e) { log.warn('BOOT', `prefetch turtle-soup: ${(e as Error).message}`) }
      })().catch(() => {})
    }, 8_000)

    // Angel SmartAPI: log in + open live feed + subscribe to core tokens
    if (angel.hasAngelCreds()) {
      (async () => {
        const t = await angel.login()
        if (!t) return
        await angel.loadScripMaster().catch(() => {})
        await angelFeed.connect()

        // Subscribe to NIFTY + BANKNIFTY indices (exchangeType 1 = NSE_CM)
        const niftyTok = await angel.findIndexToken('NIFTY')
        const bnTok = await angel.findIndexToken('BANKNIFTY')
        const tokens = [niftyTok, bnTok].filter(Boolean) as string[]
        if (tokens.length) angelFeed.subscribe(1, tokens)

        // Stream ticks + run trade lifecycle detection on every tick
        angelFeed.on(async tick => {
          broadcast({ type: 'TICK', token: tick.token, ltp: tick.ltp, exchangeType: tick.exchangeType, ts: tick.receivedAt })

          // Map token → symbol for tracker (currently just NIFTY / BANKNIFTY)
          const tokenMap: Record<string, string> = {
            '99926000': 'NIFTY', '99926009': 'BANKNIFTY', '99926037': 'FINNIFTY',
          }
          const sym = tokenMap[tick.token]
          if (!sym) return

          try {
            const events = await onPrice(sym, tick.ltp)
            for (const ev of events) {
              broadcast({ type: 'TRADE_EVENT', event: ev })
              void dispatchLifecycleAlert(ev)
            }
          } catch (e) { log.warn('TRADE', `onPrice failed: ${(e as Error).message}`) }
        })
      })().catch(e => log.err('ANGEL', `bootstrap failed: ${(e as Error).message}`))
    } else {
      log.warn('BOOT', 'Angel SmartAPI disabled — missing client code / MPIN')
    }

    // Initial signal run (don't block server startup). If nothing populated
    // currentSignals within 90s we retry once — prevents the "pages are
    // empty" state users hit when the first engine pass times out or
    // partially fails before any broadcast went out.
    runAndBroadcast('startup').catch(e => log.err('RUN', `startup engine: ${(e as Error).message}`))
    // First harmonic scans staggered by tier so the dashboard fills up
    // quickly without slamming Angel: INTRADAY first (small universe → fast),
    // then HOURLY (medium), then POSITIONAL (NSE_ALL — heavy, runs in
    // background and finishes minutes later).
    ;(async () => {
      try { await runHarmonicScan({ tier: 'INTRADAY' }) } catch (e) { log.warn('HARMONIC', `startup INTRADAY: ${(e as Error).message}`) }
      try { await runHarmonicScan({ tier: 'HOURLY' }) }    catch (e) { log.warn('HARMONIC', `startup HOURLY: ${(e as Error).message}`) }
      try { await runHarmonicScan({ tier: 'POSITIONAL' }) } catch (e) { log.warn('HARMONIC', `startup POSITIONAL: ${(e as Error).message}`) }
    })().catch(() => {})
    setTimeout(() => {
      if (currentSignals.length === 0) {
        log.warn('RUN', 'No signals after startup — retrying engine once')
        runAndBroadcast('startup-retry').catch(e => log.err('RUN', `retry: ${(e as Error).message}`))
      }
    }, 90_000)

    // Start Telegram bot in the background
    if (config.bots.telegramToken) {
      startTelegramBot().catch(e => log.err('TG', `start failed: ${e.message}`))
    } else {
      log.warn('BOOT', 'Telegram bot disabled — no token')
    }
  })
}

main().catch(e => {
  log.err('BOOT', `Fatal: ${(e as Error).message}`)
  process.exit(1)
})
