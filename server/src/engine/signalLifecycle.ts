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

export type LifecycleStatus =
  | 'ACTIVE' | 'SUPERSEDED' | 'T1_HIT' | 'T2_HIT' | 'T3_HIT' | 'SL_HIT' | 'EXPIRED' | 'INVALIDATED'

export interface LifecycleEntry {
  id: string                          // uuid v4
  source: 'WEEKLY' | 'DAILY' | 'MASTER'
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
  // Lifecycle
  status: LifecycleStatus
  firstSeenAt: string                 // first time this (symbol|direction) ever appeared
  lastSeenAt: string                  // most recent run that included it as ACTIVE
  statusChangedAt: string
  statusReason?: string
  hitPrice?: number
  hitAt?: string
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

async function saveStore(store: LifecycleStore): Promise<void> {
  store.updatedAt = new Date().toISOString()
  await fs.writeFile(LIFECYCLE_FILE, JSON.stringify(store, null, 2))
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

function rowToEntryShape(row: any): Omit<LifecycleEntry, 'id' | 'status' | 'firstSeenAt' | 'lastSeenAt' | 'statusChangedAt' | 'source'> {
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
      // New active entry
      const id = crypto.randomUUID()
      const entry: LifecycleEntry = {
        id,
        source,
        ...rowToEntryShape(row),
        status: 'ACTIVE',
        firstSeenAt: now,
        lastSeenAt: now,
        statusChangedAt: now,
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
