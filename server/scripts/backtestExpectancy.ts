/**
 * Expectancy backtest — the only metric that determines profitability.
 *
 *   Expectancy = (win_rate × avg_win) − (loss_rate × avg_loss)
 *   R-multiple = avg_win / avg_loss
 *
 * Industry-standard ship gates (positive-expectancy trading):
 *   • Expectancy per trade > +1.0%  (after slippage assumption: 0.2% per trade)
 *   • R-multiple ≥ 1.5
 *   • Minimum 30 closed trades (statistical floor)
 *
 * For each screener fire, we walk forward 10 sessions and record:
 *   - hit_T1  → realised gain = entry → T1
 *   - hit_SL  → realised loss = entry → SL
 *   - pending → measure ACTUAL end-of-window close, partial credit
 *
 * Compute mean realised %, then expectancy from full distribution.
 */
import * as data from '../src/data'
import { resolveUniverse } from '../src/screeners/universe'
import { ADVANCED_PREMOVE_SCREENERS } from '../src/screeners/preMoveAdvanced'
import type { Candle } from '../src/types'

const FORWARD_BARS = 10
const SLIPPAGE_PCT = 0.2                // round-trip slippage
const MIN_TRADES = 30

interface Trade { outcome: 'WIN' | 'LOSS' | 'PARTIAL'; realisedPct: number }
interface ScreenerStats {
  id: string; trades: Trade[]
}

function trAtBar(candles: Candle[], i: number): number {
  let sum = 0
  for (let k = Math.max(1, i - 13); k <= i; k++) {
    const c = candles[k]
    const p = candles[k - 1]
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
    sum += tr
  }
  return sum / 14
}

async function backtestSymbol(symbol: string, candles: Candle[], stats: Map<string, ScreenerStats>): Promise<void> {
  if (candles.length < 120) return
  const start = Math.max(60, candles.length - 110)
  const end = candles.length - FORWARD_BARS - 1
  for (let i = start; i <= end; i++) {
    const slice = candles.slice(0, i + 1)
    for (const s of ADVANCED_PREMOVE_SCREENERS) {
      try {
        const r = s.scan(slice, symbol)
        if (!r || !r.suggestedEntry || !r.suggestedSL || !r.suggestedTarget) continue
        const fwd = candles.slice(i + 1, i + 1 + FORWARD_BARS)
        const entry = r.suggestedEntry
        const sl = r.suggestedSL
        const t1 = r.suggestedTarget
        let outcome: Trade['outcome'] = 'PARTIAL'
        let exitPx = fwd[fwd.length - 1]?.close ?? entry
        for (const c of fwd) {
          if (r.direction === 'BULL') {
            if (c.low <= sl) { outcome = 'LOSS'; exitPx = sl; break }
            if (c.high >= t1) { outcome = 'WIN'; exitPx = t1; break }
          } else {
            if (c.high >= sl) { outcome = 'LOSS'; exitPx = sl; break }
            if (c.low <= t1) { outcome = 'WIN'; exitPx = t1; break }
          }
        }
        const realised = r.direction === 'BULL'
          ? ((exitPx - entry) / entry) * 100
          : ((entry - exitPx) / entry) * 100
        const stat = stats.get(s.id) ?? { id: s.id, trades: [] }
        stat.trades.push({ outcome, realisedPct: realised })
        stats.set(s.id, stat)
      } catch { /* skip */ }
    }
  }
}

function analyze(s: ScreenerStats): {
  id: string; n: number; wins: number; losses: number; partials: number
  winRate: number; avgWin: number; avgLoss: number; rMultiple: number
  expectancy: number; netExpectancy: number; ship: boolean
} {
  const n = s.trades.length
  const wins = s.trades.filter(t => t.outcome === 'WIN').length
  const losses = s.trades.filter(t => t.outcome === 'LOSS').length
  const partials = s.trades.filter(t => t.outcome === 'PARTIAL').length
  const winTrades = s.trades.filter(t => t.outcome === 'WIN')
  const lossTrades = s.trades.filter(t => t.outcome === 'LOSS')
  const avgWin = winTrades.length ? winTrades.reduce((s, t) => s + t.realisedPct, 0) / winTrades.length : 0
  const avgLoss = lossTrades.length ? Math.abs(lossTrades.reduce((s, t) => s + t.realisedPct, 0) / lossTrades.length) : 0
  // Include partials at their actual realised pct
  const partialMean = partials > 0
    ? s.trades.filter(t => t.outcome === 'PARTIAL').reduce((s, t) => s + t.realisedPct, 0) / partials
    : 0
  const winRate = (wins + losses) > 0 ? wins / (wins + losses) : 0
  const rMultiple = avgLoss > 0 ? avgWin / avgLoss : 0
  // Expectancy uses ALL trades incl partials weighted at realised
  const expectancy = n > 0
    ? s.trades.reduce((s, t) => s + t.realisedPct, 0) / n
    : 0
  const netExpectancy = expectancy - SLIPPAGE_PCT
  const ship = n >= MIN_TRADES && rMultiple >= 1.5 && netExpectancy > 1.0
  return { id: s.id, n, wins, losses, partials, winRate, avgWin, avgLoss, rMultiple, expectancy, netExpectancy, ship }
}

async function main(): Promise<void> {
  console.log('═'.repeat(82))
  console.log('EXPECTANCY BACKTEST — positive-expectancy gate (industry standard)')
  console.log('═'.repeat(82))
  console.log(`Ship rule: ≥${MIN_TRADES} trades · R-multiple ≥ 1.5 · net expectancy > +1.0% (after ${SLIPPAGE_PCT}% slippage)`)
  console.log(`Window: past 120 daily candles · forward look ${FORWARD_BARS} sessions\n`)

  const universe = (await resolveUniverse('CNX500')).slice(0, 200)
  const stats = new Map<string, ScreenerStats>()
  const q = [...universe]
  let processed = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (q.length) {
      const sym = q.shift()!
      try {
        const candles = await data.getCandles(sym, '1D', 150)
        if (candles.length >= 120) await backtestSymbol(sym, candles, stats)
      } catch { /* skip */ }
      processed++
      if (processed % 20 === 0) process.stderr.write('.')
    }
  }))
  process.stderr.write('\n\n')

  const analysed = [...stats.values()].map(analyze).sort((a, b) => b.netExpectancy - a.netExpectancy)
  console.log(
    'Screener'.padEnd(30) + 'N'.padStart(6) + 'WinR%'.padStart(8) +
    'AvgWin'.padStart(8) + 'AvgLoss'.padStart(9) + 'R-mult'.padStart(8) +
    'Exp%'.padStart(8) + 'Net%'.padStart(8) + '  Ship?',
  )
  console.log('-'.repeat(82))
  for (const a of analysed) {
    if (a.n < 5) continue
    const ship = a.ship ? '✅ SHIP' :
      a.netExpectancy > 0 && a.n >= MIN_TRADES ? '⚠ pos but R<1.5' :
      a.n < MIN_TRADES ? `⏸ only ${a.n}` : '❌ drop'
    console.log(
      a.id.padEnd(30) +
      String(a.n).padStart(6) +
      (a.winRate * 100).toFixed(1).padStart(8) +
      a.avgWin.toFixed(2).padStart(8) +
      a.avgLoss.toFixed(2).padStart(9) +
      a.rMultiple.toFixed(2).padStart(8) +
      a.expectancy.toFixed(2).padStart(8) +
      a.netExpectancy.toFixed(2).padStart(8) +
      `  ${ship}`,
    )
  }
  console.log()
  const shippable = analysed.filter(a => a.ship)
  console.log(`PRODUCTION-ELIGIBLE: ${shippable.length}`)
  for (const s of shippable) {
    console.log(`  ✅ ${s.id}: R=${s.rMultiple.toFixed(2)} · net expectancy ${s.netExpectancy >= 0 ? '+' : ''}${s.netExpectancy.toFixed(2)}% over ${s.n} trades`)
  }
  const fs = await import('fs/promises')
  const path = await import('path')
  await fs.writeFile(
    path.resolve(__dirname, '../data/learning/expectancy-backtest.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), gate: { minTrades: MIN_TRADES, minR: 1.5, minNetExp: 1.0, slippagePct: SLIPPAGE_PCT }, results: analysed }, null, 2),
  )
  console.log('\n→ Results saved to server/data/learning/expectancy-backtest.json')
}
main().catch(e => { console.error(e); process.exit(1) })
