/**
 * Conversational Telegram handler.
 *
 * Why this exists (2026-04-29):
 * The user wants the bot to behave like an assistant. Free-form messages such
 * as:
 *   "i want to short nifty"
 *   "going long xauusd"
 *   "i want to short WTI"
 *   "i see BSE minimum 10% correction in may month"
 *   "what do you think of dmart"
 *   "is it good to buy reliance"
 * should be understood, the symbol resolved, and the bot should reply with
 * the engine's view of that symbol — does the engine AGREE or DISAGREE with
 * the user's stated intent? — followed by an actionable plan if the engine
 * has one (entry, SL, T1/T2/T3, options expiry choice, key levels).
 *
 * No LLM dependency — pure regex/keyword classification + the existing
 * masterSetup / SMC / Gann / astro engines. Cost remains zero.
 */

import * as data from '../data'
import { ema, lastATR, lastRSI, adx, bollinger } from '../indicators'
import { analyzeSMC } from '../patterns/smc'
import { gannBiasFor } from '../gann'
import { astroBiasFor } from '../astro'
import { sessionHoras } from '../astro/parashariHora'
import { selectIndexExpiry, selectStockExpiry } from '../options/expirySelector'
import { atmStrike, blackScholesPrice } from '../options/premium'
import { getLatestSectorRotation, SECTOR_BASKETS } from '../engine/sectorRotation'
import { getLatestMasterSetup } from '../engine/masterSetup'

export type UserDirection = 'LONG' | 'SHORT'

export interface ConvIntent {
  /** The verb the user expressed. */
  kind: 'trade-idea' | 'prediction' | 'opinion-ask' | 'how-to'
  /** What direction the user has in mind (if any). */
  direction: UserDirection | null
  /** Resolved canonical symbol (NIFTY / GOLD / DMART / SENSEX / ...) or null. */
  symbol: string | null
  /** For predictions like "10% correction in May" — the magnitude they expect. */
  magnitudePct?: number
  /** For predictions — the timeframe word ("may", "this week", "next month"). */
  timeframe?: string
  /** Original message verbatim. */
  raw: string
}

const INDEX_ALIASES: Record<string, string> = {
  NIFTY: 'NIFTY', NIFTY50: 'NIFTY', N50: 'NIFTY', 'NIFTY-50': 'NIFTY',
  BANKNIFTY: 'BANKNIFTY', NIFTYBANK: 'BANKNIFTY', BANKBANK: 'BANKNIFTY',
  FINNIFTY: 'FINNIFTY',
  SENSEX: 'SENSEX', BSE: 'SENSEX', BSE30: 'SENSEX',
  MIDCPNIFTY: 'MIDCPNIFTY',
}

const COMMODITY_ALIASES: Record<string, string> = {
  GOLD: 'GOLD', XAU: 'GOLD', XAUUSD: 'GOLD', SPOTGOLD: 'GOLD',
  CRUDE: 'CRUDE', WTI: 'CRUDE', BRENT: 'CRUDE', CRUDEOIL: 'CRUDE',
  SILVER: 'SILVER', XAG: 'SILVER', XAGUSD: 'SILVER',
}

const TRADE_VERBS_LONG = /\b(buy|long|going\s+long|go\s+long|want\s+to\s+go\s+long|bullish|bull\s+on|bullish\s+on)\b/i
const TRADE_VERBS_SHORT = /\b(short|sell|going\s+short|go\s+short|want\s+to\s+short|bearish|bear\s+on|bearish\s+on)\b/i
const PREDICTION_VERBS = /\b(see|expect|expecting|predict|believe|think\s+(?:there\s+will|we\s+will|it\s+will))\b/i
const OPINION_VERBS = /\b(what\s+do\s+you\s+think|view|opinion|outlook|good\s+to\s+(?:buy|sell)|should\s+i\s+(?:buy|sell|short|long))\b/i
const HOWTO_VERBS = /\b(how\s+(?:do|should|to)|where\s+(?:to|do\s+i)\s+(?:buy|sell|enter|exit))\b/i

const STOPWORDS = new Set([
  'A','AN','THE','I','YOU','WE','MY','OUR','IS','ARE','AT','ON','TO','OF','IN','FOR','BY','WITH','AND','OR','BUT','SHOULD','WILL','THIS','THAT','THESE','THOSE',
  'WANT','WOULD','LIKE','LIKE TO','BE','BEEN','HAVE','HAS','MAY','CAN','MUST','THINK','SEE','EXPECT','EXPECTING','PREDICT','BELIEVE',
  'BUY','SELL','LONG','SHORT','BULL','BULLISH','BEAR','BEARISH','GO','GOING','UP','DOWN','HIGHER','LOWER','MOVE','MOVES','CRACK','CRASH',
  'CORRECTION','CORRECTIONS','PERCENT','MIN','MINIMUM','MAX','MAXIMUM','MONTH','WEEK','DAY','TODAY','TOMORROW',
  'JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC',
  'JANUARY','FEBRUARY','MARCH','APRIL','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER',
  'GOOD','BAD','OK','HOW','WHAT','WHEN','WHERE','WHY','WHICH','OPINION','OUTLOOK','VIEW',
  'TRADE','TRADES','TRADING','SETUP','SETUPS','SIGNAL','SIGNALS','POSITION','TARGET','SL','STOP','LOSS',
])

const SECTOR_KEYWORDS: Record<string, string> = {
  FMCG: 'FMCG', CONSUMER: 'FMCG', STAPLES: 'FMCG',
  IT: 'IT', INFOTECH: 'IT', SOFTWARE: 'IT', TECH: 'IT',
  AUTO: 'AUTO', MOTORS: 'AUTO',
  PHARMA: 'PHARMA', PHARMACEUTICALS: 'PHARMA', HEALTHCARE: 'PHARMA',
  METAL: 'METALS', METALS: 'METALS', STEEL: 'METALS',
  PSU: 'BANKS_PSU', PSUBANKS: 'BANKS_PSU',
  BANKS: 'BANKS_PVT', BANKING: 'BANKS_PVT', PRIVATEBANKS: 'BANKS_PVT',
  ENERGY: 'ENERGY', OILGAS: 'ENERGY',
  REALTY: 'REALTY', REAL: 'REALTY',
  DEFENCE: 'DEFENCE', DEFENSE: 'DEFENCE', RAILWAYS: 'DEFENCE',
  INFRA: 'INFRA', CEMENT: 'INFRA',
  CAPGOODS: 'CAPITAL_GOODS', CAPITAL: 'CAPITAL_GOODS',
}

/** Try to pull a tradeable symbol out of the user message. */
function resolveSymbol(text: string): string | null {
  const upRaw = text.toUpperCase()
  const noPunct = upRaw.replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()

  // 1. Known indices / commodities (longest match first)
  const compactCheck = noPunct.replace(/\s+/g, '')
  for (const aliases of [INDEX_ALIASES, COMMODITY_ALIASES]) {
    for (const key of Object.keys(aliases).sort((a, b) => b.length - a.length)) {
      if (compactCheck.includes(key) || noPunct.split(' ').includes(key)) return aliases[key]
    }
  }

  // 2. Sector keywords resolve to "SECTOR:<key>" — caller distinguishes
  for (const [kw, sec] of Object.entries(SECTOR_KEYWORDS)) {
    if (noPunct.includes(kw)) return `SECTOR:${sec}`
  }

  // 3. Equity ticker — first ALL-CAPS token of length 3-15 not in stopwords.
  //    Try the exact-case original first to favour user-typed tickers.
  for (const tok of upRaw.split(/[^A-Z0-9&-]+/).filter(Boolean)) {
    if (tok.length < 2 || tok.length > 15) continue
    if (STOPWORDS.has(tok)) continue
    if (/^\d+$/.test(tok)) continue
    return tok
  }
  return null
}

function extractMagnitude(text: string): number | undefined {
  const m = text.match(/(\d{1,2}(?:\.\d)?)\s*%/i) ?? text.match(/(\d{1,2})\s*percent/i)
  return m ? Number(m[1]) : undefined
}

function extractTimeframe(text: string): string | undefined {
  const t = text.toLowerCase()
  if (/\bthis\s+week\b/.test(t)) return 'this week'
  if (/\bnext\s+week\b/.test(t)) return 'next week'
  if (/\bthis\s+month\b/.test(t)) return 'this month'
  if (/\bnext\s+month\b/.test(t)) return 'next month'
  if (/\b(in|by|during|for)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(text)) {
    return text.match(/\b(in|by|during|for)\s+([a-z]+)/i)![2]
  }
  if (/\btoday|intraday\b/.test(t)) return 'today'
  if (/\btomorrow\b/.test(t)) return 'tomorrow'
  return undefined
}

/**
 * Parse a free-form message into a conversational intent.
 * Returns null when the message looks like a command / pure ticker query
 * (caller falls through to the existing handlers).
 */
export function parseConversationIntent(text: string): ConvIntent | null {
  const raw = text.trim()
  if (!raw) return null
  if (raw.startsWith('/')) return null   // command — don't grab

  const wantsLong = TRADE_VERBS_LONG.test(raw)
  const wantsShort = TRADE_VERBS_SHORT.test(raw)
  const isPrediction = PREDICTION_VERBS.test(raw) && (extractMagnitude(raw) != null || /\bcorrection|crash|rally|bounce|breakout|breakdown|fall|drop|surge|gap\b/i.test(raw))
  const isOpinion = OPINION_VERBS.test(raw)
  const isHowTo = HOWTO_VERBS.test(raw)

  const symbol = resolveSymbol(raw)

  // No verb + no symbol → not for us
  if (!wantsLong && !wantsShort && !isPrediction && !isOpinion && !isHowTo) return null

  let kind: ConvIntent['kind'] = 'opinion-ask'
  if (wantsLong || wantsShort) kind = 'trade-idea'
  else if (isPrediction) kind = 'prediction'
  else if (isHowTo) kind = 'how-to'

  return {
    kind,
    direction: wantsLong ? 'LONG' : wantsShort ? 'SHORT' : null,
    symbol,
    magnitudePct: extractMagnitude(raw),
    timeframe: extractTimeframe(raw),
    raw,
  }
}

// ─── Engine view of a single symbol ───────────────────────────

interface EngineView {
  symbol: string
  ltp: number
  changePct: number
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  rsi: number
  adxVal: number | null
  emaStack: 'BULL' | 'BEAR' | 'MIXED'
  bbPctileNote: string         // e.g. "BB pctile 14 — deep coil"
  smcNote: string
  gannNote: string
  astroNote: string
  keyResistance: number[]
  keySupport: number[]
  // Plan suggestion
  plan: {
    direction: 'BUY' | 'SELL' | null
    entry: number; sl: number; t1: number; t2: number; t3: number
    rr: number
    bestTimeIST: string
  } | null
  // Master-setup match
  masterMatch: { stars: number; setupName: string; whyNow: string } | null
  // Sector context
  sectorNote: string | null
}

async function buildEngineView(symbol: string): Promise<EngineView | null> {
  const candlesD = await data.getCandles(symbol, '1D', 150).catch(() => [])
  if (!candlesD.length) return null
  const last = candlesD[candlesD.length - 1]
  const prev = candlesD[candlesD.length - 2] ?? last
  const quote = await data.getQuote(symbol).catch(() => null)
  const ltp = quote?.price && quote.price > 0 ? quote.price : last.close
  const changePct = prev.close > 0 ? ((ltp - prev.close) / prev.close) * 100 : 0

  const e9 = ema(candlesD, 9).at(-1) ?? null
  const e21 = ema(candlesD, 21).at(-1) ?? null
  const e50 = ema(candlesD, 50).at(-1) ?? null
  const e200 = ema(candlesD, 200).at(-1) ?? null
  const rsi = lastRSI(candlesD, 14) ?? 50
  const atrV = lastATR(candlesD, 14) ?? ltp * 0.02
  const a = adx(candlesD, 14)
  const smc = analyzeSMC(candlesD)
  const gann = gannBiasFor(symbol, ltp, new Date())
  const astro = astroBiasFor(new Date())

  const stack: 'BULL' | 'BEAR' | 'MIXED' =
    e9 != null && e21 != null && e50 != null && e9 > e21 && e21 > e50 ? 'BULL' :
    e9 != null && e21 != null && e50 != null && e9 < e21 && e21 < e50 ? 'BEAR' : 'MIXED'

  // Bias = combine SMC + EMA stack + RSI
  let bias: EngineView['bias'] = 'NEUTRAL'
  if ((smc.bias === 'BULLISH' && stack !== 'BEAR') || (stack === 'BULL' && rsi >= 50)) bias = 'BULLISH'
  else if ((smc.bias === 'BEARISH' && stack !== 'BULL') || (stack === 'BEAR' && rsi <= 50)) bias = 'BEARISH'

  // Bollinger compression context (just a note, not full pctile)
  const bb = bollinger(candlesD, 20, 2)
  let bbNote = 'BB normal'
  if (bb && ltp > 0) {
    const w = (bb.upper - bb.lower) / Math.max(1, bb.middle)
    bbNote = w < 0.05 ? 'BB tight (potential expansion)' : w > 0.12 ? 'BB wide (volatile / mature trend)' : 'BB normal'
  }

  const keyResistance = [last.high + atrV, last.high + 2 * atrV, ...(gann.resistances ?? [])]
    .filter(x => Number.isFinite(x) && x > ltp).slice(0, 2).map(x => +x.toFixed(2))
  const keySupport = [last.low - atrV, last.low - 2 * atrV, ...(gann.supports ?? [])]
    .filter(x => Number.isFinite(x) && x < ltp).slice(0, 2).map(x => +x.toFixed(2))

  // Plan — entry on EMA21 pullback if bias clear; SL = 1.5×ATR; T1=2.5×ATR T2=5×ATR T3=8×ATR
  let plan: EngineView['plan'] = null
  if (bias !== 'NEUTRAL' && e21 != null) {
    const dir = bias === 'BULLISH' ? 'BUY' : 'SELL'
    const sign = dir === 'BUY' ? 1 : -1
    const entry = dir === 'BUY' ? Math.min(ltp, Math.max(e21, ltp * 0.992)) : Math.max(ltp, Math.min(e21, ltp * 1.008))
    const sl = entry - sign * 1.5 * atrV
    const t1 = entry + sign * 2.5 * atrV
    const t2 = entry + sign * 5 * atrV
    const t3 = entry + sign * 8 * atrV
    const horas = sessionHoras(new Date())
    const aligned = horas.find(h => bias === 'BULLISH' ? h.bias === 'BULLISH' : h.bias === 'BEARISH') ?? horas[0]
    plan = {
      direction: dir as 'BUY' | 'SELL',
      entry: +entry.toFixed(2), sl: +sl.toFixed(2),
      t1: +t1.toFixed(2), t2: +t2.toFixed(2), t3: +t3.toFixed(2),
      rr: +(Math.abs(t1 - entry) / Math.max(0.01, Math.abs(entry - sl))).toFixed(2),
      bestTimeIST: aligned ? `${aligned.startIST}-${aligned.endIST} (${aligned.lord})` : '09:30-10:30',
    }
  }

  // Master-setup match (look in cached top-6)
  const ms = getLatestMasterSetup()
  const match = ms?.setups.find(s => s.symbol === symbol)
  const masterMatch = match
    ? { stars: match.stars, setupName: match.setupName, whyNow: match.whyNow }
    : null

  // Sector context
  const rotation = getLatestSectorRotation()
  let sectorNote: string | null = null
  if (rotation) {
    for (const b of rotation.baskets) {
      if (b.topMovers.some(m => m.symbol === symbol) || SECTOR_BASKETS.find(x => x.key === b.key)?.members.includes(symbol)) {
        sectorNote = `${b.label}: ${b.note}`
        break
      }
    }
  }

  return {
    symbol, ltp: +ltp.toFixed(2),
    changePct: +changePct.toFixed(2),
    bias, rsi: +rsi.toFixed(0),
    adxVal: a ? +a.adx.toFixed(0) : null,
    emaStack: stack,
    bbPctileNote: bbNote,
    smcNote: smc.note || `bias ${smc.bias.toLowerCase()}`,
    gannNote: gann.note,
    astroNote: astro.note,
    keyResistance, keySupport,
    plan,
    masterMatch,
    sectorNote,
  }
}

// ─── Reply builders ───────────────────────────────────────────

function todayIST(): string {
  const t = new Date(Date.now() + 5.5 * 3600_000)
  return t.toISOString().slice(0, 10)
}

/**
 * Build a conversational Markdown reply for a parsed intent. Returns null
 * when we genuinely cannot help (no symbol resolved AND no useful action).
 */
export async function buildConversationReply(intent: ConvIntent): Promise<string | null> {
  // Sector-level "rotation" intents (e.g. "what about FMCG", "is IT good")
  if (intent.symbol?.startsWith('SECTOR:')) {
    return buildSectorReply(intent.symbol.slice(7), intent)
  }

  // Pure prediction with no symbol — treat as broad-market view
  const symbol = intent.symbol ??
    (/\b(market|index|broad)\b/i.test(intent.raw) ? 'NIFTY' : null)
  if (!symbol) {
    return buildGenericReply(intent)
  }

  const view = await buildEngineView(symbol).catch(() => null)
  if (!view) {
    return `❓ I couldn't pull market data for *${symbol}*.\n\n` +
      `• Symbol may not be on NSE / MCX\n` +
      `• Try ticker form: \`RELIANCE\`, \`DMART\`, \`GOLD\`, \`CRUDE\`\n` +
      `• Or use one of: NIFTY · SENSEX · GOLD · CRUDE`
  }

  switch (intent.kind) {
    case 'trade-idea': return formatTradeIdeaReply(view, intent)
    case 'prediction': return formatPredictionReply(view, intent)
    case 'how-to':     return formatHowToReply(view, intent)
    case 'opinion-ask':
    default:           return formatOpinionReply(view, intent)
  }
}

// ── Reply: user states a trade idea ──
function formatTradeIdeaReply(v: EngineView, intent: ConvIntent): string {
  const userDir = intent.direction! // guaranteed for trade-idea
  const userBuy = userDir === 'LONG'
  const engineSays = v.bias === 'BULLISH' ? 'LONG' : v.bias === 'BEARISH' ? 'SHORT' : 'NEUTRAL'
  const aligned = (userBuy && v.bias === 'BULLISH') || (!userBuy && v.bias === 'BEARISH')

  const verdictEmoji = aligned ? '✅' : v.bias === 'NEUTRAL' ? '🟡' : '⛔'
  const verdictLine = aligned
    ? `${verdictEmoji} *Engine AGREES* — bias is ${v.bias}.`
    : v.bias === 'NEUTRAL'
      ? `${verdictEmoji} *Engine is NEUTRAL* — no edge either way; if you take the trade, size small.`
      : `${verdictEmoji} *Engine DISAGREES* — bias is ${v.bias} (opposite of your ${userDir}). Counter-trend trades have lower hit-rate; wait for confirmation or reduce size.`

  const lines: string[] = []
  lines.push(`💬 *Your idea:* ${userDir} ${v.symbol}`)
  lines.push(`📊 *Engine view (${todayIST()}):*`)
  lines.push(`Price ₹${v.ltp} (${v.changePct >= 0 ? '+' : ''}${v.changePct}%) · Bias *${v.bias}*${v.adxVal ? ` · ADX ${v.adxVal}` : ''} · RSI ${v.rsi}`)
  lines.push(`EMA stack ${v.emaStack} · ${v.bbPctileNote}`)
  lines.push(`SMC: ${v.smcNote}`)
  if (v.sectorNote) lines.push(`🌀 Sector: ${v.sectorNote}`)
  lines.push('')
  lines.push(verdictLine)
  lines.push('')

  // Plan — show the plan for the USER's direction (even if engine disagrees,
  // they may still take it; we want to at least give them risk-managed levels)
  const planForUser = v.plan && (
    (userBuy && v.plan.direction === 'BUY') ||
    (!userBuy && v.plan.direction === 'SELL')
  ) ? v.plan : null

  if (planForUser) {
    lines.push(`*Plan (${userDir}):*`)
    lines.push(`💰 Entry \`${planForUser.entry}\``)
    lines.push(`🛑 SL \`${planForUser.sl}\``)
    lines.push(`🎯 T1 \`${planForUser.t1}\` · T2 \`${planForUser.t2}\` · T3 \`${planForUser.t3}\``)
    lines.push(`R:R to T1 ≈ 1:${planForUser.rr} · Best window: ${planForUser.bestTimeIST}`)
  } else if (v.plan && !planForUser) {
    // Engine plan is opposite — show engine's plan as "what we'd actually take"
    lines.push(`_Note:_ The engine's own plan is ${v.plan.direction} from ₹${v.plan.entry} (SL ₹${v.plan.sl}, T1 ₹${v.plan.t1}). If you want the contrarian ${userDir}, wait for a confirmed flip or use half-size.`)
  } else {
    lines.push(`_No clean structural plan right now — wait for compression/break._`)
  }

  // Options leg suggestion for index / commodity
  if (['NIFTY', 'FINNIFTY', 'GOLD', 'CRUDE'].includes(v.symbol)) {
    const choice = ['NIFTY', 'FINNIFTY'].includes(v.symbol)
      ? selectIndexExpiry(new Date())
      : selectIndexExpiry(new Date())   // commodity weekly close enough
    const strike = atmStrike(v.ltp, v.symbol)
    const side: 'CE' | 'PE' = userBuy ? 'CE' : 'PE'
    const iv = 0.18
    const premium = +blackScholesPrice(v.ltp, strike, Math.max(1, choice.daysToExpiry), iv, side).toFixed(2)
    lines.push('')
    lines.push(`*Options leg:* ${v.symbol} ${strike} ${side} · ${choice.tag} (${choice.expiry}, ${choice.daysToExpiry}d)`)
    lines.push(`Premium ≈ ₹${premium} · SL ₹${(premium * 0.65).toFixed(2)} · T1 ₹${(premium * 1.5).toFixed(2)} · T2 ₹${(premium * 2.0).toFixed(2)}`)
    lines.push(`_${choice.reason}_`)
  } else if (v.symbol.length <= 12 && !['SILVER', 'SENSEX'].includes(v.symbol)) {
    // F&O stock — suggest stock options
    const choice = selectStockExpiry(new Date())
    const strike = atmStrike(v.ltp, v.symbol)
    const side: 'CE' | 'PE' = userBuy ? 'CE' : 'PE'
    const iv = Math.max(0.18, Math.min(0.45, ((lastATR([], 14) ?? 0) || 0) / Math.max(1, v.ltp) * Math.sqrt(252)))
    const premium = +blackScholesPrice(v.ltp, strike, Math.max(1, choice.daysToExpiry), iv || 0.25, side).toFixed(2)
    lines.push('')
    lines.push(`*Options leg (if F&O):* ${v.symbol} ${strike} ${side} · ${choice.tag} (${choice.expiry}, ${choice.daysToExpiry}d)`)
    lines.push(`Premium ≈ ₹${premium} · SL ₹${(premium * 0.65).toFixed(2)} · T1 ₹${(premium * 1.5).toFixed(2)} · T2 ₹${(premium * 2.0).toFixed(2)}`)
    lines.push(`_${choice.reason}_`)
  }

  if (v.masterMatch) {
    lines.push('')
    lines.push(`🎯 *Master Setup match (${'★'.repeat(v.masterMatch.stars)}${'☆'.repeat(5 - v.masterMatch.stars)}):* ${v.masterMatch.setupName}`)
    lines.push(`_${v.masterMatch.whyNow}_`)
  }

  lines.push('')
  if (v.keyResistance.length) lines.push(`Key R: ${v.keyResistance.join(' · ')}`)
  if (v.keySupport.length)    lines.push(`Key S: ${v.keySupport.join(' · ')}`)
  lines.push(`*#tradewithvarsha*`)
  return lines.join('\n')
}

// ── Reply: user makes a market prediction (e.g. "BSE 10% correction in May") ──
function formatPredictionReply(v: EngineView, intent: ConvIntent): string {
  const mag = intent.magnitudePct
  const tf = intent.timeframe ?? 'the coming weeks'
  const isCorrection = /\b(correction|crash|fall|drop|crack|breakdown)\b/i.test(intent.raw)
  const isRally = /\b(rally|surge|breakout|gap\s*up|squeeze)\b/i.test(intent.raw)
  const userExpects: 'DOWN' | 'UP' | 'UNKNOWN' = isCorrection ? 'DOWN' : isRally ? 'UP' : 'UNKNOWN'
  const engineDir: 'DOWN' | 'UP' | 'UNKNOWN' =
    v.bias === 'BEARISH' ? 'DOWN' : v.bias === 'BULLISH' ? 'UP' : 'UNKNOWN'
  const aligned = userExpects === engineDir && userExpects !== 'UNKNOWN'

  const lines: string[] = []
  lines.push(`💬 *Your view:* ${v.symbol}${mag != null ? ` ~${mag}%` : ''} ${userExpects === 'DOWN' ? '🔴 down' : userExpects === 'UP' ? '🟢 up' : '↕ move'} ${tf ? `in ${tf}` : ''}`)
  lines.push(`📊 *Engine view:* Bias ${v.bias} · RSI ${v.rsi} · ${v.bbPctileNote}`)
  lines.push(`SMC: ${v.smcNote}`)
  lines.push(`Gann: ${v.gannNote}`)
  lines.push(`Astro: ${v.astroNote}`)
  if (v.sectorNote) lines.push(`🌀 Sector: ${v.sectorNote}`)
  lines.push('')

  if (aligned) {
    lines.push(`✅ *Engine AGREES with the direction.*`)
    if (mag != null) {
      const atrPctApprox = v.ltp > 0 ? ((Math.abs(v.ltp - (v.keySupport[0] ?? v.ltp)) / v.ltp) * 100) : 0
      lines.push(`Magnitude check: from ₹${v.ltp}, a ${mag}% ${userExpects === 'DOWN' ? 'fall' : 'rise'} = ₹${(v.ltp * (userExpects === 'DOWN' ? (1 - mag/100) : (1 + mag/100))).toFixed(2)}.`)
      lines.push(`Engine sees nearest key levels at ${(userExpects === 'DOWN' ? v.keySupport : v.keyResistance).join(' · ')} — ${mag}% target ${atrPctApprox > mag ? 'is conservative' : 'is achievable but stretched, would need cycle confirmation'}.`)
    }
  } else if (engineDir === 'UNKNOWN') {
    lines.push(`🟡 *Engine is NEUTRAL.* Compression first, then expansion. If you have conviction, wait for a confirmed BOS in your direction before sizing up.`)
  } else {
    lines.push(`⛔ *Engine DISAGREES* — bias is currently ${v.bias.toLowerCase()}. Either you're early (engine catches up later) or the prediction is anchored on macro/news the engine doesn't read. Track for an SMC flip in the next 2-3 sessions.`)
  }

  if (v.plan) {
    lines.push('')
    lines.push(`*If you want to pre-position:* ${v.plan.direction} from \`${v.plan.entry}\` · SL \`${v.plan.sl}\` · T1 \`${v.plan.t1}\` · T2 \`${v.plan.t2}\` · T3 \`${v.plan.t3}\``)
  }
  if (v.masterMatch) {
    lines.push('')
    lines.push(`🎯 Master Setup ${'★'.repeat(v.masterMatch.stars)}${'☆'.repeat(5 - v.masterMatch.stars)} — ${v.masterMatch.setupName}`)
  }
  lines.push('*#tradewithvarsha*')
  return lines.join('\n')
}

function formatOpinionReply(v: EngineView, _intent: ConvIntent): string {
  const lines: string[] = []
  const biasEmoji = v.bias === 'BULLISH' ? '🟢' : v.bias === 'BEARISH' ? '🔴' : '🟡'
  lines.push(`📊 *${v.symbol} · ${todayIST()}*`)
  lines.push(`Price ₹${v.ltp} (${v.changePct >= 0 ? '+' : ''}${v.changePct}%) · ${biasEmoji} *${v.bias}* · RSI ${v.rsi}`)
  lines.push(`EMA stack ${v.emaStack}${v.adxVal ? ` · ADX ${v.adxVal}` : ''} · ${v.bbPctileNote}`)
  lines.push(`SMC: ${v.smcNote}`)
  if (v.sectorNote) lines.push(`🌀 ${v.sectorNote}`)
  lines.push('')
  if (v.plan) {
    lines.push(`*Plan (${v.plan.direction}):* Entry \`${v.plan.entry}\` · SL \`${v.plan.sl}\` · T1 \`${v.plan.t1}\` · T2 \`${v.plan.t2}\` · T3 \`${v.plan.t3}\` · R:R 1:${v.plan.rr}`)
    lines.push(`Best window: ${v.plan.bestTimeIST}`)
  } else {
    lines.push(`_No actionable plan — bias unclear, sit out._`)
  }
  if (v.keyResistance.length) lines.push(`R: ${v.keyResistance.join(' · ')}`)
  if (v.keySupport.length) lines.push(`S: ${v.keySupport.join(' · ')}`)
  if (v.masterMatch) {
    lines.push('')
    lines.push(`🎯 Master ${'★'.repeat(v.masterMatch.stars)}${'☆'.repeat(5 - v.masterMatch.stars)}: ${v.masterMatch.setupName} — _${v.masterMatch.whyNow}_`)
  }
  lines.push('*#tradewithvarsha*')
  return lines.join('\n')
}

function formatHowToReply(v: EngineView, _intent: ConvIntent): string {
  const lines: string[] = []
  lines.push(`📘 *How to play ${v.symbol} from here*`)
  lines.push(`LTP ₹${v.ltp} · Bias *${v.bias}*`)
  if (v.plan) {
    const dir = v.plan.direction
    lines.push('')
    lines.push(`1. *Entry:* ${dir} \`${v.plan.entry}\` (engine pulls back to EMA21).`)
    lines.push(`2. *SL:* \`${v.plan.sl}\` (1.5×ATR — anything tighter gets shaken out).`)
    lines.push(`3. *Targets:* T1 \`${v.plan.t1}\` (book 50%) · T2 \`${v.plan.t2}\` (book 30%) · T3 \`${v.plan.t3}\` (trail).`)
    lines.push(`4. *Best slot:* ${v.plan.bestTimeIST}.`)
    lines.push(`5. *Invalidation:* opposite bias on ${v.symbol === 'NIFTY' ? '15m' : 'daily'} closes through SL.`)
  } else {
    lines.push('')
    lines.push(`No setup right now — wait for compression to resolve. Trigger conditions:`)
    lines.push(`  • ${v.bbPctileNote}`)
    lines.push(`  • SMC: ${v.smcNote}`)
    lines.push(`  • Watch for BOS through R: ${v.keyResistance.join(' / ') || 'n/a'} · or breakdown S: ${v.keySupport.join(' / ') || 'n/a'}`)
  }
  lines.push('*#tradewithvarsha*')
  return lines.join('\n')
}

function buildSectorReply(sectorKey: string, _intent: ConvIntent): string {
  const rotation = getLatestSectorRotation()
  if (!rotation) return `🌀 No sector-rotation snapshot yet — refresh the dashboard / try again in a few minutes.`
  const reading = rotation.baskets.find(b => b.key === sectorKey)
  if (!reading) return `🌀 *${sectorKey}* — no fresh reading. Try one of the basket keys: ${rotation.baskets.map(b => b.key).slice(0, 6).join(', ')}.`
  const lines: string[] = []
  lines.push(`🌀 *${reading.label}* · ${todayIST()}`)
  lines.push(reading.note)
  lines.push(`5d return ${reading.ret5d > 0 ? '+' : ''}${reading.ret5d}% · 20d ${reading.ret20d > 0 ? '+' : ''}${reading.ret20d}% · vs NIFTY ${reading.relStr5d > 0 ? '+' : ''}${reading.relStr5d}%`)
  lines.push(`Breadth: ${reading.pctAboveEma21}% > EMA21 · vol ${reading.volRatio}× 30d`)
  if (reading.topMovers.length) {
    lines.push('')
    lines.push(`*Top movers:*`)
    for (const m of reading.topMovers.slice(0, 5)) {
      lines.push(`  · ${m.symbol} ₹${m.ltp} · 5d ${m.ret5d > 0 ? '+' : ''}${m.ret5d}% · 20d ${m.ret20d > 0 ? '+' : ''}${m.ret20d}%`)
    }
  }
  lines.push('*#tradewithvarsha*')
  return lines.join('\n')
}

function buildGenericReply(intent: ConvIntent): string {
  const ms = getLatestMasterSetup()
  const rotation = getLatestSectorRotation()
  const lines: string[] = []
  lines.push(`💬 I caught your intent (${intent.kind}) but couldn't pin a specific symbol.`)
  lines.push('')
  lines.push(`Try one of:`)
  lines.push(`  • _"i want to short nifty"_ / _"long xauusd"_ / _"short wti"_`)
  lines.push(`  • _"i see 10% BSE correction in may"_`)
  lines.push(`  • _"what do you think of dmart"_`)
  lines.push(`  • _"is FMCG good now"_`)
  lines.push('')
  if (ms?.setups.length) {
    lines.push(`*Today's master setups (${ms.setups.length}):*`)
    for (const s of ms.setups.slice(0, 4)) {
      lines.push(`  ${'★'.repeat(s.stars)} ${s.symbol} ${s.direction} — ${s.setupName} · LTP ₹${s.ltp}`)
    }
  }
  if (rotation) {
    lines.push('')
    lines.push(`*Sector rotation:* ${rotation.oneLineSummary}`)
  }
  return lines.join('\n')
}
