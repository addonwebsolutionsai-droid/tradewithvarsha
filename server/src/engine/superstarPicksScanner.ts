/**
 * Superstar Picks Scanner — for each stock held by India's top investors
 * (Jhunjhunwala-RaRe / Damani / Mukul Agrawal / Kacholia / Kedia / Dolly
 * Khanna / Anil Goel / Sunil Singhania / Madhusudan Kela / Porinju), run
 * the SAME signal scoring used by Weekly Pick (EMA stack + tight coil +
 * vol confirm + at 20d high + RSI productive band + freshness check).
 *
 * Output: per-symbol score + which investor(s) hold it + change-QoQ tag
 * (NEW / INCREASED / HELD / DECREASED) + standard entry/SL/T1/T2/T3.
 *
 * Goal: surface "Superstar X just INCREASED their stake AND our scanner
 * confirms the setup is technically primed" — that's the highest-edge
 * confluence we can show. Catch what they're loading at the same time
 * they're loading it.
 *
 * Limitation (stated honestly to the user):
 *   Quarterly shareholding-pattern filings are delayed 30-45 days post
 *   quarter-end. So "they just bought" means "in the latest filed
 *   quarter" — NOT real-time. Real-time portfolio data is paid.
 *
 * Output snapshot: superstar-picks.json
 */
import * as data from '../data'
import { log } from '../util/logger'
import { SUPERSTAR_INVESTORS, lookupInvestorsHolding, listAllSuperstarSymbols } from '../data/superstarHoldings'

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

export interface SuperstarPick {
  symbol: string
  direction: 'BUY' | 'SHORT'
  conviction: number
  price: number
  ltp: number
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  target1Date: string
  target2Date: string
  target3Date: string
  // Investor attribution — the differentiator
  investors: Array<{
    investor: string
    alias?: string
    category: string
    stakePct?: number
    changeQoQ?: 'NEW' | 'INCREASED' | 'HELD' | 'DECREASED'
  }>
  newOrIncreasedCount: number      // how many investors are loading right now
  flowNote: string                  // for the Reason column
  shareholdingNote?: string         // FII/DII/promoter snippet from existing scrapers
  // Technical features (transparency)
  features: {
    ret5d: number
    ret20d: number
    rsi14: number
    bbWidthPct: number
    volRatio5_20: number
    distFromHigh20: number
    emaStackBull: boolean
  }
  reasons: string[]
}

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

function addBusinessDays(from: Date, days: number): string {
  const d = new Date(from); let added = 0
  while (added < days) { d.setDate(d.getDate() + 1); const dow = d.getDay(); if (dow !== 0 && dow !== 6) added++ }
  return d.toISOString().slice(0, 10)
}

function scoreSymbol(symbol: string, candles: Candle[]): {
  score: number; features: SuperstarPick['features']; reasons: string[]; price: number; direction: 'BUY' | 'SHORT'
} | null {
  if (candles.length < 25) return null
  const closes = candles.map(c => c.close)
  const vols = candles.map(c => c.volume)
  const price = closes[closes.length - 1]
  if (!Number.isFinite(price) || price < 10) return null    // anti-penny

  const ret5d = ((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
  const ret20d = ((price - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
  const high20 = Math.max(...closes.slice(-20))
  const low20 = Math.min(...closes.slice(-20))
  const distFromHigh20 = ((high20 - price) / high20) * 100
  const bbWidthPct = ((high20 - low20) / price) * 100
  const v5 = vols.slice(-5).reduce((s, x) => s + x, 0) / 5
  const v20 = vols.slice(-20).reduce((s, x) => s + x, 0) / 20
  const volRatio = v20 > 0 ? v5 / v20 : 1
  const rsi = rsi14(closes)
  const e9 = ema(closes, 9), e21 = ema(closes, 21)
  const e50 = closes.length >= 50 ? ema(closes, 50) : e21
  const emaStackBull = e9 > e21 && e21 > e50 && price > e21
  const features = { ret5d, ret20d, rsi14: rsi, bbWidthPct, volRatio5_20: volRatio, distFromHigh20, emaStackBull }

  let score = 0
  const reasons: string[] = []
  if (emaStackBull) { score += 20; reasons.push(`EMA 9>21>50 stacked bullish`) }
  if (distFromHigh20 < 5) { score += 15; reasons.push(`${distFromHigh20.toFixed(1)}% off 20d high`) }
  if (bbWidthPct < 15) { score += 10; reasons.push(`tight ${bbWidthPct.toFixed(1)}% coil`) }
  if (volRatio > 1.2) { score += 10; reasons.push(`vol ${volRatio.toFixed(2)}× rising`) }
  if (rsi >= 45 && rsi <= 70) { score += 10; reasons.push(`RSI ${rsi.toFixed(0)} productive`) }
  if (ret20d > 0 && ret20d < 25) { score += 10; reasons.push(`20d +${ret20d.toFixed(1)}%`) }
  if (Math.abs(ret5d) > 8) { score -= 15; reasons.push(`⚠️ 5d ${ret5d.toFixed(1)}% — extended`) }

  return { score, features, reasons, price, direction: 'BUY' }
}

export async function scanSuperstarPicks(): Promise<SuperstarPick[]> {
  const symbols = listAllSuperstarSymbols()
  log.info('SUPERSTAR', `scanning ${symbols.length} superstar-held symbols across ${SUPERSTAR_INVESTORS.length} investors`)

  const today = new Date()
  const out: SuperstarPick[] = []
  const BATCH = 6
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(async (sym): Promise<SuperstarPick | null> => {
      try {
        const cs = await data.getCandles(sym, '1D' as any, 80) as Candle[]
        if (!cs || cs.length < 25) return null
        const scoring = scoreSymbol(sym, cs)
        if (!scoring) return null

        const investors = lookupInvestorsHolding(sym)
        if (investors.length === 0) return null  // safety — should never happen given the input is sourced from the same list

        const newOrIncreased = investors.filter(inv =>
          inv.changeQoQ === 'NEW' || inv.changeQoQ === 'INCREASED',
        ).length
        // BOOST conviction if multiple superstars actively loading
        const conviction = Math.min(100, scoring.score + (newOrIncreased * 5) + (investors.length * 2))
        if (conviction < 50) return null  // floor — don't surface low-conviction superstar holdings

        const dir = scoring.direction
        const entry = +scoring.price.toFixed(2)
        const slPct = scoring.features.bbWidthPct < 8 ? 0.045 : 0.06
        const sl = +(entry * (dir === 'BUY' ? (1 - slPct) : (1 + slPct))).toFixed(2)
        const t1 = +(entry * (dir === 'BUY' ? 1.06 : 0.94)).toFixed(2)
        const t2 = +(entry * (dir === 'BUY' ? 1.12 : 0.88)).toFixed(2)
        const t3 = +(entry * (dir === 'BUY' ? 1.20 : 0.80)).toFixed(2)

        // Build the Reason column flow note
        const topInvestor = investors[0]
        const activeCount = newOrIncreased
        const totalCount = investors.length
        const flowNote = activeCount > 0
          ? `🌟 ${activeCount}/${totalCount} loading — ${topInvestor.alias || topInvestor.investor.split(' ')[0]}${investors.length > 1 ? ` +${investors.length - 1}` : ''} · ${scoring.reasons.slice(0, 2).join(' · ')}`
          : `📊 Held by ${totalCount} superstar${totalCount > 1 ? 's' : ''} — ${topInvestor.alias || topInvestor.investor.split(' ')[0]} · ${scoring.reasons.slice(0, 2).join(' · ')}`

        return {
          symbol: sym,
          direction: dir,
          conviction: Math.round(conviction),
          price: entry, ltp: entry,
          entry, stopLoss: sl, target1: t1, target2: t2, target3: t3,
          target1Date: addBusinessDays(today, 7),
          target2Date: addBusinessDays(today, 14),
          target3Date: addBusinessDays(today, 21),
          investors, newOrIncreasedCount: newOrIncreased,
          flowNote,
          features: scoring.features,
          reasons: scoring.reasons,
        }
      } catch { return null }
    }))
    for (const r of results) if (r) out.push(r)
  }

  // Dedup safety net + sort by conviction
  const seen = new Set<string>()
  const deduped = out.filter(r => {
    if (seen.has(r.symbol)) return false
    seen.add(r.symbol); return true
  }).sort((a, b) => b.conviction - a.conviction)

  log.ok('SUPERSTAR', `${deduped.length} superstar picks scored (${deduped.filter(p => p.newOrIncreasedCount > 0).length} actively loading) from ${symbols.length} holdings`)
  return deduped
}
