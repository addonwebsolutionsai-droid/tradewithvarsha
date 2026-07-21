/**
 * Snapshot enricher — adds shareholding fields (FII / DII / Promoter /
 * Pledge / Market cap) plus 5d-vs-20d volume ratio to every row that
 * has a `symbol`.
 *
 * Why this file exists: enrichRowsWithMoneyFlow() in server/src/index.ts
 * only fires on the /api/weekly-pick and /api/daily-pick endpoints. The
 * public snapshots consumed by the /early-momentum, /elite-picks,
 * /pre-move, and /desk pages were being written WITHOUT this data, so
 * users saw a bare row missing the FII/DII footprint that matters most.
 *
 * Now every snapshot writer can call `enrichSnapshotRows(rows)` and
 * every downstream consumer (localhost SPA, Vercel raw feed, addon
 * projects) gets the same enrichment.
 *
 * Design:
 *   - idempotent: rows with `shareholdingNote` already set are skipped.
 *   - concurrent: uses Promise.all with a soft concurrency bound.
 *   - cache-friendly: getShareholding() has its own disk-backed cache.
 *   - non-fatal: shareholding lookup failures never crash the writer.
 */

import { getShareholding } from '../data/shareholding'
import { log } from './logger'

export interface ShareholdingEnriched {
  symbol?: string
  shareholdingNote?: string
  fiiDelta?: number
  diiDelta?: number
  promoterDelta?: number
  smartMoneyUp?: boolean
  vol5dRatio?: number
  noBrainerBet?: boolean
  [k: string]: unknown
}

/**
 * Enrich an array of rows in place. Each row that has a `.symbol` field
 * will (if data is available) receive:
 *   shareholdingNote  — human-readable "FII x% · DII y% · P z% · Pledge · MC"
 *   fiiDelta          — QoQ FII change (percentage points)
 *   diiDelta          — QoQ DII change
 *   promoterDelta     — QoQ promoter change
 *   smartMoneyUp      — true if FII delta > 0.3pp AND promoter stable/up
 *   noBrainerBet      — true if smartMoneyUp AND FII pct ≥ 10 AND pledge < 5
 *   vol5dRatio        — 5d avg vol / 20d avg vol (needs candles module)
 *
 * Rows without a symbol are skipped. Rows that already have
 * shareholdingNote are skipped (idempotent — safe to call twice).
 * Volume enrichment is optional and disabled by default (opts.withVolume).
 */
export async function enrichSnapshotRows<T extends ShareholdingEnriched>(
  rows: T[] | undefined,
  opts?: { withVolume?: boolean; label?: string },
): Promise<{ enriched: number; skipped: number; failed: number }> {
  if (!Array.isArray(rows) || rows.length === 0) return { enriched: 0, skipped: 0, failed: 0 }
  const label = opts?.label ?? 'enrich'
  let enriched = 0, skipped = 0, failed = 0

  // Cap concurrency so we don't blast the shareholding cache/store on 5k rows.
  const CONCURRENCY = 20
  let i = 0
  const runners = Array.from({ length: CONCURRENCY }, async () => {
    while (i < rows.length) {
      const r = rows[i++]
      if (!r || !r.symbol) { skipped++; continue }
      if (r.shareholdingNote) { skipped++; continue }
      try {
        const shp = await getShareholding(String(r.symbol))
        if (!shp) { failed++; continue }
        const fA = shp.fiiDeltaQoQ > 0.1 ? '↑' : shp.fiiDeltaQoQ < -0.1 ? '↓' : '→'
        const pA = shp.promoterDeltaQoQ > 0.1 ? '↑' : shp.promoterDeltaQoQ < -0.1 ? '↓' : '→'
        const dA = shp.diiDeltaQoQ > 0.1 ? '↑' : shp.diiDeltaQoQ < -0.1 ? '↓' : '→'
        const mc = shp.marketCapCr >= 1000
          ? `${(shp.marketCapCr / 1000).toFixed(1)}KCr`
          : shp.marketCapCr > 0 ? `${shp.marketCapCr.toFixed(0)}Cr` : '?'
        r.shareholdingNote = `FII ${shp.fiiPct.toFixed(1)}%${fA} · DII ${shp.diiPct.toFixed(1)}%${dA} · P ${shp.promoterPct.toFixed(1)}%${pA} · Pledge ${shp.promoterPledgePct.toFixed(1)}% · MC ₹${mc}`
        r.fiiDelta = +shp.fiiDeltaQoQ.toFixed(2)
        r.diiDelta = +shp.diiDeltaQoQ.toFixed(2)
        r.promoterDelta = +shp.promoterDeltaQoQ.toFixed(2)
        r.smartMoneyUp = r.fiiDelta > 0.3 && r.promoterDelta >= -0.2
        // NO-BRAINER anchor per memory: FII↑ + promoter stable + pledge<5%
        r.noBrainerBet = r.smartMoneyUp && shp.fiiPct >= 10 && shp.promoterPledgePct < 5
        if (opts?.withVolume && r.vol5dRatio == null) {
          try {
            const { getCandles } = await import('../data')
            const candles = await getCandles(String(r.symbol), '1D', 25)
            if (candles.length >= 20) {
              const v20 = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20
              const v5 = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5
              r.vol5dRatio = v20 > 0 ? +(v5 / v20).toFixed(2) : 1
            }
          } catch { /* skip vol on failure */ }
        }
        enriched++
      } catch {
        failed++
      }
    }
  })
  await Promise.all(runners)
  log.info(label, `enriched ${enriched} · skipped ${skipped} · failed ${failed} (of ${rows.length})`)
  return { enriched, skipped, failed }
}

/**
 * Convenience wrapper — enrich a snapshot file on disk in place.
 * Reads JSON → enriches its `rows` array → writes back.
 */
export async function enrichSnapshotFile(filePath: string, opts?: { withVolume?: boolean }): Promise<void> {
  const fs = await import('fs')
  const path = await import('path')
  if (!fs.existsSync(filePath)) return
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw)
    // Support both `rows` and `signals` array shapes
    const rows = Array.isArray(data.rows) ? data.rows : Array.isArray(data.signals) ? data.signals : null
    if (!rows) return
    await enrichSnapshotRows(rows, { withVolume: opts?.withVolume, label: `ENRICH-${path.basename(filePath)}` })
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  } catch (e) {
    log.warn('ENRICH-FILE', `${filePath}: ${(e as Error).message}`)
  }
}
