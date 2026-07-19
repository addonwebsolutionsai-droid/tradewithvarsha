/**
 * One-shot seeder for high-quality-setups.json.
 *
 *   npx ts-node --transpile-only scripts/seed-hqs.ts
 */
import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../.env') })

import { writeHighQualitySetups, buildHighQualitySetups } from '../src/engine/highQualitySetups'

async function main() {
  const t0 = Date.now()
  const out = await buildHighQualitySetups()
  await writeHighQualitySetups()
  console.log(`\n✔ high-quality-setups.json written in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(`  F&O:     ${out.totals.fno}`)
  console.log(`  CASH:    ${out.totals.cash}`)
  console.log(`  ELITE:   ${out.totals.elite}`)
  console.log(`  STRONG:  ${out.totals.strong}`)
  console.log(`  Sources: ${JSON.stringify(out.sources)}`)
  console.log('\nTop 5 F&O:')
  for (const s of out.fno.slice(0, 5)) {
    console.log(`  ${s.symbol.padEnd(14)} ${s.side.padEnd(5)} · ${s.tier.padEnd(6)} · score ${String(s.score).padStart(3)} · ${s.source}`)
  }
  console.log('\nTop 5 CASH:')
  for (const s of out.cash.slice(0, 5)) {
    console.log(`  ${s.symbol.padEnd(14)} ${s.side.padEnd(5)} · ${s.tier.padEnd(6)} · score ${String(s.score).padStart(3)} · ${s.source}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
