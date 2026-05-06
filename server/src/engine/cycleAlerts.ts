import fs from 'fs/promises'
import path from 'path'
import { getGannCycleStatus, getBestCycleTrade, type BestCycleTrade } from '../gann/cycleStatus'
import * as data from '../data'
import { log } from '../util/logger'

/**
 * Daily cycle-alert engine.
 *
 * For each tracked instrument, computes today's cycle status and pushes a
 * Telegram alert when:
 *   - A HIGH-importance cycle is ending in ≤ 3 sessions (reversal watch)
 *   - A new HIGH-importance cycle has just started (≤ 2 days elapsed)
 *   - Price has reversed within 0.5 % of a Square-of-9 level on a reversal
 *     date (confirmation alert)
 *
 * Dedupe: the (symbol, cycleId, alertKind) triplet is tracked in a JSON
 * file so the same alert never fires twice for the same iteration.
 *
 * Designed to run once at 09:00 IST pre-open and once at 16:30 IST
 * post-close. Callers broadcast the formatted message; this module just
 * returns which alerts should fire.
 */

const DATA_DIR = path.resolve(__dirname, '../../data')
const ALERTED_FILE = path.join(DATA_DIR, 'cycle-alerts-sent.json')

export interface CycleAlert {
  kind: 'REVERSAL_WATCH' | 'CYCLE_STARTED' | 'REVERSAL_CONFIRMED'
  symbol: string
  date: string
  cycleLabel: string
  seedName: string
  importance: 'HIGH' | 'MED' | 'LOW'
  price?: number
  message: string
  dedupeKey: string
  bestTrade?: BestCycleTrade | null
}

interface AlertLedger { sent: Record<string, number> }   // key → timestamp

async function loadLedger(): Promise<AlertLedger> {
  try {
    const raw = await fs.readFile(ALERTED_FILE, 'utf8')
    return JSON.parse(raw)
  } catch { return { sent: {} } }
}

async function saveLedger(l: AlertLedger): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  // Prune entries older than 30 days
  const cutoff = Date.now() - 30 * 86_400_000
  for (const k of Object.keys(l.sent)) {
    if (l.sent[k] < cutoff) delete l.sent[k]
  }
  await fs.writeFile(ALERTED_FILE, JSON.stringify(l, null, 2), 'utf8')
}

const TRACKED_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'GOLD', 'CRUDE']

export async function computeCycleAlerts(today: Date = new Date()): Promise<CycleAlert[]> {
  const alerts: CycleAlert[] = []
  const ledger = await loadLedger()

  for (const sym of TRACKED_SYMBOLS) {
    try {
      const q = await data.getQuote(sym).catch(() => null)
      if (!q) continue
      const status = getGannCycleStatus(sym, q.price, today)
      const bestTrade = getBestCycleTrade(status, today)

      // 1. REVERSAL_WATCH — HIGH-importance cycle ending in ≤ 3 days
      for (const cy of status.activeCycles) {
        if (cy.importance === 'HIGH' && cy.bucket !== 'MINOR' && cy.daysRemaining <= 3 && cy.daysRemaining >= 0) {
          const key = `${sym}:revwatch:${cy.cycleDays}:${cy.seedDate}:${cy.cycleEnd}`
          if (ledger.sent[key]) continue
          alerts.push({
            kind: 'REVERSAL_WATCH',
            symbol: sym,
            date: cy.cycleEnd,
            cycleLabel: cy.cycleLabel,
            seedName: cy.seedName,
            importance: cy.importance,
            price: q.price,
            message: formatReversalWatch(sym, cy, q.price, bestTrade),
            dedupeKey: key,
            bestTrade,
          })
        }
      }

      // 2. CYCLE_STARTED — HIGH-importance cycle at ≤ 2 days elapsed
      for (const cy of status.activeCycles) {
        if (cy.importance === 'HIGH' && cy.bucket !== 'MINOR' && cy.daysElapsed <= 2) {
          const key = `${sym}:started:${cy.cycleDays}:${cy.seedDate}:${cy.cycleStart}`
          if (ledger.sent[key]) continue
          alerts.push({
            kind: 'CYCLE_STARTED',
            symbol: sym,
            date: cy.cycleStart,
            cycleLabel: cy.cycleLabel,
            seedName: cy.seedName,
            importance: cy.importance,
            price: q.price,
            message: formatCycleStarted(sym, cy, q.price, bestTrade),
            dedupeKey: key,
            bestTrade,
          })
        }
      }

      // 3. REVERSAL_CONFIRMED — price within 0.5 % of a Square-of-9 level
      //    AND a HIGH reversal date hit within last 2 sessions
      const recentReversal = status.reversals.find(r =>
        r.daysAway >= -2 && r.daysAway <= 0 && r.importance === 'HIGH' && r.bucket !== 'MINOR',
      )
      const nearest = status.squareOf9.nearest
      if (recentReversal && nearest && nearest.distancePct <= 0.5) {
        const key = `${sym}:confirm:${recentReversal.date}:${nearest.label}`
        if (!ledger.sent[key]) {
          alerts.push({
            kind: 'REVERSAL_CONFIRMED',
            symbol: sym,
            date: recentReversal.date,
            cycleLabel: recentReversal.cycleLabel,
            seedName: recentReversal.seedName,
            importance: recentReversal.importance,
            price: q.price,
            message: formatReversalConfirmed(sym, recentReversal, q.price, nearest, bestTrade),
            dedupeKey: key,
            bestTrade,
          })
        }
      }
    } catch (e) {
      log.warn('CYCLE-ALERTS', `${sym}: ${(e as Error).message}`)
    }
  }

  return alerts
}

export async function markAlertsSent(alerts: CycleAlert[]): Promise<void> {
  const ledger = await loadLedger()
  const now = Date.now()
  for (const a of alerts) ledger.sent[a.dedupeKey] = now
  await saveLedger(ledger)
}

// ─── Telegram message formatting ──────────────────────────────

function formatReversalWatch(sym: string, cy: any, price: number, bt: BestCycleTrade | null): string {
  const lines: string[] = []
  lines.push(`⚠️ *REVERSAL WATCH — ${sym}*`)
  lines.push(`━━━━━━━━━━━━━━━━`)
  lines.push(`${cy.cycleLabel} cycle ending *${cy.cycleEnd}* (${cy.daysRemaining}d)`)
  lines.push(`From: ${cy.seedKind === 'HIGH' ? '🔻' : '🔺'} ${cy.seedName}`)
  lines.push(`LTP: \`₹${price.toFixed(2)}\``)
  if (bt) {
    lines.push(``)
    lines.push(`🎯 *Best Cycle Trade*`)
    lines.push(`${bt.direction} · ${bt.confidence} confidence (RR ${bt.riskReward}:1)`)
    lines.push(`Entry: \`₹${bt.entry}\` by ${bt.entryByDate}`)
    lines.push(`SL: \`₹${bt.stopLoss}\` · T1: \`₹${bt.target1}\` · T2: \`₹${bt.target2}\``)
    lines.push(`Exit by: ${bt.exitByDate} (${bt.holdDays} sessions)`)
  }
  return lines.join('\n')
}

function formatCycleStarted(sym: string, cy: any, price: number, bt: BestCycleTrade | null): string {
  const lines: string[] = []
  lines.push(`🛫 *NEW ${cy.cycleLabel} CYCLE — ${sym}*`)
  lines.push(`━━━━━━━━━━━━━━━━`)
  lines.push(`Starts: ${cy.cycleStart} · Ends: ${cy.cycleEnd}`)
  lines.push(`Anchor: ${cy.seedKind === 'HIGH' ? '🔻' : '🔺'} ${cy.seedName}`)
  lines.push(`LTP: \`₹${price.toFixed(2)}\``)
  if (bt) {
    lines.push(``)
    lines.push(`🎯 *Suggested play*`)
    lines.push(`${bt.direction} · ${bt.confidence}`)
    lines.push(`Entry \`₹${bt.entry}\` · SL \`₹${bt.stopLoss}\` · T1 \`₹${bt.target1}\` · T2 \`₹${bt.target2}\``)
    lines.push(`Horizon: ${bt.holdDays} sessions`)
  }
  return lines.join('\n')
}

function formatReversalConfirmed(sym: string, r: any, price: number, level: any, bt: BestCycleTrade | null): string {
  const lines: string[] = []
  lines.push(`✅ *REVERSAL CONFIRMED — ${sym}*`)
  lines.push(`━━━━━━━━━━━━━━━━`)
  lines.push(`Date hit: ${r.date} (${r.cycleLabel} from ${r.seedName})`)
  lines.push(`Price @ Gann ${level.label}: \`₹${level.price.toFixed(2)}\` (${level.distancePct.toFixed(2)}% away)`)
  lines.push(`LTP: \`₹${price.toFixed(2)}\``)
  if (bt) {
    lines.push(``)
    lines.push(`🎯 *Cycle play now confirmed*`)
    lines.push(`${bt.direction} · ${bt.confidence} confidence`)
    lines.push(`Entry \`₹${bt.entry}\` · SL \`₹${bt.stopLoss}\``)
    lines.push(`T1 \`₹${bt.target1}\` · T2 \`₹${bt.target2}\``)
    lines.push(`Exit by: ${bt.exitByDate}`)
  }
  return lines.join('\n')
}
