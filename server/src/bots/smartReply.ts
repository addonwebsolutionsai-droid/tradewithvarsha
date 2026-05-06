import * as data from '../data'
import { analyzeSMC } from '../patterns/smc'
import { ema, lastATR, lastRSI } from '../indicators'
import { gannBiasFor } from '../gann'
import { astroBiasFor } from '../astro'
import { horaAt, sessionHoras } from '../astro/parashariHora'
import { signalForSymbol } from '../engine/signalEngine'
import { fmtSignal } from './formatter'
import type { Signal } from '../types'

/**
 * Free-text "smart reply" router for Telegram.
 *
 * Users want to send messages like:
 *   "Give me nifty 50 outlook of the day"
 *   "Xauusd trade setup for the day as per liquidity"
 *   "Moschip share trade signals based on smart money"
 *   "Smart money liquidity aiming next for Nifty 50 or Xauusd"
 *
 * We route these to purpose-built analyzers rather than the generic
 * instrument-parser (which is for option-chain / futures queries).
 *
 * Intent matching is pure keyword/regex — no LLM cost, deterministic,
 * and debuggable. Priority order matters: more specific intents first.
 */

export type SmartIntent =
  | { kind: 'outlook'; symbol: string }
  | { kind: 'trade-setup'; symbol: string }
  | { kind: 'smart-money'; symbol: string }
  | { kind: 'liquidity-aim'; symbol: string }
  | null

/**
 * Parse a free-text message into a smart-reply intent.
 * Returns null when no match — caller should fall through to the
 * generic instrument parser.
 */
export function parseSmartIntent(text: string): SmartIntent {
  const lc = text.toLowerCase()

  // Symbol extraction — first wins.
  const symbol = resolveSymbol(lc)
  if (!symbol) return null

  // Intent cascade — explicit user-action verbs win over passive descriptors.
  //
  // 1. "trade setup / trade signal" — when the user explicitly wants an
  //    actionable signal, that beats every other intent. The qualifying
  //    phrase ("based on smart money", "as per liquidity", etc) is treated
  //    as flavour, not as a switch to a different report type.
  if (
    /\btrade\s*setup\b/.test(lc)
    || /\btrade\s*signal/.test(lc)
    || /\bsetup\b.*\b(today|day|intraday|now)\b/.test(lc)
    || /\b(today|day|intraday)\b.*\bsetup\b/.test(lc)
  ) {
    return { kind: 'trade-setup', symbol }
  }

  // 2. "liquidity aim" — explicit liquidity-hunting query. Requires the
  //    word "liquidity" (or "liq") OR a strong directional aim phrase.
  //    Loose "aim" alone no longer hijacks SMC questions.
  if (
    /\b(liquidity|liq)\b/.test(lc)
    || /\baiming\s+next\b/.test(lc)
    || /\b(stop\s*hunt|liquidity\s*hunt)\b/.test(lc)
  ) {
    return { kind: 'liquidity-aim', symbol }
  }

  // 3. "smart money analysis" — SMC deep-dive (bias, BOS/CHoCH, OB, sweeps)
  if (/\b(smart\s*money|smc)\b/.test(lc) || /\border\s*block\b/.test(lc) || /\b(bos|choch)\b/.test(lc)) {
    return { kind: 'smart-money', symbol }
  }

  // "outlook" / "view" / "analysis for today"
  if (
    /\b(outlook|view|forecast|analysis|bias|direction)\b/.test(lc)
    || /\b(what(?:'s| is))?\s*(nifty|gold|xauusd|crude)\s*(doing|going|looking)\b/.test(lc)
  ) {
    return { kind: 'outlook', symbol }
  }

  return null
}

/**
 * Resolve a symbol alias into our canonical engine symbol.
 * We only support what our data layer can actually fetch.
 */
function resolveSymbol(lc: string): string | null {
  // Forex / commodity aliases
  if (/\bxau\s*usd\b|\bxauusd\b|\bxau\b|\bspot\s*gold\b/.test(lc)) return 'GOLD'
  if (/\bgold\b(?!\s*(etf|bees))/.test(lc)) return 'GOLD'
  if (/\b(crude|wti|brent|oil)\b/.test(lc) && !/\boil\s*india\b/.test(lc)) return 'CRUDE'
  if (/\bsilver\b/.test(lc)) return 'SILVER'

  // Indices
  if (/\bnifty\s*50\b|\bnifty50\b|\bn50\b/.test(lc)) return 'NIFTY'
  if (/\bbanknifty\b|\bbank\s*nifty\b/.test(lc)) return 'BANKNIFTY'
  if (/\bfinnifty\b|\bfin\s*nifty\b/.test(lc)) return 'FINNIFTY'
  if (/\bsensex\b/.test(lc)) return 'SENSEX'
  if (/\bnifty\b/.test(lc)) return 'NIFTY'         // bare "nifty" — after nifty50 check

  // NSE stock — pull the first ALL-CAPS token of length >=3 from the ORIGINAL
  // text. We're doing this on `lc` so we need the original — caller passes
  // the raw text below via a secondary capture.
  //
  // Accept lower-case ticker tokens too (e.g. "moschip share signals").
  const stockMatch = lc.match(/\b([a-z]{3,15})\b/g) ?? []
  // Skip English-noise words so we don't treat "share" / "trade" as tickers.
  const STOP = new Set([
    'share', 'shares', 'stock', 'stocks', 'trade', 'trades', 'trading',
    'signal', 'signals', 'setup', 'setups', 'today', 'daily', 'outlook',
    'view', 'analysis', 'bias', 'direction', 'smart', 'money', 'aim',
    'next', 'liquidity', 'forecast', 'the', 'day', 'intraday', 'swing',
    'based', 'as', 'per', 'what', 'for', 'give', 'me', 'please',
    'hunt', 'target', 'where', 'going', 'doing', 'looking',
  ])
  for (const tok of stockMatch) {
    if (STOP.has(tok)) continue
    if (/^(and|or|but|with|from|into)$/.test(tok)) continue
    return tok.toUpperCase()
  }
  return null
}

// ─── Handlers ────────────────────────────────────────────────────

/**
 * Route an intent to its handler and return the Markdown reply.
 * Returns null if we genuinely can't analyse the symbol (bad data).
 */
export async function handleSmartIntent(intent: Exclude<SmartIntent, null>): Promise<string | null> {
  switch (intent.kind) {
    case 'outlook':       return buildOutlookReport(intent.symbol)
    case 'trade-setup':   return buildTradeSetupReport(intent.symbol)
    case 'smart-money':   return buildSmartMoneyReport(intent.symbol)
    case 'liquidity-aim': return buildLiquidityAimReport(intent.symbol)
  }
}

// ─── Outlook ─────────────────────────────────────────────────────

async function buildOutlookReport(symbol: string): Promise<string | null> {
  const candlesD = await data.getCandles(symbol, '1D', 120).catch(() => [])
  if (!candlesD.length) return null
  const last = candlesD[candlesD.length - 1]
  const prev = candlesD[candlesD.length - 2] ?? last
  const changePct = prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0
  const smc = analyzeSMC(candlesD)
  const rsi = lastRSI(candlesD, 14) ?? 50
  const atr = lastATR(candlesD, 14) ?? last.close * 0.02
  const e21 = ema(candlesD, 21).at(-1)
  const e50 = ema(candlesD, 50).at(-1)
  const e200 = ema(candlesD, 200).at(-1)
  const gann = gannBiasFor(symbol, last.close, new Date())
  const astro = astroBiasFor(new Date())
  const hora = horaAt(new Date())

  // Resolve an aligned session hora for the dominant bias.
  const wantsBull = smc.bias === 'BULLISH' || astro.bullish
  const horas = sessionHoras(new Date())
  const alignHora = horas.find(h => wantsBull ? h.bias === 'BULLISH' : h.bias === 'BEARISH') ?? horas[0]

  const trendStack =
    e21 && e50 && e200 && e21 > e50 && e50 > e200 ? 'Stacked Bullish (EMA 21>50>200)' :
    e21 && e50 && e200 && e21 < e50 && e50 < e200 ? 'Stacked Bearish (EMA 21<50<200)' :
    'Mixed'

  const keyRes = [last.close + atr, last.close + 2 * atr, gann.resistances[0]].filter(Boolean).slice(0, 2)
  const keySup = [last.close - atr, last.close - 2 * atr, gann.supports[0]].filter(Boolean).slice(0, 2)

  const dirEmoji = smc.bias === 'BULLISH' ? '🟢' : smc.bias === 'BEARISH' ? '🔴' : '🟡'
  const nextCycle = gann.nextCycles[0]

  const lines: string[] = []
  lines.push(`📊 *${symbol} Outlook · ${todayIST()}*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  lines.push(`Price: *₹${last.close.toFixed(2)}* (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%)`)
  lines.push(`Bias: ${dirEmoji} *${smc.bias}* · RSI ${rsi.toFixed(0)} · ${trendStack}`)
  lines.push(``)
  lines.push(`*SMC structure:* ${smc.note || 'No major break'}`)
  if (smc.bosBull) lines.push(`  ✓ BOS↑ — structure broken to upside`)
  if (smc.bosBear) lines.push(`  ✓ BOS↓ — structure broken to downside`)
  if (smc.chochBull) lines.push(`  ⚡ CHoCH↑ — bullish reversal confirmed`)
  if (smc.chochBear) lines.push(`  ⚡ CHoCH↓ — bearish reversal confirmed`)
  if (smc.liquiditySweepBull) lines.push(`  💧 Liquidity swept low + reclaim (bullish)`)
  if (smc.liquiditySweepBear) lines.push(`  💧 Liquidity swept high + reject (bearish)`)
  lines.push(``)
  lines.push(`*Key levels:*`)
  if (keyRes.length) lines.push(`  R: ${keyRes.map(r => r.toFixed(2)).join(' · ')}`)
  if (keySup.length) lines.push(`  S: ${keySup.map(s => s.toFixed(2)).join(' · ')}`)
  lines.push(``)
  lines.push(`🪐 Astro: ${astro.bullish ? '🟢 bullish' : astro.bearish ? '🔴 bearish' : astro.volatile ? '⚡ volatile' : '⚪ neutral'} (${astro.strength.toFixed(2)})`)
  lines.push(`⏱ Hora now: *${hora.lord}* · ${hora.bias.toLowerCase()}`)
  lines.push(`   Best aligned slot: *${alignHora.startIST}-${alignHora.endIST} IST* (${alignHora.lord})`)
  if (nextCycle) {
    lines.push(`🔮 Next Gann cycle: *${nextCycle.name}* on ${nextCycle.date} (${nextCycle.daysAway}d, ${nextCycle.importance})`)
  }
  lines.push(``)
  lines.push(`_${astro.note}_`)
  lines.push(`*#tradewithvarsha*`)
  return lines.join('\n')
}

// ─── Trade setup ─────────────────────────────────────────────────

async function buildTradeSetupReport(symbol: string): Promise<string | null> {
  // Prefer the engine's fresh on-demand signal for this symbol.
  const sigs = await signalForSymbol(symbol).catch(() => [] as Signal[])
  if (sigs.length) {
    const best = sigs.sort((a, b) => b.score - a.score)[0]
    return fmtSignal(best)
  }
  // Fallback — compute a lightweight setup from the daily candles.
  const candlesD = await data.getCandles(symbol, '1D', 120).catch(() => [])
  if (!candlesD.length) return null
  const last = candlesD[candlesD.length - 1]
  const atr = lastATR(candlesD, 14) ?? last.close * 0.02
  const smc = analyzeSMC(candlesD)
  const bull = smc.bias === 'BULLISH' || smc.liquiditySweepBull || smc.chochBull
  const dir = bull ? 'BUY' : 'SELL'
  const e21 = ema(candlesD, 21).at(-1) ?? last.close
  const entry = bull ? Math.min(last.close, Math.max(e21, last.close * 0.99))
                     : Math.max(last.close, Math.min(e21, last.close * 1.01))
  const sl = bull ? entry - 1.5 * atr : entry + 1.5 * atr
  const t1 = bull ? entry + 2.5 * atr : entry - 2.5 * atr
  const t2 = bull ? entry + 5 * atr   : entry - 5 * atr
  const t3 = bull ? entry + 8 * atr   : entry - 8 * atr
  const horas = sessionHoras(new Date())
  const alignHora = horas.find(h => bull ? h.bias === 'BULLISH' : h.bias === 'BEARISH') ?? horas[0]

  const rr = Math.abs((t1 - entry) / (entry - sl))
  const dirEmoji = bull ? '🟢' : '🔴'
  const lines = [
    `🎯 *${symbol} Trade Setup* · ${dirEmoji} *${dir}*`,
    `━━━━━━━━━━━━━━━━━━`,
    `_SMC ${smc.bias} · RSI-guided fallback (no strict-engine match today)_`,
    ``,
    `⏱ Trigger window: *${alignHora.startIST}-${alignHora.endIST} IST* (${alignHora.lord} hora · ${alignHora.bias})`,
    `💰 Entry \`${entry.toFixed(2)}\``,
    `🛑 SL \`${sl.toFixed(2)}\` (${((sl - entry) / entry * 100).toFixed(1)}%)`,
    `🎯 T1 \`${t1.toFixed(2)}\` (${((t1 - entry) / entry * 100).toFixed(1)}%)`,
    `🚀 T2 \`${t2.toFixed(2)}\` (${((t2 - entry) / entry * 100).toFixed(1)}%)`,
    `🏁 T3 \`${t3.toFixed(2)}\` (${((t3 - entry) / entry * 100).toFixed(1)}%)`,
    `RR to T1: 1:${rr.toFixed(2)}`,
    ``,
    `💡 ${smc.note}`,
    `*#tradewithvarsha*`,
  ]
  return lines.join('\n')
}

// ─── Smart-money analysis ────────────────────────────────────────

async function buildSmartMoneyReport(symbol: string): Promise<string | null> {
  // 15m for execution context + 1D for structure.
  const c15 = await data.getCandles(symbol, '15m', 200).catch(() => [])
  const cD = await data.getCandles(symbol, '1D', 120).catch(() => [])
  if (!c15.length && !cD.length) return null
  const exec = c15.length ? analyzeSMC(c15) : null
  const struct = cD.length ? analyzeSMC(cD) : null
  const last = (c15[c15.length - 1] ?? cD[cD.length - 1]).close

  const lines = [`🧠 *${symbol} Smart-Money Analysis*`, `━━━━━━━━━━━━━━━━━━`]
  lines.push(`Price: *₹${last.toFixed(2)}*`)

  if (struct) {
    lines.push(``)
    lines.push(`*Daily structure:* ${smcBiasEmoji(struct.bias)} *${struct.bias}*`)
    if (struct.lastSwingHigh) lines.push(`  Last swing high: ₹${struct.lastSwingHigh.price.toFixed(2)}`)
    if (struct.lastSwingLow) lines.push(`  Last swing low:  ₹${struct.lastSwingLow.price.toFixed(2)}`)
    if (struct.bosBull) lines.push(`  ✓ Daily BOS↑ — bulls in control`)
    if (struct.bosBear) lines.push(`  ✓ Daily BOS↓ — bears in control`)
    if (struct.chochBull) lines.push(`  ⚡ Daily CHoCH↑ — trend just flipped bull`)
    if (struct.chochBear) lines.push(`  ⚡ Daily CHoCH↓ — trend just flipped bear`)
    if (struct.lastOrderBlock) {
      const ob = struct.lastOrderBlock
      lines.push(`  📦 Last Daily OB: ${ob.kind} ${ob.low.toFixed(2)}–${ob.high.toFixed(2)}`)
    }
  }

  if (exec) {
    lines.push(``)
    lines.push(`*15m execution read:* ${smcBiasEmoji(exec.bias)} *${exec.bias}*`)
    if (exec.liquiditySweepBull) lines.push(`  💧 Liquidity sweep LOW + reclaim — bullish trap`)
    if (exec.liquiditySweepBear) lines.push(`  💧 Liquidity sweep HIGH + reject — bearish trap`)
    if (exec.bosBull) lines.push(`  ✓ 15m BOS↑ — momentum with bulls`)
    if (exec.bosBear) lines.push(`  ✓ 15m BOS↓ — momentum with bears`)
    if (exec.lastOrderBlock) {
      const ob = exec.lastOrderBlock
      lines.push(`  📦 15m OB (buy-zone for ${ob.kind === 'BULLISH' ? 'longs' : 'shorts'}): ${ob.low.toFixed(2)}–${ob.high.toFixed(2)}`)
    }
  }

  // Tactical takeaway
  lines.push(``)
  const tactical = tacticalFromSMC(exec, struct, last)
  lines.push(`💡 ${tactical}`)
  lines.push(`*#tradewithvarsha*`)
  return lines.join('\n')
}

function tacticalFromSMC(
  exec: ReturnType<typeof analyzeSMC> | null,
  struct: ReturnType<typeof analyzeSMC> | null,
  last: number,
): string {
  if (struct?.bias === 'BULLISH' && exec?.liquiditySweepBull) {
    return `Daily bullish + 15m sweep-low reclaim — favour longs off ₹${last.toFixed(2)} toward the last swing high.`
  }
  if (struct?.bias === 'BEARISH' && exec?.liquiditySweepBear) {
    return `Daily bearish + 15m sweep-high reject — favour shorts off ₹${last.toFixed(2)} toward the last swing low.`
  }
  if (exec?.chochBull) return `15m CHoCH just flipped bullish — wait for the retest of OB before long entry.`
  if (exec?.chochBear) return `15m CHoCH just flipped bearish — wait for the retest of OB before short entry.`
  if (struct?.bias === 'BULLISH') return `Higher-TF bull bias intact — buy-the-dip setups preferred.`
  if (struct?.bias === 'BEARISH') return `Higher-TF bear bias intact — sell-the-rally setups preferred.`
  return `Ranging structure — wait for liquidity sweep + BOS before committing. No edge right now.`
}

function smcBiasEmoji(b: string): string {
  return b === 'BULLISH' ? '🟢' : b === 'BEARISH' ? '🔴' : '🟡'
}

// ─── Liquidity aim ───────────────────────────────────────────────

async function buildLiquidityAimReport(symbol: string): Promise<string | null> {
  const c15 = await data.getCandles(symbol, '15m', 200).catch(() => [])
  const cD = await data.getCandles(symbol, '1D', 120).catch(() => [])
  if (!c15.length && !cD.length) return null
  const last = (c15[c15.length - 1] ?? cD[cD.length - 1]).close
  const atr15 = c15.length ? (lastATR(c15, 14) ?? last * 0.005) : last * 0.005
  const atrD = cD.length ? (lastATR(cD, 14) ?? last * 0.02) : last * 0.02

  // Liquidity pools = equal highs / equal lows / prior day H-L / swing H-L.
  // We collect both above and below current price and rank by distance.
  const pools = collectLiquidityPools(c15, cD)
  const above = pools.filter(p => p.price > last).sort((a, b) => a.price - b.price).slice(0, 3)
  const below = pools.filter(p => p.price < last).sort((a, b) => b.price - a.price).slice(0, 3)

  // Which side does SM aim next? Proxy: look at 15m BOS + daily bias.
  const exec = c15.length ? analyzeSMC(c15) : null
  const struct = cD.length ? analyzeSMC(cD) : null
  const aimingUp =
    (exec?.liquiditySweepBull ?? false)
    || (struct?.bias === 'BULLISH' && !(exec?.liquiditySweepBear))
    || (exec?.bosBull ?? false)
  const aimingDown =
    (exec?.liquiditySweepBear ?? false)
    || (struct?.bias === 'BEARISH' && !(exec?.liquiditySweepBull))
    || (exec?.bosBear ?? false)
  const direction = aimingUp && !aimingDown ? 'UP'
                   : aimingDown && !aimingUp ? 'DOWN'
                   : 'UNCLEAR'

  const dirEmoji = direction === 'UP' ? '🟢 ↑' : direction === 'DOWN' ? '🔴 ↓' : '🟡 ??'
  const next = direction === 'UP' ? above[0] : direction === 'DOWN' ? below[0] : null

  const lines = [
    `💧 *${symbol} Liquidity Map*`,
    `━━━━━━━━━━━━━━━━━━`,
    `Price: *₹${last.toFixed(2)}* · ATR15 ₹${atr15.toFixed(2)} · ATRD ₹${atrD.toFixed(2)}`,
    ``,
    `*Smart-money aim:* ${dirEmoji}`,
  ]
  if (next) {
    const distPct = Math.abs(next.price - last) / last * 100
    lines.push(`  Next target: *₹${next.price.toFixed(2)}* (${distPct.toFixed(2)}% away · ${next.label})`)
  }
  lines.push(``)
  if (above.length) {
    lines.push(`*Liquidity above (buy-stops / shorts trapped):*`)
    for (const p of above) {
      const pct = ((p.price - last) / last * 100).toFixed(2)
      lines.push(`  ↑ ₹${p.price.toFixed(2)} · +${pct}% · ${p.label}`)
    }
  }
  if (below.length) {
    lines.push(`*Liquidity below (sell-stops / longs trapped):*`)
    for (const p of below) {
      const pct = ((p.price - last) / last * 100).toFixed(2)
      lines.push(`  ↓ ₹${p.price.toFixed(2)} · ${pct}% · ${p.label}`)
    }
  }
  lines.push(``)
  lines.push(`💡 ${liquidityTakeaway(direction, next, last)}`)
  lines.push(`*#tradewithvarsha*`)
  return lines.join('\n')
}

interface LiquidityPool {
  price: number
  label: string
  kind: 'EQH' | 'EQL' | 'PDH' | 'PDL' | 'SWING_H' | 'SWING_L'
}

function collectLiquidityPools(c15: Array<{ high: number; low: number }>, cD: Array<{ high: number; low: number }>): LiquidityPool[] {
  const pools: LiquidityPool[] = []
  // Prior-day high/low from daily candles (most liquid levels retail watches).
  if (cD.length >= 2) {
    const pd = cD[cD.length - 2]
    pools.push({ price: pd.high, label: 'Prior-day high', kind: 'PDH' })
    pools.push({ price: pd.low, label: 'Prior-day low', kind: 'PDL' })
  }
  // 5-day swing high/low — next-most-liquid layer.
  if (cD.length >= 6) {
    const last5 = cD.slice(-6, -1)
    const sh = Math.max(...last5.map(c => c.high))
    const sl = Math.min(...last5.map(c => c.low))
    pools.push({ price: sh, label: '5d swing high', kind: 'SWING_H' })
    pools.push({ price: sl, label: '5d swing low', kind: 'SWING_L' })
  }
  // Equal highs / lows on 15m — where stops cluster in the intraday book.
  //   Detect: two or more bars within ±0.05% of the same high / low.
  if (c15.length >= 40) {
    const window = c15.slice(-60)
    const eqh = findEqualLevels(window.map(c => c.high))
    const eql = findEqualLevels(window.map(c => c.low))
    for (const p of eqh) pools.push({ price: p, label: 'Equal highs (EQH)', kind: 'EQH' })
    for (const p of eql) pools.push({ price: p, label: 'Equal lows (EQL)', kind: 'EQL' })
  }
  // Dedupe (within 0.1% band)
  return dedupe(pools, 0.001)
}

function findEqualLevels(values: number[]): number[] {
  const found: number[] = []
  const eps = 0.0005
  for (let i = 0; i < values.length; i++) {
    let matches = 0
    for (let j = 0; j < values.length; j++) {
      if (i === j) continue
      if (Math.abs(values[i] - values[j]) / values[i] < eps) matches++
    }
    if (matches >= 1) found.push(values[i])
  }
  return dedupePrices(found, eps * 2)
}

function dedupePrices(prices: number[], tol: number): number[] {
  const out: number[] = []
  for (const p of prices) {
    if (!out.some(q => Math.abs(q - p) / p < tol)) out.push(p)
  }
  return out
}

function dedupe(pools: LiquidityPool[], tol: number): LiquidityPool[] {
  const out: LiquidityPool[] = []
  for (const p of pools) {
    if (!out.some(q => Math.abs(q.price - p.price) / p.price < tol)) out.push(p)
  }
  return out
}

function liquidityTakeaway(dir: string, next: LiquidityPool | null, last: number): string {
  if (!next) return `No clear liquidity imbalance — structure is balanced, stand aside.`
  const distPct = Math.abs(next.price - last) / last * 100
  if (dir === 'UP') {
    return `Expect a push up to *₹${next.price.toFixed(2)}* (${next.label}, ${distPct.toFixed(2)}% away) before any meaningful pullback. Longs on dips are aligned; chasing extended candles is not.`
  }
  if (dir === 'DOWN') {
    return `Expect a flush to *₹${next.price.toFixed(2)}* (${next.label}, ${distPct.toFixed(2)}% away) to clear stops before any bounce. Shorts on rallies are aligned; catching falling knives is not.`
  }
  return `Direction unclear — both ${next.label} and the opposite pool are in play. Wait for the first decisive 15m BOS.`
}

function todayIST(): string {
  const d = new Date(Date.now() + 330 * 60_000)   // UTC+5:30
  return d.toISOString().slice(0, 10)
}
