/**
 * Lifecycle backfill — resolves stale OPEN (PENDING / ACTIVE) trades by
 * walking their full candle history from entry date to now.
 *
 * Why this exists (2026-07-15):
 * The original lifecycle checker (checkTransitions in signalLifecycle.ts) only
 * used the CURRENT LTP as a single price point. So if a signal opened for
 * RELIANCE at 1400 with T1=1450 and the stock tagged 1470 intraday last
 * week but is now at 1420 — the T1 hit was never recorded. Over 19,000
 * WEEKLY signals sat in this limbo, dragging the reported win-rate to 0%
 * despite many having actually hit targets. This module fixes that by
 * consulting the full daily-candle path since entry.
 *
 * Rules:
 * - PENDING → ACTIVE: entry level crossed (range [low, high] contains entry)
 * - ACTIVE → SL_HIT: for BUY, candle low ≤ SL; for SHORT, candle high ≥ SL
 * - ACTIVE → T*_HIT: for BUY, candle high ≥ target; for SHORT, candle low ≤ target
 *   (highest target that fits within candle range wins)
 * - Same-candle both SL and target: SL wins (conservative — protects
 *   accuracy metrics from optimistic bias when we can't see intra-candle path)
 * - ACTIVE past target3Date + not hit: EXPIRED
 * - Stops if a terminal state is reached first
 */

import path from 'path'
import fs from 'fs/promises'
import { getCandles } from '../data/index'
import { log } from '../util/logger'
import type { Candle } from '../types'
import type { LifecycleEntry, LifecycleStatus, LifecycleStore } from './signalLifecycle'

const DATA_DIR = path.resolve(__dirname, '../../data')
const LIFECYCLE_FILE = path.join(DATA_DIR, 'signal-lifecycle.json')

async function loadStoreRaw(): Promise<LifecycleStore> {
  try {
    const raw = await fs.readFile(LIFECYCLE_FILE, 'utf8')
    const s = JSON.parse(raw) as LifecycleStore
    if (!s.entries) s.entries = {}
    return s
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), entries: {} }
  }
}

async function saveStoreRaw(store: LifecycleStore): Promise<void> {
  store.updatedAt = new Date().toISOString()
  const tmp = LIFECYCLE_FILE + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(store, null, 2))
  await fs.rename(tmp, LIFECYCLE_FILE)
}

interface WalkResult {
  finalStatus: LifecycleStatus
  hitPrice?: number
  hitAt?: string           // ISO of the candle that produced the hit
  triggeredAt?: string     // ISO of the candle that flipped PENDING→ACTIVE (if applicable)
}

/**
 * Walk a candle series and determine what actually happened to this trade.
 * Returns the deepest terminal state reached; if none was reached, returns
 * the current status unchanged.
 */
export function walkCandles(entry: LifecycleEntry, candles: Candle[]): WalkResult {
  let status: LifecycleStatus = entry.status
  const dir = entry.direction   // 'BUY' | 'SHORT'
  const sl = entry.stopLoss
  const t1 = entry.target1
  const t2 = entry.target2
  const t3 = entry.target3
  const entryLow = entry.entryPriceLow || entry.entryPrice
  const entryHigh = entry.entryPriceHigh || entry.entryPrice

  const targetHitAt = (candle: Candle): 'T1_HIT' | 'T2_HIT' | 'T3_HIT' | null => {
    if (dir === 'BUY') {
      // Prefer highest target that fits under candle high
      if (t3 && candle.high >= t3) return 'T3_HIT'
      if (t2 && candle.high >= t2) return 'T2_HIT'
      if (t1 && candle.high >= t1) return 'T1_HIT'
    } else {
      // SHORT — target below entry, hit when candle low ≤ target
      if (t3 && candle.low <= t3) return 'T3_HIT'
      if (t2 && candle.low <= t2) return 'T2_HIT'
      if (t1 && candle.low <= t1) return 'T1_HIT'
    }
    return null
  }

  const slHitAt = (candle: Candle): boolean => {
    if (!sl) return false
    if (dir === 'BUY') return candle.low <= sl
    return candle.high >= sl
  }

  let triggeredAt: string | undefined = entry.triggeredAt
  let hitPrice: number | undefined
  let hitAt: string | undefined

  for (const c of candles) {
    const iso = new Date(c.time).toISOString()

    if (status === 'PENDING') {
      // Entry crosses when candle range touches entry band
      const touched = c.low <= entryHigh && c.high >= entryLow
      if (touched) {
        status = 'ACTIVE'
        triggeredAt = iso
      } else {
        // Check if the market already surpassed the entry level without
        // touching it (gapped through) — count as ACTIVE at that point.
        if (dir === 'BUY' && c.close > entryHigh) { status = 'ACTIVE'; triggeredAt = iso }
        else if (dir === 'SHORT' && c.close < entryLow) { status = 'ACTIVE'; triggeredAt = iso }
      }
    }

    if (status === 'ACTIVE') {
      // Conservative rule: if the SAME candle contains both target and SL,
      // give SL priority (we can't see intra-candle path, so worst-case).
      const slIn = slHitAt(c)
      const tgt = targetHitAt(c)
      if (slIn && tgt) {
        status = 'SL_HIT'
        hitPrice = sl
        hitAt = iso
        break
      }
      if (slIn) {
        status = 'SL_HIT'
        hitPrice = sl
        hitAt = iso
        break
      }
      if (tgt) {
        status = tgt
        hitPrice = tgt === 'T3_HIT' ? t3 : tgt === 'T2_HIT' ? t2 : t1
        hitAt = iso
        break
      }
    }
  }

  return { finalStatus: status, hitPrice, hitAt, triggeredAt }
}

export interface BackfillResult {
  scannedEntries: number
  entriesUnchanged: number
  entriesResolved: number
  entriesTriggered: number   // moved PENDING → ACTIVE (no terminal yet)
  entriesExpired: number
  entriesSkipped: number     // no candles / bad symbol
  byNewStatus: Record<string, number>
  bySource: Record<string, { resolved: number; won: number; lost: number; expired: number }>
  errors: number
}

/**
 * Symbol-agnostic candle fetcher wrapper. Uses daily candles up to `count`
 * bars back. Some engines may prefer 4h — but for backfill of trade
 * outcomes (which live days to weeks), daily is the right granularity.
 */
async function loadCandlesForSymbol(symbol: string, entrySinceMs: number): Promise<Candle[]> {
  const daysBack = Math.max(30, Math.ceil((Date.now() - entrySinceMs) / 86_400_000) + 5)
  const candles = await getCandles(symbol, '1D', Math.min(daysBack, 800))
  if (!Array.isArray(candles) || candles.length === 0) return []
  // Keep only candles from entrySinceMs onwards.
  const cutoff = entrySinceMs - 86_400_000   // include the day before to catch same-day fills
  return candles.filter(c => c.time >= cutoff)
}

/**
 * Run backfill across all PENDING + ACTIVE entries. Can be called from the
 * daily EOD routine + on-demand via the CLI.
 */
export async function backfillAllOpenLifecycle(opts: {
  maxEntries?: number       // cap for one-run safety
  onlySources?: string[]    // e.g. ['WEEKLY', 'OPTIONS'] — skip everything else
  concurrency?: number      // symbol concurrency
} = {}): Promise<BackfillResult> {
  const store = await loadStoreRaw()
  const concurrency = opts.concurrency ?? 6
  const maxEntries = opts.maxEntries ?? 5000
  const sourceFilter = opts.onlySources ? new Set(opts.onlySources) : null

  const openEntries = Object.values(store.entries).filter(e => {
    if (e.status !== 'PENDING' && e.status !== 'ACTIVE') return false
    if (sourceFilter && !sourceFilter.has(e.source)) return false
    return true
  }).slice(0, maxEntries)

  const result: BackfillResult = {
    scannedEntries: openEntries.length,
    entriesUnchanged: 0,
    entriesResolved: 0,
    entriesTriggered: 0,
    entriesExpired: 0,
    entriesSkipped: 0,
    byNewStatus: {},
    bySource: {},
    errors: 0,
  }

  if (openEntries.length === 0) return result

  // Group by symbol so we fetch candles once per symbol.
  const bySym = new Map<string, LifecycleEntry[]>()
  for (const e of openEntries) {
    const list = bySym.get(e.symbol) ?? []
    list.push(e)
    bySym.set(e.symbol, list)
  }
  const symbols = Array.from(bySym.keys())

  log.info('LIFECYCLE-BACKFILL', `starting: ${openEntries.length} open entries across ${symbols.length} symbols`)

  let cursor = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < symbols.length) {
      const sym = symbols[cursor++]
      const entries = bySym.get(sym) ?? []
      let candles: Candle[] = []
      try {
        // Use earliest entry's firstSeenAt to fetch enough candle history.
        const earliestMs = Math.min(...entries.map(e => {
          const t = Date.parse(e.triggeredAt ?? e.firstSeenAt ?? e.lastSeenAt ?? new Date().toISOString())
          return Number.isFinite(t) ? t : Date.now()
        }))
        candles = await loadCandlesForSymbol(sym, earliestMs)
      } catch (e) {
        result.errors++
        continue
      }
      if (candles.length === 0) {
        result.entriesSkipped += entries.length
        continue
      }

      for (const entry of entries) {
        const entrySinceMs = Date.parse(entry.triggeredAt ?? entry.firstSeenAt ?? entry.lastSeenAt)
        const relevantCandles = Number.isFinite(entrySinceMs)
          ? candles.filter(c => c.time >= entrySinceMs - 86_400_000)
          : candles
        if (relevantCandles.length === 0) {
          result.entriesSkipped++
          continue
        }

        const walk = walkCandles(entry, relevantCandles)
        const before = entry.status
        if (walk.finalStatus === before) {
          // Check if entry is past target3Date without a hit → EXPIRED
          const nowMs = Date.now()
          const t3Ms = Date.parse(entry.target3Date || entry.target2Date || entry.target1Date || '')
          if (before === 'ACTIVE' && Number.isFinite(t3Ms) && nowMs > t3Ms + 3 * 86_400_000) {
            entry.status = 'EXPIRED'
            entry.statusChangedAt = new Date().toISOString()
            entry.statusReason = 'Backfill: past target3Date + no hit'
            result.entriesExpired++
            result.byNewStatus.EXPIRED = (result.byNewStatus.EXPIRED ?? 0) + 1
            const b = result.bySource[entry.source] ??= { resolved: 0, won: 0, lost: 0, expired: 0 }
            b.expired++
            continue
          }
          result.entriesUnchanged++
          continue
        }

        // Terminal or transition update
        entry.status = walk.finalStatus
        entry.statusChangedAt = walk.hitAt ?? new Date().toISOString()
        entry.statusReason = 'Backfill from candle history'
        if (walk.hitPrice != null) entry.hitPrice = walk.hitPrice
        if (walk.hitAt) entry.hitAt = walk.hitAt
        if (walk.triggeredAt && !entry.triggeredAt) entry.triggeredAt = walk.triggeredAt

        result.byNewStatus[walk.finalStatus] = (result.byNewStatus[walk.finalStatus] ?? 0) + 1

        if (walk.finalStatus === 'ACTIVE') {
          result.entriesTriggered++
        } else if (['T1_HIT', 'T2_HIT', 'T3_HIT', 'SL_HIT', 'EXPIRED'].includes(walk.finalStatus)) {
          result.entriesResolved++
          const b = result.bySource[entry.source] ??= { resolved: 0, won: 0, lost: 0, expired: 0 }
          b.resolved++
          if (walk.finalStatus === 'SL_HIT') b.lost++
          else if (walk.finalStatus === 'EXPIRED') b.expired++
          else b.won++
        }
      }
    }
  }))

  await saveStoreRaw(store)
  log.ok('LIFECYCLE-BACKFILL', `done · resolved ${result.entriesResolved} · triggered ${result.entriesTriggered} · expired ${result.entriesExpired} · unchanged ${result.entriesUnchanged} · skipped ${result.entriesSkipped}`)
  return result
}
