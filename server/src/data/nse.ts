import axios, { AxiosInstance } from 'axios'
import { log } from '../util/logger'
import { cached, oiCache, priceCache } from './cache'
import type { OptionChain, OptionChainRow, PriceQuote } from '../types'

/**
 * NSE India public API wrapper.
 *
 * NSE requires browser-like headers AND a session cookie obtained by first
 * visiting the home page. We keep a single axios instance with a cookie jar
 * that we refresh periodically.
 */

const NSE_BASE = 'https://www.nseindia.com'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

const HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Referer: `${NSE_BASE}/`,
  Connection: 'keep-alive',
}

let client: AxiosInstance | null = null
let cookieStr = ''
let cookieExpiresAt = 0

function buildClient(): AxiosInstance {
  return axios.create({
    baseURL: NSE_BASE,
    timeout: 12_000,
    headers: HEADERS,
    validateStatus: s => s < 500,
  })
}

async function ensureSession(): Promise<AxiosInstance> {
  if (client && Date.now() < cookieExpiresAt && cookieStr) return client
  client = buildClient()
  try {
    // Home page sets the session cookies
    const res = await client.get('/', { headers: HEADERS })
    const raw = res.headers['set-cookie']
    if (Array.isArray(raw) && raw.length) {
      cookieStr = raw.map(c => c.split(';')[0]).join('; ')
      client.defaults.headers.common['Cookie'] = cookieStr
      cookieExpiresAt = Date.now() + 5 * 60_000 // refresh every 5 min
    }
    // Some endpoints require one more "warm-up" hit
    await client.get('/option-chain', { headers: HEADERS })
  } catch (e) {
    log.warn('NSE', `Session setup failed: ${(e as Error).message}`)
  }
  return client
}

export async function fetchNiftyOptionChain(): Promise<OptionChain | null> {
  return cached(oiCache, 'nifty-oc', () => fetchOptionChainIndex('NIFTY'))
}

export async function fetchBankNiftyOptionChain(): Promise<OptionChain | null> {
  return cached(oiCache, 'bn-oc', () => fetchOptionChainIndex('BANKNIFTY'))
}

export async function fetchOptionChainIndex(symbol: string): Promise<OptionChain | null> {
  const c = await ensureSession()
  try {
    const res = await c.get(`/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`)
    if (res.status !== 200) {
      log.warn('NSE', `Option chain ${symbol} returned status ${res.status}`)
      return null
    }
    if (!res.data?.records?.data?.length) {
      // NSE blocks or returns empty outside market hours — not an error
      return null
    }
    return parseOptionChain(res.data, symbol)
  } catch (e) {
    log.err('NSE', `option-chain-indices ${symbol} failed: ${(e as Error).message}`)
    return null
  }
}

export async function fetchEquityOptionChain(symbol: string): Promise<OptionChain | null> {
  return cached(oiCache, `eq-oc-${symbol}`, async () => {
    const c = await ensureSession()
    try {
      const res = await c.get(`/api/option-chain-equities?symbol=${encodeURIComponent(symbol)}`)
      if (res.status !== 200) return null
      return parseOptionChain(res.data, symbol)
    } catch (e) {
      log.err('NSE', `option-chain-equities ${symbol} failed: ${(e as Error).message}`)
      return null
    }
  })
}

function parseOptionChain(data: any, symbol: string): OptionChain | null {
  const records = data?.records
  const filtered = data?.filtered ?? data?.records
  if (!records || !filtered?.data) return null

  const spot: number = records.underlyingValue ?? 0
  // 2026-06-03: filter out EXPIRED expiries. NSE sometimes still lists
  // last week's expiry in expiryDates[] — pick the nearest one whose date
  // is today-or-later (IST). Expiry strings are in "DD-MMM-YYYY" format.
  const allExpiries: string[] = Array.isArray(records.expiryDates) ? records.expiryDates : []
  const istTodayMs = (() => {
    const istDate = new Date(Date.now() + 5.5 * 3600_000)
    return Date.UTC(istDate.getUTCFullYear(), istDate.getUTCMonth(), istDate.getUTCDate())
  })()
  const validExpiries = allExpiries.filter(e => {
    const t = Date.parse(e)
    return !Number.isNaN(t) && t >= istTodayMs
  })
  const expiry: string = validExpiries[0] ?? allExpiries[0] ?? ''
  const frontMonth = filtered.data.filter((r: any) => r.expiryDate === expiry || !r.expiryDate)

  const rows: OptionChainRow[] = frontMonth.map((r: any) => ({
    strike: r.strikePrice,
    callOI: r.CE?.openInterest ?? 0,
    putOI: r.PE?.openInterest ?? 0,
    callOIChange: r.CE?.changeinOpenInterest ?? 0,
    putOIChange: r.PE?.changeinOpenInterest ?? 0,
    callVolume: r.CE?.totalTradedVolume ?? 0,
    putVolume: r.PE?.totalTradedVolume ?? 0,
    callIV: r.CE?.impliedVolatility ?? 0,
    putIV: r.PE?.impliedVolatility ?? 0,
    callLTP: r.CE?.lastPrice ?? 0,
    putLTP: r.PE?.lastPrice ?? 0,
    callBid: r.CE?.bidprice,
    callAsk: r.CE?.askPrice,
    putBid: r.PE?.bidprice,
    putAsk: r.PE?.askPrice,
  }))

  const totalCallOI = rows.reduce((s, r) => s + r.callOI, 0)
  const totalPutOI = rows.reduce((s, r) => s + r.putOI, 0)
  const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0

  return {
    symbol,
    expiry,
    spot,
    pcr,
    maxPain: 0, // filled by options analyzer
    totalCallOI,
    totalPutOI,
    rows,
    timestamp: Date.now(),
  }
}

export interface IndexRow {
  symbol: string
  name: string
  price: number
  change: number
  changePct: number
  open: number
  high: number
  low: number
  previousClose: number
}

export async function fetchAllIndices(): Promise<IndexRow[]> {
  return cached(priceCache, 'nse-indices', async () => {
    const c = await ensureSession()
    try {
      const res = await c.get('/api/allIndices')
      if (res.status !== 200 || !res.data?.data) return []
      return res.data.data.map((i: any): IndexRow => ({
        symbol: i.indexSymbol ?? i.index,
        name: i.index,
        price: i.last,
        change: i.variation,
        changePct: i.percentChange,
        open: i.open,
        high: i.high,
        low: i.low,
        previousClose: i.previousClose,
      }))
    } catch (e) {
      log.err('NSE', `allIndices failed: ${(e as Error).message}`)
      return []
    }
  }) ?? []
}

export async function fetchEquityQuote(symbol: string): Promise<PriceQuote | null> {
  return cached(priceCache, `nse-eq-${symbol}`, async () => {
    const c = await ensureSession()
    try {
      const res = await c.get(`/api/quote-equity?symbol=${encodeURIComponent(symbol)}`)
      if (res.status !== 200) return null
      const pi = res.data.priceInfo
      if (!pi) return null
      return {
        symbol,
        price: pi.lastPrice,
        change: pi.change,
        changePct: pi.pChange,
        high: pi.intraDayHighLow?.max ?? 0,
        low: pi.intraDayHighLow?.min ?? 0,
        open: pi.open,
        previousClose: pi.previousClose,
        volume: res.data.securityWiseDP?.quantityTraded ?? 0,
        timestamp: Date.now(),
        source: 'nse',
      }
    } catch (e) {
      log.err('NSE', `quote ${symbol} failed: ${(e as Error).message}`)
      return null
    }
  })
}

export async function fetchFIIDIIData(): Promise<any> {
  return cached(oiCache, 'fii-dii', async () => {
    const c = await ensureSession()
    try {
      const res = await c.get('/api/fiidiiTradeReact')
      return res.status === 200 ? res.data : null
    } catch {
      return null
    }
  })
}
