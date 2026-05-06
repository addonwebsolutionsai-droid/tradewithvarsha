import fs from 'fs'
import path from 'path'
import type { Direction, Signal } from '../types'
import { invalidateConflictingTrades, type LifecycleEvent } from './tradeTracker'

/**
 * Direction-stability ledger.
 *
 * Problem: on 2026-04-22 the user flagged that signals for the same
 * instrument were flipping direction within 24-48h (e.g. EPACK moved from
 * BUY to SHORT; DR REDDY / TITAN futures flipped from positional SHORT to
 * swing BUY the next day). Whipsaws erode trust and cost real money.
 *
 * This module records the last BUY/SELL call per (instrument, horizon) and
 * tags any subsequent opposite-direction signal that arrives inside a
 * cooldown window.
 *
 * Policy (deliberately non-destructive, revised 2026-04-24):
 *   - Records every NEW direction per symbol+horizon.
 *   - If a NEW signal opposes the last recorded direction AND the last one
 *     was fired inside `COOLDOWN_HOURS[horizon]`, we ATTACH a
 *     `stabilityNote` warning that the formatter surfaces to the user.
 *     We deliberately do NOT downgrade the grade — the user still needs
 *     to see the Telegram alert (ALERT_MIN_GRADE=B), just with the flip
 *     warning inline. The note is the whole point: it tells the user
 *     "we went bear yesterday and are going bull today, here's why".
 *
 * Persistence: server/data/direction-ledger.json (tiny, no DB dep).
 */

type Horizon = 'INTRADAY' | 'SWING' | 'POSITIONAL'

// Cool-down per horizon. Intraday views can and should update within the
// same session; swing/positional calls are where flips hurt most.
const COOLDOWN_HOURS: Record<Horizon, number> = {
  INTRADAY: 0,            // no penalty; intraday reversals are normal
  SWING: 48,              // swing views should hold 2+ days
  POSITIONAL: 7 * 24,     // positional at least a week
}

interface Entry {
  direction: Direction
  timestamp: string        // ISO
  source: string
  grade: string
  score: number
  tier: 'LIVE' | 'WATCH'   // 2026-04-27: track tier so WATCH→WATCH/LIVE→WATCH
                           // direction-changes don't trigger "flips" / cancellations.
                           // Only LIVE high-conviction prior calls get cancelled.
}

type Ledger = Record<string, Entry>   // key = `${symbol}|${horizon}`

const DATA_DIR = path.resolve(__dirname, '../../data')
const LEDGER_FILE = path.join(DATA_DIR, 'direction-ledger.json')

function horizonOf(s: Signal): Horizon {
  if (s.type === 'POSITIONAL') return 'POSITIONAL'
  if (s.type === 'SWING' || s.type === 'FUTURES') return 'SWING'
  return 'INTRADAY'    // INTRADAY / OPTIONS / COMMODITY treated as short-cycle
}

function keyOf(s: Signal): string {
  // Keep the instrument root — for option legs "NIFTY 24200 CE" we still
  // want to track NIFTY underlying direction (a CE-buy = BULL, PE-buy = BEAR).
  const root = s.instrument.split(' ')[0].toUpperCase()
  // Option buys map to underlying direction:
  //   "NIFTY 24200 CE" ~ BUY means long CE ≈ BULL on NIFTY
  //   "NIFTY 24200 PE" ~ BUY means long PE ≈ BEAR on NIFTY
  return `${root}|${horizonOf(s)}`
}

/**
 * Source-family bucket — strategies that read the same underlying signal
 * (just at different timeframes / lenses) are considered the same family.
 * A flip within the same family is the strategy reconsidering itself,
 * not a true reversal — and therefore NOT a cancellable view change.
 */
function sameSourceFamily(a: string, b: string): boolean {
  if (a === b) return true
  const fam = (s: string): string => {
    if (s.startsWith('confluence-') || s.startsWith('options-mtf') || s.startsWith('nifty-strict')) return 'options-primary'
    if (s.startsWith('intraday')) return 'intraday'
    if (s === 'fno-advisor') return 'fno'
    if (s === 'oi-flow') return 'oi'
    return s
  }
  return fam(a) === fam(b)
}

function underlyingDirectionOf(s: Signal): Direction {
  const m = /\s(CE|PE)$/.exec(s.instrument.trim())
  if (!m) return s.direction
  const side = m[1]
  // Long CE = bull, long PE = bear. (Shorting options is not emitted anywhere.)
  if (s.direction === 'BUY' && side === 'CE') return 'BUY'
  if (s.direction === 'BUY' && side === 'PE') return 'SELL'
  return s.direction
}

function loadLedger(): Ledger {
  try {
    const raw = fs.readFileSync(LEDGER_FILE, 'utf8')
    return JSON.parse(raw) as Ledger
  } catch { return {} }
}

function saveLedger(l: Ledger): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2), 'utf8')
  } catch { /* best-effort — ledger is advisory */ }
}

/**
 * Apply stability tagging in place and return the same array, plus emit
 * INVALIDATED lifecycle events for any open trades that are now contradicted
 * by a fresh opposite signal.
 *
 * Caller (signalEngine → runAndBroadcast) is responsible for forwarding
 * the returned events to Telegram so the user sees:
 *   "🚫 EPACK BUY signal of 21-Apr is INVALIDATED — view flipped to SELL"
 *   "🔴 EPACK SELL · grade A · entry … " (the new card)
 */
export async function applyDirectionStability(signals: Signal[]): Promise<{
  signals: Signal[]
  invalidations: LifecycleEvent[]
}> {
  if (!signals.length) return { signals, invalidations: [] }
  const ledger = loadLedger()
  const now = Date.now()
  const invalidations: LifecycleEvent[] = []

  // Keep only the best LIVE signal per key when updating ledger (so we
  // record the conviction anchor, not whichever weak strategy fired first).
  // WATCH-tier snapshots NEVER write to the ledger — they're informational.
  const bestByKey = new Map<string, Signal>()
  for (const s of signals) {
    if ((s.tier ?? 'LIVE') !== 'LIVE') continue
    const k = keyOf(s)
    const prior = bestByKey.get(k)
    if (!prior || s.score > prior.score) bestByKey.set(k, s)
  }

  // Only consider LIVE signals strong enough to rate as "view changes".
  // Anything WATCH or below grade B is too weak to invalidate a prior call.
  const FLIP_GRADES = new Set(['A', 'B'])

  for (const s of signals) {
    if ((s.tier ?? 'LIVE') !== 'LIVE') continue          // (1) WATCH never flips
    if (!FLIP_GRADES.has(s.grade)) continue              // (2) C/D too weak

    const key = keyOf(s)
    const prior = ledger[key]
    const newDir = underlyingDirectionOf(s)
    if (!prior) continue
    if (prior.tier !== 'LIVE') continue                  // (3) prior was WATCH — silent upgrade

    const flipped = prior.direction !== newDir
    if (!flipped) continue

    const ageH = (now - new Date(prior.timestamp).getTime()) / 3_600_000

    // (4) New conviction must be >= prior conviction. Otherwise we're
    //     letting a weak counter-call cancel a stronger one — bad.
    if (s.score < prior.score) continue
    if (s.grade > prior.grade && prior.grade === 'A') continue   // A → B downgrade ≠ flip

    // (5) Same source-family flips are noise (a strategy re-evaluating
    //     itself within the same run). Real reversals come from a
    //     different source confirming the change.
    if (sameSourceFamily(s.source, prior.source)) continue

    // Real flip — tag the new card AND invalidate the prior open trade.
    s.stabilityNote =
      `View flipped ${prior.direction}→${newDir} after ${ageH.toFixed(1)}h · ` +
      `prior ${prior.source} ${prior.grade}/${prior.score} → new ${s.source} ${s.grade}/${s.score}. ` +
      `Prior signal CANCELLED above.`

    const reason =
      `Engine flipped ${prior.direction} → ${newDir} after ${ageH.toFixed(1)}h. ` +
      `New trigger: ${s.source} ${s.grade}/${s.score}. ${s.reasons?.[0] ?? ''}`

    const evs = await invalidateConflictingTrades({
      symbol: s.instrument,
      newDirection: s.direction,
      newSignalId: s.id,
      reason,
      ltp: s.entry,
    })
    invalidations.push(...evs)
  }

  // Persist: one entry per (symbol|horizon) using the best LIVE signal of
  // this run. We only update the ledger when the new candidate is at least
  // as strong as what's already recorded — otherwise a weak engine pass
  // would overwrite a high-conviction prior call.
  for (const [k, best] of bestByKey) {
    const prior = ledger[k]
    if (prior && prior.tier === 'LIVE' && prior.score > best.score) continue
    ledger[k] = {
      direction: underlyingDirectionOf(best),
      timestamp: new Date().toISOString(),
      source: best.source,
      grade: best.grade,
      score: best.score,
      tier: 'LIVE',
    }
  }

  // Prune stale entries (> 30 days) to stop file growth.
  const cutoff = now - 30 * 24 * 3_600_000
  for (const k of Object.keys(ledger)) {
    if (new Date(ledger[k].timestamp).getTime() < cutoff) delete ledger[k]
  }

  saveLedger(ledger)
  return { signals, invalidations }
}
