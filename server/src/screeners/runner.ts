import * as router from '../data'
import { log } from '../util/logger'
import { MONEYFLOW_SCREENERS } from './moneyFlow'
import { SWING_SCREENERS } from './swing'
import { MULTIBAGGER_SCREENERS } from './multibagger'
import { PREMOVE_SCREENERS } from './preMove'
import { ADVANCED_PREMOVE_SCREENERS } from './preMoveAdvanced'
import { PRECISION_SCREENERS } from './preciseScreens'
import { customRulesScreener } from './customRules'
import { MOVERS_SCREENERS } from './weeklyMovers'
import { PRO_SCREENERS } from './proScreener'
import { UNIVERSES, resolveUniverse, NIFTY_500_CORE } from './universe'
import type { ScanRun, Screener, ScreenerResult } from './types'
import type { Candle } from '../types'

/**
 * Splice a synthetic "now" candle on top of cached daily candles using the
 * live LTP. Returns a NEW array (no mutation — daily candles are cached
 * across screeners). Skipped when LTP is within 5 bps of the EOD close.
 * Same helper as signalEngine.overlayLivePrice.
 */
function overlayLivePrice(candles: Candle[], livePx: number): Candle[] {
  if (!candles.length) return candles
  const last = candles[candles.length - 1]
  if (last.close <= 0) return candles
  // Sanity guard — same as signalEngine.overlayLivePrice. Keeps a junk
  // quote (e.g. 0.30 returned for GOLD by a misrouted API) from collapsing
  // the spot and producing strike-zero option signals.
  const drift = Math.abs(livePx - last.close) / last.close
  if (drift > 0.30) return candles
  if (drift < 0.0005) return candles
  return [...candles.slice(0, -1), {
    ...last,
    time: Date.now(),
    close: livePx,
    high: Math.max(last.high, livePx),
    low: Math.min(last.low, livePx),
  }]
}

/**
 * Scan runner. Iterates a universe of symbols, fetches daily candles via the
 * data router (Angel-preferred), runs each screener, and returns enriched
 * results. Throttled to ~3 concurrent requests so we stay inside Angel's
 * rate budget.
 */

const CONCURRENCY = 3

export type ScannerBucket = 'moneyflow' | 'swing' | 'multibagger' | 'premove' | 'movers' | 'pro'

function screenersFor(bucket: ScannerBucket): Screener[] {
  switch (bucket) {
    case 'moneyflow': return [...MONEYFLOW_SCREENERS, ...PRECISION_SCREENERS, customRulesScreener]
    case 'swing': return [...SWING_SCREENERS, customRulesScreener]
    case 'multibagger': return [...MULTIBAGGER_SCREENERS]
    case 'premove': return [...PREMOVE_SCREENERS, ...ADVANCED_PREMOVE_SCREENERS, ...PRECISION_SCREENERS, customRulesScreener]
    case 'movers': return [...MOVERS_SCREENERS]
    case 'pro': return [...PRO_SCREENERS]
  }
}

async function universeFor(bucket: ScannerBucket, key?: string): Promise<string[]> {
  if (key) return resolveUniverse(key)
  if (bucket === 'multibagger') {
    return [...new Set([...UNIVERSES.MIDCAP.symbols, ...UNIVERSES.SMALLCAP.symbols])]
  }
  if (bucket === 'movers') return resolveUniverse('NSE_ALL')
  // Pro screener defaults to the curated CNX 500 — wide enough to find pre-
  // move setups but tight enough to keep run-time under 60 s on free Angel.
  // Override via ?universe=NSE_ALL when you want the long-tail microcap sweep.
  if (bucket === 'pro') return NIFTY_500_CORE
  return NIFTY_500_CORE
}

let latestRuns: Record<ScannerBucket, ScanRun | null> = {
  moneyflow: null,
  swing: null,
  multibagger: null,
  premove: null,
  movers: null,
  pro: null,
}

export function getLatestRun(bucket: ScannerBucket): ScanRun | null {
  return latestRuns[bucket]
}

export async function runScan(bucket: ScannerBucket, opts: { limitSymbols?: number; universeKey?: string } = {}): Promise<ScanRun> {
  const screeners = screenersFor(bucket)
  const fullUniverse = await universeFor(bucket, opts.universeKey)
  const universe = fullUniverse.slice(0, opts.limitSymbols ?? 200)
  const started = Date.now()
  const results: ScreenerResult[] = []

  log.info('SCAN', `Running ${bucket} over ${universe.length} symbols, ${screeners.length} screeners`)

  // Concurrency-limited fetch loop
  const q = [...universe]
  async function worker() {
    while (q.length) {
      const sym = q.shift()
      if (!sym) return
      try {
        // Daily candles + live quote in parallel — see signalEngine.scanSymbol
        // for the same overlay pattern. Splices a synthetic "now" candle so
        // every screener (Multibagger / Pre-Move / Movers / Money Flow /
        // Swing / Pro) reads the live LTP, not yesterday's close.
        const [candlesRaw, quote] = await Promise.all([
          router.getCandles(sym, '1D', 300),
          router.getQuote(sym).catch(() => null),
        ])
        if (candlesRaw.length < 50) continue

        const livePx = quote?.price && quote.price > 0 ? quote.price : null
        const candles = livePx != null ? overlayLivePrice(candlesRaw, livePx) : candlesRaw

        // Augment last candle's change/changePct vs prior close
        const latest = candles[candles.length - 1]
        const prior = candles[candles.length - 2]
        const change = prior ? latest.close - prior.close : 0
        const changePct = prior ? (change / prior.close) * 100 : 0

        for (const s of screeners) {
          const r = s.scan(candles, sym)
          if (r) {
            r.change = +change.toFixed(2)
            r.changePct = +changePct.toFixed(2)
            results.push(r)
          }
        }
      } catch (e) {
        log.warn('SCAN', `${sym}: ${(e as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  results.sort((a, b) => b.score - a.score)
  const run: ScanRun = {
    startedAt: started,
    finishedAt: Date.now(),
    universe: bucket,
    totalScanned: universe.length,
    screenersRun: screeners.length,
    results,
  }
  latestRuns[bucket] = run
  log.ok('SCAN', `${bucket} complete: ${results.length} setups in ${((run.finishedAt - started) / 1000).toFixed(1)}s`)
  return run
}
