import { fetchXRecommendations } from '../src/data/xRecommendations'
import fs from 'fs/promises'
import path from 'path'

(async () => {
  const data = await fetchXRecommendations()
  const outPath = path.resolve(__dirname, '..', 'data', 'public-snapshots', 'x-recs.json')
  await fs.writeFile(outPath, JSON.stringify(data, null, 2))
  console.log(`✅ x-recs regenerated · ${data.recommendations.length} parsed recommendations`)
  console.log(`Per-handle sources:`)
  for (const [h, s] of Object.entries(data.bySite)) console.log(`  @${h.padEnd(20)} → ${s}`)
  process.exit(0)
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
