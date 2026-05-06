/**
 * Mover backfill — given a historical date window, scan a universe and report
 * every symbol that moved ≥ minPct in that window. For each mover, replay our
 * existing screeners against the candles AS-OF the day BEFORE the move started
 * and flag which screener (if any) would have caught it. Anything in the
 * mover list that no screener would have caught is a true miss — those are
 * the patterns we need to learn.
 *
 * Why this exists (2026-05-02): user pointed out we missed Crude 8200 → 9400
 * (10 sessions), Nifty 24717 → 23960 (7 sessions), and a basket of FMCG /
 * micro-cap moves over 20–30 Apr 2026. The Distribution-Top + Range-Expansion
 * screeners I just added would have flagged them; this endpoint proves it on
 * historical data and surfaces the residual misses.
 */

import * as router from '../data'
import { resolveUniverse } from './universe'
import { ADVANCED_PREMOVE_SCREENERS } from './preMoveAdvanced'
import { PREMOVE_SCREENERS } from './preMove'
import { MOVERS_SCREENERS } from './weeklyMovers'
import { log } from '../util/logger'
import type { Candle } from '../types'
import type { Screener, ScreenerResult } from './types'

export interface BackfillRow {
  symbol: string
  fromDate: string             // YYYY-MM-DD anchor (close used as ref)
  toDate: string               // YYYY-MM-DD final (close used as final)
  fromPrice: number
  toPrice: number
  movePct: number              // signed
  direction: 'UP' | 'DOWN'
  caughtBy: string[]           // screener IDs that fired ON THE BAR BEFORE the move started
  missed: boolean              // true if no screener caught it
  triggerCandle?: { date: string; close: number; reason: string }
}

export interface BackfillResult {
  fromDate: string
  toDate: string
  minPct: number
  universeKey: string
  totalScanned: number
  totalMovers: number
  caught: BackfillRow[]
  missed: BackfillRow[]
  ranAt: string
  durationMs: number
}

const SCREENERS: Screener[] = [
  ...ADVANCED_PREMOVE_SCREENERS,
  ...PREMOVE_SCREENERS,
  ...MOVERS_SCREENERS,
]

const CONCURRENCY = 2

function ymd(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

function findIndexOnOrAfter(candles: Candle[], target: Date): number {
  const ts = target.getTime()
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time >= ts) return i
  }
  return -1
}

function findIndexOnOrBefore(candles: Candle[], target: Date): number {
  const ts = target.getTime()
  let last = -1
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time <= ts) last = i
    else break
  }
  return last
}

/**
 * Replay screeners on the slice `candles[0..idx]` (inclusive), simulating the
 * point-in-time view our engine would have had at the close of bar `idx`.
 */
function replayScreeners(candles: Candle[], symbol: string, idx: number): { id: string; direction: ScreenerResult['direction']; reason: string }[] {
  const slice = candles.slice(0, idx + 1)
  const fired: { id: string; direction: ScreenerResult['direction']; reason: string }[] = []
  for (const s of SCREENERS) {
    try {
      const r = s.scan(slice, symbol)
      if (r) fired.push({ id: s.id, direction: r.direction, reason: r.reasons[0] ?? r.tags.join(' · ') })
    } catch { /* defensive */ }
  }
  return fired
}

export async function runMoverBackfill(opts: {
  from: string                // YYYY-MM-DD
  to: string                  // YYYY-MM-DD
  minPct: number              // e.g. 5
  universeKey?: string        // CNX500 default
  limitSymbols?: number
}): Promise<BackfillResult> {
  const started = Date.now()
  const fromDate = new Date(opts.from + 'T00:00:00Z')
  const toDate = new Date(opts.to + 'T23:59:59Z')
  const universeKey = opts.universeKey ?? 'CNX500'
  const fullUniverse = await resolveUniverse(universeKey)
  const universe = fullUniverse.slice(0, opts.limitSymbols ?? 500)

  const caught: BackfillRow[] = []
  const missed: BackfillRow[] = []
  let totalMovers = 0

  log.info('BACKFILL', `Scanning ${universe.length} symbols ${opts.from} → ${opts.to} (≥${opts.minPct}%)`)

  const q = [...universe]
  async function worker() {
    while (q.length) {
      const sym = q.shift()
      if (!sym) return
      try {
        const candles = await router.getCandles(sym, '1D', 400)
        if (candles.length < 30) continue

        const fromIdx = findIndexOnOrAfter(candles, fromDate)
        const toIdx = findIndexOnOrBefore(candles, toDate)
        if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) continue

        const fromBar = candles[fromIdx]
        const toBar = candles[toIdx]
        const movePct = ((toBar.close - fromBar.close) / fromBar.close) * 100
        if (Math.abs(movePct) < opts.minPct) continue

        totalMovers++
        const direction: 'UP' | 'DOWN' = movePct >= 0 ? 'UP' : 'DOWN'

        // Replay screeners on a 6-bar window ending at the move-start bar
        // (i.e. -5 … 0 sessions around fromIdx). A topping/breakout pattern
        // typically forms over 3-5 days before the realised move, so any
        // hit in this window is a "we'd have caught it" if our cron had
        // been scanning daily.
        const replayStart = Math.max(0, fromIdx - 5)
        const replayEnd = Math.max(0, fromIdx)        // up to and including move-start bar
        const allFired: { id: string; direction: ScreenerResult['direction']; reason: string; offset: number }[] = []
        for (let bi = replayStart; bi <= replayEnd; bi++) {
          const fired = replayScreeners(candles, sym, bi)
          for (const f of fired) allFired.push({ ...f, offset: bi - fromIdx })
        }
        // Filter to setups whose direction matches the realised move and
        // dedupe by screener id (keep the earliest hit).
        const seen = new Set<string>()
        const matching: { id: string; direction: ScreenerResult['direction']; reason: string; offset: number }[] = []
        for (const f of allFired) {
          const dirOk = (direction === 'UP' && f.direction === 'BULL') ||
                        (direction === 'DOWN' && f.direction === 'BEAR')
          if (!dirOk) continue
          if (seen.has(f.id)) continue
          seen.add(f.id)
          matching.push(f)
        }

        const earliest = matching[0]
        const trigBar = earliest ? candles[fromIdx + earliest.offset] : undefined
        const row: BackfillRow = {
          symbol: sym,
          fromDate: ymd(fromBar.time),
          toDate: ymd(toBar.time),
          fromPrice: +fromBar.close.toFixed(2),
          toPrice: +toBar.close.toFixed(2),
          movePct: +movePct.toFixed(2),
          direction,
          caughtBy: matching.map(m => m.id),
          missed: matching.length === 0,
          triggerCandle: trigBar
            ? { date: ymd(trigBar.time), close: +trigBar.close.toFixed(2), reason: earliest!.reason }
            : undefined,
        }
        if (row.missed) missed.push(row)
        else caught.push(row)
      } catch (e) {
        log.warn('BACKFILL', `${sym}: ${(e as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

  caught.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct))
  missed.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct))

  const out: BackfillResult = {
    fromDate: opts.from,
    toDate: opts.to,
    minPct: opts.minPct,
    universeKey,
    totalScanned: universe.length,
    totalMovers,
    caught,
    missed,
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  }
  log.ok('BACKFILL', `Done: ${totalMovers} movers · caught ${caught.length} · missed ${missed.length} in ${(out.durationMs / 1000).toFixed(1)}s`)
  return out
}
