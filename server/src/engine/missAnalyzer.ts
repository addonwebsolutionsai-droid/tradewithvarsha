/**
 * Daily Miss-Analyzer — for every 5%+ gainer the market saw today, check
 * whether OUR scanners flagged it. If missed, diagnose WHY (universe,
 * pre-breakout reject, conviction floor) so the user can audit + we can
 * auto-tune filters going forward.
 *
 * Data sources:
 *   - NSE's own /api/snapshot-derivatives or /api/equity-stockindices
 *     ?index=NIFTY%20100 etc. (free, server-side scrape via existing
 *     nse fetch helpers)
 *   - Fallback: aggregator endpoint already in place from existing
 *     gainers logic
 *
 * Output snapshot: miss-analysis.json with two sections:
 *   - caughtBy: Map of gainer symbol → which of our tabs flagged it
 *   - missedReasons: Array of (symbol, gain%, diagnosis) tuples
 *
 * Updates the daily catch-rate metric in accuracy.json downstream.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import * as data from '../data'
import { log } from '../util/logger'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

interface CaughtBy { [tab: string]: boolean }

export interface MissedRow {
  symbol: string
  gainPct: number
  caught: boolean
  caughtBy: CaughtBy
  diagnosis: string[]
}

async function readSnap(name: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(SNAP_DIR, name), 'utf8'))
  } catch { return null }
}

function norm(s: string): string { return (s || '').toUpperCase().replace(/[-_\s]/g, '') }

async function fetchTodayGainers(): Promise<{ symbol: string; gainPct: number }[]> {
  // Use NIFTY 500 derivatives screener which already supports getCandles.
  // Compute today's % move from last-candle vs prior close. This bypasses
  // 3rd-party scraping (which can block) and uses the same data layer
  // every other scanner uses.
  const { NIFTY_500_CORE } = require('../screeners/universe')
  const out: { symbol: string; gainPct: number }[] = []
  const BATCH = 8
  for (let i = 0; i < NIFTY_500_CORE.length; i += BATCH) {
    const batch = NIFTY_500_CORE.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(async (sym: string) => {
      try {
        const c = await data.getCandles(sym, '1D' as any, 3)
        if (!c || c.length < 2) return null
        const last = c[c.length - 1].close
        const prev = c[c.length - 2].close
        const pct = ((last - prev) / prev) * 100
        if (pct >= 5) return { symbol: sym, gainPct: +pct.toFixed(2) }
        return null
      } catch { return null }
    }))
    for (const r of results) if (r) out.push(r)
  }
  out.sort((a, b) => b.gainPct - a.gainPct)
  return out
}

export async function runMissAnalysis(): Promise<{
  generatedAt: string
  totalGainers: number
  caughtCount: number
  missedCount: number
  catchRate: number
  rows: MissedRow[]
  diagnoses: Record<string, number>     // count of each diagnosis reason
}> {
  const ts = new Date().toISOString()
  log.info('MISS-ANALYZER', 'fetching today\'s 5%+ gainers (NIFTY-500 + external sites)...')
  // Combine NIFTY-500 internal scan with external scraped gainers (finology +
  // trendlyne + groww). Externals catch micro/small caps NIFTY-500 misses.
  const internal = await fetchTodayGainers()
  let externalGainers: { symbol: string; gainPct: number; sources: string[] }[] = []
  try {
    const { fetchExternalGainers } = await import('../data/externalGainers')
    const ext = await fetchExternalGainers()
    externalGainers = ext.merged
  } catch (e) {
    log.warn('MISS-ANALYZER', `external gainers scrape failed: ${(e as Error).message}`)
  }
  // Merge: dedup by symbol, max gain wins
  const merged = new Map<string, { symbol: string; gainPct: number; src: string[] }>()
  for (const g of internal) merged.set(g.symbol.toUpperCase(), { symbol: g.symbol, gainPct: g.gainPct, src: ['NSE500'] })
  for (const g of externalGainers) {
    const k = g.symbol.toUpperCase()
    const prev = merged.get(k)
    if (prev) {
      prev.src.push(...g.sources)
      prev.gainPct = Math.max(prev.gainPct, g.gainPct)
    } else {
      merged.set(k, { symbol: g.symbol, gainPct: g.gainPct, src: g.sources })
    }
  }
  const gainers = Array.from(merged.values()).sort((a, b) => b.gainPct - a.gainPct)
  log.info('MISS-ANALYZER', `${internal.length} NSE500 + ${externalGainers.length} external = ${gainers.length} unique 5%+ gainers today`)

  // Load all our scanner snapshots so we can cross-reference
  const snaps = {
    weekly: await readSnap('weekly-pick'),
    preMove: await readSnap('pre-move'),
    daily: await readSnap('daily-pick'),
    fno: await readSnap('fno-futures'),
    ultra: await readSnap('cross-confluence'),
    ad: await readSnap('ad-divergence'),
    proedge: await readSnap('pro-edge'),
    oldwk: await readSnap('old-weekly-pick'),
    optsPro: await readSnap('options-pro'),
  }
  const symSet = (s: any, key = 'rows') => new Set((s?.[key] ?? []).map((r: any) => norm(r.symbol ?? r.instrument ?? '')))
  const inTabs = {
    Weekly:    symSet(snaps.weekly),
    PreMove:   symSet(snaps.preMove),
    Daily:     symSet(snaps.daily),
    FnoFut:    symSet(snaps.fno),
    UltraPicks: symSet(snaps.ultra),
    SmartMoney: symSet(snaps.ad),
    PROEdge:   symSet(snaps.proedge),
    OldWeekly: symSet(snaps.oldwk),
    OptionsPro: symSet(snaps.optsPro),
  }

  const rows: MissedRow[] = []
  const diagnosisCounts: Record<string, number> = {}
  let caught = 0
  for (const g of gainers) {
    const n = norm(g.symbol)
    const caughtBy: CaughtBy = {}
    for (const [tab, set] of Object.entries(inTabs)) {
      caughtBy[tab] = (set as Set<string>).has(n)
    }
    const isCaught = Object.values(caughtBy).some(v => v)
    if (isCaught) caught++

    // Diagnose miss reasons
    const diagnosis: string[] = []
    if (!isCaught) {
      // Pull recent candle features to guess why
      try {
        const cs = await data.getCandles(g.symbol, '1D' as any, 25)
        if (cs && cs.length >= 20) {
          const closes = cs.map(c => c.close)
          const last = closes[closes.length - 1]
          const prev5 = closes[closes.length - 6]
          const prev20 = closes[closes.length - 21] ?? closes[0]
          const ret5d_priorDay = ((closes[closes.length - 2] - prev5) / prev5) * 100
          const ret20d_priorDay = ((closes[closes.length - 2] - prev20) / prev20) * 100
          if (Math.abs(ret5d_priorDay) > 6) {
            diagnosis.push(`Pre-breakout filter rejected: prior-day |ret5d|=${ret5d_priorDay.toFixed(1)}% > 6% threshold`)
            diagnosisCounts['prebreakout_ret5d>6%'] = (diagnosisCounts['prebreakout_ret5d>6%'] ?? 0) + 1
          }
          if (Math.abs(ret20d_priorDay) > 25) {
            diagnosis.push(`Pre-breakout filter rejected: prior-day |ret20d|=${ret20d_priorDay.toFixed(1)}% > 25% threshold`)
            diagnosisCounts['prebreakout_ret20d>25%'] = (diagnosisCounts['prebreakout_ret20d>25%'] ?? 0) + 1
          }
          const vols = cs.map(c => c.volume)
          const v5 = vols.slice(-5).reduce((s, x) => s + x, 0) / 5
          const v20 = vols.slice(-20).reduce((s, x) => s + x, 0) / 20
          if (v20 === 0 || v5 / v20 < 1.0) {
            diagnosis.push(`Volume too low: 5d/20d=${v20 > 0 ? (v5 / v20).toFixed(2) : '0'}× (need ≥1.3 for fno-futures pass)`)
            diagnosisCounts['vol_too_low'] = (diagnosisCounts['vol_too_low'] ?? 0) + 1
          }
        } else {
          diagnosis.push('Insufficient candle history (likely not in scanner universe)')
          diagnosisCounts['not_in_universe'] = (diagnosisCounts['not_in_universe'] ?? 0) + 1
        }
      } catch {
        diagnosis.push('Candle fetch failed — name probably not in F&O/NIFTY500 universe')
        diagnosisCounts['not_in_universe'] = (diagnosisCounts['not_in_universe'] ?? 0) + 1
      }
      if (diagnosis.length === 0) {
        diagnosis.push('Passed all filters but no engine flagged it — possible conviction floor too high')
        diagnosisCounts['conviction_floor'] = (diagnosisCounts['conviction_floor'] ?? 0) + 1
      }
    }

    rows.push({ symbol: g.symbol, gainPct: g.gainPct, caught: isCaught, caughtBy, diagnosis })
  }

  // Dedup safety
  const seen = new Set<string>()
  const deduped = rows.filter(r => {
    if (seen.has(r.symbol)) return false
    seen.add(r.symbol); return true
  })

  const catchRate = gainers.length > 0 ? caught / gainers.length : 0
  log.ok('MISS-ANALYZER', `caught ${caught}/${gainers.length} (${(catchRate * 100).toFixed(1)}%) · top miss reasons: ${Object.entries(diagnosisCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ')}`)

  return {
    generatedAt: ts,
    totalGainers: gainers.length,
    caughtCount: caught,
    missedCount: gainers.length - caught,
    catchRate: +catchRate.toFixed(3),
    rows: deduped,
    diagnoses: diagnosisCounts,
  }
}
