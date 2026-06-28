/**
 * One-shot regen of every empty/missing public snapshot — covers the
 * tabs the user reported as empty (/chart-patterns, /bulk-deals,
 * /pedigree) plus refreshes early-momentum + cross-confluence + pro-edge
 * so the whole system is hot for Monday pre-market open.
 */
import fs from 'fs/promises'
import path from 'path'

const SNAP_DIR = path.resolve(__dirname, '..', 'data', 'public-snapshots')

async function run(label: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now()
  process.stdout.write(`▶ ${label} ... `)
  try {
    await fn()
    process.stdout.write(`✅  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
  } catch (e) {
    process.stdout.write(`❌ ${(e as Error).message}\n`)
  }
}

;(async () => {
  console.log('═══ Pre-Monday snapshot prep — running all scans ═══\n')

  await run('pedigree-accumulation', async () => {
    const { runAndPublishPedigree } = await import('../src/engine/pedigreeAccumulation')
    const out = await runAndPublishPedigree()
    console.log(`    → ${out.total} candidates (${out.deepCount} DEEP · ${out.moderateCount} MOD)`)
  })

  await run('chart-patterns', async () => {
    const { runAndPublishChartPatterns } = await import('../src/engine/chartPatterns')
    const out = await runAndPublishChartPatterns()
    console.log(`    → ${out.total} pattern hits · ${Object.keys(out.byPattern).length} distinct patterns`)
    if (Object.keys(out.byPattern).length > 0) {
      console.log(`    → top patterns: ${Object.entries(out.byPattern).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' · ')}`)
    }
  })

  await run('bulk-deals (NSE bulk + block)', async () => {
    const { fetchTodaysBulkDeals, aggregateBySymbol } = await import('../src/data/nseBulkDeals')
    const deals = await fetchTodaysBulkDeals()
    const bySymbol = aggregateBySymbol(deals)
    const out = {
      generatedAt: new Date().toISOString(),
      totalDeals: deals.length,
      superstarDeals: deals.filter((d: any) => d.category === 'SUPERSTAR').length,
      institutionDeals: deals.filter((d: any) => d.category === 'INSTITUTION').length,
      strongAccumulationCount: bySymbol.filter((s: any) => s.signal === 'STRONG_ACCUMULATION').length,
      strongDistributionCount: bySymbol.filter((s: any) => s.signal === 'STRONG_DISTRIBUTION').length,
      rows: bySymbol.slice(0, 100),
      rawDeals: deals.slice(0, 200),
    }
    await fs.writeFile(path.join(SNAP_DIR, 'bulk-deals.json'), JSON.stringify(out, null, 2))
    console.log(`    → ${deals.length} deals · ${out.strongAccumulationCount} strong-accum · ${out.strongDistributionCount} strong-dist`)
    if (deals.length === 0) {
      console.log('    → NOTE: NSE rate-limited or weekend (no deals filed today). Try again Monday EOD.')
    }
  })

  await run('early-momentum (₹50-500 pre-move radar)', async () => {
    const { runAndPublishEarlyMomentum } = await import('../src/engine/earlyMomentum')
    const out = await runAndPublishEarlyMomentum()
    console.log(`    → ${out.total} candidates (${out.tierCounts.EARLY ?? 0} EARLY · ${out.tierCounts.WAVE_2 ?? 0} WAVE_2 · ${out.tierCounts.CONFIRMED ?? 0} CONFIRMED)`)
  })

  await run('cross-confluence (Ultra Picks)', async () => {
    const { aggregateConfluence } = await import('../src/engine/crossEngineConfluence')
    const conf = await aggregateConfluence()
    await fs.writeFile(path.join(SNAP_DIR, 'cross-confluence.json'), JSON.stringify(conf, null, 2))
    console.log(`    → ${conf.rows.length} confluence picks (ultra=${conf.ultraCount} strong=${conf.strongCount})`)
  })

  await run('pro-edge (premium curated)', async () => {
    const { aggregateProEdge } = await import('../src/engine/proEdge')
    const pro = await aggregateProEdge({ minConviction: 85 })
    await fs.writeFile(path.join(SNAP_DIR, 'pro-edge.json'), JSON.stringify(pro, null, 2))
    console.log(`    → ${(pro as any).rows?.length ?? 0} signals`)
  })

  await run('mover archetypes (pattern miner)', async () => {
    const { mineTodaysMoverPatterns, publishMoverArchetypesSnapshot } = await import('../src/engine/moverPatternMiner')
    const mine = await mineTodaysMoverPatterns()
    await publishMoverArchetypesSnapshot()
    console.log(`    → added ${mine.added} fingerprints (store total ${mine.total})`)
  })

  await run('x-recs (analyst posts, filtered)', async () => {
    const { fetchXRecommendations } = await import('../src/data/xRecommendations')
    const x = await fetchXRecommendations()
    await fs.writeFile(path.join(SNAP_DIR, 'x-recs.json'), JSON.stringify(x, null, 2))
    console.log(`    → ${x.recommendations.length} actionable parsed`)
  })

  console.log('\n═══ All scans complete ═══')
  process.exit(0)
})().catch(e => { console.error('FATAL:', e); process.exit(1) })
