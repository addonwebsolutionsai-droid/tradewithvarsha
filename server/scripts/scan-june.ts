/**
 * One-shot scan: top F&O stock-futures candidates for ≥10% move in the
 * current month. Pulls daily candles via Angel for each FUTSTK underlying,
 * computes a pre-breakout + momentum + volume score, ranks, prints top 20.
 *
 * Usage:  npx ts-node scripts/scan-june.ts
 */
import * as angel from '../src/data/angel'

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Feature {
  symbol: string
  price: number
  ret5d: number
  ret20d: number
  ret60d: number
  vol5d: number
  vol20d: number
  vol60d: number
  volRatio: number      // 5d/20d
  rsi14: number
  high20: number
  low20: number
  distFrom20dHigh: number   // % below 20d high (0 = at high)
  bbWidthPct: number    // (high20 - low20) / price as % — tighter = coiling
  ema9: number
  ema21: number
  ema50: number
  trendBullish: boolean
  trendBearish: boolean
  score: number
  side: 'LONG' | 'SHORT'
  reason: string[]
}

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  let prev = values[0]
  for (let i = 0; i < values.length; i++) {
    const v = i === 0 ? values[0] : values[i] * k + prev * (1 - k)
    out.push(v)
    prev = v
  }
  return out
}

function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) gains += d
    else losses -= d
  }
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

async function fetchCandles(symbol: string): Promise<Candle[] | null> {
  const scrip = await angel.findScrip('NSE', symbol + '-EQ')
  if (!scrip) return null
  try {
    const candles = await angel.getCandles('NSE', scrip.token, '1D' as any, 90)
    if (!candles || candles.length < 25) return null
    return candles as Candle[]
  } catch {
    return null
  }
}

function scoreSymbol(symbol: string, candles: Candle[]): Feature | null {
  if (candles.length < 25) return null
  const closes = candles.map(c => c.close)
  const vols = candles.map(c => c.volume)
  const price = closes[closes.length - 1]
  if (!price || price < 5) return null

  const last5 = closes.slice(-5)
  const last20 = closes.slice(-20)
  const last60 = closes.slice(-60)
  const vlast5 = vols.slice(-5)
  const vlast20 = vols.slice(-20)
  const vlast60 = vols.slice(-60)
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length

  const ret5d = ((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
  const ret20d = ((price - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
  const ret60d = candles.length >= 61
    ? ((price - closes[closes.length - 61]) / closes[closes.length - 61]) * 100
    : 0

  const high20 = Math.max(...last20)
  const low20 = Math.min(...last20)
  const distFrom20dHigh = ((high20 - price) / high20) * 100
  const bbWidthPct = ((high20 - low20) / price) * 100

  const vol5 = mean(vlast5)
  const vol20 = mean(vlast20)
  const vol60 = candles.length >= 60 ? mean(vlast60) : vol20
  const volRatio = vol20 > 0 ? vol5 / vol20 : 1

  const rsi14 = rsi(closes)
  const e9 = ema(closes, 9)
  const e21 = ema(closes, 21)
  const e50 = ema(closes, 50)
  const ema9v = e9[e9.length - 1]
  const ema21v = e21[e21.length - 1]
  const ema50v = e50[e50.length - 1]

  const trendBullish = ema9v > ema21v && ema21v > ema50v && price > ema21v
  const trendBearish = ema9v < ema21v && ema21v < ema50v && price < ema21v

  const reason: string[] = []
  let score = 0
  let side: 'LONG' | 'SHORT' = 'LONG'

  // ── LONG SETUP ──
  // Pre-breakout coil: tight BB + at 20d high + vol rising + healthy trend
  if (trendBullish) {
    score += 25
    reason.push('EMA9>21>50 stacked bullish')
  }
  if (distFrom20dHigh < 3 && trendBullish) {
    score += 20
    reason.push(`at 20d high (${distFrom20dHigh.toFixed(1)}% off)`)
  }
  if (bbWidthPct < 12 && trendBullish) {
    score += 15
    reason.push(`tight range (BB-w ${bbWidthPct.toFixed(1)}%)`)
  }
  if (volRatio > 1.3 && trendBullish) {
    score += 15
    reason.push(`vol ${volRatio.toFixed(1)}× rising`)
  }
  if (rsi14 >= 50 && rsi14 <= 70 && trendBullish) {
    score += 10
    reason.push(`RSI ${rsi14.toFixed(0)} (productive)`)
  }
  if (ret20d > 5 && ret20d < 25 && trendBullish) {
    score += 10
    reason.push(`20d +${ret20d.toFixed(1)}% (not extended)`)
  }
  // Penalty for already-extended
  if (Math.abs(ret5d) > 8) {
    score -= 15
    reason.push(`5d ${ret5d.toFixed(1)}% — extended`)
  }

  // ── SHORT SETUP ──
  const shortReason: string[] = []
  let shortScore = 0
  if (trendBearish) {
    shortScore += 25
    shortReason.push('EMA9<21<50 stacked bearish')
  }
  if (rsi14 < 45 && trendBearish) {
    shortScore += 15
    shortReason.push(`RSI ${rsi14.toFixed(0)} weak`)
  }
  if (volRatio > 1.3 && trendBearish) {
    shortScore += 15
    shortReason.push(`vol ${volRatio.toFixed(1)}× distribution`)
  }
  if (ret20d < -5 && ret20d > -20 && trendBearish) {
    shortScore += 10
    shortReason.push(`20d ${ret20d.toFixed(1)}% breakdown`)
  }
  // Near 20d-low confirmation
  const distFrom20dLow = ((price - low20) / low20) * 100
  if (distFrom20dLow < 3 && trendBearish) {
    shortScore += 15
    shortReason.push(`at 20d low`)
  }

  if (shortScore > score) {
    score = shortScore
    side = 'SHORT'
    reason.length = 0
    reason.push(...shortReason)
  }

  return {
    symbol, price, ret5d, ret20d, ret60d,
    vol5d: vol5, vol20d: vol20, vol60d: vol60, volRatio,
    rsi14, high20, low20, distFrom20dHigh, bbWidthPct,
    ema9: ema9v, ema21: ema21v, ema50: ema50v,
    trendBullish, trendBearish, score, side, reason,
  }
}

async function main() {
  console.log('Loading ScripMaster...')
  const sm = await angel.loadScripMaster()
  const futs = sm.filter(s => s.exch_seg === 'NFO' && s.instrumenttype === 'FUTSTK')
  const names = [...new Set(futs.map(s => s.name))]
    .filter(n => !!n && !/NSETEST/i.test(n))
    .sort()
  console.log(`F&O underlyings: ${names.length}`)

  const features: Feature[] = []
  let done = 0
  // Run in batches to avoid hammering Angel
  const BATCH = 5
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(async name => {
      const c = await fetchCandles(name)
      if (!c) return null
      return scoreSymbol(name, c)
    }))
    for (const r of results) if (r) features.push(r)
    done += batch.length
    if (done % 25 === 0) console.error(`  scanned ${done}/${names.length} · kept ${features.length}`)
  }
  console.log(`Total scored: ${features.length}`)

  // Compute entry/SL/T targets
  const ranked = features.sort((a, b) => b.score - a.score)
  const top = ranked.slice(0, 20)
  console.log('\n#  Sym         Side  Price    Entry      SL        T1        T2        T3      Move  Score  Reason')
  console.log('='.repeat(170))
  top.forEach((f, i) => {
    // Targets sized for the side
    const dir = f.side === 'LONG' ? 1 : -1
    const slDist = f.bbWidthPct < 8 ? 0.045 : 0.06   // tighter coil = tighter stop
    const entry = f.price
    const sl = entry * (1 - dir * slDist)
    const t1 = entry * (1 + dir * 0.06)
    const t2 = entry * (1 + dir * 0.12)
    const t3 = entry * (1 + dir * 0.20)
    const movePct = 20
    const r = f.reason.slice(0, 3).join(' · ')
    console.log(`${(i+1).toString().padStart(2)} ${f.symbol.padEnd(11)} ${f.side.padEnd(5)} ${f.price.toFixed(2).padStart(7)}  ${entry.toFixed(2).padStart(7)}  ${sl.toFixed(2).padStart(7)}  ${t1.toFixed(2).padStart(7)}  ${t2.toFixed(2).padStart(7)}  ${t3.toFixed(2).padStart(7)}  ${movePct}%   ${f.score.toString().padStart(3)}   ${r}`)
  })
}

main().catch(e => { console.error(e); process.exit(1) })
