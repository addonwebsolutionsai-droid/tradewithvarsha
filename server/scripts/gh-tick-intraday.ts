/**
 * GitHub Actions intraday tick.
 *
 * Runs the essential real-time engines in one pass:
 *   - Cross-Engine Confluence
 *   - PRO Edge cascade
 *   - NIFTY Directional Foresight (multi-expiry OI + cycles + astro + playbook)
 *   - OI Monitor (fires Telegram alerts for high-strength OI signals)
 *   - Signal Lifecycle checker (updates open trades T-hit / SL-hit)
 *
 * Fires only during 09:15-15:30 IST Mon-Fri (short-circuits outside).
 * Called by .github/workflows/intraday-tick.yml every 5 min.
 *
 * Why this exists: the always-on cron-based server (server/src/index.ts)
 * only fires when the local process is running. When the user's laptop is
 * off, no scans, no Telegram, no snapshot refresh. This gives us free 24/5
 * intraday coverage via GitHub Actions runners.
 */

import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'

// Load .env from server root — GH Actions will inject via env: block in workflow
dotenv.config({ path: path.resolve(__dirname, '../.env') })

import { log } from '../src/util/logger'
import { createBot, broadcastSignal } from '../src/bots/telegram'
import { config } from '../src/config'
import { runSignalEngine } from '../src/engine/signalEngine'
import { gradeMeetsThreshold } from '../src/engine/scoring'
import { onSignalGenerated } from '../src/engine/tradeTracker'

const SNAPSHOT_DIR = path.resolve(__dirname, '../data/public-snapshots')

function istTimeOfDayMinutes(): number {
  const d = new Date(Date.now() + 5.5 * 3600_000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

function istWeekday(): number {
  const d = new Date(Date.now() + 5.5 * 3600_000)
  return d.getUTCDay()
}

async function writeSnapshot(name: string, data: unknown): Promise<void> {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
  const p = path.join(SNAPSHOT_DIR, name)
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
  console.log(`[SNAPSHOT] wrote ${name} (${(JSON.stringify(data).length / 1024).toFixed(1)}kB)`)
}

async function main() {
  const t0 = Date.now()
  const tod = istTimeOfDayMinutes()
  const wd = istWeekday()

  const marketOpen = 9 * 60 + 15
  const marketClose = 15 * 60 + 30
  const isWeekday = wd >= 1 && wd <= 5
  const inWindow = tod >= marketOpen && tod <= marketClose

  console.log(`[TICK] IST ${Math.floor(tod / 60).toString().padStart(2, '0')}:${(tod % 60).toString().padStart(2, '0')} · weekday=${wd} · isWeekday=${isWeekday} · inWindow=${inWindow}`)

  if (!isWeekday) {
    console.log('[TICK] Weekend — skipping.')
    return
  }
  if (!inWindow) {
    console.log('[TICK] Outside 09:15-15:30 IST market window — skipping.')
    return
  }

  // ─── Init Telegram (all downstream broadcastSignal calls need state.bot set)
  const bot = createBot()
  if (bot) console.log('[TICK] Telegram bot initialised.')
  else console.log('[TICK] Telegram bot NOT initialised — token missing.')

  const results: Record<string, string> = {}

  // ─── 0. Signal Engine — the ONLY path that actually fires Telegram alerts
  //        for new A-grade / score-≥9 setups. Mirrors index.ts:runAndBroadcast
  //        so the GH runner delivers Telegram messages exactly like the
  //        always-on local server would.
  try {
    const t = Date.now()
    const run = await runSignalEngine()
    const live = run.signals ?? []
    let broadcast = 0
    let filtered = 0

    if (config.alerts.onNewSignal) {
      for (const s of live) {
        if (!gradeMeetsThreshold(s.grade, config.alerts.minGrade)) { filtered++; continue }
        if (s.score < config.alerts.minScore) { filtered++; continue }
        try {
          const openEvent = await onSignalGenerated(s)
          if (openEvent) {
            await broadcastSignal(s)
            broadcast++
          }
        } catch (e) {
          log.warn('TICK', `broadcast ${s.instrument}: ${(e as Error).message}`)
        }
      }
    }
    results['signal-engine'] = `${live.length} live · ${broadcast} broadcast · ${filtered} filtered · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['signal-engine'] = `ERR ${(e as Error).message}`
    log.err('TICK', `signal-engine: ${(e as Error).message}`)
  }

  // ─── 1. Cross-Engine Confluence
  try {
    const { aggregateConfluence } = await import('../src/engine/crossEngineConfluence')
    const conf = await aggregateConfluence()
    await writeSnapshot('cross-confluence.json', conf)
    results['cross-confluence'] = `${conf.rows.length} rows · ${conf.ultraCount ?? 0} ULTRA · ${conf.strongCount ?? 0} STRONG`
  } catch (e) {
    results['cross-confluence'] = `ERR ${(e as Error).message}`
    log.err('TICK', `cross-confluence: ${(e as Error).message}`)
  }

  // ─── 2. PRO Edge (downstream of confluence)
  try {
    const { aggregateProEdge } = await import('../src/engine/proEdge')
    const pe = await aggregateProEdge({ minConviction: 85 })
    await writeSnapshot('pro-edge.json', pe)
    const rowsLen = Array.isArray((pe as { rows?: unknown[] }).rows) ? (pe as { rows: unknown[] }).rows.length : 0
    results['pro-edge'] = `${rowsLen} signals`
  } catch (e) {
    results['pro-edge'] = `ERR ${(e as Error).message}`
    log.err('TICK', `pro-edge: ${(e as Error).message}`)
  }

  // ─── 2b. NIFTY Volume Profile (multi-TF POC/VAH/VAL/HVN/LVN detector)
  //         Emits an ATM PE/CE recommendation when 2+ timeframes agree.
  try {
    const { runAndPublishNiftyVolumeProfile } = await import('../src/engine/niftyVolumeProfileEngine')
    const vp = await runAndPublishNiftyVolumeProfile()
    results['nifty-volume-profile'] = vp.ok
      ? `${vp.bias} ${vp.confidence} · ${vp.setup} @${vp.spot}`
      : 'no candles'
  } catch (e) {
    results['nifty-volume-profile'] = `ERR ${(e as Error).message}`
    log.err('TICK', `nifty-volume-profile: ${(e as Error).message}`)
  }

  // ─── 3. NIFTY Directional Foresight (writes own snapshot)
  try {
    const { runAndPublishNiftyForesight } = await import('../src/engine/niftyForesight')
    const nf = await runAndPublishNiftyForesight()
    results['nifty-outlook'] = nf.ok
      ? `${nf.direction} ${nf.confidence} (net ${nf.netScore}) @${nf.spot}${nf.playbook.length > 0 ? ' · ' + nf.playbook.join(',') : ''}`
      : 'no OC data'
  } catch (e) {
    results['nifty-outlook'] = `ERR ${(e as Error).message}`
    log.err('TICK', `nifty-outlook: ${(e as Error).message}`)
  }

  // ─── 4. OI Monitor — fires Telegram alerts for high-strength OI signals
  try {
    const oi = await import('../src/engine/oiMonitor')
    const runner: unknown = (oi as { checkOI?: () => Promise<unknown>; runOICheck?: () => Promise<unknown>; runOnce?: () => Promise<unknown> }).checkOI
      ?? (oi as { runOICheck?: () => Promise<unknown> }).runOICheck
      ?? (oi as { runOnce?: () => Promise<unknown> }).runOnce
    if (typeof runner === 'function') {
      await (runner as () => Promise<unknown>)()
      results['oi-monitor'] = 'tick ok'
    } else {
      results['oi-monitor'] = 'no runner export'
    }
  } catch (e) {
    results['oi-monitor'] = `ERR ${(e as Error).message}`
    log.err('TICK', `oi-monitor: ${(e as Error).message}`)
  }

  // ─── 4b. Lifecycle backfill — small chunk per tick so we chew through
  //         historical stuck-OPEN entries without blowing the 4-min budget.
  try {
    const { backfillAllOpenLifecycle } = await import('../src/engine/lifecycleBackfill')
    const t = Date.now()
    const r = await backfillAllOpenLifecycle({ maxEntries: 150, concurrency: 4 })
    const wonTotal = Object.values(r.bySource).reduce((s, v) => s + v.won, 0)
    results['lifecycle-backfill'] = `scanned ${r.scannedEntries} · resolved ${r.entriesResolved} (won ${wonTotal}) · triggered ${r.entriesTriggered} · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['lifecycle-backfill'] = `ERR ${(e as Error).message}`
    log.err('TICK', `lifecycle-backfill: ${(e as Error).message}`)
  }

  // ─── 5. Lifecycle checker — updates open trades' T-hit / SL-hit / expiry
  try {
    const lc = await import('../src/engine/signalLifecycle')
    const runner: unknown = (lc as { runLifecycleChecker?: () => Promise<unknown>; runLifecycle?: () => Promise<unknown> }).runLifecycleChecker
      ?? (lc as { runLifecycle?: () => Promise<unknown> }).runLifecycle
    if (typeof runner === 'function') {
      await (runner as () => Promise<unknown>)()
      results['lifecycle'] = 'checker ok'
    } else {
      results['lifecycle'] = 'no runner export'
    }
  } catch (e) {
    results['lifecycle'] = `ERR ${(e as Error).message}`
    log.err('TICK', `lifecycle: ${(e as Error).message}`)
  }

  // Give any in-flight Telegram messages ~2s to flush before we exit.
  await new Promise(r => setTimeout(r, 2000))

  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n[TICK COMPLETE] in ${dt}s`)
  for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${v}`)
}

main().catch(e => {
  console.error('[TICK] fatal:', e)
  process.exit(1)
})
