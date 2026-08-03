/**
 * NIFTY Bias Composer — the miss-of-Jul-25 fix.
 *
 * User directive (31 Jul 2026):
 *   "How we can miss the move of 25th July 23660 to 24590 today."
 *
 * Root cause of the miss:
 *   - nifty-outlook returned NO_DATA (NSE option-chain 404s from GH IPs)
 *   - oi-buildup HAD the right story (heavy PE writing at 23400-23700 =
 *     institutional support floor, contrarian-bullish PCR) but lived on a
 *     niche tab, never aggregated into a single actionable NIFTY call
 *   - nifty-long-horizon emitted waypoints but no unified BULLISH/BEARISH
 *
 * This engine composes ALL NIFTY-relevant snapshots into ONE definitive
 * call with trade plan. Reads:
 *
 *   - oi-buildup.json         → PE writing / CE writing / max-pain drift
 *   - nifty-long-horizon.json → waypoint clustering near current spot
 *   - nifty-outlook.json      → if NOT NO_DATA, adopts its bias directly
 *   - pro-setups.json         → NIFTY-specific pro setups if present
 *   - nifty-volume-profile.json → VP bias if fresh
 *
 * Emits:
 *   - nifty-bias.json                      — new file, richer than outlook
 *   - overrides nifty-outlook.json         — when foresight was NO_DATA,
 *                                             we hydrate it so the /nifty-outlook
 *                                             page never renders empty
 */

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { log } from '../util/logger'
import * as data from '../data'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

export interface NiftyBias {
  generatedAt: string
  spot: number
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  netScore: number                         // − bearish · + bullish · 0 neutral
  bullScore: number
  bearScore: number
  sources: Array<{
    name: string
    vote: 'BULL' | 'BEAR' | 'NEUTRAL'
    weight: number
    detail: string
  }>
  tradePlan: {
    action: string                          // "BUY NIFTY 24400 CE"
    instrument: string
    entry: number
    stopLoss: number
    target1: number
    target2: number
    spotEntry: number
    spotSL: number
    spotT1: number
    spotT2: number
    expectedMoveDays: number
    reason: string
  } | null
  humanExplain: string
}

function readSnap(name: string): any | null {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(SNAP_DIR, name), 'utf-8'))
  } catch { return null }
}

function safeWrite(name: string, obj: any): void {
  try {
    fsSync.writeFileSync(path.join(SNAP_DIR, name), JSON.stringify(obj, null, 2))
  } catch (e) { log.warn('NIFTY-BIAS', `write ${name} failed: ${(e as Error).message}`) }
}

export async function runNiftyBiasComposer(): Promise<NiftyBias> {
  const t0 = Date.now()
  log.info('NIFTY-BIAS', 'composer starting')

  // ── 1. Get current NIFTY spot from live candles (never trust 0 from snapshots)
  let spot = 0
  try {
    const candles = await data.getCandles('NIFTY', '1D' as any, 5)
    spot = candles?.[candles.length - 1]?.close ?? 0
  } catch { /* fall through */ }
  if (!spot) {
    // Fall back to whatever snapshot has a valid spot
    const oi = readSnap('oi-buildup.json')
    spot = oi?.summary?.find((s: any) => s.underlying === 'NIFTY')?.spot ?? 0
  }
  if (!spot) {
    const lh = readSnap('nifty-long-horizon.json')
    spot = lh?.spot ?? 0
  }

  const sources: NiftyBias['sources'] = []
  let bullScore = 0, bearScore = 0

  // ── 2. OI-BUILDUP signal — the one that flagged the Jul-25 move
  const oi = readSnap('oi-buildup.json')
  const oiNifty = oi?.summary?.find((s: any) => s.underlying === 'NIFTY')
  const oiNiftyRows = (oi?.rows ?? []).filter((r: any) => r.underlying === 'NIFTY')
  if (oiNifty) {
    // PCR > 1.4 with heavy PE-writing at spot-1% is contrarian bullish
    const pcr = Number(oiNifty.pcr ?? 0)
    const maxPain = Number(oiNifty.maxPain ?? 0)
    const bullishFlows = oiNiftyRows.filter((r: any) => r.bias === 'BULLISH').length
    const bearishFlows = oiNiftyRows.filter((r: any) => r.bias === 'BEARISH').length
    const netFlow = bullishFlows - bearishFlows
    const maxPainDrift = maxPain > 0 && spot > 0 ? (maxPain - spot) / spot * 100 : 0
    let oiWeight = 25
    let oiVote: 'BULL' | 'BEAR' | 'NEUTRAL' = 'NEUTRAL'
    let oiDetail = `PCR ${pcr.toFixed(2)} · max-pain ${maxPain} (${maxPainDrift >= 0 ? '+' : ''}${maxPainDrift.toFixed(2)}%) · flows ${bullishFlows}↑ ${bearishFlows}↓`
    if (netFlow >= 2 || (pcr >= 1.3 && bullishFlows > bearishFlows)) {
      oiVote = 'BULL'; bullScore += oiWeight
    } else if (netFlow <= -2 || (pcr < 0.7 && bearishFlows > bullishFlows)) {
      oiVote = 'BEAR'; bearScore += oiWeight
    } else if (Math.abs(maxPainDrift) > 0.5) {
      // Max-pain drift alone is a weak signal
      if (maxPainDrift > 0) { oiVote = 'BULL'; bullScore += 10; oiWeight = 10 }
      else { oiVote = 'BEAR'; bearScore += 10; oiWeight = 10 }
    }
    sources.push({ name: 'OI-BUILDUP', vote: oiVote, weight: oiWeight, detail: oiDetail })
  }

  // ── 3. NIFTY LONG-HORIZON: waypoint clustering near spot within 4%
  const lh = readSnap('nifty-long-horizon.json')
  if (lh?.waypoints && spot > 0) {
    const nearBand = spot * 0.04
    const above = lh.waypoints.filter((w: any) => w.price > spot && w.price - spot <= nearBand * 3).length
    const below = lh.waypoints.filter((w: any) => w.price < spot && spot - w.price <= nearBand * 3).length
    const nearestAbove = lh.waypoints.filter((w: any) => w.price > spot).sort((a: any, b: any) => a.price - b.price)[0]
    const nearestBelow = lh.waypoints.filter((w: any) => w.price < spot).sort((a: any, b: any) => b.price - a.price)[0]
    let lhVote: 'BULL' | 'BEAR' | 'NEUTRAL' = 'NEUTRAL'
    const lhWeight = 15
    const distAbove = nearestAbove ? nearestAbove.price - spot : Infinity
    const distBelow = nearestBelow ? spot - nearestBelow.price : Infinity
    // If the nearest waypoint above is MUCH closer than the one below,
    // targets are calling higher → bullish, and vice versa.
    if (distAbove < distBelow * 0.5) {
      lhVote = 'BULL'; bullScore += lhWeight
    } else if (distBelow < distAbove * 0.5) {
      lhVote = 'BEAR'; bearScore += lhWeight
    }
    const detail = `nearest ↑ ${nearestAbove?.price?.toFixed(0) ?? '—'} (+${distAbove < Infinity ? distAbove.toFixed(0) : '—'}) · ↓ ${nearestBelow?.price?.toFixed(0) ?? '—'} (-${distBelow < Infinity ? distBelow.toFixed(0) : '—'}) · ${above}↑ ${below}↓ waypoints`
    sources.push({ name: 'LONG-HORIZON', vote: lhVote, weight: lhWeight, detail })
  }

  // ── 4. EXISTING nifty-outlook (if it happens to have real data)
  const nout = readSnap('nifty-outlook.json')
  if (nout && nout.status !== 'NO_DATA' && nout.direction && nout.netScore != null) {
    const dir = String(nout.direction).toUpperCase()
    const w = 20
    if (dir === 'BULLISH') { bullScore += w; sources.push({ name: 'FORESIGHT', vote: 'BULL', weight: w, detail: `net ${nout.netScore >= 0 ? '+' : ''}${nout.netScore} · ${nout.confidence}` }) }
    else if (dir === 'BEARISH') { bearScore += w; sources.push({ name: 'FORESIGHT', vote: 'BEAR', weight: w, detail: `net ${nout.netScore}` }) }
    else sources.push({ name: 'FORESIGHT', vote: 'NEUTRAL', weight: 0, detail: 'neutral' })
  }

  // ── 5. Simple 5-day trend from candles as a tiebreaker
  try {
    const candles = await data.getCandles('NIFTY', '1D' as any, 15)
    if (candles && candles.length >= 6) {
      const last = candles[candles.length - 1].close
      const ref5 = candles[candles.length - 6].close
      const ret5d = (last - ref5) / ref5 * 100
      const w = 10
      if (ret5d > 1.5) { bullScore += w; sources.push({ name: 'TREND-5D', vote: 'BULL', weight: w, detail: `+${ret5d.toFixed(2)}%` }) }
      else if (ret5d < -1.5) { bearScore += w; sources.push({ name: 'TREND-5D', vote: 'BEAR', weight: w, detail: `${ret5d.toFixed(2)}%` }) }
      else sources.push({ name: 'TREND-5D', vote: 'NEUTRAL', weight: 0, detail: `${ret5d.toFixed(2)}%` })
    }
  } catch { /* skip if candles fail */ }

  // ── 6. Compose direction + confidence
  const netScore = bullScore - bearScore
  let direction: NiftyBias['direction'] = 'NEUTRAL'
  if (netScore >= 15) direction = 'BULLISH'
  else if (netScore <= -15) direction = 'BEARISH'
  let confidence: NiftyBias['confidence'] = 'LOW'
  const absScore = Math.abs(netScore)
  if (absScore >= 40) confidence = 'HIGH'
  else if (absScore >= 20) confidence = 'MEDIUM'

  // ── 7. Trade plan — prefer OI-buildup's already-computed trade if bias agrees
  let tradePlan: NiftyBias['tradePlan'] = null
  const oiTradeRow = oiNiftyRows.find((r: any) => (direction === 'BULLISH' && r.bias === 'BULLISH') || (direction === 'BEARISH' && r.bias === 'BEARISH'))
    ?? oiNiftyRows[0]
  if (oiTradeRow && spot > 0) {
    // For BULLISH → BUY ATM CE; for BEARISH → BUY ATM PE
    const isBull = direction === 'BULLISH'
    const atmStrike = Math.round(spot / 50) * 50
    const targetStrike = isBull ? atmStrike + 50 : atmStrike - 50
    const entry = oiTradeRow.entry ?? +(spot * 0.01).toFixed(2)
    tradePlan = {
      action: `${isBull ? 'BUY' : 'BUY'} NIFTY ${targetStrike} ${isBull ? 'CE' : 'PE'}`,
      instrument: `NIFTY ${targetStrike} ${isBull ? 'CE' : 'PE'}`,
      entry,
      stopLoss: +(entry * 0.7).toFixed(2),
      target1: +(entry * 1.4).toFixed(2),
      target2: +(entry * 1.8).toFixed(2),
      spotEntry: spot,
      spotSL: isBull ? +(spot * 0.99).toFixed(2) : +(spot * 1.01).toFixed(2),
      spotT1: isBull ? +(spot * 1.01).toFixed(2) : +(spot * 0.99).toFixed(2),
      spotT2: isBull ? +(spot * 1.02).toFixed(2) : +(spot * 0.98).toFixed(2),
      expectedMoveDays: 5,
      reason: `${direction} composite (${sources.filter(s => s.vote !== 'NEUTRAL').map(s => `${s.name} ${s.vote}`).join(' · ')})`,
    }
  }

  const humanLines: string[] = [
    `NIFTY BIAS: ${direction} · ${confidence} confidence · net ${netScore >= 0 ? '+' : ''}${netScore}`,
    `Spot: ₹${spot.toFixed(2)}   Bull score: ${bullScore}   Bear score: ${bearScore}`,
    '',
    'Source votes:',
    ...sources.map(s => `  ${s.vote === 'BULL' ? '🟢' : s.vote === 'BEAR' ? '🔴' : '⚪'} ${s.name} (+${s.weight}) — ${s.detail}`),
  ]
  if (tradePlan) {
    humanLines.push('', `Trade: ${tradePlan.action} @ ₹${tradePlan.entry}`)
    humanLines.push(`SL ₹${tradePlan.stopLoss} · T1 ₹${tradePlan.target1} · T2 ₹${tradePlan.target2}`)
    humanLines.push(`Spot band: entry ₹${tradePlan.spotEntry} · T1 ₹${tradePlan.spotT1} · T2 ₹${tradePlan.spotT2} · SL ₹${tradePlan.spotSL}`)
  }

  const bias: NiftyBias = {
    generatedAt: new Date().toISOString(),
    spot,
    direction,
    confidence,
    netScore,
    bullScore,
    bearScore,
    sources,
    tradePlan,
    humanExplain: humanLines.join('\n'),
  }

  safeWrite('nifty-bias.json', bias)

  // ── 8. Hydrate nifty-outlook.json when it was NO_DATA — closes the
  //      /nifty-outlook empty-page problem the user has flagged twice.
  //      Only overrides when foresight itself gave nothing usable.
  const currentOutlook = readSnap('nifty-outlook.json')
  if (!currentOutlook || currentOutlook.status === 'NO_DATA' || (currentOutlook.spot ?? 0) === 0) {
    const hydratedOutlook = {
      generatedAt: bias.generatedAt,
      status: 'OK_FROM_BIAS_COMPOSER',
      spot,
      direction,
      confidence,
      netScore,
      bullScore,
      bearScore,
      sessionState: currentOutlook?.sessionState ?? 'MARKET_CLOSED',
      tradePlan,
      reasoning: sources.reduce((acc: any, s) => { acc[s.name] = `${s.vote} · ${s.detail}`; return acc }, {}),
      smartMoneyLevel: oiNifty?.maxPain ?? 0,
      smartMoneyDirection: direction,
      playbookDetected: sources.filter(s => s.vote !== 'NEUTRAL').map(s => `${s.name}-${s.vote}`),
      composedFallback: true,
      note: 'Composed by niftyBiasComposer.ts — foresight engine returned no data (NSE option-chain likely 404 from GH IPs). This synthesis uses OI-buildup + long-horizon + trend so /nifty-outlook renders a live call.',
    }
    safeWrite('nifty-outlook.json', hydratedOutlook)
    log.ok('NIFTY-BIAS', `hydrated /nifty-outlook fallback with ${direction} ${confidence}`)
  }

  log.ok('NIFTY-BIAS', `${direction} ${confidence} · net ${netScore} · ${sources.length} sources · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return bias
}
