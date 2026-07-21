/**
 * One-shot: enrich every public snapshot with shareholding data.
 *
 *   npx ts-node --transpile-only scripts/enrich-all-snapshots.ts
 *
 * Idempotent — rows that already have shareholdingNote are skipped.
 */
import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../.env') })

import { enrichSnapshotFile } from '../src/util/enrichShareholding'
import fs from 'fs'

const SNAP_DIR = path.resolve(__dirname, '../data/public-snapshots')

async function main() {
  const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json'))
  console.log(`\nEnriching ${files.length} snapshot files in ${SNAP_DIR}\n`)
  const t0 = Date.now()
  for (const f of files) {
    await enrichSnapshotFile(path.join(SNAP_DIR, f), { withVolume: false })
  }
  console.log(`\n✔ done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}
main().catch(e => { console.error(e); process.exit(1) })
