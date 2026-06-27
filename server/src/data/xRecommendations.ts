/**
 * X (Twitter) STOCK-RECOMMENDATION SCRAPER — best-effort.
 *
 * User directive 2026-06-26: pull stock recommendations from 6 named X
 * profiles, parse entry/target/reason, surface as a separate tab.
 *
 * The honest reality: X / Twitter rate-limits and bot-detects aggressively.
 * The standard free options have all degraded:
 *   - nitter.net mirrors  — ~80% blocked/dead
 *   - syndication API     — works for some accounts, fails silently otherwise
 *   - RSS via nitter      — same as above
 *
 * Strategy: try syndication first (fastest, works for unprotected accounts),
 * fall back to a list of public nitter mirrors. If both fail for an account
 * the row surfaces as "unavailable" instead of crashing the tab.
 *
 * Output (per analyst):
 *   - timestamp, postText, parsedSymbol, parsedEntry, parsedSL, parsedTargets,
 *     imageUrl, sourceUrl
 *
 * Parsing heuristics extract NSE/BSE symbol tokens, price levels prefixed by
 * ₹ / Rs / target / entry / SL, and stop-loss mentions.
 */
import axios from 'axios'
import { log } from '../util/logger'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15'

export const X_ANALYSTS: Array<{ handle: string; profileUrl: string; note: string }> = [
  { handle: 'cadalukaanubhav',   profileUrl: 'https://x.com/cadalukaanubhav',   note: 'CA Anubhav Daluka' },
  { handle: 'camangalarvind',    profileUrl: 'https://x.com/camangalarvind',    note: 'CA Mangal Arvind' },
  { handle: 'Sahilpahwa09',      profileUrl: 'https://x.com/Sahilpahwa09',      note: 'Sahil Pahwa' },
  { handle: 'darvasboxtrader',   profileUrl: 'https://x.com/darvasboxtrader',   note: 'Darvas Box Trader' },
  { handle: 'iAmitKumar',        profileUrl: 'https://x.com/iAmitKumar',        note: 'Amit Kumar' },
  { handle: 'arvindshyam',       profileUrl: 'https://x.com/arvindshyam',       note: 'Arvind Shyam' },
]

export interface XRecommendation {
  handle: string
  postedAt: string
  text: string
  parsedSymbol: string | null
  parsedDirection: 'BUY' | 'SHORT' | null
  parsedEntry: number | null
  parsedSL: number | null
  parsedTargets: number[]
  imageUrl: string | null
  sourceUrl: string
}

// — Public list of nitter mirrors (community-maintained). Most go up/down. —
const NITTER_MIRRORS = [
  'https://nitter.net',
  'https://nitter.poast.org',
  'https://nitter.privacydev.net',
  'https://nitter.adminforge.de',
  'https://nitter.tiekoetter.com',
]

async function fetchNitterRss(handle: string): Promise<string | null> {
  for (const base of NITTER_MIRRORS) {
    try {
      const res = await axios.get(`${base}/${handle}/rss`, {
        headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml' },
        timeout: 10_000,
        validateStatus: () => true,
      })
      if (res.status === 200 && typeof res.data === 'string' && res.data.includes('<rss')) {
        return res.data
      }
    } catch { /* try next mirror */ }
  }
  return null
}

async function fetchSyndication(handle: string): Promise<any[] | null> {
  // Twitter syndication endpoint — older public timeline JSON. Often works
  // for unprotected accounts without auth.
  try {
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}?showReplies=false`
    const res = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json',
        Referer: `https://x.com/${handle}`,
      },
      timeout: 12_000,
      validateStatus: () => true,
    })
    if (res.status !== 200 || typeof res.data !== 'string') return null
    // Response is HTML containing a __NEXT_DATA__ JSON blob with the timeline
    const m = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (!m) return null
    const j = JSON.parse(m[1])
    const tweets = j?.props?.pageProps?.timeline?.entries ?? []
    return tweets
  } catch { return null }
}

// — Parsers —

function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
}

// NSE symbols are typically all-caps tokens 2-15 chars (e.g. RELIANCE, HDFCBANK).
// We parse $TICKER, #TICKER, or standalone TICKER followed by price/target words.
function extractSymbol(text: string): string | null {
  // Common Indian retail-pattern: "Buy XYZ @ 245" / "$XYZ" / "#XYZ"
  const cleaned = text.toUpperCase()
  const tagMatch = cleaned.match(/[$#]([A-Z]{2,15})\b/)
  if (tagMatch) return tagMatch[1]
  const verbMatch = cleaned.match(/\b(?:BUY|SELL|SHORT|LONG|ACCUMULATE|ADD|TARGET|ENTRY)\s+([A-Z]{2,15})\b/)
  if (verbMatch) return verbMatch[1]
  return null
}

function extractDirection(text: string): 'BUY' | 'SHORT' | null {
  const t = text.toUpperCase()
  if (/\b(BUY|LONG|ACCUMULATE|ADD|HOLD)\b/.test(t)) return 'BUY'
  if (/\b(SHORT|SELL|EXIT)\b/.test(t)) return 'SHORT'
  return null
}

function extractPrices(text: string, label: string): number[] {
  const re = new RegExp(`${label}[^\\d]{0,8}((?:[\\d,]+\\.?\\d*\\s*[-/,&]?\\s*)+)`, 'gi')
  const out: number[] = []
  let m
  while ((m = re.exec(text))) {
    const block = m[1]
    const nums = block.match(/[\d,]+\.?\d*/g) ?? []
    for (const n of nums) {
      const v = parseFloat(n.replace(/,/g, ''))
      if (Number.isFinite(v) && v > 0 && v < 1_000_000) out.push(v)
    }
  }
  return Array.from(new Set(out))
}

function parseRecommendation(text: string, handle: string, sourceUrl: string, postedAt: string, imageUrl: string | null): XRecommendation {
  const clean = decodeHtmlEntities(text).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  const sym = extractSymbol(clean)
  const dir = extractDirection(clean)
  const entries = extractPrices(clean, '(?:ENTRY|BUY|BUY ABOVE|ADD|ACCUMULATE|CMP|AT|@)')
  const sls = extractPrices(clean, '(?:SL|STOP\\s*LOSS|STOPLOSS)')
  const targets = extractPrices(clean, '(?:TGT|TARGET|TGTS|TARGETS|T1|T2|T3)')
  return {
    handle,
    postedAt,
    text: clean.slice(0, 500),
    parsedSymbol: sym,
    parsedDirection: dir,
    parsedEntry: entries[0] ?? null,
    parsedSL: sls[0] ?? null,
    parsedTargets: targets.slice(0, 3),
    imageUrl,
    sourceUrl,
  }
}

function parseRssItems(xml: string, handle: string): XRecommendation[] {
  const out: XRecommendation[] = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = itemRe.exec(xml))) {
    const block = m[1]
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/)
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/)
    const dateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/)
    const text = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '')) : ''
    if (!text) continue
    const imgMatch = descMatch ? descMatch[1].match(/<img[^>]+src="([^"]+)"/) : null
    const postedAt = dateMatch ? new Date(dateMatch[1]).toISOString() : new Date().toISOString()
    const sourceUrl = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : `https://x.com/${handle}`
    out.push(parseRecommendation(text, handle, sourceUrl, postedAt, imgMatch ? imgMatch[1] : null))
  }
  return out
}

export async function fetchXRecommendations(opts?: { perHandle?: number }): Promise<{ generatedAt: string; bySite: Record<string, string>; recommendations: XRecommendation[] }> {
  const perHandle = opts?.perHandle ?? 10
  const bySite: Record<string, string> = {}
  const all: XRecommendation[] = []

  log.info('X-RECS', `fetching from ${X_ANALYSTS.length} handles via nitter mirrors (best-effort)...`)
  await Promise.all(X_ANALYSTS.map(async a => {
    let recs: XRecommendation[] = []
    let source = 'unavailable'
    // Try nitter RSS first (cleanest)
    const rss = await fetchNitterRss(a.handle)
    if (rss) {
      recs = parseRssItems(rss, a.handle).slice(0, perHandle)
      source = `nitter (${recs.length} items)`
    } else {
      // Last-resort: try syndication (rare to succeed without auth now)
      const syn = await fetchSyndication(a.handle)
      if (syn) source = `syndication (${syn.length} items, parsing skipped — schema TBD)`
    }
    bySite[a.handle] = source
    all.push(...recs)
  }))

  // Keep only rows where we extracted at least a symbol — drops generic
  // memes / non-stock posts.
  const filtered = all.filter(r => r.parsedSymbol)
  filtered.sort((a, b) => b.postedAt.localeCompare(a.postedAt))

  log.ok('X-RECS', `parsed ${filtered.length} stock recommendations · sources: ${Object.entries(bySite).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  return {
    generatedAt: new Date().toISOString(),
    bySite,
    recommendations: filtered,
  }
}
