/**
 * Natural-language parser for bot queries.
 *
 * Recognises:
 *   "GHCL"                         → { kind: 'equity', exchange: 'NSE', symbol: 'GHCL' }
 *   "bse ghcl"                     → { kind: 'equity', exchange: 'BSE', symbol: 'GHCL' }
 *   "24200 put May Monthly expiry" → { kind: 'option', underlying: 'NIFTY', strike: 24200, side: 'PE', month: 5, monthly: true }
 *   "24500 Call April monthly"     → { kind: 'option', underlying: 'NIFTY', strike: 24500, side: 'CE', month: 4, monthly: true }
 *   "banknifty 52000 ce may"       → { kind: 'option', underlying: 'BANKNIFTY', strike: 52000, side: 'CE', month: 5, monthly: true }
 *   "reliance 3000 pe may"         → { kind: 'option', underlying: 'RELIANCE', strike: 3000, side: 'PE', month: 5, monthly: true }
 *   "nifty fut may"                → { kind: 'future', underlying: 'NIFTY', month: 5 }
 *   "gold mcx"                     → { kind: 'commodity', symbol: 'GOLD' }
 *   "xauusd" / "crude"             → { kind: 'commodity', ... }
 *   "/signals"                     → pass-through, handled by command router
 */

export type Exchange = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX' | 'CDS'

export type QueryIntent =
  | { kind: 'equity'; exchange: 'NSE' | 'BSE'; symbol: string; raw: string }
  | { kind: 'option'; underlying: string; strike: number; side: 'CE' | 'PE'; month: number; monthly: boolean; weekly: boolean; year?: number; exchange: 'NFO' | 'BFO'; raw: string }
  | { kind: 'future'; underlying: string; month?: number; exchange: 'NFO' | 'MCX'; raw: string }
  | { kind: 'commodity'; symbol: 'GOLD' | 'SILVER' | 'CRUDE' | 'NATURALGAS'; raw: string }
  | { kind: 'index'; symbol: string; raw: string }
  | { kind: 'unknown'; raw: string }

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
}

const INDEX_ALIASES: Record<string, string> = {
  NIFTY: 'NIFTY', NIFTY50: 'NIFTY', 'NIFTY-50': 'NIFTY',
  BANKNIFTY: 'BANKNIFTY', BANK: 'BANKNIFTY', NIFTYBANK: 'BANKNIFTY',
  FINNIFTY: 'FINNIFTY',
  SENSEX: 'SENSEX', BSE30: 'SENSEX',
  MIDCPNIFTY: 'MIDCPNIFTY', MIDCAPNIFTY: 'MIDCPNIFTY',
}

const COMMODITY_ALIASES: Record<string, 'GOLD' | 'SILVER' | 'CRUDE' | 'NATURALGAS'> = {
  GOLD: 'GOLD', XAUUSD: 'GOLD', XAU: 'GOLD', GOLDM: 'GOLD', GOLDMCX: 'GOLD',
  SILVER: 'SILVER', XAGUSD: 'SILVER', XAG: 'SILVER', SILVERM: 'SILVER', SILVERMCX: 'SILVER',
  CRUDE: 'CRUDE', CRUDEOIL: 'CRUDE', WTI: 'CRUDE', BRENT: 'CRUDE', OIL: 'CRUDE',
  NG: 'NATURALGAS', NATGAS: 'NATURALGAS', NATURALGAS: 'NATURALGAS',
}

function findMonthWord(text: string): { month: number; match: string } | null {
  const lc = text.toLowerCase()
  for (const word of Object.keys(MONTH_MAP).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`\\b${word}\\b`, 'i')
    if (re.test(lc)) return { month: MONTH_MAP[word], match: word }
  }
  return null
}

export function parseQuery(input: string): QueryIntent {
  const raw = input.trim()
  const lc = raw.toLowerCase()
  const up = raw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

  // ─── Option: look for strike + side(call/put/ce/pe) ───────────
  const optMatch = lc.match(/(?:\b([a-z]+)\s+)?(\d{3,6})\s*(call|put|ce|pe)\b/i)
  if (optMatch) {
    const [, maybeUnderlying, strikeStr, sideStr] = optMatch
    const side = /call|ce/i.test(sideStr) ? 'CE' : 'PE'
    const strike = Number(strikeStr)
    const monthHit = findMonthWord(raw)
    const weekly = /\bweekly\b|\bweek\b/i.test(raw)
    const monthly = /\bmonthly\b|\bmonth\b/i.test(raw) || !weekly
    const onBSE = /\bbse\b|\bbfo\b|\bbankex\b|\bsensex\b/i.test(raw)
    let underlying = (maybeUnderlying ?? '').toUpperCase()
    if (!underlying || underlying === 'NIFTY50') underlying = 'NIFTY'
    if (INDEX_ALIASES[underlying]) underlying = INDEX_ALIASES[underlying]
    // If no underlying given and it's BSE, assume SENSEX
    if (!maybeUnderlying) underlying = onBSE ? 'SENSEX' : 'NIFTY'

    return {
      kind: 'option',
      underlying,
      strike,
      side,
      month: monthHit?.month ?? new Date().getMonth() + 1,
      monthly,
      weekly,
      exchange: onBSE ? 'BFO' : 'NFO',
      raw,
    }
  }

  // ─── Future: "nifty fut may" / "NIFTY futures" ───────────────
  const futMatch = lc.match(/\b([a-z]+)?\s*(?:fut|future|futures)\b/i)
  if (futMatch) {
    const underlyingWord = (futMatch[1] ?? '').toUpperCase()
    const underlying = INDEX_ALIASES[underlyingWord] ?? underlyingWord
    if (underlying) {
      const monthHit = findMonthWord(raw)
      return { kind: 'future', underlying, month: monthHit?.month, exchange: 'NFO', raw }
    }
  }

  // ─── Commodity aliases ───────────────────────────────────────
  const up0 = up.replace(/\s+/g, '')
  if (COMMODITY_ALIASES[up0]) {
    return { kind: 'commodity', symbol: COMMODITY_ALIASES[up0], raw }
  }
  const firstTok = up.split(' ')[0]
  if (COMMODITY_ALIASES[firstTok]) {
    return { kind: 'commodity', symbol: COMMODITY_ALIASES[firstTok], raw }
  }

  // ─── Index ───────────────────────────────────────────────────
  if (INDEX_ALIASES[up0]) {
    return { kind: 'index', symbol: INDEX_ALIASES[up0], raw }
  }

  // ─── Equity ───────────────────────────────────────────────────
  // Strip common prefixes: "bse ghcl" / "nse sjvn"
  const bseMatch = up.match(/^BSE\s+([A-Z0-9&-]+)$/)
  if (bseMatch) return { kind: 'equity', exchange: 'BSE', symbol: bseMatch[1], raw }
  const nseMatch = up.match(/^NSE\s+([A-Z0-9&-]+)$/)
  if (nseMatch) return { kind: 'equity', exchange: 'NSE', symbol: nseMatch[1], raw }

  // Single-token → equity on NSE
  if (/^[A-Z0-9&-]{1,20}$/.test(up0)) {
    return { kind: 'equity', exchange: 'NSE', symbol: up0, raw }
  }

  return { kind: 'unknown', raw }
}
