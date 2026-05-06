import type { Signal, StrategyContext } from '../types'
import * as data from '../data'
import { fetchBankNiftyOptionChain, fetchNiftyOptionChain } from '../data/nse'
import * as angel from '../data/angel'
import { astroBiasFor } from '../astro'
import { gannBiasFor } from '../gann'
import { intradaySignal } from '../strategies/intraday'
import { swingSignal } from '../strategies/swing'
import { optionsSignal } from '../strategies/options'
import { commoditySignal } from '../strategies/commodity'
import { futuresOptionsAdvisor } from '../strategies/futuresOptionsAdvisor'
import { intradayReversalSignals } from '../strategies/intradayReversal'
import { niftyOptionsStrictSignal } from '../strategies/niftyOptionsStrict'
import { detectOptionsMultiTF, buildOptionsSignal } from '../strategies/optionsMultiTF'
import { buildConfluenceSignal } from '../strategies/optionsConfluence'
import { harmonicSignal } from '../strategies/harmonicSignal'
import { maxPain } from '../options/oiAnalyzer'
import { log } from '../util/logger'
import { resolveUniverse, NIFTY50, NIFTY_NEXT50 } from '../screeners/universe'
import { fundamentalsFactorFires, getTodaysFlow } from './fundamentals'
import { applyDirectionStability } from './directionLedger'
import { recentWin } from './tradeTracker'

interface UniverseItem {
  key: string
  strategies: (
    'intraday' | 'swing' | 'options' | 'commodity' | 'fno' | 'reversal' |
    'nifty-strict' | 'options-mtf' | 'confluence-weekly' | 'confluence-monthly' | 'confluence-quarterly' |
    'harmonic'
  )[]
  higherTf?: boolean
  withOptionChain?: 'NIFTY' | 'BANKNIFTY' | null
}

/**
 * Indices + commodities — always present regardless of the configured equity
 * universe. These three drive the OPTIONS and COMMODITY strategies.
 */
const ANCHORS: UniverseItem[] = [
  // NIFTY: MTF + strict + confluence + harmonic (XABCD pattern signals)
  { key: 'NIFTY', strategies: [
    'intraday', 'swing', 'nifty-strict', 'options-mtf',
    'confluence-weekly', 'confluence-monthly', 'harmonic',
  ], higherTf: true, withOptionChain: 'NIFTY' },
  // GOLD/CRUDE MCX options — weekly + monthly + quarterly for far-month positionals
  { key: 'GOLD',  strategies: [
    'commodity', 'options-mtf', 'harmonic',
    'confluence-weekly', 'confluence-monthly', 'confluence-quarterly',
  ], higherTf: true },
  { key: 'CRUDE', strategies: [
    'commodity', 'options-mtf', 'harmonic',
    'confluence-weekly', 'confluence-monthly', 'confluence-quarterly',
  ], higherTf: true },
  // BANKNIFTY excluded per directive.
]

// F&O-eligible stocks (subset of NSE F&O list — known liquid names)
const FNO_STOCKS = new Set([
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'AXISBANK', 'ITC',
  'LT', 'BHARTIARTL', 'BAJFINANCE', 'KOTAKBANK', 'MARUTI', 'ASIANPAINT',
  'TATAMOTORS', 'TATASTEEL', 'ONGC', 'HCLTECH', 'WIPRO', 'ULTRACEMCO', 'NTPC',
  'POWERGRID', 'ADANIENT', 'ADANIPORTS', 'BAJAJFINSV', 'JSWSTEEL', 'HINDUNILVR',
  'NESTLEIND', 'COALINDIA', 'INDUSINDBK', 'SUNPHARMA', 'EICHERMOT', 'HEROMOTOCO',
  'BRITANNIA', 'DRREDDY', 'GRASIM', 'TITAN', 'DIVISLAB', 'BPCL', 'CIPLA',
  'TECHM', 'HDFCLIFE', 'SBILIFE', 'ADANIGREEN', 'ADANIPOWER', 'TATAPOWER',
  'HAL', 'BEL', 'CANBK', 'BANKBARODA', 'IRCTC', 'IRFC', 'PFC', 'RECLTD',
  'IOC', 'VEDL', 'SAIL', 'PAGEIND', 'PIDILITIND', 'GODREJCP',
])

/**
 * Build the signal-engine universe from the SIGNAL_UNIVERSE env var.
 * - CORE10 (legacy) — the 10 hand-picked names used until 2026-04
 * - NIFTY50 / NEXT50 / NIFTY100 / MIDCAP / SMALLCAP / CNX500 / NSE_ALL
 * Default = NIFTY100 (Nifty 50 + Nifty Next 50 ≈ 100 names) — fits inside
 * Angel's 60 k req/day budget at the 5-min cadence (≈ 14 k req/day).
 */
let cachedUniverse: UniverseItem[] | null = null
let cachedKey: string | null = null

async function buildUniverse(): Promise<UniverseItem[]> {
  const key = (process.env.SIGNAL_UNIVERSE || 'NIFTY100').toUpperCase()
  if (cachedUniverse && cachedKey === key) return cachedUniverse

  let equities: string[] = []
  if (key === 'CORE10') {
    equities = ['RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'ICICIBANK', 'SBIN']
  } else if (key === 'NIFTY100') {
    equities = [...new Set([...NIFTY50, ...NIFTY_NEXT50])]
  } else {
    equities = await resolveUniverse(key)
  }

  const items: UniverseItem[] = [
    ...ANCHORS,
    ...equities.map<UniverseItem>(sym => ({
      key: sym,
      // F&O stocks: MTF options + weekly/monthly confluence + HARMONIC
      //   (user wants XABCD patterns to fire signals BEFORE the move,
      //   not after — see missed 21-Apr NIFTY 24580 short).
      // Non-F&O stocks get intraday + swing + harmonic (structural edge
      //   without needing options-chain data).
      strategies: FNO_STOCKS.has(sym)
        ? ['intraday', 'swing', 'fno', 'reversal', 'options-mtf', 'confluence-weekly', 'confluence-monthly', 'harmonic']
        : ['intraday', 'swing', 'harmonic'],
      higherTf: true,
    })),
  ]
  cachedUniverse = items
  cachedKey = key
  log.ok('UNIVERSE', `Signal engine universe = ${key} (${items.length} instruments: ${ANCHORS.length} anchors + ${equities.length} equities)`)
  return items
}

import type { LifecycleEvent } from './tradeTracker'

export interface EngineOptions {
  /**
   * Snapshot mode — used when NSE/MCX is closed. Lowers each strategy's
   * confluence floor by 1 so the dashboard tabs still surface the last-close
   * stance for every symbol. Resulting signals are tagged tier='WATCH' so
   * the UI can distinguish them from live setups.
   */
  snapshot?: boolean
}

/** Result from runSignalEngine — signals + any cancellations the stability
 *  ledger emitted this run (so the caller can forward them to Telegram). */
export interface EngineRun {
  signals: Signal[]
  invalidations: LifecycleEvent[]
}

export async function runSignalEngine(opts: EngineOptions = {}): Promise<EngineRun> {
  const tag = opts.snapshot ? 'snapshot' : 'live'
  const universe = await buildUniverse()
  log.info('ENGINE', `Starting signal engine (${tag}) over ${universe.length} symbols...`)
  const now = new Date()
  const astro = astroBiasFor(now)
  const signals: Signal[] = []
  // Pre-fetch FII/DII flow once per engine run (shared by all symbols).
  const flow = await getTodaysFlow().catch(() => null)
  const flowDirection: 'BULL' | 'BEAR' | null = flow
    ? (flow.fiiNet + flow.diiNet > 0 ? 'BULL' : flow.fiiNet + flow.diiNet < 0 ? 'BEAR' : null)
    : null

  // Throttle: 2 concurrent symbol scans (was 3). Each scan triggers ~5
  // Angel HTTP calls (15m candles + daily candles + chain + LTP batch +
  // fundamentals). 2 × 5 = 10 in-flight stays well inside Angel's per-second
  // budget AND leaves headroom for the boot-time screener prefetch which
  // also competes for the same connection pool.
  const CONCURRENCY = 2
  let cursor = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < universe.length) {
        const item = universe[cursor++]
        await scanSymbol(item, now, astro, flowDirection, signals, opts)
      }
    }),
  )

  // Drop garbage option signals before they hit the UI / Telegram.
  // A strike <=0 or premium <=0 means the data feed gave us a bad spot
  // upstream — happens occasionally for GOLD/CRUDE on cold-cache or
  // route-mismatch. Better to suppress than ship a "GOLD 0 PE" alert.
  const dropped: Signal[] = []
  for (let i = signals.length - 1; i >= 0; i--) {
    const s = signals[i]
    if (s.type === 'OPTIONS') {
      const m = /\s(\d+(?:\.\d+)?)\s(CE|PE)$/.exec(s.instrument.trim())
      const strike = m ? Number(m[1]) : NaN
      if (!Number.isFinite(strike) || strike <= 0 || s.entry <= 0 || s.target1 <= 0) {
        dropped.push(s)
        signals.splice(i, 1)
      }
    }
  }
  if (dropped.length) log.warn('ENGINE', `Dropped ${dropped.length} invalid option signals (strike/premium ≤ 0): ${dropped.slice(0, 3).map(s => s.instrument).join(', ')}${dropped.length > 3 ? '…' : ''}`)

  // POST-WIN COOLDOWN — suppress opposite-direction signals on a symbol
  // that just hit T1/T2 in the last 5 days. Direct fix for the EPACK case:
  // BUY @ 247 on 23-Apr ran to +18 % by 27-Apr; on 27-Apr the engine fired
  // a SELL at the top of the move. Statistically counter-trend after a
  // fresh win has poor follow-through AND traders who are still long get
  // whipsawed. Cooldown windows match each horizon's hold expectation.
  const COOLDOWN_DAYS: Record<string, number> = {
    INTRADAY: 1, OPTIONS: 1,
    SWING: 5, FUTURES: 5,
    COMMODITY: 3,
    POSITIONAL: 14,
  }
  const cooled: Signal[] = []
  for (let i = signals.length - 1; i >= 0; i--) {
    const s = signals[i]
    const root = s.instrument.split(' ')[0].toUpperCase()
    const lookback = COOLDOWN_DAYS[s.type] ?? 3
    const won = recentWin(root, lookback)
    if (!won) continue
    // Only suppress when new direction OPPOSES the recent winner.
    // (For option legs, BUY CE = bull, BUY PE = bear; map to underlying.)
    const m = /\s(CE|PE)$/.exec(s.instrument.trim())
    const newUnderlyingDir: 'BUY' | 'SELL' = m
      ? (s.direction === 'BUY' && m[1] === 'CE' ? 'BUY' : 'SELL')
      : s.direction
    if (newUnderlyingDir === won.direction) continue
    cooled.push(s)
    signals.splice(i, 1)
  }
  if (cooled.length) log.warn('ENGINE',
    `Post-win cooldown suppressed ${cooled.length} counter-trend signals: ` +
    cooled.slice(0, 4).map(s => `${s.instrument}(${s.direction})`).join(', ') +
    (cooled.length > 4 ? '…' : ''))

  // Stability pass — tag any signal that flips direction and INVALIDATE the
  // contradicted prior trade so we emit an explicit cancellation alert
  // before the new card. Persists last-seen direction to
  // server/data/direction-ledger.json.
  const { invalidations } = await applyDirectionStability(signals)

  signals.sort((a, b) => b.score - a.score)
  const flipped = signals.filter(s => s.stabilityNote).length
  log.ok('ENGINE',
    `Generated ${signals.length} signals (${signals.filter(s => s.grade === 'A').length} grade A` +
    `${flipped ? `, ${flipped} flipped` : ''}` +
    `${invalidations.length ? `, ${invalidations.length} invalidated` : ''}, ${tag})`,
  )
  return { signals, invalidations }
}

async function scanSymbol(
  item: UniverseItem,
  now: Date,
  astro: ReturnType<typeof astroBiasFor>,
  flowDirection: 'BULL' | 'BEAR' | null,
  signals: Signal[],
  opts: EngineOptions,
): Promise<void> {
  try {
    // Fetch 15m candles, optional daily, AND a live quote in parallel.
    // The live quote splices into the LAST bar of each candle array so
    // every downstream strategy reads the current market price — not the
    // 15-min-old close (15m TF) or yesterday's close (daily TF).
    // Same fix as Weekly/Daily Pick — same root cause.
    const [candles15Raw, candlesDRaw, liveQuote] = await Promise.all([
      data.getCandles(item.key, '15m', 200),
      item.higherTf ? data.getCandles(item.key, '1D', 200) : Promise.resolve([] as Awaited<ReturnType<typeof data.getCandles>>),
      data.getQuote(item.key).catch(() => null),
    ])
    if (!candles15Raw.length) return
    const livePx = liveQuote?.price && liveQuote.price > 0 ? liveQuote.price : null
    const candles15 = livePx != null ? overlayLivePrice(candles15Raw, livePx) : candles15Raw
    const candlesD = candlesDRaw.length
      ? (livePx != null ? overlayLivePrice(candlesDRaw, livePx) : candlesDRaw)
      : undefined
    const lastPrice = livePx ?? candles15[candles15.length - 1].close
    const gann = gannBiasFor(item.key, lastPrice, now)
    // Per-symbol fundamentals lookup (silent if no data uploaded yet).
    const fundFires = await fundamentalsFactorFires(item.key).catch(() => false)

    let optionChain = undefined
    if (item.withOptionChain) {
      // Prefer Angel for option chain (real-time OI + LTP); fall back to NSE public API
      let oc = null
      if (angel.hasAngelCreds()) {
        oc = await angel.getOptionChain(item.withOptionChain)
      }
      if (!oc) {
        oc = item.withOptionChain === 'NIFTY'
          ? await fetchNiftyOptionChain()
          : await fetchBankNiftyOptionChain()
      }
      if (oc) {
        oc.maxPain = maxPain(oc)
        optionChain = oc
      }
    }

    const ctx15: StrategyContext = {
      symbol: item.key,
      candles: candles15,
      candlesHigher: candlesD,
      optionChain,
      gannBias: gann,
      astroBias: astro,
      date: now,
      relaxed: opts.snapshot,
      fundamentalsFactorFires: fundFires,
      flowDirection,
    }
    const ctxD: StrategyContext = {
      symbol: item.key,
      candles: candlesD ?? candles15,
      candlesHigher: candlesD,
      optionChain,
      gannBias: gann,
      astroBias: astro,
      date: now,
      relaxed: opts.snapshot,
      fundamentalsFactorFires: fundFires,
      flowDirection,
    }

    for (const strat of item.strategies) {
      if (strat === 'fno') {
        const fnoSigs = futuresOptionsAdvisor(ctx15)
        signals.push(...fnoSigs)
        continue
      }
      if (strat === 'reversal') {
        const revSigs = intradayReversalSignals(ctx15)
        signals.push(...revSigs)
        continue
      }
      if (strat === 'nifty-strict') {
        const nsig = niftyOptionsStrictSignal(ctx15)
        if (nsig) signals.push(nsig)
        continue
      }
      if (strat === 'options-mtf') {
        const hits = detectOptionsMultiTF(candles15, 15)
        if (hits.length) {
          const mtfSig = buildOptionsSignal(ctx15, hits)
          if (mtfSig) signals.push(mtfSig)
        }
        continue
      }
      if (strat === 'confluence-weekly') {
        const sig = buildConfluenceSignal(ctx15, 'WEEKLY')
        if (sig) signals.push(sig)
        continue
      }
      if (strat === 'confluence-monthly') {
        const sig = buildConfluenceSignal(ctxD, 'MONTHLY')
        if (sig) signals.push(sig)
        continue
      }
      if (strat === 'confluence-quarterly') {
        const sig = buildConfluenceSignal(ctxD, 'QUARTERLY')
        if (sig) signals.push(sig)
        continue
      }
      if (strat === 'harmonic') {
        // Prefer daily structural harmonic; strategy internally falls
        // back to the 15m candles for intraday completion.
        const hSig = harmonicSignal(ctxD)
        if (hSig) signals.push(hSig)
        continue
      }
      const sig = strat === 'intraday' ? intradaySignal(ctx15)
        : strat === 'swing' ? swingSignal(ctxD)
        : strat === 'options' ? optionsSignal(ctx15)
        : strat === 'commodity' ? commoditySignal(ctxD)
        : null
      if (sig) signals.push(sig)
    }
  } catch (e) {
    log.err('ENGINE', `${item.key} failed: ${(e as Error).message}`)
  }
}

/**
 * Splice a synthetic "now" candle on top of the candle history using the
 * live LTP. Returns a NEW array (does not mutate the cached input — that
 * array is shared with screeners and other consumers).
 *
 * SANITY GUARD: if the live quote diverges by more than 30 % from the last
 * candle close, we ignore it. Earlier today GOLD's quote came back as 0.30
 * (probably an unrelated option premium leak from the data router) and
 * the overlay collapsed spot, producing "GOLD 0 PE" garbage signals.
 * 30 % is a wide enough sanity band that genuine gap-ups still pass.
 *
 * The synthetic bar inherits open/volume from the prior close so OHLC
 * continuity is preserved; close moves to the live price, high/low expand
 * to encompass it, and TIME bumps to now so downstream `asOf` reflects
 * the overlay rather than the underlying candle's open time.
 */
function overlayLivePrice(candles: import('../types').Candle[], livePx: number): import('../types').Candle[] {
  if (!candles.length) return candles
  const last = candles[candles.length - 1]
  if (last.close <= 0) return candles
  // Skip the overlay if the live price is implausible relative to the
  // existing close — almost certainly a data-router glitch, not a real move.
  const drift = Math.abs(livePx - last.close) / last.close
  if (drift > 0.30) return candles
  // Skip when the price is essentially identical (within 5 bps).
  if (drift < 0.0005) return candles
  const synthetic: import('../types').Candle = {
    ...last,
    time: Date.now(),
    close: livePx,
    high: Math.max(last.high, livePx),
    low: Math.min(last.low, livePx),
  }
  return [...candles.slice(0, -1), synthetic]
}

/**
 * On-demand signal for a single symbol — used by bot `/status SYMBOL` etc.
 */
export async function signalForSymbol(symbol: string): Promise<Signal[]> {
  const candles15 = await data.getCandles(symbol, '15m', 200)
  const candlesD = await data.getCandles(symbol, '1D', 200)
  if (!candles15.length) return []
  const now = new Date()
  const astro = astroBiasFor(now)
  const gann = gannBiasFor(symbol, candles15[candles15.length - 1].close, now)
  const ctx: StrategyContext = {
    symbol,
    candles: candles15,
    candlesHigher: candlesD,
    gannBias: gann,
    astroBias: astro,
    date: now,
  }
  const ctxD = { ...ctx, candles: candlesD }
  const out: Signal[] = []
  const s1 = intradaySignal(ctx); if (s1) out.push(s1)
  const s2 = swingSignal(ctxD); if (s2) out.push(s2)
  return out
}
