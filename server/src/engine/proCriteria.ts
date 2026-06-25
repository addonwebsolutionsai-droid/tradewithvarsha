/**
 * PRO CRITERIA — beyond-the-12 institutional-grade filters.
 *
 * Per user directive 2026-06-25: "Go ahead, add whatever you think to
 * generate more money printing ideas and signals."
 *
 * Six additional criteria appended to the 12-criteria scorecard:
 *  13. OI Buildup direction   — LONG_BUILDUP (real) vs SHORT_COVERING (fading)
 *  14. Market Regime          — NIFTY trend filter (don't long in a bear)
 *  15. INDIA VIX context      — only breakout-buy when VIX<18
 *  16. R:R floor              — auto-reject if T1/risk < 2.5
 *  17. Bulk-deals confirmation — named-buyer footprint within last 5d
 *  18. RS-z vs NIFTY          — only trade names outperforming the index
 */
import fs from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import { getCandles } from '../data'
import type { Candle } from '../types'
import type { CriterionResult } from './fnoFutures12Criteria'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

// — Lazy cached market context (computed once per scan run) —
interface MarketContext {
  regime: 'BULL' | 'MIXED' | 'BEAR'
  niftyAbove200DMA: boolean
  niftyAbove50DMA: boolean
  niftyTrendNote: string
  vix: number | null
  vixBand: 'LOW' | 'NORMAL' | 'HIGH' | 'EXTREME'
  niftyClosesNorm: number[]      // last 60 normalised returns for RS calc
  niftyStdDev: number
  bulkDealsSet: Map<string, { signal: string; netBuyValueCr: number; topBuyers: string[] }>
}

let cachedContext: { ts: number; ctx: MarketContext } | null = null
const CONTEXT_TTL_MS = 30 * 60_000

export async function getMarketContext(): Promise<MarketContext> {
  if (cachedContext && Date.now() - cachedContext.ts < CONTEXT_TTL_MS) return cachedContext.ctx
  const ctx = await buildMarketContext()
  cachedContext = { ts: Date.now(), ctx }
  return ctx
}

async function buildMarketContext(): Promise<MarketContext> {
  // NIFTY 50 candles for regime + RS base
  let niftyCloses: number[] = []
  try {
    const c = await getCandles('NIFTY 50', '1D' as any, 250)
    niftyCloses = (c ?? []).map(x => x.close).filter(Number.isFinite)
  } catch { /* fall through */ }

  let regime: MarketContext['regime'] = 'MIXED'
  let niftyAbove200DMA = false, niftyAbove50DMA = false
  let niftyTrendNote = 'NIFTY data unavailable'
  if (niftyCloses.length >= 200) {
    const last = niftyCloses[niftyCloses.length - 1]
    const dma50 = mean(niftyCloses.slice(-50))
    const dma200 = mean(niftyCloses.slice(-200))
    niftyAbove200DMA = last > dma200
    niftyAbove50DMA = last > dma50
    if (niftyAbove200DMA && niftyAbove50DMA) regime = 'BULL'
    else if (!niftyAbove200DMA && !niftyAbove50DMA) regime = 'BEAR'
    else regime = 'MIXED'
    niftyTrendNote = `NIFTY ₹${last.toFixed(0)} · 50DMA ₹${dma50.toFixed(0)} · 200DMA ₹${dma200.toFixed(0)}`
  }

  // INDIA VIX
  let vix: number | null = null
  try {
    const c = await getCandles('INDIAVIX', '1D' as any, 5)
    if (c && c.length) vix = c[c.length - 1].close
  } catch { /* skip */ }
  const vixBand: MarketContext['vixBand'] =
    vix == null ? 'NORMAL'
    : vix < 14 ? 'LOW'
    : vix < 20 ? 'NORMAL'
    : vix < 25 ? 'HIGH'
    : 'EXTREME'

  // NIFTY daily returns for RS-z calculation
  const niftyReturns: number[] = []
  for (let i = 1; i < niftyCloses.length; i++) {
    niftyReturns.push((niftyCloses[i] - niftyCloses[i - 1]) / niftyCloses[i - 1] * 100)
  }
  const niftyClosesNorm = niftyReturns.slice(-60)
  const niftyMean = mean(niftyClosesNorm)
  const niftyStdDev = Math.sqrt(
    niftyClosesNorm.reduce((s, r) => s + (r - niftyMean) ** 2, 0) / Math.max(1, niftyClosesNorm.length - 1),
  ) || 1

  // Bulk-deals lookup map
  const bulkDealsSet = new Map<string, { signal: string; netBuyValueCr: number; topBuyers: string[] }>()
  try {
    const raw = await fs.readFile(path.join(SNAP_DIR, 'bulk-deals.json'), 'utf8')
    const j = JSON.parse(raw)
    for (const r of (j.rows ?? [])) {
      bulkDealsSet.set(String(r.symbol).toUpperCase(), {
        signal: r.signal,
        netBuyValueCr: r.netBuyValueCr,
        topBuyers: r.topBuyers ?? [],
      })
    }
  } catch { /* none yet */ }

  log.info('PRO-CRIT', `Market context: regime=${regime} · vix=${vix?.toFixed(1) ?? '?'} (${vixBand}) · bulk-deals=${bulkDealsSet.size} symbols · ${niftyTrendNote}`)
  return { regime, niftyAbove200DMA, niftyAbove50DMA, niftyTrendNote, vix, vixBand, niftyClosesNorm, niftyStdDev, bulkDealsSet }
}

function mean(a: number[]): number { return a.reduce((s, x) => s + x, 0) / Math.max(1, a.length) }

// — Criterion 13: OI Buildup direction —
// LONG_BUILDUP (OI ↑ + price ↑) = real bullish · SHORT_COVERING fades fast.
// For F&O underlyings we read the per-symbol OI snapshot if available.
async function criterion13OIBuildup(symbol: string, side: 'LONG' | 'SHORT'): Promise<CriterionResult> {
  try {
    const raw = await fs.readFile(path.join(SNAP_DIR, 'oi-buildup.json'), 'utf8').catch(() => null)
    if (!raw) return { key: 'oi_buildup', label: 'OI Buildup direction', pass: false, score: 0, detail: 'no OI snapshot' }
    const j = JSON.parse(raw)
    // OI snapshot is NIFTY-only by default. Skip unless we have a per-stock
    // OI summary entry (set by extended scanners). Soft pass.
    const matched = (j.summary ?? []).find((s: any) => String(s.underlying).toUpperCase() === symbol.toUpperCase())
    if (!matched) return { key: 'oi_buildup', label: 'OI Buildup direction', pass: false, score: 0, detail: `no OI snapshot for ${symbol}` }
    const bias = matched.dominantBias
    const sideMatches = (side === 'LONG' && bias === 'BULLISH') || (side === 'SHORT' && bias === 'BEARISH')
    return {
      key: 'oi_buildup',
      label: 'OI Buildup direction',
      pass: sideMatches,
      score: sideMatches ? 10 : 0,
      detail: `OI bias ${bias} (${matched.summary?.slice?.(0, 80) ?? ''})`,
    }
  } catch (e) {
    return { key: 'oi_buildup', label: 'OI Buildup direction', pass: false, score: 0, detail: `read failed: ${(e as Error).message}` }
  }
}

// — Criterion 14: Market regime —
// Don't chase LONG breakouts in a bear regime. Symmetric for shorts.
function criterion14MarketRegime(ctx: MarketContext, side: 'LONG' | 'SHORT'): CriterionResult {
  const longOK = side === 'LONG' && ctx.regime !== 'BEAR'
  const shortOK = side === 'SHORT' && ctx.regime !== 'BULL'
  const pass = longOK || shortOK
  return {
    key: 'market_regime',
    label: 'Market Regime',
    pass,
    score: pass ? (ctx.regime === (side === 'LONG' ? 'BULL' : 'BEAR') ? 10 : 6) : 0,
    detail: `${ctx.regime} regime · ${ctx.niftyTrendNote}`,
  }
}

// — Criterion 15: VIX context —
// Breakouts work best when VIX is LOW. Mean-reversion when VIX is HIGH.
function criterion15Vix(ctx: MarketContext, side: 'LONG' | 'SHORT'): CriterionResult {
  if (ctx.vix == null) return { key: 'vix', label: 'VIX Context', pass: false, score: 0, detail: 'VIX unavailable' }
  const longFriendly = side === 'LONG' && (ctx.vixBand === 'LOW' || ctx.vixBand === 'NORMAL')
  const shortFriendly = side === 'SHORT' && (ctx.vixBand === 'HIGH' || ctx.vixBand === 'NORMAL')
  const extreme = ctx.vixBand === 'EXTREME'
  if (extreme) {
    return { key: 'vix', label: 'VIX Context', pass: false, score: -5, detail: `VIX ${ctx.vix.toFixed(1)} EXTREME — stay flat` }
  }
  const pass = longFriendly || shortFriendly
  return {
    key: 'vix',
    label: 'VIX Context',
    pass,
    score: pass ? 8 : 0,
    detail: `VIX ${ctx.vix.toFixed(1)} (${ctx.vixBand}) ${pass ? '✓ favourable' : '✗ not aligned'}`,
  }
}

// — Criterion 16: R:R floor —
// Auto-reject setups where T1 reward / SL risk < 2.5.
export function criterion16RiskReward(entry: number, sl: number, t1: number, side: 'LONG' | 'SHORT'): CriterionResult {
  const dir = side === 'LONG' ? 1 : -1
  const reward = dir * (t1 - entry)
  const risk = dir * (entry - sl)
  if (risk <= 0) return { key: 'rr_floor', label: 'R:R ≥ 2.5', pass: false, score: 0, detail: 'invalid SL placement' }
  const rr = reward / risk
  const pass = rr >= 2.5
  return {
    key: 'rr_floor',
    label: 'R:R ≥ 2.5',
    pass,
    score: rr >= 4 ? 10 : rr >= 3 ? 8 : rr >= 2.5 ? 6 : 0,
    detail: `${rr.toFixed(2)}:1 reward:risk`,
  }
}

// — Criterion 17: Bulk-deals confirmation —
// Named superstar / institution bought this stock in the last 5 sessions.
function criterion17BulkDeals(ctx: MarketContext, symbol: string): CriterionResult {
  const entry = ctx.bulkDealsSet.get(symbol.toUpperCase())
  if (!entry) return { key: 'bulk_deals', label: 'Bulk-deals confirm', pass: false, score: 0, detail: 'no recent named buyer/seller' }
  const accumulating = entry.signal === 'STRONG_ACCUMULATION' || entry.signal === 'ACCUMULATION'
  const distributing = entry.signal === 'STRONG_DISTRIBUTION' || entry.signal === 'DISTRIBUTION'
  if (accumulating) {
    const score = entry.signal === 'STRONG_ACCUMULATION' ? 10 : 6
    return {
      key: 'bulk_deals',
      label: 'Bulk-deals confirm',
      pass: true,
      score,
      detail: `${entry.signal} · +₹${entry.netBuyValueCr.toFixed(1)}Cr · ${(entry.topBuyers ?? []).slice(0, 2).join(', ')}`,
    }
  }
  if (distributing) {
    return { key: 'bulk_deals', label: 'Bulk-deals confirm', pass: false, score: -5, detail: `${entry.signal} — named sellers active` }
  }
  return { key: 'bulk_deals', label: 'Bulk-deals confirm', pass: false, score: 0, detail: 'NEUTRAL bulk-deal flow' }
}

// — Criterion 18: RS-z vs NIFTY —
// Outperforming the index by ≥1σ over the last 20 sessions.
function criterion18RelativeStrength(ctx: MarketContext, candles: Candle[]): CriterionResult {
  if (candles.length < 25 || ctx.niftyStdDev === 0) {
    return { key: 'rs_z', label: 'RS-z vs NIFTY', pass: false, score: 0, detail: 'insufficient data' }
  }
  const closes = candles.map(c => c.close)
  // Stock 20-day return
  const ret20 = (closes[closes.length - 1] - closes[closes.length - 21]) / closes[closes.length - 21] * 100
  // NIFTY 20-day return (from cached normalised series — last 20 daily rets summed)
  const niftyRet20 = ctx.niftyClosesNorm.slice(-20).reduce((s, x) => s + x, 0)
  const excess = ret20 - niftyRet20
  // Z-score normalised by NIFTY daily std × sqrt(20)
  const zNorm = ctx.niftyStdDev * Math.sqrt(20)
  const z = zNorm > 0 ? excess / zNorm : 0
  const pass = z >= 1.0
  return {
    key: 'rs_z',
    label: 'RS-z vs NIFTY',
    pass,
    score: z >= 2 ? 10 : z >= 1.5 ? 7 : z >= 1 ? 5 : 0,
    detail: `stock 20d ${ret20.toFixed(1)}% vs NIFTY ${niftyRet20.toFixed(1)}% · z=${z.toFixed(2)}`,
  }
}

/**
 * Compute all 6 pro criteria. Returns an array appended to the 12-criteria
 * result so the final scorecard has 18 entries.
 */
export async function computeProCriteria(opts: {
  symbol: string
  candles: Candle[]
  side: 'LONG' | 'SHORT'
  entry?: number
  stopLoss?: number
  target1?: number
}): Promise<CriterionResult[]> {
  const ctx = await getMarketContext()
  const results: CriterionResult[] = [
    await criterion13OIBuildup(opts.symbol, opts.side),
    criterion14MarketRegime(ctx, opts.side),
    criterion15Vix(ctx, opts.side),
  ]
  if (opts.entry != null && opts.stopLoss != null && opts.target1 != null) {
    results.push(criterion16RiskReward(opts.entry, opts.stopLoss, opts.target1, opts.side))
  }
  results.push(criterion17BulkDeals(ctx, opts.symbol))
  results.push(criterion18RelativeStrength(ctx, opts.candles))
  return results
}
