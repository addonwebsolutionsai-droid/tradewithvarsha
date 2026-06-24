/**
 * Signal Lifecycle — persistent record of every weekly/daily pick ever issued
 * with state transitions: ACTIVE → SUPERSEDED / T*_HIT / SL_HIT / EXPIRED.
 *
 * 2026-05-08: Built after user reported that signals silently disappearing on
 * fresh runs (HIKAL was in Tuesday's weekly pick, gone Wednesday) destroys
 * trust. He'd already opened a position. From now on:
 *
 *   - Picks are PERSISTED in data/signal-lifecycle.json
 *   - On each fresh run, we MERGE (don't replace): existing rows that no
 *     longer qualify are marked SUPERSEDED with a reason — strike-through
 *     in UI, not silent removal.
 *   - Targets and SL outcomes are detected and stamped permanently.
 *   - Telegram dispatches state-change events so the user is never surprised.
 *
 * Storage format: append-only JSON map keyed by entry id (uuid v4).
 * Read in full on every operation. ~50–200 entries total — no perf concern.
 */
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { log } from '../util/logger'

const DATA_DIR = path.resolve(__dirname, '../../data')
const LIFECYCLE_FILE = path.join(DATA_DIR, 'signal-lifecycle.json')
const HORIZON_DAYS = 28              // weekly picks: 6-week horizon, 28 trading days
const MATERIAL_PRICE_DELTA = 0.05    // re-stamp prices when entry/SL/T move > 5%

/**
 * State machine for every tracked signal across the system.
 *
 *   PENDING     ← signal generated, waiting for LTP to reach entry range
 *      ↓
 *   ACTIVE      ← LTP entered [entryLow, entryHigh] (or ±0.5% of single entry)
 *      ↓
 *   T1_HIT / T2_HIT / T3_HIT  ← target reached (preserved permanently)
 *   SL_HIT                    ← stop-loss reached
 *   EXPIRED                   ← entry window passed without trigger (PENDING)
 *                              OR 28+ days in ACTIVE without target
 *   SUPERSEDED                ← removed from a fresh pick run (with reason)
 *   INVALIDATED               ← pattern broke before entry triggered
 */
export type LifecycleStatus =
  | 'PENDING' | 'ACTIVE' | 'SUPERSEDED'
  | 'T1_HIT' | 'T2_HIT' | 'T3_HIT' | 'SL_HIT'
  | 'EXPIRED' | 'INVALIDATED'

export interface LifecycleEntry {
  id: string                          // uuid v4
  source: 'WEEKLY' | 'DAILY' | 'MASTER' | 'OPTIONS' | 'INTRADAY' | 'TURTLE' | 'FIB' | 'HARMONIC' | 'PREMOVE'
  symbol: string
  direction: 'BUY' | 'SHORT'
  // Trade plan (snapshot when status was last ACTIVE)
  ltp: number
  entryPrice: number
  entryPriceLow: number
  entryPriceHigh: number
  entryDate: string
  stopLoss: number
  target1: number; target1Date: string
  target2: number; target2Date: string
  target3: number; target3Date: string
  conviction: number
  convictionPrev?: number             // last conviction before SUPERSEDED, for context
  noBrainerBet: boolean
  shareholdingNote: string
  reasoning: string
  bucket?: 'FIRST_BASE' | 'WAVE_2'
  // Lifecycle
  status: LifecycleStatus
  firstSeenAt: string                 // first time this (symbol|direction) ever appeared
  lastSeenAt: string                  // most recent run that included it as ACTIVE
  statusChangedAt: string
  statusReason?: string
  hitPrice?: number
  hitAt?: string
  // 2026-05-11: price watermarks observed since signal generation. Used by
  // the periodic checker to detect SL_HIT / T*_HIT without re-fetching full
  // historical candles each cycle.
  highSinceGenerated?: number
  lowSinceGenerated?: number
  lastSeenLtp?: number
  lastLtpAt?: string                    // last time we read live LTP for this entry
  // Time tracking for accuracy reporting
  triggeredAt?: string                  // when status went PENDING → ACTIVE
}

export interface LifecycleStore {
  version: 1
  updatedAt: string
  entries: Record<string, LifecycleEntry>      // keyed by id
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {})
}

export async function loadStore(): Promise<LifecycleStore> {
  await ensureDir()
  try {
    const raw = await fs.readFile(LIFECYCLE_FILE, 'utf8')
    const s = JSON.parse(raw) as LifecycleStore
    if (!s.entries) s.entries = {}
    return s
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), entries: {} }
  }
}

// 2026-05-18: serialise writes via an in-process queue + atomic rename.
// Previous direct fs.writeFile races corrupted the JSON (extra braces from
// interleaved writes). Now: every save waits for the prior save to finish,
// and we write to a temp file then rename — eliminates partial reads.
let _saveChain: Promise<void> = Promise.resolve()
async function saveStore(store: LifecycleStore): Promise<void> {
  store.updatedAt = new Date().toISOString()
  const job = _saveChain.then(async () => {
    const tmp = LIFECYCLE_FILE + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(store, null, 2))
    await fs.rename(tmp, LIFECYCLE_FILE)
  }).catch(() => { /* swallow per-save errors, keep chain alive */ })
  _saveChain = job
  await job
}

/** Find an ACTIVE entry that matches (symbol, direction, source). */
function findActiveMatch(store: LifecycleStore, source: string, symbol: string, direction: string): LifecycleEntry | null {
  for (const e of Object.values(store.entries)) {
    if (e.source !== source) continue
    if (e.symbol !== symbol) continue
    if (e.direction !== direction) continue
    if (e.status !== 'ACTIVE') continue
    return e
  }
  return null
}

function pricesMaterialChange(prev: LifecycleEntry, fresh: any): boolean {
  const prevEntry = prev.entryPrice ?? prev.entryPriceLow
  const newEntry = fresh.entryPrice ?? fresh.entryPriceLow
  if (!prevEntry || !newEntry) return false
  const delta = Math.abs(newEntry - prevEntry) / prevEntry
  return delta > MATERIAL_PRICE_DELTA
}

function rowToEntryShape(row: any): Omit<LifecycleEntry, 'id' | 'status' | 'firstSeenAt' | 'lastSeenAt' | 'statusChangedAt' | 'source'> & { bucket?: string } {
  return {
    symbol: row.symbol,
    direction: row.direction,
    ltp: row.ltp,
    entryPrice: row.entryPrice,
    entryPriceLow: row.entryPriceLow ?? row.entryPrice,
    entryPriceHigh: row.entryPriceHigh ?? row.entryPrice,
    entryDate: row.entryDate ?? '',
    stopLoss: row.stopLoss,
    target1: row.target1, target1Date: row.target1Date ?? '',
    target2: row.target2, target2Date: row.target2Date ?? '',
    target3: row.target3, target3Date: row.target3Date ?? '',
    conviction: row.conviction,
    noBrainerBet: !!row.noBrainerBet,
    shareholdingNote: row.shareholdingNote ?? '',
    reasoning: row.flowNote ?? row.reasoning ?? '',
    bucket: row.bucket,
  }
}

/**
 * Merge a fresh weekly-pick run into the lifecycle.
 *
 * Returns a "merged" view of all rows the user should see:
 *   - ACTIVE entries (current picks, sorted by conviction)
 *   - Recent SUPERSEDED / T*_HIT / SL_HIT / INVALIDATED entries (last 21 days)
 *
 * Side effect: persists the merged store to disk + emits state-change events
 * so callers can dispatch Telegram notifications.
 */
export interface MergeReport {
  newAdded: LifecycleEntry[]        // first time seeing this (symbol|direction)
  refreshed: LifecycleEntry[]        // existing ACTIVE, plan unchanged or same-shape
  rePriced: LifecycleEntry[]         // ACTIVE but plan materially updated
  superseded: LifecycleEntry[]       // were ACTIVE, now demoted
}

export async function mergeWeeklyPickRun(rows: any[], source: 'WEEKLY' | 'DAILY' = 'WEEKLY'): Promise<{
  store: LifecycleStore
  report: MergeReport
  mergedView: LifecycleEntry[]       // ACTIVE + recent terminal states for display
}> {
  const store = await loadStore()
  const now = new Date().toISOString()
  const report: MergeReport = { newAdded: [], refreshed: [], rePriced: [], superseded: [] }

  // 1. Process every fresh row — match against existing ACTIVE
  const seenIds = new Set<string>()
  for (const row of rows) {
    if (!row.symbol || !row.direction) continue
    const existing = findActiveMatch(store, source, row.symbol, row.direction)
    if (existing) {
      seenIds.add(existing.id)
      const fresh = rowToEntryShape(row)
      const material = pricesMaterialChange(existing, fresh)
      // Update fields in place — preserves id, firstSeenAt, status timestamps
      Object.assign(existing, fresh)
      existing.lastSeenAt = now
      if (material) report.rePriced.push(existing)
      else report.refreshed.push(existing)
    } else {
      // 2026-05-11: new entries start in PENDING. The periodic LTP checker
      // transitions PENDING → ACTIVE when price reaches the entry zone.
      // Pre-existing ACTIVE entries from before this change are preserved.
      const id = crypto.randomUUID()
      const shape = rowToEntryShape(row)
      const entry: LifecycleEntry = {
        id,
        source,
        ...shape,
        status: 'PENDING',
        firstSeenAt: now,
        lastSeenAt: now,
        statusChangedAt: now,
        lastSeenLtp: shape.ltp,
        lastLtpAt: now,
        highSinceGenerated: shape.ltp,
        lowSinceGenerated: shape.ltp,
      }
      store.entries[id] = entry
      seenIds.add(id)
      report.newAdded.push(entry)
    }
  }

  // 2. ACTIVE entries from this source NOT seen in the fresh run → SUPERSEDED
  for (const e of Object.values(store.entries)) {
    if (e.source !== source) continue
    if (e.status !== 'ACTIVE') continue
    if (seenIds.has(e.id)) continue
    // Mark superseded
    e.convictionPrev = e.conviction
    e.status = 'SUPERSEDED'
    e.statusChangedAt = now
    e.statusReason = 'No longer meets pick criteria — review whether to hold or exit'
    report.superseded.push(e)
  }

  await saveStore(store)

  // 3. Build merged view — ACTIVE first, then recent terminal states (21 days)
  const cutoff = Date.now() - 21 * 86_400_000
  const mergedView = Object.values(store.entries)
    .filter(e => {
      if (e.source !== source) return false
      if (e.status === 'ACTIVE') return true
      const since = new Date(e.statusChangedAt).getTime()
      return since >= cutoff
    })
    .sort((a, b) => {
      // ACTIVE first (no-brainer first within ACTIVE), terminal states after
      if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1
      if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1
      if (a.status === 'ACTIVE' && b.status === 'ACTIVE') {
        if (a.noBrainerBet !== b.noBrainerBet) return a.noBrainerBet ? -1 : 1
        return b.conviction - a.conviction
      }
      // Both terminal — newest state change first
      return new Date(b.statusChangedAt).getTime() - new Date(a.statusChangedAt).getTime()
    })

  log.ok('LIFECYCLE', `${source} merge: +${report.newAdded.length} new · ${report.refreshed.length} same · ${report.rePriced.length} re-priced · ${report.superseded.length} superseded · ${mergedView.length} total in view`)
  return { store, report, mergedView }
}

/**
 * Mark a hit on an existing entry. Used by the periodic checker (or admin
 * trigger) when LTP touches T1/T2/T3 or SL.
 */
export async function markHit(id: string, status: 'T1_HIT' | 'T2_HIT' | 'T3_HIT' | 'SL_HIT' | 'EXPIRED' | 'INVALIDATED', hitPrice?: number, reason?: string): Promise<void> {
  const store = await loadStore()
  const e = store.entries[id]
  if (!e) return
  if (e.status !== 'ACTIVE') return            // already terminal
  e.status = status
  e.statusChangedAt = new Date().toISOString()
  if (hitPrice != null) e.hitPrice = hitPrice
  e.hitAt = e.statusChangedAt
  if (reason) e.statusReason = reason
  await saveStore(store)
  log.ok('LIFECYCLE', `${e.symbol} ${e.direction} → ${status}${hitPrice ? ` @ ₹${hitPrice}` : ''}`)
}

/**
 * Generic single-signal append — used by sources that emit one signal at a
 * time (turtle soup, fib-lrc, harmonic, options/intraday tick). The signal
 * starts in PENDING, transitions to ACTIVE when LTP reaches the entry range.
 * Idempotent: matching (symbol, direction, source) PENDING/ACTIVE entry
 * within the last 24h refreshes lastSeen instead of duplicating.
 */
export async function appendSignal(input: {
  source: LifecycleEntry['source']
  symbol: string
  direction: 'BUY' | 'SHORT'
  ltp: number
  entryPrice: number
  entryPriceLow?: number
  entryPriceHigh?: number
  stopLoss: number
  target1: number; target1Date?: string
  target2: number; target2Date?: string
  target3?: number; target3Date?: string
  conviction?: number                        // 0-100; fallback to 50
  shareholdingNote?: string
  reasoning?: string
  bucket?: 'FIRST_BASE' | 'WAVE_2'
}): Promise<LifecycleEntry> {
  const store = await loadStore()
  const now = new Date().toISOString()
  const dayAgo = Date.now() - 24 * 3600_000
  // Find an open (PENDING or ACTIVE) match within last 24h to dedupe
  for (const e of Object.values(store.entries)) {
    if (e.source !== input.source) continue
    if (e.symbol !== input.symbol) continue
    if (e.direction !== input.direction) continue
    if (e.status !== 'PENDING' && e.status !== 'ACTIVE') continue
    if (new Date(e.firstSeenAt).getTime() < dayAgo) continue
    // Refresh lastSeen + ltp; do NOT change plan (entry/SL/target preserve)
    e.lastSeenAt = now
    e.lastSeenLtp = input.ltp
    e.lastLtpAt = now
    await saveStore(store)
    return e
  }
  // New entry — start PENDING
  const id = crypto.randomUUID()
  const entry: LifecycleEntry = {
    id,
    source: input.source,
    symbol: input.symbol,
    direction: input.direction,
    ltp: input.ltp,
    entryPrice: input.entryPrice,
    entryPriceLow: input.entryPriceLow ?? input.entryPrice,
    entryPriceHigh: input.entryPriceHigh ?? input.entryPrice,
    entryDate: '',
    stopLoss: input.stopLoss,
    target1: input.target1, target1Date: input.target1Date ?? '',
    target2: input.target2, target2Date: input.target2Date ?? '',
    target3: input.target3 ?? input.target2, target3Date: input.target3Date ?? '',
    conviction: input.conviction ?? 50,
    noBrainerBet: false,
    shareholdingNote: input.shareholdingNote ?? '',
    reasoning: input.reasoning ?? '',
    bucket: input.bucket,
    status: 'PENDING',
    firstSeenAt: now,
    lastSeenAt: now,
    statusChangedAt: now,
    lastSeenLtp: input.ltp,
    lastLtpAt: now,
    highSinceGenerated: input.ltp,
    lowSinceGenerated: input.ltp,
  }
  store.entries[id] = entry
  await saveStore(store)
  return entry
}

/**
 * Periodic checker — given current LTP for each tracked symbol, walks all
 * PENDING and ACTIVE entries and transitions states based on:
 *
 *   PENDING + LTP in entry range  →  ACTIVE  (triggeredAt stamped)
 *   PENDING + entryDate passed    →  EXPIRED (with reason)
 *   ACTIVE  + LTP touched SL      →  SL_HIT
 *   ACTIVE  + LTP touched T1/T2/T3 →  T*_HIT (highest target hit wins)
 *   ACTIVE  + 28+ days no target  →  EXPIRED
 *
 * Returns transitions for Telegram dispatch.
 */
export interface Transition {
  entry: LifecycleEntry
  from: LifecycleStatus
  to: LifecycleStatus
  hitPrice?: number
}

export async function checkTransitions(ltps: Map<string, number>): Promise<Transition[]> {
  const store = await loadStore()
  const now = new Date().toISOString()
  const now28 = Date.now() - 28 * 86_400_000
  const transitions: Transition[] = []

  for (const e of Object.values(store.entries)) {
    if (e.status !== 'PENDING' && e.status !== 'ACTIVE') continue
    const ltp = ltps.get(e.symbol)
    if (ltp == null || !Number.isFinite(ltp)) continue
    // Update watermarks
    e.lastSeenLtp = ltp
    e.lastLtpAt = now
    if (e.highSinceGenerated == null || ltp > e.highSinceGenerated) e.highSinceGenerated = ltp
    if (e.lowSinceGenerated == null || ltp < e.lowSinceGenerated) e.lowSinceGenerated = ltp

    // ── PENDING → ACTIVE / EXPIRED ──
    if (e.status === 'PENDING') {
      // Entry zone: explicit range, or ±0.5% around single entry
      const zoneLow = Math.min(e.entryPriceLow, e.entryPrice * 0.995)
      const zoneHigh = Math.max(e.entryPriceHigh, e.entryPrice * 1.005)
      const inZone = ltp >= zoneLow && ltp <= zoneHigh
      if (inZone) {
        const from = e.status
        e.status = 'ACTIVE'
        e.statusChangedAt = now
        e.triggeredAt = now
        transitions.push({ entry: e, from, to: 'ACTIVE', hitPrice: ltp })
        continue
      }
      // Stale PENDING — generated more than 5 days ago without trigger
      if (new Date(e.firstSeenAt).getTime() < Date.now() - 5 * 86_400_000) {
        const from = e.status
        e.status = 'EXPIRED'
        e.statusChangedAt = now
        e.statusReason = 'Entry window passed without LTP reaching the entry zone'
        transitions.push({ entry: e, from, to: 'EXPIRED' })
        continue
      }
    }

    // ── ACTIVE → terminal states ──
    if (e.status === 'ACTIVE') {
      const isBuy = e.direction === 'BUY'
      // SL check first (failure-first ordering)
      const slHit = isBuy ? ltp <= e.stopLoss : ltp >= e.stopLoss
      if (slHit) {
        const from = e.status
        e.status = 'SL_HIT'
        e.statusChangedAt = now
        e.hitPrice = ltp
        e.hitAt = now
        e.statusReason = `LTP ${ltp} crossed SL ${e.stopLoss}`
        transitions.push({ entry: e, from, to: 'SL_HIT', hitPrice: ltp })
        continue
      }
      // Target detection — highest-numbered target reached wins
      let hitTarget: 'T1_HIT' | 'T2_HIT' | 'T3_HIT' | null = null
      if (isBuy) {
        if (e.target3 && ltp >= e.target3) hitTarget = 'T3_HIT'
        else if (e.target2 && ltp >= e.target2) hitTarget = 'T2_HIT'
        else if (e.target1 && ltp >= e.target1) hitTarget = 'T1_HIT'
      } else {
        if (e.target3 && ltp <= e.target3) hitTarget = 'T3_HIT'
        else if (e.target2 && ltp <= e.target2) hitTarget = 'T2_HIT'
        else if (e.target1 && ltp <= e.target1) hitTarget = 'T1_HIT'
      }
      if (hitTarget) {
        const from = e.status
        e.status = hitTarget
        e.statusChangedAt = now
        e.hitPrice = ltp
        e.hitAt = now
        transitions.push({ entry: e, from, to: hitTarget, hitPrice: ltp })
        // 2026-06-24: pattern memory — capture the daily candle fingerprint
        // for this winning setup so future scans can match similar shapes
        // and award conviction bonus. Fire-and-forget; failure is silent.
        void (async () => {
          try {
            const { getCandles } = await import('../data')
            const candles = await getCandles(e.symbol, '1D' as any, 60)
            if (candles && candles.length >= 30) {
              const { recordWinningPattern } = await import('./patternMemory')
              await recordWinningPattern({
                symbol: e.symbol,
                status: hitTarget!,
                direction: e.direction as 'BUY' | 'SHORT',
                candlesAtEntry: candles,
              })
            }
          } catch { /* silent */ }
        })()
        continue
      }
      // Timeout: 28 days in ACTIVE without target
      if (e.triggeredAt && new Date(e.triggeredAt).getTime() < now28) {
        const from = e.status
        e.status = 'EXPIRED'
        e.statusChangedAt = now
        e.statusReason = '28-day target window closed without T1/T2/T3'
        transitions.push({ entry: e, from, to: 'EXPIRED' })
      }
    }
  }
  if (transitions.length) await saveStore(store)
  return transitions
}

/**
 * Accuracy report across all entries (optionally filtered by source).
 * Computes: triggered rate (PENDING→ACTIVE), win rate (any target),
 * SL rate, avg R-multiple, breakdown by source + by conviction tier.
 */
export interface AccuracyReport {
  source: string                        // 'ALL' or specific source
  daysBack: number
  total: number
  byStatus: Record<string, number>
  triggeredRate: number                 // % of PENDING that went ACTIVE
  winRate: number                       // % of ACTIVE that hit any target
  slRate: number                        // % of ACTIVE that hit SL
  avgRMultiple: number                  // avg gain / planned risk
  bySource: Record<string, { total: number; wins: number; sl: number; winRate: number }>
  byConvictionTier: Record<string, { total: number; wins: number; winRate: number }>
}

export async function buildAccuracyReport(opts: { source?: string; daysBack?: number; minConviction?: number } = {}): Promise<AccuracyReport> {
  const daysBack = opts.daysBack ?? 30
  const source = opts.source ?? 'ALL'
  // 2026-06-17 user complaint: "headline says 38% WR but users only see
  // and trade conv ≥ 70 picks". Filter the entire report to the user-
  // visible bar so what's shown matches what's actually tradeable.
  // The lifecycle still records everything; we just stop counting noise.
  const minConv = opts.minConviction ?? 70
  const cutoff = Date.now() - daysBack * 86_400_000
  const store = await loadStore()
  const inWindow = Object.values(store.entries).filter(e => {
    if (source !== 'ALL' && e.source !== source) return false
    if ((e.conviction ?? 0) < minConv) return false       // skip un-tradeable noise
    return new Date(e.firstSeenAt).getTime() >= cutoff
  })
  const byStatus: Record<string, number> = {}
  let triggered = 0, totalPending = 0, wins = 0, sl = 0, activeOrTerminal = 0
  let rSum = 0, rCount = 0
  const bySource: AccuracyReport['bySource'] = {}
  // 2026-05-29: finer conviction-band granularity. Live data audit showed
  // counterintuitive pattern — conv ≥ 90 has WORSE WR than conv 70-79
  // (extended setups stop-out; coiled-spring sweet spot wins). Surfacing
  // the 70-79 band as the "Premium / Sweet Spot" tier in the UI so users
  // see the real high-WR cohort instead of chasing 90+ in vain.
  const tierBucket = (c: number): string =>
    c >= 90 ? '90+'
    : c >= 80 ? '80-89'
    : c >= 70 ? '70-79'   // ← sweet spot (live WR ≈ 82%)
    : c >= 60 ? '60-69'
    : c >= 40 ? '40-59'
    : '<40'
  const byTier: AccuracyReport['byConvictionTier'] = {}

  for (const e of inWindow) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
    const everPending = true                // every entry starts pending
    if (everPending) totalPending++
    const isActiveOrTerminal = e.status !== 'PENDING' && e.status !== 'SUPERSEDED' && e.status !== 'EXPIRED' && e.status !== 'INVALIDATED'
                                || e.status === 'EXPIRED' && e.triggeredAt
    if (e.status !== 'PENDING') {
      // Was triggered if ever became ACTIVE; we can prove that via triggeredAt
      if (e.triggeredAt || e.status === 'ACTIVE' || ['T1_HIT','T2_HIT','T3_HIT','SL_HIT'].includes(e.status)) triggered++
    }
    const win = e.status === 'T1_HIT' || e.status === 'T2_HIT' || e.status === 'T3_HIT'
    const loss = e.status === 'SL_HIT'
    if (win || loss || e.status === 'ACTIVE') activeOrTerminal++
    if (win) wins++
    if (loss) sl++
    // R-multiple — only for terminal outcomes with known hit price
    if ((win || loss) && e.hitPrice != null && e.entryPrice && e.stopLoss) {
      const planRisk = Math.abs(e.entryPrice - e.stopLoss)
      if (planRisk > 0) {
        const actualMove = e.direction === 'BUY' ? e.hitPrice - e.entryPrice : e.entryPrice - e.hitPrice
        const r = actualMove / planRisk
        rSum += r; rCount++
      }
    }
    // By source
    const srcKey = e.source
    if (!bySource[srcKey]) bySource[srcKey] = { total: 0, wins: 0, sl: 0, winRate: 0 }
    bySource[srcKey].total++
    if (win) bySource[srcKey].wins++
    if (loss) bySource[srcKey].sl++
    // By tier — TRACK both total AND closed (wins+sl) so we can compute
    // the right WR. Previously this used total in the denominator which
    // included PENDING + SUPERSEDED rows, producing fake 1-2% rates.
    const tier = tierBucket(e.conviction)
    if (!byTier[tier]) byTier[tier] = { total: 0, wins: 0, winRate: 0, slCount: 0 } as any
    byTier[tier].total++
    if (win) byTier[tier].wins++
    if (loss) (byTier[tier] as any).slCount = ((byTier[tier] as any).slCount ?? 0) + 1
  }
  for (const k of Object.keys(bySource)) {
    const s = bySource[k]
    const tradedCount = s.wins + s.sl
    s.winRate = tradedCount ? +(s.wins / tradedCount * 100).toFixed(1) : 0
  }
  for (const k of Object.keys(byTier)) {
    const t = byTier[k] as any
    // Correct WR = wins / (wins + SL_HIT closures). PENDING/SUPERSEDED
    // never trade, so they must NOT be in the denominator.
    const closed = t.wins + (t.slCount ?? 0)
    t.winRate = closed ? +(t.wins / closed * 100).toFixed(1) : 0
  }
  return {
    source, daysBack,
    total: inWindow.length,
    byStatus,
    triggeredRate: totalPending ? +(triggered / totalPending * 100).toFixed(1) : 0,
    winRate: activeOrTerminal ? +(wins / Math.max(wins + sl, 1) * 100).toFixed(1) : 0,
    slRate: activeOrTerminal ? +(sl / Math.max(wins + sl, 1) * 100).toFixed(1) : 0,
    avgRMultiple: rCount ? +(rSum / rCount).toFixed(2) : 0,
    bySource, byConvictionTier: byTier,
  }
}

/** Read-only fetch of the merged view for a source (used by snapshot publisher). */
export async function getMergedView(source: 'WEEKLY' | 'DAILY' = 'WEEKLY'): Promise<LifecycleEntry[]> {
  const store = await loadStore()
  const cutoff = Date.now() - 21 * 86_400_000
  return Object.values(store.entries)
    .filter(e => {
      if (e.source !== source) return false
      if (e.status === 'ACTIVE') return true
      return new Date(e.statusChangedAt).getTime() >= cutoff
    })
    .sort((a, b) => {
      if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1
      if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1
      if (a.status === 'ACTIVE' && b.status === 'ACTIVE') {
        if (a.noBrainerBet !== b.noBrainerBet) return a.noBrainerBet ? -1 : 1
        return b.conviction - a.conviction
      }
      return new Date(b.statusChangedAt).getTime() - new Date(a.statusChangedAt).getTime()
    })
}
