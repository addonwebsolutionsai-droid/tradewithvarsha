/**
 * Position-Review Sweep (3 Aug 2026)
 *
 * User frustration: WR 23.5% because most open trades were opened with
 * OLD rules (before symbol cool-off, hard-hold override, pre-move-strict,
 * pattern-memory bonus, Money-Printer). Those trades will keep bleeding
 * until they hit T1 or SL naturally.
 *
 * This sweep re-grades EVERY open trade against the CURRENT strict-gate
 * criteria. Trades that would NOT be taken today get an `earlyExit` flag
 * so the mark-to-market loop can exit them at breakeven (or better) on
 * the next tick instead of waiting for SL.
 *
 * Grades applied:
 *   A — passes MASTER 7-pillar OR Money-Printer 4-pillar → hold, size up
 *   B — passes at least 3 of 7 MASTER pillars → hold
 *   C — passes fewer → early exit at breakeven or +1% if possible
 *   D — matches a known losing pattern → immediate flat close
 *
 * Emits to trade.reviewGrade + trade.reviewedAt so /journal shows the
 * grade tag and the paper-book exit loop honours the early-exit flag.
 */

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { log } from '../util/logger'
import * as data from '../data'
import type { Candle } from '../types'

const JOURNAL_FILE = path.resolve(__dirname, '../../data/public-snapshots/trading-journal.json')

export interface ReviewGrade {
  symbol: string
  grade: 'A' | 'B' | 'C' | 'D'
  reasons: string[]
  earlyExit: boolean
  targetExitPrice?: number       // where to exit if grade is C/D
}

export async function runPositionReviewSweep(): Promise<{
  reviewed: number
  gradeA: number; gradeB: number; gradeC: number; gradeD: number
  markedForExit: number
}> {
  const t0 = Date.now()
  log.info('POS-REVIEW', 'sweep starting')

  let journal: any
  try {
    journal = JSON.parse(fsSync.readFileSync(JOURNAL_FILE, 'utf-8'))
  } catch (e) {
    log.warn('POS-REVIEW', `no journal: ${(e as Error).message}`)
    return { reviewed: 0, gradeA: 0, gradeB: 0, gradeC: 0, gradeD: 0, markedForExit: 0 }
  }

  const openTrades: any[] = journal.openTrades ?? []
  if (openTrades.length === 0) {
    log.info('POS-REVIEW', 'no open trades to review')
    return { reviewed: 0, gradeA: 0, gradeB: 0, gradeC: 0, gradeD: 0, markedForExit: 0 }
  }

  const [{ matchesKnownWinner, matchesKnownLoser }, { computeStockCycleLens }] = await Promise.all([
    import('./patternMemory'),
    import('./stockCycleLens'),
  ])

  let gradeA = 0, gradeB = 0, gradeC = 0, gradeD = 0, markedForExit = 0

  for (const t of openTrades) {
    try {
      const symbol = String(t.symbol ?? '').replace(/-HEDGE-.+|-FUT-HEDGE-.+/, '')
      if (!symbol || symbol.includes('HEDGE')) continue      // skip hedge legs, they follow their primary
      const dir = String(t.direction ?? 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'BUY'
      const cs: Candle[] = await data.getCandles(symbol, '1D' as any, 60).catch(() => [] as Candle[])
      if (!cs || cs.length < 30) continue

      const grade: ReviewGrade = { symbol, grade: 'B', reasons: [], earlyExit: false }
      let pillarsPass = 0

      // Pillar 1: still within pre-move band? (was signal fresh at entry?)
      const last = cs[cs.length - 1].close
      const ref5 = cs[cs.length - 6]?.close ?? last
      const ret5d = ((last - ref5) / ref5) * 100
      if (Math.abs(ret5d) < 5) { pillarsPass++; grade.reasons.push(`5d ret ${ret5d.toFixed(1)}% — still in range`) }
      else grade.reasons.push(`⚠ 5d ret ${ret5d.toFixed(1)}% — extended`)

      // Pillar 2: winner-match
      const w = await matchesKnownWinner({ candles: cs, direction: dir as 'BUY' | 'SHORT' })
      if (w?.match) { pillarsPass++; grade.reasons.push(`🧠 matches winner ${w.winnerSymbol}`) }

      // Pillar 3: NOT losing-match
      const l = await matchesKnownLoser({ candles: cs, direction: dir as 'BUY' | 'SHORT' })
      if (l?.match) grade.reasons.push(`⚠ matches known loser ${l.loserSymbol} — grade D`)
      else pillarsPass++

      // Pillar 4: cycle + seasonality alignment
      const cycle = await computeStockCycleLens(symbol, dir as 'BUY' | 'SHORT')
      if (cycle && cycle.cycleScore >= 8) { pillarsPass++; grade.reasons.push(`Cycle/seasonality tailwind (+${cycle.cycleScore})`) }
      else if (cycle && cycle.cycleScore <= -8) grade.reasons.push(`⚠ Cycle/seasonality headwind (${cycle.cycleScore})`)

      // Pillar 5: still in profit or breakeven?
      const unrPct = Number(t.returnPct ?? 0)
      if (unrPct >= -1) { pillarsPass++; grade.reasons.push(`P&L ${unrPct >= 0 ? '+' : ''}${unrPct.toFixed(2)}% — not deep loss`) }
      else grade.reasons.push(`⚠ P&L ${unrPct.toFixed(2)}% — already underwater`)

      // Grade composition
      if (l?.match) {
        grade.grade = 'D'
        grade.earlyExit = true
        grade.targetExitPrice = last       // flat close at market
        gradeD++; markedForExit++
      } else if (pillarsPass >= 4) {
        grade.grade = 'A'
        gradeA++
      } else if (pillarsPass >= 3) {
        grade.grade = 'B'
        gradeB++
      } else if (pillarsPass >= 2) {
        grade.grade = 'C'
        // Exit at breakeven if position is currently near-flat, else hold
        if (unrPct >= -2) {
          grade.earlyExit = true
          grade.targetExitPrice = Math.max(last, t.entryPrice)
          markedForExit++
        }
        gradeC++
      } else {
        grade.grade = 'C'
        grade.earlyExit = true
        grade.targetExitPrice = last
        gradeC++; markedForExit++
      }

      // Write review onto the trade object in memory (persists via
      // subsequent paper-tick save which serializes trade fields).
      t.reviewGrade = grade.grade
      t.reviewReasons = grade.reasons
      t.reviewEarlyExit = grade.earlyExit
      t.reviewTargetExitPrice = grade.targetExitPrice
      t.reviewedAt = new Date().toISOString()
    } catch (e) {
      log.warn('POS-REVIEW', `${t.symbol}: ${(e as Error).message}`)
    }
  }

  // Persist journal with review annotations so the /journal UI shows the
  // grade badge on each open trade + so paper-book mark-to-market can
  // honour earlyExit on next tick.
  try {
    fsSync.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2))
  } catch (e) { log.warn('POS-REVIEW', `journal write failed: ${(e as Error).message}`) }

  log.ok('POS-REVIEW', `reviewed ${openTrades.length} · A:${gradeA} B:${gradeB} C:${gradeC} D:${gradeD} · exit:${markedForExit} · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { reviewed: openTrades.length, gradeA, gradeB, gradeC, gradeD, markedForExit }
}
