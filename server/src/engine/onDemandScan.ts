/**
 * On-demand real-time scan · for the /desk "Scan" input.
 *
 * User pastes 1-N symbols → we compute the same feature set every daily
 * engine runs on, plus quick chart-pattern + harmonic + wave lookups.
 * Returns a normalised row per symbol with a composite score + trade plan
 * if the setup passes.
 *
 * Works during market hours (uses live quote via getQuote) and outside
 * market hours (uses last close from getCandles).
 *
 * Never throws — a bad symbol returns { error: 'no data' }.
 */

import * as data from '../data'
import { estimateTargetDates } from '../lib/targetDateEstimator'
import { buildUnifiedReason } from '../lib/unifiedReason'
import type { Candle } from '../types'

const MAX_SYMBOLS = 25

export interface OnDemandRow {
  symbol: string
  ok: boolean
  error?: string
  ltp?: number
  changePct?: number
  ret5dPct?: number
  ret20dPct?: number
  rsi14?: number
  emaStack?: 'BULL' | 'BEAR' | 'MIXED'
  volRatio5_20?: number
  distFromHigh20Pct?: number
  distFromLow20Pct?: number
  bbWidthPct?: number
  atr14?: number
  atrPctOfPrice?: number
  compositeBias?: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  compositeScore?: number
  setups?: string[]
  entry?: number
  stopLoss?: number
  target1?: number
  target2?: number
  target3?: number
  entryDate?: string
  target1Date?: string
  target2Date?: string
  target3Date?: string
  slDate?: string
  reasoning?: string[]
  unifiedReason?: string
}

// ─── Feature math ─────────────────────────────────────────────────────

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0
  const k = 2 / (period + 1)
  let e = values[0]
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}
function rsi14(values: number[]): number {
  if (values.length < 15) return 50
  let g = 0, l = 0
  for (let i = values.length - 14; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) g += d; else l -= d
  }
  if (l === 0) return 100
  return 100 - 100 / (1 + g / l)
}
function atr14(candles: Candle[]): number {
  if (candles.length < 15) return 0
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  const last = trs.slice(-14)
  return last.reduce((s, v) => s + v, 0) / last.length
}

// ─── Setup detectors (compact heuristics) ─────────────────────────────

function detectSetups(f: {
  emaStack: 'BULL' | 'BEAR' | 'MIXED'; volRatio: number; rsi: number;
  distHigh20: number; distLow20: number; bbW: number; ret5d: number
}): string[] {
  const out: string[] = []
  if (f.emaStack === 'BULL' && f.volRatio > 1.2 && f.rsi > 55 && f.rsi < 75 && f.distHigh20 < 5) {
    out.push('EMA-stacked bull breakout')
  }
  if (f.bbW < 8 && f.volRatio < 1.0 && f.rsi > 45 && f.rsi < 65) {
    out.push('BB Squeeze coil')
  }
  if (f.emaStack === 'BEAR' && f.rsi < 45 && f.distLow20 < 5) {
    out.push('EMA-stacked breakdown')
  }
  if (f.ret5d > 8 && f.rsi > 70) {
    out.push('⚠ over-extended · mean-reversion risk')
  }
  if (f.rsi < 30 && f.distLow20 < 3) {
    out.push('Oversold bounce candidate')
  }
  return out
}

function composite(f: {
  emaStack: 'BULL' | 'BEAR' | 'MIXED'; volRatio: number; rsi: number;
  distHigh20: number; distLow20: number; bbW: number; ret5d: number; ret20d: number
}): { bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; score: number; reasons: string[] } {
  let bull = 0, bear = 0
  const reasons: string[] = []
  if (f.emaStack === 'BULL') { bull += 25; reasons.push('EMA 9>21>50 stacked bullish') }
  else if (f.emaStack === 'BEAR') { bear += 25; reasons.push('EMA 9<21<50 stacked bearish') }
  if (f.rsi >= 55 && f.rsi <= 75) { bull += 15; reasons.push(`RSI ${f.rsi.toFixed(0)} in productive bull zone`) }
  else if (f.rsi <= 40) { bear += 15; reasons.push(`RSI ${f.rsi.toFixed(0)} weak`) }
  if (f.volRatio > 1.4) { bull += 10; reasons.push(`Volume ${f.volRatio.toFixed(1)}× 20-day avg`) }
  if (f.distHigh20 < 3) { bull += 10; reasons.push(`Near 20-day high (${f.distHigh20.toFixed(1)}% off)`) }
  if (f.distLow20 < 3) { bear += 10; reasons.push(`Near 20-day low (${f.distLow20.toFixed(1)}% off)`) }
  if (f.ret5d > 5 && f.ret20d > 12) { bear += 10; reasons.push(`Over-extended: 5d +${f.ret5d.toFixed(1)}% / 20d +${f.ret20d.toFixed(1)}%`) }
  if (f.bbW < 8) { bull += 5; reasons.push(`Tight coil · BB width ${f.bbW.toFixed(1)}%`) }
  const net = bull - bear
  const bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = net >= 20 ? 'BULLISH' : net <= -20 ? 'BEARISH' : 'NEUTRAL'
  const score = Math.round(Math.min(100, Math.max(0, 50 + net)))
  return { bias, score, reasons }
}

// ─── Per-symbol scan ─────────────────────────────────────────────────

async function scanOne(symbol: string): Promise<OnDemandRow> {
  const sym = symbol.trim().toUpperCase()
  if (!sym) return { symbol, ok: false, error: 'empty symbol' }
  try {
    const [quote, candles] = await Promise.all([
      data.getQuote(sym).catch(() => null),
      data.getCandles(sym, '1D' as any, 60).catch(() => [] as Candle[]),
    ])
    if (!candles || candles.length < 25) {
      return { symbol: sym, ok: false, error: 'insufficient candle history' }
    }
    const closes = candles.map(c => c.close)
    const vols = candles.map(c => c.volume)
    const last = closes[closes.length - 1]
    const prev = closes[closes.length - 2]
    const ltp = quote?.price ?? last
    const changePct = ((ltp - prev) / prev) * 100
    const ret5d = ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
    const ret20d = ((last - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
    const rsi = rsi14(closes)
    const e9 = ema(closes.slice(-30), 9)
    const e21 = ema(closes.slice(-50), 21)
    const e50 = closes.length >= 50 ? ema(closes.slice(-60), 50) : e21
    const emaStack: OnDemandRow['emaStack'] =
      e9 > e21 && e21 > e50 ? 'BULL' :
      e9 < e21 && e21 < e50 ? 'BEAR' : 'MIXED'
    const v5 = vols.slice(-5).reduce((s, x) => s + x, 0) / 5
    const v20 = vols.slice(-20).reduce((s, x) => s + x, 0) / 20
    const volRatio = v20 > 0 ? v5 / v20 : 1
    const high20 = Math.max(...closes.slice(-20))
    const low20 = Math.min(...closes.slice(-20))
    const distHigh20 = ((high20 - last) / high20) * 100
    const distLow20 = ((last - low20) / low20) * 100
    const bbW = ((high20 - low20) / last) * 100
    const atr = atr14(candles)
    const atrPct = last > 0 ? (atr / last) * 100 : 0

    const f = { emaStack, volRatio, rsi, distHigh20, distLow20, bbW, ret5d, ret20d }
    const comp = composite(f)
    const setups = detectSetups(f)

    // Tier-aware SL + guaranteed R:R ≥ 1:1 at T1 (matches api/scan/on-demand.js).
    // Indices ≤ 2%, commodities/FX 2-5%, equities tier by price (mid/large 5%,
    // small 6.5%, micro 8%). T1 distance = max(1.2×SL_dist, 1.5×ATR) so
    // R:R ≥ 1:1 at T1, ≥ 2:1 at T2, ≥ 3:1 at T3 — always.
    const slDistanceFor = (entry: number, atrX: number, symbol: string): number => {
      const isIndex = /^\^/.test(symbol) || /NIFTY|SENSEX|BANKNIFTY|FINNIFTY|MIDCP|VIX/i.test(symbol)
      const isCommodityFx = /=[FX]$|-USD|=X/.test(symbol) || /GOLD|SILVER|CRUDE|OIL|COPPER|NATGAS|XAU|XAG|BTC|ETH|USDINR|EURUSD|DXY/i.test(symbol)
      if (isIndex) return Math.min(entry * 0.02, Math.max(atrX * 1.2, entry * 0.008))
      if (isCommodityFx) return Math.min(entry * 0.05, Math.max(atrX * 1.5, entry * 0.02))
      const cap = entry >= 500 ? 0.05 : entry >= 100 ? 0.055 : entry >= 20 ? 0.065 : 0.08
      return Math.min(entry * cap, Math.max(atrX * 1.5, entry * 0.025))
    }
    let plan: Partial<OnDemandRow> = {}
    if (comp.bias === 'BULLISH' && comp.score >= 60) {
      const entry = ltp
      const slDist = slDistanceFor(entry, atr, sym)
      const t1Dist = Math.max(atr * 1.5, slDist * 1.2)
      const t2Dist = Math.max(atr * 3.0, slDist * 2.2)
      const t3Dist = Math.max(atr * 5.0, slDist * 3.2)
      const stopLoss = entry - slDist
      const target1 = entry + t1Dist
      const target2 = entry + t2Dist
      const target3 = entry + t3Dist
      const dates = estimateTargetDates({
        entry, stopLoss, target1, target2, target3,
        direction: 'BUY', atr14: atr, ret5dPct: ret5d, ret20dPct: ret20d,
        symbol: sym,
      })
      plan = {
        entry: Math.round(entry * 100) / 100,
        stopLoss: Math.round(stopLoss * 100) / 100,
        target1: Math.round(target1 * 100) / 100,
        target2: Math.round(target2 * 100) / 100,
        target3: Math.round(target3 * 100) / 100,
        entryDate: dates.entryDate,
        target1Date: dates.target1Date,
        target2Date: dates.target2Date,
        target3Date: dates.target3Date,
        slDate: dates.slDate,
      }
    } else if (comp.bias === 'BEARISH' && comp.score <= 40) {
      const entry = ltp
      const slDist = slDistanceFor(entry, atr, sym)
      const t1Dist = Math.max(atr * 1.5, slDist * 1.2)
      const t2Dist = Math.max(atr * 3.0, slDist * 2.2)
      const t3Dist = Math.max(atr * 5.0, slDist * 3.2)
      const stopLoss = entry + slDist
      const target1 = entry - t1Dist
      const target2 = entry - t2Dist
      const target3 = entry - t3Dist
      const dates = estimateTargetDates({
        entry, stopLoss, target1, target2, target3,
        direction: 'SHORT', atr14: atr, ret5dPct: ret5d, ret20dPct: ret20d,
        symbol: sym,
      })
      plan = {
        entry: Math.round(entry * 100) / 100,
        stopLoss: Math.round(stopLoss * 100) / 100,
        target1: Math.round(target1 * 100) / 100,
        target2: Math.round(target2 * 100) / 100,
        target3: Math.round(target3 * 100) / 100,
        entryDate: dates.entryDate,
        target1Date: dates.target1Date,
        target2Date: dates.target2Date,
        target3Date: dates.target3Date,
        slDate: dates.slDate,
      }
    }

    const unified = buildUnifiedReason({
      setups: setups.length > 0 ? setups : undefined,
      volRatio20d: volRatio,
      rsi14: rsi,
      ret5dPct: ret5d,
      ret20dPct: ret20d,
      emaStack,
      expectedReturnPct: plan.target1 && plan.entry ? ((plan.target1 - plan.entry) / plan.entry) * 100 : undefined,
      horizonDays: 5,
    })

    return {
      symbol: sym, ok: true,
      ltp: Math.round(ltp * 100) / 100,
      changePct: Math.round(changePct * 100) / 100,
      ret5dPct: Math.round(ret5d * 100) / 100,
      ret20dPct: Math.round(ret20d * 100) / 100,
      rsi14: Math.round(rsi * 10) / 10,
      emaStack,
      volRatio5_20: Math.round(volRatio * 100) / 100,
      distFromHigh20Pct: Math.round(distHigh20 * 10) / 10,
      distFromLow20Pct: Math.round(distLow20 * 10) / 10,
      bbWidthPct: Math.round(bbW * 10) / 10,
      atr14: Math.round(atr * 100) / 100,
      atrPctOfPrice: Math.round(atrPct * 100) / 100,
      compositeBias: comp.bias,
      compositeScore: comp.score,
      setups,
      reasoning: comp.reasons,
      unifiedReason: unified.collapsed,
      ...plan,
    }
  } catch (e) {
    return { symbol: sym, ok: false, error: (e as Error).message }
  }
}

// ─── Public entry ─────────────────────────────────────────────────────

export async function runOnDemandScan(symbols: string[]): Promise<{
  generatedAt: string
  requested: string[]
  results: OnDemandRow[]
}> {
  const uniq = Array.from(new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))).slice(0, MAX_SYMBOLS)
  const results: OnDemandRow[] = []
  const concurrency = 4
  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < uniq.length) {
      const sym = uniq[cursor++]
      results.push(await scanOne(sym))
    }
  }))
  results.sort((a, b) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0))
  return { generatedAt: new Date().toISOString(), requested: uniq, results }
}
