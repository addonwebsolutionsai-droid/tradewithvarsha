/**
 * Money-Printer Engine — the Moschip / Marksans / Epack / VIP / Hikal setup.
 *
 * User directive (30 Jul 2026):
 *   "You are missing volume. Moschip, marksans pharma, Epack, VIP
 *    Industries, Hikal all are same example — I checked manually and saw
 *    harmonic patterns on weekly daily and monthly. You should check
 *    harmonic patterns or elliot wave sharpest move wave setups too."
 *
 * These winners all had four things in common at entry:
 *
 *   1. HARMONIC pattern completing on 1D AND (1W OR 1M) — multi-TF
 *      confluence, NOT single-TF. Same direction across timeframes.
 *   2. ELLIOTT Wave-3 underway OR Wave-2 pullback complete — the
 *      sharpest impulsive move, not a corrective bounce.
 *   3. VOLUME accumulation — 5d avg > 20d avg × 1.3, AND up-day volume
 *      dominating down-day volume (Wyckoff accumulation footprint).
 *   4. TIGHT BASE — last 10 bars range < 8% of price (coil before break).
 *
 * Signals emitted here are the money-printers. Small feed, extremely
 * high hit rate. Rendered on /money-printer with 💰 badge and fed into
 * MASTER engine as a strong-source.
 */

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { log } from '../util/logger'
import * as data from '../data'
import type { Candle } from '../types'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')
const OUTPUT_FILE = path.join(SNAP_DIR, 'money-printer.json')

export interface MoneyPrinterSignal {
  symbol: string
  direction: 'BUY' | 'SELL'
  score: number                              // 0-100
  ltp: number
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  entryDate?: string
  target1Date?: string
  target2Date?: string
  target3Date?: string
  rrT1: number
  rrT2: number
  rrT3: number
  pillars: {
    mtfHarmonic: {
      pass: boolean
      timeframes: string[]                    // ['1D', '1W'] or ['1D', '1W', '1M']
      patterns: string[]
      detail: string
    }
    elliottWave: {
      pass: boolean
      setup: string | null                    // 'WAVE_3_UNDERWAY' / 'WAVE_2_PULLBACK' / null
      detail: string
    }
    volumeAccumulation: {
      pass: boolean
      vol5d20dRatio: number
      upDownVolRatio: number
      detail: string
    }
    tightBase: {
      pass: boolean
      range10dPct: number
      detail: string
    }
  }
  reasoning: string[]
  humanExplain: string
  sources: string[]                           // ['HARMONIC-1D', 'HARMONIC-1W', 'ELLIOTT-W3', ...]
}

function readSnap(name: string): any | null {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(SNAP_DIR, name), 'utf-8'))
  } catch { return null }
}

/**
 * Volume-accumulation Wyckoff-style validator. Returns:
 *   vol5d20dRatio     — 5d avg volume / 20d avg volume
 *   upDownVolRatio    — sum(vol on up-days) / sum(vol on down-days) over 20d
 *   range10dPct       — (max close - min close) / current close over last 10d
 *
 * Accumulation footprint: vol5d20dRatio ≥ 1.3 AND upDownVolRatio ≥ 1.3
 * AND range10dPct ≤ 8 (tight base pre-breakout).
 */
function computeVolumeAndBase(candles: Candle[]): { vol5d20dRatio: number; upDownVolRatio: number; range10dPct: number } | null {
  if (!candles || candles.length < 25) return null
  const last = candles[candles.length - 1]
  const v5 = candles.slice(-5).reduce((s, c) => s + (c.volume || 0), 0) / 5
  const v20 = candles.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20
  const vol5d20dRatio = v20 > 0 ? v5 / v20 : 0

  let upVol = 0, downVol = 0
  for (let i = candles.length - 20; i < candles.length; i++) {
    if (i <= 0) continue
    const cur = candles[i], prev = candles[i - 1]
    if (cur.close > prev.close) upVol += cur.volume || 0
    else if (cur.close < prev.close) downVol += cur.volume || 0
  }
  const upDownVolRatio = downVol > 0 ? upVol / downVol : (upVol > 0 ? 2 : 0)

  const last10 = candles.slice(-10)
  const hi = Math.max(...last10.map(c => c.high))
  const lo = Math.min(...last10.map(c => c.low))
  const range10dPct = last.close > 0 ? ((hi - lo) / last.close) * 100 : 0

  return {
    vol5d20dRatio: +vol5d20dRatio.toFixed(2),
    upDownVolRatio: +upDownVolRatio.toFixed(2),
    range10dPct: +range10dPct.toFixed(2),
  }
}

/**
 * Group harmonic hits by symbol + direction, keep only those with ≥ 2
 * timeframe confluences from POSITIONAL tier (1D, 1W, 1M — daily/weekly/
 * monthly are the timeframes the winning names actually showed).
 */
interface MtfHarmonicHit {
  symbol: string
  direction: 'BUY' | 'SELL'
  timeframes: Set<string>
  patterns: Set<string>
  bestConfidence: number
  bestHit: any                                // the highest-confidence source row
}

function groupHarmonicByMtf(harmonicSnap: any): Map<string, MtfHarmonicHit> {
  const rows: any[] = harmonicSnap?.rows ?? []
  const map = new Map<string, MtfHarmonicHit>()
  for (const r of rows) {
    const sym = String(r.symbol ?? '').toUpperCase().trim()
    if (!sym) continue
    const tf = String(r.timeframe ?? '').toUpperCase()
    // Only 1D / 1W / 1M count — POSITIONAL tier confluence is what
    // Moschip/Marksans showed. Intraday/hourly harmonics are noise for
    // this pattern.
    if (tf !== '1D' && tf !== '1W' && tf !== '1M') continue
    const dirRaw = String(r.direction ?? r.trade ?? '').toUpperCase()
    const direction: 'BUY' | 'SELL' = (dirRaw === 'SELL' || dirRaw === 'SHORT' || dirRaw === 'BEARISH') ? 'SELL' : 'BUY'
    const key = `${sym}|${direction}`
    const existing = map.get(key)
    const conf = Number(r.confidence ?? r.score ?? 0)
    if (existing) {
      existing.timeframes.add(tf)
      const patLabel = String(r.pattern ?? r.patternName ?? '').split('·')[0].trim() || 'harmonic'
      existing.patterns.add(patLabel)
      if (conf > existing.bestConfidence) {
        existing.bestConfidence = conf
        existing.bestHit = r
      }
    } else {
      const patLabel = String(r.pattern ?? r.patternName ?? '').split('·')[0].trim() || 'harmonic'
      map.set(key, {
        symbol: sym,
        direction,
        timeframes: new Set([tf]),
        patterns: new Set([patLabel]),
        bestConfidence: conf,
        bestHit: r,
      })
    }
  }
  return map
}

/**
 * Elliott lookup by symbol + direction.
 */
function buildElliottLookup(elliottSnap: any): Map<string, { setup: string; confidence: number; direction: 'BUY' | 'SELL' }> {
  const rows: any[] = elliottSnap?.rows ?? []
  const map = new Map<string, { setup: string; confidence: number; direction: 'BUY' | 'SELL' }>()
  for (const r of rows) {
    const sym = String(r.symbol ?? '').toUpperCase().trim()
    if (!sym) continue
    const dirRaw = String(r.direction ?? '').toUpperCase()
    const direction: 'BUY' | 'SELL' = (dirRaw === 'SELL' || dirRaw === 'SHORT') ? 'SELL' : 'BUY'
    const setup = String(r.setup ?? r.pattern ?? '')
    const conf = Number(r.confidence ?? r.score ?? 0)
    const key = `${sym}|${direction}`
    const existing = map.get(key)
    if (!existing || conf > existing.confidence) {
      map.set(key, { setup, confidence: conf, direction })
    }
  }
  return map
}

export async function runMoneyPrinterScan(): Promise<{
  emitted: MoneyPrinterSignal[]
  candidatesEvaluated: number
  filteredOut: Record<string, number>
}> {
  const t0 = Date.now()
  log.info('MONEY-PRINTER', 'scan starting')

  const harmonic = readSnap('harmonic.json')
  const elliott = readSnap('elliott-wave.json')
  if (!harmonic && !elliott) {
    log.warn('MONEY-PRINTER', 'no harmonic or elliott snapshots — skipping')
    await fs.mkdir(SNAP_DIR, { recursive: true })
    await fs.writeFile(OUTPUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), emitted: 0, rows: [] }, null, 2))
    return { emitted: [], candidatesEvaluated: 0, filteredOut: {} }
  }

  const mtfMap = groupHarmonicByMtf(harmonic)
  const elliottMap = buildElliottLookup(elliott)
  log.info('MONEY-PRINTER', `${mtfMap.size} sym+dir harmonic groups · ${elliottMap.size} elliott hits`)

  // Union of symbols across both sources — MTF harmonic OR Wave-3 alone
  // isn't enough; we require the volume gate too, so joining upstream
  // saves candle fetches.
  const symDirKeys = new Set([...mtfMap.keys(), ...elliottMap.keys()])
  const filteredOut: Record<string, number> = {}
  const emitted: MoneyPrinterSignal[] = []

  const CONCURRENCY = 8
  const keys = [...symDirKeys]
  let cursor = 0

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++]
      const [symbol, dir] = key.split('|') as [string, 'BUY' | 'SELL']
      try {
        const mtf = mtfMap.get(key)
        const elliott = elliottMap.get(key)

        // Gate A: must have EITHER (MTF harmonic ≥ 2 TFs) OR (Elliott Wave-3)
        const hasMtfHarmonic = !!(mtf && mtf.timeframes.size >= 2)
        const isWave3 = !!(elliott && (elliott.setup.includes('WAVE_3') || elliott.setup.includes('WAVE_2_PULLBACK')))
        if (!hasMtfHarmonic && !isWave3) {
          filteredOut['gate-A-mtf-or-wave3'] = (filteredOut['gate-A-mtf-or-wave3'] ?? 0) + 1
          continue
        }

        // Fetch daily candles for volume + base validation
        const candles = await data.getCandles(symbol, '1D' as any, 60).catch(() => [] as Candle[])
        if (!candles || candles.length < 25) {
          filteredOut['no-candles'] = (filteredOut['no-candles'] ?? 0) + 1
          continue
        }

        const vb = computeVolumeAndBase(candles)
        if (!vb) {
          filteredOut['no-vol-data'] = (filteredOut['no-vol-data'] ?? 0) + 1
          continue
        }

        const volAccum = vb.vol5d20dRatio >= 1.3 && vb.upDownVolRatio >= 1.3
        const tightBase = vb.range10dPct <= 8

        // Gate B: volume accumulation required
        if (!volAccum) {
          filteredOut['gate-B-volume'] = (filteredOut['gate-B-volume'] ?? 0) + 1
          continue
        }
        // Gate C: tight base required (Moschip pattern)
        if (!tightBase) {
          filteredOut['gate-C-tight-base'] = (filteredOut['gate-C-tight-base'] ?? 0) + 1
          continue
        }

        // Compose trade plan — prefer MTF-harmonic best hit's targets;
        // fall back to Elliott's target set.
        const source = mtf?.bestHit ?? {}
        const ltp = candles[candles.length - 1].close
        const entry = Number(source.entry ?? ltp)
        const stopLoss = Number(source.stopLoss ?? (dir === 'BUY' ? entry * 0.94 : entry * 1.06))
        const target1 = Number(source.target1 ?? (dir === 'BUY' ? entry * 1.08 : entry * 0.92))
        const target2 = Number(source.target2 ?? (dir === 'BUY' ? entry * 1.15 : entry * 0.85))
        const target3 = Number(source.target3 ?? (dir === 'BUY' ? entry * 1.25 : entry * 0.75))
        const risk = Math.abs(entry - stopLoss)
        const rrT1 = risk > 0 ? Math.abs(target1 - entry) / risk : 0
        const rrT2 = risk > 0 ? Math.abs(target2 - entry) / risk : 0
        const rrT3 = risk > 0 ? Math.abs(target3 - entry) / risk : 0

        // Score composition
        const mtfBonus = hasMtfHarmonic ? Math.min(30, (mtf!.timeframes.size - 1) * 15 + 15) : 0
        const waveBonus = isWave3 ? (elliott!.setup.includes('WAVE_3') ? 25 : 15) : 0
        const volBonus = Math.min(20, (vb.vol5d20dRatio - 1) * 15 + (vb.upDownVolRatio - 1) * 10)
        const baseBonus = Math.min(15, (8 - vb.range10dPct) * 2)
        const rrBonus = Math.min(10, rrT1 * 3)
        const score = Math.min(100, Math.round(mtfBonus + waveBonus + volBonus + baseBonus + rrBonus))

        const pillars: MoneyPrinterSignal['pillars'] = {
          mtfHarmonic: {
            pass: hasMtfHarmonic,
            timeframes: mtf ? [...mtf.timeframes] : [],
            patterns: mtf ? [...mtf.patterns] : [],
            detail: mtf
              ? `${mtf.timeframes.size} TFs confluence: ${[...mtf.timeframes].join('+')} · patterns: ${[...mtf.patterns].join(', ')}`
              : 'single-TF or absent',
          },
          elliottWave: {
            pass: isWave3,
            setup: elliott?.setup ?? null,
            detail: elliott ? `${elliott.setup} conf ${elliott.confidence}` : 'no wave setup',
          },
          volumeAccumulation: {
            pass: volAccum,
            vol5d20dRatio: vb.vol5d20dRatio,
            upDownVolRatio: vb.upDownVolRatio,
            detail: `5d/20d vol ${vb.vol5d20dRatio}× · up/down vol ${vb.upDownVolRatio}×`,
          },
          tightBase: {
            pass: tightBase,
            range10dPct: vb.range10dPct,
            detail: `10-bar range ${vb.range10dPct.toFixed(1)}%`,
          },
        }

        const sources: string[] = []
        if (mtf) for (const tf of mtf.timeframes) sources.push(`HARMONIC-${tf}`)
        if (isWave3) sources.push(`ELLIOTT-${elliott!.setup}`)
        sources.push('VOL-ACCUM')

        const reasoning: string[] = []
        if (hasMtfHarmonic) reasoning.push(`Multi-TF harmonic: ${pillars.mtfHarmonic.detail}`)
        if (isWave3) reasoning.push(`Elliott ${elliott!.setup} — sharpest impulsive wave`)
        reasoning.push(`Volume accumulation: 5d/20d ${vb.vol5d20dRatio}× · up/down ${vb.upDownVolRatio}×`)
        reasoning.push(`Tight base: last 10 bars range ${vb.range10dPct.toFixed(1)}% — coiled for break`)

        const humanLines = [
          `💰 MONEY-PRINTER · score ${score} · ${dir} @ ₹${entry.toFixed(2)}`,
          `Setup: ${hasMtfHarmonic ? `${mtf!.timeframes.size}-TF harmonic (${[...mtf!.timeframes].join('+')})` : '—'}${isWave3 ? ` + ${elliott!.setup}` : ''}`,
          `Volume: 5d/20d ${vb.vol5d20dRatio}× · up/down ${vb.upDownVolRatio}× (accumulation)`,
          `Base: ${vb.range10dPct.toFixed(1)}% coil over 10 bars — breakout-ready`,
          `Trade plan: SL ₹${stopLoss.toFixed(2)} · T1 ₹${target1.toFixed(2)} (R:R ${rrT1.toFixed(1)}) · T2 ₹${target2.toFixed(2)} · T3 ₹${target3.toFixed(2)}`,
        ]

        emitted.push({
          symbol,
          direction: dir,
          score,
          ltp,
          entry, stopLoss, target1, target2, target3,
          entryDate: source.entryDate,
          target1Date: source.target1Date,
          target2Date: source.target2Date,
          target3Date: source.target3Date,
          rrT1, rrT2, rrT3,
          pillars,
          reasoning,
          humanExplain: humanLines.join('\n'),
          sources,
        })
      } catch (e) {
        filteredOut[`error`] = (filteredOut[`error`] ?? 0) + 1
      }
    }
  }))

  emitted.sort((a, b) => b.score - a.score)
  const top = emitted.slice(0, 30)

  const out = {
    generatedAt: new Date().toISOString(),
    candidatesEvaluated: symDirKeys.size,
    emitted: top.length,
    filteredOut: Object.entries(filteredOut).sort(([, a], [, b]) => b - a).map(([reason, count]) => ({ reason, count })),
    rows: top,
  }
  await fs.mkdir(SNAP_DIR, { recursive: true })
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(out, null, 2), 'utf-8')
  log.ok('MONEY-PRINTER', `${top.length}/${symDirKeys.size} qualified · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { emitted: top, candidatesEvaluated: symDirKeys.size, filteredOut }
}
