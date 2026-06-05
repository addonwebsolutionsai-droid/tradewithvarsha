/**
 * Cross-Engine Confluence Aggregator — when the SAME symbol is flagged
 * by ≥2 independent engines (Weekly Pick · Pre-Move · F&O Futures ·
 * OI Build-up · Daily Pick · Old-Weekly), we mark it ⚡ULTRA confluence.
 * These are the highest-conviction setups in the system.
 *
 * Pure aggregation — reads existing snapshots, no new API calls.
 * Always dedups by symbol with direction conflict-check (a stock cannot
 * be BUY in one engine and SHORT in another in the same aggregated row).
 *
 * Output schema: { symbol, direction, sources[], conviction, ltp,
 *   entry, sl, t1/t2/t3, ultraScore, reasoning }
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { log } from '../util/logger'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

interface AggRow {
  symbol: string
  direction: 'BUY' | 'SHORT'
  sources: string[]                  // ['WEEKLY', 'FNO_FUTURES', ...]
  conviction: number                 // max conviction across all sources
  ltp: number | null
  entry: number | null
  stopLoss: number | null
  target1: number | null
  target2: number | null
  target3: number | null
  ultraScore: number                 // 0-100
  reasoning: string[]
  byEngine: Record<string, { conv: number; entry: number | null; t2: number | null }>
}

async function readSnap(name: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(path.join(SNAP_DIR, name), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

function addContribution(map: Map<string, AggRow>, sym: string, dir: 'BUY' | 'SHORT', source: string, row: {
  conviction?: number; ltp?: number; entry?: number; stopLoss?: number;
  target1?: number; target2?: number; target3?: number; reason?: string;
}): void {
  const existing = map.get(sym)
  if (existing && existing.direction !== dir) {
    // Direction conflict — keep the higher-conviction source, log the clash.
    if ((row.conviction ?? 0) <= existing.conviction) return
    // New source has higher conviction → flip direction and reset.
    log.info('CROSS-CONF', `${sym}: direction flip ${existing.direction}→${dir} (new src ${source} conv ${row.conviction})`)
    existing.direction = dir
    existing.sources = [source]
    existing.byEngine = { [source]: { conv: row.conviction ?? 0, entry: row.entry ?? null, t2: row.target2 ?? null } }
    existing.conviction = row.conviction ?? 0
    existing.reasoning = row.reason ? [row.reason] : []
    return
  }
  if (!existing) {
    map.set(sym, {
      symbol: sym, direction: dir, sources: [source],
      conviction: row.conviction ?? 0,
      ltp: row.ltp ?? null, entry: row.entry ?? null, stopLoss: row.stopLoss ?? null,
      target1: row.target1 ?? null, target2: row.target2 ?? null, target3: row.target3 ?? null,
      ultraScore: 0,
      reasoning: row.reason ? [`[${source}] ${row.reason}`] : [`[${source}]`],
      byEngine: { [source]: { conv: row.conviction ?? 0, entry: row.entry ?? null, t2: row.target2 ?? null } },
    })
    return
  }
  // Same direction — merge
  if (!existing.sources.includes(source)) existing.sources.push(source)
  existing.byEngine[source] = { conv: row.conviction ?? 0, entry: row.entry ?? null, t2: row.target2 ?? null }
  if ((row.conviction ?? 0) > existing.conviction) existing.conviction = row.conviction ?? 0
  if (existing.ltp == null && row.ltp != null) existing.ltp = row.ltp
  if (existing.entry == null && row.entry != null) existing.entry = row.entry
  if (existing.stopLoss == null && row.stopLoss != null) existing.stopLoss = row.stopLoss
  if (existing.target1 == null && row.target1 != null) existing.target1 = row.target1
  if (existing.target2 == null && row.target2 != null) existing.target2 = row.target2
  if (existing.target3 == null && row.target3 != null) existing.target3 = row.target3
  if (row.reason) existing.reasoning.push(`[${source}] ${row.reason}`)
}

export interface UltraConfluence {
  generatedAt: string
  totalEvaluated: number
  ultraCount: number              // appearing in ≥3 engines
  strongCount: number             // appearing in 2 engines
  rows: AggRow[]
}

export async function aggregateConfluence(): Promise<UltraConfluence> {
  const ts = new Date().toISOString()
  const [wk, pm, fno, daily, oldWk] = await Promise.all([
    readSnap('weekly-pick.json'),
    readSnap('pre-move.json'),
    readSnap('fno-futures.json'),
    readSnap('daily-pick.json'),
    readSnap('old-weekly-pick.json'),
  ])

  const map = new Map<string, AggRow>()

  for (const r of (wk?.rows ?? [])) {
    if (!r.symbol) continue
    const dir = r.direction === 'BUY' ? 'BUY' : 'SHORT'
    addContribution(map, r.symbol, dir as any, 'WEEKLY', {
      conviction: r.conviction, ltp: r.ltp, entry: r.entryPrice ?? r.entryPriceLow,
      stopLoss: r.stopLoss, target1: r.target1, target2: r.target2, target3: r.target3,
      reason: (r.flowNote || r.shareholdingNote || '').toString().slice(0, 100),
    })
  }
  for (const r of (pm?.rows ?? [])) {
    if (!r.symbol) continue
    const dir = (r.direction === 'BULL' || r.direction === 'BUY') ? 'BUY' : 'SHORT'
    addContribution(map, r.symbol, dir as any, 'PRE_MOVE', {
      conviction: (r.score ?? 0) * 10, ltp: r.price,
      entry: r.suggestedEntry, stopLoss: r.suggestedSL,
      target1: r.suggestedTarget, target2: r.suggestedTarget,
      reason: (r.tags ?? []).slice(0, 2).join(' · '),
    })
  }
  for (const r of (fno?.rows ?? [])) {
    if (!r.symbol) continue
    const dir = r.side === 'LONG' ? 'BUY' : 'SHORT'
    addContribution(map, r.symbol, dir as any, 'FNO_FUTURES', {
      conviction: r.score, ltp: r.price, entry: r.entry,
      stopLoss: r.stopLoss, target1: r.target1, target2: r.target2, target3: r.target3,
      reason: `score ${r.score} · ${r.confidence}`,
    })
  }
  for (const r of (daily?.rows ?? [])) {
    if (!r.symbol) continue
    const dir = r.direction === 'BUY' ? 'BUY' : 'SHORT'
    addContribution(map, r.symbol, dir as any, 'DAILY', {
      conviction: r.conviction, ltp: r.ltp,
      entry: r.entryPrice ?? r.entryPriceLow,
      stopLoss: r.stopLoss, target1: r.target1, target2: r.target2, target3: r.target3,
      reason: (r.reason ?? r.flowNote ?? '').toString().slice(0, 80),
    })
  }
  for (const r of (oldWk?.rows ?? [])) {
    if (!r.symbol) continue
    const dir = r.direction === 'BUY' ? 'BUY' : 'SHORT'
    addContribution(map, r.symbol, dir as any, 'OLD_WEEKLY', {
      conviction: r.conviction, ltp: r.ltp,
      entry: r.entryPrice ?? r.entryPriceLow,
      stopLoss: r.stopLoss, target1: r.target1, target2: r.target2, target3: r.target3,
    })
  }

  // Compute ultraScore = number of engines × 20 + max conviction × 0.4 (so max ≈ 100+).
  for (const row of map.values()) {
    row.ultraScore = Math.min(100, row.sources.length * 20 + row.conviction * 0.4)
  }

  // Keep only ≥2-engine rows (confluence is the whole point).
  const rows = Array.from(map.values())
    .filter(r => r.sources.length >= 2)
    .sort((a, b) => {
      if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length
      return b.ultraScore - a.ultraScore
    })

  // Final dedup assertion — never let two entries with the same symbol slip through.
  const seen = new Set<string>()
  const finalRows: AggRow[] = []
  for (const r of rows) {
    if (seen.has(r.symbol)) { log.warn('CROSS-CONF', `dropped duplicate ${r.symbol}`); continue }
    seen.add(r.symbol)
    finalRows.push(r)
  }

  const ultraCount = finalRows.filter(r => r.sources.length >= 3).length
  const strongCount = finalRows.filter(r => r.sources.length === 2).length
  log.ok('CROSS-CONF', `${finalRows.length} confluence picks · ${ultraCount} ULTRA (≥3 engines) · ${strongCount} STRONG (2 engines)`)

  return {
    generatedAt: ts,
    totalEvaluated: map.size,
    ultraCount, strongCount,
    rows: finalRows,
  }
}
