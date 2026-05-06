import { loadScripMaster, ScripRow } from './angel'
import type { QueryIntent } from '../bots/parseQuery'

/**
 * Resolver — turns a parsed intent into a concrete Angel ScripMaster row
 * (the one with the `token` used for quote / historical / WS calls).
 */

export interface ResolvedSymbol {
  token: string
  tradingSymbol: string
  exchange: 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX' | 'CDS'
  name: string
  kind: 'equity' | 'option' | 'future' | 'index' | 'commodity'
  strike?: number
  side?: 'CE' | 'PE'
  expiry?: string
  lotsize?: number
  displayLabel: string
}

const INDEX_TOKENS: Record<string, { token: string; exchange: 'NSE' | 'BSE' }> = {
  NIFTY:      { token: '99926000', exchange: 'NSE' },
  BANKNIFTY:  { token: '99926009', exchange: 'NSE' },
  FINNIFTY:   { token: '99926037', exchange: 'NSE' },
  MIDCPNIFTY: { token: '99926074', exchange: 'NSE' },
  SENSEX:     { token: '99919000', exchange: 'BSE' },
  BANKEX:     { token: '99919012', exchange: 'BSE' },
}

function parseAngelExpiry(s: string): Date | null {
  // "30APR2025" or "01MAY2025"
  const m = s.match(/^(\d{1,2})([A-Z]{3})(\d{4})$/)
  if (!m) return null
  const months: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 }
  const mo = months[m[2]]
  if (mo === undefined) return null
  return new Date(Date.UTC(Number(m[3]), mo, Number(m[1])))
}

export async function resolve(intent: QueryIntent): Promise<ResolvedSymbol | null> {
  const all = await loadScripMaster()
  if (!all.length) return null

  if (intent.kind === 'index') {
    const t = INDEX_TOKENS[intent.symbol]
    if (!t) return null
    return {
      token: t.token,
      tradingSymbol: intent.symbol,
      exchange: t.exchange,
      name: intent.symbol,
      kind: 'index',
      displayLabel: intent.symbol,
    }
  }

  if (intent.kind === 'equity') {
    const want = intent.symbol.toUpperCase()
    if (intent.exchange === 'NSE') {
      // Angel NSE equities use "-EQ" suffix
      const hit = all.find(s => s.exch_seg === 'NSE' && s.symbol === `${want}-EQ`)
      if (hit) return toEquity(hit, 'NSE')
      // Some instruments use "-BE" (book-entry) — try that too
      const be = all.find(s => s.exch_seg === 'NSE' && (s.symbol === `${want}-BE` || s.symbol === `${want}-BL`))
      if (be) return toEquity(be, 'NSE')
    }
    if (intent.exchange === 'BSE') {
      // BSE uses plain symbol; fall back to symbol-suffix variants
      const hit = all.find(s => s.exch_seg === 'BSE' && s.symbol === want)
      if (hit) return toEquity(hit, 'BSE')
    }
    return null
  }

  if (intent.kind === 'commodity') {
    // MCX Gold/Silver/Crude — pick the nearest-month futures contract
    const nameMap: Record<string, string[]> = {
      GOLD: ['GOLD', 'GOLDM', 'GOLDPETAL'],
      SILVER: ['SILVER', 'SILVERM', 'SILVERMIC'],
      CRUDE: ['CRUDEOIL', 'CRUDEOILM'],
      NATURALGAS: ['NATURALGAS', 'NATGASMINI'],
    }
    const wanted = nameMap[intent.symbol]
    const candidates = all.filter(
      s => s.exch_seg === 'MCX' && s.instrumenttype === 'FUTCOM' && wanted.includes(s.name),
    )
    if (!candidates.length) return null
    // Nearest expiry
    const withDates = candidates
      .map(c => ({ c, d: c.expiry ? parseAngelExpiry(c.expiry) : null }))
      .filter(x => x.d && x.d.getTime() > Date.now() - 86_400_000) as { c: ScripRow; d: Date }[]
    withDates.sort((a, b) => a.d.getTime() - b.d.getTime())
    const nearest = withDates[0]?.c
    if (!nearest) return null
    return {
      token: nearest.token,
      tradingSymbol: nearest.symbol,
      exchange: 'MCX',
      name: nearest.name,
      kind: 'commodity',
      expiry: nearest.expiry,
      lotsize: nearest.lotsize,
      displayLabel: `${intent.symbol} (${nearest.symbol})`,
    }
  }

  if (intent.kind === 'future') {
    const up = intent.underlying.toUpperCase()
    const isIdx = INDEX_TOKENS[up]
    const filter = isIdx
      ? (s: ScripRow) => s.exch_seg === 'NFO' && s.instrumenttype === 'FUTIDX' && s.name === up
      : (s: ScripRow) => s.exch_seg === 'NFO' && s.instrumenttype === 'FUTSTK' && s.name === up
    const candidates = all.filter(filter)
    const withDates = candidates
      .map(c => ({ c, d: c.expiry ? parseAngelExpiry(c.expiry) : null }))
      .filter(x => x.d && x.d.getTime() > Date.now() - 86_400_000) as { c: ScripRow; d: Date }[]
    withDates.sort((a, b) => a.d.getTime() - b.d.getTime())
    // If month was specified, prefer the future whose expiry matches that month
    let pick = withDates[0]?.c
    if (intent.month) {
      const hit = withDates.find(x => x.d.getUTCMonth() + 1 === intent.month)
      if (hit) pick = hit.c
    }
    if (!pick) return null
    return {
      token: pick.token,
      tradingSymbol: pick.symbol,
      exchange: 'NFO',
      name: pick.name,
      kind: 'future',
      expiry: pick.expiry,
      lotsize: pick.lotsize,
      displayLabel: `${up} FUT ${pick.expiry ?? ''}`,
    }
  }

  if (intent.kind === 'option') {
    const up = intent.underlying.toUpperCase()
    const isIdx = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'].includes(up)
    const exchSeg = intent.exchange // "NFO" or "BFO"
    const instrType = isIdx ? 'OPTIDX' : 'OPTSTK'
    const candidates = all.filter(s =>
      s.exch_seg === exchSeg &&
      s.instrumenttype === instrType &&
      s.name === up &&
      Math.round(Number(s.strike) / 100) === intent.strike &&
      s.symbol.endsWith(intent.side),
    )
    if (!candidates.length) return null
    // Group by expiry and pick the monthly (last Thursday / last day) of requested month
    const withDates = candidates
      .map(c => ({ c, d: c.expiry ? parseAngelExpiry(c.expiry) : null }))
      .filter(x => x.d) as { c: ScripRow; d: Date }[]
    withDates.sort((a, b) => a.d.getTime() - b.d.getTime())

    const now = new Date()
    // Pick expiries in the requested month. If the month has already passed, take next year.
    const monthMatches = withDates.filter(x => x.d.getUTCMonth() + 1 === intent.month)
      .filter(x => x.d.getTime() >= now.getTime() - 86_400_000)
    let pick: { c: ScripRow; d: Date } | undefined
    if (monthMatches.length) {
      if (intent.monthly) {
        // Monthly = latest expiry in that month
        pick = monthMatches[monthMatches.length - 1]
      } else if (intent.weekly) {
        // Weekly = earliest expiry in that month (nearest coming Thursday)
        pick = monthMatches[0]
      } else {
        pick = monthMatches[monthMatches.length - 1]
      }
    }
    if (!pick) {
      // Fallback: pick nearest future
      pick = withDates.find(x => x.d.getTime() >= now.getTime() - 86_400_000)
    }
    if (!pick) return null
    return {
      token: pick.c.token,
      tradingSymbol: pick.c.symbol,
      exchange: exchSeg,
      name: pick.c.name,
      kind: 'option',
      strike: intent.strike,
      side: intent.side,
      expiry: pick.c.expiry,
      lotsize: pick.c.lotsize,
      displayLabel: `${up} ${intent.strike} ${intent.side} ${pick.c.expiry ?? ''}`,
    }
  }

  return null
}

function toEquity(s: ScripRow, exchange: 'NSE' | 'BSE'): ResolvedSymbol {
  return {
    token: s.token,
    tradingSymbol: s.symbol,
    exchange,
    name: s.name,
    kind: 'equity',
    lotsize: s.lotsize,
    displayLabel: `${s.name} (${exchange})`,
  }
}
