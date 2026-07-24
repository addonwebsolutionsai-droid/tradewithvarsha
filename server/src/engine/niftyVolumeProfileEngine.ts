/**
 * NIFTY Volume-Profile signal engine — the setup that caught the user's
 * 15-Jul-2026 24200 PE trade (165 → 300+).
 *
 * Runs the Volume Profile detector across MULTIPLE timeframes (5m, 15m,
 * 30m, 45m, 1h, 2h, 4h, 1D) and emits a signal only when at least two
 * timeframes agree (mid-TF confluence guards against noise).
 *
 * When a BEARISH signal fires → recommends ATM PE. BULLISH → ATM CE.
 * All entry/SL/T1/T2/T3 with dated fields per money-printing standing
 * instruction. NIFTY-only per user directive.
 */

import fs from 'fs'
import path from 'path'
import { getCandles } from '../data/index'
import { buildVolumeProfile, detectSetups } from './volumeProfile'
import type { VolumeProfile, VpSignal } from './volumeProfile'
import type { Candle, Timeframe } from '../types'
import { log } from '../util/logger'

// Timeframes we scan. Note: 45m/2h/4h aren't standard Angel timeframes so we
// synthesize them from 15m/30m/1h candles by resampling.
const TFS: Array<{ key: string; source: Timeframe; resampleTo?: number }> = [
  { key: '5m',  source: '5m' },
  { key: '15m', source: '15m' },
  { key: '30m', source: '30m' },
  { key: '45m', source: '15m', resampleTo: 45 },   // 3 × 15m
  { key: '1h',  source: '1h' },
  { key: '2h',  source: '1h', resampleTo: 120 },
  { key: '4h',  source: '1h', resampleTo: 240 },
  { key: '1D',  source: '1D' },
]

function resample(candles: Candle[], targetMinutes: number, sourceMinutes: number): Candle[] {
  const factor = Math.round(targetMinutes / sourceMinutes)
  if (factor <= 1) return candles
  const out: Candle[] = []
  for (let i = 0; i < candles.length; i += factor) {
    const chunk = candles.slice(i, i + factor)
    if (chunk.length === 0) continue
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    })
  }
  return out
}

function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  const last = trs.slice(-period)
  return last.reduce((s, v) => s + v, 0) / last.length
}

function istDateStr(ms: number): string {
  const d = new Date(ms + 5.5 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function addBusinessDays(fromMs: number, n: number): string {
  let d = new Date(fromMs)
  let added = 0
  while (added < n) {
    d = new Date(d.getTime() + 86_400_000)
    const day = d.getDay()
    if (day !== 0 && day !== 6) added++
  }
  return istDateStr(d.getTime())
}

export interface TimeframeSetup {
  tf: string
  profile: {
    poc: number
    vah: number
    val: number
    hvn: number[]
    lvn: number[]
    ibH: number
    ibL: number
    totalVolume: number
  }
  signals: VpSignal[]
}

export interface NiftyVpForecast {
  generatedAt: string
  spot: number
  compositeBias: 'BULLISH' | 'BEARISH' | 'MIXED' | 'NEUTRAL'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  bullTfCount: number
  bearTfCount: number
  agreementScore: number    // 0-100
  timeframes: TimeframeSetup[]
  strongestSetup: {
    tf: string
    setup: string
    side: 'BULLISH' | 'BEARISH'
    strength: number
    reason: string
    entry: number
    stopLoss: number
    target1: number
    target2: number
    target3: number
    keyLevel: number
  } | null
  tradeRecommendation: {
    side: 'BUY' | 'SELL' | 'WAIT'
    instrument: string
    optionStrike: number
    optionType: 'CE' | 'PE' | null
    entry: number
    stopLoss: number
    target1: number
    target2: number
    target3: number
    entryDate: string
    target1Date: string
    target2Date: string
    target3Date: string
    slDate: string
    rationale: string
  }
}

export async function runNiftyVolumeProfile(): Promise<NiftyVpForecast | null> {
  const timeframes: TimeframeSetup[] = []
  let latestSpot = 0

  for (const tf of TFS) {
    try {
      // 'NIFTY' is the canonical key in the SYMBOLS map — resolves to
      // Yahoo ^NSEI. Using the literal string 'NIFTY 50' (previous value)
      // fell through the map and Yahoo returned 404 for "NIFTY 50.NS".
      let candles = await getCandles('NIFTY', tf.source, 250)
      if (candles.length < 10) continue
      const srcMin = tf.source === '5m' ? 5 : tf.source === '15m' ? 15 : tf.source === '30m' ? 30 : tf.source === '1h' ? 60 : tf.source === '1D' ? 1440 : 15
      if (tf.resampleTo) candles = resample(candles, tf.resampleTo, srcMin)
      if (candles.length < 8) continue

      const profile = buildVolumeProfile(candles, 50, tf.key)
      if (!profile) continue

      const ar = atr(candles)
      const signals = detectSetups(profile, candles.slice(-6), ar)

      latestSpot = candles[candles.length - 1].close
      timeframes.push({
        tf: tf.key,
        profile: {
          poc: profile.poc,
          vah: profile.vah,
          val: profile.val,
          hvn: profile.hvn,
          lvn: profile.lvn,
          ibH: profile.initialBalanceHigh,
          ibL: profile.initialBalanceLow,
          totalVolume: profile.totalVolume,
        },
        signals,
      })
    } catch (e) {
      log.warn('NIFTY-VP', `${tf.key}: ${(e as Error).message}`)
    }
  }

  if (timeframes.length === 0) return null

  // ── Composite bias across timeframes: majority of TFs with a fired signal wins.
  let bullTfCount = 0
  let bearTfCount = 0
  let strongestSetup: NiftyVpForecast['strongestSetup'] = null
  for (const t of timeframes) {
    let tfBull = 0
    let tfBear = 0
    for (const s of t.signals) {
      if (s.side === 'BULLISH') tfBull += s.strength
      else tfBear += s.strength
      if (!strongestSetup || s.strength > strongestSetup.strength) {
        strongestSetup = {
          tf: t.tf,
          setup: s.setup,
          side: s.side,
          strength: s.strength,
          reason: s.reason,
          entry: s.entry,
          stopLoss: s.stopLoss,
          target1: s.target1,
          target2: s.target2,
          target3: s.target3,
          keyLevel: s.keyLevel,
        }
      }
    }
    if (tfBull > tfBear && tfBull > 0) bullTfCount++
    else if (tfBear > tfBull && tfBear > 0) bearTfCount++
  }

  let compositeBias: 'BULLISH' | 'BEARISH' | 'MIXED' | 'NEUTRAL' = 'NEUTRAL'
  if (bullTfCount >= 2 && bullTfCount > bearTfCount) compositeBias = 'BULLISH'
  else if (bearTfCount >= 2 && bearTfCount > bullTfCount) compositeBias = 'BEARISH'
  else if (bullTfCount > 0 && bearTfCount > 0) compositeBias = 'MIXED'

  const scoredTfs = timeframes.length
  const dominant = Math.max(bullTfCount, bearTfCount)
  const agreementScore = scoredTfs > 0 ? Math.round((dominant / scoredTfs) * 100) : 0

  let confidence: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW'
  if (agreementScore >= 70 && dominant >= 3) confidence = 'HIGH'
  else if (agreementScore >= 50 && dominant >= 2) confidence = 'MEDIUM'

  // ── Trade recommendation
  const now = Date.now()
  const strikeGap = 50
  const atmStrike = Math.round(latestSpot / strikeGap) * strikeGap
  let side: 'BUY' | 'SELL' | 'WAIT' = 'WAIT'
  let optionType: 'CE' | 'PE' | null = null
  let entry = latestSpot, sl = latestSpot, t1 = latestSpot, t2 = latestSpot, t3 = latestSpot
  let rationale = 'No decisive Volume Profile setup — wait for cleaner rejection or breakout.'
  let optionStrike = atmStrike

  if (strongestSetup && confidence !== 'LOW') {
    entry = strongestSetup.entry
    sl = strongestSetup.stopLoss
    t1 = strongestSetup.target1
    t2 = strongestSetup.target2
    t3 = strongestSetup.target3
    if (compositeBias === 'BEARISH' || (compositeBias === 'MIXED' && strongestSetup.side === 'BEARISH')) {
      side = 'BUY'    // buy PE
      optionType = 'PE'
      optionStrike = atmStrike
      rationale = `${confidence} confidence · ${strongestSetup.tf} ${strongestSetup.setup} · ${bearTfCount}/${scoredTfs} TFs bearish · ${strongestSetup.reason}`
    } else if (compositeBias === 'BULLISH' || (compositeBias === 'MIXED' && strongestSetup.side === 'BULLISH')) {
      side = 'BUY'    // buy CE
      optionType = 'CE'
      optionStrike = atmStrike
      rationale = `${confidence} confidence · ${strongestSetup.tf} ${strongestSetup.setup} · ${bullTfCount}/${scoredTfs} TFs bullish · ${strongestSetup.reason}`
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    spot: latestSpot,
    compositeBias,
    confidence,
    bullTfCount,
    bearTfCount,
    agreementScore,
    timeframes,
    strongestSetup,
    tradeRecommendation: {
      side,
      instrument: optionType
        ? `NIFTY ${atmStrike} ${optionType} (nearest weekly expiry)`
        : 'NIFTY SPOT (reference)',
      optionStrike,
      optionType,
      entry: Math.round(entry * 100) / 100,
      stopLoss: Math.round(sl * 100) / 100,
      target1: Math.round(t1 * 100) / 100,
      target2: Math.round(t2 * 100) / 100,
      target3: Math.round(t3 * 100) / 100,
      entryDate: istDateStr(now),
      target1Date: addBusinessDays(now, 1),
      target2Date: addBusinessDays(now, 2),
      target3Date: addBusinessDays(now, 3),
      slDate: addBusinessDays(now, 3),
      rationale,
    },
  }
}

export async function runAndPublishNiftyVolumeProfile(): Promise<{
  ok: boolean
  bias: string
  confidence: string
  spot: number
  setup: string
}> {
  const snapPath = path.resolve(__dirname, '../../data/public-snapshots/nifty-volume-profile.json')
  fs.mkdirSync(path.dirname(snapPath), { recursive: true })
  const forecast = await runNiftyVolumeProfile()

  // Always write SOMETHING to the snapshot. Previously, when runNiftyVolumeProfile
  // returned null (e.g. Angel isn't logged in on the GH Actions runner and Yahoo
  // 5m/15m NIFTY intraday data isn't available), we skipped the write entirely —
  // the client then 404'd forever with "Couldn't load NIFTY Volume Profile".
  // Now we write an explicit "no data" placeholder so the UI can render a clean
  // "next refresh in ~4 min" message rather than a fetch error.
  if (!forecast) {
    const placeholder = {
      generatedAt: new Date().toISOString(),
      status: 'NO_DATA',
      note: 'NIFTY intraday candles unavailable on this tick. Common causes: Angel session not established on the GH Actions runner, or Yahoo intraday feed empty. Next tick (~4 min during market hours) will retry.',
      spot: 0,
      compositeBias: 'NEUTRAL',
      confidence: 'LOW',
      bullTfCount: 0,
      bearTfCount: 0,
      agreementScore: 0,
      timeframes: [],
      strongestSetup: null,
      tradeRecommendation: null,
    }
    fs.writeFileSync(snapPath, JSON.stringify(placeholder, null, 2))
    return { ok: false, bias: 'NEUTRAL', confidence: 'LOW', spot: 0, setup: '-' }
  }

  fs.writeFileSync(snapPath, JSON.stringify(forecast, null, 2))
  return {
    ok: true,
    bias: forecast.compositeBias,
    confidence: forecast.confidence,
    spot: forecast.spot,
    setup: forecast.strongestSetup?.setup ?? '-',
  }
}
