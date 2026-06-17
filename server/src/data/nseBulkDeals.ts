/**
 * NSE Bulk Deals + Block Deals scraper.
 *
 * Bulk deals: any single buyer/seller trading >0.5% of company's listed
 * equity in one trading session. Published daily by NSE end-of-day with
 * the BUYER NAME visible (mutual funds, FIIs, individual investors).
 * This is the actionable "smart money footprint" the user asked for.
 *
 * Block deals: minimum ₹10cr transaction in a single window-trade.
 * Less granular client info but big-money signals.
 *
 * Source: nseindia.com/api/historical/cm/bulk-deals
 *
 * Output schema per row:
 *   { symbol, dealDate, side, buyer/seller, quantity, price, isInstitution }
 *
 * Categorisation: any client name containing MUTUAL FUND, INSURANCE,
 * FII, FOREIGN, INVESTMENT TRUST, PORTFOLIO, INC, LLC, AMC, FUND →
 * tagged as INSTITUTION. Plus a curated list of known HNI superstars
 * (Damani, Jhunjhunwala, Mukul Agrawal etc).
 */
import axios from 'axios'
import { log } from '../util/logger'

const NSE_BASE = 'https://www.nseindia.com'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.nseindia.com/report-detail/display-bulk-and-block-deals',
}

const INSTITUTION_TOKENS = [
  'MUTUAL FUND', 'MF', 'INSURANCE', 'INSURNCE', 'FII', 'FPI', 'FOREIGN',
  'INVESTMENT TRUST', 'PORTFOLIO', 'AMC', 'ASSET MANAGEMENT',
  'INC', 'LLC', 'LP', 'PVT LTD', 'PRIVATE LIMITED', 'LIMITED',
  'CAPITAL', 'ADVISORS', 'HOLDINGS', 'INVESTMENTS', 'FUND',
  'PENSION', 'HDFC', 'ICICI', 'SBI', 'KOTAK', 'NIPPON', 'AXIS',
  'ABERDEEN', 'INVESCO', 'GOLDMAN', 'MORGAN', 'BLACKROCK', 'VANGUARD',
]

// Superstars (subset of those in superstarHoldings.ts). Bulk-deal feed
// shows their names directly when they trade ≥0.5% of a company.
const SUPERSTAR_NAMES = [
  'JHUNJHUNWALA', 'DAMANI', 'KACHOLIA', 'KEDIA', 'KHANNA',
  'PORINJU', 'MUKUL AGRAWAL', 'SINGHANIA', 'KELA', 'GOEL',
]

interface BulkDealRaw {
  symbol: string
  clientName: string
  buySell: 'BUY' | 'SELL'
  quantity: number
  priceAvg: number
  remarks?: string
  date: string
}

export interface BulkDealRow {
  date: string                  // YYYY-MM-DD
  symbol: string
  side: 'BUY' | 'SELL'
  clientName: string
  quantity: number
  priceAvg: number
  valueCr: number               // quantity × price / 1cr
  category: 'INSTITUTION' | 'SUPERSTAR' | 'OTHER'
  notes?: string
}

function classify(clientName: string): 'INSTITUTION' | 'SUPERSTAR' | 'OTHER' {
  const u = clientName.toUpperCase()
  for (const ss of SUPERSTAR_NAMES) {
    if (u.includes(ss)) return 'SUPERSTAR'
  }
  for (const tok of INSTITUTION_TOKENS) {
    if (u.includes(tok)) return 'INSTITUTION'
  }
  return 'OTHER'
}

// NSE requires session cookie before the data endpoint accepts requests.
// Two-step: GET the public page to set cookies, then call the JSON API
// with those cookies attached.
type AxClient = ReturnType<typeof axios.create>
async function withSession<T>(fn: (client: AxClient) => Promise<T>): Promise<T | null> {
  try {
    const cookieJar: string[] = []
    const client = axios.create({
      baseURL: NSE_BASE,
      headers: HEADERS,
      withCredentials: true,
      timeout: 15_000,
    })
    client.interceptors.response.use(res => {
      const setCookie = res.headers['set-cookie']
      if (Array.isArray(setCookie)) cookieJar.push(...setCookie.map(s => s.split(';')[0]))
      return res
    })
    // Warm-up: hit the public deals page to set cookies
    await client.get('/report-detail/display-bulk-and-block-deals', { validateStatus: () => true })
    if (cookieJar.length) {
      client.defaults.headers.Cookie = cookieJar.join('; ')
    }
    return await fn(client)
  } catch (e) {
    log.warn('NSE-BULK', `session error: ${(e as Error).message}`)
    return null
  }
}

export async function fetchTodaysBulkDeals(): Promise<BulkDealRow[]> {
  const data = await withSession(async client => {
    const res = await client.get('/api/snapshot-capital-market-largedeal', { validateStatus: () => true })
    if (res.status !== 200) {
      log.warn('NSE-BULK', `bulk-deals API → ${res.status}`)
      return null
    }
    return res.data
  })
  if (!data) return []

  const bulk: BulkDealRaw[] = Array.isArray(data?.BULK_DEALS_DATA) ? data.BULK_DEALS_DATA : []
  log.info('NSE-BULK', `received ${bulk.length} raw bulk deals from NSE`)

  const out: BulkDealRow[] = []
  const seen = new Set<string>()
  for (const r of bulk) {
    const sym = (r.symbol ?? '').toUpperCase()
    const client = (r.clientName ?? '').trim()
    if (!sym || !client) continue
    const qty = Number(r.quantity) || 0
    const price = Number(r.priceAvg) || 0
    if (qty === 0 || price === 0) continue
    const key = `${sym}|${client}|${r.buySell}|${qty}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      date: r.date ?? new Date().toISOString().slice(0, 10),
      symbol: sym,
      side: r.buySell as 'BUY' | 'SELL',
      clientName: client,
      quantity: qty,
      priceAvg: price,
      valueCr: +(qty * price / 1e7).toFixed(2),
      category: classify(client),
      notes: r.remarks,
    })
  }
  // Sort: SUPERSTAR > INSTITUTION > OTHER; then by valueCr desc
  out.sort((a, b) => {
    const rank: Record<string, number> = { SUPERSTAR: 3, INSTITUTION: 2, OTHER: 1 }
    if (rank[b.category] !== rank[a.category]) return rank[b.category] - rank[a.category]
    return b.valueCr - a.valueCr
  })
  log.ok('NSE-BULK', `${out.length} deduped bulk deals · ${out.filter(d => d.category === 'SUPERSTAR').length} superstar · ${out.filter(d => d.category === 'INSTITUTION').length} institution`)
  return out
}

/**
 * Aggregate by symbol: net buys/sells per stock today.
 * If institutions + superstars net-buy the same stock → high-conviction
 * smart-money footprint signal.
 */
export interface SymbolFootprint {
  symbol: string
  netBuyValueCr: number             // +ve = accumulated, -ve = distributed
  superstarBuys: number             // count of SUPERSTAR-tagged buys
  superstarSells: number
  institutionBuys: number
  institutionSells: number
  totalDealCount: number
  topBuyers: string[]               // names of top 3 buyers (truncated)
  signal: 'STRONG_ACCUMULATION' | 'ACCUMULATION' | 'NEUTRAL' | 'DISTRIBUTION' | 'STRONG_DISTRIBUTION'
}

export function aggregateBySymbol(deals: BulkDealRow[]): SymbolFootprint[] {
  const bySym = new Map<string, SymbolFootprint>()
  for (const d of deals) {
    let row = bySym.get(d.symbol)
    if (!row) {
      row = {
        symbol: d.symbol, netBuyValueCr: 0,
        superstarBuys: 0, superstarSells: 0,
        institutionBuys: 0, institutionSells: 0,
        totalDealCount: 0, topBuyers: [], signal: 'NEUTRAL',
      }
      bySym.set(d.symbol, row)
    }
    row.totalDealCount++
    const isBuy = d.side === 'BUY'
    row.netBuyValueCr += isBuy ? d.valueCr : -d.valueCr
    if (d.category === 'SUPERSTAR') { if (isBuy) row.superstarBuys++; else row.superstarSells++ }
    if (d.category === 'INSTITUTION') { if (isBuy) row.institutionBuys++; else row.institutionSells++ }
    if (isBuy && (d.category === 'SUPERSTAR' || d.category === 'INSTITUTION')) {
      if (!row.topBuyers.includes(d.clientName) && row.topBuyers.length < 3) {
        row.topBuyers.push(d.clientName.slice(0, 40))
      }
    }
  }
  // Classify signal
  for (const row of bySym.values()) {
    const instNetBuys = (row.superstarBuys + row.institutionBuys) - (row.superstarSells + row.institutionSells)
    if (instNetBuys >= 3 && row.netBuyValueCr > 5) row.signal = 'STRONG_ACCUMULATION'
    else if (instNetBuys >= 1 && row.netBuyValueCr > 0) row.signal = 'ACCUMULATION'
    else if (instNetBuys <= -3 || row.netBuyValueCr < -5) row.signal = 'STRONG_DISTRIBUTION'
    else if (instNetBuys < 0 && row.netBuyValueCr < 0) row.signal = 'DISTRIBUTION'
    else row.signal = 'NEUTRAL'
  }
  // Sort by abs(netBuyValueCr) descending
  return Array.from(bySym.values()).sort((a, b) => Math.abs(b.netBuyValueCr) - Math.abs(a.netBuyValueCr))
}
