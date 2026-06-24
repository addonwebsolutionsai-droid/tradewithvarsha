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
const MIN_TRADES_FOR_DECISION = 30
const MAX_CONFLUENCE_BUMP = 6             // absolute ceiling on confluence floor
const MAX_ADX_BUMP = 30

export interface AutoTune {
  lastRunAt: string
  /** Per-strategy current overrides (used by strategies via getAutoTune()) */
  overrides: Record<string, { minConfluence?: number; minAdx?: number }>
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
    if (s.trades < MIN_TRADES_FOR_DECISION) {
      decisions.push(`${strategy}: only ${s.trades} closed — need ${MIN_TRADES_FOR_DECISION}, no change`)
      continue
    }
    const cur = tune.overrides[strategy] ??= {}
    const winRate = s.winRatePct
    const target = targetWinRateFor(strategy)

    if (winRate < target - 5) {
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
    } else if (winRate >= target + 5) {
      // Outperforming → safe to relax (we already passed the n≥30 sample gate)
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
        decisions.push(`${strategy}: wr ${winRate}% outperforming, already at default ${def}, holding`)
      }
    } else {
      decisions.push(`${strategy}: wr ${winRate}% within band [${target - 5}, ${target + 5}], no change`)
    }
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
