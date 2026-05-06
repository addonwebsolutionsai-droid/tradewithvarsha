import axios, { AxiosInstance } from 'axios'
import { config } from '../config'
import { log } from '../util/logger'
import { totp } from '../util/totp'
import { correctedNow } from '../util/timeSync'
import { cached, dailyCache, oiCache, priceCache } from './cache'
import type { Candle, OptionChain, OptionChainRow, PriceQuote } from '../types'

/**
 * Angel One SmartAPI client.
 *
 * Auth flow:
 *   1. POST loginByPassword with { clientcode, password (MPIN), totp }
 *        → returns { jwtToken, refreshToken, feedToken }
 *   2. All subsequent REST calls: Authorization: Bearer {jwtToken}
 *   3. WebSocket uses feedToken.
 *
 * Docs: https://smartapi.angelone.in/docs
 */

const BASE = 'https://apiconnect.angelone.in'
const SCRIPMASTER_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json'

interface Tokens {
  jwt: string
  refresh: string
  feed: string
  obtainedAt: number
}

let tokens: Tokens | null = null
let client: AxiosInstance | null = null
let loginInFlight: Promise<Tokens | null> | null = null
let lastFailAt = 0
const FAIL_COOLDOWN_MS = 60_000 // Angel rate-limits aggressive retries — wait a full minute
let lastFailMessage = ''

function baseHeaders(withAuth = false): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '106.193.147.98',
    'X-MACAddress': 'de:ad:be:ef:00:01',
    'X-PrivateKey': config.apis.angelApiKey,
  }
  if (withAuth && tokens?.jwt) {
    h.Authorization = `Bearer ${tokens.jwt}`
  }
  return h
}

function buildClient(): AxiosInstance {
  // 2026-04-27: bumped from 15s → 30s after observing engine-pass-wide
  // timeouts during NSE opening when Angel's historical-API queue depth
  // spikes. 15s simply wasn't enough to ride out the burst.
  return axios.create({
    baseURL: BASE,
    timeout: 30_000,
    validateStatus: s => s < 500,
  })
}

/** Sleep helper for retry-with-backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** True for transient axios errors worth retrying once. */
function isTransientErr(e: unknown): boolean {
  const msg = (e as Error)?.message ?? ''
  return /timeout|ECONNRESET|ECONNABORTED|stream has been aborted|network/i.test(msg)
}

export function hasAngelCreds(): boolean {
  return !!(
    config.apis.angelApiKey &&
    config.apis.angelTotpSecret &&
    config.apis.angelClientCode &&
    config.apis.angelMpin
  )
}

export async function login(force = false): Promise<Tokens | null> {
  if (loginInFlight) return loginInFlight
  if (!hasAngelCreds()) {
    log.warn('ANGEL', 'Credentials incomplete — need ANGEL_CLIENT_CODE and ANGEL_MPIN')
    return null
  }
  if (!force && Date.now() - lastFailAt < FAIL_COOLDOWN_MS) {
    // Still in cooldown from previous failure — avoid further rate-limiting
    return null
  }
  loginInFlight = (async () => {
    client = client ?? buildClient()
    // TOTP MUST use NTP-corrected time — system clocks often drift enough to
    // invalidate the code (our first diagnostic found 18 min of drift).
    const code = totp(config.apis.angelTotpSecret, { now: correctedNow() })
    try {
      const res = await client.post(
        '/rest/auth/angelbroking/user/v1/loginByPassword',
        {
          clientcode: config.apis.angelClientCode,
          password: config.apis.angelMpin,
          totp: code,
        },
        { headers: baseHeaders(false) },
      )
      if (res.status !== 200 || !res.data?.status || !res.data?.data) {
        lastFailAt = Date.now()
        lastFailMessage = typeof res.data === 'object' ? (res.data?.message ?? JSON.stringify(res.data).slice(0, 200)) : String(res.data).slice(0, 200)
        log.err('ANGEL', `login failed: ${res.status} ${lastFailMessage}`)
        return null
      }
      const d = res.data.data
      tokens = {
        jwt: d.jwtToken,
        refresh: d.refreshToken,
        feed: d.feedToken,
        obtainedAt: Date.now(),
      }
      lastFailAt = 0
      lastFailMessage = ''
      log.ok('ANGEL', `Logged in as ${config.apis.angelClientCode} (feedToken ready)`)
      return tokens
    } catch (e) {
      lastFailAt = Date.now()
      lastFailMessage = (e as Error).message
      log.err('ANGEL', `login exception: ${lastFailMessage}`)
      return null
    } finally {
      loginInFlight = null
    }
  })()
  return loginInFlight
}

async function ensureAuth(): Promise<Tokens | null> {
  // Tokens expire in 24h on Angel. Re-login if stale or missing.
  if (!tokens || Date.now() - tokens.obtainedAt > 20 * 60 * 60 * 1000) {
    return login()
  }
  return tokens
}

// ── Scrip Master ────────────────────────────────────────────────
// Angel's instrument universe — one big JSON. We cache by symbol for quick lookup.

export interface ScripRow {
  token: string        // the symboltoken used by all APIs
  symbol: string       // tradingsymbol e.g. "RELIANCE-EQ", "NIFTY26DEC24100CE"
  name: string
  expiry?: string      // options: "29APR2026"
  strike?: number
  lotsize?: number
  instrumenttype?: string  // "FUTIDX", "OPTIDX", "OPTSTK", ""
  exch_seg: string     // "NSE", "BSE", "NFO", "MCX", "CDS"
}

let scripMaster: ScripRow[] | null = null
let scripIndex: Map<string, ScripRow> = new Map()

export async function loadScripMaster(): Promise<ScripRow[]> {
  if (scripMaster) return scripMaster
  return cached(dailyCache, 'angel-scripmaster', async () => {
    log.info('ANGEL', 'Loading ScripMaster (~25MB JSON)...')
    const res = await axios.get(SCRIPMASTER_URL, { timeout: 60_000 })
    scripMaster = res.data as ScripRow[]
    scripIndex = new Map()
    for (const s of scripMaster) {
      scripIndex.set(`${s.exch_seg}:${s.symbol}`, s)
    }
    log.ok('ANGEL', `Loaded ${scripMaster.length} instruments`)
    return scripMaster
  }) ?? []
}

export async function findScrip(exchSeg: string, tradingSymbol: string): Promise<ScripRow | null> {
  if (!scripMaster) await loadScripMaster()
  return scripIndex.get(`${exchSeg}:${tradingSymbol}`) ?? null
}

export async function findEquityToken(symbol: string): Promise<string | null> {
  const s = await findScrip('NSE', `${symbol}-EQ`)
  return s?.token ?? null
}

// ── BSE NAME-ALIAS RESOLVER ──────────────────────────────────────
// 2026-05-03: BSE scrips on Angel use 6-digit numeric codes ("532884" for
// Cemindia Projects). Users type the company-name token ("CEMINDIA"), so the
// data router silently failed to fetch BSE-only stocks like Adisoft, Cemindia,
// Pentokey, BCC Fuba, Indiabulls. This resolver maps name-aliases → ScripRow
// so getCandles/getQuote can fall through to BSE when the NSE lookup misses.

let bseAliasIndex: Map<string, ScripRow> | null = null

/** Derive a small set of plausible name-aliases for a BSE scrip. Skips the
 *  generic suffix words (LTD, LIMITED, etc.) and returns the firstWord plus
 *  a 4-14 char compact form. Examples:
 *    "CEMINDIA PROJECTS LIMITED" → ["CEMINDIA"]
 *    "PENTOKEY ORGANY (INDIA) LIMITED" → ["PENTOKEY"]
 *    "INDIABULLS HOUSING FINANCE" → ["INDIABULLS"]
 *    "ADISOFT TECHNOLOGIES LTD" → ["ADISOFT"]
 *    "BCC FUBA INDIA LTD" → ["BCC", "BCCFUBA"]   (firstWord too short alone)
 */
function bseAliasesFor(name: string): string[] {
  if (!name) return []
  const cleaned = name
    .replace(/\b(LTD|LIMITED|PVT|PRIVATE|CO|COMPANY|GROUP|TECHNOLOG(?:IES|Y)|INDUSTR(?:IES|Y)|HOLDINGS?|INC)\b/gi, '')
    .replace(/[^A-Z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase().trim()
  if (!cleaned) return []
  const firstWord = cleaned.split(/\s+/)[0]
  const compact = cleaned.replace(/\s+/g, '').slice(0, 14)
  const aliases = new Set<string>()
  if (firstWord.length >= 4) aliases.add(firstWord)
  if (compact.length >= 4 && compact !== firstWord) aliases.add(compact)
  // Short firstWord (BCC, RPG) needs the compound to be useful
  if (firstWord.length === 3 && compact.length >= 5) aliases.add(compact)
  return Array.from(aliases).filter(a => /^[A-Z0-9]+$/.test(a))
}

function buildBseAliasIndex(): void {
  if (!scripMaster) return
  bseAliasIndex = new Map()
  let count = 0
  for (const s of scripMaster) {
    if (s.exch_seg !== 'BSE') continue
    // Skip futures/options on BSE
    if (/\d{2}[A-Z]{3}\d{2}/.test(s.symbol)) continue
    for (const a of bseAliasesFor(s.name)) {
      if (!bseAliasIndex.has(a)) { bseAliasIndex.set(a, s); count++ }
    }
  }
  log.ok('ANGEL', `BSE alias index: ${count} name→scrip mappings`)
}

export async function findBseScripByAlias(alias: string): Promise<ScripRow | null> {
  if (!scripMaster) await loadScripMaster()
  if (!bseAliasIndex) buildBseAliasIndex()
  return bseAliasIndex?.get(alias.toUpperCase()) ?? null
}

/**
 * Resolve any user-typed equity symbol to {exchange, token}. Tries NSE first
 * (NSE-EQ via findEquityToken), falls back to BSE name-alias. Used by the
 * data router so getCandles('CEMINDIA') routes to BSE 532884.
 */
export async function findEquityScrip(symbol: string): Promise<{ exchange: 'NSE' | 'BSE'; token: string; tradingSymbol: string } | null> {
  const nseToken = await findEquityToken(symbol)
  if (nseToken) return { exchange: 'NSE', token: nseToken, tradingSymbol: `${symbol}-EQ` }
  const bse = await findBseScripByAlias(symbol)
  if (bse) return { exchange: 'BSE', token: bse.token, tradingSymbol: bse.symbol }
  // 2026-05-03: prefix-match fallback for cases like user typing "MTAR"
  // when the actual ticker is "MTARTECH-EQ". Only kicks in for queries ≥4
  // chars and only matches if exactly ONE NSE ticker starts with the query
  // (avoids false positives like "MARUTI" → MARUTIFINS / MARUTIINFRA).
  if (symbol.length >= 4 && scripMaster) {
    const matches = scripMaster.filter(s =>
      s.exch_seg === 'NSE' &&
      s.symbol.endsWith('-EQ') &&
      s.symbol.startsWith(symbol.toUpperCase())
    )
    if (matches.length === 1) {
      return { exchange: 'NSE', token: matches[0].token, tradingSymbol: matches[0].symbol }
    }
  }
  return null
}

export async function findIndexToken(symbol: 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY'): Promise<string | null> {
  // Index tokens are well known — hard-code the primary ones for speed
  const KNOWN: Record<string, string> = {
    NIFTY: '99926000',
    BANKNIFTY: '99926009',
    FINNIFTY: '99926037',
  }
  return KNOWN[symbol] ?? null
}

// ── Quote / LTP ─────────────────────────────────────────────────

export async function getQuoteByToken(exchange: 'NSE' | 'BSE' | 'NFO' | 'MCX', token: string): Promise<PriceQuote | null> {
  return cached(priceCache, `angel-q-${exchange}-${token}`, async () => {
    const t = await ensureAuth()
    if (!t) return null
    try {
      const res = await client!.post(
        '/rest/secure/angelbroking/market/v1/quote',
        { mode: 'FULL', exchangeTokens: { [exchange]: [token] } },
        { headers: baseHeaders(true) },
      )
      const rows = res.data?.data?.fetched
      const row = Array.isArray(rows) ? rows[0] : null
      if (!row) return null
      return {
        symbol: row.tradingSymbol,
        price: Number(row.ltp),
        change: Number(row.netChange ?? 0),
        changePct: Number(row.percentChange ?? 0),
        high: Number(row.high ?? 0),
        low: Number(row.low ?? 0),
        open: Number(row.open ?? 0),
        previousClose: Number(row.close ?? 0),
        volume: Number(row.tradeVolume ?? 0),
        timestamp: Date.now(),
        source: 'angel',
      }
    } catch (e) {
      log.err('ANGEL', `quote ${token} failed: ${(e as Error).message}`)
      return null
    }
  })
}

export async function getEquityQuote(symbol: string): Promise<PriceQuote | null> {
  // 2026-05-03: extended to fall through to BSE name-alias lookup so quotes
  // for BSE-only micro-caps (Cemindia, Pentokey, Indiabulls) actually return.
  const scrip = await findEquityScrip(symbol)
  if (!scrip) return null
  return getQuoteByToken(scrip.exchange, scrip.token)
}

export async function getIndexQuote(symbol: 'NIFTY' | 'BANKNIFTY' | 'FINNIFTY'): Promise<PriceQuote | null> {
  const token = await findIndexToken(symbol)
  if (!token) return null
  return getQuoteByToken('NSE', token)
}

// ── Historical candles ──────────────────────────────────────────

const TF_MAP: Record<string, string> = {
  '1m': 'ONE_MINUTE',
  '3m': 'THREE_MINUTE',
  '5m': 'FIVE_MINUTE',
  '10m': 'TEN_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h': 'ONE_HOUR',
  '1D': 'ONE_DAY',
}

function fmtAngelDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  // Angel wants IST: "YYYY-MM-DD HH:mm"
  const ist = new Date(d.getTime() + (330 + d.getTimezoneOffset()) * 60_000)
  return `${ist.getFullYear()}-${pad(ist.getMonth() + 1)}-${pad(ist.getDate())} ${pad(ist.getHours())}:${pad(ist.getMinutes())}`
}

export async function getCandles(
  exchange: 'NSE' | 'NFO' | 'MCX' | 'BSE',
  token: string,
  timeframe: keyof typeof TF_MAP,
  lookbackDays: number,
): Promise<Candle[]> {
  const t = await ensureAuth()
  if (!t) return []
  const now = new Date()
  const from = new Date(now.getTime() - lookbackDays * 86_400_000)
  const body = {
    exchange,
    symboltoken: token,
    interval: TF_MAP[timeframe] ?? 'FIFTEEN_MINUTE',
    fromdate: fmtAngelDate(from),
    todate: fmtAngelDate(now),
  }
  // One transient retry — Angel's historical API drops ~5 % of requests at
  // open-bell. Without retry the engine reports 0 signals on those misses.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client!.post(
        '/rest/secure/angelbroking/historical/v1/getCandleData',
        body,
        { headers: baseHeaders(true) },
      )
      const rows = res.data?.data as any[] | undefined
      if (!Array.isArray(rows)) return []
      return rows.map(r => ({
        time: new Date(r[0]).getTime(),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5] ?? 0),
      }))
    } catch (e) {
      if (attempt === 0 && isTransientErr(e)) {
        await sleep(800 + Math.random() * 600)        // 0.8-1.4s jittered backoff
        continue
      }
      log.err('ANGEL', `candles ${token} ${timeframe} failed: ${(e as Error).message}`)
      return []
    }
  }
  return []
}

// ── Option Chain (built from scripmaster + LTP batch) ───────────

export async function getOptionChain(underlying: 'NIFTY' | 'BANKNIFTY'): Promise<OptionChain | null> {
  return cached(oiCache, `angel-oc-${underlying}`, async () => {
    const t = await ensureAuth()
    if (!t) return null
    await loadScripMaster()
    if (!scripMaster) return null

    // Pick the nearest expiry OPTIDX for this underlying
    const chain = scripMaster.filter(
      s => s.exch_seg === 'NFO' && s.instrumenttype === 'OPTIDX' && s.name === underlying,
    )
    if (!chain.length) return null

    const expiries = [...new Set(chain.map(s => s.expiry).filter(Boolean))]
      .sort((a, b) => new Date(a!).getTime() - new Date(b!).getTime())
    const nearest = expiries[0]
    const thisExpiry = chain.filter(s => s.expiry === nearest)

    // Spot price
    const spotToken = await findIndexToken(underlying)
    const spotQ = spotToken ? await getQuoteByToken('NSE', spotToken) : null
    const spot = spotQ?.price ?? 0

    // Batch fetch LTPs (Angel allows up to 50 tokens per call)
    const tokens = thisExpiry.map(s => s.token)
    const batches: string[][] = []
    for (let i = 0; i < tokens.length; i += 40) batches.push(tokens.slice(i, i + 40))

    const ltpByToken: Record<string, { ltp: number; oi: number; oiChange: number; volume: number; iv: number }> = {}
    for (const batch of batches) {
      try {
        const res = await client!.post(
          '/rest/secure/angelbroking/market/v1/quote',
          { mode: 'FULL', exchangeTokens: { NFO: batch } },
          { headers: baseHeaders(true) },
        )
        const rows = res.data?.data?.fetched as any[] | undefined
        if (Array.isArray(rows)) {
          for (const r of rows) {
            ltpByToken[String(r.symbolToken)] = {
              ltp: Number(r.ltp ?? 0),
              oi: Number(r.opnInterest ?? 0),
              oiChange: Number(r.netChangeOpnInterest ?? 0),
              volume: Number(r.tradeVolume ?? 0),
              iv: 0,
            }
          }
        }
      } catch (e) {
        log.err('ANGEL', `option batch failed: ${(e as Error).message}`)
      }
    }

    // Group by strike → CE + PE
    const byStrike: Record<number, OptionChainRow> = {}
    for (const s of thisExpiry) {
      const strike = Number(s.strike) / 100  // Angel stores strikes *100
      if (!Number.isFinite(strike) || strike <= 0) continue
      const isCall = s.symbol.endsWith('CE')
      const data = ltpByToken[s.token]
      if (!data) continue
      if (!byStrike[strike]) {
        byStrike[strike] = {
          strike,
          callOI: 0, putOI: 0,
          callOIChange: 0, putOIChange: 0,
          callVolume: 0, putVolume: 0,
          callIV: 0, putIV: 0,
          callLTP: 0, putLTP: 0,
        }
      }
      const row = byStrike[strike]
      if (isCall) {
        row.callOI = data.oi; row.callOIChange = data.oiChange
        row.callVolume = data.volume; row.callLTP = data.ltp
      } else {
        row.putOI = data.oi; row.putOIChange = data.oiChange
        row.putVolume = data.volume; row.putLTP = data.ltp
      }
    }

    const rows = Object.values(byStrike).sort((a, b) => a.strike - b.strike)
    const totalCallOI = rows.reduce((s, r) => s + r.callOI, 0)
    const totalPutOI = rows.reduce((s, r) => s + r.putOI, 0)

    return {
      symbol: underlying,
      expiry: nearest ?? '',
      spot,
      pcr: totalCallOI > 0 ? totalPutOI / totalCallOI : 0,
      maxPain: 0,
      totalCallOI,
      totalPutOI,
      rows,
      timestamp: Date.now(),
    } satisfies OptionChain
  })
}

// ── Accessors for external modules ─────────────────────────────
export function getFeedToken(): string | null {
  return tokens?.feed ?? null
}

export function getJwt(): string | null {
  return tokens?.jwt ?? null
}

export function getSessionInfo(): {
  loggedIn: boolean
  obtainedAt: number | null
  clientCode: string
  lastError: string
  cooldownRemainingMs: number
} {
  const cooldownRemaining = Math.max(0, FAIL_COOLDOWN_MS - (Date.now() - lastFailAt))
  return {
    loggedIn: !!tokens,
    obtainedAt: tokens?.obtainedAt ?? null,
    clientCode: config.apis.angelClientCode,
    lastError: lastFailMessage,
    cooldownRemainingMs: lastFailAt === 0 ? 0 : cooldownRemaining,
  }
}
