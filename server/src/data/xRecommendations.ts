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
import fs from 'fs'
import path from 'path'
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

// 2026-06-26: hard blacklist of common non-stock all-caps tokens that
// the symbol extractor would otherwise grab. Religious greetings,
// motivational phrases, festival names, sports/celebrity names,
// generic shouts.
const NON_STOCK_TOKENS = new Set([
  // Religious / devotional
  'SITARAMHANUMAN', 'JAISHREERAM', 'JAIHANUMAN', 'JAIMATA', 'JAIBOLE',
  'JAIHIND', 'JAIBHIM', 'OMNAMAH', 'OMSHIVAY', 'OMNAMOH',
  // Greetings / festival
  'GOODMORNING', 'GOODEVENING', 'GOODNIGHT', 'NAMASTE',
  'HAPPYDIWALI', 'HAPPYHOLI', 'HAPPYNEWYEAR', 'EIDMUBARAK',
  'HAPPY', 'HAPPYBIRTHDAY',
  // Generic announcements
  'CONGRATS', 'CONGRATULATIONS', 'WELCOME', 'THANKYOU', 'THANKS',
  'BREAKING', 'LIVE', 'NEWS', 'UPDATE', 'ALERT', 'IMPORTANT',
  // Indices — belong in Options tab not X-Recs
  'NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'NIFTY50', 'BANKEX',
  'NIFTYIT', 'NIFTYAUTO', 'NIFTYPHARMA', 'NIFTYFMCG', 'NIFTYMETAL',
  // Geo / locale
  'INDIA', 'BHARAT', 'NSE', 'BSE', 'SEBI', 'RBI', 'GOI', 'PSU',
  // Generic finance words
  'TRADE', 'TRADING', 'INVEST', 'INVESTOR', 'STOCKS', 'STOCK', 'MARKET',
  'EQUITY', 'EQUITIES', 'PORTFOLIO', 'CAPITAL', 'WEALTH', 'PROFIT',
  'LOSS', 'GAIN', 'RETURN', 'RETURNS', 'INDIAN', 'INDIANS',
  // Chart / pattern jargon (not tickers)
  'CHART', 'CHARTS', 'PATTERN', 'PATTERNS', 'SETUP', 'BREAKOUT',
  'BREAKDOWN', 'REVERSAL', 'CONTINUATION', 'WEEKLY', 'DAILY', 'MONTHLY',
  // Cricket / sports (Virat Kohli post leak fix)
  'VIRAT', 'KOHLI', 'VIRATKOHLI', 'ROHIT', 'SHARMA', 'ROHITSHARMA',
  'DHONI', 'MSDHONI', 'SACHIN', 'TENDULKAR', 'GILL', 'SHUBMAN',
  'BUMRAH', 'JADEJA', 'RAHUL', 'RISHABH', 'PANT', 'HARDIK', 'PANDYA',
  'IPL', 'BCCI', 'RCB', 'CSK', 'MI', 'GT', 'SRH', 'KKR', 'PBKS',
  'DC', 'RR', 'LSG', 'CRICKET', 'WORLDCUP', 'TEST', 'ODI', 'T20',
  'CHAMPIONS', 'CAPTAIN', 'COACH',
  // Politics / current-affairs noise
  'MODI', 'GOVT', 'GOVERNMENT', 'BUDGET', 'MINISTER', 'POLITICS',
  // Common English words that pass all-caps test
  'PLEASE', 'KINDLY', 'JUST', 'THIS', 'THAT', 'THESE', 'THOSE',
  'WHAT', 'WHEN', 'WHERE', 'WHICH', 'WHILE', 'WHILES', 'WOULD',
  'COULD', 'SHOULD', 'EVERY', 'SOME', 'FROM', 'INTO', 'WITH',
  'ABOUT', 'AFTER', 'BEFORE', 'YESTERDAY', 'TODAY', 'TOMORROW',
  'THANK', 'SORRY', 'HELLO', 'BYE', 'OKAY', 'YESS', 'NOPE',
])

// 2026-06-26: validated universe of REAL Indian listed tickers. Loaded
// once on module init from the static NIFTY_500_CORE + dynamic
// NSE/BSE scrip master. If a parsed token isn't in this set, it's NOT
// a real stock and gets dropped — kills the "VIRAT" / random-word leaks.
let validTickerSet: Set<string> | null = null
async function getValidTickerSet(): Promise<Set<string>> {
  if (validTickerSet) return validTickerSet
  const set = new Set<string>()
  try {
    const { NIFTY_500_CORE, getAllNSEEquities, getAllBSEEquities } = await import('../screeners/universe')
    for (const s of NIFTY_500_CORE) set.add(String(s).toUpperCase())
    try {
      const nse = await getAllNSEEquities()
      for (const s of nse) set.add(String(s).toUpperCase())
    } catch { /* skip if ScripMaster cold */ }
    try {
      const bse = await getAllBSEEquities()
      for (const s of bse) set.add(String(s).toUpperCase())
    } catch { /* skip if ScripMaster cold */ }
  } catch { /* universe module unavailable */ }
  log.info('X-RECS', `valid-ticker set loaded: ${set.size} symbols`)
  validTickerSet = set
  return set
}

// NSE symbols are typically all-caps tokens 3-12 chars (e.g. RELIANCE, HDFCBANK).
// We parse $TICKER, #TICKER, or standalone TICKER followed by price/target words.
function extractSymbol(text: string, validTickers: Set<string>): string | null {
  const cleaned = text.toUpperCase()
  const validate = (s: string): string | null => {
    if (!s || s.length < 3 || s.length > 12) return null
    if (NON_STOCK_TOKENS.has(s)) return null
    if (!/[AEIOU]/.test(s)) return null
    // 2026-06-26: HARD GATE — token must be a real listed NSE / BSE ticker.
    // This kills random words like "VIRAT", "KOHLI", "TODAY", "WORLD" etc.
    // that happen to be all-caps and match the previous heuristic. If the
    // ticker set is empty (cold start), fall through to legacy behavior.
    if (validTickers.size > 0 && !validTickers.has(s)) return null
    return s
  }
  // Tightened: $TICKER / #TICKER must be followed by space or punctuation
  const tagMatch = cleaned.match(/[$#]([A-Z]{3,12})(?:\b|$)/)
  if (tagMatch) {
    const v = validate(tagMatch[1])
    if (v) return v
  }
  const verbMatch = cleaned.match(/\b(?:BUY|SELL|SHORT|LONG|ACCUMULATE|ADD|TARGET|ENTRY)\s+([A-Z]{3,12})\b/)
  if (verbMatch) {
    const v = validate(verbMatch[1])
    if (v) return v
  }
  // Last-resort: any standalone all-caps token of length 4-12 — only if it's
  // a known ticker. This catches "RELIANCE chart looks good" without a $/buy
  // prefix. Skip 3-char tokens here (too many false positives like THE, AND).
  const tokens = cleaned.match(/\b[A-Z]{4,12}\b/g) ?? []
  for (const tok of tokens) {
    const v = validate(tok)
    if (v) return v
  }
  return null
}

// 2026-06-26: ACTIONABILITY check — the post must show evidence of a
// stock-related trade idea, not just news observation / sentiment / a
// random opinion. Required: at least ONE of (parsed entry, SL, target)
// OR a strong action-keyword in the text.
const ACTION_KEYWORDS = /\b(BUY|SELL|SHORT|LONG|ACCUMULATE|ADD\b.*\b(NEAR|AROUND|ABOVE|BELOW)|TARGET|TGT|SL\s|STOP\s*LOSS|STOPLOSS|CMP|ENTRY|SETUP|BREAKOUT|BREAKDOWN|RESISTANCE|SUPPORT|PIVOT|SWING\s|POSITIONAL|INTRADAY|BTST|STBT|FUTURES?|OPTIONS?|STRIKE\s|EXPIRY|CONSOLIDATION|TRADE\s|SQUEEZE|RETRACE|BOUNCE|REVERSAL|FLAG\s|WEDGE|TRIANGLE|CUP\s+AND\s+HANDLE|DARVAS|VOLUME\s+(SURGE|BREAKOUT)|RISK\s+REWARD|R:R|VCP)\b/i

function isActionableRec(rec: { parsedEntry: number | null; parsedSL: number | null; parsedTargets: number[]; text: string }): boolean {
  if (rec.parsedEntry != null || rec.parsedSL != null || (rec.parsedTargets && rec.parsedTargets.length > 0)) return true
  return ACTION_KEYWORDS.test(rec.text)
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

function parseRecommendation(text: string, handle: string, sourceUrl: string, postedAt: string, imageUrl: string | null, validTickers: Set<string>): XRecommendation {
  const clean = decodeHtmlEntities(text).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()
  const sym = extractSymbol(clean, validTickers)
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

function parseRssItems(xml: string, handle: string, validTickers: Set<string>): XRecommendation[] {
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
    out.push(parseRecommendation(text, handle, sourceUrl, postedAt, imgMatch ? imgMatch[1] : null, validTickers))
  }
  return out
}

// 2026-07-14 — user directive: "Why you are removing old posts? you should
// keep all the posts from x here." Prior behaviour overwrote the snapshot
// every scrape → anything older than the current nitter RSS window
// (typically ~24-48h) disappeared. Fix: merge fresh scrape with retained
// history, dedup by (handle + text) + (handle + sourceUrl), keep everything
// for RETENTION_DAYS, and cap total at RETENTION_MAX_ROWS so the JSON
// snapshot doesn't grow unbounded.
const RETENTION_DAYS = 90
const RETENTION_MAX_ROWS = 500

async function loadExistingRecommendations(): Promise<XRecommendation[]> {
  try {
    const p = path.resolve(__dirname, '../../data/public-snapshots/x-recs.json')
    const raw = await fs.promises.readFile(p, 'utf8')
    const parsed = JSON.parse(raw) as { recommendations?: XRecommendation[] }
    return Array.isArray(parsed.recommendations) ? parsed.recommendations : []
  } catch {
    return []
  }
}

function mergeAndRetain(fresh: XRecommendation[], existing: XRecommendation[]): XRecommendation[] {
  const seen = new Set<string>()
  const merged: XRecommendation[] = []
  // Fresh first so we always keep the newest parsed version if the same
  // post was re-scraped (nitter sometimes re-encodes descriptions).
  for (const r of [...fresh, ...existing]) {
    const keyByUrl = `${r.handle}|${r.sourceUrl}`
    const keyByText = `${r.handle}|${(r.text ?? '').slice(0, 120)}`
    if (seen.has(keyByUrl) || seen.has(keyByText)) continue
    seen.add(keyByUrl)
    seen.add(keyByText)
    merged.push(r)
  }
  // Retention window
  const cutoffMs = Date.now() - RETENTION_DAYS * 86_400_000
  const withinWindow = merged.filter(r => {
    const t = Date.parse(r.postedAt)
    return Number.isFinite(t) ? t >= cutoffMs : true   // keep unparseable dates
  })
  withinWindow.sort((a, b) => b.postedAt.localeCompare(a.postedAt))
  return withinWindow.slice(0, RETENTION_MAX_ROWS)
}

export async function fetchXRecommendations(opts?: { perHandle?: number }): Promise<{ generatedAt: string; bySite: Record<string, string>; recommendations: XRecommendation[]; freshThisRun?: number; retainedCarryOver?: number; matchedOurCriteria?: number }> {
  const perHandle = opts?.perHandle ?? 10
  const bySite: Record<string, string> = {}
  const all: XRecommendation[] = []

  log.info('X-RECS', `fetching from ${X_ANALYSTS.length} handles via nitter mirrors (best-effort)...`)
  const validTickers = await getValidTickerSet()
  await Promise.all(X_ANALYSTS.map(async a => {
    let recs: XRecommendation[] = []
    let source = 'unavailable'
    // Try nitter RSS first (cleanest)
    const rss = await fetchNitterRss(a.handle)
    if (rss) {
      recs = parseRssItems(rss, a.handle, validTickers).slice(0, perHandle)
      source = `nitter (${recs.length} items)`
    } else {
      // Last-resort: try syndication (rare to succeed without auth now)
      const syn = await fetchSyndication(a.handle)
      if (syn) source = `syndication (${syn.length} items, parsing skipped — schema TBD)`
    }
    bySite[a.handle] = source
    all.push(...recs)
  }))

  // 2026-06-26 — filter out non-stock noise. Keep a row only if:
  //   (1) we extracted a parsed symbol (passes blacklist + validation)
  //   (2) AND it's actionable (has parsed entry/SL/target OR trade keyword)
  const before = all.length
  const filtered = all
    .filter(r => r.parsedSymbol)
    .filter(r => isActionableRec(r))
  filtered.sort((a, b) => b.postedAt.localeCompare(a.postedAt))
  const droppedNoSymbol = all.filter(r => !r.parsedSymbol).length
  const droppedNotActionable = all.filter(r => r.parsedSymbol && !isActionableRec(r)).length

  // Merge with retained history so we NEVER lose a legit past post just
  // because nitter's RSS window rolled off it.
  const existing = await loadExistingRecommendations()
  const merged = mergeAndRetain(filtered, existing)
  const carryOver = merged.length - filtered.length

  // 2026-07-15 — annotate each recommendation with our own view. User asked
  // for green highlight if the analyst's pick matches our criteria. We
  // cross-reference the parsed symbol against every high-conviction snapshot
  // and tag matchesOurCriteria + matchReasons.
  const ourUniverse = await buildOurConvictionUniverse()
  const annotated = merged.map(r => {
    const upSym = (r.parsedSymbol ?? '').toUpperCase()
    if (!upSym) return { ...r, matchesOurCriteria: false, matchReasons: [] as string[] }
    const reasons: string[] = []
    for (const [tabName, syms] of Object.entries(ourUniverse)) {
      if (syms.has(upSym)) reasons.push(tabName)
    }
    return { ...r, matchesOurCriteria: reasons.length > 0, matchReasons: reasons }
  })

  const matchedCount = annotated.filter(r => (r as { matchesOurCriteria?: boolean }).matchesOurCriteria).length
  log.ok('X-RECS', `parsed ${filtered.length} fresh actionable (raw ${before}, dropped ${droppedNoSymbol} no-symbol + ${droppedNotActionable} not-actionable) · retained ${carryOver} historical · matched-our-criteria ${matchedCount}/${annotated.length} → total ${annotated.length} · sources: ${Object.entries(bySite).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  return {
    generatedAt: new Date().toISOString(),
    bySite,
    recommendations: annotated,
    freshThisRun: filtered.length,
    retainedCarryOver: carryOver,
    matchedOurCriteria: matchedCount,
  }
}

/**
 * Load our high-conviction snapshots and build a { tab -> Set<symbol> } map.
 * X-recs whose parsedSymbol appears in ANY set get marked as
 * matchesOurCriteria = true, with the tab names as matchReasons.
 */
async function buildOurConvictionUniverse(): Promise<Record<string, Set<string>>> {
  const dir = path.resolve(__dirname, '../../data/public-snapshots')
  const load = async (file: string): Promise<Record<string, unknown> | null> => {
    try {
      const raw = await fs.promises.readFile(path.join(dir, file), 'utf8')
      return JSON.parse(raw) as Record<string, unknown>
    } catch { return null }
  }
  const extract = (obj: Record<string, unknown> | null, key: string): Set<string> => {
    const out = new Set<string>()
    if (!obj) return out
    const rows = obj[key]
    if (!Array.isArray(rows)) return out
    for (const r of rows) {
      const rec = r as { symbol?: string; instrument?: string; sym?: string; ticker?: string }
      const s = (rec.symbol ?? rec.instrument ?? rec.sym ?? rec.ticker ?? '').toUpperCase().replace(/\s.*$/, '')
      if (s) out.add(s)
    }
    return out
  }
  const [wp, pe, ib, em, cp, cc, pro, ss, bd] = await Promise.all([
    load('weekly-pick.json'),
    load('pedigree-accumulation.json'),
    load('insider-buys.json'),
    load('early-momentum.json'),
    load('chart-patterns.json'),
    load('cross-confluence.json'),
    load('pro-edge.json'),
    load('superstar-picks.json'),
    load('bulk-deals.json'),
  ])
  return {
    'Weekly Pick':        extract(wp, 'rows'),
    'Pedigree':           extract(pe, 'rows'),
    'Insider Buys':       extract(ib, 'rows'),
    'Early Momentum':     extract(em, 'rows'),
    'Chart Patterns':     extract(cp, 'rows'),
    'Cross Confluence':   extract(cc, 'rows'),
    'PRO Edge':           extract(pro, 'rows'),
    'Superstar':          extract(ss, 'rows'),
    'Bulk Deals':         extract(bd, 'rows'),
  }
}
