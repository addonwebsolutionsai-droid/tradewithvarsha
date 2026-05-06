import * as angel from '../data/angel'
import * as router from '../data'
import { astroBiasFor } from '../astro'
import { gannBiasFor } from '../gann'
import { intradaySignal } from '../strategies/intraday'
import { swingSignal } from '../strategies/swing'
import { commoditySignal } from '../strategies/commodity'
import { optionsSignal } from '../strategies/options'
import { analyzeSMC, smcSignal } from '../patterns/smc'
import { detectPatterns } from '../patterns/chart'
import { emaStack, lastATR, lastRSI, macd } from '../indicators'
import { maxPain, interpretOI } from '../options/oiAnalyzer'
import { resolve } from '../data/resolver'
import type { ResolvedSymbol } from '../data/resolver'
import type { Candle, Signal, StrategyContext } from '../types'
import type { QueryIntent } from './parseQuery'
import { log } from '../util/logger'

/**
 * Full-stack analysis pipeline for any Angel instrument:
 *
 *   QueryIntent → ResolvedSymbol → Candles + OI + Gann + Astro → Signals + Narrative
 */

export interface AnalysisReport {
  resolved: ResolvedSymbol
  ltp: number | null
  change: number | null
  changePct: number | null
  signals: Signal[]
  summary: string
  diagnostics: string[]
  oi?: {
    pcr: number
    maxPain: number
    bias: string
    note: string
  }
  underlyingBias?: 'BULL' | 'BEAR' | 'NEUTRAL'
  premiumTargets?: { entry: number; sl: number; t1: number; t2: number }
}

export async function analyzeIntent(intent: QueryIntent): Promise<AnalysisReport | null> {
  const resolved = await resolve(intent)
  if (!resolved) {
    log.warn('ANALYZE', `Unable to resolve: ${intent.kind} ${JSON.stringify(intent)}`)
    return null
  }
  return analyzeResolved(resolved)
}

export async function analyzeResolved(resolved: ResolvedSymbol): Promise<AnalysisReport> {
  const diagnostics: string[] = []
  const now = new Date()
  const astro = astroBiasFor(now)

  // Fetch LTP first (cheap)
  const quote = await angel.getQuoteByToken(resolved.exchange as any, resolved.token)
  const ltp = quote?.price ?? null
  const change = quote?.change ?? null
  const changePct = quote?.changePct ?? null

  // Route by kind
  if (resolved.kind === 'equity' || resolved.kind === 'index' || resolved.kind === 'future') {
    return analyzeDirectional(resolved, quote, astro, diagnostics)
  }
  if (resolved.kind === 'commodity') {
    return analyzeCommodityInstrument(resolved, quote, astro, diagnostics)
  }
  if (resolved.kind === 'option') {
    return analyzeOption(resolved, quote, astro, diagnostics)
  }

  return {
    resolved, ltp, change, changePct,
    signals: [], diagnostics,
    summary: `Resolved ${resolved.displayLabel} but no analyzer available for kind ${resolved.kind}`,
  }
}

/** Equity / Index / Future: run intraday + swing strategies. */
async function analyzeDirectional(
  r: ResolvedSymbol,
  quote: any,
  astro: ReturnType<typeof astroBiasFor>,
  diagnostics: string[],
): Promise<AnalysisReport> {
  const candles15 = await fetchCandles(r, '15m', 200)
  const candlesD = await fetchCandles(r, '1D', 200)
  diagnostics.push(`15m candles: ${candles15.length}`, `1D candles: ${candlesD.length}`)

  if (!candles15.length && !candlesD.length) {
    return {
      resolved: r, ltp: quote?.price ?? null, change: quote?.change ?? null, changePct: quote?.changePct ?? null,
      signals: [], diagnostics,
      summary: `${r.displayLabel} — no historical data available from Angel for this instrument.`,
    }
  }

  const gann = gannBiasFor(r.name, quote?.price ?? (candles15.at(-1)?.close ?? 0), new Date())
  const ctx15: StrategyContext = { symbol: r.name, candles: candles15, candlesHigher: candlesD, gannBias: gann, astroBias: astro, date: new Date() }
  const ctxD: StrategyContext = { symbol: r.name, candles: candlesD.length ? candlesD : candles15, candlesHigher: candlesD, gannBias: gann, astroBias: astro, date: new Date() }

  const signals: Signal[] = []
  const s1 = intradaySignal(ctx15); if (s1) signals.push(s1)
  const s2 = swingSignal(ctxD); if (s2) signals.push(s2)

  // Underlying bias snapshot even if no actionable signal
  const snapshot = snapshotBias(candles15.length ? candles15 : candlesD)
  const summary = signals.length
    ? `${signals.length} actionable signal(s) — see details below`
    : `No actionable signal — ${snapshot.summary}`

  return {
    resolved: r, ltp: quote?.price ?? null, change: quote?.change ?? null, changePct: quote?.changePct ?? null,
    signals, diagnostics, summary,
    underlyingBias: snapshot.bias,
  }
}

async function analyzeCommodityInstrument(
  r: ResolvedSymbol,
  quote: any,
  astro: ReturnType<typeof astroBiasFor>,
  diagnostics: string[],
): Promise<AnalysisReport> {
  const candles = await fetchCandles(r, '1D', 200)
  const candles15 = await fetchCandles(r, '15m', 200)
  diagnostics.push(`1D candles: ${candles.length}`, `15m candles: ${candles15.length}`)

  const gann = gannBiasFor(r.name, quote?.price ?? (candles.at(-1)?.close ?? 0), new Date())
  const ctx: StrategyContext = {
    symbol: r.name, candles: candles.length ? candles : candles15,
    candlesHigher: candles, gannBias: gann, astroBias: astro, date: new Date(),
  }

  const signals: Signal[] = []
  const s = commoditySignal(ctx); if (s) signals.push(s)

  const snapshot = snapshotBias(ctx.candles)
  return {
    resolved: r, ltp: quote?.price ?? null, change: quote?.change ?? null, changePct: quote?.changePct ?? null,
    signals, diagnostics,
    summary: signals.length ? `${signals.length} commodity signal` : `No actionable signal — ${snapshot.summary}`,
    underlyingBias: snapshot.bias,
  }
}

async function analyzeOption(
  r: ResolvedSymbol,
  quote: any,
  astro: ReturnType<typeof astroBiasFor>,
  diagnostics: string[],
): Promise<AnalysisReport> {
  // Premium candles (small — option series have thin data, limit 100 bars)
  const candles15 = await fetchCandles(r, '15m', 150)
  diagnostics.push(`premium 15m candles: ${candles15.length}`)

  // Underlying analysis — drives bias for CE (want bull) vs PE (want bear)
  const underlyingName = r.name // e.g. NIFTY, RELIANCE
  const underlyingCandles = await router.getCandles(underlyingName, '15m', 200)
  const underlyingDaily = await router.getCandles(underlyingName, '1D', 200)
  const gann = gannBiasFor(underlyingName, underlyingCandles.at(-1)?.close ?? 0, new Date())
  diagnostics.push(`underlying 15m: ${underlyingCandles.length}, 1D: ${underlyingDaily.length}`)

  // Option chain (for same underlying) — gives OI context for this strike
  let oiBlock: AnalysisReport['oi']
  let ocBias: 'BULL' | 'BEAR' | 'NEUTRAL' = 'NEUTRAL'
  if (underlyingName === 'NIFTY' || underlyingName === 'BANKNIFTY') {
    const oc = angel.hasAngelCreds()
      ? await angel.getOptionChain(underlyingName as 'NIFTY' | 'BANKNIFTY')
      : null
    if (oc) {
      oc.maxPain = maxPain(oc)
      const interp = interpretOI(oc)
      oiBlock = { pcr: oc.pcr, maxPain: oc.maxPain, bias: interp.bias, note: interp.note }
      ocBias = interp.bias === 'BULLISH' ? 'BULL' : interp.bias === 'BEARISH' ? 'BEAR' : 'NEUTRAL'
    }
  }

  // Run underlying SMC/trend analysis
  const underlyingCtx: StrategyContext = {
    symbol: underlyingName, candles: underlyingCandles,
    candlesHigher: underlyingDaily, gannBias: gann, astroBias: astro, date: new Date(),
  }
  const underlyingIntraday = intradaySignal(underlyingCtx)
  const undSnap = snapshotBias(underlyingCandles)
  const underlyingBias = underlyingIntraday
    ? (underlyingIntraday.direction === 'BUY' ? 'BULL' : 'BEAR')
    : undSnap.bias

  // Alignment: CE profits from bull, PE from bear
  const optDir = r.side
  const aligned = (optDir === 'CE' && underlyingBias === 'BULL') || (optDir === 'PE' && underlyingBias === 'BEAR')

  // Premium-based targets (20% SL, 35% T1, 80% T2 — options convention)
  const entry = quote?.price ?? candles15.at(-1)?.close ?? 0
  const premiumTargets = entry > 0 ? {
    entry: +entry.toFixed(2),
    sl: +(entry * 0.8).toFixed(2),
    t1: +(entry * 1.35).toFixed(2),
    t2: +(entry * 1.8).toFixed(2),
  } : undefined

  // Build a summary line
  const parts: string[] = []
  parts.push(`Underlying ${underlyingName} bias: ${underlyingBias}`)
  if (oiBlock) parts.push(`OI bias: ${oiBlock.bias}`)
  parts.push(aligned ? `✅ ${optDir} aligned with ${underlyingBias}` : `⚠️ ${optDir} contrarian to ${underlyingBias}`)
  if (r.strike && quote?.price != null) {
    const under = underlyingCandles.at(-1)?.close ?? 0
    const moneyness = under > 0
      ? (optDir === 'CE'
        ? (r.strike < under ? 'ITM' : r.strike === under ? 'ATM' : `OTM by ${(((r.strike - under) / under) * 100).toFixed(2)}%`)
        : (r.strike > under ? 'ITM' : r.strike === under ? 'ATM' : `OTM by ${(((under - r.strike) / under) * 100).toFixed(2)}%`))
      : '—'
    parts.push(`Strike ${r.strike} is ${moneyness} vs spot ${under.toFixed(2)}`)
  }

  return {
    resolved: r,
    ltp: quote?.price ?? null,
    change: quote?.change ?? null,
    changePct: quote?.changePct ?? null,
    signals: underlyingIntraday ? [underlyingIntraday] : [],
    diagnostics,
    summary: parts.join(' · '),
    oi: oiBlock,
    underlyingBias,
    premiumTargets,
  }
}

/** Fetch candles for any ResolvedSymbol via Angel. */
async function fetchCandles(r: ResolvedSymbol, tf: any, count: number): Promise<Candle[]> {
  try {
    const daysBack = ['1D', '1W', '1M'].includes(tf)
      ? Math.max(count * 1.5, 300)
      : tf === '1h' ? 45 : tf === '30m' ? 15 : tf === '15m' ? 10 : 3
    const candles = await angel.getCandles(r.exchange as any, r.token, tf as any, Math.ceil(daysBack))
    return candles.slice(-count)
  } catch (e) {
    log.warn('ANALYZE', `fetchCandles ${r.displayLabel} ${tf}: ${(e as Error).message}`)
    return []
  }
}

/** Quick snapshot from candles — even without a full signal. */
function snapshotBias(candles: Candle[]): { bias: 'BULL' | 'BEAR' | 'NEUTRAL'; summary: string } {
  if (!candles.length) return { bias: 'NEUTRAL', summary: 'no data' }
  const stack = emaStack(candles)
  const rsi = lastRSI(candles, 14) ?? 50
  const atr = lastATR(candles, 14) ?? 0
  const smc = analyzeSMC(candles)
  const m = macd(candles)
  const parts: string[] = []
  let bias: 'BULL' | 'BEAR' | 'NEUTRAL' = 'NEUTRAL'
  if (stack.alignedBull) { bias = 'BULL'; parts.push('EMA stack bull') }
  else if (stack.alignedBear) { bias = 'BEAR'; parts.push('EMA stack bear') }
  else parts.push('EMA mixed')
  parts.push(`RSI ${rsi.toFixed(1)}`)
  if (atr) parts.push(`ATR ${atr.toFixed(2)}`)
  if (m) parts.push(`MACD ${m.histogram > 0 ? '↑' : '↓'}${m.histogram.toFixed(2)}`)
  if (smc.bias !== 'NEUTRAL') parts.push(`SMC ${smc.bias}`)
  if (bias === 'NEUTRAL' && smc.bias === 'BULLISH') bias = 'BULL'
  if (bias === 'NEUTRAL' && smc.bias === 'BEARISH') bias = 'BEAR'
  return { bias, summary: parts.join(' · ') }
}
