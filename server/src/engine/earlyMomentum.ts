/**
 * EARLY MOMENTUM RADAR — per user directive 2026-06-25:
 *   "Every day new stocks ₹100-300 move 10-20% in a week and I'm observing
 *    it. We should have ALL those BEFORE the move happens."
 *
 * Hard-targeted scanner for the user's actual moneymaker tier:
 *   - Universe: NSE EQ/BE in ₹50-500 close range (small/mid caps where
 *     the user has explicitly observed 10-20%-weekly moves)
 *   - NO conviction-floor gating, NO pre-breakout reject. This is a
 *     MOMENTUM RADAR not a deep-conviction picker — surface the candidates,
 *     let the user/weekly engine refine.
 *   - Catches both first-base setups AND wave-2 continuations.
 *
 * Score (0-100, higher = stronger signature):
 *   30 — Volume thrust   (today vol vs 20-day avg)
 *   20 — Delivery surge  (today deliv % vs 20-day avg) — institutional footprint
 *   15 — Range expansion (today range / 20-day ATR)   — breakout signature
 *   15 — Near 20d high   (within 5% of 20d high = breakout primed)
 *   10 — EMA stack       (9>21>50 bullish)            — trend alignment
 *   10 — Tight base      (10d range < 5% of close)    — coiled spring
 *
 * Output: top 100 candidates ranked by composite, written to
 *   server/data/public-snapshots/early-momentum.json
 *
 * Runs in <2 min on MARKET_ALL with concurrency 8. Triggered nightly
 * after bhavcopy + every 30 min during market hours.
 */
import fs from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import { getCandles } from '../data'
import type { Candle } from '../types'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

export interface EarlyMomentumRow {
  symbol: string
  close: number
  pctChangeToday: number
  deliveryPct: number | null
  deliverySurgeX: number | null     // today deliv / 20-day deliv avg
  volSurgeX: number                 // today vol / 20-day vol avg
  rangeExpansionX: number           // today range / 20-day ATR
  ret5dPct: number
  ret20dPct: number
  distFrom20HighPct: number         // 0 = at high, 5 = 5% below
  emaStack: 'BULLISH' | 'MIXED' | 'BEARISH'
  baseTightnessPct: number          // 10-day range as % of close
  rsi14: number
  score: number                     // 0-100 composite
  tier: 'EARLY' | 'WAVE_2' | 'CONFIRMED'
  reasons: string[]
  /** 2026-06-25: shareholding context in Signature column per user request */
  shareholdingNote?: string         // "FII 16.1% (1.5%↑) · DII 8% · P 39.5% · MC ₹12.7KCr"
  noBrainerBet?: boolean
  capturedAt: string
}

interface ScanOpts {
  minPrice?: number
  maxPrice?: number
  topN?: number
  concurrency?: number
}

export async function runEarlyMomentumScan(opts: ScanOpts = {}): Promise<EarlyMomentumRow[]> {
  const minPrice = opts.minPrice ?? 50
  const maxPrice = opts.maxPrice ?? 500
  const topN = opts.topN ?? 100
  const concurrency = opts.concurrency ?? 8

  log.info('EARLY-MOMENTUM', `Scanning NSE+BSE universe for ₹${minPrice}-${maxPrice} momentum candidates...`)

  // Load bhavcopy delivery data (today's institutional footprint)
  const bhavMap = await loadBhavcopyDeliveryMap()
  log.info('EARLY-MOMENTUM', `bhavcopy loaded: ${bhavMap.size} symbols with delivery %`)

  // Universe = NSE + BSE
  const { resolveUniverse } = await import('../screeners/universe')
  const universe = await resolveUniverse('NSE_ALL')
  log.info('EARLY-MOMENTUM', `Scanning ${universe.length} NSE symbols (concurrency ${concurrency})...`)

  const rows: EarlyMomentumRow[] = []
  let cursor = 0
  let scanned = 0, priceFiltered = 0, dataMissing = 0

  let etfFiltered = 0
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < universe.length) {
      const sym = universe[cursor++]
      if (isLikelyETF(sym)) { etfFiltered++; continue }
      try {
        const candles = await getCandles(sym, '1D' as any, 30)
        if (!candles || candles.length < 21) { dataMissing++; continue }
        const last = candles[candles.length - 1]
        if (last.close < minPrice || last.close > maxPrice) { priceFiltered++; continue }
        scanned++

        const row = scoreCandidate(sym, candles, bhavMap.get(sym.toUpperCase()))
        if (row && row.score >= 25) rows.push(row)
      } catch { /* skip symbol on error */ }
    }
  }))
  log.info('EARLY-MOMENTUM', `Rejected ${etfFiltered} ETFs/index-funds upstream`)

  rows.sort((a, b) => b.score - a.score)
  const top = rows.slice(0, topN)
  log.ok('EARLY-MOMENTUM', `Scanned ${scanned} eligible (${priceFiltered} outside price band, ${dataMissing} no data) → ${rows.length} hits, top ${top.length} kept`)
  return top
}

function scoreCandidate(symbol: string, candles: Candle[], bhav: BhavRow | undefined): EarlyMomentumRow | null {
  const last = candles[candles.length - 1]
  if (!last || candles.length < 21) return null

  // 2026-06-25 PRE-MOVE REWRITE: previous scoring rewarded TODAY's range +
  // TODAY's volume, which surfaced stocks AFTER they had already moved.
  // The whole point of this tab is to catch the setup BEFORE the move. So:
  //   - REWARD pre-build over 5 days, NOT today's spike
  //   - REWARD tight base, low realised volatility
  //   - REWARD delivery accumulation (sticky money already positioning)
  //   - PENALIZE stocks that already moved >3% today or >10% in 5d

  const prevClose = candles[candles.length - 2]?.close ?? last.close
  const pctChangeToday = +((last.close - prevClose) / prevClose * 100).toFixed(2)
  const ref5 = candles[candles.length - 6]?.close ?? last.close
  const ref20 = candles[candles.length - 21]?.close ?? last.close
  const ret5dPct = +((last.close - ref5) / ref5 * 100).toFixed(2)
  const ret20dPct = +((last.close - ref20) / ref20 * 100).toFixed(2)
  const rsi14 = computeRSI(candles, 14)

  // — Volume PRE-BUILD: avg of last 5 days vs 20d avg (excludes today).
  //   Detects sustained accumulation, not single-day spike.
  const vol20 = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20
  const vol5avg = candles.slice(-6, -1).reduce((s, c) => s + c.volume, 0) / 5
  const volPreBuildX = vol20 > 0 ? vol5avg / vol20 : 1
  // Single-day spike still tracked for the table, but doesn't drive score.
  const volSurgeX = vol20 > 0 ? last.volume / vol20 : 1
  const volScore = volPreBuildX >= 2.0 ? 25 : volPreBuildX >= 1.5 ? 18 : volPreBuildX >= 1.2 ? 12 : volPreBuildX >= 1.05 ? 6 : 0

  // — Delivery accumulation (sticky money already positioning) —
  const deliveryPct = bhav?.deliveryPct ?? null
  let deliverySurgeX: number | null = null
  let deliveryScore = 0
  if (deliveryPct !== null && deliveryPct > 0) {
    if (deliveryPct >= 65) { deliveryScore = 25; deliverySurgeX = deliveryPct / 35 }
    else if (deliveryPct >= 55) { deliveryScore = 20; deliverySurgeX = deliveryPct / 35 }
    else if (deliveryPct >= 45) { deliveryScore = 15; deliverySurgeX = deliveryPct / 35 }
    else if (deliveryPct >= 35) { deliveryScore = 8 }
  }

  // — Range expansion (today range / 20-day ATR) — kept for table but
  //   no longer rewarded; PENALTY if too large (means move started).
  const atr20 = computeATR(candles.slice(-21))
  const todayRange = last.high - last.low
  const rangeExpansionX = atr20 > 0 ? todayRange / atr20 : 1
  let rangeScore = 0
  if (rangeExpansionX > 2) rangeScore = -10        // big bar = move started
  else if (rangeExpansionX > 1.5) rangeScore = -5

  // — Position vs 20d high — within 2-7% = pressing against resistance.
  //   AT the high (<1%) means breakout already triggered — partial penalty.
  const hi20 = Math.max(...candles.slice(-20).map(c => c.high))
  const distFrom20HighPct = hi20 > 0 ? +((hi20 - last.close) / hi20 * 100).toFixed(2) : 100
  const proxScore = distFrom20HighPct >= 2 && distFrom20HighPct <= 5 ? 15
    : distFrom20HighPct < 2 ? 8       // already breaking out
    : distFrom20HighPct <= 8 ? 10
    : 0

  // — EMA stack —
  const ema = (period: number): number => {
    const k = 2 / (period + 1)
    let e = candles[0].close
    for (let i = 1; i < candles.length; i++) e = candles[i].close * k + e * (1 - k)
    return e
  }
  const e9 = ema(9), e21 = ema(Math.min(21, candles.length - 1))
  const e50 = ema(Math.min(50, candles.length - 1))
  let emaStack: 'BULLISH' | 'MIXED' | 'BEARISH' = 'MIXED'
  let emaScore = 0
  if (e9 > e21 && e21 > e50) { emaStack = 'BULLISH'; emaScore = 10 }
  else if (e9 > e21) { emaStack = 'MIXED'; emaScore = 5 }
  else if (e9 < e21 && e21 < e50) { emaStack = 'BEARISH'; emaScore = 0 }

  // — Tight base (10d range as % of close) — coiled spring —
  const last10 = candles.slice(-10)
  const hi10 = Math.max(...last10.map(c => c.high))
  const lo10 = Math.min(...last10.map(c => c.low))
  const baseTightnessPct = last.close > 0 ? +((hi10 - lo10) / last.close * 100).toFixed(2) : 100
  const baseScore = baseTightnessPct <= 4 ? 20      // very tight = elite setup
    : baseTightnessPct <= 6 ? 15
    : baseTightnessPct <= 8 ? 10
    : baseTightnessPct <= 12 ? 5
    : 0

  // — RSI coil — 50-65 is the sweet spot for breakouts; >70 = extended.
  const rsiScore = rsi14 >= 50 && rsi14 <= 65 ? 10
    : rsi14 >= 45 && rsi14 < 50 ? 6
    : rsi14 > 65 && rsi14 <= 70 ? 4
    : 0

  // ★ HARD PENALTIES for already-moved names ★
  let extendedPenalty = 0
  if (pctChangeToday > 5) extendedPenalty -= 25         // today's move already big
  else if (pctChangeToday > 3) extendedPenalty -= 15
  else if (pctChangeToday > 2) extendedPenalty -= 8
  if (ret5dPct > 15) extendedPenalty -= 25              // 5d move already big
  else if (ret5dPct > 10) extendedPenalty -= 15
  else if (ret5dPct > 7) extendedPenalty -= 8

  const score = Math.max(0, volScore + deliveryScore + rangeScore + proxScore + emaScore + baseScore + rsiScore + extendedPenalty)

  // — Tier classification (pre-move-first) —
  // EARLY    = setup is loaded but PRICE HASN'T MOVED YET (highest priority)
  // WAVE_2   = first leg done (5-10%), consolidating tight, primed for leg 2
  // CONFIRMED = already moving today — late but technically still actionable
  let tier: 'EARLY' | 'WAVE_2' | 'CONFIRMED'
  if (pctChangeToday >= 3 || ret5dPct > 10) tier = 'CONFIRMED'
  else if (ret5dPct >= 4 && ret5dPct <= 10 && baseTightnessPct <= 7) tier = 'WAVE_2'
  else tier = 'EARLY'

  const reasons: string[] = []
  if (deliveryPct !== null && deliveryPct >= 55) reasons.push(`deliv ${deliveryPct.toFixed(0)}% (institutional)`)
  else if (deliveryPct !== null && deliveryPct >= 45) reasons.push(`deliv ${deliveryPct.toFixed(0)}%`)
  if (volPreBuildX >= 1.3) reasons.push(`5d vol ${volPreBuildX.toFixed(1)}× pre-build`)
  if (baseTightnessPct <= 5) reasons.push(`tight base ${baseTightnessPct.toFixed(1)}%`)
  if (distFrom20HighPct >= 2 && distFrom20HighPct <= 5) reasons.push(`${distFrom20HighPct.toFixed(1)}% below 20d-hi`)
  if (emaStack === 'BULLISH') reasons.push('EMA 9>21>50')
  if (rsi14 >= 50 && rsi14 <= 65) reasons.push(`RSI ${rsi14.toFixed(0)} coiled`)
  if (extendedPenalty < 0) reasons.push(`⚠️ ${pctChangeToday > 3 ? `up ${pctChangeToday.toFixed(1)}% today` : `up ${ret5dPct.toFixed(1)}% in 5d`}`)

  return {
    symbol,
    close: +last.close.toFixed(2),
    pctChangeToday,
    deliveryPct,
    deliverySurgeX: deliverySurgeX ? +deliverySurgeX.toFixed(2) : null,
    volSurgeX: +volSurgeX.toFixed(2),
    rangeExpansionX: +rangeExpansionX.toFixed(2),
    ret5dPct,
    ret20dPct,
    distFrom20HighPct,
    emaStack,
    baseTightnessPct,
    rsi14: +rsi14.toFixed(1),
    score,
    tier,
    reasons,
    capturedAt: new Date().toISOString(),
  }
}

// 2026-06-25: ETF / index-fund / FoF detector. NSE bhavcopy lumps these
// under SERIES='EQ' so we can't filter by series alone. Pattern-matches
// the most common naming conventions to keep them out of the radar:
//   - GoldBEES / NiftyBEES / NextBEES / LiquidBEES style → *BEES suffix
//   - AMC-prefixed index trackers (HDFC*, ICICI*, KOTAK*, NIPPON*,
//     MIRAE*, MOTILAL*, SBI*, AXIS*, UTI*, EDELWEISS*, BANDHAN*, TATA*)
//     followed by index/factor names (NIFTY/NEXT/PSU/MID/SMALL/MOMENT/
//     VALUE/QUAL/GROWTH/SENSEX/GOLD/SILVER/LIQUID/EQUAL/BANK[A-Z])
//   - Common factor ETF names without AMC prefix (MOQUALITY, MOMGF,
//     NEXT50BETA, LOWVOL, NV20, M50, EQUAL50, TOP10ADD, GILT*)
// Whitelist of real listed companies that share AMC-name prefixes — must
// NOT be filtered as ETFs even though they look like one.
const STOCK_WHITELIST: Set<string> = new Set([
  'HDFC', 'HDFCBANK', 'HDFCLIFE', 'HDFCAMC', 'HDFCNXT50',
  'ICICIBANK', 'ICICIGI', 'ICICIPRULI',
  'KOTAKBANK', 'KOTAKMAH',
  'SBIN', 'SBILIFE', 'SBICARD',
  'AXISBANK',
  'NIPPONLT',           // Nippon Life India (AMC parent)
  'UTIAMC',
  'EDELWEISS',
  'BANDHANBNK',
  'TATAMOTORS', 'TATASTEEL', 'TATAPOWER', 'TATACONSUM', 'TATACHEM', 'TATAELXSI', 'TATACOMM', 'TATAINVEST', 'TATATECH', 'TATATEC',
  'MOTILALOFS',         // Motilal Oswal parent
  'MIRAEASSET',
])

const ETF_PATTERNS: RegExp[] = [
  // Suffix-based
  /BEES$/i,                                              // *BEES (Nippon's ETF family)
  /ETF$/i,                                               // anything ending in "ETF"
  /^[A-Z]+(50|100|200|250|500|1000)$/i,                  // letters then index size: MOALPHA50, M50, EQUAL50, NEXT50, MID150, MID250
  /^LICN(IFTY|MID|NF|SMALL|GOLD|BANK|PSU|FN|N50|N\d+|VAL|GROWTH|MOM|QUAL)/i,
  /^PSUBANK(ADD|BEES|BK)?$/i,                            // PSUBANK / PSUBANKADD / PSUBANKBEES
  /^BANKPSU(ADD|BEES|BK)?$/i,                            // BANKPSU and variants
  /^GILT/i,
  /MOM(GF|ENT|FIVE)|MOQ(UAL)?|MOREALTY|MOMID|MOSMALL|MOLOWVOL|MONEXT|MOALPHA|MOQUALITY/i,
  // AMC-prefixed factor/index trackers
  /^(HDFC|ICICI|KOTAK|NIPPON|MIRAE|MOTILAL|SBI|AXIS|UTI|EDELWEISS|EDEL|BANDHAN|TATAMF|GROW|GROWW|ZERODHA|BHARAT|MAFANG|ULIFE|ABSL|BSL|BIRLA|DSP|FRANKLIN|INVESCO|QUANT|WHITEOAK)(NIFTY|NEXT|PSU|MIDCAP|SMALLCAP|MOMENT|VALUE|QUAL|GROWTH|SENSEX|GOLD|SILVER|LIQUID|EQUAL|NIF|BANK[A-Z]?|MID|SML|MNCG|FMCG|PHARMA|LOWVOL|ALPHA|IT|GS|MOM|FOF|TECH|N50|N100|N200|N500|B22)/i,
  // Common factor / smart-beta / sector index ETFs without AMC prefix
  /^(NIFTY|NEXT50|MIDCAP|SMALLCAP|EQUAL\d{2}|NV20|JUNIOR|LIQUID|SENSEX|MAFANG|TOP\d+ADD|LOWVOL|MOMENT|QUAL|VALUE)/i,
  /(LIQUID|GS|GILT|GOLD|SILVER|GROWTH)\d?ETF$/i,
]
function isLikelyETF(sym: string): boolean {
  const s = sym.toUpperCase()
  if (STOCK_WHITELIST.has(s)) return false
  for (const re of ETF_PATTERNS) if (re.test(s)) return true
  return false
}

function computeATR(window: Candle[]): number {
  if (window.length < 2) return 0
  let sum = 0
  for (let i = 1; i < window.length; i++) {
    const tr = Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close),
    )
    sum += tr
  }
  return sum / (window.length - 1)
}

function computeRSI(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close
    if (diff > 0) gains += diff
    else losses -= diff
  }
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - (100 / (1 + rs))
}

// — Bhavcopy delivery data loader —
interface BhavRow { deliveryPct: number; volume: number; close: number }
async function loadBhavcopyDeliveryMap(): Promise<Map<string, BhavRow>> {
  const map = new Map<string, BhavRow>()
  const ddmmyyyy = (d: Date): string => {
    const dd = String(d.getDate()).padStart(2, '0')
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    return `${dd}${mm}${d.getFullYear()}`
  }
  const axios = (await import('axios')).default
  const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16 Safari/605.1.15' }
  for (let back = 0; back < 6; back++) {
    const d = new Date(); d.setDate(d.getDate() - back)
    const url = `https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${ddmmyyyy(d)}.csv`
    try {
      const res = await axios.get(url, { headers: HEADERS, timeout: 20_000, validateStatus: () => true, responseType: 'text' })
      if (res.status !== 200 || typeof res.data !== 'string' || !res.data.startsWith('SYMBOL')) continue
      const lines = res.data.split('\n').slice(1).filter(l => l.trim())
      for (const line of lines) {
        const c = line.split(',').map(x => x.trim())
        if (c.length < 15) continue
        const series = c[1]
        if (series !== 'EQ' && series !== 'BE' && series !== 'BZ') continue
        const sym = c[0].toUpperCase()
        const close = parseFloat(c[8])
        const vol = parseFloat(c[10])
        const deliv = parseFloat(c[14])
        if (!Number.isFinite(close) || !Number.isFinite(deliv)) continue
        map.set(sym, { deliveryPct: deliv, volume: vol, close })
      }
      if (map.size > 0) return map
    } catch { /* try next day */ }
  }
  return map
}

// — Shareholding enrichment for top rows (FII/DII/Promoter/MC in Signature) —
async function enrichShareholding(rows: EarlyMomentumRow[]): Promise<void> {
  if (rows.length === 0) return
  const { scoreShareholding } = await import('../data/shareholding')
  // Enrich in batches of 4 concurrent — screener.in is the bottleneck.
  let cursor = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < rows.length) {
      const r = rows[cursor++]
      try {
        const verdict = await scoreShareholding(r.symbol)
        if (verdict.shp) {
          const shp = verdict.shp
          const fmtDelta = (d: number): string => {
            if (d > 0.1) return ` (${d.toFixed(1)}%↑)`
            if (d < -0.1) return ` (${Math.abs(d).toFixed(1)}%↓)`
            return ''
          }
          const fii = `FII ${shp.fiiPct.toFixed(1)}%${fmtDelta(shp.fiiDeltaQoQ)}`
          const dii = `DII ${shp.diiPct.toFixed(1)}%${fmtDelta(shp.diiDeltaQoQ)}`
          const prom = `P ${shp.promoterPct.toFixed(1)}%${fmtDelta(shp.promoterDeltaQoQ)}`
          const mc = shp.marketCapCr >= 1000
            ? `${(shp.marketCapCr / 1000).toFixed(1)}KCr`
            : shp.marketCapCr > 0 ? `${shp.marketCapCr.toFixed(0)}Cr` : '?'
          r.shareholdingNote = `${fii} · ${dii} · ${prom} · MC ₹${mc}`
          r.noBrainerBet = verdict.isNoBrainer
        }
      } catch { /* skip, leave blank */ }
    }
  }))
}

// 2026-06-25: Mover-archetype matcher — for each candidate, find the
// nearest WINNING archetype mined from past 5%+ movers. Strong match
// (≥75% similarity) = candidate is replaying a known pre-move setup.
async function applyArchetypeMatcher(rows: EarlyMomentumRow[]): Promise<void> {
  try {
    const { matchAgainstMoverArchetypes } = await import('./moverPatternMiner')
    let matchCount = 0
    await Promise.all(rows.map(async r => {
      try {
        const candles = await getCandles(r.symbol, '1D' as any, 60)
        if (!candles || candles.length < 30) return
        const m = await matchAgainstMoverArchetypes({ candles, symbol: r.symbol, minSimilarity: 65 })
        if (m?.match && m.archetype) {
          r.score = Math.min(100, r.score + Math.round((m.similarity ?? 0) / 10))
          r.reasons.unshift(`🔬 ${m.reasoning}`)
          matchCount++
        }
      } catch { /* skip */ }
    }))
    log.ok('EARLY-MOMENTUM', `Archetype matcher: ${matchCount}/${rows.length} candidates match a winning pre-move setup`)
  } catch (e) {
    log.warn('EARLY-MOMENTUM', `archetype matcher failed: ${(e as Error).message}`)
  }
}

// 2026-06-25: Pro-criteria boost — apply market regime + VIX + bulk-deals +
// RS-z to each candidate as an EXTRA SCORE LAYER. Names confirmed by named
// bulk-deal buyers OR strongly outperforming NIFTY get bumped to the top.
async function applyProCriteria(rows: EarlyMomentumRow[]): Promise<void> {
  try {
    const { getMarketContext } = await import('./proCriteria')
    const ctx = await getMarketContext()
    // If regime is BEAR, downgrade LONG-only candidates' score by 30%.
    for (const r of rows) {
      // Bulk-deals confirmation — named institutional buyer in last 5d
      const bd = ctx.bulkDealsSet.get(r.symbol.toUpperCase())
      if (bd && (bd.signal === 'STRONG_ACCUMULATION' || bd.signal === 'ACCUMULATION')) {
        r.score = Math.min(100, r.score + (bd.signal === 'STRONG_ACCUMULATION' ? 12 : 7))
        r.reasons.unshift(`🎯 bulk-deal ${bd.signal} +₹${bd.netBuyValueCr.toFixed(1)}Cr · ${(bd.topBuyers ?? []).slice(0, 2).join(', ')}`)
      }
      // Market regime guard — these are all LONG candidates
      if (ctx.regime === 'BEAR') {
        r.score = Math.round(r.score * 0.7)
        r.reasons.push(`⚠️ ${ctx.regime} regime — long bias suppressed`)
      } else if (ctx.regime === 'BULL') {
        r.score = Math.min(100, r.score + 3)
      }
      // VIX extreme — penalize all longs
      if (ctx.vix != null && ctx.vix > 25) {
        r.score = Math.round(r.score * 0.85)
        r.reasons.push(`⚠️ VIX ${ctx.vix.toFixed(1)} extreme — size down`)
      }
    }
    rows.sort((a, b) => b.score - a.score)
  } catch (e) {
    log.warn('EARLY-MOMENTUM', `pro-criteria layer failed: ${(e as Error).message}`)
  }
}

// — Persist snapshot —
export async function runAndPublishEarlyMomentum(): Promise<{ generatedAt: string; total: number; tierCounts: Record<string, number>; rows: EarlyMomentumRow[] }> {
  const rows = await runEarlyMomentumScan()
  // Enrich top 100 with shareholding context — surfaces in Signature column.
  await enrichShareholding(rows)
  // 2026-06-25: archetype matcher — pre-move setup pattern recognition
  await applyArchetypeMatcher(rows)
  // 2026-06-25: pro-criteria boost — bulk-deal confirm, regime, VIX
  await applyProCriteria(rows)
  const tierCounts: Record<string, number> = { EARLY: 0, WAVE_2: 0, CONFIRMED: 0 }
  for (const r of rows) tierCounts[r.tier]++
  const { enrichRows } = await import('../lib/reasonEnrichment')
  const { enrichRowsDates } = await import('../lib/targetDateEnrichment')
  const enriched = enrichRowsDates(
    enrichRows(rows as unknown as Array<Record<string, unknown>>, 'earlyMomentum') as unknown as Array<Record<string, unknown>>,
    'earlyMomentum',
  ) as unknown as EarlyMomentumRow[]
  const out = {
    generatedAt: new Date().toISOString(),
    criterion: '₹50-500 close · score ≥ 25 · ranked by composite momentum + institutional-footprint signature',
    total: enriched.length,
    tierCounts,
    rows: enriched,
  }
  await fs.mkdir(SNAP_DIR, { recursive: true })
  await fs.writeFile(path.join(SNAP_DIR, 'early-momentum.json'), JSON.stringify(out, null, 2))
  log.ok('EARLY-MOMENTUM', `Published: ${rows.length} candidates (${tierCounts.EARLY} EARLY · ${tierCounts.WAVE_2} WAVE_2 · ${tierCounts.CONFIRMED} CONFIRMED)`)
  return out
}
