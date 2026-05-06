import axios from 'axios'
import { config } from '../config'
import { log } from '../util/logger'
import { cached, dailyCache, priceCache } from './cache'
import type { Candle, PriceQuote } from '../types'

const BASE = 'https://api.twelvedata.com'

async function td<T = any>(endpoint: string, params: Record<string, string>): Promise<T | null> {
  if (!config.apis.twelveDataKey) return null
  try {
    const res = await axios.get(`${BASE}/${endpoint}`, {
      params: { ...params, apikey: config.apis.twelveDataKey },
      timeout: 15_000,
    })
    if (res.data?.status === 'error') {
      log.warn('TD', `${endpoint} error: ${res.data.message}`)
      return null
    }
    return res.data
  } catch (e) {
    log.err('TD', `${endpoint} failed: ${(e as Error).message}`)
    return null
  }
}

export async function getQuote(symbol: string): Promise<PriceQuote | null> {
  return cached(priceCache, `td-q-${symbol}`, async () => {
    const data = await td<any>('quote', { symbol })
    if (!data?.close) return null
    return {
      symbol,
      price: Number(data.close),
      change: Number(data.change),
      changePct: Number(data.percent_change),
      high: Number(data.high),
      low: Number(data.low),
      open: Number(data.open),
      previousClose: Number(data.previous_close),
      volume: Number(data.volume ?? 0),
      timestamp: Date.now(),
      source: 'twelvedata',
    }
  })
}

export async function getTimeSeries(
  symbol: string,
  interval: '1min' | '5min' | '15min' | '30min' | '1h' | '4h' | '1day' | '1week' | '1month' = '15min',
  outputsize = 200,
): Promise<Candle[]> {
  const cache = interval === '1day' || interval === '1week' || interval === '1month' ? dailyCache : priceCache
  const data = await cached(cache, `td-ts-${symbol}-${interval}-${outputsize}`, () =>
    td<any>('time_series', { symbol, interval, outputsize: String(outputsize) }),
  )
  const vals = data?.values as any[] | undefined
  if (!vals) return []
  return vals
    .map(v => ({
      time: new Date(v.datetime).getTime(),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: Number(v.volume ?? 0),
    }))
    .sort((a, b) => a.time - b.time)
}

/** Indian indices on TwelveData are named e.g. "NIFTY 50:INDX", "BANKNIFTY:INDX" */
export async function getNiftyQuote(): Promise<PriceQuote | null> {
  return getQuote('NIFTY 50:INDX')
}

export async function getBankNiftyQuote(): Promise<PriceQuote | null> {
  return getQuote('BANKNIFTY:INDX')
}
