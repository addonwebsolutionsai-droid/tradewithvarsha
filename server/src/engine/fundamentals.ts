import fs from 'fs/promises'
import path from 'path'
import * as nse from '../data/nse'
import { log } from '../util/logger'

/**
 * Fundamentals cache — powers the `flow` + `fundamentals` confluence factors.
 *
 * Data sources:
 *   1. NSE daily FII/DII CSV — already fetched by `data/nse.ts` → fetchFIIDIIData()
 *   2. Screener.in quarterly fundamentals CSV — uploaded by user via
 *      POST /api/fundamentals/upload. Stored in `data/fundamentals.json`.
 *      Expected columns (flexible — parser does its best):
 *        Symbol, EPS Growth (%), Revenue Growth (%), ROE (%), ROCE (%),
 *        Debt/Equity, Promoter Holding (%), Promoter Pledge (%), P/E,
 *        FII Holding (%), DII Holding (%), Market Cap (Cr)
 *
 * Missing data is not a red flag — a factor only fires when BOTH the data
 * is present AND the threshold is met. This keeps the score honest: if we
 * don't have fundamentals for a small-cap, it just doesn't contribute to
 * the fundamentals confluence, rather than reading as weak.
 */

const DATA_DIR = path.resolve(__dirname, '../../data')
const FUND_FILE = path.join(DATA_DIR, 'fundamentals.json')

export interface FundamentalRow {
  symbol: string
  epsGrowthPct?: number
  revenueGrowthPct?: number
  roePct?: number
  rocePct?: number
  debtEquity?: number
  promoterHoldingPct?: number
  promoterPledgePct?: number
  pe?: number
  fiiHoldingPct?: number
  diiHoldingPct?: number
  marketCapCr?: number
  updatedAt: string
}

export interface FundamentalsCache {
  uploadedAt: string
  source: string
  rows: Record<string, FundamentalRow>   // keyed by symbol (uppercase)
}

let cache: FundamentalsCache | null = null

export async function loadFundamentals(): Promise<FundamentalsCache> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(FUND_FILE, 'utf8')
    cache = JSON.parse(raw)
    return cache!
  } catch {
    cache = { uploadedAt: '', source: '', rows: {} }
    return cache
  }
}

export async function saveFundamentals(data: FundamentalsCache): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(FUND_FILE, JSON.stringify(data, null, 2), 'utf8')
  cache = data
}

/** Get fundamentals for a single symbol (case-insensitive). */
export async function getFundamentals(symbol: string): Promise<FundamentalRow | null> {
  const c = await loadFundamentals()
  return c.rows[symbol.toUpperCase()] ?? null
}

// ─── CSV Parser ────────────────────────────────────────────────

/**
 * Parse a Screener.in-style CSV export. Column matching is fuzzy — we try
 * several variations of each column name since Screener.in exports differ by
 * custom-query configuration.
 */
export async function parseAndStoreCsv(csvText: string, source = 'screener.in'): Promise<FundamentalsCache> {
  const lines = csvText.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) throw new Error('Empty CSV')
  const header = splitCsvLine(lines[0])
  const hLower = header.map(h => h.toLowerCase().trim())

  const pickCol = (...names: string[]): number => {
    for (const n of names) {
      const idx = hLower.findIndex(h => h === n.toLowerCase() || h.includes(n.toLowerCase()))
      if (idx >= 0) return idx
    }
    return -1
  }

  const idxSymbol   = pickCol('symbol', 'nse code', 'ticker', 'name')
  const idxEPS      = pickCol('eps growth', 'profit growth', 'net profit growth')
  const idxRev      = pickCol('sales growth', 'revenue growth')
  const idxROE      = pickCol('roe', 'return on equity')
  const idxROCE     = pickCol('roce', 'return on capital')
  const idxDE       = pickCol('debt/equity', 'debt to equity', 'd/e')
  const idxProm     = pickCol('promoter holding')
  const idxPledge   = pickCol('pledged', 'pledge')
  const idxPE       = pickCol('p/e', 'price to earnings', 'pe ratio')
  const idxFII      = pickCol('fii holding', 'foreign holding')
  const idxDII      = pickCol('dii holding', 'domestic holding', 'mf holding')
  const idxMCap     = pickCol('market cap', 'mcap', 'market capitalization')

  if (idxSymbol < 0) throw new Error('CSV has no Symbol/NSE-code column')

  const num = (s: string | undefined): number | undefined => {
    if (!s) return undefined
    const n = Number(String(s).replace(/[,%]/g, '').trim())
    return Number.isFinite(n) ? n : undefined
  }

  const rows: Record<string, FundamentalRow> = {}
  const now = new Date().toISOString()
  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i])
    const sym = (c[idxSymbol] ?? '').toUpperCase().trim()
    if (!sym) continue
    rows[sym] = {
      symbol: sym,
      epsGrowthPct:       num(c[idxEPS]),
      revenueGrowthPct:   num(c[idxRev]),
      roePct:             num(c[idxROE]),
      rocePct:            num(c[idxROCE]),
      debtEquity:         num(c[idxDE]),
      promoterHoldingPct: num(c[idxProm]),
      promoterPledgePct:  num(c[idxPledge]),
      pe:                 num(c[idxPE]),
      fiiHoldingPct:      num(c[idxFII]),
      diiHoldingPct:      num(c[idxDII]),
      marketCapCr:        num(c[idxMCap]),
      updatedAt: now,
    }
  }

  const payload: FundamentalsCache = {
    uploadedAt: now,
    source,
    rows,
  }
  await saveFundamentals(payload)
  log.ok('FUND', `Stored fundamentals for ${Object.keys(rows).length} symbols from ${source}`)
  return payload
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = '', inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuote = false
      else cur += ch
    } else {
      if (ch === ',') { out.push(cur); cur = '' }
      else if (ch === '"') inQuote = true
      else cur += ch
    }
  }
  out.push(cur)
  return out
}

// ─── FII/DII flow ──────────────────────────────────────────────

let cachedFlow: { fiiNet: number; diiNet: number; fetchedAt: number } | null = null
const FLOW_TTL_MS = 30 * 60_000

/**
 * Today's net FII + DII flow (₹ crore). Positive = net buying.
 * Used by the `flow` confluence factor: fires on BULLISH signals when
 * aggregate flow is net positive, on BEARISH when net negative.
 */
export async function getTodaysFlow(): Promise<{ fiiNet: number; diiNet: number } | null> {
  if (cachedFlow && Date.now() - cachedFlow.fetchedAt < FLOW_TTL_MS) {
    return { fiiNet: cachedFlow.fiiNet, diiNet: cachedFlow.diiNet }
  }
  try {
    const data = await nse.fetchFIIDIIData()
    if (!data) return null
    const fii = extractNet(data, 'FII')
    const dii = extractNet(data, 'DII')
    if (fii == null || dii == null) return null
    cachedFlow = { fiiNet: fii, diiNet: dii, fetchedAt: Date.now() }
    return { fiiNet: fii, diiNet: dii }
  } catch (e) {
    log.warn('FUND', `FII/DII fetch: ${(e as Error).message}`)
    return null
  }
}

function extractNet(data: any, key: 'FII' | 'DII'): number | null {
  // NSE returns various shapes — try common structures
  if (Array.isArray(data)) {
    const row = data.find((r: any) =>
      typeof r?.category === 'string' && r.category.toUpperCase().includes(key),
    )
    if (row && typeof row.netValue === 'number') return row.netValue
    if (row && typeof row.net === 'number') return row.net
  }
  if (typeof data === 'object' && data) {
    const keyLower = key.toLowerCase()
    for (const k of Object.keys(data)) {
      if (k.toLowerCase().includes(keyLower)) {
        const v = data[k]
        if (typeof v === 'number') return v
        if (v && typeof v.net === 'number') return v.net
      }
    }
  }
  return null
}

// ─── Helper: does this stock meet the fundamentals factor threshold? ──

/**
 * Returns true when the fundamentals data indicates a quality growth stock
 * (≥ 1.5 of: EPS growth ≥ 20 %, low pledge, ROE ≥ 15 %). Missing data → false
 * (factor stays silent, not penalised).
 */
export async function fundamentalsFactorFires(symbol: string): Promise<boolean> {
  const f = await getFundamentals(symbol)
  if (!f) return false
  let score = 0
  if ((f.epsGrowthPct ?? 0) >= 20) score += 1
  else if ((f.epsGrowthPct ?? 0) >= 10) score += 0.5
  if ((f.promoterPledgePct ?? 99) < 10) score += 0.5
  if ((f.roePct ?? 0) >= 15) score += 0.5
  if ((f.debtEquity ?? 99) < 1) score += 0.25
  return score >= 1.5
}
