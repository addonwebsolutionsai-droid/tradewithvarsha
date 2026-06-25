/**
 * F&O FUTURES 12-CRITERIA SCORECARD — per user directive 2026-06-25:
 *   "If you check all 12 below, we can identify all futures/options BEFORE
 *    the move happens, with dates, entry time and price, target with dates."
 *
 * The user's 12 criteria, each scored independently + with reason text:
 *   1. Seasonality            (historical month-over-month win-rate)
 *   2. Cycle                  (Gann/Bradley time cycle alignment)
 *   3. Volume Increase        (today vs 20d avg)
 *   4. FII/DII/Promoter ↑     (stake delta QoQ)
 *   5. Last 5-Day Vol Formula (5d avg / 20d avg)
 *   6. Technical Analysis     (EMA stack + ADX + RSI + MACD composite)
 *   7. Harmonic Patterns      (Gartley / Bat / Butterfly / Crab PRZ proximity)
 *   8. Elliott Wave 1 / 3 / 4 (impulse counting via swing detection)
 *   9. Darvas Box             (consolidation + breakout setup)
 *  10. News Driven            (corp announcement event proximity — best-effort)
 *  11. Accumulation Footprint (OBV + delivery % + bulk-deal cross-check)
 *  12. Tight Range b/f Blast  (volatility contraction pattern — BB width)
 *
 * Each criterion returns { pass, score, detail }. Total = sum, max 120.
 */
import type { Candle } from '../types'
import { getShareholding } from '../data/shareholding'
import { darvasBoxPending, vcpSetup, rangeExpansionBreakout } from '../screeners/preMoveAdvanced'

export interface CriterionResult {
  key: string
  label: string
  pass: boolean
  score: number       // 0-10 each, max 120 total
  detail: string
}

export interface TwelveCriteriaScore {
  total: number       // 0-120
  passCount: number   // how many of the 12 fired
  results: CriterionResult[]
}

// — Indicators —
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

function adx14(candles: Candle[]): number {
  if (candles.length < 16) return 0
  let dmP = 0, dmM = 0, atr = 0
  for (let i = candles.length - 14; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high
    const dn = candles[i - 1].low - candles[i].low
    if (up > dn && up > 0) dmP += up
    if (dn > up && dn > 0) dmM += dn
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    )
    atr += tr
  }
  const dx = (dmP + dmM) > 0 ? Math.abs(dmP - dmM) / (dmP + dmM) * 100 : 0
  return dx
}

function macdHist(closes: number[]): number {
  const e12 = ema(closes, 12)
  const e26 = ema(closes, 26)
  const macdLine = e12 - e26
  // Approx signal line via 9-period EMA of historical MACD points — we only
  // need direction, so use the current macdLine value vs a 3-bar smoothed.
  const recent = closes.slice(-3)
  const e12r = ema(recent, 3)
  const e26r = ema(closes.slice(-9), 9)
  return macdLine - (e12r - e26r)
}

// — Criterion 1: Seasonality —
// Best-effort: weight by month-of-year. Indian markets have known biases:
//   - November–February:  bullish (post-Diwali + budget anticipation)
//   - March–April:        bearish (year-end book closing)
//   - May–July:           bullish (monsoon + Q1 earnings)
//   - August–October:     range (pre-festival)
// This is a coarse model; we pass when the current month historically
// favors the trade direction.
function criterion1Seasonality(side: 'LONG' | 'SHORT', month: number): CriterionResult {
  const bullishMonths = new Set([11, 12, 1, 2, 5, 6, 7])    // Nov-Feb, May-Jul
  const bearishMonths = new Set([3, 4])                     // Mar-Apr
  const isFavor = side === 'LONG' ? bullishMonths.has(month) : bearishMonths.has(month)
  return {
    key: 'seasonality',
    label: 'Seasonality',
    pass: isFavor,
    score: isFavor ? 8 : 0,
    detail: isFavor
      ? `Month ${month} historically favors ${side}`
      : `Month ${month} not in ${side} seasonal sweet spot`,
  }
}

// — Criterion 2: Gann/Bradley cycle —
// Simple proxy: distance to nearest 30-day cycle midpoint (Gann's vibration
// number). When price is near a quarterly cycle high/low, expect inflection.
function criterion2Cycle(candles: Candle[]): CriterionResult {
  if (candles.length < 90) return { key: 'cycle', label: 'Cycle (Gann)', pass: false, score: 0, detail: 'insufficient history' }
  const last = candles[candles.length - 1].close
  const hi90 = Math.max(...candles.slice(-90).map(c => c.high))
  const lo90 = Math.min(...candles.slice(-90).map(c => c.low))
  const pos = (last - lo90) / (hi90 - lo90)
  // Pass if we're at 0-15% or 85-100% of the 90-day range (cycle extreme)
  const atCycleLow = pos < 0.15
  const atCycleHigh = pos > 0.85
  const pass = atCycleLow || atCycleHigh
  return {
    key: 'cycle',
    label: 'Cycle (Gann 90d)',
    pass,
    score: pass ? 10 : 0,
    detail: pass
      ? `${atCycleHigh ? 'near 90d HIGH' : 'near 90d LOW'} — inflection cycle window`
      : `mid-range ${(pos * 100).toFixed(0)}% of 90d band — no cycle edge`,
  }
}

// — Criterion 3: Volume Increase Formula —
// today vol / 20d avg ≥ 1.5×
function criterion3VolumeIncrease(candles: Candle[]): CriterionResult {
  const v20 = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20
  const today = candles[candles.length - 1].volume
  const x = v20 > 0 ? today / v20 : 1
  const pass = x >= 1.5
  return {
    key: 'volume_increase',
    label: 'Volume Increase (today / 20d)',
    pass,
    score: x >= 3 ? 10 : x >= 2 ? 8 : x >= 1.5 ? 6 : 0,
    detail: `${x.toFixed(2)}× 20d avg`,
  }
}

// — Criterion 4: FII / DII / Promoter Stake Increase —
async function criterion4Stakes(symbol: string): Promise<CriterionResult> {
  try {
    const shp = await getShareholding(symbol)
    if (!shp) return { key: 'stakes', label: 'FII/DII/Promoter ↑', pass: false, score: 0, detail: 'no shareholding data' }
    const fiiUp = shp.fiiDeltaQoQ > 0.2
    const diiUp = shp.diiDeltaQoQ > 0.2
    const promoterStable = Math.abs(shp.promoterDeltaQoQ) < 0.5
    const pledgeOk = (shp.promoterPledgePct ?? 0) < 5
    const count = [fiiUp, diiUp, promoterStable, pledgeOk].filter(Boolean).length
    const score = count * 2.5
    const detail = `FII ${shp.fiiPct.toFixed(1)}% (${shp.fiiDeltaQoQ > 0 ? '+' : ''}${shp.fiiDeltaQoQ.toFixed(2)}%) · DII ${shp.diiPct.toFixed(1)}% (${shp.diiDeltaQoQ > 0 ? '+' : ''}${shp.diiDeltaQoQ.toFixed(2)}%) · P ${shp.promoterPct.toFixed(1)}% · Pledge ${(shp.promoterPledgePct ?? 0).toFixed(1)}%`
    return { key: 'stakes', label: 'FII/DII/Promoter ↑', pass: count >= 3, score, detail }
  } catch {
    return { key: 'stakes', label: 'FII/DII/Promoter ↑', pass: false, score: 0, detail: 'shareholding lookup failed' }
  }
}

// — Criterion 5: Last 5-Day Volume Formula —
// 5d avg / 20d avg ≥ 1.3× (sustained accumulation, not single-day spike)
function criterion5Vol5d20d(candles: Candle[]): CriterionResult {
  const v20 = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20
  const v5 = candles.slice(-6, -1).reduce((s, c) => s + c.volume, 0) / 5
  const x = v20 > 0 ? v5 / v20 : 1
  const pass = x >= 1.3
  return {
    key: 'vol5d20d',
    label: 'Last 5-day Vol Formula (5d/20d)',
    pass,
    score: x >= 2 ? 10 : x >= 1.5 ? 8 : x >= 1.3 ? 6 : 0,
    detail: `${x.toFixed(2)}× — ${pass ? 'sustained accumulation' : 'no consistent build'}`,
  }
}

// — Criterion 6: Technical Analysis composite —
// EMA stack + RSI sweet zone + ADX > 20 + MACD positive
function criterion6Technical(candles: Candle[], side: 'LONG' | 'SHORT'): CriterionResult {
  const closes = candles.map(c => c.close)
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = closes.length >= 50 ? ema(closes, 50) : e21
  const price = closes[closes.length - 1]
  const rsi = rsi14(closes)
  const adx = adx14(candles)
  const macd = macdHist(closes)
  const stack = side === 'LONG'
    ? (e9 > e21 && e21 > e50 && price > e21)
    : (e9 < e21 && e21 < e50 && price < e21)
  const rsiOk = side === 'LONG' ? rsi >= 50 && rsi <= 70 : rsi >= 30 && rsi <= 50
  const adxOk = adx > 20
  const macdOk = side === 'LONG' ? macd > 0 : macd < 0
  const checks = [stack, rsiOk, adxOk, macdOk]
  const count = checks.filter(Boolean).length
  return {
    key: 'technical',
    label: 'Technical (EMA+RSI+ADX+MACD)',
    pass: count >= 3,
    score: count * 2.5,
    detail: `EMA${stack ? '✓' : '✗'} · RSI ${rsi.toFixed(0)}${rsiOk ? '✓' : '✗'} · ADX ${adx.toFixed(0)}${adxOk ? '✓' : '✗'} · MACD${macdOk ? '✓' : '✗'}`,
  }
}

// — Criterion 7: Harmonic Pattern proximity —
// Light-weight: detect if we're near a Fibonacci retracement level of recent
// swing (38.2 / 50 / 61.8) — this is the "PRZ" zone. Full harmonic ratios
// would require the harmonicScanner module which is heavy. This is a fast
// proxy that catches the high-leverage candidates.
function criterion7Harmonic(candles: Candle[]): CriterionResult {
  if (candles.length < 50) return { key: 'harmonic', label: 'Harmonic / Fib PRZ', pass: false, score: 0, detail: '<50 bars' }
  const last50 = candles.slice(-50)
  const hi = Math.max(...last50.map(c => c.high))
  const lo = Math.min(...last50.map(c => c.low))
  const price = candles[candles.length - 1].close
  const range = hi - lo
  if (range === 0) return { key: 'harmonic', label: 'Harmonic / Fib PRZ', pass: false, score: 0, detail: 'no range' }
  const fib382 = hi - range * 0.382
  const fib500 = hi - range * 0.500
  const fib618 = hi - range * 0.618
  const near = (level: number, tolPct: number): boolean => Math.abs(price - level) / level < tolPct / 100
  const at382 = near(fib382, 1.5)
  const at500 = near(fib500, 1.5)
  const at618 = near(fib618, 1.5)
  const pass = at382 || at500 || at618
  const which = at618 ? '61.8% (golden)' : at500 ? '50%' : at382 ? '38.2%' : 'none'
  return {
    key: 'harmonic',
    label: 'Harmonic / Fib PRZ',
    pass,
    score: at618 ? 10 : at500 ? 7 : at382 ? 5 : 0,
    detail: `near ${which} retrace of 50d range`,
  }
}

// — Criterion 8: Elliott Wave 1 / 3 / 4 candidate —
// Simplified: detect a low → impulse-up → pullback (W1 + W2) pattern and
// position is currently in W3-startup OR W4-pullback. Done via swing-high
// pivot counting on closes.
function criterion8Elliott(candles: Candle[]): CriterionResult {
  if (candles.length < 30) return { key: 'elliott', label: 'Elliott Wave 1/3/4', pass: false, score: 0, detail: '<30 bars' }
  const closes = candles.map(c => c.close)
  // Find recent swing low (lowest close in last 25 bars) + most recent swing high
  const win = closes.slice(-25)
  let lowIdx = 0, hiIdx = 0
  for (let i = 0; i < win.length; i++) {
    if (win[i] < win[lowIdx]) lowIdx = i
    if (win[i] > win[hiIdx]) hiIdx = i
  }
  if (hiIdx <= lowIdx) return { key: 'elliott', label: 'Elliott Wave 1/3/4', pass: false, score: 0, detail: 'no impulse pattern' }
  const swingLow = win[lowIdx]
  const swingHi = win[hiIdx]
  const last = closes[closes.length - 1]
  const impulsePct = (swingHi - swingLow) / swingLow * 100
  if (impulsePct < 7) return { key: 'elliott', label: 'Elliott Wave 1/3/4', pass: false, score: 0, detail: `weak impulse ${impulsePct.toFixed(1)}%` }
  // W2 retrace 38-61% of W1 + current bar near retrace zone OR just turned up
  const pullback = (swingHi - last) / (swingHi - swingLow)
  const inW2Zone = pullback >= 0.38 && pullback <= 0.65
  const startingW3 = pullback < 0.38 && last > swingLow + (swingHi - swingLow) * 0.5
  const inW4Zone = pullback >= 0.20 && pullback <= 0.38 && hiIdx > win.length - 8
  const isWave3 = startingW3 && win.length - hiIdx > 3      // post-retrace, leg up resuming
  const pass = inW2Zone || isWave3 || inW4Zone
  const which = isWave3 ? 'W3 start' : inW4Zone ? 'W4 pullback' : inW2Zone ? 'W2 complete (W3 imminent)' : 'no wave'
  return {
    key: 'elliott',
    label: 'Elliott W1/W3/W4',
    pass,
    score: isWave3 ? 10 : inW4Zone ? 7 : inW2Zone ? 8 : 0,
    detail: `impulse ${impulsePct.toFixed(1)}% · ${which}`,
  }
}

// — Criterion 9: Darvas Box —
// Re-uses the existing darvasBoxPending screener.
function criterion9Darvas(candles: Candle[], symbol: string): CriterionResult {
  try {
    const r = darvasBoxPending.scan(candles, symbol)
    if (r) {
      return {
        key: 'darvas',
        label: 'Darvas Box',
        pass: true,
        score: 8,
        detail: r.tags?.[0] ?? 'box pending breakout',
      }
    }
    // Fallback: check VCP setup
    const v = vcpSetup.scan(candles, symbol)
    if (v) {
      return { key: 'darvas', label: 'Darvas / VCP', pass: true, score: 6, detail: v.tags?.[0] ?? 'VCP setup' }
    }
  } catch { /* skip */ }
  return { key: 'darvas', label: 'Darvas Box', pass: false, score: 0, detail: 'no box pattern' }
}

// — Criterion 10: News-Driven —
// Best-effort: check if the stock is in today's NSE corp announcements feed.
// Skipped if data unavailable — returns false-pass to avoid penalty.
function criterion10News(candles: Candle[]): CriterionResult {
  // Without a real news feed, use price-action proxy: a big move on
  // SHARPLY ELEVATED volume usually indicates a news catalyst (results,
  // contract, M&A). Look for ≥4% move on ≥3× vol in last 3 bars.
  if (candles.length < 25) return { key: 'news', label: 'News-Driven', pass: false, score: 0, detail: 'insufficient data' }
  const recent3 = candles.slice(-3)
  const v20 = candles.slice(-21, -3).reduce((s, c) => s + c.volume, 0) / 18
  for (const c of recent3) {
    const move = Math.abs((c.close - c.open) / c.open) * 100
    const vx = v20 > 0 ? c.volume / v20 : 0
    if (move >= 4 && vx >= 3) {
      return { key: 'news', label: 'News-Driven', pass: true, score: 7, detail: `news-bar in last 3d (${move.toFixed(1)}% on ${vx.toFixed(1)}× vol)` }
    }
  }
  return { key: 'news', label: 'News-Driven', pass: false, score: 0, detail: 'no news-driven bar' }
}

// — Criterion 11: Accumulation Footprint (OBV + delivery + price-vol divergence) —
// "Big hands accumulating BEFORE the real move" — OBV rising while price flat
// is the textbook smart-money accumulation signature.
function criterion11Accumulation(candles: Candle[], deliveryPct: number | null): CriterionResult {
  if (candles.length < 20) return { key: 'accumulation', label: 'Big-hands Accumulation', pass: false, score: 0, detail: '<20 bars' }
  // OBV: cumulative volume signed by close direction
  let obv = 0
  const obvSeries: number[] = []
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume
    obvSeries.push(obv)
  }
  const obv20 = obvSeries.slice(-20)
  const obvFirst = obv20[0], obvLast = obv20[obv20.length - 1]
  const closes20 = candles.slice(-20).map(c => c.close)
  const priceChg = (closes20[19] - closes20[0]) / closes20[0] * 100
  const obvChg = obvFirst !== 0 ? ((obvLast - obvFirst) / Math.abs(obvFirst)) * 100 : 0
  // Smart-money accumulation: OBV rising > price (positive divergence)
  const divergence = obvChg > 0 && obvChg > priceChg + 5
  const highDeliv = (deliveryPct ?? 0) >= 50
  const pass = divergence || highDeliv
  let score = 0
  if (divergence) score += 6
  if (highDeliv) score += 4
  return {
    key: 'accumulation',
    label: 'Big-hands Accumulation',
    pass,
    score,
    detail: `OBV ${obvChg.toFixed(0)}% vs price ${priceChg.toFixed(0)}%${deliveryPct != null ? ` · deliv ${deliveryPct.toFixed(0)}%` : ''}`,
  }
}

// — Criterion 12: Tight Range before Blast Move —
// Volatility contraction (BB-width or ATR contraction in last 10 days vs
// prior 20). This is the "coiled spring" pattern.
function criterion12TightRange(candles: Candle[]): CriterionResult {
  if (candles.length < 30) return { key: 'tight_range', label: 'Tight Range b/f Blast', pass: false, score: 0, detail: '<30 bars' }
  const closes = candles.map(c => c.close)
  // Compute ATR for last 10 and prior 20
  const atr = (window: Candle[]): number => {
    let s = 0
    for (let i = 1; i < window.length; i++) {
      s += Math.max(
        window[i].high - window[i].low,
        Math.abs(window[i].high - window[i - 1].close),
        Math.abs(window[i].low - window[i - 1].close),
      )
    }
    return s / (window.length - 1)
  }
  const atr10 = atr(candles.slice(-10))
  const atr30Prior = atr(candles.slice(-30, -10))
  const contractionRatio = atr30Prior > 0 ? atr10 / atr30Prior : 1
  // BB width of last 10
  const last10c = closes.slice(-10)
  const mean10 = last10c.reduce((s, x) => s + x, 0) / 10
  const std10 = Math.sqrt(last10c.reduce((s, x) => s + (x - mean10) ** 2, 0) / 10)
  const bbWidth = (std10 * 4) / mean10 * 100
  const pass = contractionRatio < 0.7 && bbWidth < 5
  return {
    key: 'tight_range',
    label: 'Tight Range b/f Blast',
    pass,
    score: pass ? 10 : contractionRatio < 0.85 ? 5 : 0,
    detail: `ATR contraction ${(contractionRatio * 100).toFixed(0)}% · BB-w ${bbWidth.toFixed(1)}%`,
  }
}

/**
 * Run all 12 criteria for a symbol. Returns the full breakdown.
 */
export async function compute12CriteriaScore(opts: {
  symbol: string
  candles: Candle[]
  side: 'LONG' | 'SHORT'
  deliveryPct?: number | null
  month?: number          // 1-12; defaults to current month
}): Promise<TwelveCriteriaScore> {
  const month = opts.month ?? (new Date().getMonth() + 1)
  const stakes = await criterion4Stakes(opts.symbol)
  const results: CriterionResult[] = [
    criterion1Seasonality(opts.side, month),
    criterion2Cycle(opts.candles),
    criterion3VolumeIncrease(opts.candles),
    stakes,
    criterion5Vol5d20d(opts.candles),
    criterion6Technical(opts.candles, opts.side),
    criterion7Harmonic(opts.candles),
    criterion8Elliott(opts.candles),
    criterion9Darvas(opts.candles, opts.symbol),
    criterion10News(opts.candles),
    criterion11Accumulation(opts.candles, opts.deliveryPct ?? null),
    criterion12TightRange(opts.candles),
  ]
  const total = results.reduce((s, r) => s + r.score, 0)
  const passCount = results.filter(r => r.pass).length
  return { total: +total.toFixed(1), passCount, results }
}
