/**
 * Commodity signal scanner — MCX Gold, Silver, Crude, NatGas, Copper.
 *
 * Reuses the same 7-lens confluence math as the VP+FIB engine (via the
 * server-side onDemandScan module which already handles GOLD/CRUDE/etc.
 * through Yahoo commodity futures tickers — GC=F for Gold, CL=F for
 * Crude, SI=F for Silver, HG=F for Copper, NG=F for NatGas).
 *
 * Output: server/data/public-snapshots/commodity-signals.json — feeds
 * the paper trading book's MCX bucket. Only ELITE + STRONG tier signals
 * emit; the confluence gates (2+ lenses hit + score ≥ 60) already keep
 * the bar high.
 *
 * NOTE: we scan the international futures prices (GC=F etc.) because
 * Yahoo doesn't publish live MCX intraday data cleanly. Gold moves in
 * near-lockstep with international futures, so signals from the intl
 * feed translate 1:1 to the MCX bucket for paper-trading purposes.
 */

import fs from 'fs'
import path from 'path'
import { runOnDemandScan } from './onDemandScan'
import { log } from '../util/logger'

const OUT_PATH = path.resolve(__dirname, '../../data/public-snapshots/commodity-signals.json')

// MCX contract sizing — used to convert per-unit P&L into ₹ per lot for
// the paper trading book. Rough MCX lot sizes / value multipliers.
export const MCX_CONTRACTS: Record<string, {
  underlying: string
  onDemandKey: string   // key to pass to runOnDemandScan
  displayName: string
  lotSize: number       // MCX lot size in base units
  quoteCcy: 'USD' | 'INR'
  usdToInr: number      // approx conversion (bootstrapped; updates on next tick from data)
}> = {
  GOLD:   { underlying: 'GOLD',   onDemandKey: 'GOLD',   displayName: 'GOLD-MCX',   lotSize: 100,   quoteCcy: 'USD', usdToInr: 84 },  // 100 gm
  SILVER: { underlying: 'SILVER', onDemandKey: 'SILVER', displayName: 'SILVER-MCX', lotSize: 30_000, quoteCcy: 'USD', usdToInr: 84 }, // 30 kg = 30_000 gm (approx)
  CRUDE:  { underlying: 'CRUDE',  onDemandKey: 'CRUDE',  displayName: 'CRUDE-MCX',  lotSize: 100,   quoteCcy: 'USD', usdToInr: 84 },  // 100 barrels
  NATGAS: { underlying: 'NATGAS', onDemandKey: 'NATGAS', displayName: 'NATGAS-MCX', lotSize: 1250,  quoteCcy: 'USD', usdToInr: 84 },  // 1250 mmBtu
  COPPER: { underlying: 'COPPER', onDemandKey: 'COPPER', displayName: 'COPPER-MCX', lotSize: 2500,  quoteCcy: 'USD', usdToInr: 84 },  // 2500 kg
}

export async function runCommodityScan(): Promise<{
  generatedAt: string
  scanned: number
  eliteCount: number
  strongCount: number
  rows: any[]
}> {
  const symbols = Object.values(MCX_CONTRACTS).map(c => c.onDemandKey)
  log.info('COMMODITY', `scanning ${symbols.length} MCX contracts`)
  const scan = await runOnDemandScan(symbols)
  const rows: any[] = []
  let elites = 0, strongs = 0
  for (const r of scan.results ?? []) {
    if (!r.ok) continue
    // Only actionable setups
    if (r.compositeBias !== 'BULLISH' && r.compositeBias !== 'BEARISH') continue
    if (!r.entry || !r.stopLoss) continue
    // Tier gates matching HQS
    const score = (r as any).compositeScore ?? 0
    const tier: 'ELITE' | 'STRONG' | null =
      score >= 80 ? 'ELITE' :
      score >= 60 ? 'STRONG' :
      null
    if (!tier) continue
    if (tier === 'ELITE') elites++
    else strongs++

    // Find the MCX contract meta for sizing
    const contractKey = Object.keys(MCX_CONTRACTS).find(k => MCX_CONTRACTS[k].onDemandKey === r.symbol) ?? r.symbol
    const contract = MCX_CONTRACTS[contractKey]

    rows.push({
      symbol: contract?.displayName ?? r.symbol,
      underlying: r.symbol,
      segment: 'MCX',
      side: r.compositeBias === 'BULLISH' ? 'LONG' : 'SHORT',
      source: 'MCX-VP+FIB',
      tier, stars: tier === 'ELITE' ? 5 : 3,
      score,
      ltp: r.ltp,
      entry: r.entry,
      stopLoss: r.stopLoss,
      target1: r.target1,
      target2: r.target2,
      target3: r.target3,
      riskPct: (r as any).riskPct,
      rewardT1Pct: (r as any).rewardT1Pct,
      rrT1: (r as any).rrT1,
      rrT2: (r as any).rrT2,
      rrT3: (r as any).rrT3,
      entryDate: r.entryDate,
      target1Date: r.target1Date,
      target2Date: r.target2Date,
      target3Date: r.target3Date,
      slDate: r.slDate,
      lotSize: contract?.lotSize ?? 1,
      quoteCcy: contract?.quoteCcy ?? 'USD',
      usdToInr: contract?.usdToInr ?? 84,
      reasoning: r.reasoning ?? [],
      unifiedReason: r.unifiedReason ?? '',
    })
  }
  rows.sort((a, b) => b.score - a.score)

  const out = {
    generatedAt: new Date().toISOString(),
    scanned: symbols.length,
    eliteCount: elites,
    strongCount: strongs,
    rows,
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf-8')
  log.info('COMMODITY', `wrote ${rows.length} MCX setups (${elites} elite · ${strongs} strong)`)
  return out
}
