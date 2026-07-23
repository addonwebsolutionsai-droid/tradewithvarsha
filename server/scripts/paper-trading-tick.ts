/**
 * One-shot runner for the paper trading book.
 *
 *   npx ts-node --transpile-only scripts/paper-trading-tick.ts        # normal daily tick
 *   RESET=1 npx ts-node --transpile-only scripts/paper-trading-tick.ts # wipe + start fresh
 */
import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../.env') })

import { runPaperTradingDailyTick, resetBook } from '../src/engine/paperTradingBook'

async function main() {
  if (process.env.RESET === '1') {
    console.log('Resetting book...')
    resetBook()
  }
  const book = await runPaperTradingDailyTick()

  console.log('\n═══ PAPER TRADING BOOK ═══')
  console.log(`  Started:     ${book.startedAt}`)
  console.log(`  Last update: ${book.lastUpdatedAt}`)
  console.log(`  Days:        ${Math.max(0, Math.round((new Date(book.lastUpdatedAt).getTime() - new Date(book.startedAt).getTime()) / 86_400_000))}`)
  console.log()
  console.log(`  Starting capital:  ₹${book.startingCapital.toLocaleString('en-IN')}`)
  console.log(`  Current cash:      ₹${book.ledger.currentCash.toLocaleString('en-IN')}`)
  console.log(`  Open positions:    ₹${book.ledger.openPositionsValue.toLocaleString('en-IN')}`)
  console.log(`  Book value:        ₹${book.ledger.bookValue.toLocaleString('en-IN')}`)
  console.log(`  Return:            ${book.ledger.totalReturnPct.toFixed(2)}%`)
  console.log(`  Realised P&L:      ₹${book.ledger.totalRealisedPnl.toLocaleString('en-IN')}`)
  console.log(`  Unrealised P&L:    ₹${book.ledger.totalUnrealisedPnl.toLocaleString('en-IN')}`)
  console.log()
  console.log(`  Total trades:      ${book.performance.totalTrades}`)
  console.log(`  Open:              ${book.performance.openTrades}`)
  console.log(`  Closed:            ${book.performance.closedTrades}`)
  console.log(`  Wins / Losses:     ${book.performance.wins} / ${book.performance.losses}`)
  console.log(`  Win rate:          ${book.performance.winRatePct}%`)
  console.log(`  Avg win:           ${book.performance.avgWinPct}%`)
  console.log(`  Avg loss:          ${book.performance.avgLossPct}%`)
  console.log(`  Biggest win:       ₹${book.performance.biggestWinInr.toLocaleString('en-IN')}`)
  console.log(`  Biggest loss:      ₹${book.performance.biggestLossInr.toLocaleString('en-IN')}`)
  console.log(`  Avg days held:     ${book.performance.avgDaysHeld}`)

  if (book.trades.length > 0) {
    console.log('\nRecent trades:')
    const recent = book.trades.slice(-8).reverse()
    for (const t of recent) {
      const pnlStr = t.totalPnl >= 0 ? `+₹${Math.round(t.totalPnl).toLocaleString('en-IN')}` : `-₹${Math.round(-t.totalPnl).toLocaleString('en-IN')}`
      console.log(`  ${t.entryDate} · ${t.symbol.padEnd(12)} · ${t.tier.padEnd(6)} · qty ${String(t.qty).padStart(4)} @ ₹${t.entryPrice.toFixed(2)} · ${t.status.padEnd(10)} · ${pnlStr} (${t.returnPct.toFixed(1)}%)`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
