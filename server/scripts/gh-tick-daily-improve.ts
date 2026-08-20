/**
 * Standalone daily-improve routine — runs on GitHub Actions cron
 * 3× daily (08:00 / 12:00 / 18:00 IST). FREE, no Claude tokens.
 *
 * User directive 20 Aug 2026: routine must include (from memory):
 *   1. 8-external-site gainer check (NSE500 bhavcopy + finology +
 *      trendlyne + groww + 5 Kotak Neo) — find 10-20% movers we
 *      missed today/this week
 *   2. Miss-attribution — WHY did we not catch each
 *   3. Pattern identification — mine fingerprints from missed gainers
 *      into winning-patterns.json so future scans catch that setup
 *   4. Core-engine optimization — analyze which MASTER pillar killed
 *      most candidates + propose relaxations
 *   5. Per-source WR analysis on last 7d closed paper-book trades
 *   6. Auto-tune gate adjustments (raise <30% WR, relax >70% WR)
 *   7. Persistent symbol blacklist (≥ 2 SL_HITs in 15d → 30d block)
 *   8. Self-improve loop (live signals CSV → tune)
 *   9. Engine health check + CI status
 *  10. Append dated report to daily-routine-log.md + commit + push
 *
 * Called by .github/workflows/daily-improve.yml on cron:
 *   30 2  * * *   → 08:00 IST
 *   30 6  * * *   → 12:00 IST (noon)
 *   30 12 * * *   → 18:00 IST
 */

import path from 'path'
import fs from 'fs/promises'
import fsSync from 'fs'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../.env') })

import { log } from '../src/util/logger'

const LOG_FILE = path.resolve(__dirname, '../data/daily-routine-log.md')
const SNAP_DIR = path.resolve(__dirname, '../data/public-snapshots')

interface StepResult { name: string; ok: boolean; summary: string; elapsedMs: number }

async function runStep(name: string, fn: () => Promise<string>): Promise<StepResult> {
  const t = Date.now()
  try {
    const summary = await fn()
    const elapsedMs = Date.now() - t
    log.ok('DAILY-IMPROVE-CRON', `✓ ${name}: ${summary} · ${(elapsedMs / 1000).toFixed(1)}s`)
    return { name, ok: true, summary, elapsedMs }
  } catch (e) {
    const elapsedMs = Date.now() - t
    const summary = `ERR ${(e as Error).message}`
    log.warn('DAILY-IMPROVE-CRON', `✗ ${name}: ${summary}`)
    return { name, ok: false, summary, elapsedMs }
  }
}

function readSnap(name: string): any | null {
  try { return JSON.parse(fsSync.readFileSync(path.join(SNAP_DIR, name), 'utf-8')) }
  catch { return null }
}

async function main() {
  const t0 = Date.now()
  const nowUtc = new Date()
  const nowIst = new Date(nowUtc.getTime() + 5.5 * 3600_000)
  const istLabel = nowIst.toISOString().slice(11, 16) + ' IST'
  log.info('DAILY-IMPROVE-CRON', `starting full routine @ ${istLabel} (${nowUtc.toISOString()})`)

  const steps: StepResult[] = []

  // ── STEP 1 — 8-external-site gainer check ────────────────────────
  // Fetches today's ≥5% gainers from NSE bhavcopy + finology + trendlyne
  // + groww + 5 Kotak Neo URLs. Cross-checks against our snapshots to
  // find what we missed.
  steps.push(await runStep('miss-analysis', async () => {
    const { runMissAnalysis } = await import('../src/engine/missAnalyzer')
    const r = await runMissAnalysis()
    fsSync.writeFileSync(path.join(SNAP_DIR, 'miss-analysis.json'), JSON.stringify(r, null, 2))
    return `${r.caughtCount}/${r.totalGainers} caught (${(r.catchRate * 100).toFixed(0)}%)`
  }))

  // ── STEP 2 — Would-have-caught postmortem (with tune) ────────────
  steps.push(await runStep('gainer-postmortem', async () => {
    const { runGainerPostmortem } = await import('../src/engine/gainerPostmortem')
    const r = await runGainerPostmortem()
    fsSync.writeFileSync(path.join(SNAP_DIR, 'gainer-postmortem.json'), JSON.stringify(r, null, 2))
    return `${r.wouldHaveCaughtCount}/${r.totalGainers} would've been caught with tuning`
  }))

  // ── STEP 3 — Pattern learner: mine today's movers into memory ───
  // Extracts 30-candle fingerprints from missed 5%+ gainers so future
  // scans can match similar setups (winning-patterns.json).
  steps.push(await runStep('pattern-learner', async () => {
    const m = await import('../src/engine/moverPatternMiner')
    const r = await m.mineTodaysMoverPatterns()
    if (typeof m.publishMoverArchetypesSnapshot === 'function') {
      await m.publishMoverArchetypesSnapshot()
    }
    return `${r.added} new fingerprints (store ${r.total})`
  }))

  // ── STEP 4 — Self-improve loop (signals-CSV WR → gate tune) ─────
  steps.push(await runStep('self-improve', async () => {
    const m = await import('../src/engine/selfImprove')
    const tune = await m.runSelfImprove()
    const overrides = Object.keys(tune?.overrides ?? {}).length
    const newAdj = (tune?.adjustments ?? []).filter(a => a.ts >= new Date(Date.now() - 24 * 3600_000).toISOString()).length
    return `${overrides} strategy overrides · +${newAdj} new adjustments`
  }))

  // ── STEP 5 — Core-engine tune (per-source WR + blacklist) ───────
  // The main tune step: reads paper-book closed trades per source,
  // adjusts gate scores, extends blacklists.
  let coreReport: any = null
  steps.push(await runStep('daily-core-improvise', async () => {
    const m = await import('../src/engine/dailyCoreImprovise')
    coreReport = await m.runDailyCoreImprovise()
    const applied = coreReport.improvements.filter((i: any) => i.applied).length
    return `${applied} tunes applied · WR ${coreReport.bookWinRate}% · MASTER ${coreReport.masterEmitted} · MP ${coreReport.moneyPrinterEmitted}`
  }))

  // ── STEP 6 — Engine health snapshot (row counts + freshness) ────
  const engineHealth: Record<string, { ageH: number | null; rows: number | null; status: 'FRESH' | 'STALE' | 'EMPTY' | 'MISSING' }> = {}
  const engines = [
    'trading-journal', 'master-setups', 'money-printer', 'mtf-harmonic',
    'ichimoku-cloud', 'nifty-bias', 'harmonic', 'elliott-wave',
    'sector-rotation', 'high-quality-setups', 'pro-edge', 'vp-fib',
    'miss-analysis', 'gainer-postmortem',
  ]
  const nowMs = nowUtc.getTime()
  for (const eng of engines) {
    const snap = readSnap(eng + '.json')
    if (!snap) { engineHealth[eng] = { ageH: null, rows: null, status: 'MISSING' }; continue }
    const gen = snap.generatedAt ?? snap.lastUpdatedAt
    const ageH = gen ? (nowMs - new Date(gen).getTime()) / 3600_000 : null
    const rows = Array.isArray(snap.rows) ? snap.rows.length
      : (snap.fno && snap.cash) ? (snap.fno.length + snap.cash.length)
      : Array.isArray(snap.entries) ? snap.entries.length
      : typeof snap.emitted === 'number' ? snap.emitted
      : typeof snap.total === 'number' ? snap.total
      : 0
    const status = ageH !== null && ageH > 24 ? 'STALE'
      : rows === 0 ? 'EMPTY'
      : 'FRESH'
    engineHealth[eng] = { ageH, rows, status }
  }
  steps.push({
    name: 'engine-health',
    ok: true,
    summary: `${Object.values(engineHealth).filter(e => e.status === 'FRESH').length} fresh · ${Object.values(engineHealth).filter(e => e.status === 'STALE').length} stale · ${Object.values(engineHealth).filter(e => e.status === 'EMPTY').length} empty · ${Object.values(engineHealth).filter(e => e.status === 'MISSING').length} missing`,
    elapsedMs: 0,
  })

  // ── STEP 7 — Append dated log ───────────────────────────────────
  const missSnap = readSnap('miss-analysis.json')
  const gainerSnap = readSnap('gainer-postmortem.json')
  const missedNames: string[] = ((missSnap?.rows ?? []).filter((r: any) => !r.caught && r.gainPct >= 5) as any[])
    .sort((a, b) => (b.gainPct ?? 0) - (a.gainPct ?? 0)).slice(0, 10)
    .map(r => `${r.symbol} +${(r.gainPct ?? 0).toFixed(1)}%`)

  const lines: string[] = []
  lines.push('')
  lines.push(`## ${nowUtc.toISOString()} — ${istLabel}`)
  lines.push('')
  if (coreReport) {
    lines.push(`**Book:** WR ${coreReport.bookWinRate}% · realised ₹${coreReport.bookRealisedPnl.toFixed(0)}`)
    lines.push(`**Miss catch-rate:** ${coreReport.missCatchRate}%${missSnap ? ` (${missSnap.caughtCount}/${missSnap.totalGainers})` : ''}`)
    lines.push(`**Engine emit:** MASTER ${coreReport.masterEmitted} · Money-Printer ${coreReport.moneyPrinterEmitted}`)
  }
  lines.push('')
  lines.push('### Top misses today (10-20% movers we didn\'t catch)')
  if (missedNames.length === 0) lines.push('  _(none — either 100% catch rate or no bhavcopy data yet)_')
  else missedNames.forEach(m => lines.push(`  · ${m}`))

  if (gainerSnap?.topMissReasons) {
    lines.push('')
    lines.push('### Why we missed them (postmortem)')
    for (const [reason, count] of Object.entries(gainerSnap.topMissReasons).slice(0, 6)) {
      lines.push(`  · ${reason}: ${count}`)
    }
  }
  if (gainerSnap?.patternBreakdown) {
    lines.push('')
    lines.push('### Patterns detected in the missed movers (for future signal generation)')
    for (const [pattern, count] of Object.entries(gainerSnap.patternBreakdown).slice(0, 8)) {
      lines.push(`  · ${pattern}: ${count}`)
    }
  }

  lines.push('')
  lines.push('### Engine health')
  for (const [eng, h] of Object.entries(engineHealth)) {
    const icon = h.status === 'FRESH' ? '✓' : h.status === 'STALE' ? '⚠STALE' : h.status === 'EMPTY' ? '⚠EMPTY' : '✗MISSING'
    const age = h.ageH !== null ? h.ageH.toFixed(1) + 'h' : '—'
    lines.push(`  · ${icon} ${eng}: age ${age}, rows ${h.rows ?? '—'}`)
  }

  if (coreReport?.perSourceStats?.length) {
    lines.push('')
    lines.push('### Per-source WR (last 7d closed trades)')
    for (const s of coreReport.perSourceStats.slice(0, 8)) {
      const dup = s.repeatedLosses >= 2 ? ` ⚠ ${s.worstSymbol}×${s.repeatedLosses} losses` : ''
      lines.push(`  · ${s.source}: ${s.trades} trades, WR ${s.winRatePct}%, avgRet ${s.avgReturnPct >= 0 ? '+' : ''}${s.avgReturnPct}%${dup}`)
    }
  }

  if (coreReport?.improvements) {
    const applied = coreReport.improvements.filter((i: any) => i.applied)
    lines.push('')
    lines.push(`### Tunes applied: ${applied.length}`)
    for (const i of applied.slice(0, 10)) {
      const icon = i.type === 'GATE_TIGHTEN' ? '🔒' : i.type === 'GATE_RELAX' ? '🔓' : i.type === 'BLACKLIST_EXTEND' ? '🚫' : 'ℹ️'
      lines.push(`  ${icon} ${i.target}/${i.metric}: ${i.from} → ${i.to} — ${i.reason}`)
    }
  }

  lines.push('')
  lines.push('### Step outcomes')
  for (const s of steps) {
    lines.push(`  ${s.ok ? '✓' : '✗'} ${s.name}: ${s.summary} · ${(s.elapsedMs / 1000).toFixed(1)}s`)
  }
  lines.push('')
  lines.push(`**Total elapsed:** ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  await fs.mkdir(path.dirname(LOG_FILE), { recursive: true })
  const prior = fsSync.existsSync(LOG_FILE) ? fsSync.readFileSync(LOG_FILE, 'utf-8')
    : '# Daily Routine Log\n\nAuto-appended by the 3×-daily improve cron (GitHub Actions).\nSchedule: 08:00 / 12:00 / 18:00 IST.\n'
  fsSync.writeFileSync(LOG_FILE, prior + '\n' + lines.join('\n') + '\n')

  log.ok('DAILY-IMPROVE-CRON', `done in ${((Date.now() - t0) / 1000).toFixed(1)}s · steps ${steps.filter(s => s.ok).length}/${steps.length} ok`)
}

main().catch(e => {
  console.error('[DAILY-IMPROVE-CRON] fatal:', e)
  process.exit(1)
})
