/**
 * Ichimoku Cloud Scanner (20 Aug 2026)
 *
 * User directive: SILVERM options chart screenshot showing the trader
 * using Ichimoku Cloud (Kumo) + EMA overlay for a +68% call-option
 * trade (₹4009 → ₹6776). User asked: "Can we also implement this?"
 *
 * The setup that fired:
 *   · Price broke above the Kumo (cloud)
 *   · Cloud flipped from bearish (red) to bullish (green)
 *   · Fast EMA (9) crossed above slow EMA (21)
 *   · Chikou Span (lagging) above prior price 26 bars back
 *   · 1-minute chart for intraday options entry timing
 *
 * This engine implements the full 5-signal Ichimoku system + EMA overlay:
 *
 *   1. Tenkan (Conversion, 9) = (9-hi + 9-lo) / 2
 *   2. Kijun  (Base, 26)      = (26-hi + 26-lo) / 2
 *   3. Senkou Span A          = (Tenkan + Kijun) / 2, projected +26 bars
 *   4. Senkou Span B (52)     = (52-hi + 52-lo) / 2, projected +26 bars
 *   5. Chikou (Lagging)       = current close, plotted -26 bars back
 *
 * Bullish setup (all must fire for STRONG):
 *   · price > cloud (both spans below price)
 *   · Senkou A > Senkou B (green cloud)
 *   · Tenkan > Kijun (recent momentum up)
 *   · Chikou > close[t-26] (no lagging resistance)
 *   · Fast EMA(9) > Slow EMA(21) (trend agreement)
 *
 * Bearish setup mirrors above.
 *
 * Emits ichimoku-cloud.json — feeds into MASTER + Options-Radar for
 * NIFTY/BANKNIFTY CE/PE entry timing. Runs on 1D for positional + 15m
 * intraday for options scalps.
 */

import * as data from '../data'
import type { Candle } from '../types'
import { log } from '../util/logger'
import fs from 'fs/promises'
import path from 'path'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')
const OUTPUT_FILE = path.join(SNAP_DIR, 'ichimoku-cloud.json')

export interface IchimokuHit {
  symbol: string
  timeframe: string
  direction: 'BUY' | 'SELL'
  score: number                            // 0-100 composite
  ltp: number
  tenkan: number
  kijun: number
  senkouA: number
  senkouB: number
  chikou: number
  cloudColour: 'GREEN' | 'RED'
  priceVsCloud: 'ABOVE' | 'INSIDE' | 'BELOW'
  fastEma9: number
  slowEma21: number
  signals: string[]                        // enumerated satisfied conditions
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  rrT1: number
  entryDate: string
  target1Date: string
  target2Date: string
  target3Date: string
  reasoning: string[]
  optionsHint?: string                     // for indices: "BUY 24400 CE" style suggestion
}

interface IchimokuValues {
  tenkan: number
  kijun: number
  senkouA: number                          // current-bar Senkou A (leading-span-A shifted back)
  senkouB: number
  chikou: number                           // close 26 bars back (compared to now)
  fastEma9: number
  slowEma21: number
  cloudColour: 'GREEN' | 'RED'
  priceVsCloud: 'ABOVE' | 'INSIDE' | 'BELOW'
}

function ema(values: number[], period: number): number {
  if (!values.length) return 0
  const k = 2 / (period + 1)
  let e = values[0]
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}

/**
 * Compute Ichimoku values for the LAST bar. Returns null if not enough
 * history (need at least 78 bars: 52 base + 26 forward projection).
 */
function computeIchimoku(candles: Candle[]): IchimokuValues | null {
  const N = candles.length
  if (N < 78) return null
  const price = candles[N - 1].close

  const highN = (n: number, offset = 0) => {
    let hi = -Infinity
    for (let i = N - 1 - offset; i > N - 1 - offset - n; i--) hi = Math.max(hi, candles[i].high)
    return hi
  }
  const lowN = (n: number, offset = 0) => {
    let lo = Infinity
    for (let i = N - 1 - offset; i > N - 1 - offset - n; i--) lo = Math.min(lo, candles[i].low)
    return lo
  }

  const tenkan = (highN(9) + lowN(9)) / 2
  const kijun = (highN(26) + lowN(26)) / 2

  // Current bar's cloud comes from Span A/B values plotted 26 bars ago
  // (they're "lagged forward"). We compute them from candles 26 bars back.
  const tenkanBack = (highN(9, 26) + lowN(9, 26)) / 2
  const kijunBack = (highN(26, 26) + lowN(26, 26)) / 2
  const senkouA = (tenkanBack + kijunBack) / 2
  const senkouB = (highN(52, 26) + lowN(52, 26)) / 2

  const cloudTop = Math.max(senkouA, senkouB)
  const cloudBot = Math.min(senkouA, senkouB)
  const priceVsCloud: IchimokuValues['priceVsCloud'] =
    price > cloudTop ? 'ABOVE' : price < cloudBot ? 'BELOW' : 'INSIDE'
  const cloudColour: IchimokuValues['cloudColour'] = senkouA >= senkouB ? 'GREEN' : 'RED'

  // Chikou: today's close compared to close 26 bars back (bullish if above)
  const chikou = candles[N - 27]?.close ?? candles[0].close

  const closes = candles.map(c => c.close)
  const fastEma9 = ema(closes.slice(-30), 9)
  const slowEma21 = ema(closes.slice(-45), 21)

  return { tenkan, kijun, senkouA, senkouB, chikou, fastEma9, slowEma21, cloudColour, priceVsCloud }
}

/**
 * Evaluate the 5-signal Ichimoku setup + EMA overlay for one symbol/TF.
 * Returns null if not a valid setup (mixed signals). Otherwise emits
 * a full trade plan.
 */
function evaluate(symbol: string, timeframe: string, candles: Candle[]): IchimokuHit | null {
  const iv = computeIchimoku(candles)
  if (!iv) return null
  const last = candles[candles.length - 1]
  const price = last.close

  const bullSignals: string[] = []
  const bearSignals: string[] = []

  // 1. Price vs cloud
  if (iv.priceVsCloud === 'ABOVE') bullSignals.push(`Price ₹${price.toFixed(2)} above Kumo`)
  else if (iv.priceVsCloud === 'BELOW') bearSignals.push(`Price ₹${price.toFixed(2)} below Kumo`)

  // 2. Cloud colour
  if (iv.cloudColour === 'GREEN') bullSignals.push(`Green Kumo (Senkou A ₹${iv.senkouA.toFixed(2)} > B ₹${iv.senkouB.toFixed(2)})`)
  else bearSignals.push(`Red Kumo (Senkou A ₹${iv.senkouA.toFixed(2)} < B ₹${iv.senkouB.toFixed(2)})`)

  // 3. Tenkan vs Kijun (TK cross)
  if (iv.tenkan > iv.kijun) bullSignals.push(`Tenkan ₹${iv.tenkan.toFixed(2)} > Kijun ₹${iv.kijun.toFixed(2)} (bullish TK)`)
  else if (iv.tenkan < iv.kijun) bearSignals.push(`Tenkan ₹${iv.tenkan.toFixed(2)} < Kijun ₹${iv.kijun.toFixed(2)} (bearish TK)`)

  // 4. Chikou vs price 26 bars back
  if (price > iv.chikou) bullSignals.push(`Chikou clear (price > close[t-26] ₹${iv.chikou.toFixed(2)})`)
  else if (price < iv.chikou) bearSignals.push(`Chikou blocked (price < close[t-26] ₹${iv.chikou.toFixed(2)})`)

  // 5. EMA overlay (9 vs 21) — the fast/slow EMA pair from the screenshot
  if (iv.fastEma9 > iv.slowEma21) bullSignals.push(`EMA 9 (${iv.fastEma9.toFixed(2)}) > EMA 21 (${iv.slowEma21.toFixed(2)})`)
  else if (iv.fastEma9 < iv.slowEma21) bearSignals.push(`EMA 9 (${iv.fastEma9.toFixed(2)}) < EMA 21 (${iv.slowEma21.toFixed(2)})`)

  const bullCount = bullSignals.length
  const bearCount = bearSignals.length

  // Require at least 4 of 5 signals for STRONG, all 5 for ELITE. Anything
  // less is mixed — skip.
  const total = Math.max(bullCount, bearCount)
  if (total < 4) return null
  const direction: 'BUY' | 'SELL' = bullCount > bearCount ? 'BUY' : 'SELL'
  const signals = direction === 'BUY' ? bullSignals : bearSignals

  // Score: 20 pts per satisfied signal
  const score = Math.min(100, total * 20)

  // Trade plan — use Kijun as SL, +1× / +2× / +3× (Kijun to price distance)
  const kijunDist = Math.abs(price - iv.kijun)
  const targetMult = timeframe === '1D' ? [1.5, 2.5, 4] : [1, 1.5, 2]
  let entry = price
  let stopLoss = direction === 'BUY' ? iv.kijun : iv.kijun
  const t1 = direction === 'BUY' ? price + kijunDist * targetMult[0] : price - kijunDist * targetMult[0]
  const t2 = direction === 'BUY' ? price + kijunDist * targetMult[1] : price - kijunDist * targetMult[1]
  const t3 = direction === 'BUY' ? price + kijunDist * targetMult[2] : price - kijunDist * targetMult[2]

  const risk = Math.abs(entry - stopLoss)
  const rrT1 = risk > 0 ? Math.abs(t1 - entry) / risk : 0

  const now = new Date()
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const addDays = (n: number) => { const d = new Date(now.getTime() + n * 86400_000); return iso(d) }

  // Days-to-target scale by TF
  const [d1, d2, d3] = timeframe === '1D' ? [5, 10, 20] : timeframe === '4h' ? [3, 6, 12] : timeframe === '1h' ? [2, 4, 8] : [1, 2, 4]

  const isIndex = symbol === 'NIFTY' || symbol === 'BANKNIFTY' || symbol === 'FINNIFTY'
  let optionsHint: string | undefined
  if (isIndex) {
    const step = symbol === 'BANKNIFTY' ? 100 : 50
    const atm = Math.round(price / step) * step
    const targetStrike = direction === 'BUY' ? atm : atm
    const side = direction === 'BUY' ? 'CE' : 'PE'
    optionsHint = `BUY ${symbol} ${targetStrike} ${side}`
  }

  const reasoning = [
    `Ichimoku ${direction === 'BUY' ? 'BULLISH' : 'BEARISH'} · ${total}/5 signals + EMA agreement`,
    ...signals.map(s => `  · ${s}`),
    `Trade plan: Kijun SL (Base line) · R:R T1 ${rrT1.toFixed(2)}`,
    optionsHint ? `Options: ${optionsHint} for leveraged expression` : '',
  ].filter(Boolean)

  return {
    symbol, timeframe, direction, score,
    ltp: price,
    tenkan: +iv.tenkan.toFixed(2),
    kijun: +iv.kijun.toFixed(2),
    senkouA: +iv.senkouA.toFixed(2),
    senkouB: +iv.senkouB.toFixed(2),
    chikou: +iv.chikou.toFixed(2),
    cloudColour: iv.cloudColour,
    priceVsCloud: iv.priceVsCloud,
    fastEma9: +iv.fastEma9.toFixed(2),
    slowEma21: +iv.slowEma21.toFixed(2),
    signals,
    entry: +entry.toFixed(2),
    stopLoss: +stopLoss.toFixed(2),
    target1: +t1.toFixed(2),
    target2: +t2.toFixed(2),
    target3: +t3.toFixed(2),
    rrT1: +rrT1.toFixed(2),
    entryDate: iso(now),
    target1Date: addDays(d1),
    target2Date: addDays(d2),
    target3Date: addDays(d3),
    reasoning,
    optionsHint,
  }
}

const UNIVERSE = [
  // Indices — the highest-leverage Ichimoku plays (options driver)
  'NIFTY', 'BANKNIFTY', 'FINNIFTY',
  // Commodities — the SILVERM example on the screenshot
  'SILVER', 'GOLD', 'CRUDE',
  // Top F&O leaders — high options volume
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN', 'AXISBANK',
  'ITC', 'LT', 'BHARTIARTL', 'BAJFINANCE', 'KOTAKBANK', 'MARUTI',
  'ASIANPAINT', 'TATAMOTORS', 'TATASTEEL', 'HCLTECH', 'WIPRO',
  'ADANIENT', 'ADANIPORTS', 'HINDUNILVR', 'SUNPHARMA',
]

export async function runIchimokuScan(): Promise<{ hits: IchimokuHit[]; scanned: number }> {
  const t0 = Date.now()
  const timeframes: Array<{ label: string; tf: any; lookback: number }> = [
    { label: '1D', tf: '1D', lookback: 120 },
    { label: '1h', tf: '1h', lookback: 200 },
    { label: '15m', tf: '15m', lookback: 300 },
  ]

  const hits: IchimokuHit[] = []
  let scanned = 0

  for (const sym of UNIVERSE) {
    for (const { label, tf, lookback } of timeframes) {
      try {
        const candles = await data.getCandles(sym, tf, lookback)
        scanned++
        if (!candles || candles.length < 78) continue
        const hit = evaluate(sym, label, candles)
        if (hit) hits.push(hit)
      } catch { /* skip on data failure */ }
    }
  }

  hits.sort((a, b) => b.score - a.score)

  const out = {
    generatedAt: new Date().toISOString(),
    universe: UNIVERSE.length,
    timeframes: timeframes.map(t => t.label),
    scanned,
    total: hits.length,
    elite: hits.filter(h => h.score === 100).length,
    strong: hits.filter(h => h.score >= 80 && h.score < 100).length,
    rows: hits,
  }
  await fs.mkdir(SNAP_DIR, { recursive: true })
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(out, null, 2), 'utf-8')
  log.ok('ICHIMOKU', `${hits.length} setups (${out.elite}E + ${out.strong}S) from ${scanned} scans · ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return { hits, scanned }
}
