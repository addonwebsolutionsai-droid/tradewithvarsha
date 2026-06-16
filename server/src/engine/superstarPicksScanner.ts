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
  // 2026-06-16: tier — which leg of the move we're entering at. EARLY
  // = pre-breakout (best edge, we're WITH the superstars not behind them).
  // CONFIRMED = move started, still has runway. LATE = already extended,
  // we'd be exit liquidity (auto-demoted in ranking).
  tier: 'EARLY' | 'CONFIRMED' | 'LATE'
  preMoveScore: number              // -50 to +100
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
  score: number; preMoveScore: number; features: SuperstarPick['features']; reasons: string[]; price: number; direction: 'BUY' | 'SHORT'; tier: 'EARLY' | 'CONFIRMED' | 'LATE'
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
  // 60-day move context — needed to detect "already running" vs "still consolidating"
  const has60 = candles.length >= 60
  const high60 = has60 ? Math.max(...closes.slice(-60)) : high20
  const low60 = has60 ? Math.min(...closes.slice(-60)) : low20
  const distFromLow60 = ((price - low60) / low60) * 100      // % above 60d low
  const ret60d = has60 ? ((price - closes[closes.length - 61]) / closes[closes.length - 61]) * 100 : 0
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

  // 2026-06-16 — "BEFORE THE MOVE" detector per user directive:
  // we should NOT be the exit liquidity for the big investors. So
  // explicitly classify which leg of the move we're in:
  //
  //   EARLY     — still pre-breakout: low ret5d AND below 15% from 60d low
  //   CONFIRMED — moving up cleanly: 5-30% above 60d low, tight coil
  //   LATE      — already extended: >40% above 60d low OR ret60d > 30%
  let tier: 'EARLY' | 'CONFIRMED' | 'LATE' = 'CONFIRMED'
  let preMoveScore = 0
  if (Math.abs(ret5d) < 4 && Math.abs(ret20d) < 10 && distFromLow60 < 20 && bbWidthPct < 12) {
    tier = 'EARLY'
    preMoveScore = 100                       // strongest "we're before the move" signal
    reasons.unshift(`🎯 EARLY — pre-breakout (${distFromLow60.toFixed(0)}% off 60d low, coil ${bbWidthPct.toFixed(1)}%)`)
  } else if (distFromLow60 > 40 || ret60d > 30) {
    tier = 'LATE'
    preMoveScore = -50                       // demote — we'd be exit liquidity
    reasons.unshift(`⚠️ LATE — ${distFromLow60.toFixed(0)}% above 60d low / ret60d ${ret60d.toFixed(0)}%`)
  } else {
    tier = 'CONFIRMED'
    preMoveScore = 50
    reasons.unshift(`✓ CONFIRMED — moving but not exhausted (${distFromLow60.toFixed(0)}% above 60d low)`)
  }

  return { score, preMoveScore, features, reasons, price, direction: 'BUY', tier }
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
        // Conviction = base technical + superstar boost + pre-move tier weight.
        // EARLY tier (pre-breakout) gets the biggest boost so it ranks ABOVE
        // already-extended names that bigger investors might be exiting into.
        const conviction = Math.min(100, Math.max(0,
          scoring.score
          + (newOrIncreased * 5)
          + (investors.length * 2)
          + (scoring.tier === 'EARLY' ? 20 : scoring.tier === 'CONFIRMED' ? 5 : -15),
        ))
        if (conviction < 50) return null  // floor — don't surface low-conviction
        // LATE tier auto-suppressed: we'd be exit liquidity
        if (scoring.tier === 'LATE') return null

        const dir = scoring.direction
        const entry = +scoring.price.toFixed(2)
        const slPct = scoring.features.bbWidthPct < 8 ? 0.045 : 0.06
        const sl = +(entry * (dir === 'BUY' ? (1 - slPct) : (1 + slPct))).toFixed(2)
        const t1 = +(entry * (dir === 'BUY' ? 1.06 : 0.94)).toFixed(2)
        const t2 = +(entry * (dir === 'BUY' ? 1.12 : 0.88)).toFixed(2)
        const t3 = +(entry * (dir === 'BUY' ? 1.20 : 0.80)).toFixed(2)

        // Build the Reason column flow note — leads with tier so user
        // immediately sees whether we're early or just confirming.
        const topInvestor = investors[0]
        const activeCount = newOrIncreased
        const totalCount = investors.length
        const tierBadge = scoring.tier === 'EARLY' ? '🎯 EARLY' : '✓ CONFIRMED'
        const investorBit = activeCount > 0
          ? `${activeCount}/${totalCount} loading — ${topInvestor.alias || topInvestor.investor.split(' ')[0]}${investors.length > 1 ? ` +${investors.length - 1}` : ''}`
          : `held by ${topInvestor.alias || topInvestor.investor.split(' ')[0]}${investors.length > 1 ? ` +${investors.length - 1}` : ''}`
        const techBit = scoring.reasons.filter(r => !r.startsWith('🎯') && !r.startsWith('✓') && !r.startsWith('⚠️')).slice(0, 2).join(' · ')
        const flowNote = `${tierBadge} · 🌟 ${investorBit} · ${techBit}`

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
          tier: scoring.tier,
          preMoveScore: scoring.preMoveScore,
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

  // 2026-06-16: enrich with FII/DII/Promoter stake info so the Reason
  // column shows both "🌟 Damani loading" AND "📊 FII 5.2% (1.1pp↑)
  // · DII 8.0% · P 39%→ · Pledge 0% · MC ₹12.7KCr". Two-line wrap in
  // UniformPickTable so users see both aspects without scrolling.
  try {
    const { enrichShareholdingNotes } = await import('./publicSnapshots')
    await enrichShareholdingNotes(deduped)
  } catch (e) {
    log.warn('SUPERSTAR', `shareholding enrich skipped: ${(e as Error).message}`)
  }

  // 2026-06-16 fallback — if the screener.in scraper had no data for a
  // symbol (common for smallcap superstar holdings), synthesise the
  // shareholdingNote from the superstar stake itself + investor name.
  // This guarantees the user ALWAYS sees a 📊 line in the Reason col.
  for (const r of deduped) {
    if (r.shareholdingNote && r.shareholdingNote.length > 5) continue
    const top = r.investors[0]
    const totalStake = r.investors.reduce((s, x) => s + (x.stakePct ?? 0), 0)
    r.shareholdingNote = top
      ? `${top.alias || top.investor.split(' ')[0]} owns ${(top.stakePct ?? 0).toFixed(1)}%${r.investors.length > 1 ? ` (combined ${totalStake.toFixed(1)}% across ${r.investors.length} superstars)` : ''} · FII/DII data unavailable for this smallcap`
      : 'FII/DII data unavailable for this smallcap'
  }

  // Sort: EARLY tier first, then by conviction descending. So pre-breakout
  // setups always lead — never let LATE / extended names be the headline.
  deduped.sort((a, b) => {
    const ta = a.tier === 'EARLY' ? 2 : a.tier === 'CONFIRMED' ? 1 : 0
    const tb = b.tier === 'EARLY' ? 2 : b.tier === 'CONFIRMED' ? 1 : 0
    if (tb !== ta) return tb - ta
    return b.conviction - a.conviction
  })

  log.ok('SUPERSTAR', `${deduped.length} picks · ${deduped.filter(p => p.tier === 'EARLY').length} 🎯 EARLY · ${deduped.filter(p => p.tier === 'CONFIRMED').length} ✓ CONFIRMED · ${deduped.filter(p => p.newOrIncreasedCount > 0).length} actively loading`)
  return deduped
}
