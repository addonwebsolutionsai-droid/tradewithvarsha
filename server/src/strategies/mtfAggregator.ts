import type { Candle } from '../types'

/**
 * Multi-timeframe candle aggregator.
 *
 * We fetch 5-min candles from the data layer once, then resample them up to
 * any target timeframe in memory. Cheaper than N separate API calls, and
 * supports arbitrary multiples: 10m, 15m, 30m, 45m, 1h (60m), 2h (120m),
 * 3h (180m), 4h (240m). Also supports passthrough for 1m / 3m / 5m when the
 * base fetch is at that TF.
 */

export type TfMinutes = 1 | 3 | 5 | 10 | 15 | 30 | 45 | 60 | 120 | 180 | 240

export interface Tf {
  name: string           // "5m", "15m", "1h" etc — matches what we display
  minutes: TfMinutes
}

export const ALL_TFS: Tf[] = [
  { name: '5m',  minutes: 5 },
  { name: '15m', minutes: 15 },
  { name: '30m', minutes: 30 },
  { name: '1h',  minutes: 60 },
  { name: '2h',  minutes: 120 },
  { name: '3h',  minutes: 180 },
  { name: '4h',  minutes: 240 },
]

/**
 * Aggregate a series of base candles up to a multi-minute timeframe.
 * `groupSize` = targetMinutes / baseMinutes, must be ≥ 1.
 * E.g. 5m candles resampled to 15m → groupSize 3.
 */
export function resample(base: Candle[], baseMinutes: number, targetMinutes: number): Candle[] {
  if (targetMinutes === baseMinutes) return base
  if (targetMinutes < baseMinutes) return base   // can't resample down

  const groupSize = Math.round(targetMinutes / baseMinutes)
  if (groupSize <= 1) return base

  const out: Candle[] = []
  for (let i = 0; i < base.length; i += groupSize) {
    const chunk = base.slice(i, i + groupSize)
    if (chunk.length < groupSize) break     // drop trailing partial bar
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low:  Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    })
  }
  return out
}
