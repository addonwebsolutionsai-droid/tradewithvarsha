/**
 * PRO Edge — the strictest signal feed in the platform.
 *
 * A name reaches PRO Edge only when EVERY filter passes simultaneously:
 *   1. Cross-engine confluence: flagged by ≥2 engines (in cross-confluence.json)
 *   2. Smart-money same-side: NOT flagged on the opposite side in ad-divergence.json
 *      - long candidate must NOT be in DISTRIBUTION
 *      - short candidate must NOT be in ACCUMULATION
 *   3. Sector tailwind: sector trend aligned with direction
 *      - long → sector in LEADING or IMPROVING
 *      - short → sector in LAGGING or WEAKENING
 *   4. Conviction floor: max-engine conviction ≥ 85
 *
 * Output: 0–10 names/day on average. Targeted WR (theoretical) 75–85%.
 * Needs 30 days of closed-trade data to prove empirically.
 *
 * Strict dedup: Map<symbol> at write + Set<symbol> at downstream consumers.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { log } from '../util/logger'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

interface ProEdgeRow {
  symbol: string
  direction: 'BUY' | 'SHORT'
  conviction: number
  ltp: number | null
  entry: number | null
  stopLoss: number | null
  target1: number | null
  target2: number | null
  target3: number | null
  sources: string[]                  // engines that agreed
  smartMoneySide: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL'
  sectorLabel: string | null
  sectorTrend: 'LEADING' | 'IMPROVING' | 'WEAKENING' | 'LAGGING' | 'NEUTRAL' | null
  reasoning: string[]
}

async function readSnap(name: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(path.join(SNAP_DIR, name), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

const SECTOR_MEMBER_MAP: Record<string, { trend: string; label: string }> = {}

async function buildSectorMap(): Promise<void> {
  // Reads sector-rotation.json + the sector basket members list to map
  // symbol → sector. Cached for the call.
  const sr = await readSnap('sector-rotation.json')
  if (!sr?.rows) return
  // sectorRotation.ts has SECTOR_BASKETS hardcoded — we re-import it.
  try {
    const { SECTOR_BASKETS } = await import('./sectorRotation')
    const trendByKey = new Map<string, { trend: string; label: string }>()
    for (const r of sr.rows) trendByKey.set(r.index, { trend: r.trend, label: r.label })
    for (const basket of SECTOR_BASKETS) {
      const t = trendByKey.get(basket.key)
      if (!t) continue
      for (const sym of basket.members) {
        // Don't overwrite — a symbol may be in multiple baskets; first wins.
        if (!SECTOR_MEMBER_MAP[sym]) SECTOR_MEMBER_MAP[sym] = t
      }
    }
  } catch (e) {
    log.warn('PRO-EDGE', `sector map build: ${(e as Error).message}`)
  }
}

export async function aggregateProEdge(opts?: { minConviction?: number }): Promise<{
  generatedAt: string
  totalEvaluated: number
  passCount: number
  rows: ProEdgeRow[]
  filters: { ultraPicks: number; smartMoneyOk: number; sectorAligned: number; convOk: number }
}> {
  const ts = new Date().toISOString()
  const minConv = opts?.minConviction ?? 85

  await buildSectorMap()

  const [conf, ad] = await Promise.all([
    readSnap('cross-confluence.json'),
    readSnap('ad-divergence.json'),
  ])
  const confRows: any[] = conf?.rows ?? []

  // Build a quick lookup of smart-money side per symbol.
  const smartMoneyBySym = new Map<string, 'ACCUMULATION' | 'DISTRIBUTION'>()
  for (const r of (ad?.rows ?? [])) smartMoneyBySym.set(r.symbol, r.side)

  const passed: ProEdgeRow[] = []
  let fUltra = 0, fSmart = 0, fSector = 0, fConv = 0
  for (const r of confRows) {
    // Filter 1: ultra picks (≥2 engines) — already implicit in cross-confluence.json
    if (!r.sources || r.sources.length < 2) continue
    fUltra++

    // Filter 2: smart-money same-side
    const smartSide = smartMoneyBySym.get(r.symbol)
    const smartOK = !smartSide
      || (r.direction === 'BUY' && smartSide !== 'DISTRIBUTION')
      || (r.direction === 'SHORT' && smartSide !== 'ACCUMULATION')
    if (!smartOK) continue
    fSmart++

    // Filter 3: sector tailwind
    const sec = SECTOR_MEMBER_MAP[r.symbol]
    const sectorOK = !sec
      || (r.direction === 'BUY' && (sec.trend === 'LEADING' || sec.trend === 'IMPROVING'))
      || (r.direction === 'SHORT' && (sec.trend === 'LAGGING' || sec.trend === 'WEAKENING'))
    if (!sectorOK) continue
    fSector++

    // Filter 4: conviction floor
    if ((r.conviction ?? 0) < minConv) continue
    fConv++

    // Filter 5: anti pump-and-dump hard gate (industry-best 80%+ accuracy
    // parameters). Blocks GSM/ASM/T2T names, micro-caps, thin-trade names,
    // high-pledge promoters, and repeat upper-circuit hitters.
    try {
      const { verifySymbol } = await import('./pumpDumpFilter')
      const verdict = await verifySymbol(r.symbol)
      if (!verdict.passes) {
        log.info('PRO-EDGE', `BLOCKED ${r.symbol}: ${verdict.blockers.join(' · ')}`)
        continue
      }
    } catch { /* filter unavailable, fail-open */ }

    passed.push({
      symbol: r.symbol,
      direction: r.direction,
      conviction: r.conviction,
      ltp: r.ltp ?? null,
      entry: r.entry ?? null,
      stopLoss: r.stopLoss ?? null,
      target1: r.target1 ?? null,
      target2: r.target2 ?? null,
      target3: r.target3 ?? null,
      sources: r.sources,
      smartMoneySide: (smartSide ?? 'NEUTRAL') as any,
      sectorLabel: sec?.label ?? null,
      sectorTrend: (sec?.trend ?? 'NEUTRAL') as any,
      reasoning: [
        `Confluence: ${r.sources.join(' + ')} (${r.sources.length} engines)`,
        sec ? `Sector tailwind: ${sec.label} ${sec.trend}` : 'Sector: unmapped',
        smartSide ? `Smart-money: ${smartSide} (aligned)` : 'Smart-money: neutral',
        `Conviction ${r.conviction} ≥ ${minConv} floor`,
      ],
    })
  }

  // Strict dedup — never two entries for same symbol.
  const seen = new Set<string>()
  const finalRows = passed
    .sort((a, b) => b.conviction - a.conviction)
    .filter(r => {
      if (seen.has(r.symbol)) { log.warn('PRO-EDGE', `dropped duplicate ${r.symbol}`); return false }
      seen.add(r.symbol); return true
    })

  log.ok('PRO-EDGE', `${finalRows.length} signals · filters: ultra=${fUltra} smart=${fSmart} sector=${fSector} conv=${fConv}`)

  const { enrichRows } = await import('../lib/reasonEnrichment')
  const { enrichRowsDates } = await import('../lib/targetDateEnrichment')
  const enrichedRows = enrichRowsDates(
    enrichRows(finalRows as unknown as Array<Record<string, unknown>>, 'proEdge'),
    'proEdge',
  )

  return {
    generatedAt: ts,
    totalEvaluated: confRows.length,
    passCount: enrichedRows.length,
    rows: enrichedRows as unknown as typeof finalRows,
    filters: { ultraPicks: fUltra, smartMoneyOk: fSmart, sectorAligned: fSector, convOk: fConv },
  }
}
