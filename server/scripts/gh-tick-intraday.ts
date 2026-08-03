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

  // Bypass gate for backtest / smoke-test runs (env FORCE_TICK=1)
  const forceTick = process.env.FORCE_TICK === '1'
  if (!isWeekday && !forceTick) {
    console.log('[TICK] Weekend — skipping.')
    return
  }
  if (!inWindow && !forceTick) {
    console.log('[TICK] Outside 09:15-15:30 IST market window — skipping.')
    return
  }
  if (forceTick) console.log('[TICK] FORCE_TICK=1 — running outside market window for smoke-test.')

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

  // ─── 3b. NIFTY Long-Horizon Forecast — projects levels + dates 2-3
  //          months out (Elliott weekly/monthly + Gann 90/180/270-day
  //          cycles + Fib price+time extensions + historical analogues).
  //          Weekly-scale signals but refreshed every intraday tick so
  //          "days from now" counters + intraday-drift-adjusted spot
  //          stay live. User asked to see future waypoints in advance
  //          so they can accumulate for anticipated moves.
  try {
    const t = Date.now()
    const { runAndPublishNiftyLongHorizon } = await import('../src/engine/niftyLongHorizonForecast')
    const r = await runAndPublishNiftyLongHorizon()
    results['nifty-long-horizon'] = `${r.bias} · ${r.waypoints} waypoints · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['nifty-long-horizon'] = `ERR ${(e as Error).message}`
    log.err('TICK', `nifty-long-horizon: ${(e as Error).message}`)
  }

  // ─── 3a-1. PRO Multi-TF Setups — the money-printing engine.
  //           NIFTY + XAUUSD + MCX Gold/Silver/Crude + top 25 F&O stocks
  //           scanned across 5m/15m/30m/1h/4h/1D via 7-lens confluence
  //           (VP + Fib + Volume + SMC + Liquidity Sweep + Seasonality
  //           + Astro overlay). Emits pro-setups.json with per-(inst,tf)
  //           setup + observation + dated targets + how-to-play.
  try {
    const t = Date.now()
    const { runProMultiTfSetups } = await import('../src/engine/proMultiTfSetups')
    const r = await runProMultiTfSetups()
    results['pro-setups'] = `${r.rows.length}/${r.totalScanned} setups (${r.eliteCount}E ${r.strongCount}S ${r.decentCount}D) · market ${r.marketOpen ? 'OPEN' : 'CLOSED'} · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['pro-setups'] = `ERR ${(e as Error).message}`
    log.err('TICK', `pro-setups: ${(e as Error).message}`)
  }

  // ─── 3a-1a. NIFTY Bias Composer (31 Jul 2026) — the Jul-25 miss fix.
  //           Composes OI-buildup + long-horizon + foresight + trend into
  //           ONE unified BULLISH/BEARISH call with trade plan. Also
  //           hydrates nifty-outlook.json when foresight returns NO_DATA
  //           so /nifty-outlook never renders empty.
  try {
    const t = Date.now()
    const { runNiftyBiasComposer } = await import('../src/engine/niftyBiasComposer')
    const r = await runNiftyBiasComposer()
    results['nifty-bias'] = `${r.direction} ${r.confidence} · net ${r.netScore} · ${r.sources.length} sources · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['nifty-bias'] = `ERR ${(e as Error).message}`
    log.err('TICK', `nifty-bias: ${(e as Error).message}`)
  }

  // ─── 3a-1b. Money-Printer Engine — the Moschip / Marksans / Epack /
  //           VIP / Hikal winning-setup pattern. Multi-TF harmonic OR
  //           Wave-3 + volume-accum + tight base. Runs BEFORE MASTER.
  try {
    const t = Date.now()
    const { runMoneyPrinterScan } = await import('../src/engine/moneyPrinterEngine')
    const r = await runMoneyPrinterScan()
    results['money-printer'] = `${r.emitted.length}/${r.candidatesEvaluated} qualified · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['money-printer'] = `ERR ${(e as Error).message}`
    log.err('TICK', `money-printer: ${(e as Error).message}`)
  }

  // ─── 3a-2. MASTER Setup Engine — the 85% WR curated feed (30 Jul 2026).
  //           Runs AFTER every underlying signal engine so joins see fresh
  //           data. Emits master-setups.json which /master surfaces with
  //           the 🏆 badge. Requires all 7 pillars: multi-source + winning-
  //           pattern + not-losing + smart-money + shareholding + sector +
  //           quality (chase, R:R, MC).
  try {
    const t = Date.now()
    const { runMasterSetupScan } = await import('../src/engine/masterSetupEngine')
    const r = await runMasterSetupScan()
    results['master-setups'] = `${r.emitted.length}/${r.candidatesEvaluated} passed all pillars · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['master-setups'] = `ERR ${(e as Error).message}`
    log.err('TICK', `master-setups: ${(e as Error).message}`)
  }

  // ─── 3b-1. F&O Futures scanner — 12-criteria pre-breakout scan across
  //           the ~211 NSE F&O underlyings. Was buried in localhost publicSnapshots
  //           publish path (bug: 16-day stale on GH Actions). Now wired into
  //           intraday-tick so it refreshes every 5 min like everything else.
  try {
    const t = Date.now()
    const { scanFnoFutures } = await import('../src/engine/fnoFuturesScanner')
    const rows = await scanFnoFutures({ limit: 25 })
    const fs2 = await import('fs')
    const path2 = await import('path')
    const out = {
      generatedAt: new Date().toISOString(),
      universeSize: rows.length,
      total: rows.length,
      highConvCount: rows.filter((r: any) => (r.score ?? 0) >= 8).length,
      medConvCount: rows.filter((r: any) => (r.score ?? 0) >= 6 && (r.score ?? 0) < 8).length,
      rows,
    }
    fs2.writeFileSync(path2.join(SNAPSHOT_DIR, 'fno-futures.json'), JSON.stringify(out, null, 2))
    results['fno-futures'] = `${rows.length} signals · ${out.highConvCount} high-conv · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['fno-futures'] = `ERR ${(e as Error).message}`
    log.err('TICK', `fno-futures: ${(e as Error).message}`)
  }

  // ─── 3c. F&O Stock Move Forecaster — 85 high-beta F&O stocks scanned
  //          through 7 lenses. Broadcasts ELITE-tier signals (top 5 per
  //          tick) to Telegram. broadcastSignal handles the 2-hour dedup
  //          per (instrument|direction|source-group) — same rule the rest
  //          of the pipeline uses so channel doesn't spam.
  try {
    const t = Date.now()
    const { runFnoStockMoveForecast } = await import('../src/engine/fnoStockMoveForecaster')
    const r = await runFnoStockMoveForecast()
    let bc = 0
    const elites = r.rows.filter(x => x.tier === 'ELITE').slice(0, 5)
    for (const row of elites) {
      try {
        const sig = {
          type: 'SWING' as const,
          direction: (row.side === 'SHORT' ? 'SHORT' : 'BUY') as 'BUY' | 'SHORT',
          instrument: row.symbol,
          symbol: row.symbol,
          score: Math.min(10, row.score / 10),
          grade: 'A' as const,
          source: 'FNO_FORECAST',
          conviction: row.score,
          entry: row.entry,
          stopLoss: row.stopLoss,
          target1: row.target1,
          target2: row.target2,
          target3: row.target3,
          reason: `🎯 F&O FORECAST · ${row.lensesHit}/7 lenses · ${row.observation.slice(0, 180)} · Play: ${row.bestWayToPlay.slice(0, 120)}`.slice(0, 400),
          time: Date.now(),
        } as unknown as Parameters<typeof broadcastSignal>[0]
        await broadcastSignal(sig)
        bc++
      } catch (e) { log.warn('TICK', `fno-forecast-broadcast ${row.symbol}: ${(e as Error).message}`) }
    }
    results['fno-stock-forecast'] = `${r.totalScored} forecasts (${r.eliteCount} elite · ${r.strongCount} strong · ${r.decentCount} decent) · ${bc} broadcast · ${((Date.now() - t) / 1000).toFixed(1)}s`
  } catch (e) {
    results['fno-stock-forecast'] = `ERR ${(e as Error).message}`
    log.err('TICK', `fno-stock-forecast: ${(e as Error).message}`)
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

  // ─── 4a-1. OI history logger — appends per-tick option chain snapshot
  //           to data/oi-history/ so options radar can compute velocity.
  //           MUST run BEFORE the OI buildup writer + radar so radar sees
  //           the freshest tick.
  try {
    const { logCurrentOiTick } = await import('../src/engine/oiHistoryLogger')
    const r = logCurrentOiTick()
    results['oi-history-log'] = `${r.ticksLogged} ticks across ${r.files.length} expiry files`
  } catch (e) {
    results['oi-history-log'] = `ERR ${(e as Error).message}`
    log.err('TICK', `oi-history-log: ${(e as Error).message}`)
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

  // ─── 4a-2. Options Accumulation Radar — reads the last N ticks of
  //           OI history per (expiry, strike, side), scores by velocity +
  //           premium-flow + freshness + IV + multi-expiry stacking, emits
  //           options-radar.json. Bootstraps after 4+ ticks accumulate.
  try {
    const { runOptionsAccumulationRadar } = await import('../src/engine/optionsAccumulationRadar')
    const r = await runOptionsAccumulationRadar()
    results['options-radar'] = `${r.signals.length} signals (${r.elites} elite · ${r.strongs} strong) from ${r.totalStrikesScanned} strikes`
  } catch (e) {
    results['options-radar'] = `ERR ${(e as Error).message}`
    log.err('TICK', `options-radar: ${(e as Error).message}`)
  }

  // ─── 4a-3. Paper trading book intraday tick — moved out of EOD so
  //           the book can act on the Options Radar's fresh signals in
  //           real time (not 6 hours later). Book state persists in
  //           trading-journal.json which the snapshot publisher pushes.
  try {
    const { runPaperTradingDailyTick } = await import('../src/engine/paperTradingBook')
    const book = await runPaperTradingDailyTick()
    // Broadcast each new trade opened this tick to Telegram. broadcastSignal
    // dedups per (instrument|direction|source-group) in 2h — same rule the
    // rest of the platform uses so the channel doesn't spam on re-runs.
    let bcPaper = 0
    const newTrades = (book as any).newTradesThisTick ?? []
    for (const t of newTrades) {
      try {
        const sig = {
          type: (t.segment === 'MCX' ? 'SWING' : (t.source?.includes('OPT') || t.source?.includes('FORESIGHT') ? 'OPTIONS' : 'SWING')) as 'SWING' | 'OPTIONS',
          direction: (t.direction === 'SHORT' ? 'SHORT' : 'BUY') as 'BUY' | 'SHORT',
          instrument: t.symbol,
          symbol: t.symbol,
          score: Math.min(10, (t.score ?? 60) / 10),
          grade: (t.tier === 'ELITE' ? 'A' : 'B') as 'A' | 'B',
          source: `PAPER_BOOK_${t.segment}`,
          conviction: t.score,
          entry: t.entryPrice,
          stopLoss: t.stopLoss,
          target1: t.target1,
          target2: t.target2,
          target3: t.target3,
          reason: `📓 JOURNAL ENTRY · ${t.segment} · ${t.tier} · qty ${t.qty} @ ₹${t.entryPrice} · position ₹${Math.round(t.positionValue).toLocaleString('en-IN')} · ${(t.entryReason ?? '').slice(0, 260)}`.slice(0, 400),
          time: Date.now(),
        } as unknown as Parameters<typeof broadcastSignal>[0]
        await broadcastSignal(sig)
        bcPaper++
      } catch (e) { log.warn('TICK', `paper-book-broadcast ${t.symbol}: ${(e as Error).message}`) }
    }
    results['paper-book'] = `₹${book.ledger.bookValue.toLocaleString('en-IN')} · ${book.ledger.totalReturnPct.toFixed(2)}% · open ${book.performance.openTrades} · closed ${book.performance.closedTrades} · +${bcPaper} broadcast`
  } catch (e) {
    results['paper-book'] = `ERR ${(e as Error).message}`
    log.err('TICK', `paper-book: ${(e as Error).message}`)
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
