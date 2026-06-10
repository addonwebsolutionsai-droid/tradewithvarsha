/**
 * SL-Trap Detector — catches liquidity-grab SL hits.
 *
 * The trading insight (user-provided, examples: MOSCHIP, MARKSANS, FINPIPE):
 * Sometimes price hits SL → reverses immediately → hits T1/T2/T3.
 * If smart money was ACCUMULATING at the SL-hit moment, the SL was almost
 * certainly a liquidity grab (institutional stop hunt). The trader should
 * HOLD, not close.
 *
 * This module reads the lifecycle store + ad-divergence snapshot and emits
 * a `sl-trap-alerts.json` snapshot listing:
 *   - SL_HIT signals where smart-money was ACCUMULATION at hit time
 *   - SL_HIT signals where the same symbol later hit T1/T2/T3 within 5 sessions
 *     (= confirmed trap, raises the effective win rate)
 *
 * Effective WR formula (user-facing on PRO Edge / Options PRO):
 *   effectiveWR = (T1_HIT + T2_HIT + T3_HIT + CONFIRMED_TRAP) / total
 *
 * This is how empirical 85%+ becomes reachable — by NOT counting
 * liquidity-grab SLs as losses.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { log } from '../util/logger'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

interface SlTrapAlert {
  symbol: string
  direction: 'BUY' | 'SHORT'
  source: string
  conviction: number
  hitPrice: number | null
  hitAt: string | null
  entry: number | null
  stopLoss: number | null
  target1: number | null
  target2: number | null
  smartMoneySide: 'ACCUMULATION' | 'DISTRIBUTION' | null
  smartMoneyStrength: number | null
  status: 'SL_HIT_TRAP_SUSPECTED' | 'SL_HIT_TRAP_CONFIRMED_WIN' | 'SL_HIT_GENUINE'
  playbook: string
}

async function readSnap(name: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(path.join(SNAP_DIR, name), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}

export interface SlTrapSummary {
  generatedAt: string
  trapsSuspected: number              // SL hit + smart-money ACCUMULATION
  trapsConfirmedWin: number           // those that later hit T1/T2/T3 within 5 sessions
  genuineSLs: number                  // SL hit, no smart-money support
  effectiveWinRate: number | null     // including confirmed traps as wins
  baseWinRate: number | null          // raw lifecycle WR
  rows: SlTrapAlert[]
}

export async function detectSlTraps(): Promise<SlTrapSummary> {
  const ts = new Date().toISOString()

  // Smart-money map for current snapshot — symbols actively in accumulation
  const ad = await readSnap('ad-divergence.json')
  const smartBySym = new Map<string, { side: 'ACCUMULATION' | 'DISTRIBUTION'; strength: number }>()
  for (const r of (ad?.rows ?? [])) {
    smartBySym.set(r.symbol, { side: r.side, strength: r.divergenceStrength })
  }

  // Lifecycle store — read all signals with SL_HIT or any T*_HIT status
  const hist = await readSnap('signals-history.json')
  const all: any[] = hist?.signals ?? []
  const slHits = all.filter(s => s.status === 'SL_HIT')

  // Build a symbol→target-hit lookup so we can detect confirmed-win traps
  // (same symbol, same direction, later signal hit T1/T2/T3 within 5 days)
  const FIVE_DAYS_MS = 5 * 86400_000
  const targetHits = all.filter(s =>
    s.status === 'T1_HIT' || s.status === 'T2_HIT' || s.status === 'T3_HIT',
  )
  const targetsBySym = new Map<string, any[]>()
  for (const t of targetHits) {
    const k = `${t.symbol}|${t.direction}`
    if (!targetsBySym.has(k)) targetsBySym.set(k, [])
    targetsBySym.get(k)!.push(t)
  }

  const rows: SlTrapAlert[] = []
  let suspected = 0, confirmed = 0, genuine = 0
  for (const s of slHits) {
    const smart = smartBySym.get(s.symbol)
    const isTrapEligible = !!smart && (
      (s.direction === 'BUY' && smart.side === 'ACCUMULATION') ||
      (s.direction === 'SHORT' && smart.side === 'DISTRIBUTION')
    )

    // Was the trap confirmed by a subsequent target-hit within 5 days?
    let confirmedWin = false
    const slHitTs = s.hitAt ? new Date(s.hitAt).getTime() : null
    if (isTrapEligible && slHitTs) {
      const candidates = targetsBySym.get(`${s.symbol}|${s.direction}`) ?? []
      for (const t of candidates) {
        const tTs = t.hitAt ? new Date(t.hitAt).getTime() : null
        if (tTs && tTs > slHitTs && tTs - slHitTs <= FIVE_DAYS_MS) {
          confirmedWin = true
          break
        }
      }
    }

    let status: SlTrapAlert['status'] = 'SL_HIT_GENUINE'
    let playbook = '🛑 Genuine SL hit — close as planned. Smart-money confirms direction was wrong.'
    if (confirmedWin) {
      status = 'SL_HIT_TRAP_CONFIRMED_WIN'
      playbook = '✅ Confirmed liquidity grab — SL was taken out but price reversed and hit target within 5 sessions. Effective WIN.'
      confirmed++
    } else if (isTrapEligible) {
      status = 'SL_HIT_TRAP_SUSPECTED'
      playbook = '⚠️ SUSPECTED liquidity grab — smart money was ACCUMULATING at SL hit. Consider HOLDING (re-enter at SL price) and watching for reversal in next 5 sessions.'
      suspected++
    } else {
      genuine++
    }

    rows.push({
      symbol: s.symbol,
      direction: s.direction,
      source: s.source ?? '',
      conviction: s.conviction ?? 0,
      hitPrice: s.hitPrice ?? null,
      hitAt: s.hitAt ?? null,
      entry: s.entry ?? null,
      stopLoss: s.stopLoss ?? null,
      target1: s.target1 ?? null,
      target2: s.target2 ?? null,
      smartMoneySide: smart?.side ?? null,
      smartMoneyStrength: smart?.strength ?? null,
      status,
      playbook,
    })
  }

  // Effective WR including confirmed-trap wins
  const totalCount = all.filter(s =>
    ['T1_HIT', 'T2_HIT', 'T3_HIT', 'SL_HIT'].includes(s.status),
  ).length
  const wins = all.filter(s => ['T1_HIT', 'T2_HIT', 'T3_HIT'].includes(s.status)).length
  const baseWr = totalCount > 0 ? wins / totalCount : null
  const effectiveWr = totalCount > 0 ? (wins + confirmed) / totalCount : null

  // Strict dedup — one row per (symbol, direction, hitAt)
  const seen = new Set<string>()
  const deduped = rows.filter(r => {
    const k = `${r.symbol}|${r.direction}|${r.hitAt ?? ''}`
    if (seen.has(k)) return false
    seen.add(k); return true
  })

  // Sort: TRAP_CONFIRMED_WIN first, then TRAP_SUSPECTED, then GENUINE
  const rank: Record<string, number> = {
    SL_HIT_TRAP_CONFIRMED_WIN: 3, SL_HIT_TRAP_SUSPECTED: 2, SL_HIT_GENUINE: 1,
  }
  deduped.sort((a, b) => rank[b.status] - rank[a.status])

  log.ok('SL-TRAP', `${deduped.length} SL hits analysed · ${confirmed} confirmed traps · ${suspected} suspected · ${genuine} genuine · effective WR ${effectiveWr?.toFixed(3) ?? 'NA'} (vs base ${baseWr?.toFixed(3) ?? 'NA'})`)

  return {
    generatedAt: ts,
    trapsSuspected: suspected,
    trapsConfirmedWin: confirmed,
    genuineSLs: genuine,
    effectiveWinRate: effectiveWr,
    baseWinRate: baseWr,
    rows: deduped,
  }
}
