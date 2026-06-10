/**
 * Gainer Postmortem — for every 5%+ gainer the market saw today, walk back
 * day by day and check whether OUR scanner's pre-breakout rules would have
 * flagged the stock BEFORE the move. Reports:
 *   - The day-N entry our rules would have fired (or "NEVER")
 *   - Which feature drove the rule pass (tightness / dry-up / EMA stack)
 *   - WHY we missed if we did (universe / filter rejected / conv too low)
 *
 * Also identifies the PATTERN of the gainer (Wyckoff accumulation, VCP,
 * cup-and-handle, breakout-from-base) so we know which signal-generation
 * style would have caught it.
 *
 * Output: gainer-postmortem.json — the auto-tune feedback loop. Used by
 * miss-miner cron to suggest filter tweaks.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import * as data from '../data'
import { log } from '../util/logger'
import { fetchExternalGainers } from '../data/externalGainers'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

interface FeatureSnapshot {
  ret5d: number
  ret20d: number
  bbWidthPct: number
  volRatio5_20: number
  rsi14: number
  distFromHigh20: number
  emaStackBull: boolean
}

interface PostmortemRow {
  symbol: string
  gainPct: number
  sources: string[]
  caughtTodayByOurTabs: boolean
  // Backward simulation
  wouldHaveFiredDaysAgo: number | null    // 0 = today, 7 = 7 days ago, null = never
  patternDetected: string                  // "wyckoff" | "vcp" | "breakout" | "momentum-chase" | "unknown"
  preMoveFeatures: FeatureSnapshot | null  // features at day of "would have fired"
  missReason: string                       // why we missed (if missed)
  recommendation: string                   // what to tweak to catch this in future
}

function ema(values: number[], period: number): number {
  const k = 2 / (period + 1)
  let v = values[0]
  for (let i = 1; i < values.length; i++) v = values[i] * k + v * (1 - k)
  return v
}

function rsi14(values: number[]): number {
  if (values.length < 15) return 50
  let g = 0, l = 0
  for (let i = values.length - 14; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) g += d; else l -= d
  }
  if (l === 0) return 100
  return 100 - 100 / (1 + g / l)
}

function computeFeatures(slice: Candle[]): FeatureSnapshot | null {
  if (slice.length < 25) return null
  const closes = slice.map(c => c.close)
  const vols = slice.map(c => c.volume)
  const price = closes[closes.length - 1]
  const ret5d = ((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
  const ret20d = ((price - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
  const high20 = Math.max(...closes.slice(-20))
  const low20 = Math.min(...closes.slice(-20))
  const v5 = vols.slice(-5).reduce((s, x) => s + x, 0) / 5
  const v20 = vols.slice(-20).reduce((s, x) => s + x, 0) / 20
  const e9 = ema(closes, 9), e21 = ema(closes, 21)
  const e50 = closes.length >= 50 ? ema(closes, 50) : e21
  return {
    ret5d: +ret5d.toFixed(2),
    ret20d: +ret20d.toFixed(2),
    bbWidthPct: +((high20 - low20) / price * 100).toFixed(2),
    volRatio5_20: +(v20 > 0 ? v5 / v20 : 1).toFixed(2),
    rsi14: +rsi14(closes).toFixed(1),
    distFromHigh20: +((high20 - price) / high20 * 100).toFixed(2),
    emaStackBull: e9 > e21 && e21 > e50 && price > e21,
  }
}

// Pre-breakout rule (mirrors weeklyManagerPick lane A): tight coil + vol
// dry-up + at-20d-high + EMA stack + RSI productive + NOT extended.
function passesPreBreakout(f: FeatureSnapshot): boolean {
  if (Math.abs(f.ret5d) > 6) return false       // hard freshness reject
  if (Math.abs(f.ret20d) > 25) return false
  if (!f.emaStackBull) return false
  if (f.bbWidthPct > 12) return false
  if (f.volRatio5_20 > 1.0) return false        // dry-up rule
  if (f.rsi14 < 40 || f.rsi14 > 70) return false
  if (f.distFromHigh20 > 7) return false        // must be near 20d high
  return true
}

function detectPattern(history: Candle[]): string {
  if (history.length < 25) return 'unknown'
  const closes = history.map(c => c.close)
  const last = closes[closes.length - 1]
  const high60 = Math.max(...closes.slice(-60))
  const low60 = Math.min(...closes.slice(-60))
  const range60 = (high60 - low60) / low60 * 100
  const ret60d = closes.length >= 61 ? ((last - closes[closes.length - 61]) / closes[closes.length - 61]) * 100 : 0
  // Wyckoff: long base near lows then breakout
  if (range60 < 25 && ret60d < 10) return 'wyckoff-accumulation'
  // VCP: contracting volatility
  const range20 = (Math.max(...closes.slice(-20)) - Math.min(...closes.slice(-20))) / last * 100
  const range10 = (Math.max(...closes.slice(-10)) - Math.min(...closes.slice(-10))) / last * 100
  if (range10 < range20 * 0.6 && range20 < 15) return 'vcp'
  // Momentum chase
  if (ret60d > 40) return 'momentum-chase'
  // Breakout from base
  if (ret60d > 10 && ret60d < 30 && range60 < 40) return 'breakout-from-base'
  return 'unknown'
}

async function readJson(name: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(path.join(SNAP_DIR, name), 'utf8')) } catch { return null }
}

export async function runGainerPostmortem(): Promise<{
  generatedAt: string
  totalGainers: number
  caughtCount: number
  wouldHaveCaughtCount: number              // with backward-look filter check
  patternBreakdown: Record<string, number>
  topMissReasons: Record<string, number>
  rows: PostmortemRow[]
}> {
  const ts = new Date().toISOString()
  const ext = await fetchExternalGainers()
  const gainers = ext.merged.filter(g => g.gainPct >= 5).slice(0, 60)
  log.info('GAINER-PM', `${gainers.length} gainers across all sources to postmortem`)

  // Cross-ref against current snapshots to mark "caught today"
  const snaps = await Promise.all([
    readJson('weekly-pick.json'), readJson('fno-futures.json'),
    readJson('cross-confluence.json'), readJson('ad-divergence.json'),
    readJson('pre-move.json'),
  ])
  const norm = (s: string) => s.toUpperCase().replace(/[-_\s]/g, '')
  const allCaughtSyms = new Set<string>()
  for (const snap of snaps) {
    for (const r of (snap?.rows ?? [])) allCaughtSyms.add(norm(r.symbol ?? ''))
  }

  const rows: PostmortemRow[] = []
  const patternBreakdown: Record<string, number> = {}
  const missReasons: Record<string, number> = {}
  let wouldHaveCount = 0, caughtCount = 0

  for (const g of gainers) {
    try {
      const cs = await data.getCandles(g.symbol, '1D' as any, 60) as Candle[]
      if (!cs || cs.length < 25) {
        rows.push({
          symbol: g.symbol, gainPct: g.gainPct, sources: g.sources,
          caughtTodayByOurTabs: false, wouldHaveFiredDaysAgo: null,
          patternDetected: 'no-data', preMoveFeatures: null,
          missReason: 'Not in scanner universe (no candle history available)',
          recommendation: 'Add to MARKET_ALL scan list; verify Angel ScripMaster has token',
        })
        missReasons['not_in_universe'] = (missReasons['not_in_universe'] ?? 0) + 1
        continue
      }
      const isCaught = allCaughtSyms.has(norm(g.symbol))
      if (isCaught) caughtCount++

      // Backward simulation — walk back N days, recompute features, check if rule fires
      let wouldFireAtDay: number | null = null
      let featuresAt: FeatureSnapshot | null = null
      for (let daysBack = 1; daysBack <= 10; daysBack++) {
        const idx = cs.length - daysBack
        if (idx < 25) break
        const slice = cs.slice(0, idx + 1)
        const f = computeFeatures(slice)
        if (f && passesPreBreakout(f)) {
          wouldFireAtDay = daysBack
          featuresAt = f
          break
        }
      }
      if (wouldFireAtDay != null && !isCaught) wouldHaveCount++

      const pattern = detectPattern(cs)
      patternBreakdown[pattern] = (patternBreakdown[pattern] ?? 0) + 1

      let missReason = ''
      let recommendation = ''
      if (isCaught) {
        missReason = '— (caught)'
        recommendation = 'No action needed'
      } else if (wouldFireAtDay != null) {
        missReason = `Rule WOULD have fired ${wouldFireAtDay}d ago but signal was not emitted — likely scanner ran on smaller universe (e.g. CNX500 intraday vs MARKET_ALL post-close)`
        recommendation = 'Expand intraday CNX500 cron to NIFTY_500 or add this symbol to MARKET_ALL universe'
        missReasons['rule_fired_but_not_emitted'] = (missReasons['rule_fired_but_not_emitted'] ?? 0) + 1
      } else {
        // Diagnose why rule didn't fire
        const todayFeat = computeFeatures(cs)
        if (todayFeat) {
          if (todayFeat.bbWidthPct > 15) {
            missReason = `Too wide a range (BB-w ${todayFeat.bbWidthPct}%) — not a coil setup. Pattern was momentum-driven, not pre-breakout.`
            recommendation = 'Add momentum-style scanner: ret5d > 10% + vol > 2× + RSI > 60 firing'
            missReasons['not_coil_pattern'] = (missReasons['not_coil_pattern'] ?? 0) + 1
          } else if (todayFeat.volRatio5_20 > 1.5) {
            missReason = `Volume was already elevated (${todayFeat.volRatio5_20}× 20d) before the move — fails our dry-up filter`
            recommendation = 'Loosen dry-up filter from <1.0 to <1.3, or add vol-surge path alongside dry-up path'
            missReasons['vol_already_elevated'] = (missReasons['vol_already_elevated'] ?? 0) + 1
          } else if (Math.abs(todayFeat.ret5d) > 6 || Math.abs(todayFeat.ret20d) > 25) {
            missReason = `Stock was already extended (5d ${todayFeat.ret5d}%, 20d ${todayFeat.ret20d}%) — hit our freshness reject`
            recommendation = 'For wave-2 continuation candidates, extend wave2 scanner to micro/small caps'
            missReasons['extended_freshness_reject'] = (missReasons['extended_freshness_reject'] ?? 0) + 1
          } else if (!todayFeat.emaStackBull) {
            missReason = 'EMA stack not bullish (9 < 21 or below 50) — moved despite weak trend structure'
            recommendation = 'Add news/insider scanner OR loosen EMA stack requirement for small caps'
            missReasons['ema_not_stacked'] = (missReasons['ema_not_stacked'] ?? 0) + 1
          } else {
            missReason = 'All features look fine — possible miss-miner sample bias or scanner universe gap'
            recommendation = 'Add to next universe expansion; verify scanner ran for this name'
            missReasons['scanner_gap'] = (missReasons['scanner_gap'] ?? 0) + 1
          }
        } else {
          missReason = 'Could not compute features'
          recommendation = 'Investigate data layer for this symbol'
          missReasons['feature_compute_failed'] = (missReasons['feature_compute_failed'] ?? 0) + 1
        }
      }

      rows.push({
        symbol: g.symbol, gainPct: g.gainPct, sources: g.sources,
        caughtTodayByOurTabs: isCaught,
        wouldHaveFiredDaysAgo: wouldFireAtDay,
        patternDetected: pattern,
        preMoveFeatures: featuresAt,
        missReason, recommendation,
      })
    } catch (e) {
      log.warn('GAINER-PM', `${g.symbol}: ${(e as Error).message}`)
    }
  }

  // Dedup by symbol
  const seen = new Set<string>()
  const deduped = rows.filter(r => {
    if (seen.has(r.symbol)) return false
    seen.add(r.symbol); return true
  })

  log.ok('GAINER-PM', `${deduped.length} gainers analysed · caught ${caughtCount} · would-have-caught ${wouldHaveCount} more · top pattern: ${Object.entries(patternBreakdown).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'n/a'}`)

  return {
    generatedAt: ts,
    totalGainers: deduped.length,
    caughtCount,
    wouldHaveCaughtCount: wouldHaveCount,
    patternBreakdown,
    topMissReasons: missReasons,
    rows: deduped,
  }
}
