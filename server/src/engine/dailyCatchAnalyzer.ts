/**
 * Daily Catch-Rate Analyzer — measurable feedback loop on the user's #1 goal:
 * "identify the move BEFORE it happens".
 *
 * What it does (runs at 17:30 IST every weekday after market close):
 *   1. Pull the universe (NSE_ALL ~3000 symbols).
 *   2. Compute today's intraday return for each: (close - prev_close) / prev_close.
 *   3. Pick the top-100 gainers (≥ 3 % move).
 *   4. For each gainer, fetch its candles up to YESTERDAY (T-1) and replay every
 *      ACTIVE pre-move screener as it would have run yesterday evening.
 *   5. Record per-stock: did ANY screener fire on T-1? Which one(s)?
 *   6. Persist to data/learning/daily-catch-YYYY-MM-DD.json with:
 *        catchRate            % of top-100 gainers caught by ≥ 1 screener
 *        perScreenerCounts    how many movers each screener flagged
 *        missedSamples        20 examples of misses (sym + return + features)
 *
 * Why this matters: until we MEASURE catch-rate per day, every "the system
 * doesn't catch moves" complaint is anecdotal. With this report, the system
 * audits itself daily and a learning loop (next iteration) can auto-tune the
 * borderline screeners against the actual miss profile.
 *
 * Token-cheap design: no external API beyond getCandles/Quote we already use.
 * Caps universe at 500 (sampled) so it completes inside the 10-minute eod
 * window even on slow Yahoo days.
 */
import fs from 'fs/promises'
import path from 'path'
import * as data from '../data'
import { resolveUniverse } from '../screeners/universe'
import { ADVANCED_PREMOVE_ACTIVE } from '../screeners/preMoveAdvanced'
import { ema, lastATR, lastRSI } from '../indicators'
import { log } from '../util/logger'
import type { Candle } from '../types'

const LEARNING_DIR = path.resolve(__dirname, '../../data/learning')

export interface CatchReport {
  ranAt: string
  date: string                        // YYYY-MM-DD (IST)
  universeSize: number                // # symbols scanned
  topGainersCount: number             // size of the cohort tested
  catches: number                     // top-gainers our screeners detected on T-1
  catchRate: number                   // catches / topGainersCount
  perScreenerCounts: Record<string, number>
  missedSamples: Array<{
    symbol: string
    todayPct: number
    rsi: number
    offHighPct: number
    volRatio: number
    range10Pct: number
    atrPct: number
    aboveEma50: boolean
    aboveEma200: boolean
  }>
  caughtSamples: Array<{
    symbol: string
    todayPct: number
    screeners: string[]
  }>
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(LEARNING_DIR, { recursive: true }).catch(() => {})
}

function featuresOf(candles: Candle[]): {
  rsi: number; offHighPct: number; volRatio: number; range10Pct: number; atrPct: number;
  aboveEma50: boolean; aboveEma200: boolean
} {
  const last = candles[candles.length - 1]
  const high60 = Math.max(...candles.slice(-60).map(c => c.high))
  const offHigh = (high60 - last.close) / high60 * 100
  const v20 = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20
  const v60 = candles.slice(-60).reduce((s, c) => s + c.volume, 0) / 60
  const last10 = candles.slice(-10)
  const r10 = (Math.max(...last10.map(c => c.high)) - Math.min(...last10.map(c => c.low))) / last.close * 100
  const rsi = lastRSI(candles, 14) ?? 50
  const atrPct = ((lastATR(candles, 14) ?? last.close * 0.02) / last.close) * 100
  const e50 = ema(candles, 50); const e200 = ema(candles, 200)
  return {
    rsi: +rsi.toFixed(1),
    offHighPct: +offHigh.toFixed(1),
    volRatio: +(v60 > 0 ? v20 / v60 : 1).toFixed(2),
    range10Pct: +r10.toFixed(1),
    atrPct: +atrPct.toFixed(2),
    aboveEma50: last.close > (e50[e50.length - 1] ?? Infinity),
    aboveEma200: last.close > (e200[e200.length - 1] ?? Infinity),
  }
}

export async function runDailyCatchAnalyzer(opts: { universeSample?: number; topN?: number } = {}): Promise<CatchReport> {
  await ensureDir()
  const sampleSize = opts.universeSample ?? 500
  const topN = opts.topN ?? 100
  // 1. Universe
  const all = await resolveUniverse('NSE_ALL').catch(() => [] as string[])
  // Random sample so we don't always test the same 500 (deterministic per-day
  // seed via the date string so two runs on the same day are reproducible).
  const seed = new Date().getUTCDate() + new Date().getUTCMonth() * 31
  const universe = all.slice().sort((a, b) => ((a.charCodeAt(0) + seed) % 7) - ((b.charCodeAt(0) + seed) % 7)).slice(0, sampleSize)
  log.info('CATCH', `Sampling ${universe.length} of ${all.length} NSE_ALL symbols`)

  // 2-3. Today's gainers — concurrent quote fetch
  const gainers: Array<{ sym: string; pct: number }> = []
  let cursor = 0
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      try {
        const q = await data.getQuote(sym)
        const pct = q?.changePct ?? 0
        if (pct >= 3) gainers.push({ sym, pct })
      } catch { /* skip */ }
    }
  }))
  gainers.sort((a, b) => b.pct - a.pct)
  const cohort = gainers.slice(0, topN)
  log.info('CATCH', `Today's gainers ≥ 3%: ${gainers.length} · testing top ${cohort.length}`)

  // 4-5. Replay screeners on T-1 candles
  const perScreener: Record<string, number> = {}
  for (const s of ADVANCED_PREMOVE_ACTIVE) perScreener[s.id] = 0
  let catches = 0
  const caughtSamples: CatchReport['caughtSamples'] = []
  const missedSamples: CatchReport['missedSamples'] = []
  cursor = 0
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (cursor < cohort.length) {
      const { sym, pct } = cohort[cursor++]
      try {
        const candles = await data.getCandles(sym, '1D', 100)
        if (candles.length < 60) continue
        // T-1 = drop the most recent (today's) candle.
        const t1 = candles.slice(0, -1)
        const hits: string[] = []
        for (const scr of ADVANCED_PREMOVE_ACTIVE) {
          try {
            const r = scr.scan(t1, sym)
            if (r) { hits.push(scr.id); perScreener[scr.id]++ }
          } catch { /* skip */ }
        }
        if (hits.length) {
          catches++
          if (caughtSamples.length < 50) caughtSamples.push({ symbol: sym, todayPct: pct, screeners: hits })
        } else {
          if (missedSamples.length < 20) missedSamples.push({ symbol: sym, todayPct: pct, ...featuresOf(t1) })
        }
      } catch { /* skip */ }
    }
  }))
  const catchRate = cohort.length ? catches / cohort.length : 0
  log.ok('CATCH', `Catch-rate ${(catchRate * 100).toFixed(1)}% (${catches}/${cohort.length}) · per-screener: ${JSON.stringify(perScreener)}`)

  const date = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
  const report: CatchReport = {
    ranAt: new Date().toISOString(),
    date,
    universeSize: universe.length,
    topGainersCount: cohort.length,
    catches,
    catchRate: +catchRate.toFixed(3),
    perScreenerCounts: perScreener,
    missedSamples,
    caughtSamples,
  }
  await fs.writeFile(path.join(LEARNING_DIR, `daily-catch-${date}.json`), JSON.stringify(report, null, 2)).catch(() => {})
  return report
}

/** Read the most recent catch-rate report (used by /api/catch-rate). */
export async function getLatestCatchReport(): Promise<CatchReport | null> {
  try {
    const files = (await fs.readdir(LEARNING_DIR)).filter(f => f.startsWith('daily-catch-')).sort().reverse()
    if (!files.length) return null
    const raw = await fs.readFile(path.join(LEARNING_DIR, files[0]), 'utf8')
    return JSON.parse(raw) as CatchReport
  } catch { return null }
}

/** Aggregated catch-rate over the last N days. */
export async function getCatchRateRolling(daysBack = 30): Promise<{
  days: number; runs: number; avgCatchRate: number; perScreenerAvg: Record<string, number>
}> {
  try {
    const files = (await fs.readdir(LEARNING_DIR))
      .filter(f => f.startsWith('daily-catch-'))
      .sort()
      .slice(-daysBack)
    const reports = await Promise.all(files.map(async f => {
      try { return JSON.parse(await fs.readFile(path.join(LEARNING_DIR, f), 'utf8')) as CatchReport } catch { return null }
    }))
    const valid = reports.filter((r): r is CatchReport => r != null)
    const avgCatchRate = valid.length ? valid.reduce((s, r) => s + r.catchRate, 0) / valid.length : 0
    const perScreenerAvg: Record<string, number> = {}
    for (const r of valid) {
      for (const [k, v] of Object.entries(r.perScreenerCounts)) {
        perScreenerAvg[k] = (perScreenerAvg[k] ?? 0) + v
      }
    }
    for (const k of Object.keys(perScreenerAvg)) perScreenerAvg[k] = +(perScreenerAvg[k] / Math.max(1, valid.length)).toFixed(1)
    return { days: daysBack, runs: valid.length, avgCatchRate: +avgCatchRate.toFixed(3), perScreenerAvg }
  } catch { return { days: daysBack, runs: 0, avgCatchRate: 0, perScreenerAvg: {} } }
}
