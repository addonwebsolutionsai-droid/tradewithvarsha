import axios from 'axios'
import { log } from '../util/logger'
import { cached, dailyCache, priceCache } from './cache'
import type { Candle, PriceQuote } from '../types'

/**
 * Yahoo Finance public endpoints — no key needed. Used as a fallback
 * when AlphaVantage / TwelveData are rate-limited.
 */

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  Accept: 'application/json',
}

export async function getQuote(symbol: string): Promise<PriceQuote | null> {
  return cached(priceCache, `yh-q-${symbol}`, async () => {
    try {
      const res = await axios.get(
        `https://query1.finance.yahoo.com/v7/finance/quote`,
        { params: { symbols: symbol }, headers: HEADERS, timeout: 10_000 },
      )
      const r = res.data?.quoteResponse?.result?.[0]
      if (!r) return null
      return {
        symbol,
        price: r.regularMarketPrice,
        change: r.regularMarketChange,
        changePct: r.regularMarketChangePercent,
        high: r.regularMarketDayHigh,
        low: r.regularMarketDayLow,
        open: r.regularMarketOpen,
        previousClose: r.regularMarketPreviousClose,
        volume: r.regularMarketVolume ?? 0,
        timestamp: Date.now(),
        source: 'yahoo',
      }
    } catch (e) {
      log.err('YH', `quote ${symbol} failed: ${(e as Error).message}`)
      return null
    }
  })
}

export async function getChart(
  symbol: string,
  interval: '1m' | '5m' | '15m' | '30m' | '1h' | '1d' | '1wk' | '1mo' = '15m',
  range: '1d' | '5d' | '1mo' | '3mo' | '6mo' | '1y' | '5y' | '10y' = '5d',
): Promise<Candle[]> {
  const cache = ['1d', '1wk', '1mo'].includes(interval) ? dailyCache : priceCache
  return cached(cache, `yh-c-${symbol}-${interval}-${range}`, async () => {
    try {
      const res = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
        { params: { interval, range }, headers: HEADERS, timeout: 12_000 },
      )
      const r = res.data?.chart?.result?.[0]
      if (!r?.timestamp || !r?.indicators?.quote?.[0]) return []
      const q = r.indicators.quote[0]
      const out: Candle[] = []
      for (let i = 0; i < r.timestamp.length; i++) {
        const c = q.close?.[i], o = q.open?.[i], h = q.high?.[i], l = q.low?.[i]
        if (c == null || o == null || h == null || l == null) continue
        out.push({
          time: r.timestamp[i] * 1000,
          open: o,
          high: h,
          low: l,
          close: c,
          volume: q.volume?.[i] ?? 0,
        })
      }
      return out
    } catch (e) {
      log.err('YH', `chart ${symbol} failed: ${(e as Error).message}`)
      return []
    }
  }) ?? []
}

/** Common symbol mappings for Indian markets on Yahoo. */
export const YH_SYMBOLS = {
  NIFTY: '^NSEI',
  BANKNIFTY: '^NSEBANK',
  SENSEX: '^BSESN',
  INDIAVIX: '^INDIAVIX',
  GOLD: 'GC=F',         // COMEX gold futures (USD/oz)
  GOLD_MCX: 'GOLDBEES.NS', // Nippon India Gold ETF listed on NSE (proxy)
  CRUDE: 'CL=F',        // WTI crude
  DXY: 'DX-Y.NYB',
  USDINR: 'INR=X',
  // Equities
  RELIANCE: 'RELIANCE.NS',
  TCS: 'TCS.NS',
  HDFCBANK: 'HDFCBANK.NS',
  INFY: 'INFY.NS',
  ICICIBANK: 'ICICIBANK.NS',
  SBIN: 'SBIN.NS',
  ADANIENT: 'ADANIENT.NS',
  AXISBANK: 'AXISBANK.NS',
  ITC: 'ITC.NS',
  LT: 'LT.NS',
} as const

export type YHSymbol = keyof typeof YH_SYMBOLS
