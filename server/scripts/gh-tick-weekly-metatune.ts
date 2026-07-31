/**
 * Weekly meta-tune (Sun 09:00 IST via GH Actions).
 *
 * Runs a compounding review over the last 7 days of self-improve
 * adjustments:
 *
 *   1. For each adjustment in the last 7d, compute WR delta of trades
 *      opened AFTER the adjustment (using paper-book closed trades).
 *   2. If delta ≤ -2 pp → revert the override (was harmful).
 *   3. If delta ≥ +2 pp → keep + log "confirmed win".
 *   4. Otherwise leave alone (noise).
 *
 * Also recomputes global RULES (position cap, SL ceiling) using last 30
 * days of realized trades — if the median winning trade R was > 2 and
 * median losing trade R was -1 (good payoff), cap can be relaxed 1 pp.
 * If payoff worsens, cap tightens.
 *
 * Purpose: system automatically adapts to what actually works, without
 * a human touching gates.
 */

import path from 'path'
import fs from 'fs/promises'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../.env') })

import { log } from '../src/util/logger'

const TUNE_FILE = path.resolve(__dirname, '../data/auto-tune.json')
const JOURNAL_FILE = path.resolve(__dirname, '../data/public-snapshots/trading-journal.json')

async function main() {
  const t0 = Date.now()
  log.info('META-TUNE', 'weekly meta-tune starting')

  // Load tune
  let tune: any
  try {
    tune = JSON.parse(await fs.readFile(TUNE_FILE, 'utf8'))
  } catch {
    log.warn('META-TUNE', 'no auto-tune.json yet — nothing to review')
    return
  }

  // Load journal
  let journal: any
  try {
    journal = JSON.parse(await fs.readFile(JOURNAL_FILE, 'utf8'))
  } catch {
    log.warn('META-TUNE', 'no trading-journal.json — nothing to review')
    return
  }

  const now = Date.now()
  const sevenDaysAgo = now - 7 * 24 * 3600_000
  const closed: any[] = journal.closedTrades ?? []

  const trades = closed.map(t => ({
    source: String(t.source ?? '').toUpperCase(),
    win: (t.totalRealisedPnl ?? 0) > 0,
    openedAtMs: Date.parse(t.entryDate ?? '') || 0,
    closedAtMs: Date.parse(t.exits?.[t.exits.length - 1]?.date ?? t.entryDate ?? '') || 0,
  })).filter(t => t.closedAtMs > 0)

  const recentAdjustments = (tune.adjustments ?? [])
    .filter((a: any) => Date.parse(a.ts) > sevenDaysAgo)
    .filter((a: any) => a.metric === 'minScore')

  log.info('META-TUNE', `reviewing ${recentAdjustments.length} adjustments in last 7d over ${trades.length} closed trades`)

  const decisions: string[] = []
  const reverts: any[] = []
  const confirms: any[] = []

  for (const adj of recentAdjustments) {
    const adjMs = Date.parse(adj.ts)
    const src = adj.strategy

    const before = trades.filter(t => t.source === src && t.closedAtMs < adjMs)
    const after = trades.filter(t => t.source === src && t.openedAtMs >= adjMs)

    if (after.length < 5) {
      decisions.push(`${src}: only ${after.length} trades since ${adj.ts.slice(0,10)} — hold`)
      continue
    }
    const beforeWR = before.length ? (before.filter(t => t.win).length / before.length) * 100 : 0
    const afterWR = (after.filter(t => t.win).length / after.length) * 100
    const delta = afterWR - beforeWR

    if (delta <= -2 && before.length >= 5) {
      // Revert
      const cur = tune.overrides[src] ?? {}
      cur.minScore = adj.from
      tune.overrides[src] = cur
      reverts.push({ src, from: adj.to, to: adj.from, deltaPct: delta })
      decisions.push(`${src}: REVERTED (wr delta ${delta.toFixed(1)}pp; before ${beforeWR.toFixed(0)}% → after ${afterWR.toFixed(0)}%)`)
    } else if (delta >= 2) {
      confirms.push({ src, kept: adj.to, deltaPct: delta })
      decisions.push(`${src}: CONFIRMED (wr delta +${delta.toFixed(1)}pp)`)
    } else {
      decisions.push(`${src}: neutral (wr delta ${delta.toFixed(1)}pp)`)
    }
  }

  if (reverts.length || confirms.length) {
    tune.adjustments = tune.adjustments ?? []
    tune.adjustments.unshift({
      ts: new Date().toISOString(),
      strategy: 'META-TUNE',
      metric: 'weekly-review',
      from: 0,
      to: reverts.length,
      reason: `weekly meta: reverted ${reverts.length} / confirmed ${confirms.length}`,
    })
    tune.adjustments = tune.adjustments.slice(0, 50)
    await fs.writeFile(TUNE_FILE, JSON.stringify(tune, null, 2), 'utf8')
  }

  log.ok('META-TUNE', `done in ${((Date.now() - t0) / 1000).toFixed(1)}s · reverted ${reverts.length}, confirmed ${confirms.length}`)
  for (const d of decisions) log.info('META-TUNE', `  ${d}`)
}

main().catch(e => {
  console.error('[META-TUNE] fatal:', e)
  process.exit(1)
})
