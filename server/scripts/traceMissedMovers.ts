/**
 * One-shot diagnostic: for each user-flagged mover (20–30 Apr 2026), trace
 * exactly where the weekly-pick pipeline drops it. Call signs:
 *
 *   1. Symbol not in NSE_ALL ScripMaster → unreachable from Angel
 *   2. Daily candles fewer than 60 (newly listed / data gap)
 *   3. Liquidity gate (volume < 1,000)
 *   4. Did not make top-250 prerank shortlist
 *   5. Score below conviction floor (45 micro / 60 large)
 *   6. Score below 80 (the user's "highest conviction" bar)
 *
 * Usage:
 *   npx tsx server/scripts/traceMissedMovers.ts
 */

import * as data from '../src/data'
import { resolveUniverse } from '../src/screeners/universe'

const TARGETS = [
  'ADISOFT', 'CEMINDIA', 'MACH', 'MARUTIGLB', 'CALSOFT', 'RESOURCE',
  'YUNIK', 'KKSHOSP', 'MTAR', 'MUKTA', 'PENTOKEY', 'RPGLIFE',
  'BCPL', 'BCPLRAIL', 'RONI', 'MAURIA', 'IITL', 'BCCFUBA',
  'MEESHO', 'SAAKSHI', 'ONECLICK', 'PROSPECT', 'DELTAIND',
  'VANI', 'HATHWAY', 'INDIABULLS',
] as const

interface Trace {
  symbol: string
  inUniverse: boolean
  daysOfData: number | null
  lastVolume: number | null
  mom5: number | null
  volBurst: number | null
  rank: number | null
  rankPos: number | null
  failReason: string
}

async function main(): Promise<void> {
  console.log(`\n=== Weekly-pick trace for ${TARGETS.length} user-flagged movers (20–30 Apr 2026) ===\n`)

  const universe = await resolveUniverse('NSE_ALL')
  console.log(`NSE_ALL universe size: ${universe.length}\n`)

  // First: find any name-collisions (Angel may use a different ticker)
  for (const t of TARGETS) {
    const exact = universe.includes(t)
    if (!exact) {
      const partial = universe.filter(u => u.includes(t.slice(0, 5)) || t.includes(u.slice(0, 5))).slice(0, 5)
      console.log(`✗ ${t.padEnd(12)} not exact in universe — closest matches: ${partial.join(', ') || '(none)'}`)
    }
  }
  console.log('')

  const traces: Trace[] = []
  // Compute prerank rank for ALL universe symbols for context.
  type P = { sym: string; mom5: number; volBurst: number; rank: number }
  console.log(`Computing pre-rank for full universe (this may take 60-90s)...`)
  const preranks: P[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      try {
        const c = await data.getCandles(sym, '1D', 80)
        if (c.length < 60) continue
        const last = c[c.length - 1]
        if (last.volume < 1_000) continue
        const ref5 = c[c.length - 6]?.close ?? last.close
        const mom5 = ((last.close - ref5) / ref5) * 100
        const v60 = c.slice(-61, -1).reduce((s, x) => s + x.volume, 0) / 60
        const volBurst = v60 > 0 ? last.volume / v60 : 0
        preranks.push({ sym, mom5, volBurst, rank: Math.abs(mom5) * 0.6 + volBurst * 4 })
      } catch { /* skip */ }
    }
  }))
  preranks.sort((a, b) => b.rank - a.rank)
  console.log(`Pre-rank computed: ${preranks.length} ranked symbols (${universe.length - preranks.length} skipped on liquidity / no-data)\n`)

  for (const t of TARGETS) {
    const inUni = universe.includes(t)
    const trace: Trace = {
      symbol: t, inUniverse: inUni, daysOfData: null, lastVolume: null,
      mom5: null, volBurst: null, rank: null, rankPos: null, failReason: '',
    }
    if (!inUni) {
      trace.failReason = 'not in NSE_ALL ScripMaster (likely BSE-only / SME / wrong ticker)'
    } else {
      const idx = preranks.findIndex(p => p.sym === t)
      if (idx === -1) {
        try {
          const c = await data.getCandles(t, '1D', 80)
          trace.daysOfData = c.length
          if (c.length < 60) trace.failReason = `only ${c.length} days of candles (<60 floor)`
          else if (c[c.length - 1].volume < 1_000) {
            trace.lastVolume = c[c.length - 1].volume
            trace.failReason = `last volume ${c[c.length - 1].volume} < 1,000 liquidity gate`
          } else {
            trace.failReason = 'data fetch failed at prerank time'
          }
        } catch (e) {
          trace.failReason = `candle fetch error: ${(e as Error).message}`
        }
      } else {
        trace.rankPos = idx + 1
        trace.mom5 = preranks[idx].mom5
        trace.volBurst = preranks[idx].volBurst
        trace.rank = preranks[idx].rank
        if (idx >= 250) trace.failReason = `prerank position ${idx + 1} > 250 (shortlist cap)`
        else trace.failReason = '— made shortlist; check 5-lens conviction'
      }
    }
    traces.push(trace)
  }

  console.log('--- TRACE TABLE ---')
  console.log('Symbol       | InUni | Rank | Pos    | Mom5%  | VolBurst | Reason')
  console.log('-'.repeat(120))
  for (const t of traces) {
    console.log(
      `${t.symbol.padEnd(12)} | ${t.inUniverse ? '✓' : '✗'.padEnd(2)}    | ${(t.rank?.toFixed(1) ?? '—').padStart(5)}| ${(t.rankPos?.toString() ?? '—').padStart(6)} | ${(t.mom5?.toFixed(2) ?? '—').padStart(6)} | ${(t.volBurst?.toFixed(2) ?? '—').padStart(8)} | ${t.failReason}`
    )
  }
  console.log('')

  // Summary buckets
  const notInUni = traces.filter(t => !t.inUniverse)
  const noData = traces.filter(t => t.inUniverse && t.daysOfData != null && t.daysOfData < 60)
  const lowLiq = traces.filter(t => t.inUniverse && t.lastVolume != null && t.lastVolume < 1000)
  const outranked = traces.filter(t => t.rankPos != null && t.rankPos > 250)
  const shortlisted = traces.filter(t => t.rankPos != null && t.rankPos <= 250)

  console.log('--- SUMMARY ---')
  console.log(`✗ Not in NSE_ALL universe: ${notInUni.length} → ${notInUni.map(t => t.symbol).join(', ')}`)
  console.log(`✗ <60 days of candles:     ${noData.length} → ${noData.map(t => t.symbol).join(', ')}`)
  console.log(`✗ Below 1k liquidity:      ${lowLiq.length} → ${lowLiq.map(t => t.symbol).join(', ')}`)
  console.log(`✗ Outranked (pos>250):     ${outranked.length} → ${outranked.map(t => `${t.symbol}(#${t.rankPos})`).join(', ')}`)
  console.log(`✓ Made shortlist:          ${shortlisted.length} → ${shortlisted.map(t => `${t.symbol}(#${t.rankPos}, +${t.mom5?.toFixed(1)}%)`).join(', ')}`)
  console.log('')
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
