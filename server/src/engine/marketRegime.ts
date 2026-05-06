/**
 * Market regime classifier — implements the GO / NO-GO checklist from
 * `screener.md` PART 7. Used to gate Pro Screener output: in BEAR regime we
 * surface watchlist only; in MIXED we cap to Tier-1 & Tier-2; in BULL we
 * release everything.
 */

import * as data from '../data'
import { ema } from '../indicators'
import { log } from '../util/logger'

export type Regime = 'BULL' | 'MIXED' | 'BEAR'

export interface RegimeReading {
  regime: Regime
  greenCount: number       // 0–6
  checklist: { name: string; ok: boolean; note: string }[]
  niftyAbove200ema: boolean
  niftyAbove50ema: boolean
  vix: number | null
  asOf: string
  recommendation: string
}

let cachedReading: { reading: RegimeReading; ts: number } | null = null
const TTL_MS = 5 * 60_000

export async function getMarketRegime(): Promise<RegimeReading> {
  if (cachedReading && Date.now() - cachedReading.ts < TTL_MS) {
    return cachedReading.reading
  }

  const checklist: { name: string; ok: boolean; note: string }[] = []

  // 1+2: Nifty vs 200/50 EMA
  let niftyAbove200ema = false
  let niftyAbove50ema = false
  try {
    const nifty = await data.getCandles('NIFTY', '1D', 250)
    if (nifty.length >= 200) {
      const e200 = ema(nifty, 200)
      const e50 = ema(nifty, 50)
      const last = nifty[nifty.length - 1].close
      const lastE200 = e200[e200.length - 1]
      const lastE50 = e50[e50.length - 1]
      niftyAbove200ema = last > lastE200
      niftyAbove50ema = last > lastE50
      checklist.push({ name: 'Nifty > 200-EMA', ok: niftyAbove200ema, note: `${last.toFixed(0)} vs ${lastE200.toFixed(0)}` })
      checklist.push({ name: 'Nifty > 50-EMA',  ok: niftyAbove50ema,  note: `${last.toFixed(0)} vs ${lastE50.toFixed(0)}` })
    }
  } catch (e) { log.warn('REGIME', `nifty fetch: ${(e as Error).message}`) }

  // 3+4: India VIX
  let vix: number | null = null
  try {
    const vixQ = await data.getQuote('INDIAVIX')
    if (vixQ) vix = vixQ.price
    if (vix != null) {
      checklist.push({ name: 'VIX < 16',  ok: vix < 16, note: `${vix.toFixed(2)}` })
      checklist.push({ name: 'VIX < 20',  ok: vix < 20, note: vix > 20 ? 'NO-GO for new swings' : 'OK' })
    }
  } catch (e) { log.warn('REGIME', `vix fetch: ${(e as Error).message}`) }

  // 5: A/D ratio (proxy from indices — full A/D needs broad-market scan)
  // We approximate with: are 4 of 5 sector indices green today?
  try {
    const indices = await data.getMarketIndices()
    const sectorish = indices.filter(i => i.symbol !== 'NIFTY 50' && i.symbol !== 'INDIA VIX')
    const greens = sectorish.filter(i => i.changePct > 0).length
    const total = sectorish.length || 1
    const ratio = greens / total
    checklist.push({
      name: 'Breadth (sector greens)',
      ok: ratio >= 0.6,
      note: `${greens}/${total} sectors up`,
    })
  } catch (e) { log.warn('REGIME', `breadth fetch: ${(e as Error).message}`) }

  // Note: FII flows + SGX Nifty pre-market are not wired — we surface 5 of 7
  // checks instead of all 7 and scale the regime thresholds accordingly.
  const greenCount = checklist.filter(c => c.ok).length
  const total = checklist.length || 1
  const greenRatio = greenCount / total

  let regime: Regime
  let recommendation: string
  if (greenRatio >= 0.8) {
    regime = 'BULL'
    recommendation = 'Run all queries · full position size · Tier 1 + 2 + 3 visible'
  } else if (greenRatio >= 0.5) {
    regime = 'MIXED'
    recommendation = 'Run Tier-1 + Tier-2 only · reduce size 30 %'
  } else {
    regime = 'BEAR'
    recommendation = 'No new entries · manage existing only · watchlist mode'
  }

  const reading: RegimeReading = {
    regime,
    greenCount,
    checklist,
    niftyAbove200ema,
    niftyAbove50ema,
    vix,
    asOf: new Date().toISOString(),
    recommendation,
  }
  cachedReading = { reading, ts: Date.now() }
  return reading
}
