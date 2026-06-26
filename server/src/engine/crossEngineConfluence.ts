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
  reasoning: string[]                // 2026-06-26: now contains REAL trading
                                     // signals (RSI / vol / delivery / FII↑
                                     // etc.) not Engine α/β/γ labels
  shareholdingNote?: string          // explicit FII/DII/Promoter/MC line
  noBrainerBet?: boolean
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
  target1?: number; target2?: number; target3?: number;
  reasons?: string[];                 // 2026-06-26: array of REAL trading signals
  shareholdingNote?: string;
  noBrainerBet?: boolean;
}): void {
  const existing = map.get(sym)
  if (existing && existing.direction !== dir) {
    if ((row.conviction ?? 0) <= existing.conviction) return
    log.info('CROSS-CONF', `${sym}: direction flip ${existing.direction}→${dir} (new src ${source} conv ${row.conviction})`)
    existing.direction = dir
    existing.sources = [source]
    existing.byEngine = { [source]: { conv: row.conviction ?? 0, entry: row.entry ?? null, t2: row.target2 ?? null } }
    existing.conviction = row.conviction ?? 0
    existing.reasoning = (row.reasons ?? []).filter(Boolean)
    existing.shareholdingNote = row.shareholdingNote
    existing.noBrainerBet = row.noBrainerBet
    return
  }
  if (!existing) {
    map.set(sym, {
      symbol: sym, direction: dir, sources: [source],
      conviction: row.conviction ?? 0,
      ltp: row.ltp ?? null, entry: row.entry ?? null, stopLoss: row.stopLoss ?? null,
      target1: row.target1 ?? null, target2: row.target2 ?? null, target3: row.target3 ?? null,
      ultraScore: 0,
      reasoning: (row.reasons ?? []).filter(Boolean),
      shareholdingNote: row.shareholdingNote,
      noBrainerBet: row.noBrainerBet,
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
  if (row.shareholdingNote && !existing.shareholdingNote) existing.shareholdingNote = row.shareholdingNote
  if (row.noBrainerBet) existing.noBrainerBet = true
  // Merge reasons — dedup by lowercase prefix so we don't show
  // duplicate "EMA stack ✓" from multiple engines
  for (const r of (row.reasons ?? [])) {
    if (!r) continue
    const key = r.toLowerCase().slice(0, 22)
    if (!existing.reasoning.some(x => x.toLowerCase().slice(0, 22) === key)) {
      existing.reasoning.push(r)
    }
  }
}

// ── REASON EXTRACTORS — pull actual trading signals from each engine's
// snapshot data so the UI shows human-readable logic instead of opaque
// "Engine α + γ + ε" labels.
function extractWeeklyReasons(r: any): string[] {
  const out: string[] = []
  if (r.trendNote) out.push(r.trendNote)                                  // "EMA 9>21>50>200 stacked · ADX 62 strong"
  if (r.smcNote) out.push(r.smcNote)                                       // "BOS↑ · BULLISH OB @ 355-364"
  if (r.flowNote) out.push(r.flowNote)                                     // "vol 0.7× · RSI 74 · 5d +6.8%"
  if (r.gannNote) out.push(r.gannNote)                                     // "POC 389 (31% vol)"
  if (r.astroNote) out.push(r.astroNote)                                   // "RS-z 30.21 · 20d 17.2%"
  if (r.noBrainerBet) out.push('⭐ NO-BRAINER (FII↑ + promoter stable + pledge<5%)')
  return out
}
function extractPreMoveReasons(r: any): string[] {
  const out: string[] = []
  const tags = r.tags ?? r.screenerTags ?? []
  for (const t of tags) out.push(typeof t === 'string' ? t : (t.name ?? ''))
  if (r.reason) out.push(r.reason)
  if (r.flowNote) out.push(r.flowNote)
  return out.filter(Boolean)
}
function extractFnoReasons(r: any): string[] {
  const out: string[] = []
  // confluences from the original 6-lens stack
  for (const c of (r.confluences ?? [])) {
    if (c.pass && c.name && c.detail) out.push(`${c.name}: ${c.detail}`)
  }
  // 12-criteria passes (newer + richer)
  for (const c of (r.twelveCriteria?.results ?? [])) {
    if (c.pass && c.label && c.detail) out.push(`${c.label}: ${c.detail}`)
  }
  // fallback to reasons[] array
  if ((out.length === 0) && Array.isArray(r.reasons)) out.push(...r.reasons.slice(0, 4))
  return out
}
function extractDailyReasons(r: any): string[] {
  const out: string[] = []
  if (r.flowNote) out.push(r.flowNote)
  if (r.reason) out.push(r.reason)
  if (r.pattern) out.push(`pattern: ${r.pattern}`)
  return out
}
function extractOldWeeklyReasons(r: any): string[] {
  // Same shape as weekly
  return extractWeeklyReasons(r)
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
      reasons: extractWeeklyReasons(r),
      shareholdingNote: r.shareholdingNote,
      noBrainerBet: r.noBrainerBet,
    })
  }
  for (const r of (pm?.rows ?? [])) {
    if (!r.symbol) continue
    const dir = (r.direction === 'BULL' || r.direction === 'BUY') ? 'BUY' : 'SHORT'
    addContribution(map, r.symbol, dir as any, 'PRE_MOVE', {
      conviction: (r.score ?? 0) * 10, ltp: r.price,
      entry: r.suggestedEntry, stopLoss: r.suggestedSL,
      target1: r.suggestedTarget, target2: r.suggestedTarget,
      reasons: extractPreMoveReasons(r),
    })
  }
  for (const r of (fno?.rows ?? [])) {
    if (!r.symbol) continue
    const dir = r.side === 'LONG' ? 'BUY' : 'SHORT'
    addContribution(map, r.symbol, dir as any, 'FNO_FUTURES', {
      conviction: r.score, ltp: r.price, entry: r.entry,
      stopLoss: r.stopLoss, target1: r.target1, target2: r.target2, target3: r.target3,
      reasons: extractFnoReasons(r),
      shareholdingNote: r.fiiDelta != null && r.fiiDelta > 0
        ? `FII +${r.fiiDelta.toFixed(2)}pp QoQ${r.marketCapCr ? ` · MC ₹${(r.marketCapCr / 1000).toFixed(1)}KCr` : ''}`
        : undefined,
    })
  }
  for (const r of (daily?.rows ?? [])) {
    if (!r.symbol) continue
    const dir = r.direction === 'BUY' ? 'BUY' : 'SHORT'
    addContribution(map, r.symbol, dir as any, 'DAILY', {
      conviction: r.conviction, ltp: r.ltp,
      entry: r.entryPrice ?? r.entryPriceLow,
      stopLoss: r.stopLoss, target1: r.target1, target2: r.target2, target3: r.target3,
      reasons: extractDailyReasons(r),
      shareholdingNote: r.shareholdingNote,
    })
  }
  for (const r of (oldWk?.rows ?? [])) {
    if (!r.symbol) continue
    const dir = r.direction === 'BUY' ? 'BUY' : 'SHORT'
    addContribution(map, r.symbol, dir as any, 'OLD_WEEKLY', {
      conviction: r.conviction, ltp: r.ltp,
      entry: r.entryPrice ?? r.entryPriceLow,
      stopLoss: r.stopLoss, target1: r.target1, target2: r.target2, target3: r.target3,
      reasons: extractOldWeeklyReasons(r),
      shareholdingNote: r.shareholdingNote,
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

  // 2026-06-26: per user audit, the Reason column was showing opaque
  // labels like "Engine α + γ + ε" instead of actual trading logic.
  // The reasoning array now carries REAL signals (extracted in
  // addContribution from each engine's actual snapshot fields). The
  // `sources` array remains for analytics; the UI renders it as a
  // confluence COUNT, not as engine names.

  // Enrich any rows missing shareholdingNote (best-effort, batches of 4)
  await enrichShareholdingForRows(finalRows)

  // Cap reasoning to top 6 most-distinctive signals to avoid clutter
  for (const r of finalRows) {
    r.reasoning = (r.reasoning ?? []).slice(0, 6)
  }

  return {
    generatedAt: ts,
    totalEvaluated: map.size,
    ultraCount, strongCount,
    rows: finalRows,
  }
}

/**
 * Best-effort shareholding enrichment for rows whose source engine didn't
 * already include the stake summary (e.g. F&O rows without screener.in
 * data). Concurrency 4 to avoid hammering screener.in.
 */
async function enrichShareholdingForRows(rows: AggRow[]): Promise<void> {
  const need = rows.filter(r => !r.shareholdingNote)
  if (need.length === 0) return
  try {
    const { scoreShareholding } = await import('../data/shareholding')
    let cursor = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < need.length) {
        const r = need[cursor++]
        try {
          const v = await scoreShareholding(r.symbol)
          if (v.shp) {
            const shp = v.shp
            const fmtDelta = (d: number): string => {
              if (d > 0.1) return ` (${d.toFixed(1)}%↑)`
              if (d < -0.1) return ` (${Math.abs(d).toFixed(1)}%↓)`
              return ''
            }
            const mc = shp.marketCapCr >= 1000
              ? `${(shp.marketCapCr / 1000).toFixed(1)}KCr`
              : shp.marketCapCr > 0 ? `${shp.marketCapCr.toFixed(0)}Cr` : '?'
            r.shareholdingNote = `FII ${shp.fiiPct.toFixed(1)}%${fmtDelta(shp.fiiDeltaQoQ)} · DII ${shp.diiPct.toFixed(1)}%${fmtDelta(shp.diiDeltaQoQ)} · P ${shp.promoterPct.toFixed(1)}%${fmtDelta(shp.promoterDeltaQoQ)} · Pledge ${(shp.promoterPledgePct ?? 0).toFixed(1)}% · MC ₹${mc}`
            if (v.isNoBrainer) r.noBrainerBet = true
          }
        } catch { /* skip per-symbol */ }
      }
    }))
  } catch { /* shareholding module unavailable */ }
}
