import { aggregateConfluence } from '../src/engine/crossEngineConfluence'
import fs from 'fs/promises'
import path from 'path'

(async () => {
  const conf = await aggregateConfluence()
  const outPath = path.resolve(__dirname, '..', 'data', 'public-snapshots', 'cross-confluence.json')
  await fs.writeFile(outPath, JSON.stringify(conf, null, 2))
  console.log(`✅ regenerated · ${conf.rows.length} rows · ultra=${conf.ultraCount} strong=${conf.strongCount}`)
  // Verify NO greek labels
  const raw = await fs.readFile(outPath, 'utf8')
  const greek = raw.match(/Engine [αβγδε]/g)
  if (greek) console.log('⚠️ STILL HAS GREEK:', greek.slice(0, 5))
  else console.log('✅ No greek labels')
  // Sample first row's reasoning
  if (conf.rows[0]) {
    console.log('\nFirst row:')
    console.log('  symbol:', conf.rows[0].symbol, '· sources:', conf.rows[0].sources)
    console.log('  reasoning:', conf.rows[0].reasoning?.slice(0, 4))
    console.log('  shareholding:', conf.rows[0].shareholdingNote)
  }
  process.exit(0)
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
