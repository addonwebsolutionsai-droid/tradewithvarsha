/**
 * Shareholding-pattern anchor — fetches FII / Promoter / Pledge data per
 * symbol and decides if it qualifies as a "NO-BRAINER" bet.
 *
 * No-brainer criteria (all three must hold):
 *   1. FII stake increasing OR > 10% (smart money is in)
 *   2. Promoter stake stable or increasing Q-on-Q (founders not exiting)
 *   3. Promoter pledge < 5% (no margin-call risk)
 *
 * Source: screener.in (free, well-formatted HTML with Q-on-Q shareholding
 * tables). The official NSE shareholding URL doesn't exist as a clean GET
 * endpoint — screener.in's `/company/SYMBOL/consolidated/` page is the de-
 * facto reliable source for Indian equity fundamentals.
 *
 * Falls back to null when blocked/empty — never throws so the weekly-pick
 * pipeline can't break on data unavailability.
 */
import { log } from '../util/logger'
import axios from 'axios'
import fs from 'fs/promises'
import path from 'path'

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

export interface ShareholdingPattern {
  symbol: string
  asOfQuarter: string             // e.g. "Mar-2026"
  promoterPct: number             // total promoter holding
  promoterPledgePct: number       // pct of promoter shares pledged
  promoterDeltaQoQ: number        // change vs prior quarter (percentage points)
  fiiPct: number
  fiiDeltaQoQ: number
  diiPct: number
  diiDeltaQoQ: number
  publicPct: number
  // 2026-05-04: market cap (₹ Cr) + book ratios scraped from the same screener.in
  // page so we can filter out obscure ultra-micro-caps without making a second
  // HTTP call. User feedback: "none of these are well-known companies" — we
  // need market-cap visibility to bias toward institutional-grade names.
  marketCapCr: number             // market cap in INR Crores; 0 if unparseable
  pe: number                      // trailing P/E ratio
  fetchedAt: number
}

export interface NoBrainerVerdict {
  isNoBrainer: boolean
  reasons: string[]               // why it qualifies (or why not)
  rawScore: number                // 0-15 contribution to the lens score
}

// 2026-05-07: cache is now disk-backed so it survives server restarts and
// the publish path always has shareholding data even if screener.in throws.
// Persists to data/shareholding-cache.json. TTL extended to 7 days because
// shareholding patterns update quarterly only; failed fetches stay 6h cached
// so we retry sooner than a successful fetch.
const cache = new Map<string, { data: ShareholdingPattern | null; ts: number }>()
const TTL_OK = 7 * 24 * 3600_000
const TTL_NULL = 6 * 3600_000
const CACHE_FILE = path.resolve(__dirname, '../../data/shareholding-cache.json')
let cacheLoaded = false
let cacheDirty = false

async function loadCacheFromDisk(): Promise<void> {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8')
    const obj = JSON.parse(raw) as Record<string, { data: ShareholdingPattern | null; ts: number }>
    for (const [k, v] of Object.entries(obj)) cache.set(k, v)
  } catch { /* file may not exist yet */ }
}

async function persistCacheToDisk(): Promise<void> {
  if (!cacheDirty) return
  cacheDirty = false
  try {
    const obj: Record<string, any> = {}
    for (const [k, v] of cache.entries()) obj[k] = v
    await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true })
    await fs.writeFile(CACHE_FILE, JSON.stringify(obj))
  } catch { /* skip — best-effort */ }
}

// Flush cache every 60s if dirty (debounce; avoids per-symbol I/O)
setInterval(() => { void persistCacheToDisk() }, 60_000).unref?.()

export async function getShareholding(symbol: string): Promise<ShareholdingPattern | null> {
  await loadCacheFromDisk()
  const k = symbol.toUpperCase()
  const hit = cache.get(k)
  if (hit) {
    const ttl = hit.data ? TTL_OK : TTL_NULL
    if (Date.now() - hit.ts < ttl) return hit.data
  }
  try {
    const url = `https://www.screener.in/company/${encodeURIComponent(k)}/consolidated/`
    const res = await axios.get(url, { timeout: 15_000, headers: HEADERS, validateStatus: s => s < 500 })
    if (res.status !== 200 || typeof res.data !== 'string') {
      // Try non-consolidated as fallback (smaller companies don't have consolidated)
      const url2 = `https://www.screener.in/company/${encodeURIComponent(k)}/`
      const res2 = await axios.get(url2, { timeout: 15_000, headers: HEADERS, validateStatus: s => s < 500 })
      if (res2.status !== 200 || typeof res2.data !== 'string') {
        cache.set(k, { data: null, ts: Date.now() }); cacheDirty = true
        return null
      }
      const parsed = parseScreenerHtml(res2.data, k)
      cache.set(k, { data: parsed, ts: Date.now() }); cacheDirty = true
      return parsed
    }
    const parsed = parseScreenerHtml(res.data, k)
    cache.set(k, { data: parsed, ts: Date.now() }); cacheDirty = true
    return parsed
  } catch (e) {
    cache.set(k, { data: null, ts: Date.now() }); cacheDirty = true
    return null
  }
}

/** Parse the quarterly-shp section of a screener.in company page. */
function parseScreenerHtml(html: string, symbol: string): ShareholdingPattern | null {
  // The quarterly-shp section is a <section> with id="shareholding" containing
  // a table with columns = quarters and rows = categories. Extract the last
  // 2 quarters of values for Promoters / FIIs / DIIs / Pledge.
  const secStart = html.indexOf('id="quarterly-shp"')
  if (secStart < 0) return null
  // Take a slice of the HTML containing the table — table ends before the
  // next big section (typically a "data-tab-id=" for yearly).
  const sec = html.slice(secStart, secStart + 8000)

  // Strip tags and collapse whitespace for easier parsing
  const text = sec.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

  // Quarter headers are sequence of "Mon Year" tokens (e.g. "Jun 2023 Sep 2023 ...")
  const quarterRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/g
  const quarterMatches = text.match(quarterRe) || []
  const latestQuarter = quarterMatches[quarterMatches.length - 1] ?? ''
  if (!quarterMatches.length) return null

  // Generic line extractor — given a category label, find the row and pull
  // all percentage values that follow it, up to the NEXT category or "+ -" key.
  function extractRow(label: string): number[] {
    const labelIdx = text.indexOf(label)
    if (labelIdx < 0) return []
    // Take 1500 chars after label; pull "X.XX%" tokens
    const slice = text.slice(labelIdx, labelIdx + 1500)
    // Stop at next category boundary (next "+" preceded by a known label)
    const stopRe = /(Promoters|FIIs|DIIs|Public|Government|Others|Shares pledged|No\. of Shareholders)/g
    let stopAt = slice.length
    let m: RegExpExecArray | null
    while ((m = stopRe.exec(slice))) {
      if (m.index > 5 && m[0] !== label.replace(/[+\s]+/g, '').trim()) {
        stopAt = m.index; break
      }
    }
    const usable = slice.slice(0, stopAt)
    const pcts = (usable.match(/-?\d+(?:\.\d+)?\s*%/g) || [])
      .map(s => parseFloat(s.replace('%', '').trim()))
      .filter(n => Number.isFinite(n))
    return pcts
  }

  const promoterValues = extractRow('Promoters')
  const fiiValues = extractRow('FIIs')
  const diiValues = extractRow('DIIs')
  const pledgeValues = extractRow('Shares pledged')

  if (!promoterValues.length || !fiiValues.length) return null

  const last = (a: number[]) => a[a.length - 1] ?? 0
  const prev = (a: number[]) => a[a.length - 2] ?? a[a.length - 1] ?? 0

  // ── Market cap + P/E from the same page (no extra HTTP call) ──
  // screener.in renders these in a top-of-page <ul class="ratios">… each <li>
  // has a name span and a number span. We strip tags and look for "Market Cap"
  // followed by a "₹ X,XXX Cr." number.
  const fullText = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
  let marketCapCr = 0
  const mcMatch = fullText.match(/Market\s*Cap\s*₹?\s*([\d,]+(?:\.\d+)?)\s*Cr/i)
  if (mcMatch) marketCapCr = parseFloat(mcMatch[1].replace(/,/g, '')) || 0
  let pe = 0
  const peMatch = fullText.match(/Stock\s*P\/?E\s*([\d,]+(?:\.\d+)?)/i)
  if (peMatch) pe = parseFloat(peMatch[1].replace(/,/g, '')) || 0

  return {
    symbol,
    asOfQuarter: latestQuarter,
    promoterPct: last(promoterValues),
    promoterPledgePct: last(pledgeValues),
    promoterDeltaQoQ: last(promoterValues) - prev(promoterValues),
    fiiPct: last(fiiValues),
    fiiDeltaQoQ: last(fiiValues) - prev(fiiValues),
    diiPct: last(diiValues),
    diiDeltaQoQ: last(diiValues) - prev(diiValues),
    publicPct: 0,
    marketCapCr,
    pe,
    fetchedAt: Date.now(),
  }
}

/**
 * Apply the "no-brainer" rules to a parsed ShareholdingPattern.
 * Returns isNoBrainer + score contribution (0-15) for the lens.
 */
export function evaluateNoBrainer(shp: ShareholdingPattern | null): NoBrainerVerdict {
  if (!shp) return { isNoBrainer: false, reasons: ['shareholding data unavailable'], rawScore: 0 }
  const reasons: string[] = []
  let score = 0

  // Rule 1: FII positioning
  const fiiInfusing = shp.fiiDeltaQoQ > 0.3 || shp.fiiPct > 10
  if (shp.fiiDeltaQoQ > 0.3) reasons.push(`FII +${shp.fiiDeltaQoQ.toFixed(2)}pp QoQ (infusing)`)
  else if (shp.fiiPct > 10) reasons.push(`FII ${shp.fiiPct.toFixed(1)}% (high baseline)`)
  if (fiiInfusing) score += 5

  // Rule 2: Promoter not exiting
  const promoterStable = shp.promoterDeltaQoQ >= -0.2     // tolerate -0.2pp tax-loss noise
  if (promoterStable) {
    if (shp.promoterDeltaQoQ > 0.1) reasons.push(`promoter +${shp.promoterDeltaQoQ.toFixed(2)}pp (increasing)`)
    else reasons.push(`promoter stable (${shp.promoterPct.toFixed(1)}%)`)
    score += 5
  } else {
    reasons.push(`promoter ${shp.promoterDeltaQoQ.toFixed(2)}pp (exiting — caution)`)
  }

  // Rule 3: Pledge low
  const pledgeLow = shp.promoterPledgePct < 5
  if (pledgeLow) {
    reasons.push(`pledge ${shp.promoterPledgePct.toFixed(1)}% (clean)`)
    score += 5
  } else {
    reasons.push(`pledge ${shp.promoterPledgePct.toFixed(1)}% (margin-call risk)`)
  }

  const isNoBrainer = fiiInfusing && promoterStable && pledgeLow
  return { isNoBrainer, reasons, rawScore: score }
}

/** One-call helper used by the weekly-pick scorer. */
export async function scoreShareholding(symbol: string): Promise<NoBrainerVerdict & { shp: ShareholdingPattern | null }> {
  const shp = await getShareholding(symbol).catch(() => null)
  return { ...evaluateNoBrainer(shp), shp }
}
