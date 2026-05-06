import type { Candle } from '../types'
import { findSwings } from './smc'

/** Higher-order chart patterns based on swing points. */

export interface ChartPattern {
  name: string
  direction: 'BULL' | 'BEAR'
  confidence: number // 0-1
  note: string
}

export function detectPatterns(candles: Candle[]): ChartPattern[] {
  const out: ChartPattern[] = []
  if (candles.length < 30) return out

  const swings = findSwings(candles, 3, 3)
  const highs = swings.filter(s => s.kind === 'HIGH')
  const lows = swings.filter(s => s.kind === 'LOW')

  // ── Double bottom / double top ──────────────────────────────
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2)
    const diff = Math.abs(a.price - b.price) / ((a.price + b.price) / 2)
    if (diff < 0.015 && b.idx - a.idx > 5) {
      out.push({
        name: 'Double Bottom',
        direction: 'BULL',
        confidence: 0.7,
        note: `Twin lows at ${a.price.toFixed(2)} ≈ ${b.price.toFixed(2)}`,
      })
    }
  }
  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2)
    const diff = Math.abs(a.price - b.price) / ((a.price + b.price) / 2)
    if (diff < 0.015 && b.idx - a.idx > 5) {
      out.push({
        name: 'Double Top',
        direction: 'BEAR',
        confidence: 0.7,
        note: `Twin highs at ${a.price.toFixed(2)} ≈ ${b.price.toFixed(2)}`,
      })
    }
  }

  // ── Higher-high trending (uptrend channel / bull flag) ──────
  if (highs.length >= 3 && lows.length >= 3) {
    const h = highs.slice(-3)
    const l = lows.slice(-3)
    const hhTrend = h[0].price < h[1].price && h[1].price < h[2].price
    const hlTrend = l[0].price < l[1].price && l[1].price < l[2].price
    if (hhTrend && hlTrend) {
      out.push({
        name: 'Uptrend (HH+HL)',
        direction: 'BULL',
        confidence: 0.65,
        note: 'Consecutive higher highs and higher lows — bull flag / channel',
      })
    }
    const llTrend = l[0].price > l[1].price && l[1].price > l[2].price
    const lhTrend = h[0].price > h[1].price && h[1].price > h[2].price
    if (llTrend && lhTrend) {
      out.push({
        name: 'Downtrend (LL+LH)',
        direction: 'BEAR',
        confidence: 0.65,
        note: 'Consecutive lower lows and lower highs — bear flag / channel',
      })
    }
  }

  // ── Ascending triangle: flat highs + rising lows ────────────
  if (highs.length >= 3 && lows.length >= 3) {
    const h = highs.slice(-3).map(x => x.price)
    const l = lows.slice(-3).map(x => x.price)
    const flatHigh = Math.max(...h) - Math.min(...h) < (Math.max(...h) * 0.01)
    const risingLow = l[0] < l[1] && l[1] < l[2]
    if (flatHigh && risingLow) {
      out.push({
        name: 'Ascending Triangle',
        direction: 'BULL',
        confidence: 0.7,
        note: 'Flat resistance, rising support — bullish breakout setup',
      })
    }
    const flatLow = Math.max(...l) - Math.min(...l) < (Math.min(...l) * 0.01)
    const fallingHigh = h[0] > h[1] && h[1] > h[2]
    if (flatLow && fallingHigh) {
      out.push({
        name: 'Descending Triangle',
        direction: 'BEAR',
        confidence: 0.7,
        note: 'Flat support, falling resistance — bearish breakdown setup',
      })
    }
  }

  // ── Breakout from N-period range (simplified Donchian break) ──
  const last = candles[candles.length - 1]
  const lookback = candles.slice(-21, -1)
  if (lookback.length >= 10) {
    const rangeHigh = Math.max(...lookback.map(c => c.high))
    const rangeLow = Math.min(...lookback.map(c => c.low))
    if (last.close > rangeHigh) {
      out.push({
        name: '20-bar Range Breakout',
        direction: 'BULL',
        confidence: 0.6,
        note: `Close ${last.close.toFixed(2)} above 20-bar range high ${rangeHigh.toFixed(2)}`,
      })
    }
    if (last.close < rangeLow) {
      out.push({
        name: '20-bar Range Breakdown',
        direction: 'BEAR',
        confidence: 0.6,
        note: `Close ${last.close.toFixed(2)} below 20-bar range low ${rangeLow.toFixed(2)}`,
      })
    }
  }

  return out
}

export function patternsToSignal(patterns: ChartPattern[]): { bull: number; bear: number; name: string } {
  let bull = 0, bear = 0
  const names: string[] = []
  for (const p of patterns) {
    if (p.direction === 'BULL') bull += p.confidence
    else bear += p.confidence
    names.push(p.name)
  }
  return { bull, bear, name: names.join(', ') }
}
