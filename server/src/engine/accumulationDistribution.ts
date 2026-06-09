/**
 * Accumulation / Distribution divergence scanner.
 *
 * Smart-money detection that price-only filters miss. Three indicators
 * computed per name:
 *   - OBV  (On-Balance Volume) — cumulative signed volume
 *   - CMF  (Chaikin Money Flow, 20p) — money-flow / volume ratio
 *   - A/D  (Accumulation/Distribution Line) — Williams' classic
 *
 * Divergence signals (the actual edge):
 *   - BULLISH ACCUMULATION: price flat or down 20d AND OBV rising 20d AND CMF > 0.05
 *     → institutions are loading while retail thinks it's dead
 *   - BEARISH DISTRIBUTION: price flat or up 20d AND OBV falling 20d AND CMF < -0.05
 *     → institutions are unloading into retail strength
 *
 * Output: ranked list of names with strong divergence signal — exactly
 * the kind of pre-move setup the existing price-action scanners often
 * miss because they require price confirmation.
 */
import * as data from '../data'
import { log } from '../util/logger'

export interface AdDivergence {
  symbol: string
  side: 'ACCUMULATION' | 'DISTRIBUTION'
  price: number
  ret20d: number
  obvSlope20: number       // normalised OBV slope over last 20 bars (-1 to +1)
  cmf20: number            // -1 to +1, money-flow strength
  adlSlope20: number       // normalised A/D Line slope
  divergenceStrength: number   // 0-100, composite
  reasons: string[]
}

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

function computeOBV(candles: Candle[]): number[] {
  const obv: number[] = [0]
  for (let i = 1; i < candles.length; i++) {
    const prev = obv[i - 1]
    const c = candles[i]
    const p = candles[i - 1]
    if (c.close > p.close) obv.push(prev + c.volume)
    else if (c.close < p.close) obv.push(prev - c.volume)
    else obv.push(prev)
  }
  return obv
}

function computeADL(candles: Candle[]): number[] {
  const adl: number[] = []
  let acc = 0
  for (const c of candles) {
    const range = c.high - c.low
    const mfm = range > 0 ? ((c.close - c.low) - (c.high - c.close)) / range : 0
    acc += mfm * c.volume
    adl.push(acc)
  }
  return adl
}

function computeCMF(candles: Candle[], period = 20): number {
  if (candles.length < period) return 0
  let mfvSum = 0
  let volSum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]
    const range = c.high - c.low
    const mfm = range > 0 ? ((c.close - c.low) - (c.high - c.close)) / range : 0
    mfvSum += mfm * c.volume
    volSum += c.volume
  }
  return volSum > 0 ? mfvSum / volSum : 0
}

/** Normalised slope of a series over last N bars, scaled by mean magnitude. */
function normalisedSlope(values: number[], n: number): number {
  if (values.length < n) return 0
  const seg = values.slice(-n)
  const first = seg[0]
  const last = seg[seg.length - 1]
  const mean = seg.reduce((s, v) => s + Math.abs(v), 0) / seg.length
  if (mean === 0) return 0
  return (last - first) / mean
}

export async function scanAccumulationDistribution(symbols: string[]): Promise<AdDivergence[]> {
  log.info('AD-DIV', `scanning ${symbols.length} symbols for accumulation/distribution divergence`)
  const out: AdDivergence[] = []

  const BATCH = 6
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(async (sym): Promise<AdDivergence | null> => {
      try {
        const candles = await data.getCandles(sym, '1D' as any, 60) as Candle[]
        if (!candles || candles.length < 25) return null
        const price = candles[candles.length - 1].close
        if (!Number.isFinite(price) || price < 5) return null

        const ret20d = ((price - candles[candles.length - 21].close) / candles[candles.length - 21].close) * 100
        const obv = computeOBV(candles)
        const adl = computeADL(candles)
        const cmf = computeCMF(candles, 20)
        const obvSlope = normalisedSlope(obv, 20)
        const adlSlope = normalisedSlope(adl, 20)

        // BULLISH accumulation: price flat/down BUT OBV/ADL rising + CMF positive
        const priceFlat = Math.abs(ret20d) < 5
        const priceDown = ret20d < -3 && ret20d > -20
        const bullDiv = (priceFlat || priceDown) && obvSlope > 0.05 && adlSlope > 0.05 && cmf > 0.05

        // BEARISH distribution: price flat/up BUT OBV/ADL falling + CMF negative
        const priceUp = ret20d > 3 && ret20d < 20
        const bearDiv = (priceFlat || priceUp) && obvSlope < -0.05 && adlSlope < -0.05 && cmf < -0.05

        if (!bullDiv && !bearDiv) return null

        const side: 'ACCUMULATION' | 'DISTRIBUTION' = bullDiv ? 'ACCUMULATION' : 'DISTRIBUTION'
        const reasons: string[] = []
        if (bullDiv) {
          reasons.push(priceFlat ? `price flat 20d (${ret20d.toFixed(1)}%)` : `price down ${ret20d.toFixed(1)}%`)
          reasons.push(`OBV rising +${(obvSlope * 100).toFixed(0)}%`)
          reasons.push(`A/D Line rising +${(adlSlope * 100).toFixed(0)}%`)
          reasons.push(`CMF ${cmf.toFixed(2)} (money flowing in)`)
        } else {
          reasons.push(priceUp ? `price up ${ret20d.toFixed(1)}% (looks bullish)` : `price flat 20d`)
          reasons.push(`OBV falling ${(obvSlope * 100).toFixed(0)}%`)
          reasons.push(`A/D Line falling ${(adlSlope * 100).toFixed(0)}%`)
          reasons.push(`CMF ${cmf.toFixed(2)} (money flowing out)`)
        }

        // Composite divergence strength (0-100)
        const obvWeight = Math.min(40, Math.abs(obvSlope) * 200)
        const cmfWeight = Math.min(30, Math.abs(cmf) * 100)
        const adlWeight = Math.min(30, Math.abs(adlSlope) * 200)
        const strength = Math.round(obvWeight + cmfWeight + adlWeight)

        return {
          symbol: sym, side, price: +price.toFixed(2), ret20d: +ret20d.toFixed(2),
          obvSlope20: +obvSlope.toFixed(3),
          cmf20: +cmf.toFixed(3),
          adlSlope20: +adlSlope.toFixed(3),
          divergenceStrength: strength,
          reasons,
        }
      } catch { return null }
    }))
    for (const r of results) if (r) out.push(r)
  }

  // Dedup safety net (shouldn't be needed — input was already unique)
  const seen = new Set<string>()
  const deduped = out.filter(r => {
    if (seen.has(r.symbol)) return false
    seen.add(r.symbol); return true
  })
  deduped.sort((a, b) => b.divergenceStrength - a.divergenceStrength)
  log.ok('AD-DIV', `${deduped.length} divergence picks · ${deduped.filter(r => r.side === 'ACCUMULATION').length} accum · ${deduped.filter(r => r.side === 'DISTRIBUTION').length} dist`)
  return deduped
}
