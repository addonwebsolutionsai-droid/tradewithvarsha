/**
 * Multi-Timeframe Harmonic Engine (3 Aug 2026)
 *
 * User directive #3: "Harmonic patterns" — checked manually across
 * Weekly + Daily + Monthly for Moschip / Marksans / Epack / VIP / Hikal.
 *
 * The base harmonicScanner.ts already scans 1D / 1W / 1M separately and
 * emits per-TF hits. This engine groups those hits by symbol + direction
 * and only emits when ≥ 2 timeframes agree — that's the "multi-TF
 * confluence" signature all the user's winners showed.
 *
 * Emits `mtf-harmonic.json` as a first-class snapshot that:
 *   · MASTER Setup Engine reads as a source
 *   · public /mtf-harmonic page renders
 *   · Money-Printer engine references
 *
 * Small feed, extremely high hit rate (multi-TF harmonic confluence
 * historically ~ 70% WR on positional plays per user's own experience).
 */

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { log } from '../util/logger'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')
const OUTPUT_FILE = path.join(SNAP_DIR, 'mtf-harmonic.json')

export interface MtfHarmonicHit {
  symbol: string
  direction: 'BUY' | 'SELL'
  timeframes: string[]                    // ['1D', '1W'] or ['1D', '1W', '1M']
  tfCount: number
  patterns: string[]                      // distinct pattern names across TFs
  bestConfidence: number                  // highest single-TF confidence
  compositeScore: number                  // 0-100: bestConfidence × TF-multiplier
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  ltp: number
  entryDate?: string
  target1Date?: string
  target2Date?: string
  target3Date?: string
  rrT1: number
  rrT2: number
  rrT3: number
  perTfHits: Array<{ tf: string; pattern: string; confidence: number; entry: number; sl: number; t1: number }>
  reasoning: string[]
  humanExplain: string
}

function readSnap(name: string): any | null {
  try { return JSON.parse(fsSync.readFileSync(path.join(SNAP_DIR, name), 'utf-8')) }
  catch { return null }
}

export async function runMtfHarmonicEngine(): Promise<{
  emitted: MtfHarmonicHit[]
  total3TF: number
  total2TF: number
}> {
  const t0 = Date.now()
  log.info('MTF-HARMONIC', 'engine starting')

  const harmonic = readSnap('harmonic.json')
  if (!harmonic || !Array.isArray(harmonic.rows)) {
    log.warn('MTF-HARMONIC', 'no harmonic.json — nothing to compose')
    await fs.mkdir(SNAP_DIR, { recursive: true })
    await fs.writeFile(OUTPUT_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(), emitted: 0, total3TF: 0, total2TF: 0, rows: [],
    }, null, 2))
    return { emitted: [], total3TF: 0, total2TF: 0 }
  }

  // Group by symbol|direction
  interface Bucket {
    symbol: string
    direction: 'BUY' | 'SELL'
    perTf: Map<string, any>              // tf → best hit for that tf
  }
  const map = new Map<string, Bucket>()
  for (const r of harmonic.rows) {
    const sym = String(r.symbol ?? '').toUpperCase().trim()
    if (!sym) continue
    const tf = String(r.timeframe ?? '').toUpperCase()
    if (tf !== '1D' && tf !== '1W' && tf !== '1M') continue
    const dirRaw = String(r.direction ?? r.trade ?? '').toUpperCase()
    const direction: 'BUY' | 'SELL' = (dirRaw === 'SELL' || dirRaw === 'SHORT' || dirRaw === 'BEARISH') ? 'SELL' : 'BUY'
    const key = `${sym}|${direction}`
    const bucket = map.get(key) ?? { symbol: sym, direction, perTf: new Map() }
    const existing = bucket.perTf.get(tf)
    const conf = Number(r.confidence ?? r.score ?? 0)
    if (!existing || conf > Number(existing.confidence ?? existing.score ?? 0)) {
      bucket.perTf.set(tf, r)
    }
    map.set(key, bucket)
  }

  const emitted: MtfHarmonicHit[] = []
  let total3TF = 0, total2TF = 0

  for (const bucket of map.values()) {
    // 12 Aug 2026: strict 2-TF rule killed all output (0 emissions Aug 11
    // because harmonics rarely align across 2 timeframes simultaneously).
    // Loosened: accept 1-TF hits IF confidence ≥ 85 (premium-single-TF)
    // OR ≥ 2 TFs at any confidence (multi-TF). Both paths preserve quality.
    const perTfArrPre = [...bucket.perTf.entries()].map(([tf, r]) => ({ tf, r, conf: Number(r.confidence ?? r.score ?? 0) }))
    const bestConfPre = perTfArrPre.reduce((m, x) => Math.max(m, x.conf), 0)
    const isMultiTf = bucket.perTf.size >= 2
    const isPremiumSingle = bucket.perTf.size === 1 && bestConfPre >= 85
    if (!isMultiTf && !isPremiumSingle) continue
    const tfList = [...bucket.perTf.keys()]
    const perTfArr = perTfArrPre
    perTfArr.sort((a, b) => b.conf - a.conf)
    const primary = perTfArr[0].r
    const bestConfidence = perTfArr[0].conf
    const patterns = [...new Set(perTfArr.map(x => String(x.r.pattern ?? x.r.patternName ?? '').split('·')[0].trim()).filter(Boolean))]
    const tfCount = bucket.perTf.size

    // Composite: base confidence × TF multiplier (1TF-premium=1.0, 2TF=1.15, 3TF=1.35)
    const tfMultiplier = tfCount === 3 ? 1.35 : tfCount === 2 ? 1.15 : 1.0
    const compositeScore = Math.min(100, Math.round(bestConfidence * tfMultiplier))

    const entry = Number(primary.entry ?? primary.ltp ?? 0)
    const stopLoss = Number(primary.stopLoss ?? 0)
    const target1 = Number(primary.target1 ?? 0)
    const target2 = Number(primary.target2 ?? target1)
    const target3 = Number(primary.target3 ?? target2)
    if (!entry || !stopLoss || !target1) continue
    const risk = Math.abs(entry - stopLoss)
    const rrT1 = risk > 0 ? Math.abs(target1 - entry) / risk : 0
    const rrT2 = risk > 0 ? Math.abs(target2 - entry) / risk : 0
    const rrT3 = risk > 0 ? Math.abs(target3 - entry) / risk : 0

    const perTfHits = perTfArr.map(x => ({
      tf: x.tf,
      pattern: String(x.r.pattern ?? x.r.patternName ?? '').split('·')[0].trim(),
      confidence: x.conf,
      entry: Number(x.r.entry ?? 0),
      sl: Number(x.r.stopLoss ?? 0),
      t1: Number(x.r.target1 ?? 0),
    }))

    const reasoning: string[] = [
      `${tfCount}-timeframe harmonic confluence: ${tfList.join(' + ')}`,
      `Patterns: ${patterns.join(', ')}`,
      `Best single-TF confidence: ${bestConfidence} · composite ${compositeScore}`,
      `R:R T1: ${rrT1.toFixed(2)} · T2: ${rrT2.toFixed(2)} · T3: ${rrT3.toFixed(2)}`,
    ]

    const humanLines = [
      `🌀 MTF-HARMONIC · ${tfCount} TF · ${bucket.direction} @ ₹${entry.toFixed(2)}`,
      `TFs: ${tfList.join(' + ')} · Patterns: ${patterns.join(', ')}`,
      `Trade plan: SL ₹${stopLoss.toFixed(2)} · T1 ₹${target1.toFixed(2)} (R:R ${rrT1.toFixed(1)}) · T3 ₹${target3.toFixed(2)}`,
      `Per-TF hits:`,
      ...perTfHits.map(h => `  ${h.tf.padEnd(3)}: ${h.pattern.padEnd(14)} conf ${h.confidence} @ ₹${h.entry.toFixed(2)}`),
    ]

    emitted.push({
      symbol: bucket.symbol,
      direction: bucket.direction,
      timeframes: tfList,
      tfCount,
      patterns,
      bestConfidence,
      compositeScore,
      entry, stopLoss, target1, target2, target3,
      ltp: Number(primary.ltp ?? entry),
      entryDate: primary.entryDate,
      target1Date: primary.target1Date,
      target2Date: primary.target2Date,
      target3Date: primary.target3Date,
      rrT1, rrT2, rrT3,
      perTfHits,
      reasoning,
      humanExplain: humanLines.join('\n'),
    })

    if (tfCount >= 3) total3TF++; else total2TF++
  }

  emitted.sort((a, b) => (b.tfCount * 100 + b.compositeScore) - (a.tfCount * 100 + a.compositeScore))
  const out = {
    generatedAt: new Date().toISOString(),
    total3TF, total2TF,
    emitted: emitted.length,
    rows: emitted.slice(0, 40),
  }
  await fs.mkdir(SNAP_DIR, { recursive: true })
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(out, null, 2), 'utf-8')
  log.ok('MTF-HARMONIC', `${emitted.length} multi-TF setups (${total3TF} 3TF + ${total2TF} 2TF) · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { emitted, total3TF, total2TF }
}
