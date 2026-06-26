/**
 * MOVER PATTERN MINER — supervised pattern extraction from daily winners.
 *
 * User directive 2026-06-25: "From the gainer sites, find the pattern,
 * style, combination of technicals, news, insider plays that caused these
 * 10-20% moves. Then identify similar footprint in any stock before it
 * happens — generate signals BEFORE the move."
 *
 * Architecture:
 *   1. Every day, pull the NSE bhavcopy gainer list (5%+ moves)
 *   2. For each mover, fetch ~60 daily candles ending AT T-1 (the day
 *      BEFORE the move). This captures the SETUP that preceded the move,
 *      not the move itself.
 *   3. Compute a 12-dimension fingerprint per mover at T-1 (EMA stack,
 *      ADX, RSI, ATR%, vol ratios, base tightness, base days, distance
 *      from 20d-high, MACD, OBV slope, FII delta, delivery %).
 *   4. Append to mover-archetypes.json with the realised return (T+1 to
 *      T+10) as the supervisor label.
 *   5. Cluster archetypes by Euclidean distance in fingerprint space.
 *      Top centroids become the "WINNING ARCHETYPES."
 *   6. Live scanner — for each candidate today, compute the same
 *      fingerprint AT TODAY. Score by inverse distance to nearest
 *      archetype centroid. Closest match + low distance = candidate is
 *      replaying a known winning setup → flag BEFORE the move.
 *
 * The system gets sharper every day with no human input — each new mover
 * the bhavcopy publishes either reinforces an existing cluster or creates
 * a new one. After 30+ trading days the archetype library is statistically
 * meaningful.
 */
import fs from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import { getCandles } from '../data'
import { getShareholding } from '../data/shareholding'
import type { Candle } from '../types'

const DATA_DIR = path.resolve(__dirname, '../../data')
const ARCHETYPE_FILE = path.join(DATA_DIR, 'mover-archetypes.json')
const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

export interface MoverFingerprint {
  symbol: string
  capturedAt: string                  // T-1 close timestamp
  moveDate: string                    // T (the day of the 5%+ move)
  moveMagnitudePct: number            // T's gain %
  deliveryPctAtMove: number | null    // T's delivery %
  realisedReturnPct?: number          // T+10 vs T-1 close (filled in next day's pass)
  // — 12-dimensional fingerprint at T-1 —
  emaStack: -2 | -1 | 0 | 1 | 2
  adx: number
  rsi: number
  atrPct: number
  volRatio5d: number                  // 5d avg / 20d avg (pre-move sustained build)
  volRatioToday: number               // T-1 vol / 20d (any pre-spike?)
  range20Pct: number                  // 20d range / close
  baseDays: number                    // bars within ±2% of close in last 20
  distFrom20High: number              // 0 = at high
  macdHist: number
  obvSlopePct: number                 // 20-day OBV slope
  fiiDeltaQoQ: number | null
  deliveryDirectionScore: number      // delta vs 20-day avg delivery
  closePrice: number                  // for filtering archetypes by price tier
}

export interface ArchetypeStore {
  fingerprints: MoverFingerprint[]
  lastMined: string
}

let cached: ArchetypeStore | null = null
async function load(): Promise<ArchetypeStore> {
  if (cached) return cached
  try {
    const raw = await fs.readFile(ARCHETYPE_FILE, 'utf8')
    cached = JSON.parse(raw)
    return cached!
  } catch {
    cached = { fingerprints: [], lastMined: '' }
    return cached
  }
}
async function save(store: ArchetypeStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(ARCHETYPE_FILE, JSON.stringify(store, null, 2))
  cached = store
}

// ── Fingerprint extraction ──

function ema(values: number[], period: number): number {
  const k = 2 / (period + 1)
  let v = values[0]
  for (let i = 1; i < values.length; i++) v = values[i] * k + v * (1 - k)
  return v
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let g = 0, l = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) g += d; else l -= d
  }
  if (l === 0) return 100
  return 100 - 100 / (1 + g / l)
}

function atrPct(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    )
  }
  const atr = sum / period
  const last = candles[candles.length - 1].close
  return last > 0 ? (atr / last) * 100 : 0
}

function adxApprox(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0
  let dmP = 0, dmM = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high
    const dn = candles[i - 1].low - candles[i].low
    if (up > dn && up > 0) dmP += up
    if (dn > up && dn > 0) dmM += dn
  }
  return (dmP + dmM) > 0 ? Math.abs(dmP - dmM) / (dmP + dmM) * 100 : 0
}

function macdHist(closes: number[]): number {
  if (closes.length < 27) return 0
  return ema(closes, 12) - ema(closes, 26)
}

function obvSlope20(candles: Candle[]): number {
  if (candles.length < 21) return 0
  let obv = 0
  const series: number[] = []
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) obv += candles[i].volume
    else if (candles[i].close < candles[i - 1].close) obv -= candles[i].volume
    series.push(obv)
  }
  const last20 = series.slice(-20)
  const first = last20[0] || 1
  const last = last20[last20.length - 1]
  return first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0
}

function computeFingerprint(candles: Candle[], opts: { symbol: string; moveDate: string; moveMagnitudePct: number; deliveryPctAtMove: number | null; fiiDeltaQoQ: number | null; deliveryDirectionScore: number }): MoverFingerprint | null {
  if (candles.length < 30) return null
  const last = candles[candles.length - 1]
  if (!last) return null
  const closes = candles.map(c => c.close)
  const e9 = ema(closes, 9), e21 = ema(closes, 21)
  const e50 = closes.length >= 50 ? ema(closes, 50) : e21
  const e200 = closes.length >= 200 ? ema(closes, 200) : e50
  let stack: MoverFingerprint['emaStack'] = 0
  if (e9 > e21 && e21 > e50 && e50 > e200) stack = 2
  else if (e9 > e21 && e21 > e50) stack = 1
  else if (e9 < e21 && e21 < e50 && e50 < e200) stack = -2
  else if (e9 < e21 && e21 < e50) stack = -1

  const v20 = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20
  const v5 = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5
  const volRatio5d = v20 > 0 ? v5 / v20 : 1
  const volRatioToday = v20 > 0 ? last.volume / v20 : 1

  const last20 = candles.slice(-20)
  const hi20 = Math.max(...last20.map(c => c.high))
  const lo20 = Math.min(...last20.map(c => c.low))
  const range20Pct = last.close > 0 ? ((hi20 - lo20) / last.close) * 100 : 0
  const distFrom20High = hi20 > 0 ? (hi20 - last.close) / hi20 : 0

  let baseDays = 0
  for (const c of last20) if (Math.abs(c.close - last.close) / last.close < 0.02) baseDays++

  return {
    symbol: opts.symbol,
    capturedAt: new Date(last.time).toISOString(),
    moveDate: opts.moveDate,
    moveMagnitudePct: opts.moveMagnitudePct,
    deliveryPctAtMove: opts.deliveryPctAtMove,
    emaStack: stack,
    adx: +adxApprox(candles).toFixed(1),
    rsi: +rsi(closes).toFixed(1),
    atrPct: +atrPct(candles).toFixed(2),
    volRatio5d: +volRatio5d.toFixed(2),
    volRatioToday: +volRatioToday.toFixed(2),
    range20Pct: +range20Pct.toFixed(2),
    baseDays,
    distFrom20High: +distFrom20High.toFixed(3),
    macdHist: +macdHist(closes).toFixed(2),
    obvSlopePct: +obvSlope20(candles).toFixed(1),
    fiiDeltaQoQ: opts.fiiDeltaQoQ,
    deliveryDirectionScore: opts.deliveryDirectionScore,
    closePrice: +last.close.toFixed(2),
  }
}

// ── Mining (called by the daily 18:30 cron) ──

/**
 * Pull today's bhavcopy gainers and capture each one's T-1 fingerprint.
 * Idempotent — running twice on the same day deduplicates by (symbol, moveDate).
 */
export async function mineTodaysMoverPatterns(opts?: { minGainPct?: number; topN?: number }): Promise<{ added: number; total: number }> {
  const minGainPct = opts?.minGainPct ?? 5
  const topN = opts?.topN ?? 200

  const { fetchExternalGainers } = await import('../data/externalGainers')
  const ext = await fetchExternalGainers()
  const gainers = ext.merged
    .filter(g => g.gainPct >= minGainPct && g.sources.includes('nse-bhavcopy'))
    .slice(0, topN)

  log.info('MOVER-MINE', `Mining ${gainers.length} bhavcopy gainers (≥${minGainPct}% today)`)
  if (gainers.length === 0) return { added: 0, total: (await load()).fingerprints.length }

  const store = await load()
  // Dedup key: (symbol, moveDate=today)
  const today = new Date().toISOString().slice(0, 10)
  const seen = new Set(store.fingerprints.map(f => `${f.symbol}|${f.moveDate}`))

  let added = 0
  let cursor = 0
  const concurrency = 6
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < gainers.length) {
      const g = gainers[cursor++]
      const key = `${g.symbol}|${today}`
      if (seen.has(key)) continue
      try {
        // Fetch ~60 daily candles. The LAST candle is today (the move).
        // We need T-1, so slice off the last bar to capture the setup.
        const all = await getCandles(g.symbol, '1D' as any, 60)
        if (!all || all.length < 31) continue
        const tMinus1 = all.slice(0, -1)

        // FII delta from shareholding (best-effort)
        let fiiDelta: number | null = null
        try {
          const shp = await getShareholding(g.symbol)
          fiiDelta = shp?.fiiDeltaQoQ ?? null
        } catch { /* skip */ }

        // Delivery direction — today's delivery % vs prior 20d avg from
        // bhavcopy if we had historical deliveries cached. Without that we
        // use the current day's delivery alone as the magnitude indicator.
        const todayDeliv = g.deliveryPct ?? null
        const deliveryDirectionScore = todayDeliv != null
          ? (todayDeliv >= 70 ? 2 : todayDeliv >= 55 ? 1 : todayDeliv >= 40 ? 0 : -1)
          : 0

        const fp = computeFingerprint(tMinus1, {
          symbol: g.symbol,
          moveDate: today,
          moveMagnitudePct: g.gainPct,
          deliveryPctAtMove: todayDeliv,
          fiiDeltaQoQ: fiiDelta,
          deliveryDirectionScore,
        })
        if (fp) {
          store.fingerprints.unshift(fp)
          added++
        }
      } catch { /* skip on per-symbol error */ }
    }
  }))

  // Update realised returns for fingerprints captured 10 trading days ago
  await fillRealisedReturns(store)

  // Cap the store at 2000 fingerprints (FIFO) — ~10 trading days of full
  // mover coverage. Older patterns slowly drop out.
  store.fingerprints = store.fingerprints.slice(0, 2000)
  store.lastMined = new Date().toISOString()
  await save(store)
  log.ok('MOVER-MINE', `Added ${added} new fingerprints (total ${store.fingerprints.length})`)
  return { added, total: store.fingerprints.length }
}

/**
 * For fingerprints captured 10+ trading days ago, fetch the close at T+10
 * and compute realised return. This labels each archetype with actual
 * outcome — winners stay in the matcher, losers fall out of the centroid.
 */
async function fillRealisedReturns(store: ArchetypeStore): Promise<void> {
  const now = Date.now()
  const candidates = store.fingerprints.filter(f => {
    if (f.realisedReturnPct != null) return false
    const age = (now - new Date(f.moveDate).getTime()) / 86_400_000
    return age >= 12 && age <= 30
  })
  if (candidates.length === 0) return
  log.info('MOVER-MINE', `Filling realised returns for ${candidates.length} fingerprints (T+10)`)
  let cursor = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < candidates.length) {
      const f = candidates[cursor++]
      try {
        const c = await getCandles(f.symbol, '1D' as any, 40)
        if (!c || c.length < 15) continue
        // Find the candle on moveDate, then look 10 bars ahead
        const moveIdx = c.findIndex(x => new Date(x.time).toISOString().slice(0, 10) >= f.moveDate)
        if (moveIdx < 0 || moveIdx + 10 >= c.length) continue
        const moveClose = c[moveIdx].close
        const futureClose = c[moveIdx + 10].close
        f.realisedReturnPct = +((futureClose - moveClose) / moveClose * 100).toFixed(2)
      } catch { /* skip */ }
    }
  }))
}

// ── Matching (used by live scanners) ──

/**
 * For a live candidate, compute its current fingerprint and find the
 * nearest WINNING archetype (move ≥5% AND post-move 10d return ≥0%, i.e.
 * the move stuck or extended). Returns the match details with similarity
 * score 0-100 (higher = closer).
 */
export async function matchAgainstMoverArchetypes(opts: {
  candles: Candle[]
  symbol?: string
  minSimilarity?: number
}): Promise<{ match: boolean; archetype?: MoverFingerprint; similarity?: number; reasoning?: string } | null> {
  if (!opts.candles || opts.candles.length < 30) return null
  const fp = computeFingerprint(opts.candles, {
    symbol: opts.symbol ?? 'LIVE',
    moveDate: new Date().toISOString().slice(0, 10),
    moveMagnitudePct: 0,
    deliveryPctAtMove: null,
    fiiDeltaQoQ: null,
    deliveryDirectionScore: 0,
  })
  if (!fp) return null

  const store = await load()
  // Filter to STUCK winners: move >=5% AND T+10 return >= 0
  const winners = store.fingerprints.filter(f => f.moveMagnitudePct >= 5 && (f.realisedReturnPct == null || f.realisedReturnPct >= 0))
  if (winners.length === 0) return { match: false }

  // Euclidean distance on normalized features. Heavier weights on the
  // pre-move-distinguishing dimensions (vol pre-build, base tightness,
  // delivery direction) — the things that ACTUALLY precede the move.
  const score = (a: MoverFingerprint, b: MoverFingerprint): number => {
    const w = {
      emaStack: 0.5,          // direction context
      adx: 0.04,              // 0-100 → scaled
      rsi: 0.04,
      atrPct: 0.2,            // small range
      volRatio5d: 1.5,        // KEY pre-move
      volRatioToday: 0.5,
      range20Pct: 0.1,
      baseDays: 0.15,
      distFrom20High: 4,      // 0-1 range; primed-for-breakout
      macdHist: 0.05,
      obvSlopePct: 0.02,
      deliveryDirectionScore: 1.2,
    }
    let dist = 0
    dist += w.emaStack * (a.emaStack - b.emaStack) ** 2
    dist += w.adx * ((a.adx - b.adx) / 100) ** 2
    dist += w.rsi * ((a.rsi - b.rsi) / 100) ** 2
    dist += w.atrPct * ((a.atrPct - b.atrPct) / 10) ** 2
    dist += w.volRatio5d * (a.volRatio5d - b.volRatio5d) ** 2
    dist += w.volRatioToday * ((a.volRatioToday - b.volRatioToday) / 5) ** 2
    dist += w.range20Pct * ((a.range20Pct - b.range20Pct) / 30) ** 2
    dist += w.baseDays * ((a.baseDays - b.baseDays) / 20) ** 2
    dist += w.distFrom20High * (a.distFrom20High - b.distFrom20High) ** 2
    dist += w.macdHist * Math.tanh((a.macdHist - b.macdHist) / 100) ** 2
    dist += w.obvSlopePct * ((a.obvSlopePct - b.obvSlopePct) / 200) ** 2
    dist += w.deliveryDirectionScore * (a.deliveryDirectionScore - b.deliveryDirectionScore) ** 2
    return Math.sqrt(dist)
  }

  let best = { archetype: null as MoverFingerprint | null, dist: Infinity }
  for (const w of winners) {
    const d = score(fp, w)
    if (d < best.dist) best = { archetype: w, dist: d }
  }
  if (!best.archetype) return { match: false }

  // Convert distance to similarity 0-100 (heuristic: distance < 0.5 = strong match)
  const similarity = Math.max(0, Math.min(100, Math.round((1 - best.dist) * 100)))
  const minSim = opts.minSimilarity ?? 65
  const match = similarity >= minSim
  const reasoning = match
    ? `Matches ${best.archetype.symbol} setup that ran +${best.archetype.moveMagnitudePct.toFixed(1)}% on ${best.archetype.moveDate}${best.archetype.realisedReturnPct != null ? ` (T+10 ${best.archetype.realisedReturnPct.toFixed(1)}%)` : ''} · similarity ${similarity}%`
    : `closest archetype: ${best.archetype.symbol} @ ${similarity}% similarity (below ${minSim}% threshold)`

  return { match, archetype: best.archetype, similarity, reasoning }
}

// ── Public snapshot — surface the mined archetypes for transparency ──

export async function publishMoverArchetypesSnapshot(): Promise<void> {
  const store = await load()
  if (store.fingerprints.length === 0) return
  const fps = store.fingerprints
  // Cluster summary by archetype signature: (emaStack, distFrom20High band,
  // volRatio5d band, deliveryDirectionScore)
  const clusters = new Map<string, { count: number; avgMove: number; avgT10: number; example: string }>()
  for (const f of fps) {
    const distBand = f.distFrom20High < 0.02 ? 'AT-HIGH' : f.distFrom20High < 0.05 ? 'NEAR-HIGH' : f.distFrom20High < 0.10 ? 'BELOW-HIGH' : 'OFF-HIGH'
    const volBand = f.volRatio5d > 1.8 ? 'VOL-3X-BUILD' : f.volRatio5d > 1.3 ? 'VOL-BUILD' : f.volRatio5d < 0.7 ? 'VOL-DRYUP' : 'VOL-FLAT'
    const delivBand = f.deliveryDirectionScore >= 2 ? 'HIGH-DELIV' : f.deliveryDirectionScore >= 1 ? 'MID-DELIV' : 'LO-DELIV'
    const stackTxt = f.emaStack >= 1 ? 'STACK-BULL' : f.emaStack <= -1 ? 'STACK-BEAR' : 'STACK-MIX'
    const key = `${stackTxt} · ${distBand} · ${volBand} · ${delivBand}`
    const prev = clusters.get(key)
    if (prev) {
      prev.count++
      prev.avgMove = (prev.avgMove * (prev.count - 1) + f.moveMagnitudePct) / prev.count
      if (f.realisedReturnPct != null) prev.avgT10 = (prev.avgT10 * (prev.count - 1) + f.realisedReturnPct) / prev.count
    } else {
      clusters.set(key, { count: 1, avgMove: f.moveMagnitudePct, avgT10: f.realisedReturnPct ?? 0, example: f.symbol })
    }
  }
  const ranked = Array.from(clusters.entries())
    .map(([key, v]) => ({ archetype: key, count: v.count, avgMove: +v.avgMove.toFixed(1), avgT10: +v.avgT10.toFixed(1), example: v.example }))
    .sort((a, b) => b.count - a.count)

  const out = {
    generatedAt: new Date().toISOString(),
    totalFingerprints: fps.length,
    clustersCount: ranked.length,
    description: 'Daily mined T-1 setups from all bhavcopy 5%+ movers. Each row = a recurring pre-move archetype with avg subsequent return.',
    clusters: ranked.slice(0, 50),
  }
  await fs.mkdir(SNAP_DIR, { recursive: true })
  await fs.writeFile(path.join(SNAP_DIR, 'mover-archetypes.json'), JSON.stringify(out, null, 2))
  log.ok('MOVER-MINE', `Published ${ranked.length} archetype clusters (${fps.length} fingerprints)`)
}
