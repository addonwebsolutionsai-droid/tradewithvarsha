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

  // ─── 1b. VP + FIB Confluence — the 7-lens PRO trader master scanner.
  //          Combines Volume Profile · Fib · Order Block · Liquidity Grab ·
  //          Elliott · Harmonic · Volume Engine into one confluence score.
  //          Reads elliott-wave.json + harmonic.json on disk, so must run
  //          AFTER those snapshots are refreshed (see gh-tick-eod).
  //          Full MARKET_ALL universe (NSE + BSE, ~11.5k) with a 4-min
  //          wall-clock budget — as many symbols as fit in the window get
  //          scanned; leftovers roll into the next tick.
  try {
    const t = Date.now()
    const { scanVpFibConfluence, writeVpFibSnapshot } = await import('../src/engine/vpFibScanner')
    const out = await scanVpFibConfluence({
      universe: 'MARKET_ALL',
      concurrency: 25,
      maxRuntimeMs: 4 * 60_000,
    })
    await writeVpFibSnapshot(out)
    results['vp-fib'] = `attempted ${out.attempted} · ${out.rows.length} setups (${out.eliteCount} elite · ${out.strongCount} strong · ${out.decentCount} decent) · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['vp-fib'] = `ERR ${(e as Error).message}`
    log.err('TICK', `vp-fib: ${(e as Error).message}`)
  }

  // ─── 1c. High-Quality Setups snapshot for external Vercel projects
  //          (addon-products-home /v2/). Composes VP+FIB + PRO-Edge +
  //          Cross-Confluence + Weekly + Daily picks, filters ELITE +
  //          STRONG only, splits by F&O eligibility, publishes.
  //          Must run AFTER vp-fib + pro-edge + cross-confluence so it
  //          sees the freshest source data.
  try {
    const t = Date.now()
    const { writeHighQualitySetups } = await import('../src/engine/highQualitySetups')
    await writeHighQualitySetups()
    results['high-quality-setups'] = `written · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['high-quality-setups'] = `ERR ${(e as Error).message}`
    log.err('TICK', `high-quality-setups: ${(e as Error).message}`)
  }

  // ─── 2. PRO Edge (downstream of confluence)
  try {
    const { aggregateProEdge } = await import('../src/engine/proEdge')
    const pe = await aggregateProEdge({ minConviction: 85 })
    await writeSnapshot('pro-edge.json', pe)
    const peRows = Array.isArray((pe as { rows?: unknown[] }).rows) ? ((pe as { rows: unknown[] }).rows as Array<Record<string, unknown>>) : []

    // 2026-07-16 — broadcast the TOP-3 fresh PRO Edge picks to Telegram.
    // Yesterday's fix was too strict: intraday tick only broadcast the
    // (blocked) stock-option scalps and never surfaced the pre-move
    // PRO Edge picks that ARE the money-printing setups. broadcastSignal
    // handles dedup + rate caps + filter — we just have to feed it a Signal.
    let peBroadcast = 0
    for (const r of peRows.slice(0, 3)) {
      try {
        const symbol = String(r.symbol ?? '')
        const direction = (r.direction === 'SHORT' || r.direction === 'SELL') ? 'SHORT' : 'BUY'
        const conv = Number(r.conviction ?? 0)
        if (!symbol || conv < 85) continue
        const sig = {
          type: 'SWING' as const,
          direction: direction as 'BUY' | 'SHORT',
          instrument: symbol,
          symbol,
          score: Math.min(10, conv / 10),
          grade: 'A' as const,
          source: 'PRO_EDGE',
          conviction: conv,
          entry: Number(r.entry ?? 0),
          stopLoss: Number(r.stopLoss ?? 0),
          target1: Number(r.target1 ?? 0),
          target2: Number(r.target2 ?? 0),
          target3: Number(r.target3 ?? 0),
          reason: Array.isArray(r.reasoning) ? (r.reasoning as string[]).join(' · ').slice(0, 400) : '',
          time: Date.now(),
        } as unknown as Parameters<typeof broadcastSignal>[0]
        await broadcastSignal(sig)
        peBroadcast++
      } catch (e) { log.warn('TICK', `pe-broadcast: ${(e as Error).message}`) }
    }
    results['pro-edge'] = `${peRows.length} signals · ${peBroadcast} broadcast (top-3)`
  } catch (e) {
    results['pro-edge'] = `ERR ${(e as Error).message}`
    log.err('TICK', `pro-edge: ${(e as Error).message}`)
  }

  // ─── 2b. NIFTY Volume Profile (multi-TF POC/VAH/VAL/HVN/LVN detector)
  //         Emits an ATM PE/CE recommendation when 2+ timeframes agree.
  try {
    const { runAndPublishNiftyVolumeProfile, runNiftyVolumeProfile } = await import('../src/engine/niftyVolumeProfileEngine')
    const vp = await runAndPublishNiftyVolumeProfile()
    results['nifty-volume-profile'] = vp.ok
      ? `${vp.bias} ${vp.confidence} · ${vp.setup} @${vp.spot}`
      : 'no candles'
    // Broadcast VP recommendation when confidence ≥ MEDIUM and a side is set.
    if (vp.ok && (vp.confidence === 'HIGH' || vp.confidence === 'MEDIUM')) {
      const full = await runNiftyVolumeProfile()
      if (full?.tradeRecommendation && full.tradeRecommendation.side !== 'WAIT' && full.tradeRecommendation.optionType) {
        const rec = full.tradeRecommendation
        const inst = rec.instrument.startsWith('NIFTY') ? rec.instrument : `NIFTY ${rec.optionStrike} ${rec.optionType}`
        const sig = {
          type: 'OPTIONS' as const,
          direction: (rec.side === 'SELL' ? 'SHORT' : 'BUY') as 'BUY' | 'SHORT',
          instrument: inst,
          symbol: inst,
          score: full.confidence === 'HIGH' ? 10 : 9,
          grade: 'A' as const,
          source: 'NIFTY_VOLUME_PROFILE',
          conviction: full.confidence === 'HIGH' ? 90 : 75,
          entry: rec.entry,
          stopLoss: rec.stopLoss,
          target1: rec.target1,
          target2: rec.target2,
          target3: rec.target3,
          reason: (rec.rationale || '').slice(0, 400),
          time: Date.now(),
        } as unknown as Parameters<typeof broadcastSignal>[0]
        try { await broadcastSignal(sig) } catch (e) { log.warn('TICK', `vp-broadcast: ${(e as Error).message}`) }
      }
    }
  } catch (e) {
    results['nifty-volume-profile'] = `ERR ${(e as Error).message}`
    log.err('TICK', `nifty-volume-profile: ${(e as Error).message}`)
  }

  // ─── 3. NIFTY Directional Foresight (writes own snapshot)
  try {
    const { runAndPublishNiftyForesight, runNiftyForesight } = await import('../src/engine/niftyForesight')
    const nf = await runAndPublishNiftyForesight()
    results['nifty-outlook'] = nf.ok
      ? `${nf.direction} ${nf.confidence} (net ${nf.netScore}) @${nf.spot}${nf.playbook.length > 0 ? ' · ' + nf.playbook.join(',') : ''}`
      : 'no OC data'
    // Broadcast when confidence ≥ HIGH and direction is decisive.
    if (nf.ok && nf.confidence === 'HIGH' && nf.direction !== 'NEUTRAL') {
      const full = await runNiftyForesight()
      if (full?.tradePlan && full.tradePlan.side !== 'WAIT') {
        const tp = full.tradePlan
        const sig = {
          type: 'OPTIONS' as const,
          direction: (tp.side === 'SELL' ? 'SHORT' : 'BUY') as 'BUY' | 'SHORT',
          instrument: tp.instrument,
          symbol: tp.instrument,
          score: 10,
          grade: 'A' as const,
          source: 'NIFTY_OUTLOOK',
          conviction: 90,
          entry: tp.entry,
          stopLoss: tp.stopLoss,
          target1: tp.target1,
          target2: tp.target2,
          target3: tp.target3,
          reason: full.reasoning?.playbook || full.reasoning?.multiExpiryOI?.join(' · ') || '',
          time: Date.now(),
        } as unknown as Parameters<typeof broadcastSignal>[0]
        try { await broadcastSignal(sig) } catch (e) { log.warn('TICK', `nf-broadcast: ${(e as Error).message}`) }
      }
    }
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

  // ─── 4a. OI Buildup snapshot writer — extracted from publicSnapshots.ts
  //         so the /oi-buildup public page gets a real-time refresh on GH
  //         Actions runners too (previously only localhost cron wrote it,
  //         so the file went stale for days at a time). Writes 5 min tick.
  try {
    const { writeOiBuildupSnapshot } = await import('../src/engine/oiBuildupWriter')
    const r = await writeOiBuildupSnapshot()
    results['oi-buildup'] = `${r.rows} rows · ${r.symbols.length} symbols · ${r.dataMode}`
  } catch (e) {
    results['oi-buildup'] = `ERR ${(e as Error).message}`
    log.err('TICK', `oi-buildup: ${(e as Error).message}`)
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

  // ─── Snapshot enrichment pass ────────────────────────────────────
  // Every snapshot writer above completed; now walk the public-snapshots
  // dir and enrich each JSON's rows with shareholding data (FII/DII/
  // Promoter/Pledge/MC + smartMoneyUp flag). Rows that already have
  // shareholdingNote are skipped, so this is idempotent + cheap on
  // subsequent ticks.
  try {
    const t = Date.now()
    const { enrichSnapshotFile } = await import('../src/util/enrichShareholding')
    const targets = [
      'early-momentum.json', 'pre-move-identifier.json', 'elite-picks.json',
      'chart-patterns.json', 'harmonic.json', 'elliott-wave.json',
      'insider-buys.json', 'pedigree-accumulation.json', 'bulk-deals.json',
      'superstar-picks.json', 'pro-edge.json', 'cross-confluence.json',
      'ad-divergence.json', 'options.json', 'multi-strike-oi.json',
      'oi-buildup.json', 'stock-fno-volume-profile.json', 'vp-fib.json',
      'high-quality-setups.json',
    ]
    for (const name of targets) {
      const p = path.join(SNAPSHOT_DIR, name)
      await enrichSnapshotFile(p, { withVolume: false })
    }
    results['shareholding-enrich'] = `${targets.length} files · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['shareholding-enrich'] = `ERR ${(e as Error).message}`
    log.err('TICK', `shareholding-enrich: ${(e as Error).message}`)
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
