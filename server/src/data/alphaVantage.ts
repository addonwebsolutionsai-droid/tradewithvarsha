import axios from 'axios'
import { config } from '../config'
import { log } from '../util/logger'
import { cached, dailyCache, priceCache } from './cache'
import type { Candle, PriceQuote } from '../types'

const BASE = 'https://www.alphavantage.co/query'

async function av<T = any>(params: Record<string, string>): Promise<T | null> {
  try {
    const res = await axios.get(BASE, {
      params: { ...params, apikey: config.apis.alphaVantageKey || 'demo' },
      timeout: 15_000,
    })
    if (res.data?.Note || res.data?.Information) {
      log.warn('AV', `rate-limit: ${res.data.Note ?? res.data.Information}`)
      return null
    }
    return res.data
  } catch (e) {
    log.err('AV', `${params.function} failed: ${(e as Error).message}`)
    return null
  }
}

export async function getQuote(symbol: string): Promise<PriceQuote | null> {
  return cached(priceCache, `av-q-${symbol}`, async () => {
    const data = await av<{ 'Global Quote': Record<string, string> }>({
      function: 'GLOBAL_QUOTE',
      symbol,
    })
    const q = data?.['Global Quote']
    if (!q || !q['05. price']) return null
    return {
      symbol,
      price: Number(q['05. price']),
      change: Number(q['09. change']),
      changePct: Number((q['10. change percent'] ?? '0%').replace('%', '')),
      high: Number(q['03. high']),
      low: Number(q['04. low']),
      open: Number(q['02. open']),
      previousClose: Number(q['08. previous close']),
      volume: Number(q['06. volume']),
      timestamp: Date.now(),
      source: 'alphavantage',
    }
  })
}

export async function getDailyCandles(symbol: string, outputsize: 'compact' | 'full' = 'compact'): Promise<Candle[]> {
  const data = await cached(dailyCache, `av-d-${symbol}-${outputsize}`, () =>
    av<any>({ function: 'TIME_SERIES_DAILY', symbol, outputsize }),
  )
  return parseTimeSeries(data, 'Time Series (Daily)')
}

export async function getIntradayCandles(symbol: string, interval: '1min' | '5min' | '15min' | '30min' | '60min' = '15min'): Promise<Candle[]> {
  const data = await cached(priceCache, `av-i-${symbol}-${interval}`, () =>
    av<any>({ function: 'TIME_SERIES_INTRADAY', symbol, interval, outputsize: 'compact' }),
  )
  return parseTimeSeries(data, `Time Series (${interval})`)
}

function parseTimeSeries(data: any, key: string): Candle[] {
  const series = data?.[key]
  if (!series) return []
  return Object.entries(series)
    .map(([time, v]: [string, any]) => ({
      time: new Date(time).getTime(),
      open: Number(v['1. open']),
      high: Number(v['2. high']),
      low: Number(v['3. low']),
      close: Number(v['4. close']),
      volume: Number(v['5. volume']),
    }))
    .sort((a, b) => a.time - b.time)
}

/** Dollar Index (DXY) — important for gold/crude trading signals. */
export async function getDXY(): Promise<PriceQuote | null> {
  return getQuote('DX-Y.NYB') // Yahoo symbol variant, AV supports it
}
