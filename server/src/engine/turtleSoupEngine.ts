import * as data from '../data'
import { resample } from '../strategies/mtfAggregator'
import { detectTurtleSoup, type TurtleSoupSignal } from '../strategies/ictTurtleSoup'
import { logSignal } from './signalLogger'
import { log } from '../util/logger'
import type { Candle, Signal, Timeframe } from '../types'

/**
 * Multi-timeframe runner for the pure ICT Turtle Soup detector.
 *
 * Scans NIFTY (NSE index) and GOLD (XAUUSD) on the 11 timeframes the user
 * specified — including 45m, 2h, 3h which are not natively fetched and are
 * therefore resampled from finer base candles via mtfAggregator.resample.
 *
 * Each (symbol × timeframe) pair runs the detector exactly once per scan
 * and emits at most one signal. Fresh signals (not seen in any previous
 * run today) get pushed to Telegram via the dispatcher in index.ts.
 *
 * The detector is intentionally pure — see strategies/ictTurtleSoup.ts. No
 * other indicator/engine state contaminates this scan.
 */

// 2026-05-02: XAUUSD added explicitly. GOLD resolves to NSE GOLDBEES ETF;
// XAUUSD is the same data path but kept as a separate ticker so the UI shows
// both labels and the user can grep their TradingView XAUUSD trades against
// our signal feed.
export const TURTLE_SOUP_SYMBOLS = ['NIFTY', 'GOLD', 'XAUUSD'] as const
export type TurtleSoupSymbol = (typeof TURTLE_SOUP_SYMBOLS)[number]

export interface TfConfig {
  /** User-facing label (this is what the Telegram + UI show). */
  label: string
  /** Native data-router timeframe to fetch. */
  baseTf: Timeframe
  /** If set, resample baseTf bars (in minutes) into this minute-size. */
  resampleToMin?: number
  /** How many base candles to fetch (sized so resampling still leaves >= 80 bars). */
  candleCount: number
}

export const TURTLE_SOUP_TFS: TfConfig[] = [
  { label: '5m',  baseTf: '5m',  candleCount: 250 },
  { label: '15m', baseTf: '15m', candleCount: 250 },
  { label: '30m', baseTf: '30m', candleCount: 250 },
  { label: '45m', baseTf: '15m', resampleToMin: 45, candleCount: 400 },   // ~133 × 45m bars
  { label: '1h',  baseTf: '1h',  candleCount: 250 },
  { label: '2h',  baseTf: '1h',  resampleToMin: 120, candleCount: 400 },  // ~200 × 2h bars
  { label: '3h',  baseTf: '1h',  resampleToMin: 180, candleCount: 400 },  // ~133 × 3h bars
  { label: '4h',  baseTf: '4h',  candleCount: 250 },
  { label: '1d',  baseTf: '1D',  candleCount: 300 },
  { label: '1w',  baseTf: '1W',  candleCount: 200 },
  { label: '1mo', baseTf: '1M',  candleCount: 120 },
]

export interface TurtleSoupRow extends TurtleSoupSignal {
  /** Stable dedup key — same setup won't push twice. */
  sigKey: string
}

export interface TurtleSoupRun {
  generatedAt: string
  scanned: number              // total (symbol × tf) pairs attempted
  qualified: number            // total signals returned
  signals: TurtleSoupRow[]
  /** One-line summary for digest / Telegram top. */
  summary: string
}

let lastRun: TurtleSoupRun | null = null

// Dedup ledger — per sigKey timestamp. Cleared at midnight IST by index.ts cron.
const sentDedupKeys = new Set<string>()

export function getLatestTurtleSoupRun(): TurtleSoupRun | null { return lastRun }

export function clearTurtleSoupDedup(): void { sentDedupKeys.clear() }

function tfMinutes(tf: Timeframe): number {
  switch (tf) {
    case '1m': return 1
    case '3m': return 3
    case '5m': return 5
    case '15m': return 15
    case '30m': return 30
    case '1h': return 60
    case '4h': return 240
    case '1D': return 1440
    case '1W': return 10080
    case '1M': return 43200
  }
}

export async function runTurtleSoupScan(): Promise<TurtleSoupRun> {
  log.info('TURTLE-SOUP', 'Multi-TF scan starting...')
  const now = new Date()
  const out: TurtleSoupRow[] = []
  let scanned = 0

  for (const sym of TURTLE_SOUP_SYMBOLS) {
    for (const tf of TURTLE_SOUP_TFS) {
      scanned++
      try {
        const baseCandles = await data.getCandles(sym, tf.baseTf, tf.candleCount).catch(() => [] as Candle[])
        if (!baseCandles.length) continue
        let candles = baseCandles
        if (tf.resampleToMin) {
          const baseMin = tfMinutes(tf.baseTf)
          candles = resample(baseCandles, baseMin, tf.resampleToMin as 45 | 120 | 180)
        }
        if (candles.length < 30) continue
        const sig = detectTurtleSoup(sym, tf.label, candles)
        if (!sig) continue
        const sigKey = `${sym}|${tf.label}|${sig.direction}|${sig.sweepBarTime}`
        out.push({ ...sig, sigKey })
      } catch (e) {
        log.warn('TURTLE-SOUP', `${sym} ${tf.label}: ${(e as Error).message}`)
      }
    }
  }

  // Sort: smallest timeframe first (fastest-entry priority — 2026-05-02). When
  // a 5m sweep+reclaim is fresh it MUST surface above the same instrument's
  // 1h/1d card, otherwise the user enters 100+ pts late. Tie-break on RR.
  out.sort((a, b) => tfRank(a.timeframe) - tfRank(b.timeframe) || b.riskReward - a.riskReward)

  // Persist each to signals.csv for the audit journal
  for (const s of out) {
    void logSignal(turtleSoupToSignal(s), 'turtle-soup').catch(() => undefined)
  }

  const buys = out.filter(s => s.direction === 'BUY').length
  const sells = out.filter(s => s.direction === 'SELL').length
  const summary = out.length
    ? `🐢 Turtle Soup: ${out.length} signal${out.length > 1 ? 's' : ''} (${buys} BUY · ${sells} SELL) across ${TURTLE_SOUP_SYMBOLS.length} symbols × ${TURTLE_SOUP_TFS.length} TFs`
    : `🐢 Turtle Soup: no qualifying sweep + reclaim across ${scanned} (symbol × TF) pairs scanned.`

  const run: TurtleSoupRun = {
    generatedAt: now.toISOString(),
    scanned,
    qualified: out.length,
    signals: out,
    summary,
  }
  lastRun = run
  log.ok('TURTLE-SOUP', `${run.qualified}/${run.scanned} qualified (${buys} BUY · ${sells} SELL)`)
  return run
}

function tfRank(label: string): number {
  const order = ['5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '1d', '1w', '1mo']
  const i = order.indexOf(label.toLowerCase())
  return i >= 0 ? i : 0
}

/**
 * Filter out signals already pushed to Telegram in any prior run today and
 * record the keys so they don't fire again. Caller (index.ts) invokes this
 * right before formatting the Telegram message.
 */
export function takeFreshTurtleSoupSignals(run: TurtleSoupRun): TurtleSoupRow[] {
  const fresh: TurtleSoupRow[] = []
  for (const s of run.signals) {
    if (sentDedupKeys.has(s.sigKey)) continue
    sentDedupKeys.add(s.sigKey)
    fresh.push(s)
  }
  return fresh
}

// ─── Adapters ─────────────────────────────────────────────────

function turtleSoupToSignal(s: TurtleSoupRow): Signal {
  // Type semantics: Turtle Soup is its own pattern. Map to SWING for the
  // signals.csv schema since INTRADAY scalps + multi-day positionals both
  // share the same trade-management rules in this strategy.
  return {
    id: `turtle-soup-${s.sigKey.replace(/[^a-zA-Z0-9]/g, '-')}`,
    instrument: `${s.symbol} ${s.timeframe} (Turtle Soup)`,
    direction: s.direction,
    grade: s.confidence >= 80 ? 'A' : s.confidence >= 65 ? 'B' : s.confidence >= 50 ? 'C' : 'D',
    score: +(s.confidence / 10).toFixed(1),
    entry: s.entry,
    stopLoss: s.stopLoss,
    target1: s.target1,
    target2: s.target2,
    target3: s.target3,
    riskPct: 0,
    rewardPct: 0,
    riskReward: s.riskReward,
    type: 'SWING',
    reasons: s.reasons,
    gannNote: 'N/A',
    astroNote: 'N/A',
    oiNote: 'N/A',
    pattern: 'ICT Turtle Soup',
    expiresAt: s.detectedAt,
    timestamp: s.detectedAt,
    confluence: { pattern: true },
    confluenceCount: 1,
    source: 'turtle-soup',
    tier: 'LIVE',
  }
}

// ─── Telegram formatter ───────────────────────────────────────

export function formatTurtleSoupForTelegram(rows: TurtleSoupRow[]): string {
  if (!rows.length) return ''
  const lines: string[] = []
  lines.push(`🐢 *ICT TURTLE SOUP — ${rows.length} fresh signal${rows.length > 1 ? 's' : ''}*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  for (const s of rows) {
    const arrow = s.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'
    lines.push(`${arrow} *${s.symbol}* · ${s.timeframe} · LTP \`${s.ltp}\``)
    lines.push(`   Range \`${s.rangeLow}\` – \`${s.rangeHigh}\` · HTF: ${s.htfOrderFlow}`)
    lines.push(`   Sweep ${s.direction === 'BUY' ? 'below' : 'above'} \`${s.sweptLevel}\` → wick \`${s.sweepWickPrice}\` · reclaimed close \`${s.sweepCloseBack}\``)
    lines.push(`   Entry \`${s.entry}\` · SL \`${s.stopLoss}\``)
    lines.push(`   T1 \`${s.target1}\` (mid) · T2 \`${s.target2}\` (opposite) · T3 \`${s.target3}\` (extension)`)
    lines.push(`   R:R 1:${s.riskReward} · conf ${s.confidence}%`)
    lines.push('')
  }
  lines.push(`_Pure ICT Turtle Soup. No other indicators used._`)
  lines.push(`*#tradewithvarsha*`)
  return lines.join('\n')
}
