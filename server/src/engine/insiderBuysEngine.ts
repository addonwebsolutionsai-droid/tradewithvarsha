/**
 * INSIDER BUYS ENGINE — surfaces stocks where promoters / KMP / external
 * SAST acquirers are buying with conviction. Combines the raw insider
 * filing data with technical + shareholding context so the output is
 * actionable, not just informational.
 *
 * Score 0-100:
 *   30  Insider net-buy magnitude (₹Cr promoter + KMP + acquirer)
 *   20  Pure promoter buy (most bullish signal class)
 *   15  External SAST acquirer (someone crossing 5%/10% threshold)
 *   10  Bottoming setup (RSI 30-55, no further breakdown)
 *   10  Pedigree (NIFTY-500 member, mcap ≥ ₹500 Cr)
 *   10  Low pledge (<5%)
 *    5  Recent (last 7 days = freshest signal)
 *
 * Output: top 50 rows sorted by composite score.
 */
import fs from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import { getCandles } from '../data'
import { getShareholding } from '../data/shareholding'
import { fetchPitFilings, fetchSastFilings, aggregateInsiderFootprint } from '../data/nseInsiderFilings'
import type { SymbolInsiderFootprint } from '../data/nseInsiderFilings'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

export interface InsiderBuyRow {
  symbol: string
  signal: SymbolInsiderFootprint['signal']
  close: number
  marketCapCr: number | null
  isNifty500: boolean
  // Insider footprint
  promoterNetBuyCr: number
  kmpNetBuyCr: number
  externalAcquirerBuyCr: number
  totalNetBuyCr: number
  filingCount: number
  topActors: string[]
  mostRecentDate: string
  // Technical context
  rsi14: number
  pctOffHigh52w: number
  ret20dPct: number
  // Shareholding
  fiiDeltaQoQ: number | null
  diiDeltaQoQ: number | null
  promoterPledgePct: number | null
  // Score
  score: number
  reasons: string[]
}

function rsi14(closes: number[]): number {
  if (closes.length < 15) return 50
  let g = 0, l = 0
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) g += d; else l -= d
  }
  if (l === 0) return 100
  return 100 - 100 / (1 + g / l)
}

export async function runInsiderBuysScan(opts?: { windowDays?: number; topN?: number }): Promise<InsiderBuyRow[]> {
  const windowDays = opts?.windowDays ?? 30
  const topN = opts?.topN ?? 50

  log.info('INSIDER-BUYS', `Fetching PIT + SAST filings for last ${windowDays}d...`)
  const [pit, sast] = await Promise.all([fetchPitFilings(windowDays), fetchSastFilings(windowDays)])
  const allFilings = [...pit, ...sast]
  if (allFilings.length === 0) {
    log.warn('INSIDER-BUYS', 'No filings returned (NSE rate-limited or no recent activity)')
    return []
  }

  const footprints = aggregateInsiderFootprint(allFilings, windowDays)
    .filter(f => f.signal === 'STRONG_INSIDER_BUY' || f.signal === 'INSIDER_BUY')
    .slice(0, topN * 2)        // over-fetch, then technical-enrich top 100

  log.info('INSIDER-BUYS', `${footprints.length} candidate symbols with insider buying — enriching technicals + shareholding`)

  const rows: InsiderBuyRow[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < footprints.length) {
      const fp = footprints[cursor++]
      try {
        const candles = await getCandles(fp.symbol, '1D' as any, 252)
        if (!candles || candles.length < 30) continue
        const last = candles[candles.length - 1]
        const closes = candles.map(c => c.close)
        const rsi = rsi14(closes)
        const ref20 = candles[candles.length - 21]?.close ?? last.close
        const ret20d = ((last.close - ref20) / ref20) * 100
        const high52w = Math.max(...candles.slice(-252).map(c => c.high))
        const pctOffHigh = ((high52w - last.close) / high52w) * 100

        // Shareholding (best-effort)
        const shp = await getShareholding(fp.symbol).catch(() => null)

        // — Score —
        let score = 0
        const reasons: string[] = []
        // 30: net-buy magnitude
        const netBuyCr = fp.totalNetBuyLakhs / 100
        if (netBuyCr >= 50) score += 30
        else if (netBuyCr >= 20) score += 25
        else if (netBuyCr >= 10) score += 18
        else if (netBuyCr >= 5) score += 12
        else if (netBuyCr >= 2) score += 6
        // 20: pure promoter buy
        const promoterNetCr = (fp.promoterBuyValueLakhs - fp.promoterSellValueLakhs) / 100
        if (promoterNetCr >= 20) score += 20
        else if (promoterNetCr >= 10) score += 15
        else if (promoterNetCr >= 5) score += 10
        else if (promoterNetCr >= 1) score += 5
        // 15: external SAST acquirer
        const acquirerCr = fp.externalAcquirerBuyLakhs / 100
        if (acquirerCr >= 50) score += 15
        else if (acquirerCr >= 20) score += 12
        else if (acquirerCr >= 5) score += 8
        // 10: bottoming setup
        if (rsi >= 30 && rsi <= 55 && pctOffHigh >= 15) score += 10
        else if (rsi >= 30 && rsi <= 60) score += 5
        // 10: pedigree (mcap + index)
        const isNifty500 = await (async () => {
          try {
            const { NIFTY_500_CORE } = await import('../screeners/universe')
            return NIFTY_500_CORE.includes(fp.symbol.toUpperCase())
          } catch { return false }
        })()
        if (isNifty500 || (shp?.marketCapCr ?? 0) >= 1000) score += 10
        else if ((shp?.marketCapCr ?? 0) >= 500) score += 6
        // 10: low pledge
        const pledge = shp?.promoterPledgePct ?? 0
        if (pledge < 1) score += 10
        else if (pledge < 5) score += 6
        else if (pledge < 10) score += 3
        else if (pledge >= 25) score -= 10           // penalty for heavy pledge
        // 5: recent (last 7d)
        const mostRecent = allFilings
          .filter(f => f.symbol === fp.symbol)
          .reduce((mx, f) => f.filingDate > mx ? f.filingDate : mx, '0000')
        const daysOld = (Date.now() - new Date(mostRecent).getTime()) / 86400_000
        if (daysOld <= 7) score += 5
        else if (daysOld <= 14) score += 2

        // Reason building
        if (promoterNetCr > 0) reasons.push(`promoter +₹${promoterNetCr.toFixed(1)}Cr net`)
        if (acquirerCr > 0) reasons.push(`SAST acquirer ₹${acquirerCr.toFixed(1)}Cr`)
        if (rsi >= 30 && rsi <= 55) reasons.push(`bottoming RSI ${rsi.toFixed(0)}`)
        if (pctOffHigh >= 30) reasons.push(`${pctOffHigh.toFixed(0)}% off 52w-hi`)
        reasons.push(...fp.reasoning)
        reasons.push(`${fp.filingCount} filings · ${daysOld.toFixed(0)}d old`)

        rows.push({
          symbol: fp.symbol,
          signal: fp.signal,
          close: +last.close.toFixed(2),
          marketCapCr: shp?.marketCapCr ?? null,
          isNifty500,
          promoterNetBuyCr: +promoterNetCr.toFixed(2),
          kmpNetBuyCr: +((fp.kmpBuyValueLakhs - fp.kmpSellValueLakhs) / 100).toFixed(2),
          externalAcquirerBuyCr: +acquirerCr.toFixed(2),
          totalNetBuyCr: +netBuyCr.toFixed(2),
          filingCount: fp.filingCount,
          topActors: fp.topActors,
          mostRecentDate: mostRecent,
          rsi14: +rsi.toFixed(1),
          pctOffHigh52w: +pctOffHigh.toFixed(1),
          ret20dPct: +ret20d.toFixed(2),
          fiiDeltaQoQ: shp?.fiiDeltaQoQ ?? null,
          diiDeltaQoQ: shp?.diiDeltaQoQ ?? null,
          promoterPledgePct: shp?.promoterPledgePct ?? null,
          score,
          reasons,
        })
      } catch { /* skip per-symbol error */ }
    }
  }))

  rows.sort((a, b) => b.score - a.score)
  const top = rows.slice(0, topN)
  log.ok('INSIDER-BUYS', `Found ${rows.length} candidates · top ${top.length} kept`)
  return top
}

export async function runAndPublishInsiderBuys(): Promise<{ generatedAt: string; total: number; strongCount: number; rows: InsiderBuyRow[] }> {
  const rows = await runInsiderBuysScan()
  const strongCount = rows.filter(r => r.signal === 'STRONG_INSIDER_BUY').length
  const out = {
    generatedAt: new Date().toISOString(),
    criterion: 'SEBI PIT (Reg 7) + SAST (Reg 29) filings · last 30d · classified by actor type (promoter / KMP / external) and direction',
    total: rows.length,
    strongCount,
    rows,
  }
  await fs.mkdir(SNAP_DIR, { recursive: true })
  await fs.writeFile(path.join(SNAP_DIR, 'insider-buys.json'), JSON.stringify(out, null, 2))
  log.ok('INSIDER-BUYS', `Published: ${rows.length} candidates (${strongCount} STRONG)`)
  return out
}
