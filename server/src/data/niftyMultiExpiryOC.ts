/**
 * NIFTY Multi-Expiry Option Chain fetcher.
 *
 * Existing parseOptionChain in nse.ts filters to a single front-month expiry.
 * That is where the July 1-10 moves slipped past us — smart money builds
 * positions on monthly + quarterly + LEAPS, not on the current week.
 *
 * This module fetches the NSE index option-chain payload once and returns
 * a per-expiry breakdown so the foresight engine can inspect where the
 * institutional book actually sits.
 */

import { log } from '../util/logger'

const ROOT = 'https://www.nseindia.com'

interface ExpiryBook {
  expiry: string           // "10-Jul-2026"
  expiryMs: number         // parsed timestamp (UTC midnight of that date)
  daysToExpiry: number
  totalCallOI: number
  totalPutOI: number
  totalCallOIChange: number
  totalPutOIChange: number
  pcr: number
  maxPain: number
  top3CallStrikes: Array<{ strike: number; oi: number; change: number }>
  top3PutStrikes: Array<{ strike: number; oi: number; change: number }>
  atmIVCall: number
  atmIVPut: number
  strikes: Array<{
    strike: number
    callOI: number
    putOI: number
    callOIChg: number
    putOIChg: number
  }>
}

export interface MultiExpiryOC {
  symbol: string
  spot: number
  fetchedAt: number
  expiries: ExpiryBook[]   // sorted near → far
}

let cachedSession: { cookies: string; ts: number } | null = null
const SESSION_TTL_MS = 20 * 60_000

async function warmSession(): Promise<string> {
  if (cachedSession && Date.now() - cachedSession.ts < SESSION_TTL_MS) {
    return cachedSession.cookies
  }
  const res = await fetch(ROOT + '/option-chain', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh) TWV-Foresight/1.0',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  })
  const setCookieRaw = res.headers.get('set-cookie') ?? ''
  const cookies = setCookieRaw
    .split(/,(?=[^;]+=)/)
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
  cachedSession = { cookies, ts: Date.now() }
  return cookies
}

function computeMaxPain(strikes: Array<{ strike: number; callOI: number; putOI: number }>): number {
  if (strikes.length === 0) return 0
  let bestStrike = strikes[0].strike
  let bestPain = Infinity
  for (const s of strikes) {
    let pain = 0
    for (const r of strikes) {
      if (s.strike > r.strike) pain += (s.strike - r.strike) * r.callOI
      if (s.strike < r.strike) pain += (r.strike - s.strike) * r.putOI
    }
    if (pain < bestPain) {
      bestPain = pain
      bestStrike = s.strike
    }
  }
  return bestStrike
}

function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000))
}

export async function fetchNiftyAllExpiries(): Promise<MultiExpiryOC | null> {
  try {
    const cookies = await warmSession()
    const url = ROOT + '/api/option-chain-indices?symbol=NIFTY'
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh) TWV-Foresight/1.0',
        Accept: 'application/json',
        Referer: ROOT + '/option-chain',
        Cookie: cookies,
      },
    })
    if (!res.ok) {
      log.err('NIFTY-MULTI-OC', `HTTP ${res.status}`)
      cachedSession = null
      return null
    }
    const json = (await res.json()) as {
      records?: { data?: unknown[]; expiryDates?: string[]; underlyingValue?: number }
    }
    const records = json.records
    if (!records?.data || !Array.isArray(records.expiryDates)) return null

    const spot = records.underlyingValue ?? 0
    const nowIstMs = (() => {
      const d = new Date(Date.now() + 5.5 * 3600_000)
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    })()

    const validExpiries = records.expiryDates.filter(e => {
      const t = Date.parse(e)
      return !Number.isNaN(t) && t >= nowIstMs
    })

    const books: ExpiryBook[] = []
    for (const expiry of validExpiries) {
      const rowsForExp = records.data.filter((r) => {
        const row = r as { expiryDate?: string }
        return row.expiryDate === expiry
      })
      if (rowsForExp.length === 0) continue

      const strikes = rowsForExp.map((r) => {
        const row = r as {
          strikePrice: number
          CE?: { openInterest?: number; changeinOpenInterest?: number; impliedVolatility?: number }
          PE?: { openInterest?: number; changeinOpenInterest?: number; impliedVolatility?: number }
        }
        return {
          strike: row.strikePrice,
          callOI: row.CE?.openInterest ?? 0,
          putOI: row.PE?.openInterest ?? 0,
          callOIChg: row.CE?.changeinOpenInterest ?? 0,
          putOIChg: row.PE?.changeinOpenInterest ?? 0,
          callIV: row.CE?.impliedVolatility ?? 0,
          putIV: row.PE?.impliedVolatility ?? 0,
        }
      })

      const totalCallOI = strikes.reduce((s, r) => s + r.callOI, 0)
      const totalPutOI = strikes.reduce((s, r) => s + r.putOI, 0)
      const totalCallOIChange = strikes.reduce((s, r) => s + r.callOIChg, 0)
      const totalPutOIChange = strikes.reduce((s, r) => s + r.putOIChg, 0)
      const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0
      const mp = computeMaxPain(strikes)

      const top3CallStrikes = [...strikes]
        .sort((a, b) => b.callOI - a.callOI)
        .slice(0, 3)
        .map(r => ({ strike: r.strike, oi: r.callOI, change: r.callOIChg }))
      const top3PutStrikes = [...strikes]
        .sort((a, b) => b.putOI - a.putOI)
        .slice(0, 3)
        .map(r => ({ strike: r.strike, oi: r.putOI, change: r.putOIChg }))

      const atmStrike = strikes
        .map(r => ({ r, diff: Math.abs(r.strike - spot) }))
        .sort((a, b) => a.diff - b.diff)[0]?.r
      const atmIVCall = atmStrike?.callIV ?? 0
      const atmIVPut = atmStrike?.putIV ?? 0

      const expiryMs = Date.parse(expiry)
      books.push({
        expiry,
        expiryMs,
        daysToExpiry: daysBetween(nowIstMs, expiryMs),
        totalCallOI,
        totalPutOI,
        totalCallOIChange,
        totalPutOIChange,
        pcr,
        maxPain: mp,
        top3CallStrikes,
        top3PutStrikes,
        atmIVCall,
        atmIVPut,
        strikes: strikes.map(r => ({
          strike: r.strike,
          callOI: r.callOI,
          putOI: r.putOI,
          callOIChg: r.callOIChg,
          putOIChg: r.putOIChg,
        })),
      })
    }

    books.sort((a, b) => a.expiryMs - b.expiryMs)
    return { symbol: 'NIFTY', spot, fetchedAt: Date.now(), expiries: books }
  } catch (e) {
    log.err('NIFTY-MULTI-OC', `fetch failed: ${(e as Error).message}`)
    cachedSession = null
    return null
  }
}
