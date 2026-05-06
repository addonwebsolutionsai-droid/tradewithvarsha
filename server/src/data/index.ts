/**
 * Unified data router. Tries providers in order and falls back gracefully.
 * Every strategy / indicator flows through this module so provider failures
 * never block signal generation.
 */
import type { Candle, PriceQuote, Timeframe } from '../types'
import * as nse from './nse'
import * as av from './alphaVantage'
import * as td from './twelveData'
import * as yh from './yahoo'
import * as angel from './angel'
import { YH_SYMBOLS } from './yahoo'
import { log } from '../util/logger'

export interface SymbolMap {
  /** User-facing key — e.g. "NIFTY", "RELIANCE", "GOLD" */
  key: string
  /** NSE symbol (equity) or index identifier */
  nse?: string
  /** AlphaVantage symbol */
  av?: string
  /** TwelveData symbol */
  td?: string
  /** Yahoo symbol */
  yh?: string
  /** Is this an index? Indexes can't fetch via nse quote-equity */
  index?: boolean
  /** Is this a commodity? */
  commodity?: boolean
}

export const SYMBOLS: Record<string, SymbolMap> = {
  // Note: TwelveData's free tier doesn't cover Indian indices reliably; we prefer Yahoo for NIFTY/BANKNIFTY
  NIFTY: { key: 'NIFTY', yh: YH_SYMBOLS.NIFTY, index: true },
  BANKNIFTY: { key: 'BANKNIFTY', yh: YH_SYMBOLS.BANKNIFTY, index: true },
  SENSEX: { key: 'SENSEX', yh: YH_SYMBOLS.SENSEX, index: true },
  INDIAVIX: { key: 'INDIAVIX', yh: YH_SYMBOLS.INDIAVIX, index: true },
  // GOLD — primary is NSE GOLDBEES ETF via Angel (always-on, perfectly
  // correlated INR proxy for gold spot). Yahoo GC=F was 401 throughout
  // 2026-04 and TwelveData XAU/USD is paywalled on free tier. AV is the
  // 25/day deep-fallback. The XAUUSD-spot signal still gets generated —
  // GOLDBEES tracks it tick-for-tick at NSE close — and the user can act
  // either via GOLDBEES (₹) or XAUUSD (USD) on their broker.
  // Drop yh/av fallbacks — they returned USD/oz spot (~4644) which mismatches
  // the GOLDBEES ₹ scale (~123) and corrupted candle math. Stay on GOLDBEES
  // alone via Angel for consistent units across quote + candles.
  GOLD: { key: 'GOLD', nse: 'GOLDBEES' },
  XAUUSD: { key: 'XAUUSD', nse: 'GOLDBEES' },
  CRUDE: { key: 'CRUDE', yh: YH_SYMBOLS.CRUDE, av: 'USO', commodity: true },
  DXY: { key: 'DXY', yh: YH_SYMBOLS.DXY, av: 'DX-Y.NYB' },
  USDINR: { key: 'USDINR', yh: YH_SYMBOLS.USDINR },
  RELIANCE: { key: 'RELIANCE', nse: 'RELIANCE', yh: YH_SYMBOLS.RELIANCE, av: 'RELIANCE.BSE' },
  TCS: { key: 'TCS', nse: 'TCS', yh: YH_SYMBOLS.TCS, av: 'TCS.BSE' },
  HDFCBANK: { key: 'HDFCBANK', nse: 'HDFCBANK', yh: YH_SYMBOLS.HDFCBANK, av: 'HDFCBANK.BSE' },
  INFY: { key: 'INFY', nse: 'INFY', yh: YH_SYMBOLS.INFY, av: 'INFY' },
  ICICIBANK: { key: 'ICICIBANK', nse: 'ICICIBANK', yh: YH_SYMBOLS.ICICIBANK },
  SBIN: { key: 'SBIN', nse: 'SBIN', yh: YH_SYMBOLS.SBIN },
  AXISBANK: { key: 'AXISBANK', nse: 'AXISBANK', yh: YH_SYMBOLS.AXISBANK },
  ADANIENT: { key: 'ADANIENT', nse: 'ADANIENT', yh: YH_SYMBOLS.ADANIENT },
  ITC: { key: 'ITC', nse: 'ITC', yh: YH_SYMBOLS.ITC },
  LT: { key: 'LT', nse: 'LT', yh: YH_SYMBOLS.LT },
}

export async function getQuote(key: string): Promise<PriceQuote | null> {
  const up = key.toUpperCase()
  const s = SYMBOLS[up]
  if (!s) {
    // Unknown symbol — try Angel ScripMaster first (covers ~1.9k NSE-EQ
    // names, all of MIDCAP/SMALLCAP/CNX500), then fall back to:
    //   2. NSE public equity-quote endpoint (best for mid/small caps that
    //      Yahoo's free tier doesn't index — e.g. EPACK, CMSINFO).
    //   3. Yahoo .NS  (fallback for non-NSE-indexed names)
    //   4. Yahoo .BO  (BSE listing as last resort)
    // Bare `yh.getQuote(key)` was returning foreign tickers for collisions
    // like "SAIL"/"HAL", so we always force a `.NS` / `.BO` suffix.
    if (angel.hasAngelCreds()) {
      const q = await angel.getEquityQuote(up).catch(() => null)
      if (q) return q
    }
    const nseQ = await nse.fetchEquityQuote(up).catch(() => null)
    if (nseQ) return nseQ
    return (await yh.getQuote(`${up}.NS`)) ?? (await yh.getQuote(`${up}.BO`)) ?? null
  }
  // PRIORITY 1: Angel SmartAPI — real-time LTP when creds configured
  if (angel.hasAngelCreds()) {
    if (s.index && (up === 'NIFTY' || up === 'BANKNIFTY')) {
      const q = await angel.getIndexQuote(up as 'NIFTY' | 'BANKNIFTY')
      if (q) return q
    } else if (!s.index && !s.commodity && s.nse) {
      const q = await angel.getEquityQuote(s.nse)
      if (q) return q
    }
  }
  // For Indian indices, try NSE allIndices (public, no key needed)
  if (s.index) {
    const idx = await nse.fetchAllIndices()
    const match = idx.find(i => matchesIndex(i.name, up))
    if (match) {
      return {
        symbol: up,
        price: match.price,
        change: match.change,
        changePct: match.changePct,
        high: match.high,
        low: match.low,
        open: match.open,
        previousClose: match.previousClose,
        volume: 0,
        timestamp: Date.now(),
        source: 'nse-allIndices',
      }
    }
  }
  // Prefer NSE for equities, then TwelveData, then Yahoo, then AV
  if (!s.index && !s.commodity && s.nse) {
    const q = await nse.fetchEquityQuote(s.nse)
    if (q) return q
  }
  // For commodities (GOLD/XAUUSD/CRUDE) TwelveData beats Yahoo — Yahoo's
  // GC=F / CL=F return 401 on the free tier, while TwelveData's XAU/USD and
  // WTI/USD are open. Try td first, then yh, then av regardless of category.
  if (s.td) {
    const q = await td.getQuote(s.td)
    if (q) return q
  }
  if (s.yh) {
    const q = await yh.getQuote(s.yh)
    if (q) return q
  }
  if (s.av) {
    const q = await av.getQuote(s.av)
    if (q) return q
  }
  log.warn('DATA', `No quote source worked for ${key}`)
  return null
}

function matchesIndex(nseName: string, key: string): boolean {
  const n = nseName.toUpperCase().replace(/\s+/g, '')
  if (key === 'NIFTY') return n === 'NIFTY50'
  if (key === 'BANKNIFTY') return n === 'NIFTYBANK'
  if (key === 'SENSEX') return n.includes('SENSEX')
  if (key === 'INDIAVIX') return n.includes('INDIAVIX')
  return n === key
}

/** Map our internal timeframe to each provider. */
function mapTf(tf: Timeframe) {
  return {
    td:
      tf === '1m' ? '1min' : tf === '3m' ? '5min' : tf === '5m' ? '5min' :
      tf === '15m' ? '15min' : tf === '30m' ? '30min' : tf === '1h' ? '1h' :
      tf === '4h' ? '4h' : tf === '1D' ? '1day' : tf === '1W' ? '1week' :
      tf === '1M' ? '1month' : '15min',
    yh:
      tf === '1m' ? '1m' : tf === '3m' ? '5m' : tf === '5m' ? '5m' :
      tf === '15m' ? '15m' : tf === '30m' ? '30m' : tf === '1h' ? '1h' :
      tf === '4h' ? '1h' : tf === '1D' ? '1d' : tf === '1W' ? '1wk' :
      tf === '1M' ? '1mo' : '15m',
    yhRange: (tf === '1m' || tf === '3m' || tf === '5m') ? '5d' :
      (tf === '15m' || tf === '30m' || tf === '1h') ? '1mo' :
      (tf === '4h' || tf === '1D') ? '1y' : '5y',
    av:
      tf === '1m' ? '1min' : tf === '5m' ? '5min' :
      tf === '15m' ? '15min' : tf === '30m' ? '30min' : '60min',
  } as const
}

export async function getCandles(key: string, timeframe: Timeframe = '15m', count = 200): Promise<Candle[]> {
  const up = key.toUpperCase()
  const s = SYMBOLS[up]
  const tf = mapTf(timeframe)

  // PRIORITY 1: Angel SmartAPI — works for ANY NSE-EQ scrip via ScripMaster,
  // not just those in the SYMBOLS map. This is what makes the wider universe
  // (MIDCAP / SMALLCAP / CNX500 / NSE_ALL) actually fetchable with correct
  // Indian-market prices instead of foreign-ticker collisions on Yahoo.
  if (angel.hasAngelCreds()) {
    try {
      let token: string | null = null
      let exch: 'NSE' | 'BSE' | 'NFO' = 'NSE'
      if (s?.index && (up === 'NIFTY' || up === 'BANKNIFTY' || up === 'FINNIFTY')) {
        token = await angel.findIndexToken(up as 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY')
      } else if (!s?.commodity) {
        // Either a mapped equity (use s.nse) or an unmapped NSE symbol (use up).
        const symbolToLookup = (s && !s.index && s.nse) ? s.nse : up
        // 2026-05-03: findEquityScrip tries NSE-EQ first, falls back to BSE
        // name-alias lookup. Lets us fetch BSE-only micro-caps like Cemindia,
        // Pentokey, Indiabulls without the user supplying numeric codes.
        const scrip = await angel.findEquityScrip(symbolToLookup)
        if (scrip) { token = scrip.token; exch = scrip.exchange }
      }
      if (token) {
        const daysBack = (['1D', '1W', '1M'] as Timeframe[]).includes(timeframe)
          ? Math.max(count * 1.5, 300)
          : timeframe === '1h' || timeframe === '4h'
            ? 45
            : timeframe === '30m' ? 15
            : timeframe === '15m' ? 10
            : 3
        const candles = await angel.getCandles(exch, token, timeframe as any, Math.ceil(daysBack))
        if (candles.length) return candles.slice(-count)
      }
    } catch (e) {
      log.warn('DATA', `Angel candles fallback for ${key}: ${(e as Error).message}`)
    }
  }

  if (s?.td) {
    const c = await td.getTimeSeries(s.td, tf.td as any, count)
    if (c.length) return c.slice(-count)
  }
  // Yahoo fallback — for unmapped symbols we MUST suffix the exchange so we
  // don't collide with US tickers (e.g. bare "SAIL" → South African foreign
  // listing instead of Steel Authority of India).
  const ySymbol = s?.yh ?? `${up}.NS`
  const c = await yh.getChart(ySymbol, tf.yh as any, tf.yhRange as any)
  if (c.length) return c.slice(-count)
  // Last-resort: try BSE listing
  if (!s?.yh) {
    const cBse = await yh.getChart(`${up}.BO`, tf.yh as any, tf.yhRange as any)
    if (cBse.length) return cBse.slice(-count)
  }
  if (s?.av) {
    if (timeframe === '1D' || timeframe === '1W' || timeframe === '1M') {
      return (await av.getDailyCandles(s.av, 'compact')).slice(-count)
    }
    return (await av.getIntradayCandles(s.av, tf.av as any)).slice(-count)
  }
  log.warn('DATA', `No candle source worked for ${key} ${timeframe}`)
  return []
}

export async function getMarketIndices(): Promise<{
  symbol: string
  name: string
  price: number
  change: number
  changePct: number
  high: number
  low: number
}[]> {
  // Try NSE allIndices first (richest data)
  const nseData = await nse.fetchAllIndices()
  if (nseData.length) {
    const wanted = ['NIFTY 50', 'NIFTY BANK', 'NIFTY IT', 'NIFTY AUTO', 'NIFTY FMCG', 'INDIA VIX']
    return nseData
      .filter(i => wanted.includes(i.name))
      .map(i => ({
        symbol: i.symbol || i.name,
        name: i.name,
        price: i.price,
        change: i.change,
        changePct: i.changePct,
        high: i.high,
        low: i.low,
      }))
  }
  // Fallback to individual Yahoo quotes for core 4
  const out: Awaited<ReturnType<typeof getMarketIndices>> = []
  for (const key of ['NIFTY', 'BANKNIFTY', 'GOLD', 'CRUDE']) {
    const q = await getQuote(key)
    if (q) {
      out.push({
        symbol: key,
        name: key,
        price: q.price,
        change: q.change,
        changePct: q.changePct,
        high: q.high,
        low: q.low,
      })
    }
  }
  return out
}
