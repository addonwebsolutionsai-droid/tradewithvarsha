/**
 * Vercel serverless function · on-demand real-time scan.
 *
 * POST /api/scan/on-demand
 * Body: { symbols: string[] }
 *
 * Computes real-time composite bias + trade plan for 1-25 symbols by
 * fetching OHLCV from Yahoo Finance (public, no auth). Handles NSE
 * equities, indices, and cross-asset commodities/FX.
 *
 * Why this function exists on Vercel: the primary Node server isn't
 * publicly hosted (it runs on GitHub Actions crons + user's laptop),
 * so browsers hitting /api/scan/on-demand were getting 405 from
 * Vercel's static-file fallback. This function serves that endpoint
 * directly from Vercel's edge with self-contained math.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_SYMBOLS = 25

// Yahoo Finance symbol mappings. NSE stocks use .NS suffix by default.
// Special names (commodities, FX, global indices) need explicit tickers.
const YAHOO_ALIAS: Record<string, string> = {
  NIFTY: '^NSEI',
  BANKNIFTY: '^NSEBANK',
  SENSEX: '^BSESN',
  INDIAVIX: '^INDIAVIX',
  GOLD: 'GC=F',       // gold futures
  XAUUSD: 'GC=F',
  XAU: 'GC=F',
  CRUDE: 'CL=F',      // WTI crude
  OIL: 'CL=F',
  BRENT: 'BZ=F',
  DXY: 'DX-Y.NYB',
  USDINR: 'INR=X',
  EURUSD: 'EURUSD=X',
  BTCUSD: 'BTC-USD',
  ETHUSD: 'ETH-USD',
  SILVER: 'SI=F',
  COPPER: 'HG=F',
  NATGAS: 'NG=F',
}

function toYahooTicker(sym: string): string {
  const up = sym.toUpperCase()
  if (YAHOO_ALIAS[up]) return YAHOO_ALIAS[up]
  // NSE stock — try .NS suffix.
  return `${up}.NS`
}

interface OHLC { open: number; high: number; low: number; close: number; volume: number; time: number }

async function fetchYahoo(ticker: string, timeoutMs = 8000): Promise<{ ohlc: OHLC[]; ltp: number; changePct: number } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=3mo&includePrePost=false`
    const ctrl = new AbortController()
    const to = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TWV-Scan/1.0)',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    })
    clearTimeout(to)
    if (!res.ok) return null
    const j = (await res.json()) as any
    const r = j?.chart?.result?.[0]
    if (!r) return null
    const meta = r.meta
    const ts: number[] = r.timestamp ?? []
    const q = r.indicators?.quote?.[0]
    if (!q || !ts.length) return null
    const ohlc: OHLC[] = []
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i]
      if (o == null || h == null || l == null || c == null) continue
      ohlc.push({
        time: ts[i] * 1000,
        open: o, high: h, low: l, close: c,
        volume: v ?? 0,
      })
    }
    if (ohlc.length < 25) return null
    const ltp = meta?.regularMarketPrice ?? ohlc[ohlc.length - 1].close
    const prev = meta?.chartPreviousClose ?? ohlc[ohlc.length - 2].close
    const changePct = prev > 0 ? ((ltp - prev) / prev) * 100 : 0
    return { ohlc, ltp, changePct }
  } catch { return null }
}

// ─── Feature math ─────────────────────────────────────────────────────

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0
  const k = 2 / (period + 1)
  let e = values[0]
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}
function rsi14(values: number[]): number {
  if (values.length < 15) return 50
  let g = 0, l = 0
  for (let i = values.length - 14; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) g += d; else l -= d
  }
  if (l === 0) return 100
  return 100 - 100 / (1 + g / l)
}
function atr14(candles: OHLC[]): number {
  if (candles.length < 15) return 0
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  const last = trs.slice(-14)
  return last.reduce((s, v) => s + v, 0) / last.length
}

// ─── Setup detection ─────────────────────────────────────────────────

function detectSetups(f: {
  emaStack: 'BULL' | 'BEAR' | 'MIXED'; volRatio: number; rsi: number;
  distHigh20: number; distLow20: number; bbW: number; ret5d: number
}): string[] {
  const out: string[] = []
  if (f.emaStack === 'BULL' && f.volRatio > 1.2 && f.rsi > 55 && f.rsi < 75 && f.distHigh20 < 5) out.push('EMA-stacked bull breakout')
  if (f.bbW < 8 && f.volRatio < 1.0 && f.rsi > 45 && f.rsi < 65) out.push('BB Squeeze coil')
  if (f.emaStack === 'BEAR' && f.rsi < 45 && f.distLow20 < 5) out.push('EMA-stacked breakdown')
  if (f.ret5d > 8 && f.rsi > 70) out.push('⚠ over-extended · mean-reversion risk')
  if (f.rsi < 30 && f.distLow20 < 3) out.push('Oversold bounce candidate')
  return out
}

function composite(f: {
  emaStack: 'BULL' | 'BEAR' | 'MIXED'; volRatio: number; rsi: number;
  distHigh20: number; distLow20: number; bbW: number; ret5d: number; ret20d: number
}): { bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; score: number; reasons: string[] } {
  let bull = 0, bear = 0
  const reasons: string[] = []
  if (f.emaStack === 'BULL') { bull += 25; reasons.push('EMA 9>21>50 stacked bullish') }
  else if (f.emaStack === 'BEAR') { bear += 25; reasons.push('EMA 9<21<50 stacked bearish') }
  if (f.rsi >= 55 && f.rsi <= 75) { bull += 15; reasons.push(`RSI ${f.rsi.toFixed(0)} in productive bull zone`) }
  else if (f.rsi <= 40) { bear += 15; reasons.push(`RSI ${f.rsi.toFixed(0)} weak`) }
  if (f.volRatio > 1.4) { bull += 10; reasons.push(`Volume ${f.volRatio.toFixed(1)}× 20-day avg`) }
  if (f.distHigh20 < 3) { bull += 10; reasons.push(`Near 20-day high (${f.distHigh20.toFixed(1)}% off)`) }
  if (f.distLow20 < 3) { bear += 10; reasons.push(`Near 20-day low (${f.distLow20.toFixed(1)}% off)`) }
  if (f.ret5d > 5 && f.ret20d > 12) { bear += 10; reasons.push(`Over-extended: 5d +${f.ret5d.toFixed(1)}% / 20d +${f.ret20d.toFixed(1)}%`) }
  if (f.bbW < 8) { bull += 5; reasons.push(`Tight coil · BB width ${f.bbW.toFixed(1)}%`) }
  const net = bull - bear
  const bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = net >= 20 ? 'BULLISH' : net <= -20 ? 'BEARISH' : 'NEUTRAL'
  const score = Math.round(Math.min(100, Math.max(0, 50 + net)))
  return { bias, score, reasons }
}

// ─── Business-day math for dated targets ─────────────────────────────

function addBusinessDays(from: Date, n: number): Date {
  let d = new Date(from.getTime())
  let added = 0
  const step = n >= 0 ? 1 : -1
  const target = Math.abs(Math.round(n))
  while (added < target) {
    d = new Date(d.getTime() + step * 86_400_000)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d
}
function toIstDateOnly(d: Date): string {
  const ms = d.getTime() + 5.5 * 3600_000
  const shifted = new Date(ms)
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

// ─── Per-symbol scan ─────────────────────────────────────────────────

async function scanOne(sym: string): Promise<any> {
  const upSym = sym.trim().toUpperCase()
  const yahoo = toYahooTicker(upSym)
  let data = await fetchYahoo(yahoo)
  // Some NSE names fail on .NS but succeed on .BO (BSE listing)
  if (!data && !YAHOO_ALIAS[upSym]) {
    data = await fetchYahoo(`${upSym}.BO`)
  }
  if (!data) {
    return { symbol: upSym, ok: false, error: `no market data (tried ${yahoo}${!YAHOO_ALIAS[upSym] ? ` + ${upSym}.BO` : ''})` }
  }
  const { ohlc, ltp, changePct } = data
  const closes = ohlc.map(c => c.close)
  const vols = ohlc.map(c => c.volume)
  const last = closes[closes.length - 1]
  const ret5d = ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
  const ret20d = closes.length >= 21 ? ((last - closes[closes.length - 21]) / closes[closes.length - 21]) * 100 : 0
  const rsi = rsi14(closes)
  const e9 = ema(closes.slice(-30), 9)
  const e21 = ema(closes.slice(-50), 21)
  const e50 = closes.length >= 50 ? ema(closes.slice(-60), 50) : e21
  const emaStack: 'BULL' | 'BEAR' | 'MIXED' =
    e9 > e21 && e21 > e50 ? 'BULL' :
    e9 < e21 && e21 < e50 ? 'BEAR' : 'MIXED'
  const v5 = vols.slice(-5).reduce((s, x) => s + x, 0) / 5
  const v20 = vols.slice(-20).reduce((s, x) => s + x, 0) / 20
  const volRatio = v20 > 0 ? v5 / v20 : 1
  const window20 = closes.slice(-20)
  const high20 = Math.max(...window20)
  const low20 = Math.min(...window20)
  const distHigh20 = high20 > 0 ? ((high20 - last) / high20) * 100 : 0
  const distLow20 = low20 > 0 ? ((last - low20) / low20) * 100 : 0
  const bbW = last > 0 ? ((high20 - low20) / last) * 100 : 0
  const atr = atr14(ohlc)
  const atrPct = last > 0 ? (atr / last) * 100 : 0

  const f = { emaStack, volRatio, rsi, distHigh20, distLow20, bbW, ret5d, ret20d }
  const comp = composite(f)
  const setups = detectSetups(f)

  let plan: any = {}
  const now = new Date()
  const entryDate = toIstDateOnly(now)
  if (comp.bias === 'BULLISH' && comp.score >= 60 && atr > 0) {
    const entry = ltp
    const sl = entry - Math.max(atr * 1.5, entry * 0.04)
    const t1 = entry + atr * 1.5
    const t2 = entry + atr * 3
    const t3 = entry + atr * 5
    plan = {
      entry: Math.round(entry * 100) / 100,
      stopLoss: Math.round(sl * 100) / 100,
      target1: Math.round(t1 * 100) / 100,
      target2: Math.round(t2 * 100) / 100,
      target3: Math.round(t3 * 100) / 100,
      entryDate,
      target1Date: toIstDateOnly(addBusinessDays(now, 3)),
      target2Date: toIstDateOnly(addBusinessDays(now, 6)),
      target3Date: toIstDateOnly(addBusinessDays(now, 10)),
      slDate: toIstDateOnly(addBusinessDays(now, 8)),
    }
  } else if (comp.bias === 'BEARISH' && comp.score <= 40 && atr > 0) {
    const entry = ltp
    const sl = entry + Math.max(atr * 1.5, entry * 0.04)
    const t1 = entry - atr * 1.5
    const t2 = entry - atr * 3
    const t3 = entry - atr * 5
    plan = {
      entry: Math.round(entry * 100) / 100,
      stopLoss: Math.round(sl * 100) / 100,
      target1: Math.round(t1 * 100) / 100,
      target2: Math.round(t2 * 100) / 100,
      target3: Math.round(t3 * 100) / 100,
      entryDate,
      target1Date: toIstDateOnly(addBusinessDays(now, 3)),
      target2Date: toIstDateOnly(addBusinessDays(now, 6)),
      target3Date: toIstDateOnly(addBusinessDays(now, 10)),
      slDate: toIstDateOnly(addBusinessDays(now, 8)),
    }
  }

  const unifiedReason = comp.reasons.join(' · ') + (setups.length > 0 ? ` · Setups: ${setups.join(', ')}` : '')

  return {
    symbol: upSym,
    ok: true,
    ltp: Math.round(ltp * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    ret5dPct: Math.round(ret5d * 100) / 100,
    ret20dPct: Math.round(ret20d * 100) / 100,
    rsi14: Math.round(rsi * 10) / 10,
    emaStack,
    volRatio5_20: Math.round(volRatio * 100) / 100,
    distFromHigh20Pct: Math.round(distHigh20 * 10) / 10,
    distFromLow20Pct: Math.round(distLow20 * 10) / 10,
    bbWidthPct: Math.round(bbW * 10) / 10,
    atr14: Math.round(atr * 100) / 100,
    atrPctOfPrice: Math.round(atrPct * 100) / 100,
    compositeBias: comp.bias,
    compositeScore: comp.score,
    setups,
    reasoning: comp.reasons,
    unifiedReason,
    yahooTicker: yahoo,
    ...plan,
  }
}

// ─── Handler ─────────────────────────────────────────────────────────

export default async function handler(req: any, res: any): Promise<void> {
  // CORS + method gate
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.status(200).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }

  let body: any = req.body
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { body = {} } }
  const raw: string[] = Array.isArray(body?.symbols)
    ? (body.symbols as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  if (raw.length === 0) {
    res.status(400).json({ error: 'symbols must be a non-empty string array' })
    return
  }
  const uniq = Array.from(new Set(raw.map(s => s.trim().toUpperCase()).filter(Boolean))).slice(0, MAX_SYMBOLS)

  // Fetch all in parallel — Yahoo tolerates concurrent chart requests.
  const results = await Promise.all(uniq.map(s => scanOne(s).catch(e => ({
    symbol: s, ok: false, error: (e as Error)?.message ?? 'unknown',
  }))))
  results.sort((a: any, b: any) => (b.compositeScore ?? 0) - (a.compositeScore ?? 0))
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    requested: uniq,
    results,
  })
}
