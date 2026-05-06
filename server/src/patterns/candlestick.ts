import type { Candle } from '../types'

/** Classic candlestick patterns — operates on the last 2–3 candles. */

function body(c: Candle) { return Math.abs(c.close - c.open) }
function range(c: Candle) { return c.high - c.low }
function upperWick(c: Candle) { return c.high - Math.max(c.open, c.close) }
function lowerWick(c: Candle) { return Math.min(c.open, c.close) - c.low }
function isBull(c: Candle) { return c.close > c.open }
function isBear(c: Candle) { return c.close < c.open }

export function bullishEngulfing(c: Candle[]): boolean {
  if (c.length < 2) return false
  const p = c[c.length - 2], l = c[c.length - 1]
  return isBear(p) && isBull(l) && l.close > p.open && l.open < p.close
}

export function bearishEngulfing(c: Candle[]): boolean {
  if (c.length < 2) return false
  const p = c[c.length - 2], l = c[c.length - 1]
  return isBull(p) && isBear(l) && l.close < p.open && l.open > p.close
}

export function hammer(c: Candle[]): boolean {
  if (c.length < 1) return false
  const l = c[c.length - 1]
  const r = range(l), b = body(l)
  return r > 0 && lowerWick(l) >= b * 2 && upperWick(l) <= b * 0.5 && b > 0
}

export function shootingStar(c: Candle[]): boolean {
  if (c.length < 1) return false
  const l = c[c.length - 1]
  const r = range(l), b = body(l)
  return r > 0 && upperWick(l) >= b * 2 && lowerWick(l) <= b * 0.5 && b > 0
}

export function doji(c: Candle[], tolerance = 0.1): boolean {
  const l = c[c.length - 1]
  const r = range(l)
  return r > 0 && body(l) <= r * tolerance
}

export function morningStar(c: Candle[]): boolean {
  if (c.length < 3) return false
  const [a, b, d] = c.slice(-3)
  return isBear(a) && body(b) < body(a) * 0.4 && isBull(d) && d.close > (a.open + a.close) / 2
}

export function eveningStar(c: Candle[]): boolean {
  if (c.length < 3) return false
  const [a, b, d] = c.slice(-3)
  return isBull(a) && body(b) < body(a) * 0.4 && isBear(d) && d.close < (a.open + a.close) / 2
}

export interface CandleSignal {
  name: string
  direction: 'BULL' | 'BEAR'
}

export function detectCandlePatterns(candles: Candle[]): CandleSignal[] {
  const out: CandleSignal[] = []
  if (bullishEngulfing(candles)) out.push({ name: 'Bullish Engulfing', direction: 'BULL' })
  if (bearishEngulfing(candles)) out.push({ name: 'Bearish Engulfing', direction: 'BEAR' })
  if (hammer(candles)) out.push({ name: 'Hammer', direction: 'BULL' })
  if (shootingStar(candles)) out.push({ name: 'Shooting Star', direction: 'BEAR' })
  if (morningStar(candles)) out.push({ name: 'Morning Star', direction: 'BULL' })
  if (eveningStar(candles)) out.push({ name: 'Evening Star', direction: 'BEAR' })
  return out
}
