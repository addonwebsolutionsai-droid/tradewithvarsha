/**
 * Elliott Wave engine · minimal heuristic scanner.
 *
 * Not a rigorous Neely count — a pragmatic 3-detector scanner that catches
 * the setups Elliott traders actually put money on:
 *
 *   1. WAVE_2_PULLBACK  — a fresh Wave-1 has retraced 0.5-0.618 to prior
 *                          swing low. Buy the pullback; target = Wave-3
 *                          extension (typically 1.618× Wave-1).
 *   2. WAVE_3_UNDERWAY  — price broke above prior swing high with volume
 *                          expansion, in-progress Wave-3. Trail SL, take
 *                          T1 at 1.0×, T2 at 1.618×, T3 at 2.618× of W1.
 *   3. ABC_COMPLETION   — three-leg corrective (down-up-down or up-down-up)
 *                          with C leg ≈ A leg length. Fade the completion,
 *                          expect trend resumption.
 *
 * The engine emits rows in the same shape every other engine produces —
 * symbol · direction · entry · SL · T1/T2/T3 with dated targets — so the
 * existing UI + Telegram + target-date enrichment all Just Work.
 */

import fs from 'fs'
import path from 'path'
import { getCandles } from '../data/index'
import { log } from '../util/logger'
import type { Candle } from '../types'

// ─── Types ────────────────────────────────────────────────────────────

export type WaveSetup = 'WAVE_2_PULLBACK' | 'WAVE_3_UNDERWAY' | 'ABC_COMPLETION'

export interface WaveHit {
  symbol: string
  timeframe: '1D'
  setup: WaveSetup
  direction: 'BUY' | 'SHORT'
  wavePosition: string        // human-readable, e.g. 'Wave 2 low · 61.8% retrace of Wave 1'
  score: number               // 0-100
  ltp: number
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  entryDate: string
  target1Date: string
  target2Date: string
  target3Date: string
  wave1High: number
  wave1Low: number
  wave2Level: number
  wave1PctMove: number
  retracePct: number
  reasons: string[]
  reasoning: string[]
}

interface Pivot { idx: number; price: number; kind: 'HIGH' | 'LOW'; time: number }

// ─── Pivot detection ─────────────────────────────────────────────────

function detectPivots(candles: Candle[], lookback = 5): Pivot[] {
  const out: Pivot[] = []
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]
    let isHigh = true, isLow = true
    for (let k = 1; k <= lookback; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high >= c.high) isHigh = false
      if (candles[i - k].low <= c.low || candles[i + k].low <= c.low) isLow = false
    }
    if (isHigh) out.push({ idx: i, price: c.high, kind: 'HIGH', time: c.time })
    else if (isLow) out.push({ idx: i, price: c.low, kind: 'LOW', time: c.time })
  }
  return out
}

// ─── Setup detectors ─────────────────────────────────────────────────

function detectWave2Pullback(candles: Candle[], pivots: Pivot[]): WaveHit | null {
  if (pivots.length < 3) return null
  const last = pivots[pivots.length - 1]
  const prev = pivots[pivots.length - 2]
  const prev2 = pivots[pivots.length - 3]

  // Bullish Wave 2: LOW-HIGH-LOW-currentPrice, current near 50-61.8% retrace
  if (prev2.kind === 'LOW' && prev.kind === 'HIGH' && last.kind === 'LOW') {
    const w1Low = prev2.price, w1High = prev.price
    const w1Range = w1High - w1Low
    if (w1Range <= 0 || w1Low <= 0) return null
    const w1Pct = (w1Range / w1Low) * 100
    if (w1Pct < 4) return null                       // Wave 1 must be meaningful
    if (w1Pct > 40) return null                      // Too extended
    const retrace = (w1High - last.price) / w1Range
    if (retrace < 0.35 || retrace > 0.75) return null // Sweet spot 50-61.8%

    const entry = candles[candles.length - 1].close
    if (entry < last.price * 0.98 || entry > last.price * 1.06) return null
    const sl = last.price * 0.985                    // just below Wave-2 low
    const t1 = w1High                                // return to Wave-1 high
    const t2 = w1Low + w1Range * 1.618               // Wave-3 typical extension
    const t3 = w1Low + w1Range * 2.618               // aggressive Wave-3

    const score = Math.min(100, Math.round(50 + w1Pct * 1.2 + (retrace >= 0.5 && retrace <= 0.65 ? 15 : 0)))
    return {
      symbol: '', timeframe: '1D',
      setup: 'WAVE_2_PULLBACK', direction: 'BUY',
      wavePosition: `Wave-2 low · ${(retrace * 100).toFixed(0)}% retrace of Wave-1 (₹${w1Low.toFixed(2)} → ₹${w1High.toFixed(2)})`,
      score,
      ltp: entry,
      entry, stopLoss: Math.round(sl * 100) / 100,
      target1: Math.round(t1 * 100) / 100,
      target2: Math.round(t2 * 100) / 100,
      target3: Math.round(t3 * 100) / 100,
      entryDate: '', target1Date: '', target2Date: '', target3Date: '',
      wave1High: w1High, wave1Low: w1Low,
      wave2Level: last.price,
      wave1PctMove: Math.round(w1Pct * 10) / 10,
      retracePct: Math.round(retrace * 1000) / 10,
      reasons: [
        `Wave-1 impulse +${w1Pct.toFixed(1)}%`,
        `Wave-2 pullback landed at ${(retrace * 100).toFixed(0)}% retrace (Fib zone)`,
        `Target T1=Wave-1 high, T2=1.618× extension, T3=2.618× extension`,
      ],
      reasoning: [
        `Wave-2 pullback setup · Wave 1 was +${w1Pct.toFixed(1)}% then retraced ${(retrace * 100).toFixed(0)}% — classic Fib zone`,
        `Wave-3 typically the strongest; target 1.618× Wave-1 extension`,
      ],
    }
  }
  return null
}

function detectWave3Underway(candles: Candle[], pivots: Pivot[]): WaveHit | null {
  if (pivots.length < 3 || candles.length < 30) return null
  const last = pivots[pivots.length - 1]
  const prev = pivots[pivots.length - 2]
  const prev2 = pivots[pivots.length - 3]

  // Bullish Wave 3: LOW-HIGH-LOW · price above prev HIGH with volume expansion
  if (prev2.kind === 'LOW' && prev.kind === 'HIGH' && last.kind === 'LOW') {
    const w1Low = prev2.price, w1High = prev.price, w2Low = last.price
    const w1Range = w1High - w1Low
    if (w1Range <= 0) return null
    const spot = candles[candles.length - 1].close
    if (spot < w1High * 1.005) return null           // must have broken Wave-1 high
    if (spot > w1High * 1.15) return null            // and not too extended past it

    const recentVol = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5
    const baseVol = candles.slice(-30, -5).reduce((s, c) => s + c.volume, 0) / 25
    if (baseVol <= 0 || recentVol < baseVol * 1.15) return null    // volume expansion required

    const entry = spot
    const sl = w2Low * 1.005                          // Wave-2 low invalidates
    const t1 = w1Low + w1Range * 1.618
    const t2 = w1Low + w1Range * 2.0
    const t3 = w1Low + w1Range * 2.618
    if (t1 <= entry) return null                      // targets must be above entry

    const w1Pct = (w1Range / w1Low) * 100
    const score = Math.min(100, Math.round(60 + w1Pct + (recentVol / baseVol - 1) * 30))
    return {
      symbol: '', timeframe: '1D',
      setup: 'WAVE_3_UNDERWAY', direction: 'BUY',
      wavePosition: `Wave-3 impulse · broke above Wave-1 high ₹${w1High.toFixed(2)} with volume ${(recentVol / baseVol).toFixed(1)}×`,
      score,
      ltp: spot,
      entry, stopLoss: Math.round(sl * 100) / 100,
      target1: Math.round(t1 * 100) / 100,
      target2: Math.round(t2 * 100) / 100,
      target3: Math.round(t3 * 100) / 100,
      entryDate: '', target1Date: '', target2Date: '', target3Date: '',
      wave1High: w1High, wave1Low: w1Low, wave2Level: w2Low,
      wave1PctMove: Math.round(w1Pct * 10) / 10,
      retracePct: 0,
      reasons: [
        `Wave-3 breakout · above Wave-1 high ${w1High.toFixed(2)}`,
        `Volume ${(recentVol / baseVol).toFixed(1)}× 25-day base`,
        `Fib extensions: T1=1.618× · T2=2.0× · T3=2.618×`,
      ],
      reasoning: [
        `Wave-3 impulse underway · broke prior swing high ${w1High.toFixed(2)} with ${(recentVol / baseVol).toFixed(1)}× volume`,
        `Fib extensions target 1.618× / 2.0× / 2.618× of Wave-1 range`,
      ],
    }
  }
  return null
}

function detectABCCompletion(candles: Candle[], pivots: Pivot[]): WaveHit | null {
  if (pivots.length < 4 || candles.length < 30) return null
  const last = pivots[pivots.length - 1]
  const c = pivots[pivots.length - 2]
  const b = pivots[pivots.length - 3]
  const a = pivots[pivots.length - 4]

  // Bullish ABC (down-up-down) → expect uptrend resumption
  //   a HIGH · b LOW · c HIGH · last LOW ~= b or below
  if (a.kind === 'HIGH' && b.kind === 'LOW' && c.kind === 'HIGH' && last.kind === 'LOW') {
    const aLeg = a.price - b.price
    const cLeg = c.price - last.price
    if (aLeg <= 0 || cLeg <= 0) return null
    const legRatio = cLeg / aLeg
    if (legRatio < 0.8 || legRatio > 1.3) return null   // ABC legs roughly equal
    if (last.price > b.price * 1.05) return null        // must revisit near-B territory

    const entry = candles[candles.length - 1].close
    if (entry < last.price * 0.99 || entry > last.price * 1.06) return null
    const sl = last.price * 0.98
    // Wave targets: recover to A + fresh impulse
    const t1 = c.price
    const t2 = a.price
    const t3 = a.price + (a.price - b.price) * 0.618
    const score = Math.min(100, Math.round(55 + legRatio * 20 + 10))
    return {
      symbol: '', timeframe: '1D',
      setup: 'ABC_COMPLETION', direction: 'BUY',
      wavePosition: `ABC correction complete · C leg = ${(legRatio * 100).toFixed(0)}% of A leg`,
      score,
      ltp: entry,
      entry, stopLoss: Math.round(sl * 100) / 100,
      target1: Math.round(t1 * 100) / 100,
      target2: Math.round(t2 * 100) / 100,
      target3: Math.round(t3 * 100) / 100,
      entryDate: '', target1Date: '', target2Date: '', target3Date: '',
      wave1High: a.price, wave1Low: b.price,
      wave2Level: last.price,
      wave1PctMove: 0, retracePct: 0,
      reasons: [
        `ABC corrective complete · C=${(legRatio * 100).toFixed(0)}% of A`,
        `Uptrend resumption expected · target recovery to A`,
      ],
      reasoning: [
        `Corrective ABC complete · C leg ≈ A leg (${(legRatio * 100).toFixed(0)}%)`,
        `Trend-resumption target: T1=C high, T2=A high, T3=A + 0.618× impulse`,
      ],
    }
  }
  return null
}

// ─── Per-symbol scan ─────────────────────────────────────────────────

async function scanSymbol(symbol: string): Promise<WaveHit | null> {
  try {
    const candles = await getCandles(symbol, '1D', 200)
    if (candles.length < 50) return null
    const pivots = detectPivots(candles, 5)
    if (pivots.length < 3) return null
    const spot = candles[candles.length - 1].close
    if (spot < 30) return null                        // skip pennies

    // Detectors run in order; the first hit wins (setups are mutually exclusive
    // in nature — you'd never see Wave-2 AND Wave-3 on the same day).
    const hits = [
      detectWave3Underway(candles, pivots),
      detectWave2Pullback(candles, pivots),
      detectABCCompletion(candles, pivots),
    ]
    const hit = hits.find(h => h != null)
    if (!hit) return null
    hit.symbol = symbol
    return hit
  } catch { return null }
}

// ─── Full scan ───────────────────────────────────────────────────────

export async function runElliottWaveScan(opts: { universe?: string[]; concurrency?: number } = {}): Promise<WaveHit[]> {
  const universe = opts.universe && opts.universe.length > 0
    ? opts.universe
    : await resolveNifty500Universe()
  if (universe.length === 0) {
    log.warn('ELLIOTT', 'no universe symbols')
    return []
  }
  log.info('ELLIOTT', `scanning ${universe.length} symbols on daily`)

  const concurrency = opts.concurrency ?? 8
  const hits: WaveHit[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      const hit = await scanSymbol(sym)
      if (hit) hits.push(hit)
    }
  }))
  hits.sort((a, b) => b.score - a.score)
  log.ok('ELLIOTT', `${hits.length} wave setups found`)
  return hits
}

async function resolveNifty500Universe(): Promise<string[]> {
  try {
    const angel = await import('../data/angel')
    const sm = await angel.loadScripMaster()
    if (!sm) return []
    const isNfoStock = new Set(sm.filter(s => s.exch_seg === 'NFO' && s.instrumenttype === 'FUTSTK').map(s => s.name))
    return Array.from(isNfoStock).filter(n => !!n && !/NSETEST/i.test(n)).sort()
  } catch { return [] }
}

export async function runAndPublishElliottWave(): Promise<{ ok: boolean; total: number; byType: Record<string, number> }> {
  const hits = await runElliottWaveScan()
  const mapped = hits.slice(0, 200).map(h => ({
    symbol: h.symbol,
    direction: h.direction,
    conviction: h.score,
    score: h.score,
    ltp: h.ltp,
    entry: h.entry,
    stopLoss: h.stopLoss,
    target1: h.target1,
    target2: h.target2,
    target3: h.target3,
    entryDate: h.entryDate,
    target1Date: h.target1Date,
    target2Date: h.target2Date,
    target3Date: h.target3Date,
    pattern: h.setup.replace(/_/g, ' '),
    setup: h.setup,
    source: 'ELLIOTT',
    reasons: h.reasons,
    reasoning: h.reasoning,
    wavePosition: h.wavePosition,
    wave1PctMove: h.wave1PctMove,
    retracePct: h.retracePct,
  }))
  const { enrichRows } = await import('../lib/reasonEnrichment')
  const { enrichRowsDates } = await import('../lib/targetDateEnrichment')
  const enriched = enrichRowsDates(
    enrichRows(mapped as unknown as Array<Record<string, unknown>>, 'chartPattern'),
    'chartPattern',
  )
  const byType: Record<string, number> = {}
  for (const h of hits) byType[h.setup] = (byType[h.setup] ?? 0) + 1

  const outPath = path.resolve(__dirname, '../../data/public-snapshots/elliott-wave.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    criterion: 'Elliott Wave heuristic scanner · pivot-based Wave-2/Wave-3/ABC detectors with Fib-extension targets',
    total: enriched.length,
    byType,
    rows: enriched,
  }, null, 2))
  log.ok('ELLIOTT-SNAP', `Published: ${enriched.length} wave setups (${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')})`)
  return { ok: true, total: enriched.length, byType }
}
