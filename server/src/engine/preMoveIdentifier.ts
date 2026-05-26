/**
 * Pre-Move Identifier — composes the 8-signal master prompt framework
 * (Institutional / Volume / Pattern / Fundamentals / News / Sector / Pump-Dump /
 * Entry-Risk) into a unified 24-point scorer for NSE/BSE stocks.
 *
 * Token-efficient design: this module does NOT re-implement the underlying
 * detection logic. It REUSES the existing infrastructure:
 *   - ADVANCED_PREMOVE_SCREENERS for patterns + volume
 *   - getShareholding / evaluateNoBrainer for institutional + pump-dump
 *   - SectorRotation for Signal 6
 *   - getFundamentals for Signal 4
 *   - tradePlan-style ATR levels for Signal 8
 *
 * Output: ranked candidates with full 8-signal breakdown + entry/SL/T1/T2/T3
 * trade plan, segmented into Tier 1 (≥18) / Tier 2 (13–17) / Tier 3 (9–12).
 *
 * Honest expectation: this is NOT an 85%-accuracy system (no equity system is).
 * Realistic target: 55–65% win-rate with R-multiple 2:1. The daily catch-rate
 * analyzer (server/src/engine/dailyCatchAnalyzer.ts) measures this objectively.
 */
import fs from 'fs/promises'
import path from 'path'
import * as data from '../data'
import { resolveUniverse } from '../screeners/universe'
import { ADVANCED_PREMOVE_SCREENERS } from '../screeners/preMoveAdvanced'
import { ema, lastATR, lastRSI, sma } from '../indicators'
import { getShareholding, evaluateNoBrainer } from '../data/shareholding'
import { getFundamentals, fundamentalsFactorFires } from './fundamentals'
import { getLatestSectorRotation, runSectorRotationScan, SECTOR_BASKETS } from './sectorRotation'
import { log } from '../util/logger'
import type { Candle } from '../types'

const LEARNING_DIR = path.resolve(__dirname, '../../data/learning')
const SNAP_FILE = path.join(LEARNING_DIR, 'pre-move-identifier-latest.json')

export interface SignalBreakdown {
  score: number                                 // 0..3
  reason: string                                // 1-line human reason
}

export interface PreMoveCandidate {
  symbol: string
  ltp: number
  marketCapCr?: number
  sector?: string
  // 8-signal breakdown
  s1_institutional: SignalBreakdown
  s2_volume: SignalBreakdown
  s3_pattern: SignalBreakdown
  s4_fundamentals: SignalBreakdown
  s5_news: SignalBreakdown
  s6_sector: SignalBreakdown
  s7_pumpDump: SignalBreakdown
  s8_entryTiming: SignalBreakdown
  // Composite
  totalScore: number                            // 0..24
  tier: 1 | 2 | 3 | 4                           // 1=buy, 2=watch, 3=monitor, 4=avoid
  tierLabel: string
  passedQualityFilter: boolean
  qualityRejectReason?: string
  // Trade plan
  entry: number
  stopLoss: number
  target1: number; target2: number; target3: number
  riskPct: number
  rewardPct: number
  riskReward: number
  expectedMovePct: number
  // For UI
  primarySignal: string                         // dominant pattern name
  shareholdingNote?: string
  detectedAt: string
}

export interface PreMoveRun {
  generatedAt: string
  universeSize: number
  evaluated: number
  qualityPassed: number
  candidates: PreMoveCandidate[]                // sorted by score desc
  tier1Count: number
  tier2Count: number
  tier3Count: number
  notes: string[]
}

// ── Quality filter — hard rejection criteria from master prompt ──
interface QualityCheck { ok: boolean; reason?: string }
async function checkQualityFilter(symbol: string, candles: Candle[]): Promise<QualityCheck> {
  if (candles.length < 60) return { ok: false, reason: 'insufficient history (<60 days)' }
  const last = candles[candles.length - 1]
  // Price floor — penny stock manipulation risk
  if (last.close < 10) return { ok: false, reason: 'penny stock (<₹10)' }
  // Recent extension without consolidation — already-moved exclusion
  if (candles.length >= 6) {
    const ret5d = (last.close - candles[candles.length - 6].close) / candles[candles.length - 6].close * 100
    if (ret5d > 15) return { ok: false, reason: `already up ${ret5d.toFixed(1)}% in 5d` }
  }
  // Turnover floor — illiquid stocks are manipulation playgrounds
  const v20 = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20
  const avgTurnoverCr = (v20 * last.close) / 1e7
  if (avgTurnoverCr < 2) return { ok: false, reason: `low turnover ₹${avgTurnoverCr.toFixed(2)}Cr` }
  // Shareholding gates (best-effort)
  try {
    const shp = await getShareholding(symbol)
    if (shp) {
      if (shp.marketCapCr > 0 && shp.marketCapCr < 100) return { ok: false, reason: `micro-cap ₹${shp.marketCapCr}Cr` }
      if (shp.promoterPct > 0 && shp.promoterPct < 25) return { ok: false, reason: `low promoter ${shp.promoterPct}%` }
      if (shp.promoterPledgePct > 50) return { ok: false, reason: `high pledge ${shp.promoterPledgePct}%` }
    }
  } catch { /* shareholding optional */ }
  return { ok: true }
}

// ── Signal 1: Institutional Accumulation (FII/DII/Promoter delta + no-brainer) ──
async function scoreInstitutional(symbol: string): Promise<SignalBreakdown> {
  try {
    const shp = await getShareholding(symbol)
    if (!shp) return { score: 0, reason: 'no shareholding data' }
    const nb = evaluateNoBrainer(shp)
    let pts = 0
    const bits: string[] = []
    if (shp.fiiDeltaQoQ > 0.5) { pts++; bits.push(`FII ↑${shp.fiiDeltaQoQ.toFixed(1)}%`) }
    if (shp.diiDeltaQoQ > 0.3) { pts++; bits.push(`DII ↑${shp.diiDeltaQoQ.toFixed(1)}%`) }
    if (Math.abs(shp.promoterDeltaQoQ) < 0.3 && shp.promoterPct >= 40) { pts++; bits.push('Promoter stable') }
    if (nb.isNoBrainer && pts < 3) pts = Math.min(3, pts + 1)
    return { score: Math.min(3, pts), reason: bits.join(' · ') || 'no QoQ confluence' }
  } catch { return { score: 0, reason: 'fetch error' } }
}

// ── Signal 2: Volume Signature (3x avg, delivery proxy, OBV trend) ──
function scoreVolume(candles: Candle[]): SignalBreakdown {
  const last = candles[candles.length - 1]
  const v20 = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20
  const todayRatio = v20 > 0 ? last.volume / v20 : 1
  // Up-days vs down-days volume over last 10
  const last10 = candles.slice(-10)
  let upVol = 0, downVol = 0
  for (const c of last10) {
    if (c.close >= c.open) upVol += c.volume
    else downVol += c.volume
  }
  // OBV trend over last 20
  let obv = 0; const obvSeries: number[] = []
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume
    obvSeries.push(obv)
  }
  const obvLast = obvSeries[obvSeries.length - 1]
  const obv20 = obvSeries[obvSeries.length - 21]
  const obvRising = obvLast != null && obv20 != null && obvLast > obv20
  let pts = 0
  const bits: string[] = []
  if (todayRatio >= 3) { pts++; bits.push(`vol ${todayRatio.toFixed(1)}×`) }
  else if (todayRatio >= 1.5) { pts++; bits.push(`vol ${todayRatio.toFixed(1)}× rising`) }
  if (upVol > downVol * 1.2) { pts++; bits.push(`up-vol > down-vol (${(upVol / Math.max(1, downVol)).toFixed(1)}×)`) }
  if (obvRising) { pts++; bits.push('OBV trending up') }
  // Penalty: rising price on falling vol
  const ret5 = candles.length >= 6 ? (last.close - candles[candles.length - 6].close) / candles[candles.length - 6].close : 0
  if (ret5 > 0.02 && todayRatio < 0.8) pts = Math.max(0, pts - 1)
  return { score: Math.min(3, pts), reason: bits.join(' · ') || 'volume neutral' }
}

// ── Signal 3: Technical Pattern (compose existing screeners) ──
function scorePattern(candles: Candle[], symbol: string): SignalBreakdown {
  const hits: string[] = []
  let darvasHit = false
  for (const scr of ADVANCED_PREMOVE_SCREENERS) {
    try {
      const r = scr.scan(candles, symbol)
      if (r) {
        hits.push(scr.name)
        if (scr.id === 'darvas_box') darvasHit = true
      }
    } catch { /* skip */ }
  }
  let pts = 0
  if (darvasHit) pts = 3
  else if (hits.length >= 2) pts = 2
  else if (hits.length === 1) pts = 1
  return { score: pts, reason: hits.slice(0, 3).join(', ') || 'no pattern' }
}

// ── Signal 4: Fundamentals ──
async function scoreFundamentals(symbol: string): Promise<SignalBreakdown> {
  try {
    const f = await getFundamentals(symbol)
    if (!f) return { score: 0, reason: 'no fundamentals' }
    let pts = 0
    const bits: string[] = []
    const sg = (f as any).salesGrowth1y ?? (f as any).salesGrowth ?? 0
    const pg = (f as any).profitGrowth1y ?? (f as any).profitGrowth ?? 0
    const roe = (f as any).roe ?? 0
    const de = (f as any).debtToEquity ?? (f as any).de ?? 0
    if (sg >= 20) { pts++; bits.push(`sales ↑${sg}%`) }
    if (pg >= 25) { pts++; bits.push(`profit ↑${pg}%`) }
    if (roe >= 15) { pts++; bits.push(`RoE ${roe}%`) }
    if (de >= 0 && de < 1) { pts++; bits.push(`D/E ${de}`) }
    return { score: Math.min(3, pts), reason: bits.join(' · ') || 'fundamentals weak' }
  } catch { return { score: 0, reason: 'fetch error' } }
}

// ── Signal 5: News & Catalyst (PARTIAL — no NLP scraper yet, scores 0 by default) ──
// Will be upgraded when announcement-NLP is built. For now we score
// 1 point if the stock is in an earnings window (placeholder hook).
function scoreNews(_symbol: string, _candles: Candle[]): SignalBreakdown {
  // TODO: integrate corporate-announcement scraper.
  return { score: 0, reason: 'news engine not yet built (placeholder)' }
}

// ── Signal 6: Sector Momentum (uses live sector-rotation snapshot) ──
function scoreSector(symbol: string): SignalBreakdown {
  const snap = getLatestSectorRotation()
  if (!snap) return { score: 0, reason: 'no sector data' }
  // Find which basket contains this symbol
  const basket = SECTOR_BASKETS.find(b => b.members.includes(symbol.toUpperCase()))
  if (!basket) return { score: 1, reason: 'no sector mapped' }
  const reading = snap.baskets.find((r: any) => r.key === basket.key)
  if (!reading) return { score: 1, reason: `${basket.label}: no reading` }
  // Rank sector by relStr20d
  const ranked = snap.baskets.slice().sort((a: any, b: any) => b.relStr20d - a.relStr20d)
  const rank = ranked.findIndex((r: any) => r.key === reading.key) + 1
  let pts = 0
  if (reading.rotatingIn && rank <= 2) pts = 3
  else if (reading.rotatingIn && rank <= 5) pts = 2
  else if (!reading.rotatingOut) pts = 1
  else pts = 0
  return { score: pts, reason: `${basket.label} #${rank} rs20d ${reading.relStr20d > 0 ? '+' : ''}${reading.relStr20d.toFixed(1)}%` }
}

// ── Signal 7: Pump & Dump Filter ──
// All five tests from the master prompt — full pass = 3, 1-2 flags = 1, ≥3 flags = REJECT.
async function scorePumpDump(symbol: string, candles: Candle[]): Promise<SignalBreakdown> {
  let flags = 0
  const flagDetails: string[] = []
  // Test 1: extreme price history
  if (candles.length >= 63) {
    const px3m = candles[candles.length - 63].close
    const ret3m = (candles[candles.length - 1].close - px3m) / px3m * 100
    if (ret3m > 100) { flags++; flagDetails.push(`+${ret3m.toFixed(0)}% in 3m`) }
  }
  // Test 2: circuit-hitting pattern (5%+ moves clustered)
  if (candles.length >= 20) {
    let circuitDays = 0
    for (let i = candles.length - 20; i < candles.length; i++) {
      const ret = (candles[i].close - candles[i - 1].close) / candles[i - 1].close
      if (Math.abs(ret) >= 0.0475) circuitDays++       // near-circuit (allow 0.25% tolerance)
    }
    if (circuitDays >= 4) { flags++; flagDetails.push(`${circuitDays} circuit days/20`) }
  }
  // Test 3: shareholding quality
  try {
    const shp = await getShareholding(symbol)
    if (shp) {
      if (shp.publicPct > 80) { flags++; flagDetails.push(`public ${shp.publicPct}%`) }
      if (shp.promoterDeltaQoQ < -2) { flags++; flagDetails.push(`Promoter ↓${shp.promoterDeltaQoQ.toFixed(1)}%`) }
    }
  } catch { /* skip */ }
  // Test 4: extreme PE (placeholder — fundamentals optional)
  try {
    const f = await getFundamentals(symbol)
    const pe = (f as any)?.pe ?? 0
    if (pe > 200) { flags++; flagDetails.push(`PE ${pe}x`) }
  } catch { /* skip */ }
  // Test 5: bid-ask spread proxy — high recent gap-ups suggest thin book
  if (candles.length >= 5) {
    let gapDays = 0
    for (let i = candles.length - 5; i < candles.length; i++) {
      const prevClose = candles[i - 1].close
      if (candles[i].open > prevClose * 1.05) gapDays++
    }
    if (gapDays >= 3) { flags++; flagDetails.push(`${gapDays} gap-ups/5`) }
  }
  if (flags >= 3) return { score: 0, reason: `REJECT: ${flagDetails.join(', ')}` }
  if (flags >= 1) return { score: 1, reason: `caution: ${flagDetails.join(', ')}` }
  return { score: 3, reason: 'clean' }
}

// ── Signal 8: Entry Timing & Risk (ATR-based plan + structure check) ──
function scoreEntry(candles: Candle[]): { score: SignalBreakdown; plan: { entry: number; sl: number; t1: number; t2: number; t3: number; expMove: number } } {
  const last = candles[candles.length - 1]
  const atr = lastATR(candles, 14) ?? last.close * 0.025
  const e50 = sma(candles, 50)
  const e50v = e50[e50.length - 1]
  // Plan
  const entry = +last.close.toFixed(2)
  const sl = +(Math.min(entry - atr * 1.5, entry * 0.93)).toFixed(2)     // tighter of 1.5×ATR or 7%
  const t1 = +(entry + atr * 2).toFixed(2)
  const t2 = +(entry + atr * 4).toFixed(2)
  const t3 = +(entry + atr * 7).toFixed(2)
  const expMove = ((t2 - entry) / entry) * 100
  // Scoring: structure + R:R
  let pts = 0
  const bits: string[] = []
  const rr = (t1 - entry) / Math.max(0.01, entry - sl)
  if (rr >= 2) { pts++; bits.push(`R:R 1:${rr.toFixed(1)}`) }
  if (e50v && entry > e50v) { pts++; bits.push('above 50EMA') }
  // Avoid stocks at extreme — RSI overbought
  const rsi = lastRSI(candles, 14) ?? 50
  if (rsi < 70) { pts++; bits.push(`RSI ${rsi.toFixed(0)}`) }
  return {
    score: { score: Math.min(3, pts), reason: bits.join(' · ') },
    plan: { entry, sl, t1, t2, t3, expMove },
  }
}

// ── Composite scorer ──
async function evaluateOne(symbol: string, candles: Candle[]): Promise<PreMoveCandidate | null> {
  if (candles.length < 60) return null
  const last = candles[candles.length - 1]

  // Quality filter — hard rejection
  const qf = await checkQualityFilter(symbol, candles)
  if (!qf.ok) {
    return {
      symbol, ltp: +last.close.toFixed(2),
      s1_institutional: { score: 0, reason: '—' },
      s2_volume: { score: 0, reason: '—' },
      s3_pattern: { score: 0, reason: '—' },
      s4_fundamentals: { score: 0, reason: '—' },
      s5_news: { score: 0, reason: '—' },
      s6_sector: { score: 0, reason: '—' },
      s7_pumpDump: { score: 0, reason: '—' },
      s8_entryTiming: { score: 0, reason: '—' },
      totalScore: 0, tier: 4, tierLabel: '🔴 AVOID',
      passedQualityFilter: false, qualityRejectReason: qf.reason,
      entry: last.close, stopLoss: 0, target1: 0, target2: 0, target3: 0,
      riskPct: 0, rewardPct: 0, riskReward: 0, expectedMovePct: 0,
      primarySignal: `Quality filter: ${qf.reason}`,
      detectedAt: new Date().toISOString(),
    }
  }

  const [s1, s4, s7] = await Promise.all([
    scoreInstitutional(symbol),
    scoreFundamentals(symbol),
    scorePumpDump(symbol, candles),
  ])

  // Pump-dump REJECT override
  if (s7.score === 0) return null    // hard reject — don't emit

  const s2 = scoreVolume(candles)
  const s3 = scorePattern(candles, symbol)
  const s5 = scoreNews(symbol, candles)
  const s6 = scoreSector(symbol)
  const { score: s8, plan } = scoreEntry(candles)

  const totalScore = s1.score + s2.score + s3.score + s4.score + s5.score + s6.score + s7.score + s8.score

  // Tier classification — adjusted because s5_news is 0 by default (max realistic = 21)
  let tier: 1 | 2 | 3 | 4
  let tierLabel: string
  if (totalScore >= 16) { tier = 1; tierLabel = '🟢 BUY ALERT' }
  else if (totalScore >= 12) { tier = 2; tierLabel = '🟡 WATCHLIST' }
  else if (totalScore >= 8) { tier = 3; tierLabel = '🟠 MONITOR' }
  else { tier = 4; tierLabel = '🔴 AVOID' }

  // Primary signal — highest-scoring of pattern/volume/institutional
  const primarySignal = s3.score >= 2 ? s3.reason :
                        s2.score >= 2 ? `Volume — ${s2.reason}` :
                        s1.score >= 2 ? `Institutional — ${s1.reason}` :
                        s6.score >= 2 ? `Sector — ${s6.reason}` : 'mixed'

  // Shareholding note (for UI parity with Weekly Pick)
  let shareholdingNote: string | undefined
  try {
    const shp = await getShareholding(symbol)
    if (shp) {
      const fA = shp.fiiDeltaQoQ > 0.1 ? '↑' : shp.fiiDeltaQoQ < -0.1 ? '↓' : '→'
      const pA = shp.promoterDeltaQoQ > 0.1 ? '↑' : shp.promoterDeltaQoQ < -0.1 ? '↓' : '→'
      const dA = shp.diiDeltaQoQ > 0.1 ? '↑' : shp.diiDeltaQoQ < -0.1 ? '↓' : '→'
      const mc = shp.marketCapCr >= 1000
        ? `${(shp.marketCapCr / 1000).toFixed(1)}KCr`
        : shp.marketCapCr > 0 ? `${shp.marketCapCr.toFixed(0)}Cr` : '?'
      shareholdingNote = `FII ${shp.fiiPct.toFixed(1)}%${fA} · DII ${shp.diiPct.toFixed(1)}%${dA} · P ${shp.promoterPct.toFixed(1)}%${pA} · Pledge ${shp.promoterPledgePct.toFixed(1)}% · MC ₹${mc}`
    }
  } catch { /* skip */ }

  const riskPct = +(((plan.entry - plan.sl) / plan.entry) * 100).toFixed(2)
  const rewardPct = +(((plan.t1 - plan.entry) / plan.entry) * 100).toFixed(2)
  const rr = riskPct > 0 ? +(rewardPct / riskPct).toFixed(2) : 0

  return {
    symbol, ltp: +last.close.toFixed(2),
    s1_institutional: s1, s2_volume: s2, s3_pattern: s3, s4_fundamentals: s4,
    s5_news: s5, s6_sector: s6, s7_pumpDump: s7, s8_entryTiming: s8,
    totalScore, tier, tierLabel,
    passedQualityFilter: true,
    entry: plan.entry, stopLoss: plan.sl,
    target1: plan.t1, target2: plan.t2, target3: plan.t3,
    riskPct, rewardPct, riskReward: rr,
    expectedMovePct: +plan.expMove.toFixed(1),
    primarySignal,
    shareholdingNote,
    detectedAt: new Date().toISOString(),
  }
}

// ── Top-level runner ──
export async function runPreMoveIdentifier(opts: { universe?: string; sample?: number; topN?: number } = {}): Promise<PreMoveRun> {
  const t0 = Date.now()
  const universeKey = opts.universe ?? 'NIFTY500'
  const sample = opts.sample ?? 500
  const topN = opts.topN ?? 25
  await fs.mkdir(LEARNING_DIR, { recursive: true }).catch(() => {})

  // Ensure we have a sector snapshot. If stale, refresh.
  if (!getLatestSectorRotation()) {
    try { await runSectorRotationScan() } catch { /* skip */ }
  }

  // Resolve universe
  const all = await resolveUniverse(universeKey).catch(() => [] as string[])
  const universe = all.slice(0, sample)
  log.info('PRE-MOVE', `Scanning ${universe.length} symbols (${universeKey})...`)

  const candidates: PreMoveCandidate[] = []
  let qualityPassed = 0
  let cursor = 0
  const concurrency = 5
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      try {
        const candles = await data.getCandles(sym, '1D', 150).catch(() => [] as Candle[])
        if (candles.length < 60) continue
        const c = await evaluateOne(sym, candles)
        if (!c) continue                            // pump-dump reject
        if (c.passedQualityFilter) qualityPassed++
        candidates.push(c)
      } catch { /* skip */ }
    }
  }))

  candidates.sort((a, b) => b.totalScore - a.totalScore)
  const top = candidates.filter(c => c.passedQualityFilter && c.tier <= 3).slice(0, topN)
  const tier1 = top.filter(c => c.tier === 1).length
  const tier2 = top.filter(c => c.tier === 2).length
  const tier3 = top.filter(c => c.tier === 3).length

  const notes = [
    `Universe: ${universeKey} (${universe.length} sampled of ${all.length} total)`,
    `Quality filter passed: ${qualityPassed} · Pump-dump rejected: ${candidates.length === 0 ? 0 : (universe.length - candidates.length - (universe.length - qualityPassed))}`,
    `Tier 1 buy-alerts: ${tier1} · Tier 2 watchlist: ${tier2} · Tier 3 monitor: ${tier3}`,
    `Note: signal 5 (news/catalyst) scores 0 by default — full NLP integration pending.`,
    `Runtime: ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  ]

  const run: PreMoveRun = {
    generatedAt: new Date().toISOString(),
    universeSize: universe.length,
    evaluated: candidates.length,
    qualityPassed,
    candidates: top,
    tier1Count: tier1, tier2Count: tier2, tier3Count: tier3,
    notes,
  }
  await fs.writeFile(SNAP_FILE, JSON.stringify(run, null, 2)).catch(() => {})
  log.ok('PRE-MOVE', `Done. Tier1=${tier1} Tier2=${tier2} Tier3=${tier3} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return run
}

export async function getLatestPreMoveRun(): Promise<PreMoveRun | null> {
  try {
    const raw = await fs.readFile(SNAP_FILE, 'utf8')
    return JSON.parse(raw) as PreMoveRun
  } catch { return null }
}
