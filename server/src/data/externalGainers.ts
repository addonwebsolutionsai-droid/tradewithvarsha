/**
 * External-source gainers scraper — pulls today's top gainers from the
 * 3 sites the user named:
 *   1. https://ticker.finology.in/market/top-gainers
 *   2. https://trendlyne.com/stock-screeners/price-based/top-gainers/today/
 *   3. https://groww.in/markets/top-gainers
 *
 * Falls back gracefully if any site blocks scraping. Output is a deduped
 * list of (symbol, gainPct, sources[]). Used by the daily miss-analyzer
 * cron to verify our own NIFTY-500 catch rate against what the wider
 * market saw.
 *
 * NOTE: web scraping is fragile (HTML changes break selectors). Each
 * extractor is wrapped in try/catch and returns [] on failure. The
 * caller treats partial data as valid.
 */
import axios from 'axios'
import { log } from '../util/logger'

export interface ExternalGainer {
  symbol: string
  name?: string
  gainPct: number
  sources: string[]
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16 Safari/605.1.15'
const HEADERS = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-IN,en;q=0.9' }

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim()
}

async function fetchHtml(url: string, timeoutMs = 12_000): Promise<string | null> {
  try {
    const res = await axios.get(url, { headers: HEADERS, timeout: timeoutMs, validateStatus: () => true })
    if (res.status !== 200) {
      log.warn('EXT-GAINERS', `${url} → HTTP ${res.status}`)
      return null
    }
    return typeof res.data === 'string' ? res.data : String(res.data)
  } catch (e) {
    log.warn('EXT-GAINERS', `${url} fetch error: ${(e as Error).message}`)
    return null
  }
}

// — FINOLOGY — table rows look like:
//   <tr><td>Stock Name</td><td>240.00</td><td>+12.5%</td>...
async function parseFinology(html: string): Promise<{ symbol: string; gainPct: number }[]> {
  const out: { symbol: string; gainPct: number }[] = []
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(html))) {
    const row = m[1]
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g
    const cells: string[] = []
    let c: RegExpExecArray | null
    while ((c = cellRe.exec(row))) cells.push(clean(c[1].replace(/<[^>]+>/g, '')))
    if (cells.length < 3) continue
    const name = cells[0]
    // look for a % number in any cell
    let pct: number | null = null
    for (const cell of cells.slice(1)) {
      const pm = /([+-]?\d+(?:\.\d+)?)\s*%/.exec(cell)
      if (pm) { pct = parseFloat(pm[1]); break }
    }
    if (!name || pct == null || pct < 5) continue
    // crude symbol extraction (caller cross-refs anyway)
    out.push({ symbol: name.split(/[\s(]+/)[0].toUpperCase(), gainPct: pct })
  }
  return out.slice(0, 30)
}

// — TRENDLYNE — embedded JSON-like data; pragmatic: extract %-patterns
async function parseTrendlyne(html: string): Promise<{ symbol: string; gainPct: number }[]> {
  const out: { symbol: string; gainPct: number }[] = []
  // Trendlyne renders stock rows as <a href="/equity/...">SYMBOL</a> followed
  // by % cell nearby. Look for sequence.
  const re = /\/equity\/[\w-]+\/(\w+?)\/[\w-]+\/[\w-]*?[\s\S]{0,500}?([+-]?\d+(?:\.\d+)?)\s*%/g
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  while ((m = re.exec(html))) {
    const sym = m[1].toUpperCase()
    const pct = parseFloat(m[2])
    if (!sym || pct < 5 || seen.has(sym)) continue
    seen.add(sym)
    out.push({ symbol: sym, gainPct: pct })
    if (out.length >= 30) break
  }
  return out
}

// — KOTAK NEO — index-specific top gainer pages.
// URL pattern: kotakneo.com/share-market-today/top-gainers/{index-slug}/
// Each page renders a table; rows have symbol + price + %change cells.
async function parseKotakNeo(html: string): Promise<{ symbol: string; gainPct: number }[]> {
  const out: { symbol: string; gainPct: number }[] = []
  // Strategy 1: find any <a> ticker symbol followed by a % within 500 chars
  const re1 = /<a[^>]*>([A-Z][A-Z0-9&]{1,15})<\/a>[\s\S]{0,800}?([+-]?\d+(?:\.\d+)?)\s*%/g
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  while ((m = re1.exec(html))) {
    const sym = m[1].toUpperCase()
    const pct = parseFloat(m[2])
    if (!sym || pct < 5 || seen.has(sym)) continue
    if (sym.length < 2 || /^(NSE|BSE|NIFTY)$/.test(sym)) continue
    seen.add(sym)
    out.push({ symbol: sym, gainPct: pct })
    if (out.length >= 30) break
  }
  return out
}

// — GROWW — Groww often serves data via JS-injected JSON. Fallback: extract
// "TICKERSYM"-like patterns. Groww may block bot UAs, so this often returns 0.
async function parseGroww(html: string): Promise<{ symbol: string; gainPct: number }[]> {
  const out: { symbol: string; gainPct: number }[] = []
  // Look for "symbol":"XYZ","percentChange":N pattern in any embedded JSON
  const re = /"(?:symbol|nseScriptCode|companyShortName)"\s*:\s*"(\w+)"[^}]*?"(?:percentChange|dayChangePerc)"\s*:\s*([+-]?\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  const seen = new Set<string>()
  while ((m = re.exec(html))) {
    const sym = m[1].toUpperCase()
    const pct = parseFloat(m[2])
    if (!sym || pct < 5 || seen.has(sym)) continue
    seen.add(sym)
    out.push({ symbol: sym, gainPct: pct })
    if (out.length >= 30) break
  }
  return out
}

export async function fetchExternalGainers(): Promise<{
  bySite: Record<string, { symbol: string; gainPct: number }[]>
  merged: ExternalGainer[]
}> {
  // 2026-06-10: User added 5 Kotak Neo URLs (index-specific gainer pages).
  // Each Kotak page is independently fetched; failures don't affect others.
  const KOTAK_URLS = [
    { url: 'https://www.kotakneo.com/share-market-today/top-gainers/nifty-500/',         src: 'kotak-nifty500' },
    { url: 'https://www.kotakneo.com/share-market-today/top-gainers/nifty-midcap-50/',   src: 'kotak-midcap50' },
    { url: 'https://www.kotakneo.com/share-market-today/top-gainers/nifty-midcap-100/',  src: 'kotak-midcap100' },
    { url: 'https://www.kotakneo.com/share-market-today/top-gainers/nifty-midcap-150/',  src: 'kotak-midcap150' },
    { url: 'https://www.kotakneo.com/share-market-today/top-gainers/nifty-smallcap-100/',src: 'kotak-smallcap100' },
  ]
  log.info('EXT-GAINERS', `fetching gainers from 3 base sites + ${KOTAK_URLS.length} Kotak Neo pages...`)
  const [finHtml, trendHtml, growwHtml, ...kotakHtmls] = await Promise.all([
    fetchHtml('https://ticker.finology.in/market/top-gainers'),
    fetchHtml('https://trendlyne.com/stock-screeners/price-based/top-gainers/today/'),
    fetchHtml('https://groww.in/markets/top-gainers'),
    ...KOTAK_URLS.map(k => fetchHtml(k.url)),
  ])
  const fin = finHtml ? await parseFinology(finHtml).catch(() => []) : []
  const trend = trendHtml ? await parseTrendlyne(trendHtml).catch(() => []) : []
  const groww = growwHtml ? await parseGroww(growwHtml).catch(() => []) : []
  const kotakResults: { src: string; rows: { symbol: string; gainPct: number }[] }[] = []
  for (let i = 0; i < KOTAK_URLS.length; i++) {
    const html = kotakHtmls[i]
    const rows = html ? await parseKotakNeo(html).catch(() => []) : []
    kotakResults.push({ src: KOTAK_URLS[i].src, rows })
  }
  log.info('EXT-GAINERS', `finology=${fin.length} · trendlyne=${trend.length} · groww=${groww.length} · kotak=[${kotakResults.map(k => `${k.src.replace('kotak-', '')}:${k.rows.length}`).join(' ')}]`)

  // Merge with source tracking
  const map = new Map<string, ExternalGainer>()
  const add = (rows: { symbol: string; gainPct: number }[], src: string) => {
    for (const r of rows) {
      const existing = map.get(r.symbol)
      if (existing) {
        if (!existing.sources.includes(src)) existing.sources.push(src)
        existing.gainPct = Math.max(existing.gainPct, r.gainPct)
      } else {
        map.set(r.symbol, { symbol: r.symbol, gainPct: r.gainPct, sources: [src] })
      }
    }
  }
  add(fin, 'finology')
  add(trend, 'trendlyne')
  add(groww, 'groww')
  for (const k of kotakResults) add(k.rows, k.src)

  const merged = Array.from(map.values()).sort((a, b) => b.gainPct - a.gainPct)
  const bySite: Record<string, { symbol: string; gainPct: number }[]> = {
    finology: fin, trendlyne: trend, groww: groww,
  }
  for (const k of kotakResults) bySite[k.src] = k.rows
  return { bySite, merged }
}
