/**
 * One-shot local backfill runner — resolves stuck-OPEN lifecycle entries
 * against candle history, then regenerates public-snapshots/accuracy.json
 * so the /track-record page shows the real hit rate.
 *
 * Usage: cd server && npx ts-node-dev --transpile-only scripts/run-backfill-now.ts
 * (env: reads server/../.env for Angel/data-fallback creds)
 */

import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

async function main() {
  const { backfillAllOpenLifecycle } = await import('../src/engine/lifecycleBackfill')
  console.log('[BACKFILL-LOCAL] starting…')
  const t0 = Date.now()

  // Chunk 1500 at a time — Angel session can go stale on longer runs. We can
  // invoke this script repeatedly until scanned=0.
  const r = await backfillAllOpenLifecycle({ maxEntries: 1500, concurrency: 6 })
  console.log(`\n[BACKFILL-LOCAL] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(`  scanned:    ${r.scannedEntries}`)
  console.log(`  resolved:   ${r.entriesResolved}`)
  console.log(`  triggered:  ${r.entriesTriggered}`)
  console.log(`  expired:    ${r.entriesExpired}`)
  console.log(`  unchanged:  ${r.entriesUnchanged}`)
  console.log(`  skipped:    ${r.entriesSkipped}`)
  console.log(`  by new status:`)
  for (const [k, v] of Object.entries(r.byNewStatus)) console.log(`    ${k}: ${v}`)
  console.log(`  by source:`)
  for (const [k, v] of Object.entries(r.bySource)) console.log(`    ${k}: resolved ${v.resolved} · won ${v.won} · lost ${v.lost} · expired ${v.expired}`)

  // Regenerate accuracy snapshot directly (skip the heavier publish pipeline).
  const fs = await import('fs')
  const { buildAccuracyReport } = await import('../src/engine/signalLifecycle')
  const accReport = await buildAccuracyReport({ source: 'ALL', daysBack: 30 })
  const snapPath = path.resolve(__dirname, '../data/public-snapshots/accuracy.json')
  fs.writeFileSync(snapPath, JSON.stringify(accReport, null, 2))
  console.log(`\n[BACKFILL-LOCAL] rewrote accuracy.json — WR ${accReport.winRate?.toFixed?.(1) ?? '?'}% · total ${accReport.total}`)
  for (const [src, v] of Object.entries(accReport.bySource ?? {}) as Array<[string, any]>) {
    console.log(`    ${src}: n=${v.total} · WR=${v.winRate?.toFixed?.(1) ?? '?'}%`)
  }
}

main().catch(e => {
  console.error('[BACKFILL-LOCAL] fatal:', e)
  process.exit(1)
})
