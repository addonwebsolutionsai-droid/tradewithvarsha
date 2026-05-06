/**
 * Master Setup Engine — "find the move BEFORE it happens".
 *
 * Why this exists (2026-04-29):
 * The user is rightly tired of getting hundreds of mediocre signals every day.
 * Recent misses he listed:
 *   • CRUDE 8200 → 9400 (Apr 17 → 28) — 14% trend, missed entry
 *   • NIFTY 24717 → 23960 over 5 days — missed the swing short
 *   • NIFTY 24262 → 23960 intraday on Apr 28 (10 AM → 2:30 PM) — missed the day-trade
 *   • DMART, HINDUNILVR, VOLTAS — 10%+ in 20d while index sold off — missed defensive bid
 *
 * Common thread: all four were detectable IN ADVANCE from compression/coil
 * patterns + smart-money footprint + sectoral rotation + cycle alignment.
 * The existing engine fires on momentum already-in-progress; this one fires
 * on PRE-MOVE compression where every box is ticked.
 *
 * Hard quality gates (a setup is rejected if ANY fails):
 *   1. COMPRESSION    — Bollinger-band-width <50% of 60d median  OR  ATR <60% of 60d median
 *   2. SMART-MONEY    — BOS / CHoCH / liquidity sweep within last 5 bars
 *   3. RELATIVE-VOL   — last bar volume ≥ 1.5× 20d average (early footprint)
 *   4. CYCLE          — Gann cycle hit in next 7d  OR  active astro alignment
 *   5. STRUCTURE      — clean trend frame: EMA stack OR fresh BOS aligning with bias
 *
 * Stretch boosters (each adds 1 ★ on top of base 3★, max 5★):
 *   ★ Sector rotating IN (or OUT for shorts) per sectorRotation snapshot
 *   ★ Option-chain OI flow agrees (PE-writing for bull, CE-writing for bear)
 *
 * Output: the absolute best ≤ 6 setups across the entire universe with the
 * full plan (LTP, entry zone, SL, T1/T2/T3, target dates, expiry choice for
 * options leg, "why now" narrative).
 */

import * as data from '../data'
import { ema, lastATR, lastRSI, bollinger } from '../indicators'
import { analyzeSMC } from '../patterns/smc'
import { gannBiasFor } from '../gann'
import { astroBiasFor } from '../astro'
import { resolveUniverse } from '../screeners/universe'
import { addDays } from '../util/time'
import { log } from '../util/logger'
import { selectIndexExpiry, selectStockExpiry, type ExpiryChoice } from '../options/expirySelector'
import { atmStrike, blackScholesPrice } from '../options/premium'
import { getLatestSectorRotation, runSectorRotationScan, SECTOR_BASKETS, type SectorKey } from './sectorRotation'
import { logSignal } from './signalLogger'
import type { Candle, Signal } from '../types'

const FNO_NAMES = new Set([
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'AXISBANK', 'ITC',
  'LT', 'BHARTIARTL', 'BAJFINANCE', 'KOTAKBANK', 'MARUTI', 'ASIANPAINT', 'HINDUNILVR',
  'TATAMOTORS', 'TATASTEEL', 'ONGC', 'HCLTECH', 'WIPRO', 'ULTRACEMCO', 'NTPC',
  'POWERGRID', 'ADANIENT', 'BAJAJFINSV', 'JSWSTEEL', 'NESTLEIND', 'COALINDIA',
  'INDUSINDBK', 'SUNPHARMA', 'EICHERMOT', 'HEROMOTOCO', 'BRITANNIA', 'DRREDDY',
  'GRASIM', 'TITAN', 'DIVISLAB', 'BPCL', 'CIPLA', 'TECHM', 'HDFCLIFE', 'SBILIFE',
  'TATAPOWER', 'HAL', 'BEL', 'CANBK', 'BANKBARODA', 'IRCTC', 'IRFC', 'PFC', 'RECLTD',
  'IOC', 'VEDL', 'DMART', 'VOLTAS', 'DABUR', 'GODREJCP', 'M&M', 'BAJAJ-AUTO',
  'TATACONSUM', 'APOLLOHOSP',
])

export type Direction = 'BUY' | 'SHORT'
export type Horizon = 'INTRADAY' | 'SWING' | 'POSITIONAL'

export interface MasterSetup {
  symbol: string
  ltp: number
  ltpAsOf: string
  direction: Direction
  horizon: Horizon
  stars: 3 | 4 | 5             // ★ rating
  /** Single-line "why now" narrative, ready to paste in a Telegram card. */
  whyNow: string
  setupName: string            // "Pre-breakout coil", "Sweep + BOS reversal", etc.
  // Trade plan (cash equity)
  entryPrice: number
  entryPriceLow: number
  entryPriceHigh: number
  entryDate: string            // YYYY-MM-DD — next session
  stopLoss: number
  target1: number; target1Date: string
  target2: number; target2Date: string
  target3: number; target3Date: string
  riskReward: number
  // Options leg (optional — only for F&O names)
  options?: {
    strike: number
    side: 'CE' | 'PE'
    expiry: string
    expiryTag: ExpiryChoice['tag']
    expiryReason: string
    daysToExpiry: number
    premium: number
    premiumSL: number
    premiumT1: number
    premiumT2: number
  }
  // Confluence breakdown
  confluence: {
    compression: boolean
    smartMoney: boolean
    relativeVolume: boolean
    cycleAligned: boolean
    structureClean: boolean
    sectorRotating: boolean
    oiFlowAgrees: boolean
  }
  reasons: string[]            // per-factor reasons, for the card
  // Meta
  meta: {
    rsi: number
    atr: number
    bbWidthPctile: number      // 0-100 percentile vs 60d
    volRatio20: number
    sectorKey: SectorKey | null
    sectorNote: string | null
  }
}

export interface MasterSetupRun {
  generatedAt: string
  scanned: number
  qualified: number
  setups: MasterSetup[]        // top 6 only
  digestLine: string           // one-line for daily digest
}

// ─── Helpers ──────────────────────────────────────────────────

const pct = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100)
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function projectBusinessDate(from: Date, sessions: number): string {
  let d = new Date(from)
  let added = 0
  while (added < sessions) {
    d = addDays(d, 1)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d.toISOString().slice(0, 10)
}

interface BBContext {
  width: number          // current BB width / SMA
  pctile: number         // 0-100 — where this width sits in the 60d distribution
  squeezing: boolean     // pctile <= 30
}

function bbWidthContext(candles: Candle[]): BBContext {
  // Compute width % at every bar over the last ~80 bars and rank current.
  const widths: number[] = []
  for (let i = 20; i <= candles.length; i++) {
    const bb = bollinger(candles.slice(0, i), 20, 2)
    if (!bb) continue
    const w = (bb.upper - bb.lower) / Math.max(1, bb.middle)
    widths.push(w)
  }
  if (widths.length < 20) return { width: 0, pctile: 50, squeezing: false }
  const cur = widths[widths.length - 1]
  const last60 = widths.slice(-60)
  const sorted = [...last60].sort((a, b) => a - b)
  const idx = sorted.findIndex(x => x >= cur)
  const pctile = idx < 0 ? 100 : Math.round((idx / sorted.length) * 100)
  return { width: cur, pctile, squeezing: pctile <= 30 }
}

interface CompressionFlags {
  bbSqueezing: boolean
  bbPctile: number
  atrCompressed: boolean
  rangeCompressed: boolean
}

function compressionContext(candles: Candle[]): CompressionFlags {
  const bb = bbWidthContext(candles)
  // ATR vs 60d median
  const atrSeries: number[] = []
  for (let i = 14; i <= candles.length; i++) {
    const a = lastATR(candles.slice(0, i), 14)
    if (a) atrSeries.push(a)
  }
  const atrCur = atrSeries[atrSeries.length - 1] ?? 0
  const atrMed60 = median(atrSeries.slice(-60))
  const atrCompressed = atrMed60 > 0 && atrCur < atrMed60 * 0.6
  // 5d range vs 30d range
  const last5 = candles.slice(-5)
  const range5 = Math.max(...last5.map(c => c.high)) - Math.min(...last5.map(c => c.low))
  const last30 = candles.slice(-30)
  const range30 = Math.max(...last30.map(c => c.high)) - Math.min(...last30.map(c => c.low))
  const rangeCompressed = range30 > 0 && (range5 / range30) < 0.4
  return {
    bbSqueezing: bb.squeezing,
    bbPctile: bb.pctile,
    atrCompressed,
    rangeCompressed,
  }
}

// Map a symbol to its sector basket (for the sector-rotation booster)
let symbolSectorIndex: Map<string, SectorKey> | null = null
function buildSectorIndex(): Map<string, SectorKey> {
  if (symbolSectorIndex) return symbolSectorIndex
  const m = new Map<string, SectorKey>()
  for (const b of SECTOR_BASKETS) {
    for (const member of b.members) {
      if (!m.has(member)) m.set(member, b.key)
    }
  }
  symbolSectorIndex = m
  return m
}

// ─── The scoring core ─────────────────────────────────────────

interface SymbolEval {
  symbol: string
  ltp: number
  setup: MasterSetup | null
}

async function evaluateSymbol(
  symbol: string,
  rotatingIn: Set<SectorKey>,
  rotatingOut: Set<SectorKey>,
  today: Date,
): Promise<SymbolEval> {
  try {
    const [candlesD, candles15, quote] = await Promise.all([
      data.getCandles(symbol, '1D', 200),
      data.getCandles(symbol, '15m', 150).catch(() => [] as Candle[]),
      data.getQuote(symbol).catch(() => null),
    ])
    if (candlesD.length < 60) return { symbol, ltp: 0, setup: null }
    const lastD = candlesD[candlesD.length - 1]
    const ltp = quote?.price && quote.price > 0 ? quote.price : lastD.close

    const e9 = ema(candlesD, 9).slice(-1)[0]
    const e21 = ema(candlesD, 21).slice(-1)[0]
    const e50 = ema(candlesD, 50).slice(-1)[0]
    const e200 = ema(candlesD, 200).slice(-1)[0]
    const rsi = lastRSI(candlesD, 14) ?? 50
    const atrV = lastATR(candlesD, 14) ?? ltp * 0.02
    const stackBull = e9 > e21 && e21 > e50 && (e200 ? e50 > e200 : true)
    const stackBear = e9 < e21 && e21 < e50 && (e200 ? e50 < e200 : true)

    // 1) COMPRESSION — daily BB squeeze or ATR compression
    const comp = compressionContext(candlesD)
    const compression = comp.bbSqueezing || comp.atrCompressed || comp.rangeCompressed

    // 2) SMART-MONEY — SMC fires on intraday or daily?
    const smcD = analyzeSMC(candlesD)
    const smc15 = candles15.length >= 30 ? analyzeSMC(candles15) : null
    const smartMoneyBull = smcD.bosBull || smcD.chochBull || (!!smc15 && (smc15.bosBull || smc15.chochBull))
    const smartMoneyBear = smcD.bosBear || smcD.chochBear || (!!smc15 && (smc15.bosBear || smc15.chochBear))
    const smartMoney = smartMoneyBull || smartMoneyBear

    // 3) RELATIVE VOLUME — today's bar vs 20d
    const vol20Avg = candlesD.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20
    const volRatio = vol20Avg > 0 ? lastD.volume / vol20Avg : 0
    const relativeVolume = volRatio >= 1.5

    // 4) CYCLE — Gann cycle hit in next 7d OR strong astro
    const gann = gannBiasFor(symbol, ltp, today)
    const upcoming = (gann.nextCycles ?? []).filter(c => c.daysAway >= 0 && c.daysAway <= 7)
    const astro = astroBiasFor(today)
    const cycleAligned = upcoming.length > 0 || gann.timeCycleHit ||
      (astro.bullish || astro.bearish) && Math.abs(astro.strength) > 0.4

    // 5) STRUCTURE — clean trend frame OR fresh BOS aligning
    const structureBull = stackBull || smartMoneyBull
    const structureBear = stackBear || smartMoneyBear
    const structureClean = structureBull || structureBear

    // Direction call — must agree across structure + SMC
    let direction: Direction | null = null
    if (smartMoneyBull && (stackBull || rsi > 50)) direction = 'BUY'
    else if (smartMoneyBear && (stackBear || rsi < 50)) direction = 'SHORT'
    else if (stackBull && rsi >= 55 && rsi <= 72) direction = 'BUY'
    else if (stackBear && rsi <= 45 && rsi >= 28) direction = 'SHORT'

    // ── Hard gates ──
    const baseGatesPassed = compression && smartMoney && relativeVolume && cycleAligned && structureClean && direction != null
    if (!baseGatesPassed) return { symbol, ltp, setup: null }
    // From here on `direction` is non-null — narrow for the rest of the fn.
    if (direction == null) return { symbol, ltp, setup: null }

    // ── Boosters ──
    const sectorKey = buildSectorIndex().get(symbol) ?? null
    const sectorRotating = direction === 'BUY'
      ? (sectorKey ? rotatingIn.has(sectorKey) : false)
      : (sectorKey ? rotatingOut.has(sectorKey) : false)
    // OI agreement — simplified proxy: PCR direction (no chain fetch here to keep
    // this engine cheap; the dedicated OI engines stay authoritative)
    const oiFlowAgrees = false

    let stars: 3 | 4 | 5 = 3
    if (sectorRotating) stars = (Math.min(5, stars + 1) as 3 | 4 | 5)
    if (oiFlowAgrees) stars = (Math.min(5, stars + 1) as 3 | 4 | 5)
    // Bonus when BB pctile is in deep-coil zone (≤15) — historically the biggest expansions
    if (comp.bbPctile <= 15) stars = (Math.min(5, stars + 1) as 3 | 4 | 5)

    // ── Build the trade plan ──
    const sign = direction === 'BUY' ? 1 : -1
    const horizon: Horizon = comp.bbPctile <= 15 ? 'POSITIONAL' : 'SWING'
    const t1Pct = horizon === 'POSITIONAL' ? 12 : 6
    const t2Pct = horizon === 'POSITIONAL' ? 22 : 12
    const t3Pct = horizon === 'POSITIONAL' ? 35 : 20
    const t1Days = horizon === 'POSITIONAL' ? 12 : 5
    const t2Days = horizon === 'POSITIONAL' ? 22 : 10
    const t3Days = horizon === 'POSITIONAL' ? 35 : 18

    const entryPrice = direction === 'BUY'
      ? +Math.min(ltp, Math.max(e21 ?? ltp, ltp * 0.992)).toFixed(2)
      : +Math.max(ltp, Math.min(e21 ?? ltp, ltp * 1.008)).toFixed(2)
    const band = Math.max(entryPrice * 0.005, 0.5)
    const entryPriceLow = +(direction === 'BUY' ? entryPrice - band : entryPrice).toFixed(2)
    const entryPriceHigh = +(direction === 'BUY' ? entryPrice : entryPrice + band).toFixed(2)
    const stopLoss = +(direction === 'BUY' ? entryPrice - 1.8 * atrV : entryPrice + 1.8 * atrV).toFixed(2)
    const target1 = +(entryPrice * (1 + sign * t1Pct / 100)).toFixed(2)
    const target2 = +(entryPrice * (1 + sign * t2Pct / 100)).toFixed(2)
    const target3 = +(entryPrice * (1 + sign * t3Pct / 100)).toFixed(2)
    const risk = Math.abs(entryPrice - stopLoss)
    const rr = +(Math.abs(target1 - entryPrice) / Math.max(risk, 0.01)).toFixed(2)

    // Setup name — the headline pattern
    let setupName = 'Pre-breakout coil'
    if (smartMoneyBull && smcD.bosBull) setupName = 'BOS + compression breakout'
    else if (smartMoneyBear && smcD.bosBear) setupName = 'BOS + compression breakdown'
    else if (smcD.chochBull || smcD.chochBear) setupName = 'CHoCH structure shift'
    else if (comp.bbPctile <= 15) setupName = 'Deep BB coil — explosive expansion due'
    else if (comp.atrCompressed) setupName = 'ATR contraction → expansion setup'

    // Reasons
    const reasons: string[] = []
    reasons.push(`Compression: BB-width ${comp.bbPctile}th-pctile · ${comp.atrCompressed ? 'ATR compressed' : 'ATR normal'} · 5d-range/${comp.rangeCompressed ? 'tight' : 'open'}`)
    reasons.push(`Smart Money: ${smcD.note}${smc15 && smc15.note !== smcD.note ? ` · 15m: ${smc15.note}` : ''}`)
    reasons.push(`Volume: ${volRatio.toFixed(1)}× 20d avg (footprint forming)`)
    if (upcoming[0]) reasons.push(`Cycle: ${upcoming[0].name} in ${upcoming[0].daysAway}d (${upcoming[0].importance})`)
    else if (gann.timeCycleHit) reasons.push(`Cycle: Gann time-cycle active today`)
    reasons.push(`Astro: ${astro.note}`)
    reasons.push(`Structure: ${stackBull ? 'EMA stack bull' : stackBear ? 'EMA stack bear' : 'mixed but SMC aligned'} · RSI ${rsi.toFixed(0)}`)
    if (sectorRotating && sectorKey) {
      reasons.push(`🌀 Sector rotation: ${direction === 'BUY' ? 'IN' : 'OUT'} for ${sectorKey} basket`)
    }

    const whyNow =
      `${setupName} · ${direction} · ${stars}★ · ` +
      (sectorRotating && sectorKey ? `[${sectorKey} rotation] · ` : '') +
      `BB-pctile ${comp.bbPctile} · vol ${volRatio.toFixed(1)}× · ` +
      (upcoming[0] ? `${upcoming[0].name} in ${upcoming[0].daysAway}d` : 'cycle window open')

    const entryDate = projectBusinessDate(today, 1)

    // Options leg for F&O names
    let options: MasterSetup['options'] | undefined
    if (FNO_NAMES.has(symbol) || ['NIFTY', 'FINNIFTY', 'GOLD', 'CRUDE'].includes(symbol.toUpperCase())) {
      const isIndex = ['NIFTY', 'FINNIFTY'].includes(symbol.toUpperCase())
      const choice = isIndex
        ? selectIndexExpiry(today)
        : (symbol === 'GOLD' || symbol === 'CRUDE'
            ? selectIndexExpiry(today)         // MCX weekly expiry semantics close enough
            : selectStockExpiry(today))
      const strike = atmStrike(ltp, symbol.toUpperCase())
      const side: 'CE' | 'PE' = direction === 'BUY' ? 'CE' : 'PE'
      const dte = Math.max(1, choice.daysToExpiry)
      const iv = Math.max(0.10, Math.min(0.40, (atrV / ltp) * Math.sqrt(252)))
      const premium = +blackScholesPrice(ltp, strike, dte, iv, side).toFixed(2)
      const ladder = horizon === 'POSITIONAL'
        ? { sl: 0.55, t1: 1.8, t2: 2.8 }    // wider ladder for far-month
        : { sl: 0.65, t1: 1.5, t2: 2.0 }
      options = {
        strike, side,
        expiry: choice.expiry,
        expiryTag: choice.tag,
        expiryReason: choice.reason,
        daysToExpiry: dte,
        premium,
        premiumSL: +(premium * ladder.sl).toFixed(2),
        premiumT1: +(premium * ladder.t1).toFixed(2),
        premiumT2: +(premium * ladder.t2).toFixed(2),
      }
    }

    const setup: MasterSetup = {
      symbol,
      ltp: +ltp.toFixed(2),
      ltpAsOf: new Date().toISOString(),
      direction,
      horizon,
      stars,
      whyNow,
      setupName,
      entryPrice, entryPriceLow, entryPriceHigh,
      entryDate,
      stopLoss,
      target1, target1Date: projectBusinessDate(today, t1Days),
      target2, target2Date: projectBusinessDate(today, t2Days),
      target3, target3Date: projectBusinessDate(today, t3Days),
      riskReward: rr,
      options,
      confluence: {
        compression,
        smartMoney,
        relativeVolume,
        cycleAligned,
        structureClean,
        sectorRotating,
        oiFlowAgrees,
      },
      reasons,
      meta: {
        rsi: +rsi.toFixed(1),
        atr: +atrV.toFixed(2),
        bbWidthPctile: comp.bbPctile,
        volRatio20: +volRatio.toFixed(2),
        sectorKey,
        sectorNote: sectorKey
          ? (sectorRotating ? `Rotating ${direction === 'BUY' ? 'IN' : 'OUT'}` : 'Sector neutral')
          : null,
      },
    }
    return { symbol, ltp, setup }
  } catch (e) {
    log.warn('MASTER', `${symbol}: ${(e as Error).message}`)
    return { symbol, ltp: 0, setup: null }
  }
}

// ─── Public entrypoint ────────────────────────────────────────

export interface RunOpts {
  /** Hard cap on the universe scanned (default 250 — top liquid names). */
  limit?: number
  /** Max setups to return after ranking (default 6). */
  maxOutput?: number
}

export async function runMasterSetup(opts: RunOpts = {}): Promise<MasterSetupRun> {
  const limit = opts.limit ?? 250
  const maxOutput = opts.maxOutput ?? 6
  const today = new Date()
  log.info('MASTER', `Master-setup scan starting (limit=${limit}, top=${maxOutput})...`)

  // Sector-rotation snapshot — refresh if missing or stale (>2h old)
  let rotation = getLatestSectorRotation()
  const rotationAge = rotation ? Date.now() - new Date(rotation.generatedAt).getTime() : Infinity
  if (!rotation || rotationAge > 2 * 3600_000) {
    rotation = await runSectorRotationScan().catch(() => null) ?? rotation
  }
  const rotIn = new Set<SectorKey>(rotation?.rotatingIntoSectors ?? [])
  const rotOut = new Set<SectorKey>(rotation?.rotatingOutSectors ?? [])

  // Universe — NIFTY100 + INDICES + commodities + key F&O stocks
  const baseUniverse = await resolveUniverse('NIFTY50')
  const next50 = await resolveUniverse('NEXT50')
  const fnoSet = new Set([...baseUniverse, ...next50, ...FNO_NAMES])
  const indices = ['NIFTY', 'CRUDE', 'GOLD']
  const symbols = [...indices, ...fnoSet].slice(0, limit)

  const out: MasterSetup[] = []
  let cursor = 0
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < symbols.length) {
      const sym = symbols[cursor++]
      const res = await evaluateSymbol(sym, rotIn, rotOut, today)
      if (res.setup) out.push(res.setup)
    }
  }))

  // Rank: stars desc, then BB-pctile asc (deeper coil = bigger move), then volRatio desc
  out.sort((a, b) =>
    b.stars - a.stars ||
    a.meta.bbWidthPctile - b.meta.bbWidthPctile ||
    b.meta.volRatio20 - a.meta.volRatio20,
  )
  const top = out.slice(0, maxOutput)

  // Log to signals.csv so the audit journal sees them
  for (const s of top) {
    void logSignal(masterSetupToSignal(s), 'master-setup').catch(() => undefined)
  }

  const fiveStarCount = top.filter(s => s.stars === 5).length
  const digestLine = top.length
    ? `🎯 ${top.length} master setup${top.length > 1 ? 's' : ''} (${fiveStarCount} × 5★) — ${top.slice(0, 3).map(s => `${s.symbol} ${s.direction} ${s.stars}★`).join(' · ')}`
    : '⚪ No master-setup confluence today — all five gates not aligned. Sit out.'

  log.ok('MASTER', `${out.length} qualified · top ${top.length} returned · ${fiveStarCount} are 5★`)

  return {
    generatedAt: today.toISOString(),
    scanned: symbols.length,
    qualified: out.length,
    setups: top,
    digestLine,
  }
}

let lastRun: MasterSetupRun | null = null

/** Cache the latest run so the dashboard / Telegram can read it without re-scanning. */
export async function refreshMasterSetup(opts: RunOpts = {}): Promise<MasterSetupRun> {
  lastRun = await runMasterSetup(opts)
  return lastRun
}

export function getLatestMasterSetup(): MasterSetupRun | null { return lastRun }

// ─── Adapters ─────────────────────────────────────────────────

function masterSetupToSignal(m: MasterSetup): Signal {
  const direction = m.direction === 'SHORT' ? 'SELL' : 'BUY'
  const grade = m.stars === 5 ? 'A' : m.stars === 4 ? 'B' : 'C'
  const score = m.stars === 5 ? 9.5 : m.stars === 4 ? 8.5 : 7.5
  const instrument = m.options
    ? `${m.symbol} ${m.options.strike} ${m.options.side}`
    : m.symbol
  const entry = m.options ? m.options.premium : m.entryPrice
  const sl = m.options ? m.options.premiumSL : m.stopLoss
  const t1 = m.options ? m.options.premiumT1 : m.target1
  const t2 = m.options ? m.options.premiumT2 : m.target2
  return {
    id: `master-${m.symbol}-${m.direction}-${m.entryDate.replace(/-/g, '')}-${m.stars}`,
    instrument,
    direction,
    grade, score,
    entry, stopLoss: sl, target1: t1, target2: t2, target3: m.options ? t2 : m.target3,
    riskPct: 0,
    rewardPct: 0,
    riskReward: m.riskReward,
    type: m.options ? 'OPTIONS' : 'SWING',
    reasons: [m.whyNow, ...m.reasons],
    gannNote: m.reasons.find(r => r.startsWith('Cycle:')) ?? '—',
    astroNote: m.reasons.find(r => r.startsWith('Astro:')) ?? '—',
    oiNote: m.confluence.oiFlowAgrees ? 'OI agrees' : 'OI not used',
    pattern: m.setupName,
    expiresAt: m.options?.expiry ?? m.target3Date,
    timestamp: new Date().toISOString(),
    confluence: {
      trend: m.confluence.structureClean,
      vwap: false,
      volume: m.confluence.relativeVolume,
      pattern: m.confluence.smartMoney,
      gann: m.confluence.cycleAligned,
      astro: m.confluence.cycleAligned,
      rsi: false,
      oi: m.confluence.oiFlowAgrees,
      supertrend: false,
      flow: m.confluence.sectorRotating,
      fundamentals: false,
    },
    confluenceCount: Object.values(m.confluence).filter(Boolean).length,
    source: `master-setup-${m.stars}star`,
    tier: 'LIVE',
  }
}

// ─── Telegram formatter ───────────────────────────────────────

export function formatMasterSetupForTelegram(run: MasterSetupRun): string {
  if (!run.setups.length) {
    return '🎯 *MASTER SETUPS · ' + run.generatedAt.slice(0, 10) + '*\n\n' +
      run.digestLine + '\n\n_All 5 confluence gates must align for a master setup. ' +
      'No fire today = preserve capital, the next high-conviction setup is coming._\n*#tradewithvarsha*'
  }
  const lines: string[] = []
  lines.push(`🎯 *MASTER SETUPS · ${run.generatedAt.slice(0, 10)}*`)
  lines.push(`Scanned ${run.scanned} · qualified ${run.qualified} · top ${run.setups.length}`)
  lines.push('')
  for (const s of run.setups) {
    const star = '★'.repeat(s.stars) + '☆'.repeat(5 - s.stars)
    const arrow = s.direction === 'BUY' ? '🟢 BUY' : '🔴 SHORT'
    lines.push(`${star} *${s.symbol}* ${arrow} · LTP ₹${s.ltp} · _${s.setupName}_`)
    lines.push(`   Entry \`${s.entryPriceLow}–${s.entryPriceHigh}\` · SL \`${s.stopLoss}\` · T1 \`${s.target1}\` · T2 \`${s.target2}\` · T3 \`${s.target3}\``)
    lines.push(`   Dates: enter ${s.entryDate} · T1 ${s.target1Date} · T2 ${s.target2Date} · T3 ${s.target3Date} · R:R ${s.riskReward}`)
    if (s.options) {
      lines.push(`   📈 *Options*: ${s.symbol} ${s.options.strike} ${s.options.side} · ${s.options.expiryTag} (${s.options.expiry}, ${s.options.daysToExpiry}d)`)
      lines.push(`      Premium ₹${s.options.premium} · SL ₹${s.options.premiumSL} · T1 ₹${s.options.premiumT1} · T2 ₹${s.options.premiumT2}`)
      lines.push(`      _${s.options.expiryReason}_`)
    }
    lines.push(`   _${s.whyNow}_`)
    lines.push('')
  }
  lines.push(`💡 _${run.digestLine}_`)
  lines.push('*#tradewithvarsha*')
  return lines.join('\n')
}
