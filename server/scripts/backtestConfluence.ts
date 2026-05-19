/**
 * Confluence backtest — when 2+ screeners fire on the same bar for the same
 * symbol AND in the same direction, does win-rate climb to ≥85%?
 *
 * Logic: walk every bar, collect ALL fires per bar, group by direction,
 * count corroboration. If ≥N screeners fire same direction on bar T → it's
 * a "confluence signal". Measure T1-within-10 hit rate on those.
 */
import * as data from '../src/data'
import { resolveUniverse } from '../src/screeners/universe'
import { ADVANCED_PREMOVE_SCREENERS } from '../src/screeners/preMoveAdvanced'
import type { Candle } from '../src/types'

const FORWARD_BARS = 10
const T1_PCT = 0.06              // 6% target — universal across confluence levels
const SL_ATR_MULT = 1.5

interface ConfluenceStats {
  level: number             // 1 = any one fire, 2 = ≥2 fires, etc.
  signals: number
  wins: number
  losses: number
  pending: number
  winRate: number
  examples: { symbol: string; date: string; dir: string; outcome: string; fires: string[] }[]
}

async function backtestSymbol(symbol: string, candles: Candle[], stats: Map<number, ConfluenceStats>): Promise<void> {
  if (candles.length < 120) return
  const start = Math.max(60, candles.length - 110)
  const end = candles.length - FORWARD_BARS - 1
  for (let i = start; i <= end; i++) {
    const slice = candles.slice(0, i + 1)
    const bullFires: string[] = []
    const bearFires: string[] = []
    for (const s of ADVANCED_PREMOVE_SCREENERS) {
      try {
        const r = s.scan(slice, symbol)
        if (!r) continue
        if (r.direction === 'BULL') bullFires.push(s.id)
        else if (r.direction === 'BEAR') bearFires.push(s.id)
      } catch { /* skip */ }
    }
    const last = candles[i]
    const atr = (() => {
      let sumTR = 0
      for (let k = Math.max(1, i - 13); k <= i; k++) {
        const c = candles[k]
        const p = candles[k - 1]
        const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
        sumTR += tr
      }
      return sumTR / 14
    })()
    const fwd = candles.slice(i + 1, i + 1 + FORWARD_BARS)
    function evaluate(dir: 'BULL' | 'BEAR', fires: string[]): { outcome: 'WIN' | 'LOSS' | 'PENDING' } {
      const t1 = dir === 'BULL' ? last.close * (1 + T1_PCT) : last.close * (1 - T1_PCT)
      const sl = dir === 'BULL' ? last.close - atr * SL_ATR_MULT : last.close + atr * SL_ATR_MULT
      for (const c of fwd) {
        if (dir === 'BULL') {
          if (c.low <= sl) return { outcome: 'LOSS' }
          if (c.high >= t1) return { outcome: 'WIN' }
        } else {
          if (c.high >= sl) return { outcome: 'LOSS' }
          if (c.low <= t1) return { outcome: 'WIN' }
        }
      }
      return { outcome: 'PENDING' }
    }

    // Test confluence levels 1, 2, 3+
    for (const lvl of [1, 2, 3]) {
      // For BULL
      if (bullFires.length >= lvl) {
        const ev = evaluate('BULL', bullFires)
        const stat = stats.get(lvl) ?? { level: lvl, signals: 0, wins: 0, losses: 0, pending: 0, winRate: 0, examples: [] }
        stat.signals++
        if (ev.outcome === 'WIN') stat.wins++
        else if (ev.outcome === 'LOSS') stat.losses++
        else stat.pending++
        if (stat.examples.length < 3) {
          stat.examples.push({
            symbol, date: new Date(last.time).toISOString().slice(0, 10),
            dir: 'BULL', outcome: ev.outcome, fires: bullFires,
          })
        }
        stats.set(lvl, stat)
      }
      // For BEAR
      if (bearFires.length >= lvl) {
        const ev = evaluate('BEAR', bearFires)
        const stat = stats.get(lvl) ?? { level: lvl, signals: 0, wins: 0, losses: 0, pending: 0, winRate: 0, examples: [] }
        stat.signals++
        if (ev.outcome === 'WIN') stat.wins++
        else if (ev.outcome === 'LOSS') stat.losses++
        else stat.pending++
        stats.set(lvl, stat)
      }
    }
  }
}

async function main(): Promise<void> {
  console.log('═'.repeat(80))
  console.log('CONFLUENCE BACKTEST — does requiring N+ screeners lift win rate to 85%?')
  console.log('═'.repeat(80))
  const universe = (await resolveUniverse('CNX500')).slice(0, 200)
  console.log(`Universe: ${universe.length} symbols · target: T1 = ±6% within 10 sessions\n`)
  const stats = new Map<number, ConfluenceStats>()
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

  for (const [lvl, s] of [...stats.entries()].sort()) {
    const traded = s.wins + s.losses
    s.winRate = traded > 0 ? s.wins / traded : 0
    const verdict = s.winRate >= 0.85 ? '✅ SHIP'
      : s.winRate >= 0.70 ? '⚠ near'
      : '❌ drop'
    console.log(`Confluence ≥${lvl}:  ${s.signals} signals  ·  ${s.wins} wins  ·  ${s.losses} losses  ·  ${s.pending} pending  ·  win-rate ${(s.winRate * 100).toFixed(1)}%  ${verdict}`)
    for (const ex of s.examples) {
      console.log(`     · ${ex.symbol} ${ex.date} ${ex.dir} → ${ex.outcome}  (fires: ${ex.fires.join(' + ')})`)
    }
    console.log()
  }
  const fs = await import('fs/promises')
  const path = await import('path')
  await fs.writeFile(
    path.resolve(__dirname, '../data/learning/confluence-backtest.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), levels: [...stats.values()] }, null, 2),
  )
}
main().catch(e => { console.error(e); process.exit(1) })
