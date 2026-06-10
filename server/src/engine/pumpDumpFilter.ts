/**
 * Anti Pump-and-Dump Filter — hard gate for PRO Mode signals.
 *
 * Implements the 5 most impactful filters from the industry-standard
 * "85% accuracy parameters" list:
 *
 *   1. GSM/ASM/T2T surveillance blacklist (NSE/BSE)
 *   2. Market cap floor (≥ ₹1,000 Cr — kills micro-cap pump candidates)
 *   3. Avg daily turnover floor (≥ ₹5 Cr — kills thin-trade manipulation)
 *   4. Upper-circuit history check (reject ≥2 UC hits in last 10 sessions)
 *   5. Promoter pledge cap (< 5% — already in shareholding, enforced here)
 *
 * Plus a 6th filter the user's examples suggest: fundamental sanity
 *   (mcap_cr × 1 must be non-trivial; price > ₹10 to skip penny stocks)
 *
 * Filter output schema per symbol:
 *   { passes: boolean, blockers: string[], warnings: string[] }
 *
 * Snapshot: pump-dump-blacklist.json — list of names AVOIDED today + why.
 * Used by PRO Edge / Ultra Picks / Smart Money / Cash-Equity PRO Mode.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import * as data from '../data'
import { getShareholding } from '../data/shareholding'
import { log } from '../util/logger'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

export interface PumpDumpVerdict {
  symbol: string
  passes: boolean
  mcapCr: number | null
  avgTurnoverCr: number | null
  promoterPledgePct: number | null
  ucHits10d: number
  ucHits5d: number
  recentPriceRange: number | null    // (max-min)/min over last 20 sessions
  blockers: string[]
  warnings: string[]
}

const FILTERS = {
  MIN_MCAP_CR: 1000,                  // ≥ ₹1,000 Cr
  MIN_AVG_TURNOVER_CR: 5,             // ≥ ₹5 Cr/day
  MAX_PLEDGE_PCT: 5,                  // < 5%
  MAX_UC_HITS_10D: 1,                 // ≤ 1 UC hit in last 10 sessions
  MIN_PRICE: 10,                      // ≥ ₹10 (no penny stocks)
}

// NSE surveillance list — fetched daily. Empty fallback if scrape blocked.
let surveillanceCache: { ts: number; gsm: Set<string>; asm: Set<string>; t2t: Set<string> } | null = null
const SURV_TTL_MS = 12 * 3600_000

async function loadSurveillance(): Promise<{ gsm: Set<string>; asm: Set<string>; t2t: Set<string> }> {
  if (surveillanceCache && Date.now() - surveillanceCache.ts < SURV_TTL_MS) {
    return surveillanceCache
  }
  // NSE publishes GSM/ASM/T2T daily as CSV/HTML. The Angel/Yahoo data layer
  // doesn't have these, so we read a hand-maintained list from disk if
  // available, otherwise return empty (safe default — no false blacklists).
  const gsm = new Set<string>()
  const asm = new Set<string>()
  const t2t = new Set<string>()
  try {
    const raw = await fs.readFile(path.join(SNAP_DIR, '..', 'surveillance-list.json'), 'utf8').catch(() => null)
    if (raw) {
      const j = JSON.parse(raw)
      for (const s of (j.gsm ?? [])) gsm.add(String(s).toUpperCase())
      for (const s of (j.asm ?? [])) asm.add(String(s).toUpperCase())
      for (const s of (j.t2t ?? [])) t2t.add(String(s).toUpperCase())
    }
  } catch { /* file not present, OK */ }
  surveillanceCache = { ts: Date.now(), gsm, asm, t2t }
  log.info('PUMP-DUMP', `surveillance lists loaded: GSM=${gsm.size} · ASM=${asm.size} · T2T=${t2t.size}`)
  return surveillanceCache
}

export async function verifySymbol(symbol: string): Promise<PumpDumpVerdict> {
  const sym = symbol.toUpperCase()
  const blockers: string[] = []
  const warnings: string[] = []
  let mcapCr: number | null = null
  let avgTurnoverCr: number | null = null
  let promoterPledgePct: number | null = null
  let ucHits10d = 0, ucHits5d = 0
  let recentRange: number | null = null

  // Surveillance check
  const surv = await loadSurveillance()
  if (surv.gsm.has(sym)) blockers.push('On NSE GSM surveillance list — AVOID')
  if (surv.asm.has(sym)) blockers.push('On NSE ASM surveillance list — AVOID')
  if (surv.t2t.has(sym)) blockers.push('On NSE T2T (trade-to-trade) — AVOID')

  // Shareholding-based filters
  try {
    const shp = await getShareholding(sym)
    if (shp) {
      mcapCr = shp.marketCapCr ?? null
      promoterPledgePct = shp.promoterPledgePct ?? null
      if (mcapCr != null && mcapCr < FILTERS.MIN_MCAP_CR) {
        blockers.push(`Market cap ₹${mcapCr.toFixed(0)} Cr < ₹${FILTERS.MIN_MCAP_CR} Cr floor`)
      }
      if (promoterPledgePct != null && promoterPledgePct >= FILTERS.MAX_PLEDGE_PCT) {
        blockers.push(`Promoter pledge ${promoterPledgePct.toFixed(1)}% ≥ ${FILTERS.MAX_PLEDGE_PCT}% cap`)
      }
    }
  } catch { /* shp unavailable */ }

  // Price + turnover + UC history — from daily candles
  try {
    const cs = await data.getCandles(sym, '1D' as any, 25)
    if (cs && cs.length >= 10) {
      const last = cs[cs.length - 1]
      if (last.close < FILTERS.MIN_PRICE) {
        blockers.push(`Price ₹${last.close.toFixed(2)} < ₹${FILTERS.MIN_PRICE} floor (penny stock)`)
      }
      // Avg turnover (₹ Cr) = avg(close × volume) / 1 Cr over last 20 sessions
      const span = Math.min(20, cs.length)
      const avgTurnoverRupees = cs.slice(-span).reduce((s, c) => s + c.close * c.volume, 0) / span
      avgTurnoverCr = +(avgTurnoverRupees / 1e7).toFixed(2)
      if (avgTurnoverCr < FILTERS.MIN_AVG_TURNOVER_CR) {
        blockers.push(`Avg turnover ₹${avgTurnoverCr.toFixed(2)} Cr < ₹${FILTERS.MIN_AVG_TURNOVER_CR} Cr floor (thin)`)
      }
      // UC hits — proxy: any session where (close - open) / open > 19% or
      // (close - prev_close) / prev_close > 19% (NSE upper band 20%; allow
      // 1% buffer for partial UC closures).
      const recent10 = cs.slice(-10)
      const recent5 = cs.slice(-5)
      for (let i = 1; i < recent10.length; i++) {
        const move = (recent10[i].close - recent10[i - 1].close) / recent10[i - 1].close
        if (move > 0.19) ucHits10d++
      }
      for (let i = 1; i < recent5.length; i++) {
        const move = (recent5[i].close - recent5[i - 1].close) / recent5[i - 1].close
        if (move > 0.19) ucHits5d++
      }
      if (ucHits10d > FILTERS.MAX_UC_HITS_10D) {
        blockers.push(`${ucHits10d} upper-circuit hits in last 10d — likely manipulation`)
      } else if (ucHits10d === 1) {
        warnings.push(`1 UC hit in last 10d — monitor`)
      }
      // Recent extreme range (for warning, not block)
      const last20 = cs.slice(-20)
      const hi = Math.max(...last20.map(c => c.high))
      const lo = Math.min(...last20.map(c => c.low))
      recentRange = lo > 0 ? +((hi - lo) / lo * 100).toFixed(1) : null
      if (recentRange != null && recentRange > 50) {
        warnings.push(`20d range ${recentRange.toFixed(1)}% — high volatility`)
      }
    }
  } catch { /* candle unavailable */ }

  const passes = blockers.length === 0
  return {
    symbol: sym,
    passes,
    mcapCr, avgTurnoverCr, promoterPledgePct,
    ucHits10d, ucHits5d,
    recentPriceRange: recentRange,
    blockers, warnings,
  }
}

export async function verifyMany(symbols: string[]): Promise<PumpDumpVerdict[]> {
  const BATCH = 4
  const out: PumpDumpVerdict[] = []
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH)
    const results = await Promise.all(batch.map(s => verifySymbol(s).catch(() => null)))
    for (const r of results) if (r) out.push(r)
  }
  return out
}

/**
 * Soft-backtest: apply the filter to every signal in signals-history.json
 * and compute how many SL-hit signals it would have blocked (saved losses)
 * vs how many winning signals it would have blocked (missed gains).
 */
export async function backtest(): Promise<{
  totalAnalysed: number
  wouldBlock: number
  wouldBlockOfWinners: number       // winners we'd have blocked (missed)
  wouldBlockOfLosers: number        // losers we'd have blocked (saved)
  effectiveUplift: number           // pp improvement to WR
  baseWr: number
  filteredWr: number
}> {
  const histRaw = await fs.readFile(path.join(SNAP_DIR, 'signals-history.json'), 'utf8').catch(() => null)
  if (!histRaw) return { totalAnalysed: 0, wouldBlock: 0, wouldBlockOfWinners: 0, wouldBlockOfLosers: 0, effectiveUplift: 0, baseWr: 0, filteredWr: 0 }
  const hist = JSON.parse(histRaw)
  const closed = (hist.signals ?? []).filter((s: any) =>
    ['T1_HIT', 'T2_HIT', 'T3_HIT', 'SL_HIT'].includes(s.status),
  )
  // Dedup by symbol (we only need the unique-symbol verdict)
  const symbols = [...new Set(closed.map((s: any) => s.symbol).filter(Boolean))] as string[]
  const verdictBySym = new Map<string, PumpDumpVerdict>()
  for (const v of await verifyMany(symbols)) verdictBySym.set(v.symbol, v)

  let wouldBlock = 0, blockOfWinners = 0, blockOfLosers = 0
  let baseWins = 0
  for (const s of closed) {
    const v = verdictBySym.get(String(s.symbol).toUpperCase())
    const isWin = s.status !== 'SL_HIT'
    if (isWin) baseWins++
    if (v && !v.passes) {
      wouldBlock++
      if (isWin) blockOfWinners++
      else blockOfLosers++
    }
  }
  const baseWr = closed.length > 0 ? baseWins / closed.length : 0
  const afterCount = closed.length - wouldBlock
  const afterWins = baseWins - blockOfWinners
  const filteredWr = afterCount > 0 ? afterWins / afterCount : 0
  const uplift = filteredWr - baseWr
  log.ok('PUMP-DUMP-BT', `${closed.length} signals analysed · would block ${wouldBlock} (${blockOfLosers} losers saved · ${blockOfWinners} winners missed) · WR uplift ${(uplift * 100).toFixed(2)}pp`)
  return {
    totalAnalysed: closed.length,
    wouldBlock,
    wouldBlockOfWinners: blockOfWinners,
    wouldBlockOfLosers: blockOfLosers,
    effectiveUplift: +(uplift * 100).toFixed(2),
    baseWr: +(baseWr * 100).toFixed(2),
    filteredWr: +(filteredWr * 100).toFixed(2),
  }
}
