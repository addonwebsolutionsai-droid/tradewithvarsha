/**
 * Multi-TF runner for the Fib + LRC confluence detector. Mirrors the shape
 * of turtleSoupEngine so the dashboard / Telegram formatter / dedup ledger
 * can re-use the same wiring.
 *
 * Symbols: NIFTY (NSE) + XAUUSD (TwelveData spot). Timeframes mirror the
 * Turtle Soup matrix exactly so comparisons are apples-to-apples.
 */

import * as data from '../data'
import { resample } from '../strategies/mtfAggregator'
import { detectFibLrc, type FibLrcSignal } from '../strategies/fibLrc'
import { logSignal } from './signalLogger'
import { log } from '../util/logger'
import type { Signal, Timeframe } from '../types'

export const FIB_LRC_SYMBOLS = ['NIFTY', 'XAUUSD'] as const
export type FibLrcSymbol = (typeof FIB_LRC_SYMBOLS)[number]

export interface TfConfig {
  label: string
  baseTf: Timeframe
  resampleToMin?: number
  candleCount: number
}

export const FIB_LRC_TFS: TfConfig[] = [
  { label: '5m',  baseTf: '5m',  candleCount: 250 },
  { label: '15m', baseTf: '15m', candleCount: 250 },
  { label: '30m', baseTf: '30m', candleCount: 250 },
  { label: '45m', baseTf: '15m', resampleToMin: 45, candleCount: 400 },
  { label: '1h',  baseTf: '1h',  candleCount: 250 },
  { label: '2h',  baseTf: '1h',  resampleToMin: 120, candleCount: 400 },
  { label: '3h',  baseTf: '1h',  resampleToMin: 180, candleCount: 400 },
  { label: '4h',  baseTf: '4h',  candleCount: 250 },
  { label: '1d',  baseTf: '1D',  candleCount: 300 },
]

export interface FibLrcRow extends FibLrcSignal {
  sigKey: string
}

export interface FibLrcRun {
  generatedAt: string
  scanned: number
  qualified: number
  signals: FibLrcRow[]
  summary: string
}

let lastRun: FibLrcRun | null = null
const sentDedupKeys = new Set<string>()

export function getLatestFibLrcRun(): FibLrcRun | null { return lastRun }
export function clearFibLrcDedup(): void { sentDedupKeys.clear() }

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

function tfRank(label: string): number {
  const order = ['5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '1d']
  const i = order.indexOf(label.toLowerCase())
  return i >= 0 ? i : 0
}

export async function runFibLrcScan(): Promise<FibLrcRun> {
  log.info('FIB-LRC', 'Multi-TF scan starting...')
  const out: FibLrcRow[] = []
  let scanned = 0

  for (const sym of FIB_LRC_SYMBOLS) {
    for (const tf of FIB_LRC_TFS) {
      scanned++
      try {
        const baseCandles = await data.getCandles(sym, tf.baseTf, tf.candleCount)
        if (!baseCandles.length) continue
        let candles = baseCandles
        if (tf.resampleToMin) {
          const baseMin = tfMinutes(tf.baseTf)
          candles = resample(baseCandles, baseMin, tf.resampleToMin as 45 | 120 | 180)
        }
        if (candles.length < 60) continue
        const sig = detectFibLrc(sym, tf.label, candles)
        if (!sig) continue
        const sigKey = `${sym}|${tf.label}|${sig.direction}|${sig.detectedAt}|${sig.fibLevel}`
        out.push({ ...sig, sigKey })
      } catch (e) {
        log.warn('FIB-LRC', `${sym} ${tf.label}: ${(e as Error).message}`)
      }
    }
  }

  // Smallest TF first — same fast-entry priority as Turtle Soup.
  out.sort((a, b) => tfRank(a.timeframe) - tfRank(b.timeframe) || b.riskReward - a.riskReward)

  for (const s of out) {
    void logSignal(fibLrcToSignal(s), 'fib-lrc').catch(() => undefined)
  }

  const buys = out.filter(s => s.direction === 'BUY').length
  const sells = out.filter(s => s.direction === 'SELL').length
  const summary = out.length
    ? `📐 Fib+LRC: ${out.length} signal${out.length > 1 ? 's' : ''} (${buys} BUY · ${sells} SELL) across ${FIB_LRC_SYMBOLS.length} symbols × ${FIB_LRC_TFS.length} TFs`
    : `📐 Fib+LRC: no Fib-tag + LRC-flip across ${scanned} (symbol × TF) pairs.`

  const run: FibLrcRun = {
    generatedAt: new Date().toISOString(),
    scanned, qualified: out.length, signals: out, summary,
  }
  lastRun = run
  log.ok('FIB-LRC', `${run.qualified}/${run.scanned} qualified (${buys} BUY · ${sells} SELL)`)
  return run
}

export function takeFreshFibLrcSignals(run: FibLrcRun): FibLrcRow[] {
  const fresh: FibLrcRow[] = []
  for (const s of run.signals) {
    if (sentDedupKeys.has(s.sigKey)) continue
    sentDedupKeys.add(s.sigKey)
    fresh.push(s)
  }
  return fresh
}

function fibLrcToSignal(s: FibLrcRow): Signal {
  return {
    id: `fib-lrc-${s.sigKey.replace(/[^a-zA-Z0-9]/g, '-')}`,
    instrument: `${s.symbol} ${s.timeframe} (Fib+LRC)`,
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
    pattern: 'Fib + LRC',
    expiresAt: s.detectedAt,
    timestamp: s.detectedAt,
    confluence: { pattern: true },
    confluenceCount: 2,
    source: 'fib-lrc' as any,
    tier: 'LIVE',
  }
}

export function formatFibLrcForTelegram(rows: FibLrcRow[]): string {
  if (!rows.length) return ''
  const lines: string[] = []
  lines.push(`📐 *FIB + LRC — ${rows.length} fresh signal${rows.length > 1 ? 's' : ''}*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  for (const s of rows) {
    const arrow = s.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'
    lines.push(`${arrow} *${s.symbol}* · ${s.timeframe} · LTP \`${s.ltp}\``)
    lines.push(`   Swing \`${s.swingLow}\` → \`${s.swingHigh}\``)
    lines.push(`   Fib ${(s.fibLevel * 100).toFixed(1)}% @ \`${s.fibPrice}\` · tagged \`${s.tagPrice}\` (${s.tagDistancePct.toFixed(2)}% off)`)
    lines.push(`   LRC flip ${s.direction === 'BUY' ? 'GREEN' : 'RED'}: ${s.lrcOpen} ${s.direction === 'BUY' ? '→' : '↓'} ${s.lrcClose}`)
    lines.push(`   Entry \`${s.entry}\` · SL \`${s.stopLoss}\``)
    lines.push(`   T1 \`${s.target1}\` · T2 \`${s.target2}\` · T3 \`${s.target3}\``)
    lines.push(`   R:R 1:${s.riskReward} · conf ${s.confidence}%`)
    lines.push('')
  }
  lines.push(`_Fib retracement + Linear Regression Candles flip. Fast-entry indicator._`)
  lines.push(`*#tradewithvarsha*`)
  return lines.join('\n')
}
