import {
  EMA, SMA, RSI, MACD, ATR, BollingerBands, Stochastic, ADX, VWAP,
} from 'technicalindicators'
import type { Candle } from '../types'

function closes(c: Candle[]): number[] { return c.map(x => x.close) }
function highs(c: Candle[]): number[]  { return c.map(x => x.high) }
function lows(c: Candle[]): number[]   { return c.map(x => x.low) }
function vols(c: Candle[]): number[]   { return c.map(x => x.volume) }

// ── Moving averages ────────────────────────────────────────────

export function ema(candles: Candle[], period: number): number[] {
  if (candles.length < period) return []
  return EMA.calculate({ period, values: closes(candles) })
}

export function sma(candles: Candle[], period: number): number[] {
  if (candles.length < period) return []
  return SMA.calculate({ period, values: closes(candles) })
}

/** Full EMA stack used for trend detection */
export function emaStack(candles: Candle[]): { ema9?: number; ema21?: number; ema50?: number; ema200?: number; alignedBull: boolean; alignedBear: boolean } {
  const last = <T>(a: T[]): T | undefined => (a.length ? a[a.length - 1] : undefined)
  const e9 = last(ema(candles, 9))
  const e21 = last(ema(candles, 21))
  const e50 = last(ema(candles, 50))
  const e200 = last(ema(candles, 200))
  const alignedBull = !!(e9 && e21 && e50 && e9 > e21 && e21 > e50)
  const alignedBear = !!(e9 && e21 && e50 && e9 < e21 && e21 < e50)
  return { ema9: e9, ema21: e21, ema50: e50, ema200: e200, alignedBull, alignedBear }
}

// ── Momentum ───────────────────────────────────────────────────

export function rsi(candles: Candle[], period = 14): number[] {
  if (candles.length <= period) return []
  return RSI.calculate({ period, values: closes(candles) })
}

export function lastRSI(candles: Candle[], period = 14): number | undefined {
  const r = rsi(candles, period)
  return r[r.length - 1]
}

export function macd(candles: Candle[]): { macd: number; signal: number; histogram: number } | null {
  if (candles.length < 35) return null
  const out = MACD.calculate({
    values: closes(candles),
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  })
  const last = out[out.length - 1]
  if (!last || last.MACD === undefined || last.signal === undefined || last.histogram === undefined) return null
  return { macd: last.MACD, signal: last.signal, histogram: last.histogram }
}

export function adx(candles: Candle[], period = 14): { adx: number; pdi: number; mdi: number } | null {
  if (candles.length < period + 10) return null
  const out = ADX.calculate({ period, close: closes(candles), high: highs(candles), low: lows(candles) })
  const last = out[out.length - 1]
  if (!last) return null
  return { adx: last.adx, pdi: last.pdi, mdi: last.mdi }
}

export function stoch(candles: Candle[]): { k: number; d: number } | null {
  if (candles.length < 20) return null
  const out = Stochastic.calculate({
    high: highs(candles), low: lows(candles), close: closes(candles),
    period: 14, signalPeriod: 3,
  })
  const last = out[out.length - 1]
  if (!last) return null
  return { k: last.k, d: last.d }
}

// ── Volatility ─────────────────────────────────────────────────

export function atr(candles: Candle[], period = 14): number[] {
  if (candles.length < period + 1) return []
  return ATR.calculate({ period, high: highs(candles), low: lows(candles), close: closes(candles) })
}

export function lastATR(candles: Candle[], period = 14): number | undefined {
  const a = atr(candles, period)
  return a[a.length - 1]
}

export function bollinger(candles: Candle[], period = 20, stdDev = 2) {
  if (candles.length < period) return null
  const out = BollingerBands.calculate({ period, stdDev, values: closes(candles) })
  return out[out.length - 1] ?? null
}

// ── VWAP (intraday) ────────────────────────────────────────────

export function vwap(candles: Candle[]): number[] {
  if (!candles.length) return []
  return VWAP.calculate({
    high: highs(candles), low: lows(candles), close: closes(candles), volume: vols(candles),
  })
}

export function lastVWAP(candles: Candle[]): number | undefined {
  const v = vwap(candles)
  return v[v.length - 1]
}

// ── SuperTrend (custom — not in the lib) ──────────────────────

export interface SuperTrendPoint {
  value: number
  trend: 'UP' | 'DOWN'
}

export function superTrend(candles: Candle[], period = 10, multiplier = 3): SuperTrendPoint[] {
  if (candles.length < period + 1) return []
  const atrVals = atr(candles, period)
  const offset = candles.length - atrVals.length
  const out: SuperTrendPoint[] = []
  let prevUpper = 0, prevLower = 0
  let prevSuper = 0
  let prevTrend: 'UP' | 'DOWN' = 'UP'
  for (let i = 0; i < atrVals.length; i++) {
    const idx = offset + i
    const c = candles[idx]
    const hl2 = (c.high + c.low) / 2
    const a = atrVals[i]
    let upper = hl2 + multiplier * a
    let lower = hl2 - multiplier * a
    if (i > 0) {
      const prevClose = candles[idx - 1].close
      upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper
      lower = lower > prevLower || prevClose < prevLower ? lower : prevLower
    }
    let trend: 'UP' | 'DOWN'
    if (i === 0) {
      trend = c.close >= upper ? 'UP' : 'DOWN'
    } else {
      if (prevSuper === prevUpper && c.close > upper) trend = 'UP'
      else if (prevSuper === prevUpper && c.close <= upper) trend = 'DOWN'
      else if (prevSuper === prevLower && c.close < lower) trend = 'DOWN'
      else if (prevSuper === prevLower && c.close >= lower) trend = 'UP'
      else trend = prevTrend
    }
    const value = trend === 'UP' ? lower : upper
    out.push({ value, trend })
    prevUpper = upper
    prevLower = lower
    prevSuper = value
    prevTrend = trend
  }
  return out
}

export function lastSuperTrend(candles: Candle[], period = 10, multiplier = 3): SuperTrendPoint | undefined {
  const s = superTrend(candles, period, multiplier)
  return s[s.length - 1]
}

// ── Volume ─────────────────────────────────────────────────────

export function volumeSpike(candles: Candle[], lookback = 20, threshold = 1.8): boolean {
  if (candles.length < lookback + 1) return false
  const recent = candles.slice(-lookback - 1, -1)
  const avg = recent.reduce((s, c) => s + c.volume, 0) / recent.length
  const last = candles[candles.length - 1].volume
  return avg > 0 && last >= avg * threshold
}

export function obv(candles: Candle[]): number[] {
  if (candles.length < 2) return []
  const out: number[] = [0]
  for (let i = 1; i < candles.length; i++) {
    const prev = out[i - 1]
    const c = candles[i].close, p = candles[i - 1].close
    out.push(c > p ? prev + candles[i].volume : c < p ? prev - candles[i].volume : prev)
  }
  return out
}

// ── Pivot Points (intraday R/S) ───────────────────────────────

export function pivotPoints(prevDay: Candle): {
  P: number; R1: number; R2: number; R3: number; S1: number; S2: number; S3: number
} {
  const { high: H, low: L, close: C } = prevDay
  const P = (H + L + C) / 3
  return {
    P,
    R1: 2 * P - L,
    R2: P + (H - L),
    R3: H + 2 * (P - L),
    S1: 2 * P - H,
    S2: P - (H - L),
    S3: L - 2 * (H - P),
  }
}
