import type { AstroBias, BacktestResult, GannBias, Signal } from '../types'
import type { AnalysisReport } from './smartAnalyzer'
import type { TimeCycleReport } from '../gann/timeCycleAnalysis'
import type { ReversalReport } from '../engine/reversalDates'

const gradeEmoji = { A: '🔥', B: '✅', C: '🟡', D: '⚪' } as const
const dirEmoji = { BUY: '🟢', SELL: '🔴' } as const

/**
 * Star rating shown on every alert and list entry. Rules match the
 * client-side helper (convictionTier.ts):
 *   5★  A + score ≥ 8
 *   3★  A (score < 8)  OR  B
 *   2★  C or below / WATCH
 */
function signalStars(s: Signal): string {
  if (s.tier === 'WATCH') return '⭐⭐'
  if (s.grade === 'A' && s.score >= 8) return '⭐⭐⭐⭐⭐'
  if (s.grade === 'A' || s.grade === 'B') return '⭐⭐⭐'
  return '⭐⭐'
}

// Short labels for confluence factors. Only firing (✓) factors are listed
// in the compact card — misses are omitted to keep alerts short.
const CONFLUENCE_LABEL: Record<string, string> = {
  trend: 'Trend', smc: 'SMC', vwap: 'VWAP', volume: 'Vol', pattern: 'Ptrn',
  gann: 'Gann', astro: 'Astro', rsi: 'RSI', oi: 'OI', supertrend: 'ST',
  flow: 'Flow', fundamentals: 'Fund',
}

function firingFactors(c: Signal['confluence']): string[] {
  return Object.entries(c)
    .filter(([, v]) => v)
    .map(([k]) => CONFLUENCE_LABEL[k] || k)
}

function prettyDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso.slice(0, 10)
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
  return `${d.getDate()}-${mon}`
}

function daysTo(iso: string): number | null {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86400_000))
}

/**
 * Compact signal card — ~9 lines, crisp, branded.
 * Design priorities: header → price ladder → firing-factor pill →
 * one-line flavour (top reason + astro/hora hint) → plan → validity → hashtag.
 */
export function fmtSignal(s: Signal): string {
  const lines: string[] = []
  const tierTag = s.tier === 'WATCH' ? ' 👁' : ''
  const total = Object.keys(s.confluence).length || 8
  const fired = firingFactors(s.confluence)

  // Header: stars + instrument + direction, then meta line
  lines.push(`${signalStars(s)} *${s.instrument}* · ${dirEmoji[s.direction]} *${s.direction}*${tierTag}`)
  lines.push(`_${gradeEmoji[s.grade]} ${s.grade} · ${s.score}/10 · RR 1:${s.riskReward} · ${s.confluenceCount}/${total} conf_`)

  // Entry date + precise hora window (Parashari). Fallback: generic entry window.
  const tp = s.tradePlan
  if (tp?.entryDate) {
    const win = tp.bestEntryTimeIST
      ? `${tp.bestEntryTimeIST} IST${tp.horaLord ? ` · ${tp.horaLord} hora` : ''}`
      : tp.entryWindow.split('·')[0].trim()
    lines.push(`📅 ${prettyDate(tp.entryDate)} · ⏱ ${win}`)
  }

  // Price ladder — entry as a zone when available (preserves "best-entry-price"
  // clarity for intraday/options where premium band matters).
  const entryTxt = tp?.entryPriceLow != null && tp?.entryPriceHigh != null && tp.entryPriceLow !== tp.entryPriceHigh
    ? `${tp.entryPriceLow}-${tp.entryPriceHigh}`
    : `${s.entry}`
  lines.push(`💰 Entry \`${entryTxt}\``)
  lines.push(`🛑 SL \`${s.stopLoss}\` *-${Math.abs(s.riskPct)}%*`)
  const t1d = tp?.target1Date ? ` by ${prettyDate(tp.target1Date)}` : ''
  const t2d = tp?.target2Date ? ` by ${prettyDate(tp.target2Date)}` : ''
  lines.push(`🎯 T1 \`${s.target1}\` *+${s.rewardPct}%*${t1d}`)
  if (s.target2 && s.target2 !== s.target1) {
    lines.push(`🚀 T2 \`${s.target2}\`${t2d}`)
  }
  if (s.target3 && s.target3 !== s.target2) {
    const t3d = tp?.target3Date ? ` by ${prettyDate(tp.target3Date)}` : ''
    lines.push(`🏁 T3 \`${s.target3}\`${t3d}`)
  }

  // Firing factors — single wrapped line, no misses shown
  if (fired.length) lines.push(`✓ ${fired.join(' · ')}`)

  // One flavour line: top reason. Append hora/cycle hint if short enough.
  const topReason = (s.reasons[0] || '').replace(/\s+/g, ' ').trim()
  const hint = (s.astroNote || s.gannNote || '').replace(/\s+/g, ' ').trim()
  const flavour = [topReason, hint].filter(Boolean).join(' · ').slice(0, 140)
  if (flavour) lines.push(`💡 ${flavour}`)

  // Stability warning — emitted by directionLedger when this signal flips
  // against a recent opposite call on the same instrument.
  if (s.stabilityNote) lines.push(`⚠️ ${s.stabilityNote}`)

  // Option leg — only if attached. Hold horizon already implied by entry/T2 dates above.
  if (tp?.optionLeg) {
    const leg = tp.optionLeg
    lines.push(`🎫 ${leg.lots} lot${leg.lots > 1 ? 's' : ''} · exp ${prettyDate(leg.expiry)}`)
  }

  // Validity + branding
  const days = daysTo(s.expiresAt)
  lines.push(`_Valid until ${prettyDate(s.expiresAt)}${days != null ? ` · ${days}d_` : '_'}`)
  lines.push(`*#tradewithvarsha*`)

  return lines.join('\n')
}

export function fmtSignalsList(signals: Signal[], title = 'Live Signals'): string {
  if (!signals.length) return `📭 *${title}*\n\n_No signals right now._`
  const top = signals.slice(0, 8)
  const lines = top.map(s =>
    `${signalStars(s)} ${dirEmoji[s.direction]} *${s.instrument}*  \`${s.entry}\` → \`${s.target1}\` _(SL \`${s.stopLoss}\`)_\n   _${s.grade} · ${s.score}/10 · RR 1:${s.riskReward} · conf ${s.confluenceCount}_`,
  )
  return `📊 *${title}* · ${signals.length}\n━━━━━━━━━━━━━━━━━━━━\n\n${lines.join('\n\n')}\n\n— *#tradewithvarsha* —`
}

export function fmtGann(g: GannBias): string {
  const cyclesLines = g.nextCycles.slice(0, 5).map(c =>
    `• ${c.name} — *${c.date}* (${c.daysAway}d, ${c.importance})`,
  ).join('\n')
  return `🔮 *Gann Analysis*

*Time Cycles* ${g.timeCycleHit ? '⚠️ HIT NOW' : ''}
${cyclesLines}

*Key Levels (Square of 9):*
Resistance: ${g.resistances.map(r => r.toFixed(0)).join(', ')}
Support:    ${g.supports.map(r => r.toFixed(0)).join(', ')}

_${g.note}_`
}

export function fmtAstro(a: AstroBias): string {
  const planets = a.planets.slice(0, 8).map(p =>
    `• ${p.planet.padEnd(7)} ${p.sign} ${p.degree.toFixed(1)}°${p.retrograde ? ' (R)' : ''} — _${p.influence}_`,
  ).join('\n')
  return `🪐 *Planetary Positions (Sidereal)*

${planets}

*Aspects:*
${a.aspects.map(x => `• ${x}`).join('\n') || '_None active_'}

*Net bias:* ${a.bullish ? '🟢 BULLISH' : a.bearish ? '🔴 BEARISH' : a.volatile ? '⚡ VOLATILE' : '⚪ NEUTRAL'} (strength ${a.strength.toFixed(2)})
_${a.note}_`
}

export function fmtTimeCycle(r: TimeCycleReport): string {
  const lines: string[] = []
  lines.push(`🔮 *${r.symbol} Time Cycle Analysis*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  lines.push(`As of *${r.asOf}*`)
  lines.push(`Dominant bias now: *${r.dominantBiasNow}*`)
  lines.push(`Nearest pivot: *${r.nearestPivotDate}* → ${r.nearestPivotBias}`)
  lines.push(``)
  lines.push(`*Active cycles (${r.positions.length}):*`)
  for (const p of r.positions.slice(0, 6)) {
    const tag = p.importance === 'HIGH' ? '🔥' : p.importance === 'MED' ? '⚡' : '·'
    const biasEmoji = p.biasNow === 'BULL' ? '🟢' : p.biasNow === 'BEAR' ? '🔴' : '🟡'
    lines.push(
      `${tag} ${biasEmoji} *${p.cycleDays}d* from ${p.fromSeedKind} (${p.fromSeedName.slice(0, 20)})`,
    )
    lines.push(
      `   Day ${p.daysInCycle}/${p.cycleDays} · ${p.phase} (${p.phasePct}%) · next hit *${p.nextHitDate}* (${p.daysToNext}d) → ${p.biasNext}`,
    )
  }
  lines.push(``)
  lines.push(`_${r.summary}_`)
  return lines.join('\n')
}

export function fmtReversalDates(r: ReversalReport): string {
  const lines: string[] = []
  lines.push(`🎯 *${r.symbol} Reversal Dates*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  lines.push(`_As of ${r.asOf} · Gann + Vedic + Mundane + Numerology_`)
  lines.push(``)
  if (!r.topPicks.length) {
    lines.push(`No high-confluence reversals in the next 60 days.`)
    return lines.join('\n')
  }
  for (const c of r.topPicks) {
    const biasTxt = c.bias === 'TOP' ? '🔴 TOP' : c.bias === 'BOTTOM' ? '🟢 BOTTOM' : '🟡 PIVOT'
    const tier = c.kind === 'HIGH' ? '🔥 HIGH' : c.kind === 'MED' ? '⚡ MED' : '· LOW'
    lines.push(`*${c.date}* (${c.daysAway}d) — ${tier} · ${biasTxt} · score ${c.score.toFixed(1)}`)
    for (const src of c.sources.slice(0, 4)) lines.push(`   • ${src}`)
    lines.push(``)
  }
  return lines.join('\n')
}

export function fmtAnalysis(r: AnalysisReport): string {
  const { resolved: s, ltp, change, changePct, signals, oi, premiumTargets, underlyingBias } = r
  const priceBlock = ltp != null
    ? `\`${ltp.toFixed(2)}\`` + (change != null ? ` (${change >= 0 ? '+' : ''}${change.toFixed(2)} / ${changePct != null ? (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%' : ''})` : '')
    : '—'

  const lines: string[] = []
  lines.push(`🔍 *${s.displayLabel}*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  lines.push(`Exchange: *${s.exchange}* · Token: \`${s.token}\``)
  if (s.lotsize) lines.push(`Lot size: *${s.lotsize}*`)
  if (s.expiry) lines.push(`Expiry: *${s.expiry}*`)
  lines.push(`LTP: ${priceBlock}`)

  if (s.kind === 'option') {
    lines.push(`Strike: *${s.strike}* · Side: *${s.side}*`)
    if (underlyingBias) lines.push(`Underlying bias: *${underlyingBias}*`)
    if (oi) lines.push(`OI: PCR *${oi.pcr.toFixed(2)}* · Max Pain *${oi.maxPain}* · ${oi.bias}`)
    if (premiumTargets) {
      lines.push(``)
      lines.push(`*Premium targets:*`)
      lines.push(`📍 Entry: \`${premiumTargets.entry}\``)
      lines.push(`🛑 SL:    \`${premiumTargets.sl}\` (-20%)`)
      lines.push(`🎯 T1:    \`${premiumTargets.t1}\` (+35%)`)
      lines.push(`🚀 T2:    \`${premiumTargets.t2}\` (+80%)`)
    }
  }

  lines.push(``)
  lines.push(`_${r.summary}_`)

  if (signals.length) {
    lines.push(``)
    lines.push(`*Actionable signals:*`)
    for (const sig of signals.slice(0, 2)) {
      lines.push(`• ${sig.direction} ${sig.instrument} — Grade ${sig.grade} · Score ${sig.score} · RR 1:${sig.riskReward}`)
    }
  }
  return lines.join('\n')
}

export function fmtBacktest(results: BacktestResult[]): string {
  const rows = results.map(r =>
    `\`${r.strategy.padEnd(28)}\` ${r.trades.toString().padStart(4)} · WR ${r.winRate}% · PF ${r.profitFactor} · DD ${r.maxDrawdownPct}%`,
  ).join('\n')
  const totalTrades = results.reduce((s, r) => s + r.trades, 0)
  const avgWR = results.length ? results.reduce((s, r) => s + r.winRate, 0) / results.length : 0
  return `📈 *Backtest Suite*

${rows}

━━━━━━━━━━━━━━━━━━
Combined: *${totalTrades}* trades · Avg WR *${avgWR.toFixed(1)}%*`
}
