import * as data from '../data'
import { sessionHoras, type HoraReading, type HoraLord } from '../astro/parashariHora'
import { astroBiasFor } from '../astro'
import { gannBiasFor } from '../gann'
import { analyzeSMC } from '../patterns/smc'
import { getElliottContext } from '../patterns/elliott'
import { detectAllHarmonics } from '../patterns/harmonic'
import { ema, lastRSI, lastATR } from '../indicators'
import { fetchNiftyOptionChain } from '../data/nse'
import { interpretOI } from '../options/oiAnalyzer'
import { resample } from '../strategies/mtfAggregator'
import { log } from '../util/logger'
import type { Candle } from '../types'

/**
 * NIFTY 50 Intraday Confluence Engine.
 *
 * Built after the user explicitly listed the inputs to combine:
 *   1. Time Cycle (Gann)
 *   2. Parashari Hora · Vedha · Vedic + Mundane Astro
 *   3. Smart Money Concept (SMC) — BOS / CHoCH / order block / sweep
 *   4. Liquidity grabs · market-maker liquidity aim
 *   5. EMA stack + RSI divergence
 *   6. Elliott Wave count + Fib levels
 *   7. Real-time CE / PE volume buildup (option chain)
 *
 * For NIFTY-50 specifically the user noted that Mars and Saturn horas are
 * BAD even though Mars is classically bullish — Mars favours metals /
 * defence at the EXPENSE of broad indices, and Saturn is bearish across
 * the board. We override the hora bias accordingly for the NIFTY index
 * (this override applies ONLY to NIFTY-50, not to individual stocks).
 *
 * Output: a hora-by-hora plan for the trading day with explicit
 * BUY CE / BUY PE / EXIT / WAIT bullets, the confluence factors that
 * fired, and a confidence score (0-100). Designed to be pushed to
 * Telegram as part of the morning digest AND to be the data source for
 * a future NIFTY-specific dashboard panel.
 */

export type NiftyAction =
  | 'BUY_CE'    // bullish — buy calls
  | 'BUY_PE'    // bearish — buy puts
  | 'EXIT'      // close all positions, no fresh entry
  | 'WAIT'      // structure unclear, sit out
  | 'HOLD_CE'   // already long calls — keep, don't add
  | 'HOLD_PE'   // already long puts — keep, don't add

export interface HoraPlan {
  startIST: string                 // 'HH:MM'
  endIST: string
  lord: HoraLord
  /** Classical Parashari bias of the lord (untouched). */
  classicalBias: 'BULLISH' | 'BEARISH' | 'VOLATILE' | 'NEUTRAL'
  /** NIFTY-50 SPECIFIC bias override (the bias the engine actually uses). */
  niftyBias: 'BULLISH' | 'BEARISH' | 'VOLATILE' | 'NEUTRAL'
  niftyBiasReason: string          // why the NIFTY bias differs (or doesn't)
  action: NiftyAction
  confidence: number               // 0-100
  factors: string[]                // human-readable confluence factors
  warnings: string[]               // anything cautionary (vedha, retrograde, etc.)
}

export interface NiftyIntradayPlan {
  date: string                     // YYYY-MM-DD
  spot: number
  generatedAt: string
  // Daily-level context applied to every hora
  smcBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  smcNote: string
  emaStack: 'BULL' | 'BEAR' | 'MIXED'
  rsi: number
  rsiZone: 'OVERBOUGHT' | 'OVERSOLD' | 'BULL' | 'BEAR' | 'NEUTRAL'
  elliottPhase: string
  elliottConfidence: 'HIGH' | 'MEDIUM' | 'LOW'
  gannHit: boolean
  gannNote: string
  astroNet: 'BULLISH' | 'BEARISH' | 'VOLATILE' | 'NEUTRAL'
  astroNote: string
  oiBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  oiPcr: number | null
  oiMaxPain: number | null
  /** Recent 1h harmonic patterns on NIFTY (informational, not per-hora). */
  harmonics: Array<{ name: string; direction: 'BULLISH' | 'BEARISH'; confidence: number; entry: number; t1: number }>
  // Key Fib levels from the last meaningful swing
  fibLevels: { high: number; low: number; pct382: number; pct500: number; pct618: number; pct786: number } | null
  // Per-hora plan
  horas: HoraPlan[]
  /** Current active hora's recommendation (the "what to do RIGHT NOW" answer). */
  current: HoraPlan | null
  /** One-line summary for Telegram digest. */
  oneLineSummary: string
}

/**
 * NIFTY-specific hora bias override.
 *
 * Per user observation:
 *   Mars hora     → bearish for NIFTY-50 (sectoral rotation pulls money
 *                   into metals/defence, away from index heavyweights)
 *   Saturn hora   → bearish (weighty / contracting energy)
 *   Mercury       → neutral / volatile (intraday only)
 *   Jupiter / Sun → bullish (Jupiter strongest)
 *   Venus         → mildly bullish
 *   Moon          → volatile / whipsaw — treat as neutral with WAIT bias
 */
function niftyHoraBias(lord: HoraLord): { bias: 'BULLISH' | 'BEARISH' | 'VOLATILE' | 'NEUTRAL'; reason: string } {
  switch (lord) {
    case 'Jupiter': return { bias: 'BULLISH',  reason: 'Jupiter — strongest bull on banks/finance, NIFTY favoured' }
    case 'Sun':     return { bias: 'BULLISH',  reason: 'Sun — leadership / breakouts, PSU + government weights' }
    case 'Venus':   return { bias: 'BULLISH',  reason: 'Venus — luxury/consumption, mild bullish bias' }
    case 'Mars':    return { bias: 'BEARISH',  reason: 'Mars — sectoral pull to metals/defence at expense of broad index (NIFTY-specific override)' }
    case 'Saturn':  return { bias: 'BEARISH',  reason: 'Saturn — weighty/contracting, classically bearish' }
    case 'Moon':    return { bias: 'VOLATILE', reason: 'Moon — reversals + whipsaws, no commitment' }
    case 'Mercury': return { bias: 'NEUTRAL',  reason: 'Mercury — IT/trading focus, scalps OK but no positional bias' }
  }
}

export async function buildNiftyIntradayPlan(): Promise<NiftyIntradayPlan> {
  const now = new Date()
  const today = now.toISOString().slice(0, 10)

  // ─── Pull base 15m candles for NIFTY ────────────────────────────
  const candles15 = await data.getCandles('NIFTY', '15m', 200).catch(() => [] as Candle[])
  if (!candles15.length) {
    log.warn('NIFTY-PLAN', 'No 15m candles available — returning empty plan')
    return emptyPlan(today, now)
  }
  const last = candles15[candles15.length - 1]
  const spot = last.close

  // 5m candles (resampled from 15m won't help; for 5m we'd need a separate
  // fetch — skip for now since 15m is dense enough for hora-window analysis).
  const candles5 = candles15   // alias; could be resample(candles1m, 1, 5) if 1m feed wired

  // ─── Daily-level context ────────────────────────────────────────
  const candlesD = await data.getCandles('NIFTY', '1D', 200).catch(() => [] as Candle[])
  const smc = analyzeSMC(candles15)
  const smcBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = smc.bias
  const e9  = ema(candles15, 9)[ema(candles15, 9).length - 1]
  const e21 = ema(candles15, 21)[ema(candles15, 21).length - 1]
  const e50 = ema(candles15, 50)[ema(candles15, 50).length - 1]
  const e200 = candlesD.length >= 200 ? ema(candlesD, 200)[ema(candlesD, 200).length - 1] : null
  const emaStack: 'BULL' | 'BEAR' | 'MIXED' =
    e9 > e21 && e21 > e50 ? 'BULL' :
    e9 < e21 && e21 < e50 ? 'BEAR' : 'MIXED'
  const rsi = lastRSI(candles15, 14) ?? 50
  const rsiZone: NiftyIntradayPlan['rsiZone'] =
    rsi >= 70 ? 'OVERBOUGHT' :
    rsi <= 30 ? 'OVERSOLD' :
    rsi >= 55 ? 'BULL' :
    rsi <= 45 ? 'BEAR' : 'NEUTRAL'
  const elliott = getElliottContext(candlesD.length >= 30 ? candlesD : candles15, 1.0)
  const gann = gannBiasFor('NIFTY', spot, now)
  const astro = astroBiasFor(now)
  const astroNet = astro.bullish ? 'BULLISH' : astro.bearish ? 'BEARISH' : astro.volatile ? 'VOLATILE' : 'NEUTRAL'

  // ─── Option chain for OI bias ─────────────────────────────────
  let oiBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL'
  let oiPcr: number | null = null
  let oiMaxPain: number | null = null
  try {
    const chain = await fetchNiftyOptionChain()
    if (chain) {
      const oi = interpretOI(chain)
      oiBias = oi.bias === 'BULLISH' ? 'BULLISH' : oi.bias === 'BEARISH' ? 'BEARISH' : 'NEUTRAL'
      oiPcr = chain.pcr
      oiMaxPain = chain.maxPain
    }
  } catch { /* chain fetch optional */ }

  // ─── Recent harmonic patterns on NIFTY (15m + 1h + 1D) ────────
  const harmonics: NiftyIntradayPlan['harmonics'] = []
  try {
    const tfs: Array<{ minutes: number; series: Candle[] }> = [
      { minutes: 15,  series: candles15 },
      { minutes: 60,  series: resample(candles15, 15, 60) },
      { minutes: 240, series: resample(candles15, 15, 240) },
    ]
    for (const tf of tfs) {
      if (tf.series.length < 30) continue
      const ps = detectAllHarmonics(tf.series.slice(-200), {
        minSwingPct: tf.minutes <= 60 ? 0.3 : 0.6,
        maxAgeBars: 10,
        minConfidence: 65,
      })
      for (const p of ps.slice(0, 2)) {
        harmonics.push({
          name: p.name,
          direction: p.direction,
          confidence: p.confidence,
          entry: p.D.price,
          t1: p.targets.t1,
        })
      }
    }
  } catch { /* harmonic detection optional */ }

  // ─── Fib levels from last 50-bar swing ─────────────────────────
  const last50 = candles15.slice(-50)
  const swingHigh = Math.max(...last50.map(c => c.high))
  const swingLow = Math.min(...last50.map(c => c.low))
  const fibLevels = swingHigh > swingLow ? {
    high: +swingHigh.toFixed(2),
    low: +swingLow.toFixed(2),
    pct382: +(swingHigh - (swingHigh - swingLow) * 0.382).toFixed(2),
    pct500: +(swingHigh - (swingHigh - swingLow) * 0.500).toFixed(2),
    pct618: +(swingHigh - (swingHigh - swingLow) * 0.618).toFixed(2),
    pct786: +(swingHigh - (swingHigh - swingLow) * 0.786).toFixed(2),
  } : null

  // ─── Per-hora plan for the session ─────────────────────────────
  const allHoras = sessionHoras(now)
  const horas: HoraPlan[] = allHoras.map(h => buildHoraPlan(h, {
    smcBias, emaStack, rsi, rsiZone, astroNet, oiBias, gannHit: gann.timeCycleHit,
    elliottPhase: elliott.phase, harmonics, spot,
  }))

  // Pick the currently active hora as `current`.
  const nowMin = istMinuteOfDay(now)
  const current = horas.find(h => {
    const s = hmToMin(h.startIST)
    const e = hmToMin(h.endIST)
    return nowMin >= s && nowMin < e
  }) ?? null

  const oneLineSummary = current
    ? `${actionEmoji(current.action)} *${current.startIST}-${current.endIST}*: ${current.action.replace('_', ' ')} · ${current.lord} hora · ${current.confidence}% confidence`
    : `Market closed — next session opens 09:15 IST. SMC ${smcBias} · OI ${oiBias} · RSI ${rsi.toFixed(0)}`

  return {
    date: today,
    spot,
    generatedAt: now.toISOString(),
    smcBias,
    smcNote: smc.note,
    emaStack,
    rsi: +rsi.toFixed(1),
    rsiZone,
    elliottPhase: elliott.phase,
    elliottConfidence: elliott.confidence,
    gannHit: gann.timeCycleHit,
    gannNote: gann.note,
    astroNet,
    astroNote: astro.note,
    oiBias,
    oiPcr,
    oiMaxPain,
    harmonics,
    fibLevels,
    horas,
    current,
    oneLineSummary,
  }
}

interface HoraInputs {
  smcBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  emaStack: 'BULL' | 'BEAR' | 'MIXED'
  rsi: number
  rsiZone: NiftyIntradayPlan['rsiZone']
  astroNet: 'BULLISH' | 'BEARISH' | 'VOLATILE' | 'NEUTRAL'
  oiBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  gannHit: boolean
  elliottPhase: string
  harmonics: NiftyIntradayPlan['harmonics']
  spot: number
}

function buildHoraPlan(h: HoraReading, ctx: HoraInputs): HoraPlan {
  const { bias: niftyBias, reason: niftyBiasReason } = niftyHoraBias(h.lord)
  const factors: string[] = []
  const warnings: string[] = []
  let bullScore = 0
  let bearScore = 0

  // Hora itself
  if (niftyBias === 'BULLISH') { bullScore += 30; factors.push(`✓ ${h.lord} hora (NIFTY-bull)`) }
  else if (niftyBias === 'BEARISH') { bearScore += 30; factors.push(`✓ ${h.lord} hora (NIFTY-bear)`) }
  else if (niftyBias === 'VOLATILE') { warnings.push(`⚠️ ${h.lord} hora — whipsaw zone`) }
  else { factors.push(`· ${h.lord} hora (neutral)`) }

  // SMC
  if (ctx.smcBias === 'BULLISH') { bullScore += 25; factors.push('✓ SMC bias bullish (BOS↑/order-flow up)') }
  else if (ctx.smcBias === 'BEARISH') { bearScore += 25; factors.push('✓ SMC bias bearish (BOS↓/order-flow down)') }

  // EMA stack
  if (ctx.emaStack === 'BULL') { bullScore += 15; factors.push('✓ EMA 9>21>50 stacked bull') }
  else if (ctx.emaStack === 'BEAR') { bearScore += 15; factors.push('✓ EMA 9<21<50 stacked bear') }

  // RSI
  if (ctx.rsiZone === 'BULL') { bullScore += 8; factors.push(`✓ RSI ${ctx.rsi.toFixed(0)} bull zone`) }
  else if (ctx.rsiZone === 'BEAR') { bearScore += 8; factors.push(`✓ RSI ${ctx.rsi.toFixed(0)} bear zone`) }
  else if (ctx.rsiZone === 'OVERBOUGHT') { bearScore += 12; warnings.push(`⚠️ RSI ${ctx.rsi.toFixed(0)} OVERBOUGHT — risk of reversal`) }
  else if (ctx.rsiZone === 'OVERSOLD')   { bullScore += 12; warnings.push(`⚠️ RSI ${ctx.rsi.toFixed(0)} OVERSOLD — bounce due`) }

  // OI
  if (ctx.oiBias === 'BULLISH') { bullScore += 10; factors.push('✓ Option-chain OI bias bullish (PUT writers heavy)') }
  else if (ctx.oiBias === 'BEARISH') { bearScore += 10; factors.push('✓ Option-chain OI bias bearish (CALL writers heavy)') }

  // Astro net
  if (ctx.astroNet === 'BULLISH') { bullScore += 8; factors.push('✓ Vedic/Mundane astro net bull') }
  else if (ctx.astroNet === 'BEARISH') { bearScore += 8; factors.push('✓ Vedic/Mundane astro net bear') }
  else if (ctx.astroNet === 'VOLATILE') { warnings.push('⚠️ Volatile astro period — keep stops tight') }

  // Gann time cycle
  if (ctx.gannHit) { warnings.push('⚠️ Gann time cycle active today — sharp moves possible') }

  // Elliott
  if (ctx.elliottPhase === 'IMPULSE_UP') { bullScore += 8; factors.push('✓ Elliott impulse up') }
  else if (ctx.elliottPhase === 'IMPULSE_DOWN') { bearScore += 8; factors.push('✓ Elliott impulse down') }
  else if (ctx.elliottPhase === 'TOPPING') { bearScore += 6; warnings.push('⚠️ Elliott topping pattern — reversal risk') }
  else if (ctx.elliottPhase === 'BOTTOMING') { bullScore += 6; factors.push('✓ Elliott bottoming pattern') }

  // Harmonics on NIFTY
  for (const harm of ctx.harmonics) {
    if (harm.direction === 'BULLISH') bullScore += Math.round(harm.confidence / 10)
    else bearScore += Math.round(harm.confidence / 10)
    factors.push(`✓ ${harm.name} ${harm.direction.toLowerCase()} (${harm.confidence}%) — entry ${harm.entry} → T1 ${harm.t1}`)
  }

  // Decide action
  const totalConviction = bullScore + bearScore
  const edge = bullScore - bearScore
  const confidence = Math.min(100, totalConviction)
  let action: NiftyAction
  if (totalConviction < 35) {
    action = 'WAIT'
  } else if (Math.abs(edge) < 15) {
    // Conflicting signals — stay flat, exit existing positions
    action = 'EXIT'
  } else if (edge > 0) {
    action = 'BUY_CE'
  } else {
    action = 'BUY_PE'
  }

  // Volatile horas force WAIT regardless of edge
  if (niftyBias === 'VOLATILE' && action !== 'WAIT') {
    action = 'WAIT'
    warnings.unshift('⚠️ Volatile hora — overrides directional signal, sit out')
  }

  return {
    startIST: h.startIST,
    endIST: h.endIST,
    lord: h.lord,
    classicalBias: h.bias,
    niftyBias,
    niftyBiasReason,
    action,
    confidence,
    factors,
    warnings,
  }
}

function actionEmoji(a: NiftyAction): string {
  switch (a) {
    case 'BUY_CE':  return '🟢'
    case 'BUY_PE':  return '🔴'
    case 'EXIT':    return '🟡'
    case 'WAIT':    return '⚪'
    case 'HOLD_CE': return '🟢'
    case 'HOLD_PE': return '🔴'
  }
}

function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}

function istMinuteOfDay(d: Date): number {
  const istHours = (d.getUTCHours() + 5.5) % 24
  return Math.floor(istHours) * 60 + d.getUTCMinutes()
}

function emptyPlan(date: string, now: Date): NiftyIntradayPlan {
  return {
    date,
    spot: 0,
    generatedAt: now.toISOString(),
    smcBias: 'NEUTRAL',
    smcNote: 'No data',
    emaStack: 'MIXED',
    rsi: 50,
    rsiZone: 'NEUTRAL',
    elliottPhase: 'UNKNOWN',
    elliottConfidence: 'LOW',
    gannHit: false,
    gannNote: 'No data',
    astroNet: 'NEUTRAL',
    astroNote: 'No data',
    oiBias: 'NEUTRAL',
    oiPcr: null,
    oiMaxPain: null,
    harmonics: [],
    fibLevels: null,
    horas: [],
    current: null,
    oneLineSummary: 'No data — engine couldn\'t fetch NIFTY candles.',
  }
}

/** Format the plan as a Telegram-ready Markdown message. */
export function formatNiftyPlanForTelegram(plan: NiftyIntradayPlan): string {
  if (!plan.spot) return '⚠️ NIFTY plan unavailable — data fetch failed.'
  const lines: string[] = []
  lines.push(`🪐 *NIFTY-50 INTRADAY PLAN · ${plan.date}*`)
  lines.push(`Spot \`${plan.spot.toFixed(2)}\` · SMC ${plan.smcBias} · OI ${plan.oiBias} · RSI ${plan.rsi}`)
  if (plan.elliottPhase !== 'UNKNOWN') lines.push(`Elliott: ${plan.elliottPhase} (${plan.elliottConfidence}) · Astro: ${plan.astroNet}`)
  if (plan.fibLevels) {
    lines.push(`Fib (last 50 bars): swing ${plan.fibLevels.low}-${plan.fibLevels.high} · 50%=${plan.fibLevels.pct500} · 61.8%=${plan.fibLevels.pct618}`)
  }
  if (plan.harmonics.length) {
    lines.push('')
    lines.push(`*Active harmonics:*`)
    for (const h of plan.harmonics.slice(0, 3)) {
      lines.push(`· ${h.direction === 'BULLISH' ? '🟢' : '🔴'} ${h.name} ${h.confidence}% — entry \`${h.entry}\` T1 \`${h.t1}\``)
    }
  }
  lines.push('')
  lines.push(`*Hora-by-hora plan (NSE 09:15-15:30):*`)
  const sessionHorasOnly = plan.horas.filter(h => {
    const s = hmToMin(h.startIST)
    return s >= 9 * 60 && s < 15 * 60 + 30
  })
  for (const h of sessionHorasOnly) {
    lines.push(`${actionEmoji(h.action)} \`${h.startIST}-${h.endIST}\` · *${h.lord}* · ${h.action.replace('_', ' ')} · ${h.confidence}%`)
    if (h.warnings.length) lines.push(`   ${h.warnings[0]}`)
  }
  lines.push('')
  lines.push(`💡 _${plan.oneLineSummary}_`)
  lines.push('*#tradewithvarsha*')
  return lines.join('\n')
}
