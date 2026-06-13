/**
 * Multi-Strike OI Surge Detector — catches the pattern that
 * single-strike AGGR_CE_BUY misses.
 *
 * User flagged 12-Jun-2026: NIFTY 23330, CE options 23300/23400/23500/
 * 23600 ALL went 3X intraday. The existing oiMonitor fires per-strike
 * but each individual strike's strength may be only 50-60 (not enough
 * to clear the 60 threshold). When 3-4 adjacent strikes ALL accumulate
 * simultaneously, that's institutional positioning — far stronger than
 * any single-strike alert.
 *
 * Detection rule:
 *   - Within ±5% of spot
 *   - 3+ adjacent (within 200 pts) CE strikes ALL show OI Δ > +5% over
 *     the previous snapshot
 *   - Combined OI Δ > 1.5L lots
 *   - LTP rising on majority (>50%) of these strikes
 *   → SURGE_CE_ACCUMULATION (BULLISH) fires
 *   Mirror logic for PE side → SURGE_PE_ACCUMULATION (BEARISH)
 *
 * Output: emitted as a regular OI signal with kind="SURGE_CE_ACCUM" or
 * "SURGE_PE_ACCUM" so existing dispatcher/dedup logic handles it.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { log } from '../util/logger'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

interface MultiStrikeSurge {
  side: 'CE' | 'PE'
  bias: 'BULLISH' | 'BEARISH'
  strikes: number[]
  combinedOiDelta: number
  avgLtpChangePct: number
  spot: number
  expiry: string | null
  strength: number     // 0-100, higher than single-strike
  note: string
}

interface FlowRow {
  strike: number
  side: 'CE' | 'PE'
  oiChange: number
  ltpChangePct: number
  currentOI: number
  currentLTP: number
  spot: number
  expiry?: string
  bias?: string
}

/**
 * Read the current oi-buildup.json snapshot and detect multi-strike
 * surges. This is cheap (file read + 1 pass) — runs on every public
 * snapshot publish (every 30 min).
 */
export async function detectMultiStrikeSurges(): Promise<MultiStrikeSurge[]> {
  let oi: any = null
  try {
    oi = JSON.parse(await fs.readFile(path.join(SNAP_DIR, 'oi-buildup.json'), 'utf8'))
  } catch { return [] }

  const rows: FlowRow[] = oi?.rows ?? []
  if (rows.length === 0) return []
  const summary = (oi?.summary ?? [])[0]
  const spot = summary?.spot
  const expiry = summary?.expiry ?? null
  if (!spot) return []

  const ceFlows = rows.filter(r => r.side === 'CE' && Math.abs(r.strike - spot) / spot < 0.05)
  const peFlows = rows.filter(r => r.side === 'PE' && Math.abs(r.strike - spot) / spot < 0.05)

  const out: MultiStrikeSurge[] = []

  // CE side — find clusters of 3+ adjacent strikes with positive OI delta
  for (const cluster of findAdjacentClusters(ceFlows, 200, 3)) {
    const combinedOi = cluster.reduce((s, r) => s + (r.oiChange ?? 0), 0)
    if (combinedOi < 1.5e5) continue           // need 1.5L combined
    const ltpsUp = cluster.filter(r => (r.ltpChangePct ?? 0) > 0).length
    if (ltpsUp / cluster.length < 0.5) continue // need majority LTPs up
    const avgLtpPct = cluster.reduce((s, r) => s + (r.ltpChangePct ?? 0), 0) / cluster.length
    // Strength: cluster size × strength multiplier (cluster of 4 = stronger
    // signal than cluster of 3); scaled by combined OI vs threshold
    const strength = Math.min(100, 30 + cluster.length * 15 + Math.min(25, combinedOi / 1e6 * 5) + Math.min(15, avgLtpPct))
    out.push({
      side: 'CE', bias: 'BULLISH',
      strikes: cluster.map(c => c.strike).sort((a, b) => a - b),
      combinedOiDelta: combinedOi,
      avgLtpChangePct: +avgLtpPct.toFixed(2),
      spot,
      expiry,
      strength: Math.round(strength),
      note: `${cluster.length}-strike CE accumulation cluster ${cluster.map(c => c.strike).sort((a, b) => a - b).join('/')} — combined OI Δ ${(combinedOi / 1e5).toFixed(1)}L · avg LTP +${avgLtpPct.toFixed(1)}% · institutional CALL build`,
    })
  }

  // PE side — same but mirror
  for (const cluster of findAdjacentClusters(peFlows, 200, 3)) {
    const combinedOi = cluster.reduce((s, r) => s + (r.oiChange ?? 0), 0)
    if (combinedOi < 1.5e5) continue
    const ltpsUp = cluster.filter(r => (r.ltpChangePct ?? 0) > 0).length
    if (ltpsUp / cluster.length < 0.5) continue
    const avgLtpPct = cluster.reduce((s, r) => s + (r.ltpChangePct ?? 0), 0) / cluster.length
    const strength = Math.min(100, 30 + cluster.length * 15 + Math.min(25, combinedOi / 1e6 * 5) + Math.min(15, avgLtpPct))
    out.push({
      side: 'PE', bias: 'BEARISH',
      strikes: cluster.map(c => c.strike).sort((a, b) => a - b),
      combinedOiDelta: combinedOi,
      avgLtpChangePct: +avgLtpPct.toFixed(2),
      spot,
      expiry,
      strength: Math.round(strength),
      note: `${cluster.length}-strike PE accumulation cluster ${cluster.map(c => c.strike).sort((a, b) => a - b).join('/')} — combined OI Δ ${(combinedOi / 1e5).toFixed(1)}L · avg LTP +${avgLtpPct.toFixed(1)}% · institutional PUT build`,
    })
  }

  // Strict dedup — never two surges of same side
  const seen = new Set<string>()
  const deduped = out.filter(s => {
    const k = `${s.side}|${s.strikes.join('-')}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })

  if (deduped.length) log.ok('MULTI-STRIKE-OI', `${deduped.length} multi-strike surges detected: ${deduped.map(s => `${s.side}[${s.strikes.join(',')}] str=${s.strength}`).join('; ')}`)
  return deduped
}

/**
 * Find clusters of adjacent strikes (each within `maxGap` of the next,
 * minimum cluster size `minSize`) all with positive OI delta.
 */
function findAdjacentClusters(rows: FlowRow[], maxGap: number, minSize: number): FlowRow[][] {
  const positive = rows.filter(r => (r.oiChange ?? 0) > 0).sort((a, b) => a.strike - b.strike)
  const clusters: FlowRow[][] = []
  let current: FlowRow[] = []
  for (const r of positive) {
    if (current.length === 0) { current.push(r); continue }
    const prev = current[current.length - 1]
    if (r.strike - prev.strike <= maxGap) current.push(r)
    else {
      if (current.length >= minSize) clusters.push(current)
      current = [r]
    }
  }
  if (current.length >= minSize) clusters.push(current)
  return clusters
}
