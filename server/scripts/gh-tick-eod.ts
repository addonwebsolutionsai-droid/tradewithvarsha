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
