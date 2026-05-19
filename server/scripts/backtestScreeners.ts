/**
 * Universal screener backtest — measures hit rate of every advanced
 * pre-move screener against forward-looking returns.
 *
 * Definition of "win": after a screener fires on bar T, did the price
 * reach the suggested T1 within 10 sessions (without first hitting SL)?
 * For BEAR signals, inverted.
 *
 * Only screeners hitting ≥ 85% win rate are eligible for production.
 *
 * Run:
 *   npx tsx server/scripts/backtestScreeners.ts
 *
 * Universe: CNX 500 (curated 500 names) for speed.
 * Window: past 120 daily candles per symbol; signals tested on bars
 *   -110 to -10 so each fired signal has ≥10 sessions of forward data.
 */
import * as data from '../src/data'
import { resolveUniverse } from '../src/screeners/universe'
import { ADVANCED_PREMOVE_SCREENERS } from '../src/screeners/preMoveAdvanced'
import type { Screener, ScreenerResult } from '../src/screeners/types'
import type { Candle } from '../src/types'

const FORWARD_BARS = 10                  // how many sessions to wait for T1
const MIN_SIGNALS_PER_SCREENER = 5       // need at least 5 fires to compute stable rate
const PRODUCTION_THRESHOLD = 0.85        // 85% hit rate gate

interface ScreenerStats {
  id: string
  name: string
  fires: number
  wins: number
  losses: number
  pending: number          // didn't reach T1 OR SL in 10 sessions
  winRate: number          // wins / (wins + losses)
  examples: { symbol: string; date: string; direction: string; outcome: string }[]
}

function pad(s: string, n: number): string { return (s + ' '.repeat(n)).slice(0, n) }

async function backtestSymbol(symbol: string, candles: Candle[], stats: Map<string, ScreenerStats>): Promise<void> {
  if (candles.length < 120) return
  // Walk bars from index 60 (need 60 lookback) to length-FORWARD_BARS
  const start = Math.max(60, candles.length - 110)
  const end = candles.length - FORWARD_BARS - 1
  for (let i = start; i <= end; i++) {
    const slice = candles.slice(0, i + 1)        // candles UP TO and INCLUDING bar i
    for (const s of ADVANCED_PREMOVE_SCREENERS) {
      try {
        const r: ScreenerResult | null = s.scan(slice, symbol)
        if (!r) continue
        if (!r.suggestedEntry || !r.suggestedSL || !r.suggestedTarget) continue
        // Walk forward 10 bars, check if T1 or SL hit first
        const fwd = candles.slice(i + 1, i + 1 + FORWARD_BARS)
        let outcome: 'WIN' | 'LOSS' | 'PENDING' = 'PENDING'
        for (const c of fwd) {
          if (r.direction === 'BULL') {
            if (c.low <= r.suggestedSL) { outcome = 'LOSS'; break }
            if (c.high >= r.suggestedTarget) { outcome = 'WIN'; break }
          } else if (r.direction === 'BEAR') {
            if (c.high >= r.suggestedSL) { outcome = 'LOSS'; break }
            if (c.low <= r.suggestedTarget) { outcome = 'WIN'; break }
          }
        }
        const stat = stats.get(s.id) ?? { id: s.id, name: s.name, fires: 0, wins: 0, losses: 0, pending: 0, winRate: 0, examples: [] }
        stat.fires++
        if (outcome === 'WIN') stat.wins++
        else if (outcome === 'LOSS') stat.losses++
        else stat.pending++
        if (stat.examples.length < 3) {
          stat.examples.push({
            symbol,
            date: new Date(candles[i].time).toISOString().slice(0, 10),
            direction: r.direction,
            outcome,
          })
        }
        stats.set(s.id, stat)
      } catch { /* skip — defensive */ }
    }
  }
}

async function main(): Promise<void> {
  console.log('═'.repeat(80))
  console.log('SCREENER BACKTEST — 85% win-rate gate')
  console.log('═'.repeat(80))
  const universe = (await resolveUniverse('CNX500')).slice(0, 200)   // top 200 for speed
  console.log(`Universe: ${universe.length} symbols`)
  console.log(`Window: past 120 daily candles, signals on bars -110 to -10`)
  console.log(`Win definition: T1 hit within ${FORWARD_BARS} sessions WITHOUT first hitting SL\n`)

  const stats = new Map<string, ScreenerStats>()
  let processed = 0
  // Concurrency 4 to stay inside Angel rate budget
  const q = [...universe]
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (q.length) {
      const sym = q.shift()!
      try {
        const candles = await data.getCandles(sym, '1D', 150)
        if (candles.length >= 120) await backtestSymbol(sym, candles, stats)
      } catch { /* skip */ }
      processed++
      if (processed % 20 === 0) process.stderr.write(`.`)
    }
  }))
  process.stderr.write('\n')

  // Sort by win rate desc, but only screeners with ≥ MIN_SIGNALS_PER_SCREENER
  const sorted = Array.from(stats.values())
    .map(s => {
      const tradedCount = s.wins + s.losses
      s.winRate = tradedCount > 0 ? s.wins / tradedCount : 0
      return s
    })
    .sort((a, b) => b.winRate - a.winRate)

  console.log('\n' + '═'.repeat(80))
  console.log('RESULTS — sorted by win rate')
  console.log('═'.repeat(80))
  console.log(pad('Screener', 30) + pad('Fires', 8) + pad('Wins', 6) + pad('Loss', 6) + pad('Pend', 6) + pad('Win%', 8) + 'Production?')
  console.log('-'.repeat(80))
  for (const s of sorted) {
    if (s.fires < MIN_SIGNALS_PER_SCREENER) continue
    const pct = (s.winRate * 100).toFixed(1) + '%'
    const verdict = s.winRate >= PRODUCTION_THRESHOLD ? '✅ SHIP'
      : s.winRate >= 0.70 ? '⚠ near'
      : '❌ drop'
    console.log(
      pad(s.id.slice(0, 28), 30)
      + pad(String(s.fires), 8)
      + pad(String(s.wins), 6)
      + pad(String(s.losses), 6)
      + pad(String(s.pending), 6)
      + pad(pct, 8)
      + verdict,
    )
  }
  console.log()
  const passing = sorted.filter(s => s.winRate >= PRODUCTION_THRESHOLD && s.fires >= MIN_SIGNALS_PER_SCREENER)
  console.log(`PRODUCTION-ELIGIBLE (≥ ${PRODUCTION_THRESHOLD * 100}% win rate): ${passing.length}`)
  for (const p of passing) {
    console.log(`  ✅ ${p.id} — ${(p.winRate * 100).toFixed(1)}% over ${p.wins + p.losses} closed trades`)
    for (const ex of p.examples) {
      console.log(`     · ${ex.symbol} ${ex.date} ${ex.direction} → ${ex.outcome}`)
    }
  }
  // Write JSON for the publisher
  const out = {
    ranAt: new Date().toISOString(),
    universe: 'CNX500',
    candidates: sorted.length,
    productionEligible: passing.map(p => p.id),
    results: sorted.map(s => ({
      id: s.id, name: s.name, fires: s.fires,
      wins: s.wins, losses: s.losses, pending: s.pending,
      winRate: +(s.winRate * 100).toFixed(1),
    })),
  }
  const fs = await import('fs/promises')
  const path = await import('path')
  await fs.writeFile(
    path.resolve(__dirname, '../data/learning/screener-backtest.json'),
    JSON.stringify(out, null, 2),
  )
  console.log('\n→ Results saved to server/data/learning/screener-backtest.json')
}

main().catch(e => { console.error(e); process.exit(1) })
