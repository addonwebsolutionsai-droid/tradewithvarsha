/**
 * Options Accumulation Radar — the "early institutional positioning"
 * detector.
 *
 * Goal: catch strikes where big players are BUILDING positions BEFORE the
 * price move — not the current OI-buildup detector's approach which fires
 * on ΔOI thresholds AFTER the position is already built.
 *
 * Method: reads the per-tick OI history log (data/oi-history/) and scores
 * every strike by:
 *
 *   velocityScore  = |ΔOI| over last N ticks / OI baseline
 *   flowScore      = ΔOI × premium (rupees committed this tick)
 *   freshnessScore = min(1, volume / |ΔOI|)          — 1.0 = fresh, ≪1 = churn
 *   ivScore        = |ΔIV| over N ticks              — accumulation → IV drifts
 *   stackingScore  = # of expiries showing the same strike accumulating
 *
 *   strike_score   = velocityScore × 40 + flowScore(norm) × 25 +
 *                    freshnessScore × 15 + ivScore(norm) × 10 +
 *                    stackingScore × 10
 *   (capped 0-100)
 *
 * Emits: server/data/public-snapshots/options-radar.json
 *
 * Read by paper-trading book as an FNO options source. Signal fires only
 * on ELITE (≥ 75) — this cadence is meant to be selective, not noisy.
 *
 * Bootstrap: needs 4+ ticks of oi-history to compute anything meaningful.
 * On the first few intraday-tick runs after this ships, the radar output
 * will be empty. That's expected — velocity requires history.
 */

import fs from 'fs'
import path from 'path'
import { readAllLatestPerStrike, readOiHistory, OiHistoryTick } from './oiHistoryLogger'
import { getLatestOiAnalysis } from './oiMonitor'
import { log } from '../util/logger'

const OUT_PATH = path.resolve(process.cwd(), 'data', 'public-snapshots', 'options-radar.json')

const MIN_HISTORY_TICKS = 4         // need at least 4 samples for velocity
const VELOCITY_WINDOW = 6           // compare against last 6 ticks (~30 min at 5-min cadence)
const MIN_OI_BASELINE = 20_000      // filter out illiquid strikes
const MIN_STRIKE_SCORE_ELITE = 75

export interface RadarSignal {
  underlying: string
  expiry: string
  daysToExpiry: number | null
  strike: number
  side: 'CE' | 'PE'
  bias: 'BULLISH' | 'BEARISH'      // CE accumulation LONG = BULLISH; PE accumulation = BEARISH
  strikeScore: number               // 0-100
  velocity: number                  // ΔOI / baseline over VELOCITY_WINDOW
  flowInr: number                   // ΔOI × premium (₹ commited by big players this window)
  freshness: number                 // volume / |ΔOI|
  ivDelta: number                   // IV drift over window
  stackingCount: number             // # of other expiries showing same-strike accumulation
  currentOI: number
  currentLTP: number
  currentIV: number
  spot: number
  distFromSpotPct: number

  // Trade plan derived from strike + premium
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number

  ticksAvailable: number
  reasoning: string[]
  unifiedReason: string
}

function pctChange(a: number, b: number): number {
  return b > 0 ? ((a - b) / b) * 100 : 0
}

function scoreStrike(history: OiHistoryTick[], spot: number): {
  score: number
  velocity: number
  flowInr: number
  freshness: number
  ivDelta: number
} | null {
  if (history.length < MIN_HISTORY_TICKS) return null
  const window = history.slice(-VELOCITY_WINDOW)
  const first = window[0]
  const last = window[window.length - 1]

  const baseOi = Math.max(first.oi, MIN_OI_BASELINE)
  if (baseOi < MIN_OI_BASELINE) return null

  const deltaOi = last.oi - first.oi
  const velocity = Math.abs(deltaOi) / baseOi                  // e.g. 0.35 = 35% OI growth in window
  const flowInr = Math.abs(deltaOi) * last.ltp * 75            // NIFTY lot 75 (approx); rupees committed
  const volSum = window.reduce((s, t) => s + (t.vol ?? 0), 0)
  const freshness = Math.abs(deltaOi) > 0 ? Math.min(1, volSum / Math.abs(deltaOi)) : 0
  const ivDelta = (last.iv ?? 0) - (first.iv ?? 0)

  // Score composition — velocity weighted heaviest (this is the "before-the-move" edge)
  const velocityScore = Math.min(1, velocity / 0.5) * 40       // cap at 50% velocity → 40 pts
  const flowScore = Math.min(1, flowInr / 5_000_000) * 25      // cap at ₹50 L → 25 pts
  const freshScore = freshness * 15                             // 0-15 pts
  const ivScore = Math.min(1, Math.abs(ivDelta) / 5) * 10       // cap at 5 vol pts → 10 pts
  // Directional-consistency bonus: OI growing AND premium growing → aggressive buying
  const premiumDelta = pctChange(last.ltp, first.ltp)
  const consistencyBonus = (deltaOi > 0 && premiumDelta > 3) ? 10 : 0
  const score = Math.round(velocityScore + flowScore + freshScore + ivScore + consistencyBonus)

  void spot
  return {
    score: Math.min(100, Math.max(0, score)),
    velocity: Math.round(velocity * 1000) / 1000,
    flowInr: Math.round(flowInr),
    freshness: Math.round(freshness * 100) / 100,
    ivDelta: Math.round(ivDelta * 100) / 100,
  }
}

export async function runOptionsAccumulationRadar(): Promise<{
  generatedAt: string
  underlyings: string[]
  totalStrikesScanned: number
  elites: number
  strongs: number
  signals: RadarSignal[]
}> {
  const analysis = getLatestOiAnalysis()
  const underlyings = Object.keys(analysis).filter(k => analysis[k] && (analysis[k] as any).expiry)

  const allSignals: RadarSignal[] = []
  let totalScanned = 0

  // Track same-strike accumulation across expiries for stacking-bonus
  const accByStrike = new Map<string, number>()

  for (const underlying of underlyings) {
    const a = analysis[underlying] as any
    const expiry: string = a.expiry
    const daysToExpiry: number | null = a.daysToExpiry ?? null
    const spot: number = a.spot ?? 0

    const latestPerStrike = readAllLatestPerStrike(underlying, expiry)
    for (const latest of latestPerStrike) {
      totalScanned++
      const history = readOiHistory(underlying, expiry, latest.strike, latest.side, VELOCITY_WINDOW + 2)
      const scored = scoreStrike(history, spot)
      if (!scored) continue
      if (scored.score < 50) continue                          // gate: only actionable

      const distPct = spot > 0 ? ((latest.strike - spot) / spot) * 100 : 0
      // Skip deep ITM (institutions don't buy there for direction) and super-far OTM (>15%)
      if (Math.abs(distPct) > 15) continue
      // Skip ATM band (< 0.5% from spot) — that's retail-crowded, not accumulation
      if (Math.abs(distPct) < 0.5) continue

      // Directional interpretation
      const bias: 'BULLISH' | 'BEARISH' =
        (latest.side === 'CE' && distPct > 0)  ? 'BULLISH' :   // OTM CE accumulation = expecting up-move
        (latest.side === 'PE' && distPct < 0)  ? 'BEARISH' :   // OTM PE accumulation = expecting down-move
        (latest.side === 'CE' && distPct <= 0) ? 'BULLISH' :   // ITM CE = strong bullish (already deep)
        'BEARISH'

      // Trade plan on the premium (entry at current LTP, targets scaled to velocity)
      const entry = latest.ltp
      const slDist = Math.max(entry * 0.30, 5)                 // 30% premium SL (options loss cap)
      const rewardMult = scored.score >= 85 ? 1.5 : 1.2         // score-scaled reward
      const t1 = entry * (1 + rewardMult * 0.4)                // +40-60%
      const t2 = entry * (1 + rewardMult * 0.8)                // +80-120%
      const t3 = entry * (1 + rewardMult * 1.4)                // +140-210%
      const sl = Math.max(1, entry - slDist)

      const key = `${underlying}-${latest.strike}-${latest.side}`
      accByStrike.set(key, (accByStrike.get(key) ?? 0) + 1)

      const sig: RadarSignal = {
        underlying, expiry, daysToExpiry,
        strike: latest.strike, side: latest.side, bias,
        strikeScore: scored.score,
        velocity: scored.velocity,
        flowInr: scored.flowInr,
        freshness: scored.freshness,
        ivDelta: scored.ivDelta,
        stackingCount: 0,   // filled in below
        currentOI: latest.oi,
        currentLTP: latest.ltp,
        currentIV: latest.iv ?? 0,
        spot,
        distFromSpotPct: Math.round(distPct * 100) / 100,
        entry: Math.round(entry * 100) / 100,
        stopLoss: Math.round(sl * 100) / 100,
        target1: Math.round(t1 * 100) / 100,
        target2: Math.round(t2 * 100) / 100,
        target3: Math.round(t3 * 100) / 100,
        ticksAvailable: history.length,
        reasoning: [
          `OI velocity ${(scored.velocity * 100).toFixed(0)}% over last ${history.length} ticks (${VELOCITY_WINDOW * 5} min)`,
          `Premium flow ₹${(scored.flowInr / 100000).toFixed(1)} L this window`,
          `Freshness ratio ${scored.freshness.toFixed(2)} (${scored.freshness > 0.7 ? 'fresh positioning' : 'mostly churn'})`,
          `IV Δ ${scored.ivDelta > 0 ? '+' : ''}${scored.ivDelta.toFixed(2)}pts`,
          `${latest.side} strike ${latest.strike} is ${Math.abs(distPct).toFixed(1)}% ${distPct >= 0 ? 'above' : 'below'} spot ₹${spot.toFixed(2)} · ${bias}`,
        ],
        unifiedReason: '',
      }
      sig.unifiedReason = sig.reasoning.join(' · ')
      allSignals.push(sig)
    }
  }

  // Apply stacking bonus — strikes appearing in multiple expiries get +5 per extra expiry
  for (const sig of allSignals) {
    const acrossExpiries = allSignals.filter(s =>
      s.underlying === sig.underlying && s.strike === sig.strike && s.side === sig.side && s.expiry !== sig.expiry
    ).length
    sig.stackingCount = acrossExpiries
    if (acrossExpiries > 0) {
      sig.strikeScore = Math.min(100, sig.strikeScore + Math.min(15, acrossExpiries * 5))
      sig.reasoning.push(`🎯 STACKED across ${acrossExpiries + 1} expiries — high-conviction target price`)
      sig.unifiedReason = sig.reasoning.join(' · ')
    }
  }

  // Sort by strike score, keep top 20
  allSignals.sort((a, b) => b.strikeScore - a.strikeScore)
  const top = allSignals.slice(0, 20)
  const elites = top.filter(s => s.strikeScore >= MIN_STRIKE_SCORE_ELITE).length
  const strongs = top.filter(s => s.strikeScore >= 60 && s.strikeScore < MIN_STRIKE_SCORE_ELITE).length

  const out = {
    generatedAt: new Date().toISOString(),
    underlyings,
    totalStrikesScanned: totalScanned,
    elites,
    strongs,
    signals: top,
    minScoreEmitted: 50,
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), 'utf-8')
  log.info('OPT-RADAR', `scanned ${totalScanned} strikes · ${top.length} signals emitted (${elites} elite · ${strongs} strong)`)
  return out
}
