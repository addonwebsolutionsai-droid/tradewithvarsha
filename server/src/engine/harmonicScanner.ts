import * as data from '../data'
import { detectAllHarmonics, type HarmonicPattern } from '../patterns/harmonic'
import { resample } from '../strategies/mtfAggregator'
import { sessionHoras, horaAt } from '../astro/parashariHora'
import { resolveUniverse } from '../screeners/universe'
import { log } from '../util/logger'
import type { Candle } from '../types'

/**
 * Multi-timeframe Harmonic Pattern scanner.
 *
 * Scans the watchlist symbols across every requested timeframe and returns
 * every Bat / Gartley / Butterfly / Crab / Cypher / Shark pattern that
 * completed in the recent N bars. Each row carries:
 *   - the pattern name + confidence score
 *   - bullish / bearish direction
 *   - entry, SL, T1, T2, T3 prices (Carney targets — see harmonic.ts)
 *   - projected T1/T2/T3 dates based on the timeframe's bar duration
 *   - Parashari hora-aligned best entry time on the entry date
 *   - human-readable reason explaining the Fibonacci ratios that fired
 *
 * Powers the "Harmonic Patterns" dashboard tab the user requested
 * after sharing Trading Strategy Guides' "Ultimate Harmonic Pattern" PDF.
 */

export interface HarmonicTimeframe {
  /** Display label e.g. "5m", "15m", "1h", "1D" */
  label: string
  /** Minutes per candle. Daily=1440, weekly=10080, monthly≈43200. */
  minutes: number
  /** Source timeframe to fetch and resample from. */
  source: '5m' | '15m' | '1D'
  /** Lookback window (bars) — capped per source to avoid huge payloads. */
  lookback: number
  /** Tier classification — controls which universe size this TF scans. */
  tier: 'INTRADAY' | 'HOURLY' | 'POSITIONAL'
}

/**
 * The 11 timeframes the user requested:
 *   5m · 15m · 30m · 45m · 1h · 2h · 3h · 4h · 1d · 1w · 1mo
 *
 * Tiered by source candle: 5m + 15m + 30m + 45m source from 5m feed (we
 * resample 5m → 30m / 45m to get those bars). 1h-4h source from 15m feed.
 * 1D / 1W / 1M source from 1D feed.
 *
 * Tier controls the universe size each TF scans against (see TIER_CONFIG):
 *  - INTRADAY  = top-200 liquid (5m / 15m / 30m / 45m) — heaviest data load
 *  - HOURLY    = NIFTY 500 core (1h / 2h / 3h / 4h)
 *  - POSITIONAL = ENTIRE NSE universe (1D / 1W / 1M)
 *
 * Daily/weekly/monthly is where the user's missed-trade examples live
 * (Maruti, Reliance, ICICI, Kotak — all daily harmonic) so the positional
 * tier MUST cover the entire NSE_ALL set.
 */
export const HARMONIC_TIMEFRAMES: HarmonicTimeframe[] = [
  // INTRADAY — 5m feed source
  { label: '5m',  minutes: 5,     source: '5m',  lookback: 250, tier: 'INTRADAY' },
  { label: '15m', minutes: 15,    source: '15m', lookback: 200, tier: 'INTRADAY' },
  { label: '30m', minutes: 30,    source: '15m', lookback: 200, tier: 'INTRADAY' },
  { label: '45m', minutes: 45,    source: '15m', lookback: 200, tier: 'INTRADAY' },
  // HOURLY — 15m feed source (resampled)
  { label: '1h',  minutes: 60,    source: '15m', lookback: 200, tier: 'HOURLY' },
  { label: '2h',  minutes: 120,   source: '15m', lookback: 200, tier: 'HOURLY' },
  { label: '3h',  minutes: 180,   source: '15m', lookback: 200, tier: 'HOURLY' },
  { label: '4h',  minutes: 240,   source: '15m', lookback: 200, tier: 'HOURLY' },
  // POSITIONAL — 1D feed source
  { label: '1D',  minutes: 1440,  source: '1D',  lookback: 300, tier: 'POSITIONAL' },
  { label: '1W',  minutes: 10080, source: '1D',  lookback: 400, tier: 'POSITIONAL' },
  { label: '1M',  minutes: 43200, source: '1D',  lookback: 500, tier: 'POSITIONAL' },
]

export type Tier = 'INTRADAY' | 'HOURLY' | 'POSITIONAL'

/**
 * Per-tier universe-size policy. The user wants ALL NSE-listed equities
 * (~1900) covered on daily-and-above; intraday tiers cap at the most-liquid
 * 200 names because each 5m fetch is ~250 bars vs ~300 for 1D, AND the
 * intraday scan runs every 30 min vs once-a-day for positional.
 */
export const TIER_CONFIG: Record<Tier, { universe: 'NSE_ALL' | 'CNX500' | 'NIFTY200'; concurrency: number }> = {
  POSITIONAL: { universe: 'NSE_ALL', concurrency: 4 },
  HOURLY:     { universe: 'CNX500',  concurrency: 3 },
  INTRADAY:   { universe: 'NIFTY200', concurrency: 3 },
}

/** Resolve the symbol set for a tier. NIFTY200 ≈ NIFTY50 + NEXT50 + top-100 midcap. */
async function resolveTierUniverse(tier: Tier): Promise<string[]> {
  const cfg = TIER_CONFIG[tier]
  if (cfg.universe === 'NIFTY200') {
    const [n50, next50, midcap] = await Promise.all([
      resolveUniverse('NIFTY50'),
      resolveUniverse('NEXT50'),
      resolveUniverse('MIDCAP'),
    ])
    return [...new Set([...n50, ...next50, ...midcap.slice(0, 100)])]
  }
  return resolveUniverse(cfg.universe)
}

export interface HarmonicHit {
  symbol: string
  timeframe: string                   // '5m' / '15m' / '1h' / '1D' / '1W' / '1M'
  tier: Tier
  patternName: HarmonicPattern['name']
  direction: 'BULLISH' | 'BEARISH'
  /** Trade direction in plain words (matches the user's chart annotations). */
  trade: 'BUY' | 'SELL'
  confidence: number                  // 0-100
  ltp: number                          // last live close (price right now)
  // PRZ — Potential Reversal Zone (entry band around D)
  przLow: number
  przHigh: number
  // Prices (entry = D mid-PRZ, except SHARK where entry = C)
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  // Trade dates and times
  detectedAt: string                  // ISO timestamp of D bar (when pattern completed)
  entryDate: string                   // YYYY-MM-DD — next bar after D
  entryTimeIST: string                // HH:MM IST — best execution slot on entryDate (hora-aligned)
  bestEntryTimeIST: string            // alias for backward compat
  horaLord: string
  target1Date: string
  target2Date: string
  target3Date: string
  // **Invalidation rule** — explicit so the trader knows when to abort
  invalidationPrice: number           // exact price level beyond which pattern is dead
  invalidationRule: string            // human-readable rule
  // R:R + reasoning
  riskReward: number                  // (T1 - entry) / (entry - SL) — symmetric for SHORT
  reasons: string[]
  ratios: HarmonicPattern['ratios']
  // For chart overlays
  pivots: { label: 'X' | 'A' | 'B' | 'C' | 'D'; price: number; time: number }[]
  ageBars: number
  /** Stable de-dup key (symbol|tf|pattern|direction|D-time) for Telegram. */
  sigKey: string
}

export interface HarmonicScanRun {
  generatedAt: string
  symbolsScanned: number
  timeframesScanned: number
  totalPatterns: number
  /** Which tier this run covered (or 'ALL' for the merged combined run). */
  tier: Tier | 'ALL'
  hits: HarmonicHit[]
}

// Tier-scoped caches so each cron's last result is independently retrievable.
let lastByTier: Record<Tier, HarmonicScanRun | null> = {
  POSITIONAL: null, HOURLY: null, INTRADAY: null,
}
let lastCombined: HarmonicScanRun | null = null
let scanInFlight: Record<Tier, boolean> = {
  POSITIONAL: false, HOURLY: false, INTRADAY: false,
}
const sentSigKeys = new Set<string>()

export function getLastHarmonicScan(tier?: Tier | 'ALL'): HarmonicScanRun | null {
  if (!tier || tier === 'ALL') return lastCombined ?? composeAll()
  return lastByTier[tier]
}

export function clearHarmonicDedup(): void { sentSigKeys.clear() }

/**
 * Filter hits to only those NOT seen in any earlier run today. Caller (the
 * Telegram dispatcher) records the keys so the same pattern doesn't push
 * twice in a session. Cleared by midnight cron.
 */
export function takeFreshHarmonicHits(hits: HarmonicHit[]): HarmonicHit[] {
  const fresh: HarmonicHit[] = []
  for (const h of hits) {
    if (sentSigKeys.has(h.sigKey)) continue
    sentSigKeys.add(h.sigKey)
    fresh.push(h)
  }
  return fresh
}

/**
 * Tier-scoped scan. Each cron schedule calls runHarmonicScan({ tier }):
 *   - POSITIONAL → 1D / 1W / 1M across NSE_ALL (~1900 symbols, 1× per day)
 *   - HOURLY     → 1h / 2h / 3h / 4h across CNX500 (~500 symbols, every hour)
 *   - INTRADAY   → 5m / 15m / 30m / 45m across NIFTY200 (every 30 min)
 *
 * The legacy unified call (no opts) merges previously-cached results from
 * every tier so existing callers (HarmonicPage, /api/harmonic-scan) keep
 * working unchanged.
 */
export async function runHarmonicScan(opts?: {
  /** Run only one tier. If omitted, runs ALL three sequentially (slower). */
  tier?: Tier
  /** Override universe symbols (escape-hatch for tests / one-off probes). */
  symbols?: string[]
  /** Override TFs scanned. Default: every TF whose tier matches the run. */
  timeframes?: HarmonicTimeframe[]
  /** Minimum pattern confidence to keep. Default 60. */
  minConfidence?: number
}): Promise<HarmonicScanRun> {
  // Multi-tier mode (legacy callers without opts) — run each tier and merge
  if (!opts?.tier && !opts?.symbols) {
    const tiers: Tier[] = ['POSITIONAL', 'HOURLY', 'INTRADAY']
    for (const t of tiers) {
      try { await runHarmonicScan({ tier: t, minConfidence: opts?.minConfidence }) }
      catch (e) { log.warn('HARMONIC', `tier ${t}: ${(e as Error).message}`) }
    }
    return composeAll()
  }

  const tier: Tier = opts?.tier ?? 'POSITIONAL'
  if (scanInFlight[tier]) {
    log.warn('HARMONIC', `${tier} scan already running; returning last result`)
    return lastByTier[tier] ?? emptyRun(tier)
  }
  scanInFlight[tier] = true
  try {
    const symbols = opts?.symbols ?? await resolveTierUniverse(tier)
    const tfs = opts?.timeframes ?? HARMONIC_TIMEFRAMES.filter(t => t.tier === tier)
    const minConfidence = opts?.minConfidence ?? 60
    const concurrency = TIER_CONFIG[tier].concurrency
    const startedAt = Date.now()
    log.info('HARMONIC', `[${tier}] Scanning ${symbols.length} symbols × ${tfs.length} TFs (min conf ${minConfidence}, concurrency ${concurrency})`)

    const hits: HarmonicHit[] = []
    let cursor = 0

    // Pre-compute which source feeds we need so we don't fetch unnecessarily
    const needs5m  = tfs.some(t => t.source === '5m')
    const needs15m = tfs.some(t => t.source === '15m')
    const needs1D  = tfs.some(t => t.source === '1D')

    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (cursor < symbols.length) {
        const sym = symbols[cursor++]
        try {
          const [candles5Raw, candles15Raw, candlesDRaw] = await Promise.all([
            needs5m  ? data.getCandles(sym, '5m',  300).catch(() => [] as Candle[]) : Promise.resolve([] as Candle[]),
            needs15m ? data.getCandles(sym, '15m', 300).catch(() => [] as Candle[]) : Promise.resolve([] as Candle[]),
            needs1D  ? data.getCandles(sym, '1D',  600).catch(() => [] as Candle[]) : Promise.resolve([] as Candle[]),
          ])
          for (const tf of tfs) {
            const base =
              tf.source === '5m'  ? candles5Raw  :
              tf.source === '15m' ? candles15Raw :
                                    candlesDRaw
            const baseMin =
              tf.source === '5m'  ? 5  :
              tf.source === '15m' ? 15 :
                                    1440
            if (base.length < 30) continue
            const series = tf.minutes === baseMin
              ? base
              : resample(base, baseMin, tf.minutes as 30 | 45 | 60 | 120 | 180 | 240 | 10080 | 43200)
            if (series.length < 30) continue

            // Adaptive swing threshold — scale by the symbol's typical move so
            // calm large-caps still fire patterns and noisy smallcaps don't
            // generate junk.
            const sample = series.slice(-30)
            const avgRangePct = sample.length
              ? sample.reduce((s, c) => s + (c.high - c.low) / Math.max(c.close, 1), 0) / sample.length * 100
              : 0
            const baseSwing = tfMinSwing(tf.minutes)
            const adaptiveSwing = Math.min(baseSwing, Math.max(0.25, avgRangePct * 0.6))
            const patterns = detectAllHarmonics(series.slice(-tf.lookback), {
              minSwingPct: adaptiveSwing,
              maxAgeBars: 12,
              minConfidence,
            })
            for (const p of patterns) {
              hits.push(toHit(sym, tf, p, series))
            }
          }
        } catch (e) {
          log.warn('HARMONIC', `${sym}: ${(e as Error).message}`)
        }
      }
    }))

    hits.sort((a, b) => (b.confidence - a.confidence) || (a.ageBars - b.ageBars))
    const run: HarmonicScanRun = {
      generatedAt: new Date().toISOString(),
      symbolsScanned: symbols.length,
      timeframesScanned: tfs.length,
      totalPatterns: hits.length,
      tier,
      hits,
    }
    lastByTier[tier] = run
    lastCombined = composeAll()
    log.ok('HARMONIC',
      `[${tier}] Scan done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${hits.length} patterns across ${symbols.length} symbols`)
    return run
  } finally {
    scanInFlight[tier] = false
  }
}

function composeAll(): HarmonicScanRun {
  const all = ([] as HarmonicHit[]).concat(
    lastByTier.POSITIONAL?.hits ?? [],
    lastByTier.HOURLY?.hits ?? [],
    lastByTier.INTRADAY?.hits ?? [],
  )
  all.sort((a, b) => (b.confidence - a.confidence) || (a.ageBars - b.ageBars))
  const symbolsSet = new Set(all.map(h => h.symbol))
  const tfsSet = new Set(all.map(h => h.timeframe))
  return {
    generatedAt: new Date().toISOString(),
    symbolsScanned: symbolsSet.size,
    timeframesScanned: tfsSet.size,
    totalPatterns: all.length,
    tier: 'ALL',
    hits: all,
  }
}

function emptyRun(tier: Tier | 'ALL' = 'ALL'): HarmonicScanRun {
  return { generatedAt: new Date().toISOString(), symbolsScanned: 0, timeframesScanned: 0, totalPatterns: 0, tier, hits: [] }
}

/**
 * Picks a sensible minimum swing % per timeframe so we don't generate
 * dozens of tiny noise-patterns on intraday TFs. Larger TF → bigger swings.
 */
function tfMinSwing(minutes: number): number {
  if (minutes <= 15) return 0.4
  if (minutes <= 60) return 0.6
  if (minutes <= 240) return 1.0
  if (minutes <= 1440) return 1.5
  if (minutes <= 10080) return 2.5
  return 4.0
}

function toHit(sym: string, tf: HarmonicTimeframe, p: HarmonicPattern, series: Candle[]): HarmonicHit {
  const trade: 'BUY' | 'SELL' = p.direction === 'BULLISH' ? 'BUY' : 'SELL'
  const lastBar = series[series.length - 1]
  const ltp = +(lastBar?.close ?? p.D.price).toFixed(2)
  const detectedAt = new Date(p.completedAt).toISOString()
  // Project T1/T2/T3 dates from the timeframe's bar duration. Conservative
  // multipliers — patterns typically reach T1 in ~5-10 bars, T2 in ~15-25.
  const barMs = tf.minutes * 60_000
  const t1Date = new Date(p.completedAt + 8  * barMs)
  const t2Date = new Date(p.completedAt + 18 * barMs)
  const t3Date = new Date(p.completedAt + 35 * barMs)
  const entryDateD = new Date(p.completedAt + 1 * barMs)
  // Hora window for the entry day (intraday TFs care most; daily-plus get the
  // first hora aligned with the pattern's direction).
  const horas = sessionHoras(entryDateD)
  const wantsBull = p.direction === 'BULLISH'
  const aligned = horas.find(h => wantsBull ? h.bias === 'BULLISH' : h.bias === 'BEARISH')
  const horaPick = aligned ?? horas.find(h => h.bias === 'VOLATILE') ?? horas[0] ?? horaAt(entryDateD)
  // T3 = 1.6 × distance from entry to T2 (geometric extension)
  const t3 = +(p.D.price + (p.targets.t2 - p.D.price) * 1.6).toFixed(2)

  // Invalidation: per Carney, the pattern is dead if price closes BEYOND X
  // (the original swing-extreme that anchors the structure). For BULLISH
  // patterns, X is the high; if price closes above X (the SL is even tighter
  // — at the structural break) the pattern voids. Use SL as the operational
  // invalidation (tighter than X) and X as the structural absolute kill.
  const invalidationPrice = p.targets.sl
  const invalidationRule = p.direction === 'BULLISH'
    ? `Pattern voids if price closes BELOW ₹${invalidationPrice.toFixed(2)} on the ${tf.label} timeframe (structural break of D / X-anchor at ₹${p.X.price.toFixed(2)}). Cut the trade.`
    : `Pattern voids if price closes ABOVE ₹${invalidationPrice.toFixed(2)} on the ${tf.label} timeframe (structural break of D / X-anchor at ₹${p.X.price.toFixed(2)}). Cut the trade.`

  // R:R from entry to T1
  const risk = Math.abs(p.D.price - p.targets.sl)
  const reward1 = Math.abs(p.targets.t1 - p.D.price)
  const riskReward = +(reward1 / Math.max(0.01, risk)).toFixed(2)

  const sigKey = `${sym}|${tf.label}|${p.name}|${p.direction}|${p.completedAt}`

  // entryTimeIST = the start of the hora-aligned slot (single time, not a range)
  const entryTimeIST = horaPick.startIST

  return {
    symbol: sym,
    timeframe: tf.label,
    tier: tf.tier,
    patternName: p.name,
    direction: p.direction,
    trade,
    confidence: p.confidence,
    ltp,
    przLow: p.prz.low,
    przHigh: p.prz.high,
    entry: p.D.price,
    stopLoss: p.targets.sl,
    target1: p.targets.t1,
    target2: p.targets.t2,
    target3: t3,
    detectedAt,
    entryDate: entryDateD.toISOString().slice(0, 10),
    entryTimeIST,
    bestEntryTimeIST: `${horaPick.startIST}-${horaPick.endIST}`,
    horaLord: horaPick.lord,
    target1Date: t1Date.toISOString().slice(0, 10),
    target2Date: t2Date.toISOString().slice(0, 10),
    target3Date: t3Date.toISOString().slice(0, 10),
    invalidationPrice,
    invalidationRule,
    riskReward,
    reasons: [
      `${trade} ${sym} via ${p.name} ${p.direction.toLowerCase()} (${p.confidence}% confidence)`,
      ...buildReasons(p, tf),
      `Invalidation: ${invalidationRule}`,
    ],
    ratios: p.ratios,
    pivots: [
      { label: 'X', price: p.X.price, time: p.X.time },
      { label: 'A', price: p.A.price, time: p.A.time },
      { label: 'B', price: p.B.price, time: p.B.time },
      { label: 'C', price: p.C.price, time: p.C.time },
      { label: 'D', price: p.D.price, time: p.D.time },
    ],
    ageBars: p.ageBars,
    sigKey,
  }
}

function buildReasons(p: HarmonicPattern, tf: HarmonicTimeframe): string[] {
  const r: string[] = []
  const f = (n: number) => n.toFixed(3)
  r.push(`Timeframe: ${tf.label}`)
  r.push(`Pivots: X=${p.X.price.toFixed(2)} → A=${p.A.price.toFixed(2)} → B=${p.B.price.toFixed(2)} → C=${p.C.price.toFixed(2)} → D=${p.D.price.toFixed(2)}`)
  r.push(`Fibonacci ratios — B/XA: ${f(p.ratios.B_over_XA)} · C/AB: ${f(p.ratios.C_over_AB)} · D/XA: ${f(p.ratios.D_over_XA)} · BC ext: ${f(p.ratios.BCProjection)}`)
  r.push(`PRZ (Potential Reversal Zone): ${p.prz.low.toFixed(2)} – ${p.prz.high.toFixed(2)}`)
  switch (p.name) {
    case 'BAT':       r.push('Bat — deep XA retest (88.6 %), tight SL, smooth reversal expected'); break
    case 'GARTLEY':   r.push('Gartley 222 — shallow B (0.618 XA), classical low-risk reversal'); break
    case 'BUTTERFLY': r.push('Butterfly — D extends 1.272-1.618 of XA, sharp reversal target'); break
    case 'CRAB':      r.push('Crab — explosive 1.618 XA extension, requires wide SL but high R:R'); break
    case 'CYPHER':    r.push('Cypher — highest historical win-rate harmonic, rare structure'); break
    case 'SHARK':     r.push('Shark — 5-point structure, enter at C, target 50 % of BC retracement'); break
    case 'ABCD':      r.push('AB=CD — basic measured-move harmonic'); break
  }
  return r
}

// ─── Telegram formatter ───────────────────────────────────────

/**
 * Format a batch of fresh harmonic hits as a single Telegram-ready Markdown
 * message. Each hit prints the full trade plan: entry date+time, PRZ band,
 * entry price, SL, T1/T2/T3, R:R, and the explicit invalidation rule.
 */
export function formatHarmonicHitsForTelegram(hits: HarmonicHit[]): string {
  if (!hits.length) return ''
  const lines: string[] = []
  lines.push(`💎 *HARMONIC PATTERNS — ${hits.length} fresh signal${hits.length > 1 ? 's' : ''}*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  // Cap per-message at 12 to stay within Telegram's 4096-char limit
  const slice = hits.slice(0, 12)
  for (const h of slice) {
    const arrow = h.trade === 'BUY' ? '🟢 BUY' : '🔴 SELL'
    lines.push(`${arrow} *${h.symbol}* · ${h.timeframe} · _${h.patternName}_ · conf ${h.confidence}%`)
    lines.push(`   LTP \`${h.ltp}\` · PRZ \`${h.przLow.toFixed(2)} – ${h.przHigh.toFixed(2)}\``)
    lines.push(`   Entry \`${h.entry}\` (on ${h.entryDate} ~${h.entryTimeIST} IST · ${h.horaLord} hora)`)
    lines.push(`   SL \`${h.stopLoss}\` · T1 \`${h.target1}\` (${h.target1Date}) · T2 \`${h.target2}\` (${h.target2Date}) · T3 \`${h.target3}\` (${h.target3Date})`)
    lines.push(`   R:R 1:${h.riskReward}`)
    lines.push(`   _Invalidation:_ ${h.invalidationRule}`)
    lines.push('')
  }
  if (hits.length > slice.length) {
    lines.push(`+ ${hits.length - slice.length} more in dashboard.`)
    lines.push('')
  }
  lines.push(`_Pure Carney harmonic detector — ratios + PRZ only._`)
  lines.push(`*#tradewithvarsha*`)
  return lines.join('\n')
}
