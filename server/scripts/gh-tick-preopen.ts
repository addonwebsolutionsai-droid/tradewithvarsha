/**
 * GitHub Actions Mon-Fri 08:30 IST pre-open snapshot top-up.
 *
 * Refreshes the tabs that populate the user's morning dashboard, so all
 * snapshots are current the moment market opens at 09:15 IST.
 *
 * Called by .github/workflows/pre-open.yml on `30 3 * * 1-5` UTC.
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
  console.log(`[SNAPSHOT] wrote ${name}`)
}

async function main() {
  const t0 = Date.now()
  createBot()

  const steps: Array<[string, () => Promise<string>]> = [
    ['pedigree-accumulation', async () => {
      const m = await import('../src/engine/pedigreeAccumulation')
      const p = await m.runAndPublishPedigree()
      return `${p.total} candidates`
    }],
    ['chart-patterns', async () => {
      const m = await import('../src/engine/chartPatterns')
      const c = await m.runAndPublishChartPatterns()
      return `${c.total} pattern hits`
    }],
    ['insider-buys', async () => {
      const m = await import('../src/engine/insiderBuysEngine')
      const i = await m.runAndPublishInsiderBuys()
      return `${i.total} candidates (${i.strongCount} STRONG)`
    }],
    ['early-momentum', async () => {
      const m = await import('../src/engine/earlyMomentum')
      const e = await m.runAndPublishEarlyMomentum()
      return `${e.total} candidates`
    }],
    ['nifty-outlook', async () => {
      const m = await import('../src/engine/niftyForesight')
      const n = await m.runAndPublishNiftyForesight()
      return `${n.direction} ${n.confidence} (net ${n.netScore})`
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
  ]

  for (const [name, fn] of steps) {
    try {
      const summary = await fn()
      log.ok('PRE-OPEN', `✓ ${name}: ${summary}`)
    } catch (e) {
      log.warn('PRE-OPEN', `✗ ${name}: ${(e as Error).message}`)
    }
  }

  await new Promise(r => setTimeout(r, 2000))
  console.log(`\n[PRE-OPEN COMPLETE] in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main().catch(e => {
  console.error('[PRE-OPEN] fatal:', e)
  process.exit(1)
})
