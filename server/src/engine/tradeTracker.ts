import fs from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import type { Signal } from '../types'

/**
 * Trade Lifecycle Tracker.
 *
 * Solves two problems:
 *   1. De-dupes signals — same symbol + strategy + direction within a day
 *      counts as the same trade, so we never re-send the entry alert.
 *   2. Detects SL / T1 / T2 / expiry events on each price tick and emits
 *      one alert per lifecycle event.
 *
 * Storage: `server/data/trades.json` — survives restarts.
 */

export type TradeStatus = 'ACTIVE' | 'T1_HIT' | 'T2_HIT' | 'SL_HIT' | 'EXPIRED' | 'INVALIDATED'

export interface TrackedTrade {
  canonicalId: string       // symbol|strategy|direction|YYYY-MM-DD
  currentSignalId: string   // points to latest signal's id for reference
  symbol: string
  strategy: string
  direction: 'BUY' | 'SELL'
  entry: number
  originalSL: number
  currentSL: number         // may be trailed after T1
  target1: number
  target2: number
  status: TradeStatus
  alertsSent: string[]      // ['OPEN', 'T1_HIT', 'SL_HIT'] etc.
  openedAt: number
  lastCheckedAt: number
  closedAt?: number
  finalPnlPct?: number
}

export type LifecycleEvent = {
  kind: 'OPEN' | 'T1_HIT' | 'T2_HIT' | 'SL_HIT' | 'EXPIRED' | 'INVALIDATED'
  trade: TrackedTrade
  ltp: number
  pnlPct: number
  note: string
  /** When the kind is INVALIDATED, this carries the reason + the new
   *  signal that replaced it (so Telegram can surface both clearly). */
  replacement?: { newSignalId: string; reason: string }
}

const DATA_DIR = path.resolve(__dirname, '../../data')
const TRADES_PATH = path.join(DATA_DIR, 'trades.json')

let trades: Map<string, TrackedTrade> = new Map()
let saveQueue: Promise<void> = Promise.resolve()

function canonicalIdFor(s: { instrument: string; source: string; direction: 'BUY' | 'SELL'; timestamp: string }): string {
  const day = new Date(s.timestamp).toISOString().slice(0, 10)
  return `${s.instrument}|${s.source}|${s.direction}|${day}`
}

function pnlPct(entry: number, price: number, direction: 'BUY' | 'SELL'): number {
  if (direction === 'BUY') return ((price - entry) / entry) * 100
  return ((entry - price) / entry) * 100
}

export async function loadTrades(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const raw = await fs.readFile(TRADES_PATH, 'utf8').catch(() => '[]')
    const parsed = JSON.parse(raw) as TrackedTrade[]
    trades = new Map(parsed.map(t => [t.canonicalId, t]))
    log.ok('TRADES', `Loaded ${trades.size} tracked trades (${activeCount()} active)`)
  } catch (e) {
    log.warn('TRADES', `Failed to load trades: ${(e as Error).message}`)
    trades = new Map()
  }
}

async function saveTrades(): Promise<void> {
  saveQueue = saveQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const arr = [...trades.values()]
    await fs.writeFile(TRADES_PATH, JSON.stringify(arr, null, 2), 'utf8')
  }).catch(e => log.warn('TRADES', `save failed: ${(e as Error).message}`))
  return saveQueue
}

export function activeTrades(): TrackedTrade[] {
  return [...trades.values()].filter(t => t.status === 'ACTIVE')
}

export function activeCount(): number {
  return activeTrades().length
}

export function allTrades(): TrackedTrade[] {
  return [...trades.values()]
}

/**
 * Called when a new signal is generated. Returns:
 *   - kind: 'OPEN' if this is a brand-new trade (alert operator)
 *   - kind: null if the trade already exists (DO NOT alert again)
 */
export async function onSignalGenerated(signal: Signal): Promise<LifecycleEvent | null> {
  const canonical = canonicalIdFor(signal)
  let trade = trades.get(canonical)

  if (trade) {
    // Already tracking — update the reference signal ID, don't re-alert
    trade.currentSignalId = signal.id
    trade.lastCheckedAt = Date.now()
    await saveTrades()
    return null
  }

  // Brand new trade → register and emit OPEN event
  trade = {
    canonicalId: canonical,
    currentSignalId: signal.id,
    symbol: signal.instrument,
    strategy: signal.source,
    direction: signal.direction,
    entry: signal.entry,
    originalSL: signal.stopLoss,
    currentSL: signal.stopLoss,
    target1: signal.target1,
    target2: signal.target2,
    status: 'ACTIVE',
    alertsSent: ['OPEN'],
    openedAt: Date.now(),
    lastCheckedAt: Date.now(),
  }
  trades.set(canonical, trade)
  await saveTrades()

  return {
    kind: 'OPEN',
    trade,
    ltp: signal.entry,
    pnlPct: 0,
    note: 'New trade opened',
  }
}

/**
 * Called on every LTP tick (Angel WebSocket) to detect lifecycle transitions.
 * Returns any events that fired this tick (usually empty).
 */
/**
 * Tick handler for OPTION-premium prices. Call this from the OI monitor
 * with the actual option LTP (NOT the underlying spot). Routes to the
 * matching open option trade by full instrument string.
 *
 *   onOptionPremiumTick('NIFTY 24400 PE', 132.5)  →  evaluates SL/T1/T2
 */
export async function onOptionPremiumTick(instrument: string, premium: number): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = []
  const now = Date.now()
  for (const trade of trades.values()) {
    if (trade.status !== 'ACTIVE') continue
    if (trade.symbol.toUpperCase() !== instrument.toUpperCase()) continue

    const pnl = pnlPct(trade.entry, premium, trade.direction)
    trade.lastCheckedAt = now
    const bull = trade.direction === 'BUY'
    const hitSL = bull ? premium <= trade.currentSL : premium >= trade.currentSL
    const hitT1 = bull ? premium >= trade.target1 : premium <= trade.target1
    const hitT2 = bull ? premium >= trade.target2 : premium <= trade.target2

    if (hitT2 && !trade.alertsSent.includes('T2_HIT')) {
      trade.status = 'T2_HIT'; trade.closedAt = now; trade.finalPnlPct = pnl
      trade.alertsSent.push('T2_HIT')
      events.push({ kind: 'T2_HIT', trade, ltp: premium, pnlPct: pnl, note: `🚀 T2 hit @ ₹${premium} (+${pnl.toFixed(1)}%)` })
      continue
    }
    if (hitT1 && !trade.alertsSent.includes('T1_HIT')) {
      trade.alertsSent.push('T1_HIT')
      trade.currentSL = trade.entry      // trail to BE
      events.push({ kind: 'T1_HIT', trade, ltp: premium, pnlPct: pnl, note: `🎯 T1 hit @ ₹${premium} — SL trailed to entry` })
      continue
    }
    if (hitSL && !trade.alertsSent.includes('SL_HIT')) {
      trade.status = 'SL_HIT'; trade.closedAt = now; trade.finalPnlPct = pnl
      trade.alertsSent.push('SL_HIT')
      events.push({ kind: 'SL_HIT', trade, ltp: premium, pnlPct: pnl, note: `❌ SL hit @ ₹${premium} (${pnl.toFixed(1)}%)` })
    }
  }
  if (events.length) await saveTrades()
  return events
}

export async function onPrice(symbol: string, ltp: number): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = []
  const now = Date.now()

  for (const trade of trades.values()) {
    if (trade.status !== 'ACTIVE') continue
    // Match by symbol — trade.symbol may be "NIFTY 22200 CE", we need the base
    const baseSymbol = trade.symbol.split(' ')[0].toUpperCase()
    if (baseSymbol !== symbol.toUpperCase()) continue

    // CRITICAL: option trades store entry/SL/T1 in PREMIUM space, not spot.
    // Comparing spot LTP (e.g. NIFTY 24,400) to a premium SL (e.g. ₹75) would
    // instantly fake a T2 hit. Skip option trades unless onOptionPrice() is
    // called with the actual premium (see oiMonitor — TODO wire premium ticks).
    const isOption = / (PE|CE)$/.test(trade.symbol)
    if (isOption) continue

    const pnl = pnlPct(trade.entry, ltp, trade.direction)
    trade.lastCheckedAt = now

    const bull = trade.direction === 'BUY'
    const hitSL = bull ? ltp <= trade.currentSL : ltp >= trade.currentSL
    const hitT1 = bull ? ltp >= trade.target1 : ltp <= trade.target1
    const hitT2 = bull ? ltp >= trade.target2 : ltp <= trade.target2

    if (hitT2 && !trade.alertsSent.includes('T2_HIT')) {
      trade.status = 'T2_HIT'
      trade.closedAt = now
      trade.finalPnlPct = pnl
      trade.alertsSent.push('T2_HIT')
      events.push({ kind: 'T2_HIT', trade, ltp, pnlPct: pnl, note: `🚀 T2 hit — trade closed at +${pnl.toFixed(2)}%` })
      continue
    }
    if (hitT1 && !trade.alertsSent.includes('T1_HIT')) {
      trade.alertsSent.push('T1_HIT')
      // Trail SL to entry (risk-free runner)
      trade.currentSL = trade.entry
      events.push({ kind: 'T1_HIT', trade, ltp, pnlPct: pnl, note: `🎯 T1 hit — SL trailed to entry, runner live` })
      continue
    }
    if (hitSL && !trade.alertsSent.includes('SL_HIT')) {
      trade.status = 'SL_HIT'
      trade.closedAt = now
      trade.finalPnlPct = pnl
      trade.alertsSent.push('SL_HIT')
      events.push({ kind: 'SL_HIT', trade, ltp, pnlPct: pnl, note: `❌ SL hit — trade closed at ${pnl.toFixed(2)}%` })
    }
  }

  if (events.length) await saveTrades()
  return events
}

/**
 * Expire stale trades — any ACTIVE trade open for > maxHoldDays is closed
 * at the current price with an EXPIRED event. Runs on a 15-min cron.
 */
export async function expireStaleTrades(now: number = Date.now(), maxHoldDays = 21): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = []
  const ageLimit = maxHoldDays * 86_400_000
  for (const trade of trades.values()) {
    if (trade.status !== 'ACTIVE') continue
    if (now - trade.openedAt < ageLimit) continue
    trade.status = 'EXPIRED'
    trade.closedAt = now
    trade.alertsSent.push('EXPIRED')
    events.push({
      kind: 'EXPIRED',
      trade,
      ltp: trade.entry,
      pnlPct: 0,
      note: `⏰ ${maxHoldDays}-day time-stop reached — closing at entry`,
    })
  }
  if (events.length) await saveTrades()
  return events
}

/**
 * Invalidate every ACTIVE trade on `symbol` whose direction is OPPOSITE to
 * `newDirection`. Used by directionLedger when a fresh signal flips the
 * stance so the user gets an explicit cancellation alert instead of two
 * contradictory live trades.
 *
 * Only ACTIVE trades are invalidated — already-closed trades (T1/T2/SL/EXPIRED)
 * are left alone so we keep the historical record intact.
 */
export async function invalidateConflictingTrades(args: {
  symbol: string                            // root symbol e.g. NIFTY / EPACK
  newDirection: 'BUY' | 'SELL'
  newSignalId: string
  reason: string
  ltp: number
}): Promise<LifecycleEvent[]> {
  const events: LifecycleEvent[] = []
  for (const trade of trades.values()) {
    if (trade.status !== 'ACTIVE') continue
    if (rootOf(trade.symbol) !== rootOf(args.symbol)) continue
    if (trade.direction === args.newDirection) continue        // same side — no flip
    // Only cancel trades that the user actually saw — no point sending a
    // "🚫 SIGNAL CANCELLED" Telegram for a trade that was never alerted in
    // the first place (e.g. WATCH or below-threshold setups).
    if (!trade.alertsSent.includes('OPEN')) continue

    const pnl = pnlPct(trade.entry, args.ltp, trade.direction)
    trade.status = 'INVALIDATED'
    trade.closedAt = Date.now()
    trade.finalPnlPct = +pnl.toFixed(2)
    trade.alertsSent.push('INVALIDATED')

    events.push({
      kind: 'INVALIDATED',
      trade,
      ltp: args.ltp,
      pnlPct: +pnl.toFixed(2),
      note: `🚫 ${trade.symbol} ${trade.direction} signal invalidated — view flipped to ${args.newDirection}`,
      replacement: { newSignalId: args.newSignalId, reason: args.reason },
    })
  }
  if (events.length) await saveTrades()
  return events
}

/** Strip option-leg suffix so "NIFTY 24000 PE" canonicalises to "NIFTY". */
function rootOf(instrument: string): string {
  return instrument.split(' ')[0].toUpperCase()
}

/**
 * Return the most-recent WINNING trade on a symbol within `lookbackDays`.
 * "Winning" = closed at T1/T2 hit (not SL_HIT, not EXPIRED at flat, not
 * INVALIDATED). Used by the post-win-cooldown filter in the signal engine
 * to suppress an immediate counter-direction signal after a successful ride.
 *
 * Why this exists (2026-04-27): user took an EPACK BUY at ₹247 on 23-Apr,
 * it ran to +18% by 27-Apr, and the engine immediately fired a SELL on
 * EPACK at the top of that move. Counter-trend signals after a fresh win
 * are statistically poor and emotionally destructive.
 */
export function recentWin(symbolRoot: string, lookbackDays = 5): TrackedTrade | null {
  const cutoff = Date.now() - lookbackDays * 86_400_000
  const root = symbolRoot.toUpperCase()
  let best: TrackedTrade | null = null
  for (const t of trades.values()) {
    if (rootOf(t.symbol) !== root) continue
    if (t.status !== 'T1_HIT' && t.status !== 'T2_HIT') continue
    if ((t.closedAt ?? t.openedAt) < cutoff) continue
    if (!best || (t.closedAt ?? t.openedAt) > (best.closedAt ?? best.openedAt)) {
      best = t
    }
  }
  return best
}

/** Purge closed trades older than N days to keep the file small. */
export async function vacuum(retainDays = 90): Promise<number> {
  const cutoff = Date.now() - retainDays * 86_400_000
  let removed = 0
  for (const [key, t] of trades) {
    if (t.status !== 'ACTIVE' && (t.closedAt ?? t.openedAt) < cutoff) {
      trades.delete(key)
      removed++
    }
  }
  if (removed) await saveTrades()
  return removed
}

/** Simple stats for /api/trades endpoint. */
export function tradeStats(): {
  active: number
  closed: number
  wins: number
  losses: number
  invalidated: number
  winRate: number
  totalPnlPct: number
  avgPnlPct: number
  byStatus: Record<TradeStatus, number>
} {
  const all = [...trades.values()]
  const active = all.filter(t => t.status === 'ACTIVE').length
  // "Closed" excludes invalidations so they don't drag the win rate down —
  // an invalidated trade is a *cancelled* call, not a loss the trader took.
  const closed = all.filter(t => t.status !== 'ACTIVE' && t.status !== 'INVALIDATED')
  const wins = closed.filter(t => (t.finalPnlPct ?? 0) > 0).length
  const losses = closed.filter(t => (t.finalPnlPct ?? 0) < 0).length
  const invalidated = all.filter(t => t.status === 'INVALIDATED').length
  const totalPnl = closed.reduce((s, t) => s + (t.finalPnlPct ?? 0), 0)
  const byStatus: Record<TradeStatus, number> = {
    ACTIVE: active,
    T1_HIT: all.filter(t => t.status === 'T1_HIT').length,
    T2_HIT: all.filter(t => t.status === 'T2_HIT').length,
    SL_HIT: all.filter(t => t.status === 'SL_HIT').length,
    EXPIRED: all.filter(t => t.status === 'EXPIRED').length,
    INVALIDATED: invalidated,
  }
  return {
    active,
    closed: closed.length,
    wins,
    losses,
    invalidated,
    winRate: closed.length ? +((wins / closed.length) * 100).toFixed(1) : 0,
    totalPnlPct: +totalPnl.toFixed(2),
    avgPnlPct: closed.length ? +(totalPnl / closed.length).toFixed(2) : 0,
    byStatus,
  }
}
