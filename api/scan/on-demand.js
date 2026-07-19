/**
 * Vercel serverless function · on-demand real-time scan.
 * POST /api/scan/on-demand
 * Body: { symbols: string[] } · up to 25 symbols per request.
 *
 * Written in plain JS so Vercel's serverless runtime picks it up
 * without needing a TS build step. Uses Yahoo Finance for OHLCV
 * (public, no auth) and computes the same composite bias + trade
 * plan as the on-server engine in server/src/engine/onDemandScan.ts.
 */

const MAX_SYMBOLS = 25

const YAHOO_ALIAS = {
  NIFTY: '^NSEI', BANKNIFTY: '^NSEBANK', SENSEX: '^BSESN', INDIAVIX: '^INDIAVIX',
  GOLD: 'GC=F', XAUUSD: 'GC=F', XAU: 'GC=F',
  CRUDE: 'CL=F', OIL: 'CL=F', BRENT: 'BZ=F',
  DXY: 'DX-Y.NYB', USDINR: 'INR=X', EURUSD: 'EURUSD=X',
  BTCUSD: 'BTC-USD', ETHUSD: 'ETH-USD',
  SILVER: 'SI=F', COPPER: 'HG=F', NATGAS: 'NG=F',
}

function toYahooTicker(sym) {
  const up = sym.toUpperCase()
  if (YAHOO_ALIAS[up]) return YAHOO_ALIAS[up]
  return up + '.NS'
}

function isNseMarketOpen() {
  // 9:15-15:30 IST, Mon-Fri
  const nowMs = Date.now() + 5.5 * 3600000
  const d = new Date(nowMs)
  const dow = d.getUTCDay()
  if (dow === 0 || dow === 6) return false
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes()
  return mins >= 555 && mins <= 930
}

async function fetchYahoo(ticker, timeoutMs) {
  timeoutMs = timeoutMs || 6000
  // During IST market hours pull 5-min candles for live accuracy;
  // outside market hours pull daily for stable EMA/RSI calc.
  const intraday = isNseMarketOpen()
  const params = intraday
    ? 'interval=5m&range=5d&includePrePost=false'
    : 'interval=1d&range=3mo&includePrePost=false'
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?' + params
    const ctrl = new AbortController()
    const to = setTimeout(function () { ctrl.abort() }, timeoutMs)
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TWV-Scan/1.0)',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    })
    clearTimeout(to)
    if (!res.ok) return null
    const j = await res.json()
    const r = j && j.chart && j.chart.result && j.chart.result[0]
    if (!r) return null
    const meta = r.meta
    const ts = r.timestamp || []
    const q = r.indicators && r.indicators.quote && r.indicators.quote[0]
    if (!q || !ts.length) return null
    const ohlc = []
    for (let i = 0; i < ts.length; i++) {
      const o = q.open && q.open[i]
      const h = q.high && q.high[i]
      const l = q.low && q.low[i]
      const c = q.close && q.close[i]
      const v = q.volume && q.volume[i]
      if (o == null || h == null || l == null || c == null) continue
      ohlc.push({ time: ts[i] * 1000, open: o, high: h, low: l, close: c, volume: v || 0 })
    }
    // Intraday needs at least 25 bars (2+ hours of 5-min); daily needs 25 sessions.
    if (ohlc.length < 25) return null
    const ltp = (meta && meta.regularMarketPrice) || ohlc[ohlc.length - 1].close
    const prev = (meta && meta.chartPreviousClose) || ohlc[ohlc.length - 2].close
    const changePct = prev > 0 ? ((ltp - prev) / prev) * 100 : 0
    return { ohlc: ohlc, ltp: ltp, changePct: changePct, resolution: intraday ? '5m' : '1d' }
  } catch (e) {
    return null
  }
}

async function fetchStooq(sym, timeoutMs) {
  // Stooq CSV fallback: works for major NSE stocks (add .in suffix), commodities,
  // indices, FX. Free, no auth, no rate limit. EOD only.
  timeoutMs = timeoutMs || 5000
  const stooqSym = sym.toLowerCase() + '.in'
  try {
    const url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(stooqSym) + '&i=d'
    const ctrl = new AbortController()
    const to = setTimeout(function () { ctrl.abort() }, timeoutMs)
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TWV-Scan/1.0)' },
      signal: ctrl.signal,
    })
    clearTimeout(to)
    if (!res.ok) return null
    const csv = await res.text()
    const lines = csv.trim().split('\n')
    if (lines.length < 30) return null
    const ohlc = []
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',')
      if (parts.length < 6) continue
      const o = parseFloat(parts[1]), h = parseFloat(parts[2]), l = parseFloat(parts[3]), c = parseFloat(parts[4]), v = parseFloat(parts[5])
      if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue
      ohlc.push({ time: Date.parse(parts[0]), open: o, high: h, low: l, close: c, volume: isFinite(v) ? v : 0 })
    }
    if (ohlc.length < 25) return null
    const last = ohlc[ohlc.length - 1]
    const prev = ohlc[ohlc.length - 2]
    const changePct = prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0
    return { ohlc: ohlc, ltp: last.close, changePct: changePct, resolution: '1d' }
  } catch (e) {
    return null
  }
}

function ema(values, period) {
  if (!values.length) return 0
  const k = 2 / (period + 1)
  let e = values[0]
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k)
  return e
}
function rsi14(values) {
  if (values.length < 15) return 50
  let g = 0, l = 0
  for (let i = values.length - 14; i < values.length; i++) {
    const d = values[i] - values[i - 1]
    if (d > 0) g += d; else l -= d
  }
  if (l === 0) return 100
  return 100 - 100 / (1 + g / l)
}
function atr14(candles) {
  if (candles.length < 15) return 0
  const trs = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)))
  }
  const last = trs.slice(-14)
  return last.reduce(function (s, v) { return s + v }, 0) / last.length
}

function detectSetups(f) {
  const out = []
  if (f.emaStack === 'BULL' && f.volRatio > 1.2 && f.rsi > 55 && f.rsi < 75 && f.distHigh20 < 5) out.push('EMA-stacked bull breakout')
  if (f.bbW < 8 && f.volRatio < 1.0 && f.rsi > 45 && f.rsi < 65) out.push('BB Squeeze coil')
  if (f.emaStack === 'BEAR' && f.rsi < 45 && f.distLow20 < 5) out.push('EMA-stacked breakdown')
  if (f.ret5d > 8 && f.rsi > 70) out.push('over-extended · mean-reversion risk')
  if (f.rsi < 30 && f.distLow20 < 3) out.push('Oversold bounce candidate')
  return out
}

function composite(f) {
  let bull = 0, bear = 0
  const reasons = []
  if (f.emaStack === 'BULL') { bull += 25; reasons.push('EMA 9>21>50 stacked bullish') }
  else if (f.emaStack === 'BEAR') { bear += 25; reasons.push('EMA 9<21<50 stacked bearish') }
  if (f.rsi >= 55 && f.rsi <= 75) { bull += 15; reasons.push('RSI ' + f.rsi.toFixed(0) + ' in productive bull zone') }
  else if (f.rsi <= 40) { bear += 15; reasons.push('RSI ' + f.rsi.toFixed(0) + ' weak') }
  if (f.volRatio > 1.4) { bull += 10; reasons.push('Volume ' + f.volRatio.toFixed(1) + '× 20-day avg') }
  if (f.distHigh20 < 3) { bull += 10; reasons.push('Near 20-day high (' + f.distHigh20.toFixed(1) + '% off)') }
  if (f.distLow20 < 3) { bear += 10; reasons.push('Near 20-day low (' + f.distLow20.toFixed(1) + '% off)') }
  if (f.ret5d > 5 && f.ret20d > 12) { bear += 10; reasons.push('Over-extended: 5d +' + f.ret5d.toFixed(1) + '% / 20d +' + f.ret20d.toFixed(1) + '%') }
  if (f.bbW < 8) { bull += 5; reasons.push('Tight coil · BB width ' + f.bbW.toFixed(1) + '%') }
  const net = bull - bear
  const bias = net >= 20 ? 'BULLISH' : net <= -20 ? 'BEARISH' : 'NEUTRAL'
  const score = Math.round(Math.min(100, Math.max(0, 50 + net)))
  return { bias: bias, score: score, reasons: reasons }
}

function addBusinessDays(from, n) {
  let d = new Date(from.getTime())
  let added = 0
  const step = n >= 0 ? 1 : -1
  const target = Math.abs(Math.round(n))
  while (added < target) {
    d = new Date(d.getTime() + step * 86400000)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d
}
function toIstDateOnly(d) {
  const ms = d.getTime() + 5.5 * 3600000
  const shifted = new Date(ms)
  return shifted.getUTCFullYear() + '-' + String(shifted.getUTCMonth() + 1).padStart(2, '0') + '-' + String(shifted.getUTCDate()).padStart(2, '0')
}

async function scanOne(sym) {
  const upSym = sym.trim().toUpperCase()
  const yahoo = toYahooTicker(upSym)
  let data = await fetchYahoo(yahoo)
  let source = 'yahoo:' + yahoo
  if (!data && !YAHOO_ALIAS[upSym]) {
    data = await fetchYahoo(upSym + '.BO')
    if (data) source = 'yahoo:' + upSym + '.BO'
  }
  if (!data && !YAHOO_ALIAS[upSym]) {
    // Last resort: Stooq CSV. Only for plain equity tickers (Stooq covers NSE via .in).
    data = await fetchStooq(upSym)
    if (data) source = 'stooq:' + upSym.toLowerCase() + '.in'
  }
  if (!data) {
    return { symbol: upSym, ok: false, error: 'no market data (tried yahoo + stooq fallbacks)' }
  }
  const ohlc = data.ohlc, ltp = data.ltp, changePct = data.changePct
  const closes = ohlc.map(function (c) { return c.close })
  const vols = ohlc.map(function (c) { return c.volume })
  const last = closes[closes.length - 1]
  const ret5d = ((last - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
  const ret20d = closes.length >= 21 ? ((last - closes[closes.length - 21]) / closes[closes.length - 21]) * 100 : 0
  const rsi = rsi14(closes)
  const e9 = ema(closes.slice(-30), 9)
  const e21 = ema(closes.slice(-50), 21)
  const e50 = closes.length >= 50 ? ema(closes.slice(-60), 50) : e21
  const emaStack = e9 > e21 && e21 > e50 ? 'BULL' : e9 < e21 && e21 < e50 ? 'BEAR' : 'MIXED'
  const v5 = vols.slice(-5).reduce(function (s, x) { return s + x }, 0) / 5
  const v20 = vols.slice(-20).reduce(function (s, x) { return s + x }, 0) / 20
  const volRatio = v20 > 0 ? v5 / v20 : 1
  const window20 = closes.slice(-20)
  const high20 = Math.max.apply(null, window20)
  const low20 = Math.min.apply(null, window20)
  const distHigh20 = high20 > 0 ? ((high20 - last) / high20) * 100 : 0
  const distLow20 = low20 > 0 ? ((last - low20) / low20) * 100 : 0
  const bbW = last > 0 ? ((high20 - low20) / last) * 100 : 0
  const atr = atr14(ohlc)
  const atrPct = last > 0 ? (atr / last) * 100 : 0

  const f = { emaStack: emaStack, volRatio: volRatio, rsi: rsi, distHigh20: distHigh20, distLow20: distLow20, bbW: bbW, ret5d: ret5d, ret20d: ret20d }
  const comp = composite(f)
  const setups = detectSetups(f)

  let plan = {}
  const now = new Date()
  const entryDate = toIstDateOnly(now)
  if (comp.bias === 'BULLISH' && comp.score >= 60 && atr > 0) {
    const entry = ltp
    const sl = entry - Math.max(atr * 1.5, entry * 0.04)
    plan = {
      entry: Math.round(entry * 100) / 100,
      stopLoss: Math.round(sl * 100) / 100,
      target1: Math.round((entry + atr * 1.5) * 100) / 100,
      target2: Math.round((entry + atr * 3) * 100) / 100,
      target3: Math.round((entry + atr * 5) * 100) / 100,
      entryDate: entryDate,
      target1Date: toIstDateOnly(addBusinessDays(now, 3)),
      target2Date: toIstDateOnly(addBusinessDays(now, 6)),
      target3Date: toIstDateOnly(addBusinessDays(now, 10)),
      slDate: toIstDateOnly(addBusinessDays(now, 8)),
    }
  } else if (comp.bias === 'BEARISH' && comp.score <= 40 && atr > 0) {
    const entry = ltp
    const sl = entry + Math.max(atr * 1.5, entry * 0.04)
    plan = {
      entry: Math.round(entry * 100) / 100,
      stopLoss: Math.round(sl * 100) / 100,
      target1: Math.round((entry - atr * 1.5) * 100) / 100,
      target2: Math.round((entry - atr * 3) * 100) / 100,
      target3: Math.round((entry - atr * 5) * 100) / 100,
      entryDate: entryDate,
      target1Date: toIstDateOnly(addBusinessDays(now, 3)),
      target2Date: toIstDateOnly(addBusinessDays(now, 6)),
      target3Date: toIstDateOnly(addBusinessDays(now, 10)),
      slDate: toIstDateOnly(addBusinessDays(now, 8)),
    }
  }

  const unifiedReason = comp.reasons.join(' · ') + (setups.length > 0 ? ' · Setups: ' + setups.join(', ') : '')

  const out = {
    symbol: upSym, ok: true,
    ltp: Math.round(ltp * 100) / 100,
    changePct: Math.round(changePct * 100) / 100,
    ret5dPct: Math.round(ret5d * 100) / 100,
    ret20dPct: Math.round(ret20d * 100) / 100,
    rsi14: Math.round(rsi * 10) / 10,
    emaStack: emaStack,
    volRatio5_20: Math.round(volRatio * 100) / 100,
    distFromHigh20Pct: Math.round(distHigh20 * 10) / 10,
    distFromLow20Pct: Math.round(distLow20 * 10) / 10,
    bbWidthPct: Math.round(bbW * 10) / 10,
    atr14: Math.round(atr * 100) / 100,
    atrPctOfPrice: Math.round(atrPct * 100) / 100,
    compositeBias: comp.bias,
    compositeScore: comp.score,
    setups: setups,
    reasoning: comp.reasons,
    unifiedReason: unifiedReason,
    yahooTicker: yahoo,
    dataSource: source,
    resolution: data.resolution,
  }
  return Object.assign(out, plan)
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.status(200).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return }

  let body = req.body
  if (typeof body === 'string') {
    try { body = JSON.parse(body) } catch (e) { body = {} }
  }
  const raw = Array.isArray(body && body.symbols)
    ? body.symbols.filter(function (s) { return typeof s === 'string' })
    : []
  if (raw.length === 0) {
    res.status(400).json({ error: 'symbols must be a non-empty string array' })
    return
  }
  const uniq = Array.from(new Set(raw.map(function (s) { return s.trim().toUpperCase() }).filter(Boolean))).slice(0, MAX_SYMBOLS)

  const results = await Promise.all(uniq.map(function (s) {
    return scanOne(s).catch(function (e) {
      return { symbol: s, ok: false, error: (e && e.message) || 'unknown' }
    })
  }))
  results.sort(function (a, b) { return (b.compositeScore || 0) - (a.compositeScore || 0) })
  // 60s CDN cache · 5min stale-while-revalidate — repeat queries hit edge, not Yahoo.
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300')
  res.status(200).json({
    generatedAt: new Date().toISOString(),
    marketOpen: isNseMarketOpen(),
    requested: uniq,
    results: results,
  })
}
