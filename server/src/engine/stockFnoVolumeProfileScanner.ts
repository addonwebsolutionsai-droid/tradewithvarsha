/**
 * Stock F&O Volume Profile scanner — extension of the NIFTY VP engine to
 * the ~211 F&O underlyings, UI-only (no Telegram per NIFTY-only rule).
 *
 * Per stock, we build 3 timeframe profiles (15m, 1h, 1D) — that's enough
 * to detect the setup families with a manageable data budget. Requires
 * 2+ timeframe agreement OR one HIGH-strength setup on the 1D profile to
 * emit a row.
 *
 * Output rows include:
 *   - Symbol · Direction · Setup family · Strength · TFs agreeing
 *   - LTP · Entry · SL · T1 / T2 / T3 (all dated)
 *   - POC / VAH / VAL / IB high-low for the primary timeframe
 *   - Composite reasoning
 */

import fs from 'fs'
import path from 'path'
import { getCandles } from '../data/index'
import * as angel from '../data/angel'
import { buildVolumeProfile, detectSetups } from './volumeProfile'
import type { VpSignal } from './volumeProfile'
import type { Candle, Timeframe } from '../types'
import { log } from '../util/logger'

const TFS: Array<{ key: string; source: Timeframe; count: number }> = [
  { key: '15m', source: '15m', count: 200 },
  { key: '1h',  source: '1h',  count: 200 },
  { key: '1D',  source: '1D',  count: 200 },
]

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

interface TfProfile {
  tf: string
  poc: number
  vah: number
  val: number
  ibH: number
  ibL: number
  signals: VpSignal[]
}

export interface StockFnoVpRow {
  symbol: string
  ltp: number
  side: 'BULLISH' | 'BEARISH'
  compositeStrength: number   // 0-100
  agreementScore: number      // # of TFs agreeing (out of 3)
  bestSetup: string
  bestTf: string
  keyLevel: number
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  entryDate: string
  target1Date: string
  target2Date: string
  target3Date: string
  poc1D: number
  vah1D: number
  val1D: number
  reasoning: string[]
  tfProfiles: TfProfile[]
}

async function listFnoUnderlyings(): Promise<string[]> {
  try {
    const sm = await angel.loadScripMaster()
    if (!sm) return []
    const futs = sm.filter(s => s.exch_seg === 'NFO' && s.instrumenttype === 'FUTSTK')
    return [...new Set(futs.map(s => s.name))]
      .filter(n => !!n && !/NSETEST/i.test(n))
      .filter(n => n !== 'NIFTY' && n !== 'BANKNIFTY' && n !== 'FINNIFTY' && n !== 'MIDCPNIFTY')
      .sort()
  } catch { return [] }
}

async function scanSymbol(symbol: string): Promise<StockFnoVpRow | null> {
  const tfProfiles: TfProfile[] = []
  let latestSpot = 0
  let bestSignal: (VpSignal & { tf: string }) | null = null
  let bullCount = 0
  let bearCount = 0

  for (const tf of TFS) {
    try {
      const candles = await getCandles(symbol, tf.source, tf.count)
      if (!candles || candles.length < 25) continue
      const profile = buildVolumeProfile(candles, 40, tf.key)
      if (!profile) continue
      const ar = atr(candles)
      const signals = detectSetups(profile, candles.slice(-6), ar)
      latestSpot = candles[candles.length - 1].close
      tfProfiles.push({
        tf: tf.key,
        poc: profile.poc,
        vah: profile.vah,
        val: profile.val,
        ibH: profile.initialBalanceHigh,
        ibL: profile.initialBalanceLow,
        signals,
      })
      let tfBull = 0, tfBear = 0
      for (const s of signals) {
        if (s.side === 'BULLISH') tfBull += s.strength
        else tfBear += s.strength
        if (!bestSignal || s.strength > bestSignal.strength) {
          bestSignal = { ...s, tf: tf.key }
        }
      }
      if (tfBull > tfBear && tfBull > 0) bullCount++
      else if (tfBear > tfBull && tfBear > 0) bearCount++
    } catch { /* skip TF */ }
  }

  if (!bestSignal || tfProfiles.length === 0) return null
  const agreement = Math.max(bullCount, bearCount)
  // Require 2+ TF agreement OR strong 1D signal alone
  const oneDaySig = tfProfiles.find(t => t.tf === '1D')?.signals ?? []
  const oneDayHighStrength = oneDaySig.some(s => s.strength >= 70)
  if (agreement < 2 && !oneDayHighStrength) return null

  const side: 'BULLISH' | 'BEARISH' = bullCount > bearCount ? 'BULLISH' : 'BEARISH'
  const now = Date.now()
  const oneDayProfile = tfProfiles.find(t => t.tf === '1D')
  const compositeStrength = Math.min(100, bestSignal.strength + agreement * 5)

  return {
    symbol,
    ltp: latestSpot,
    side,
    compositeStrength,
    agreementScore: agreement,
    bestSetup: bestSignal.setup,
    bestTf: bestSignal.tf,
    keyLevel: bestSignal.keyLevel,
    entry: Math.round(bestSignal.entry * 100) / 100,
    stopLoss: Math.round(bestSignal.stopLoss * 100) / 100,
    target1: Math.round(bestSignal.target1 * 100) / 100,
    target2: Math.round(bestSignal.target2 * 100) / 100,
    target3: Math.round(bestSignal.target3 * 100) / 100,
    entryDate: istDateStr(now),
    target1Date: addBusinessDays(now, 2),
    target2Date: addBusinessDays(now, 5),
    target3Date: addBusinessDays(now, 10),
    poc1D: oneDayProfile?.poc ?? bestSignal.keyLevel,
    vah1D: oneDayProfile?.vah ?? 0,
    val1D: oneDayProfile?.val ?? 0,
    reasoning: [
      `${bestSignal.tf} · ${bestSignal.setup} · strength ${bestSignal.strength}`,
      `${agreement}/${tfProfiles.length} TFs agree on ${side} bias`,
      bestSignal.reason,
    ],
    tfProfiles,
  }
}

export async function scanStockFnoVolumeProfile(opts?: { concurrency?: number; limit?: number }): Promise<{
  generatedAt: string
  scanned: number
  rows: StockFnoVpRow[]
}> {
  const universe = await listFnoUnderlyings()
  if (universe.length === 0) {
    log.warn('STOCK-FNO-VP', 'no F&O underlyings (ScripMaster not loaded?)')
    return { generatedAt: new Date().toISOString(), scanned: 0, rows: [] }
  }
  const concurrency = opts?.concurrency ?? 6
  const limit = opts?.limit ?? universe.length
  const targets = universe.slice(0, limit)

  log.info('STOCK-FNO-VP', `scanning ${targets.length} F&O underlyings with Volume Profile (3 TFs each)`)

  const rows: StockFnoVpRow[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < targets.length) {
      const sym = targets[cursor++]
      try {
        const r = await scanSymbol(sym)
        if (r) rows.push(r)
      } catch { /* skip */ }
    }
  }))
  rows.sort((a, b) => b.compositeStrength - a.compositeStrength)

  return { generatedAt: new Date().toISOString(), scanned: targets.length, rows }
}

export async function runAndPublishStockFnoVolumeProfile(): Promise<{
  ok: boolean
  scanned: number
  total: number
  bullCount: number
  bearCount: number
}> {
  const r = await scanStockFnoVolumeProfile()
  const { enrichRowsDates } = await import('../lib/targetDateEnrichment')
  r.rows = enrichRowsDates(r.rows as unknown as Array<Record<string, unknown>>, 'stockFnoVp') as unknown as typeof r.rows
  const snapPath = path.resolve(__dirname, '../../data/public-snapshots/stock-fno-volume-profile.json')
  fs.mkdirSync(path.dirname(snapPath), { recursive: true })
  fs.writeFileSync(snapPath, JSON.stringify(r, null, 2))
  const bull = r.rows.filter(x => x.side === 'BULLISH').length
  const bear = r.rows.filter(x => x.side === 'BEARISH').length
  return { ok: true, scanned: r.scanned, total: r.rows.length, bullCount: bull, bearCount: bear }
}
