/**
 * GitHub Actions Mon-Fri 18:30 IST end-of-day routine.
 *
 * Runs the full learning + scan + self-improve cascade so tomorrow's
 * signals are ready before 08:30 pre-open.
 *
 * Called by .github/workflows/eod.yml on `0 13 * * 1-5` UTC.
 */

import path from 'path'
import fs from 'fs'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../.env') })

import { log } from '../src/util/logger'
import { createBot } from '../src/bots/telegram'

const SNAPSHOT_DIR = path.resolve(__dirname, '../data/public-snapshots')

async function writeSnapshot(name: string, data: unknown): Promise<void> {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true })
  fs.writeFileSync(path.join(SNAPSHOT_DIR, name), JSON.stringify(data, null, 2))
}

async function main() {
  const t0 = Date.now()
  createBot()

  const steps: Array<[string, () => Promise<string>]> = [
    ['mover-patterns', async () => {
      const m = await import('../src/engine/moverPatternMiner')
      const r = await m.mineTodaysMoverPatterns()
      if (typeof m.publishMoverArchetypesSnapshot === 'function') {
        await m.publishMoverArchetypesSnapshot()
      }
      return `${r.added} new fingerprints (store ${r.total})`
    }],
    ['pedigree-accumulation', async () => {
      const m = await import('../src/engine/pedigreeAccumulation')
      const p = await m.runAndPublishPedigree()
      return `${p.total} candidates`
    }],
    ['x-recs', async () => {
      const m = await import('../src/data/xRecommendations')
      const x = await m.fetchXRecommendations()
      await writeSnapshot('x-recs.json', x)
      return `${x.recommendations.length} parsed`
    }],
    ['chart-patterns', async () => {
      const m = await import('../src/engine/chartPatterns')
      const c = await m.runAndPublishChartPatterns()
      return `${c.total} hits`
    }],
    ['insider-buys', async () => {
      const m = await import('../src/engine/insiderBuysEngine')
      const i = await m.runAndPublishInsiderBuys()
      return `${i.total} candidates (${i.strongCount} STRONG)`
    }],
    ['nifty-outlook', async () => {
      const m = await import('../src/engine/niftyForesight')
      const n = await m.runAndPublishNiftyForesight()
      return `${n.direction} ${n.confidence} (net ${n.netScore})`
    }],
    ['early-momentum', async () => {
      const m = await import('../src/engine/earlyMomentum')
      const e = await m.runAndPublishEarlyMomentum()
      return `${e.total} candidates`
    }],
    ['cross-confluence', async () => {
      const m = await import('../src/engine/crossEngineConfluence')
      const c = await m.aggregateConfluence()
      await writeSnapshot('cross-confluence.json', c)
      return `${c.rows.length} picks`
    }],
    ['pro-edge', async () => {
      const m = await import('../src/engine/proEdge')
      const pe = await m.aggregateProEdge({ minConviction: 85 })
      await writeSnapshot('pro-edge.json', pe)
      const rowsLen = Array.isArray((pe as { rows?: unknown[] }).rows) ? (pe as { rows: unknown[] }).rows.length : 0
      return `${rowsLen} signals`
    }],
    ['miss-analysis', async () => {
      const m = await import('../src/engine/missAnalyzer')
      const r = await m.runMissAnalysis()
      // Publish snapshot the /5-20-move + /desk consume
      const fs = await import('fs')
      const path = await import('path')
      const outPath = path.resolve(__dirname, '../data/public-snapshots/miss-analysis.json')
      fs.writeFileSync(outPath, JSON.stringify(r, null, 2))
      return `${r.caughtCount}/${r.totalGainers} caught (${(r.catchRate * 100).toFixed(1)}%)`
    }],
    ['gainer-postmortem', async () => {
      const m = await import('../src/engine/gainerPostmortem')
      const r = await m.runGainerPostmortem()
      const fs = await import('fs')
      const path = await import('path')
      const outPath = path.resolve(__dirname, '../data/public-snapshots/gainer-postmortem.json')
      fs.writeFileSync(outPath, JSON.stringify(r, null, 2))
      return `${r.wouldHaveCaughtCount}/${r.totalGainers} would've been caught with tuning`
    }],
    ['miss-digest', async () => {
      const m = await import('../src/engine/missDigest')
      const r = await m.sendMissDigest()
      return `sent to ${r.sent} chats`
    }],
    ['daily-summary', async () => {
      const m = await import('../src/engine/dailyPerformanceSummary')
      const r = await m.sendDailyPerformanceSummary()
      return `sent to ${r.sent} chats`
    }],
    ['elliott-wave', async () => {
      const m = await import('../src/engine/elliottWaveEngine')
      const r = await m.runAndPublishElliottWave()
      return `${r.total} wave setups`
    }],
    ['nifty-outlook', async () => {
      const m = await import('../src/engine/niftyForesight')
      const r = await m.runAndPublishNiftyForesight()
      return `${r.direction} ${r.confidence} @${r.spot}`
    }],
    ['nifty-volume-profile', async () => {
      const m = await import('../src/engine/niftyVolumeProfileEngine')
      const r = await m.runAndPublishNiftyVolumeProfile()
      return `${r.bias} ${r.confidence} @${r.spot}`
    }],
    ['harmonic', async () => {
      const m = await import('../src/engine/harmonicScanner')
      const run = await m.runHarmonicScan({ tier: 'POSITIONAL' })
      // Also publish snapshot directly since the cron path uses index.ts state.
      const fs = await import('fs')
      const path = await import('path')
      const enrichM = await import('../src/lib/reasonEnrichment')
      const mapped = run.hits.slice(0, 200).map(h => ({
        symbol: h.symbol, direction: h.trade, conviction: h.confidence, score: h.confidence,
        ltp: h.ltp, entry: h.entry, stopLoss: h.stopLoss,
        target1: h.target1, target2: h.target2, target3: h.target3,
        entryDate: h.entryDate, target1Date: h.target1Date, target2Date: h.target2Date, target3Date: h.target3Date,
        pattern: `${h.patternName} · ${h.direction}`, source: 'HARMONIC',
        reasons: h.reasons, reasoning: h.reasons,
        riskReward: h.riskReward, prz: [h.przLow, h.przHigh],
        invalidationPrice: h.invalidationPrice, invalidationRule: h.invalidationRule,
        tier: h.tier, timeframe: h.timeframe,
      }))
      const rows = enrichM.enrichRows(mapped as unknown as Array<Record<string, unknown>>, 'chartPattern')
      const outPath = path.resolve(__dirname, '../data/public-snapshots/harmonic.json')
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      fs.writeFileSync(outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        criterion: 'Harmonic scanner · Gartley / Bat / Butterfly / Crab / Shark / Cypher with PRZ + invalidation',
        total: rows.length,
        byPattern: rows.reduce((a: Record<string, number>, r: Record<string, unknown>) => { const p = String(r.pattern ?? ''); a[p] = (a[p] ?? 0) + 1; return a }, {}),
        byTier: { POSITIONAL: rows.length },
        rows,
      }, null, 2))
      return `${run.hits.length} harmonic hits (positional)`
    }],
    ['stock-fno-volume-profile', async () => {
      const m = await import('../src/engine/stockFnoVolumeProfileScanner')
      const r = await m.runAndPublishStockFnoVolumeProfile()
      return `scanned ${r.scanned} · ${r.total} setups (${r.bullCount} bull · ${r.bearCount} bear)`
    }],
    ['lifecycle-backfill', async () => {
      const { backfillAllOpenLifecycle } = await import('../src/engine/lifecycleBackfill')
      // Cap so a single EOD run stays bounded; if store has 20k+ stuck
      // trades, subsequent EODs chew through the tail.
      const r = await backfillAllOpenLifecycle({ maxEntries: 3000, concurrency: 6 })
      return `scanned ${r.scannedEntries} · resolved ${r.entriesResolved} (won ${Object.values(r.bySource).reduce((s, v) => s + v.won, 0)} · lost ${Object.values(r.bySource).reduce((s, v) => s + v.lost, 0)}) · triggered ${r.entriesTriggered} · expired ${r.entriesExpired}`
    }],
    ['bulk-deals', async () => {
      const m = await import('../src/engine/superstarPicksScanner')
      const runner: unknown = (m as { runAndPublishBulkDeals?: () => Promise<{ total?: number }> }).runAndPublishBulkDeals
      if (typeof runner === 'function') {
        const r = await (runner as () => Promise<{ total?: number }>)()
        return `${r.total ?? 0} bulk-deal footprints`
      }
      return 'no runner export'
    }],
    // ─── VP + FIB confluence — belt-and-braces so EOD refreshes the
    //     snapshot even if all intraday ticks missed (Actions delays /
    //     rate limits / network). Full MARKET_ALL universe, 6-min budget
    //     (EOD has more headroom than intraday).
    ['vp-fib', async () => {
      const m = await import('../src/engine/vpFibScanner')
      const r = await m.scanVpFibConfluence({
        universe: 'MARKET_ALL',
        concurrency: 25,
        maxRuntimeMs: 6 * 60_000,
      })
      await m.writeVpFibSnapshot(r)
      return `${r.rows.length} setups (${r.eliteCount} elite · ${r.strongCount} strong · ${r.decentCount} decent)`
    }],
    // ─── High-Quality Setups feed for addon-products-home /v2/.
    //     Composes VP+FIB + PRO-Edge + Cross-Confluence + Weekly/Daily
    //     Picks after they've all been refreshed above.
    ['high-quality-setups', async () => {
      const m = await import('../src/engine/highQualitySetups')
      await m.writeHighQualitySetups()
      return 'written'
    }],
    // ─── Daily self-improvement loop (mirrors the localhost 18:30 IST
    //     cron in server/src/index.ts). Runs on GH Actions as backup so
    //     auto-tune fires even if the local server is off.
    ['self-improve', async () => {
      const m = await import('../src/engine/selfImprove')
      const tune = await m.runSelfImprove()
      const overrides = Object.keys(tune?.overrides ?? {}).length
      const newAdj = (tune?.adjustments ?? []).filter(a => a.ts >= new Date(Date.now() - 24 * 3600_000).toISOString()).length
      return `${overrides} strategy overrides · +${newAdj} new adjustments`
    }],
  ]

  for (const [name, fn] of steps) {
    try {
      const summary = await fn()
      log.ok('EOD', `✓ ${name}: ${summary}`)
    } catch (e) {
      log.warn('EOD', `✗ ${name}: ${(e as Error).message}`)
    }
  }

  await new Promise(r => setTimeout(r, 2000))
  console.log(`\n[EOD COMPLETE] in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch(e => {
  console.error('[EOD] fatal:', e)
  process.exit(1)
})
