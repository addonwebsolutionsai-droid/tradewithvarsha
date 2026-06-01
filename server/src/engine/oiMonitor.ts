import * as angel from '../data/angel'
import { fetchNiftyOptionChain, fetchBankNiftyOptionChain } from '../data/nse'
import { maxPain } from '../options/oiAnalyzer'
import { buildTradePlan } from '../engine/tradePlan'
import { logSignal } from './signalLogger'
import { onSignalGenerated, onOptionPremiumTick } from './tradeTracker'
import { log } from '../util/logger'
import { addDays } from '../util/time'
import type { OptionChain, OptionChainRow, Signal } from '../types'
import { analyzeOiFlow, type StrikeFlow, type OiFlowAnalysis } from './oiFlowAnalyzer'
import * as fs from 'fs'
import * as path from 'path'

/**
 * OI Monitor — 1-min option-chain polling + strike-by-strike flow analysis.
 *
 * Reads NIFTY + BANKNIFTY chains every minute. Uses `analyzeOiFlow()` to
 * classify each strike's positioning (long-buy / writing / covering /
 * unwinding), then generates strike-specific signals on the top 1-2
 * flows per underlying per minute.
 *
 * This is the difference vs. the old monitor:
 *   - Old: 4 trigger types, all fired ATM CE/PE blindly
 *   - New: scans ±5% of spot, picks the EXACT strike where flow is building,
 *          buys CE/PE at that strike with real chain LTP
 *
 * Example output (what a pro would look at on the chain):
 *   NIFTY spot 24350 · PCR 0.95 ·
 *   → CE 24400 shows +2.5M OI + LTP +18% = AGGR_CE_BUY · strong bullish
 *   → PE 24300 shows +1.8M OI + LTP +12% = AGGR_PE_BUY · competing bearish
 *   → Dominant bias: BULLISH (net +35 strength) → fire BUY 24400 CE @ chain LTP
 */

interface ChainSnapshot {
  ts: number
  chain: OptionChain
}

const lastSnap: Record<string, ChainSnapshot | undefined> = {}
const dedupe: Record<string, number> = {}
const DEDUPE_WINDOW_MS = 10 * 60_000       // same (strike × side × kind) won't fire again for 10 min

const MIN_STRENGTH = 40        // only fire signals on flows with strength ≥ 40/100

// 2026-06-01: persist last meaningful analysis (with strikeFlows) so the
// public OI-Build-up snapshot still has rows after market hours and after
// server restarts. `analyzeOiFlow` needs a prior chain to compute deltas;
// off-cron callers can't reconstruct that, so we cache the latest non-empty
// analysis here AND mirror it to disk.
const lastAnalysis: Record<string, { ts: number; analysis: OiFlowAnalysis }> = {}
const ANALYSIS_CACHE_FILE = path.join(process.cwd(), 'server', 'data', 'oi-analysis-cache.json')

function loadAnalysisCacheFromDisk(): void {
  try {
    const raw = fs.readFileSync(ANALYSIS_CACHE_FILE, 'utf8')
    const obj = JSON.parse(raw)
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && (v as any).analysis) lastAnalysis[k] = v as any
    }
  } catch { /* first run / corrupt — ignore */ }
}
loadAnalysisCacheFromDisk()

function persistAnalysisCache(): void {
  try {
    fs.mkdirSync(path.dirname(ANALYSIS_CACHE_FILE), { recursive: true })
    fs.writeFileSync(ANALYSIS_CACHE_FILE, JSON.stringify(lastAnalysis, null, 2))
  } catch (e) {
    log.warn('OI-MONITOR', `persist cache: ${(e as Error).message}`)
  }
}

function roundStrike(spot: number, underlying: string): number {
  const step = underlying === 'BANKNIFTY' ? 100 : 50
  return Math.round(spot / step) * step
}

function estimatePremiumFromChain(chain: OptionChain, strike: number, side: 'CE' | 'PE'): number {
  const row = chain.rows.find(r => r.strike === strike)
  if (row) {
    const ltp = side === 'CE' ? row.callLTP : row.putLTP
    if (ltp > 0) return +ltp.toFixed(2)
  }
  return +(chain.spot * 0.01).toFixed(2)
}

/** Convert a StrikeFlow into a Signal when it's strong enough to trade. */
function buildSignalFromFlow(
  underlying: 'NIFTY' | 'BANKNIFTY',
  chain: OptionChain,
  flow: StrikeFlow,
  analysis: OiFlowAnalysis,
): Signal | null {
  // Map flow to which option to BUY (flow bias = market direction, side = which
  // option you buy for that direction).
  // Bullish bias → buy a CALL (CE). Bearish bias → buy a PUT (PE).
  // The signal's chosen strike is the one where flow is strongest, not
  // always ATM — ride where the smart money is going.
  const buySide: 'CE' | 'PE' = flow.bias === 'BULLISH' ? 'CE' : 'PE'
  const strike = flow.strike
  const premium = estimatePremiumFromChain(chain, strike, buySide)
  if (!premium || premium <= 0) return null

  const expiry = chain.expiry || addDays(new Date(), 7).toISOString().slice(0, 10)

  // Premium-ladder — fast momentum options: -30% SL, +40% T1, +100% T2
  const slPrem = +(premium * 0.70).toFixed(2)
  const t1Prem = +(premium * 1.40).toFixed(2)
  const t2Prem = +(premium * 2.00).toFixed(2)

  // Grade based on strength
  const grade: 'A' | 'B' | 'C' =
    flow.strength >= 75 ? 'A' : flow.strength >= 55 ? 'B' : 'C'

  const reasons: string[] = [
    `🎯 OI FLOW · ${flow.kind.replace(/_/g, ' ')} detected at ${flow.strike} ${flow.side}`,
    flow.note,
    `Chain bias: ${analysis.dominantBias} (bull ${analysis.biasBreakdown.bullish} vs bear ${analysis.biasBreakdown.bearish})`,
    `Trade: BUY ${underlying} ${strike} ${buySide} @ ₹${premium} (chain LTP)`,
    analysis.summary,
  ]
  // Add competing setups as context
  if (analysis.top3Bullish.length) {
    reasons.push(`Other bullish: ${analysis.top3Bullish.slice(0, 3).map(f => `${f.kind.split('_').slice(0,2).join('')} ${f.strike} (${f.strength})`).join(' · ')}`)
  }
  if (analysis.top3Bearish.length) {
    reasons.push(`Other bearish: ${analysis.top3Bearish.slice(0, 3).map(f => `${f.kind.split('_').slice(0,2).join('')} ${f.strike} (${f.strength})`).join(' · ')}`)
  }

  const tradePlan = buildTradePlan({
    type: 'OPTIONS', underlying, strike, side: buySide, expiry, premium,
    entry: premium, target2: t2Prem, direction: 'BUY',
    asOf: new Date().toISOString(),
  })
  return {
    id: `oi-flow-${underlying}-${strike}-${buySide}-${Date.now()}`,
    instrument: `${underlying} ${strike} ${buySide}`,
    direction: 'BUY',
    grade,
    score: Math.min(9, Math.round(flow.strength / 10 + 1)),    // 0-9 scale
    entry: premium,
    stopLoss: slPrem,
    target1: t1Prem,
    target2: t2Prem,
    target3: tradePlan.target3,
    riskPct: +((1 - slPrem / premium) * 100).toFixed(2),
    rewardPct: +((t1Prem / premium - 1) * 100).toFixed(2),
    riskReward: +((t1Prem - premium) / Math.max(premium - slPrem, 0.01)).toFixed(2),
    type: 'OPTIONS',
    reasons,
    gannNote: 'OI flow — chain read',
    astroNote: 'n/a',
    oiNote: `${flow.kind.replace(/_/g, ' ')} · ${flow.spotDistancePct >= 0 ? '+' : ''}${flow.spotDistancePct}% from spot · OI Δ ${flow.oiChange.toLocaleString('en-IN')}`,
    pattern: flow.kind,
    expiresAt: expiry,
    timestamp: new Date().toISOString(),
    confluence: { oi: true, volume: true, flow: flow.bias === 'BULLISH' },
    confluenceCount: 3,
    source: 'oi-flow',
    tier: 'LIVE',
    asOf: new Date().toISOString(),
    meta: { timeframe: '1m', rsi: undefined, atr: undefined },
    tradePlan,
  }
}

/** One-tick scan — returns signals generated this tick. */
export async function tickOiMonitor(): Promise<Signal[]> {
  const out: Signal[] = []
  // BANKNIFTY deliberately excluded per user directive. Only NIFTY OI flow
  // generates actionable signals. BANKNIFTY chain still fetched elsewhere
  // if needed (e.g. for the Options chain page), but doesn't emit signals.
  for (const underlying of ['NIFTY'] as const) {
    try {
      let chain: OptionChain | null = null
      if (angel.hasAngelCreds()) chain = await angel.getOptionChain(underlying).catch(() => null)
      if (!chain) chain = underlying === 'NIFTY' ? await fetchNiftyOptionChain() : await fetchBankNiftyOptionChain()
      if (!chain || !chain.rows?.length) continue
      chain.maxPain = maxPain(chain)

      const prev = lastSnap[underlying]
      const analysis = analyzeOiFlow(chain, prev ? { rows: prev.chain.rows, pcr: prev.chain.pcr, maxPain: prev.chain.maxPain } : null)

      // Always store current as new prev
      lastSnap[underlying] = { ts: Date.now(), chain }

      // Cache analysis if it has meaningful flows — preserves last-known
      // institutional positioning across server restarts + after-hours.
      if (analysis.strikeFlows.length > 0) {
        lastAnalysis[underlying] = { ts: Date.now(), analysis }
        persistAnalysisCache()
      }

      // Tick every option premium so any OPEN option trades have their
      // SL/T1/T2 evaluated against the actual chain LTP — not underlying spot.
      for (const row of chain.rows) {
        if (row.callLTP > 0) {
          const evs = await onOptionPremiumTick(`${underlying} ${row.strike} CE`, row.callLTP).catch(() => [])
          for (const ev of evs) log.ok('TRADE', `${ev.kind} · ${ev.trade.symbol} @ ₹${row.callLTP} (${ev.pnlPct.toFixed(1)}%)`)
        }
        if (row.putLTP > 0) {
          const evs = await onOptionPremiumTick(`${underlying} ${row.strike} PE`, row.putLTP).catch(() => [])
          for (const ev of evs) log.ok('TRADE', `${ev.kind} · ${ev.trade.symbol} @ ₹${row.putLTP} (${ev.pnlPct.toFixed(1)}%)`)
        }
      }

      // Need a prior snapshot to have meaningful deltas
      if (!prev) continue

      // PER USER DIRECTIVE: NIFTY OI signals were producing too many losing
      // PE trades. The OI monitor now ONLY tracks chain (for tradeTracker
      // option-premium ticks above) and does NOT emit signals for NIFTY.
      // The strict 9/21 EMA-cross + Marabozu strategy is the sole NIFTY
      // options producer. Keeping the OI monitor running is still valuable
      // because it routes real option premium to open trades' SL/T1/T2.
      const enableSignals = false
      if (!enableSignals) continue

      const strong = analysis.strikeFlows
        .filter(f => f.strength >= MIN_STRENGTH)
        .filter(f => analysis.dominantBias === 'NEUTRAL' || f.bias === analysis.dominantBias || f.strength >= 60)
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 2)

      for (const flow of strong) {
        const dedupeKey = `${underlying}:${flow.strike}:${flow.side}:${flow.kind}`
        const lastFired = dedupe[dedupeKey] ?? 0
        if (Date.now() - lastFired < DEDUPE_WINDOW_MS) continue
        dedupe[dedupeKey] = Date.now()

        const sig = buildSignalFromFlow(underlying, chain, flow, analysis)
        if (!sig) continue

        out.push(sig)
        void logSignal(sig, 'OI_MONITOR').catch(() => {})
        void onSignalGenerated(sig).catch(() => {})
        log.ok('OI-MONITOR', `${underlying} ${flow.kind} @ ${flow.strike} · strength ${flow.strength} → ${sig.instrument}`)
      }
    } catch (e) {
      log.warn('OI-MONITOR', `${underlying}: ${(e as Error).message}`)
    }
  }
  return out
}

/** Expose latest analysis for API consumers (dashboard widget etc).
 *  Prefers the cached analysis from the last live tick (which has real
 *  OI deltas + strike flows). Falls back to a synthetic "where institutions
 *  are parked" analysis built from absolute OI when no live tick has run
 *  yet (cold start, pre-first-market-open, restart). */
export function getLatestOiAnalysis(): Record<string, OiFlowAnalysis | null> {
  const result: Record<string, OiFlowAnalysis | null> = {}
  for (const u of ['NIFTY']) {
    const cached = lastAnalysis[u]
    if (cached) { result[u] = cached.analysis; continue }
    const s = lastSnap[u]
    if (!s) { result[u] = null; continue }
    const base = analyzeOiFlow(s.chain, null)
    // Synthesize parked-OI flows from the chain itself — top CE/PE strikes
    // by absolute OI in a ±5% band around spot.
    result[u] = enrichWithParkedFlows(base, s.chain)
  }
  return result
}

function enrichWithParkedFlows(base: OiFlowAnalysis, chain: OptionChain): OiFlowAnalysis {
  const spot = chain.spot
  const band = chain.rows.filter(r => Math.abs(r.strike - spot) / spot * 100 <= 5)
  const ceTop = [...band]
    .filter(r => r.strike >= spot && r.callOI > 0)
    .sort((a, b) => b.callOI - a.callOI)
    .slice(0, 3)
    .map(r => ({
      strike: r.strike, side: 'CE' as const, kind: 'CE_WRITING' as any, bias: 'BEARISH' as any,
      strength: 45,
      oiChange: 0, ltpChange: 0, ltpChangePct: 0,
      currentOI: r.callOI, currentLTP: r.callLTP, currentIV: r.callIV, currentVol: r.callVolume,
      spotDistancePct: +(((r.strike - spot) / spot) * 100).toFixed(2),
      note: `Heavy call writing parked at ${r.strike} (OI ${r.callOI.toLocaleString('en-IN')}) — institutional resistance ceiling`,
    }))
  const peTop = [...band]
    .filter(r => r.strike <= spot && r.putOI > 0)
    .sort((a, b) => b.putOI - a.putOI)
    .slice(0, 3)
    .map(r => ({
      strike: r.strike, side: 'PE' as const, kind: 'PE_WRITING' as any, bias: 'BULLISH' as any,
      strength: 45,
      oiChange: 0, ltpChange: 0, ltpChangePct: 0,
      currentOI: r.putOI, currentLTP: r.putLTP, currentIV: r.putIV, currentVol: r.putVolume,
      spotDistancePct: +(((r.strike - spot) / spot) * 100).toFixed(2),
      note: `Heavy put writing parked at ${r.strike} (OI ${r.putOI.toLocaleString('en-IN')}) — institutional support floor`,
    }))
  const synthetic = [...peTop, ...ceTop] as any[]
  return {
    ...base,
    strikeFlows: synthetic,
    top3Bullish: peTop as any,
    top3Bearish: ceTop as any,
    summary: base.summary + ' · Showing institutional positioning (parked OI) — fresh deltas resume at next market tick.',
  }
}
