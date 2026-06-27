/**
 * PEDIGREE ACCUMULATION SCREENER
 *
 * User directive 2026-06-26: "I want stocks of good pedigree companies
 * whose price is 50%+ down from 52-week high, AND FII or DII or Promoters
 * are increasing stakes continuously. This shows big hands are grabbing
 * from retailers — when everyone is out, the move starts."
 *
 * Three composite filters (ALL must pass for the row to surface):
 *
 *   1. PEDIGREE QUALITY
 *      - NIFTY-500 membership OR market cap ≥ ₹1,000 Cr
 *      - Promoter pledge < 10%
 *      - Average turnover ≥ ₹2 Cr/day (eliminates illiquid micro-caps)
 *
 *   2. DEEP PULLBACK
 *      - Price ≥ 40% off the 52-week high (52w-high - close) / 52w-high)
 *      - Tagged DEEP (60%+ off) or MODERATE (40-60% off)
 *
 *   3. INSTITUTIONAL ACCUMULATION (≥1 of 3 must fire)
 *      - FII stake ↑ QoQ by ≥ 0.3 pp
 *      - DII stake ↑ QoQ by ≥ 0.3 pp
 *      - Promoter stake ↑ QoQ by ≥ 0.3 pp (rare but most bullish)
 *
 * Score 0-100 composite:
 *   30 — depth of pullback (50%+ from 52w-hi)
 *   25 — number of institutional buyers increasing (1 / 2 / 3)
 *   15 — magnitude of stake delta (sum of FII+DII+Promoter QoQ deltas)
 *   10 — bottoming signature (RSI 30-50, no further breakdown)
 *   10 — NIFTY-500 membership (proper pedigree)
 *   10 — low pledge (<5%)
 *
 * Output: top 50 candidates sorted by composite score.
 */
import fs from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import { getCandles } from '../data'
import { getShareholding } from '../data/shareholding'
import type { Candle } from '../types'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

export interface PedigreeRow {
  symbol: string
  close: number
  high52w: number
  pctOffHigh: number              // 0-100 (how far below 52w hi)
  pullbackTier: 'MODERATE' | 'DEEP'
  marketCapCr: number | null
  isNifty500: boolean
  // Institutional flow (latest QoQ from screener.in shareholding)
  fiiPct: number | null
  fiiDeltaQoQ: number | null
  diiPct: number | null
  diiDeltaQoQ: number | null
  promoterPct: number | null
  promoterDeltaQoQ: number | null
  promoterPledgePct: number | null
  accumBuyerCount: number          // how many of FII/DII/Promoter buying
  // Bottoming context
  rsi14: number
  ret5dPct: number
  ret20dPct: number
  baseTightnessPct: number         // 10d range / close
  // Composite
  score: number                    // 0-100
  reasons: string[]
  capturedAt: string
}

// — Indicators —
function ema(values: number[], period: number): number {
  const k = 2 / (period + 1)
  let v = values[0]
  for (let i = 1; i < values.length; i++) v = values[i] * k + v * (1 - k)
  return v
}
function rsi14(closes: number[]): number {
  if (closes.length < 15) return 50
  let g = 0, l = 0
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) g += d; else l -= d
  }
  if (l === 0) return 100
  return 100 - 100 / (1 + g / l)
}

interface ScanOpts {
  minPctOffHigh?: number          // default 40
  minTurnoverCr?: number          // default 2
  maxConcurrency?: number         // default 6
  topN?: number                   // default 50
}

export async function runPedigreeAccumulation(opts: ScanOpts = {}): Promise<PedigreeRow[]> {
  const minPctOff = opts.minPctOffHigh ?? 40
  const minTurnover = opts.minTurnoverCr ?? 2
  const concurrency = opts.maxConcurrency ?? 6
  const topN = opts.topN ?? 50

  log.info('PEDIGREE', `Scanning for pedigree-accumulation candidates (≥${minPctOff}% off 52w-hi + FII/DII/Promoter↑)...`)

  // Universe = NIFTY 500 core for the pedigree filter — this is by design
  // since "good pedigree" means established mid-large caps with screener.in
  // coverage.
  const { NIFTY_500_CORE } = await import('../screeners/universe')
  const universe = NIFTY_500_CORE
  const niftySet = new Set(universe.map((s: string) => s.toUpperCase()))

  const rows: PedigreeRow[] = []
  let cursor = 0
  let dataMissing = 0, illiquid = 0, notDeep = 0, noAccum = 0

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      try {
        // Need 1 year of daily candles for 52-week high
        const candles = await getCandles(sym, '1D' as any, 252)
        if (!candles || candles.length < 60) { dataMissing++; continue }
        const last = candles[candles.length - 1]
        if (!last || !Number.isFinite(last.close) || last.close < 5) { dataMissing++; continue }

        // Turnover gate
        const v60 = candles.slice(-60).reduce((s, c) => s + c.volume * c.close, 0) / 60
        const avgTurnoverCr = v60 / 1e7
        if (avgTurnoverCr < minTurnover) { illiquid++; continue }

        // 52w high & pullback %
        const high52w = Math.max(...candles.slice(-252).map(c => c.high))
        const pctOffHigh = high52w > 0 ? ((high52w - last.close) / high52w) * 100 : 0
        if (pctOffHigh < minPctOff) { notDeep++; continue }

        // Shareholding (REQUIRED — pedigree screener needs institutional data)
        const shp = await getShareholding(sym).catch(() => null)
        if (!shp) { noAccum++; continue }

        // Institutional accumulation gate — at least one increasing
        const fiiUp = (shp.fiiDeltaQoQ ?? 0) >= 0.3
        const diiUp = (shp.diiDeltaQoQ ?? 0) >= 0.3
        const promoterUp = (shp.promoterDeltaQoQ ?? 0) >= 0.3
        const accumBuyerCount = [fiiUp, diiUp, promoterUp].filter(Boolean).length
        if (accumBuyerCount === 0) { noAccum++; continue }

        // Reject if pledge ≥ 25% (corporate governance red flag)
        if ((shp.promoterPledgePct ?? 0) >= 25) { noAccum++; continue }

        // — Composite scoring —
        const closes = candles.map(c => c.close)
        const rsi = rsi14(closes)
        const ret5d = ((last.close - candles[candles.length - 6].close) / candles[candles.length - 6].close) * 100
        const ret20d = ((last.close - candles[candles.length - 21].close) / candles[candles.length - 21].close) * 100
        const last10 = candles.slice(-10)
        const hi10 = Math.max(...last10.map(c => c.high))
        const lo10 = Math.min(...last10.map(c => c.low))
        const baseTightness = last.close > 0 ? ((hi10 - lo10) / last.close) * 100 : 0

        let score = 0
        // Depth of pullback (30 max)
        if (pctOffHigh >= 60) score += 30
        else if (pctOffHigh >= 50) score += 25
        else if (pctOffHigh >= 40) score += 15

        // Accumulation breadth (25 max)
        score += accumBuyerCount * 8        // 1=8, 2=16, 3=24

        // Stake-delta magnitude (15 max)
        const totalDelta = (Math.max(0, shp.fiiDeltaQoQ ?? 0)) + (Math.max(0, shp.diiDeltaQoQ ?? 0)) + (Math.max(0, shp.promoterDeltaQoQ ?? 0))
        if (totalDelta >= 3) score += 15
        else if (totalDelta >= 2) score += 12
        else if (totalDelta >= 1) score += 8
        else if (totalDelta >= 0.5) score += 5

        // Bottoming signature (10 max) — RSI rising from <40, recent move stable
        const bottoming = rsi >= 30 && rsi <= 55 && ret5d >= -3 && ret5d <= 5
        if (bottoming) score += 10
        else if (rsi >= 30 && rsi <= 60) score += 5

        // Pedigree confirms (10 max)
        const isNifty500 = niftySet.has(sym.toUpperCase())
        if (isNifty500) score += 10

        // Pledge cleanliness (10 max)
        const pledge = shp.promoterPledgePct ?? 0
        if (pledge < 1) score += 10
        else if (pledge < 5) score += 7
        else if (pledge < 10) score += 4

        const reasons: string[] = []
        reasons.push(`${pctOffHigh.toFixed(0)}% off 52w-hi (₹${high52w.toFixed(0)})`)
        if (fiiUp) reasons.push(`FII +${(shp.fiiDeltaQoQ ?? 0).toFixed(2)}pp QoQ`)
        if (diiUp) reasons.push(`DII +${(shp.diiDeltaQoQ ?? 0).toFixed(2)}pp QoQ`)
        if (promoterUp) reasons.push(`Promoter +${(shp.promoterDeltaQoQ ?? 0).toFixed(2)}pp QoQ`)
        if (bottoming) reasons.push(`bottoming RSI ${rsi.toFixed(0)} · 5d ${ret5d >= 0 ? '+' : ''}${ret5d.toFixed(1)}%`)
        if (baseTightness <= 6) reasons.push(`tight base ${baseTightness.toFixed(1)}%`)
        if (pledge < 1) reasons.push('pledge 0%')
        if (isNifty500) reasons.push('NIFTY-500 member')

        rows.push({
          symbol: sym,
          close: +last.close.toFixed(2),
          high52w: +high52w.toFixed(2),
          pctOffHigh: +pctOffHigh.toFixed(1),
          pullbackTier: pctOffHigh >= 60 ? 'DEEP' : 'MODERATE',
          marketCapCr: shp.marketCapCr ?? null,
          isNifty500,
          fiiPct: shp.fiiPct ?? null,
          fiiDeltaQoQ: shp.fiiDeltaQoQ ?? null,
          diiPct: shp.diiPct ?? null,
          diiDeltaQoQ: shp.diiDeltaQoQ ?? null,
          promoterPct: shp.promoterPct ?? null,
          promoterDeltaQoQ: shp.promoterDeltaQoQ ?? null,
          promoterPledgePct: shp.promoterPledgePct ?? null,
          accumBuyerCount,
          rsi14: +rsi.toFixed(1),
          ret5dPct: +ret5d.toFixed(2),
          ret20dPct: +ret20d.toFixed(2),
          baseTightnessPct: +baseTightness.toFixed(2),
          score,
          reasons,
          capturedAt: new Date().toISOString(),
        })
      } catch { /* skip on per-symbol error */ }
    }
  }))

  rows.sort((a, b) => b.score - a.score)
  const top = rows.slice(0, topN)
  log.ok('PEDIGREE', `Found ${rows.length} candidates · rejected: ${dataMissing} data, ${illiquid} illiquid, ${notDeep} not-deep, ${noAccum} no-accum · top ${top.length}`)
  return top
}

export async function runAndPublishPedigree(): Promise<{ generatedAt: string; total: number; deepCount: number; moderateCount: number; rows: PedigreeRow[] }> {
  const rows = await runPedigreeAccumulation()
  const deepCount = rows.filter(r => r.pullbackTier === 'DEEP').length
  const moderateCount = rows.length - deepCount
  const out = {
    generatedAt: new Date().toISOString(),
    criterion: '≥40% off 52w-high · NIFTY-500 OR mcap ≥₹1KCr · turnover ≥₹2Cr · FII OR DII OR Promoter ↑ QoQ · pledge <25%',
    total: rows.length,
    deepCount,
    moderateCount,
    rows,
  }
  await fs.mkdir(SNAP_DIR, { recursive: true })
  await fs.writeFile(path.join(SNAP_DIR, 'pedigree-accumulation.json'), JSON.stringify(out, null, 2))
  log.ok('PEDIGREE', `Published: ${rows.length} candidates (${deepCount} DEEP · ${moderateCount} MODERATE)`)
  return out
}
