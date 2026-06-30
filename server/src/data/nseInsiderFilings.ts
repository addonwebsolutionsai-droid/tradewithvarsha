/**
 * NSE INSIDER TRADING + SAST FILINGS SCRAPER
 *
 * User directive 2026-06-30: "Insider/SAST scraper — SEBI publishes
 * promoter buys >0.5% daily; we'd parse + show on a new tab. Smartest
 * single signal in Indian markets (insider knowledge). Free data."
 *
 * Two NSE feeds (both public, no auth required, cookie-warmup needed):
 *
 *   1. PIT (Prohibition of Insider Trading) — Regulation 7(2)
 *      Promoters / KMP / directors transacting in own shares
 *      URL: https://www.nseindia.com/api/corporates-pit?index=equities
 *
 *   2. SAST (Substantial Acquisition of Shares & Takeover)
 *      Any acquirer crossing 5%/10%/15%/etc. thresholds
 *      URL: https://www.nseindia.com/api/corporate-sast-reg29?index=equities
 *
 * Output: classified by direction (BUY / SELL) + actor type (PROMOTER /
 * KMP / DIRECTOR / RELATIVE / EXTERNAL_ACQUIRER) with aggregated
 * per-symbol footprint.
 */
import axios from 'axios'
import { log } from '../util/logger'

const NSE_BASE = 'https://www.nseindia.com'
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/companies-listing/corporate-filings-insider-trading',
}

export type ActorType = 'PROMOTER' | 'KMP' | 'DIRECTOR' | 'PROMOTER_GROUP' | 'IMMEDIATE_RELATIVE' | 'EXTERNAL_ACQUIRER' | 'OTHER'
export type TxnDirection = 'BUY' | 'SELL' | 'PLEDGE' | 'REVOKE'

export interface InsiderFiling {
  symbol: string
  filingDate: string                 // ISO date
  reportType: 'PIT' | 'SAST'         // Regulation source
  acquirer: string                   // name of person/entity
  actorType: ActorType
  direction: TxnDirection
  shares: number
  pricePerShare: number | null
  valueLakhs: number                 // total value in lakhs (10⁵)
  pctOfCapital: number | null        // % of total paid-up capital (SAST especially)
  postTxnHolding: number | null      // post-transaction holding %
  mode: string                       // market purchase / off-market / IPO / etc.
}

export interface SymbolInsiderFootprint {
  symbol: string
  windowDays: number
  promoterBuyValueLakhs: number
  promoterSellValueLakhs: number
  kmpBuyValueLakhs: number
  kmpSellValueLakhs: number
  externalAcquirerBuyLakhs: number
  totalNetBuyLakhs: number
  filingCount: number
  topActors: string[]
  signal: 'STRONG_INSIDER_BUY' | 'INSIDER_BUY' | 'NEUTRAL' | 'INSIDER_SELL' | 'STRONG_INSIDER_SELL'
  reasoning: string[]
}

type AxClient = ReturnType<typeof axios.create>

async function withSession<T>(fn: (client: AxClient) => Promise<T>): Promise<T | null> {
  try {
    const cookieJar: string[] = []
    const client = axios.create({
      baseURL: NSE_BASE,
      headers: HEADERS,
      withCredentials: true,
      timeout: 18_000,
    })
    client.interceptors.response.use(res => {
      const setCookie = res.headers['set-cookie']
      if (Array.isArray(setCookie)) cookieJar.push(...setCookie.map(s => s.split(';')[0]))
      return res
    })
    // Warmup — visit the corporate-filings page to establish cookies
    await client.get('/companies-listing/corporate-filings-insider-trading', { headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml' }, validateStatus: () => true }).catch(() => null)
    client.defaults.headers.common.Cookie = cookieJar.join('; ')
    return await fn(client)
  } catch (e) {
    log.warn('NSE-INSIDER', `session failed: ${(e as Error).message}`)
    return null
  }
}

// Classify the actor based on category text NSE returns.
function classifyActor(category: string): ActorType {
  const c = (category || '').toUpperCase()
  if (c.includes('PROMOTER') && c.includes('GROUP')) return 'PROMOTER_GROUP'
  if (c.includes('PROMOTER')) return 'PROMOTER'
  if (c.includes('KMP') || c.includes('KEY MANAGERIAL')) return 'KMP'
  if (c.includes('DIRECTOR')) return 'DIRECTOR'
  if (c.includes('RELATIVE') || c.includes('SPOUSE') || c.includes('FAMILY')) return 'IMMEDIATE_RELATIVE'
  if (c.includes('ACQUIRER') || c.includes('INVESTOR')) return 'EXTERNAL_ACQUIRER'
  return 'OTHER'
}

function classifyDirection(mode: string, txnType: string): TxnDirection {
  const t = (txnType || '').toUpperCase()
  const m = (mode || '').toUpperCase()
  if (t.includes('PURCHASE') || t.includes('ACQUISITION') || t.includes('BUY')) return 'BUY'
  if (t.includes('SALE') || t.includes('DISPOSAL') || t.includes('SELL')) return 'SELL'
  if (t.includes('PLEDGE')) return 'PLEDGE'
  if (t.includes('REVOKE')) return 'REVOKE'
  if (m.includes('PURCHASE')) return 'BUY'
  if (m.includes('SALE')) return 'SELL'
  return 'BUY'
}

// — PIT (Reg 7) — insider transactions —
export async function fetchPitFilings(days = 14): Promise<InsiderFiling[]> {
  return await withSession(async client => {
    const res = await client.get('/api/corporates-pit', {
      params: { index: 'equities', period: 'last_n_days', from_date: '', to_date: '' },
      validateStatus: () => true,
    })
    if (res.status !== 200 || !res.data?.data) {
      log.warn('NSE-INSIDER', `PIT fetch HTTP ${res.status}`)
      return []
    }
    const cutoff = Date.now() - days * 86400_000
    const out: InsiderFiling[] = []
    for (const row of res.data.data) {
      try {
        // NSE PIT response field names — they shift occasionally; defensive lookups
        const symbol = String(row.symbol ?? row.SYMBOL ?? '').toUpperCase().trim()
        if (!symbol || symbol.length > 20) continue
        const dateStr = row.date ?? row.tdpDate ?? row.acquisitionDate ?? row.broadcastDate ?? ''
        const filingDate = parseNseDate(dateStr)
        if (!filingDate || new Date(filingDate).getTime() < cutoff) continue
        const acquirer = String(row.acqName ?? row.personName ?? row.acquirer ?? '').trim()
        const category = String(row.personCategory ?? row.category ?? '').trim()
        const txnType = String(row.acqMode ?? row.transactionType ?? row.txnType ?? '').trim()
        const shares = parseFloat(String(row.secAcq ?? row.numberOfShares ?? row.shares ?? 0).replace(/,/g, '')) || 0
        const value = parseFloat(String(row.secVal ?? row.totalValue ?? row.value ?? 0).replace(/,/g, '')) || 0
        const valueLakhs = value > 1e6 ? value / 1e5 : value      // NSE sometimes returns rupees vs lakhs
        const postHolding = parseFloat(String(row.afterAcqSharesPer ?? row.postAcquisition ?? 0).replace(/,/g, '')) || null
        out.push({
          symbol,
          filingDate,
          reportType: 'PIT',
          acquirer,
          actorType: classifyActor(category),
          direction: classifyDirection(txnType, txnType),
          shares,
          pricePerShare: shares > 0 && valueLakhs > 0 ? +(valueLakhs * 1e5 / shares).toFixed(2) : null,
          valueLakhs,
          pctOfCapital: null,
          postTxnHolding: postHolding,
          mode: txnType,
        })
      } catch { /* skip malformed row */ }
    }
    log.ok('NSE-INSIDER', `PIT: ${out.length} filings in last ${days}d`)
    return out
  }) ?? []
}

// — SAST (Reg 29) — substantial acquirer crossing thresholds —
export async function fetchSastFilings(days = 30): Promise<InsiderFiling[]> {
  return await withSession(async client => {
    const res = await client.get('/api/corporate-sast-reg29', {
      params: { index: 'equities' },
      validateStatus: () => true,
    })
    if (res.status !== 200 || !res.data?.data) {
      log.warn('NSE-INSIDER', `SAST fetch HTTP ${res.status}`)
      return []
    }
    const cutoff = Date.now() - days * 86400_000
    const out: InsiderFiling[] = []
    for (const row of res.data.data) {
      try {
        const symbol = String(row.symbol ?? row.SYMBOL ?? '').toUpperCase().trim()
        if (!symbol || symbol.length > 20) continue
        const dateStr = row.acquisitionDate ?? row.broadcastDate ?? row.timestamp ?? ''
        const filingDate = parseNseDate(dateStr)
        if (!filingDate || new Date(filingDate).getTime() < cutoff) continue
        const acquirer = String(row.acqName ?? row.acquirer ?? row.persons ?? '').trim()
        const txnType = String(row.acqMode ?? row.modeOfAcquisition ?? '').trim()
        const shares = parseFloat(String(row.secAcq ?? row.numberOfShares ?? 0).replace(/,/g, '')) || 0
        const pctOfCapital = parseFloat(String(row.secAcqShareholdingPer ?? row.percentOfCapital ?? 0).replace(/,/g, '')) || null
        const postHolding = parseFloat(String(row.afterAcqSharesPer ?? row.postAcquisition ?? 0).replace(/,/g, '')) || null
        const value = parseFloat(String(row.secVal ?? row.totalValue ?? 0).replace(/,/g, '')) || 0
        const valueLakhs = value > 1e6 ? value / 1e5 : value
        out.push({
          symbol,
          filingDate,
          reportType: 'SAST',
          acquirer,
          actorType: 'EXTERNAL_ACQUIRER',
          direction: classifyDirection(txnType, txnType),
          shares,
          pricePerShare: shares > 0 && valueLakhs > 0 ? +(valueLakhs * 1e5 / shares).toFixed(2) : null,
          valueLakhs,
          pctOfCapital,
          postTxnHolding: postHolding,
          mode: txnType,
        })
      } catch { /* skip */ }
    }
    log.ok('NSE-INSIDER', `SAST: ${out.length} filings in last ${days}d`)
    return out
  }) ?? []
}

// NSE returns dates in inconsistent formats — best-effort parser.
function parseNseDate(s: string): string | null {
  if (!s) return null
  const cleaned = s.replace(/\s+/g, ' ').trim()
  // Try standard ISO / ASCII patterns
  const formats = [
    /^(\d{2})-([A-Za-z]{3})-(\d{4})/,            // 30-Jun-2026
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})/,            // 30/06/2026
    /^(\d{4})-(\d{2})-(\d{2})/,                  // ISO date
  ]
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  }
  let m
  if ((m = cleaned.match(formats[0]))) {
    const mm = months[m[2]] ?? '01'
    return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`
  }
  if ((m = cleaned.match(formats[1]))) {
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  }
  if ((m = cleaned.match(formats[2]))) {
    return `${m[1]}-${m[2]}-${m[3]}`
  }
  return null
}

// Aggregate filings by symbol, compute signal.
export function aggregateInsiderFootprint(filings: InsiderFiling[], windowDays = 30): SymbolInsiderFootprint[] {
  const bySym = new Map<string, SymbolInsiderFootprint>()
  for (const f of filings) {
    let row = bySym.get(f.symbol)
    if (!row) {
      row = {
        symbol: f.symbol,
        windowDays,
        promoterBuyValueLakhs: 0,
        promoterSellValueLakhs: 0,
        kmpBuyValueLakhs: 0,
        kmpSellValueLakhs: 0,
        externalAcquirerBuyLakhs: 0,
        totalNetBuyLakhs: 0,
        filingCount: 0,
        topActors: [],
        signal: 'NEUTRAL',
        reasoning: [],
      }
      bySym.set(f.symbol, row)
    }
    row.filingCount++
    if (f.actorType === 'PROMOTER' || f.actorType === 'PROMOTER_GROUP') {
      if (f.direction === 'BUY') row.promoterBuyValueLakhs += f.valueLakhs
      if (f.direction === 'SELL') row.promoterSellValueLakhs += f.valueLakhs
    } else if (f.actorType === 'KMP' || f.actorType === 'DIRECTOR') {
      if (f.direction === 'BUY') row.kmpBuyValueLakhs += f.valueLakhs
      if (f.direction === 'SELL') row.kmpSellValueLakhs += f.valueLakhs
    } else if (f.actorType === 'EXTERNAL_ACQUIRER' && f.direction === 'BUY') {
      row.externalAcquirerBuyLakhs += f.valueLakhs
    }
    if (f.acquirer && !row.topActors.includes(f.acquirer) && row.topActors.length < 3) {
      row.topActors.push(f.acquirer.slice(0, 40))
    }
  }
  for (const row of bySym.values()) {
    row.totalNetBuyLakhs = +(
      (row.promoterBuyValueLakhs - row.promoterSellValueLakhs) +
      (row.kmpBuyValueLakhs - row.kmpSellValueLakhs) +
      row.externalAcquirerBuyLakhs
    ).toFixed(1)
    // Classify signal
    const promoterNet = row.promoterBuyValueLakhs - row.promoterSellValueLakhs
    if (promoterNet >= 500 || row.externalAcquirerBuyLakhs >= 1000) {
      row.signal = 'STRONG_INSIDER_BUY'
      row.reasoning.push(`promoter net buy ₹${(promoterNet / 100).toFixed(1)}Cr`)
      if (row.externalAcquirerBuyLakhs > 0) row.reasoning.push(`SAST acquirer ₹${(row.externalAcquirerBuyLakhs / 100).toFixed(1)}Cr`)
    } else if (promoterNet >= 100 || (row.kmpBuyValueLakhs - row.kmpSellValueLakhs) >= 50) {
      row.signal = 'INSIDER_BUY'
      if (promoterNet > 0) row.reasoning.push(`promoter buying ₹${(promoterNet / 100).toFixed(1)}Cr`)
      if (row.kmpBuyValueLakhs > row.kmpSellValueLakhs) row.reasoning.push(`KMP buying ₹${((row.kmpBuyValueLakhs - row.kmpSellValueLakhs) / 100).toFixed(1)}Cr`)
    } else if (promoterNet <= -500) {
      row.signal = 'STRONG_INSIDER_SELL'
      row.reasoning.push(`promoter net sell ₹${(Math.abs(promoterNet) / 100).toFixed(1)}Cr`)
    } else if (promoterNet <= -100) {
      row.signal = 'INSIDER_SELL'
      row.reasoning.push(`promoter selling ₹${(Math.abs(promoterNet) / 100).toFixed(1)}Cr`)
    } else {
      row.signal = 'NEUTRAL'
      row.reasoning.push(`mixed flow (${row.filingCount} filings)`)
    }
    if (row.topActors.length) row.reasoning.push(`actors: ${row.topActors.slice(0, 2).join(', ')}`)
  }
  return Array.from(bySym.values()).sort((a, b) => b.totalNetBuyLakhs - a.totalNetBuyLakhs)
}
