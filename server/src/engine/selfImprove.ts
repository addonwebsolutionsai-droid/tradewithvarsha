import fs from 'fs/promises'
import path from 'path'
import { readPerfStats, type PerfStats } from './signalLogger'
import { logIssue } from '../util/errorsLog'
import { log } from '../util/logger'

/**
 * Daily self-improvement loop.
 *
 * Reads the live CSV audit trail of signals + outcomes and decides whether
 * to tighten or relax engine parameters. Decisions persist in
 * `server/data/auto-tune.json` and are applied at runtime by the strategies
 * (currently exposed via env-style helpers; full wire-up is incremental).
 *
 * Goal: drive overall win rate toward the user's 80–90 % target, but be
 * honest about it — never silently change scoring weights to inflate a
 * number, only tighten ENTRY filters (raise confluence floor, raise ADX gate)
 * which legitimately reduces signal count and lifts hit-rate.
 */

const DATA_DIR = path.resolve(__dirname, '../../data')
const TUNE_FILE = path.join(DATA_DIR, 'auto-tune.json')

// 2026-06-24: realistic per-strategy targets after spotting auto-tune was
// ratcheting EVERY strategy's confluence to 6/6 on noisy n=10–20 samples.
// A pro trader chases asymmetric edge, not a fairy-tale 80% headline.
// Real-world targets per strategy archetype:
//   - oi-flow: 75% (option-flow asymmetry, strongest edge)
//   - options-mtf: 65% (options + multi-timeframe)
//   - swing / weekly / monthly: 60% (multi-day breakouts)
//   - intraday-reversal: 60% (mean-reversion in liquids)
//   - commodity: 55% (noisier asset class)
//   - default: 60%
function targetWinRateFor(strategy: string): number {
  if (strategy === 'oi-flow') return 75
  if (strategy === 'options-mtf' || strategy === 'options') return 65
  if (strategy === 'commodity') return 55
  return 60
}

// 2026-06-24: bumped from 10 → 30. n=10 has ±15% standard error — system
// was tightening on noise. n=30 gives ±9%, decisions become statistical.
// 28 Oct 2026: made ADAPTIVE. The strict n=30 bar meant that during
// low-emission periods (which this exact strangle-loop causes!) the
// autotuner never fired — strategies stayed stuck at whatever ceilings
// the earlier noise-tightening left them at. New rule: n=30 for TIGHTENING
// decisions (which lower emission) but n=15 for RELAXING decisions (which
// raise emission). Avoids the deadlock where "fewer signals" prevented
// the autotuner from relaxing.
const MIN_TRADES_FOR_TIGHTEN = 30
const MIN_TRADES_FOR_RELAX = 15
const MAX_CONFLUENCE_BUMP = 6             // absolute ceiling on confluence floor
const MAX_ADX_BUMP = 30

export interface AutoTune {
  lastRunAt: string
  /** Per-strategy current overrides (used by strategies via getAutoTune()) */
  overrides: Record<string, {
    minConfluence?: number
    minAdx?: number
    /** 30 Jul 2026 — paper-book candidate acceptance floor per source. */
    minScore?: number
  }>
  /** History of adjustments for the dashboard / ERRORS.md trail */
  adjustments: { ts: string; strategy: string; metric: string; from: number; to: number; reason: string }[]
  /** Last computed perf stats per strategy */
  lastPerf: PerfStats | null
}

let cached: AutoTune | null = null

async function load(): Promise<AutoTune> {
  if (cached) return cached
  try {
    const raw = await fs.readFile(TUNE_FILE, 'utf8')
    cached = JSON.parse(raw)
    return cached!
  } catch {
    cached = { lastRunAt: '', overrides: {}, adjustments: [], lastPerf: null }
    return cached
  }
}

async function save(tune: AutoTune): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(TUNE_FILE, JSON.stringify(tune, null, 2), 'utf8')
  cached = tune
}

/** Strategies look this up before deciding their thresholds. */
export async function getAutoTune(): Promise<AutoTune> { return load() }

export async function runSelfImprove(): Promise<AutoTune> {
  log.info('IMPROVE', 'Self-improvement loop starting...')
  const tune = await load()
  const perf = await readPerfStats()
  tune.lastRunAt = new Date().toISOString()
  tune.lastPerf = perf

  const decisions: string[] = []

  for (const [strategy, s] of Object.entries(perf.byStrategy)) {
    const cur = tune.overrides[strategy] ??= {}
    const winRate = s.winRatePct
    const target = targetWinRateFor(strategy)
    const under = winRate < target - 5
    const over  = winRate >= target + 5
    const needed = under ? MIN_TRADES_FOR_TIGHTEN : over ? MIN_TRADES_FOR_RELAX : MIN_TRADES_FOR_TIGHTEN
    if (s.trades < needed) {
      decisions.push(`${strategy}: only ${s.trades} closed — need ${needed}, no change`)
      continue
    }

    if (under) {
      // Underperforming → tighten
      const oldConf = cur.minConfluence ?? defaultConfluence(strategy)
      const newConf = Math.min(MAX_CONFLUENCE_BUMP, oldConf + 1)
      if (newConf !== oldConf) {
        cur.minConfluence = newConf
        const adj = {
          ts: new Date().toISOString(), strategy, metric: 'minConfluence',
          from: oldConf, to: newConf,
          reason: `Win-rate ${winRate}% < target ${target}% over ${s.trades} closed trades — raised confluence floor`,
        }
        tune.adjustments.unshift(adj)
        await logIssue({
          severity: 'MED',
          description: `Auto-tune: ${strategy} confluence ${oldConf} → ${newConf}`,
          rootCause: `Live win-rate ${winRate}% under target ${target}% over ${s.trades} trades`,
          fixApplied: 'Tightened entry filter; expect lower signal volume + higher hit rate',
          verified: false,
        })
        decisions.push(`${strategy}: tightened minConfluence ${oldConf}→${newConf} (wr ${winRate}% < ${target}%)`)
      }
    } else if (over) {
      // Outperforming → safe to relax (relax uses the lower n=15 gate)
      // Floor of 2 is the absolute sanity bound (we never go below that).
      const oldConf = cur.minConfluence ?? defaultConfluence(strategy)
      const newConf = Math.max(2, oldConf - 1)
      if (newConf < oldConf) {
        cur.minConfluence = newConf
        tune.adjustments.unshift({
          ts: new Date().toISOString(), strategy, metric: 'minConfluence',
          from: oldConf, to: newConf,
          reason: `Win-rate ${winRate}% > target+5 (${target + 5}%) over ${s.trades} trades — relaxed to surface more setups`,
        })
        decisions.push(`${strategy}: relaxed minConfluence ${oldConf}→${newConf} (wr ${winRate}% > ${target + 5}%)`)
      } else {
        decisions.push(`${strategy}: wr ${winRate}% outperforming, floor already at min, holding`)
      }
    } else {
      decisions.push(`${strategy}: wr ${winRate}% within band [${target - 5}, ${target + 5}], no change`)
    }
  }

  // ─── Paper-book per-source tune (30 Jul 2026) ─────────────────────
  // Reads the paper-trading book, groups closed trades by source, and
  // adjusts overrides[source].minScore so under-performing sources need
  // a stricter score bar next tick. Closes the feedback loop that used
  // to just log proposals and never enforce them.
  try {
    const { loadBook } = await import('./paperTradingBook')
    const book = (loadBook as any)?.() as { trades?: any[] } | undefined
    if (book?.trades?.length) {
      const closed = book.trades.filter(t => t.status === 'SL_HIT' || t.status === 'T3_HIT' || t.status === 'T2_HIT' || t.status === 'T1_HIT' || t.status === 'TIME_STOP')
      const bySource: Record<string, { wins: number; losses: number; scores: number[] }> = {}
      for (const t of closed) {
        const src = String(t.source ?? 'UNKNOWN').toUpperCase()
        const win = (t.totalRealisedPnl ?? 0) > 0
        const stats = bySource[src] ??= { wins: 0, losses: 0, scores: [] }
        if (win) stats.wins++; else stats.losses++
        if (typeof t.score === 'number') stats.scores.push(t.score)
      }
      for (const [src, s] of Object.entries(bySource)) {
        const total = s.wins + s.losses
        if (total < 8) continue    // n<8 too noisy
        const wr = (s.wins / total) * 100
        const currentMinScore = tune.overrides[src]?.minScore ?? 60
        // 10 Sep 2026 — 24-hour cooldown per source. This engine used to
        // ping-pong PRO-EDGE 82↔87↔90 on same-day runs; dailyCoreImprovise
        // already respects a 6h cooldown but this one had none and would
        // keep raising the gate every EOD tick.
        const lastTune = (tune.adjustments ?? []).find(a => a.strategy === src && a.metric === 'minScore')
        const hoursSince = lastTune ? (Date.now() - Date.parse(lastTune.ts)) / 3600_000 : Infinity
        if (hoursSince < 24) {
          log.info('IMPROVE', `[paper] ${src}: cooldown (${hoursSince.toFixed(1)}h < 24h) — hold`)
          continue
        }
        // Under-performing: raise minScore bar; over-performing: lower it.
        // 10 Sep 2026 — tightened threshold from wr<40 to wr<30 to match
        // dailyCoreImprovise (was double-tightening at 40%). Ceiling
        // capped at 85 (was 90) — a source at 90 emits ~zero, that's
        // "kill" not "tighten". Verified after PRO-EDGE strangled the
        // whole funnel for 5 weeks.
        if (wr < 30 && currentMinScore < 85) {
          const newMin = Math.min(85, currentMinScore + 5)
          tune.overrides[src] = { ...(tune.overrides[src] ?? {}), minScore: newMin }
          tune.adjustments.unshift({
            ts: new Date().toISOString(), strategy: src, metric: 'minScore',
            from: currentMinScore, to: newMin,
            reason: `PAPER-BOOK wr ${wr.toFixed(0)}% over ${total} closed — raised score bar (cap 85)`,
          })
          log.ok('IMPROVE', `[paper] ${src}: wr ${wr.toFixed(0)}% (${s.wins}/${total}) → minScore ${currentMinScore}→${newMin}`)
        } else if (wr > 75 && currentMinScore > 60) {
          const newMin = Math.max(60, currentMinScore - 3)
          tune.overrides[src] = { ...(tune.overrides[src] ?? {}), minScore: newMin }
          tune.adjustments.unshift({
            ts: new Date().toISOString(), strategy: src, metric: 'minScore',
            from: currentMinScore, to: newMin,
            reason: `PAPER-BOOK wr ${wr.toFixed(0)}% over ${total} closed — safe to relax`,
          })
          log.ok('IMPROVE', `[paper] ${src}: wr ${wr.toFixed(0)}% (${s.wins}/${total}) → minScore ${currentMinScore}→${newMin} (relaxed)`)
        } else {
          log.info('IMPROVE', `[paper] ${src}: wr ${wr.toFixed(0)}% (${s.wins}/${total}) — no change`)
        }
      }
    }
  } catch (e) {
    log.warn('IMPROVE', `paper-book tune skipped: ${(e as Error).message}`)
  }

  // Keep only last 50 adjustments
  tune.adjustments = tune.adjustments.slice(0, 50)
  await save(tune)
  log.ok('IMPROVE', `Self-improve done — ${decisions.length} strategy reviews: ${decisions.join(' | ')}`)
  return tune
}

function defaultConfluence(strategy: string): number {
  // Mirrors the floors hard-coded in the strategy modules so tune adjustments
  // stay symmetric around them.
  switch (strategy) {
    case 'intraday': return 4
    case 'swing': return 5
    case 'options': return 5
    case 'commodity': return 4
    default: return 4
  }
}
