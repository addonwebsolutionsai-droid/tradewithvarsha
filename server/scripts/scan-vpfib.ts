/**
 * One-shot VP + FIB scanner runner.
 *
 *   npx ts-node --transpile-only scripts/scan-vpfib.ts
 *
 * Runs the 7-lens confluence scanner over the default universe
 * (existing snapshot symbols + hand-curated F&O leaders), writes the
 * result to server/data/public-snapshots/vp-fib.json. Meant for seed
 * runs on the dev box; the intraday-tick cron does the same in prod.
 */

import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../.env') })

import { scanVpFibConfluence, writeVpFibSnapshot } from '../src/engine/vpFibScanner'
import { log } from '../src/util/logger'

async function main() {
  const t0 = Date.now()
  log.info('SCAN-VPFIB', 'starting one-shot VP + FIB scan')

  const limit = Number(process.env.VPFIB_LIMIT ?? 150)
  const concurrency = Number(process.env.VPFIB_CONCURRENCY ?? 5)

  const out = await scanVpFibConfluence({ limit, concurrency })
  await writeVpFibSnapshot(out)

  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n✔ VP + FIB scan done in ${secs}s`)
  console.log(`  Scanned:  ${out.scanned}`)
  console.log(`  ELITE:    ${out.eliteCount}`)
  console.log(`  STRONG:   ${out.strongCount}`)
  console.log(`  DECENT:   ${out.decentCount}`)
  console.log(`  Written:  server/data/public-snapshots/vp-fib.json`)

  if (out.rows.length > 0) {
    console.log('\nTop 5:')
    for (const r of out.rows.slice(0, 5)) {
      console.log(`  ${r.symbol.padEnd(12)} ${r.side.padEnd(5)} · score ${String(r.confluenceScore).padStart(3)} (${r.tier}) · ${r.confluencesHit} confluences · R:R ${r.rrT1}`)
    }
  }
}

main().catch(e => {
  console.error('scan-vpfib failed:', e)
  process.exit(1)
})
