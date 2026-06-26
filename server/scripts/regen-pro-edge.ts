import { aggregateProEdge } from '../src/engine/proEdge'
import fs from 'fs/promises'
import path from 'path'

(async () => {
  const out = await aggregateProEdge({ minConviction: 85 })
  const outPath = path.resolve(__dirname, '..', 'data', 'public-snapshots', 'pro-edge.json')
  await fs.writeFile(outPath, JSON.stringify(out, null, 2))
  console.log(`✅ pro-edge regenerated · ${(out as any).rows?.length ?? 0} rows`)
  const raw = await fs.readFile(outPath, 'utf8')
  const greek = raw.match(/Engine [αβγδε]/g)
  if (greek) console.log('⚠️ STILL HAS GREEK:', greek.slice(0, 5))
  else console.log('✅ No greek labels')
  process.exit(0)
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
