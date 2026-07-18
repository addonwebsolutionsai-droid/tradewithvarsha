/**
 * Daily performance summary → Telegram.
 *
 * Fires at EOD (post-market). Reads lifecycle store + accuracy snapshot and
 * sends a compact card summarising the day's outcomes. Same format every
 * day so the user can scan quickly:
 *
 *   📊 Desk EOD · 18 Jul (Sat)
 *   ━━━━━━━━━━━━━━━━━━
 *   Signals fired today: 8 new · 3 elite · 2 NIFTY options
 *   Outcomes: 4 T1 · 1 T2 · 0 T3 · 2 SL · 1 still open
 *   Net day R: +2.3R (per-trade avg +0.29R)
 *   30d WR: 78.1% ↑0.4 vs prior 30d
 *
 *   Top winners: TITAN +2.1R · GODREJIND +1.4R · DLF +1.2R
 *   Top losers:  TCS −0.5R · IRCTC −0.5R
 *
 *   Sources firing most: Elite (4) · Chart Patterns (3) · Insider Buys (1)
 *
 * Never throws; if any snapshot is missing, just omits that section.
 */

import path from 'path'
import fs from 'fs/promises'
import { log } from '../util/logger'
import { config } from '../config'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')
const LIFECYCLE_FILE = path.resolve(__dirname, '../../data/signal-lifecycle.json')

interface LifecycleEntry {
  status: string
  source: string
  symbol: string
  direction: string
  entryPrice?: number
  hitPrice?: number
  stopLoss?: number
  triggeredAt?: string
  hitAt?: string
  statusChangedAt?: string
  firstSeenAt?: string
}

function istDateOnly(ms: number): string {
  const d = new Date(ms + 5.5 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

async function loadStore(): Promise<Record<string, LifecycleEntry>> {
  try {
    const raw = await fs.readFile(LIFECYCLE_FILE, 'utf8')
    return (JSON.parse(raw) as { entries: Record<string, LifecycleEntry> }).entries ?? {}
  } catch { return {} }
}

async function loadAccuracy(): Promise<{ winRate?: number; total?: number; bySource?: Record<string, { winRate?: number; total?: number }> }> {
  try {
    const raw = await fs.readFile(path.join(SNAP_DIR, 'accuracy.json'), 'utf8')
    return JSON.parse(raw)
  } catch { return {} }
}

function rMultiple(e: LifecycleEntry): number | null {
  const entry = e.entryPrice
  const hit = e.hitPrice
  const sl = e.stopLoss
  if (entry == null || hit == null || sl == null) return null
  const risk = Math.abs(entry - sl)
  if (risk <= 0) return null
  const move = e.direction === 'BUY' ? hit - entry : entry - hit
  return move / risk
}

export interface DailyPerformance {
  date: string
  newSignals: number
  eliteSignals: number
  niftyOptionSignals: number
  t1Hits: number
  t2Hits: number
  t3Hits: number
  slHits: number
  stillOpen: number
  netR: number
  avgR: number
  wr30d: number
  wr30dDelta: number
  topWinners: Array<{ symbol: string; r: number }>
  topLosers: Array<{ symbol: string; r: number }>
  sourcesToday: Record<string, number>
}

export async function computeDailyPerformance(): Promise<DailyPerformance> {
  const store = await loadStore()
  const acc = await loadAccuracy()
  const todayIst = istDateOnly(Date.now())

  const entries = Object.values(store)

  const isToday = (iso: string | undefined): boolean =>
    typeof iso === 'string' && istDateOnly(Date.parse(iso)) === todayIst

  // Signals fired today = firstSeenAt in today.
  const firedToday = entries.filter(e => isToday(e.firstSeenAt))
  const eliteFired = firedToday.filter(e => (e.source === 'PRO_EDGE' || e.source === 'CROSS_CONFLUENCE' || e.source === 'ELITE'))
  const niftyOptionsFired = firedToday.filter(e => /^NIFTY.*(CE|PE)/.test(e.symbol ?? ''))

  // Outcomes resolved today.
  const resolvedToday = entries.filter(e => isToday(e.hitAt ?? e.statusChangedAt))
  const t1Hits = resolvedToday.filter(e => e.status === 'T1_HIT')
  const t2Hits = resolvedToday.filter(e => e.status === 'T2_HIT')
  const t3Hits = resolvedToday.filter(e => e.status === 'T3_HIT')
  const slHits = resolvedToday.filter(e => e.status === 'SL_HIT')
  const stillOpen = entries.filter(e => e.status === 'ACTIVE').length

  const rs = [...t1Hits, ...t2Hits, ...t3Hits, ...slHits]
    .map(e => ({ e, r: rMultiple(e) }))
    .filter((x): x is { e: LifecycleEntry; r: number } => x.r != null)
  const netR = rs.reduce((s, x) => s + x.r, 0)
  const avgR = rs.length > 0 ? netR / rs.length : 0

  const winners = [...rs].filter(x => x.r > 0).sort((a, b) => b.r - a.r).slice(0, 3)
  const losers = [...rs].filter(x => x.r < 0).sort((a, b) => a.r - b.r).slice(0, 3)

  const sourcesToday: Record<string, number> = {}
  for (const e of firedToday) sourcesToday[e.source] = (sourcesToday[e.source] ?? 0) + 1

  const wr30d = (acc.winRate ?? 0) * 100 > 100 ? (acc.winRate ?? 0) : (acc.winRate ?? 0) * 100
  // We can't compute delta without prior snapshot; leave as 0 for now.
  const wr30dDelta = 0

  return {
    date: todayIst,
    newSignals: firedToday.length,
    eliteSignals: eliteFired.length,
    niftyOptionSignals: niftyOptionsFired.length,
    t1Hits: t1Hits.length,
    t2Hits: t2Hits.length,
    t3Hits: t3Hits.length,
    slHits: slHits.length,
    stillOpen,
    netR: Math.round(netR * 100) / 100,
    avgR: Math.round(avgR * 100) / 100,
    wr30d: Math.round(wr30d * 10) / 10,
    wr30dDelta,
    topWinners: winners.map(w => ({ symbol: w.e.symbol, r: Math.round(w.r * 10) / 10 })),
    topLosers: losers.map(l => ({ symbol: l.e.symbol, r: Math.round(l.r * 10) / 10 })),
    sourcesToday,
  }
}

/** Format the daily card in Telegram-compatible Markdown. */
export function formatDailyCard(p: DailyPerformance): string {
  const dayName = new Date(p.date).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'Asia/Kolkata' })
  const netSign = p.netR >= 0 ? '+' : ''
  const avgSign = p.avgR >= 0 ? '+' : ''
  const lines: string[] = []
  lines.push(`📊 *Desk EOD · ${p.date} (${dayName})*`)
  lines.push('━━━━━━━━━━━━━━━━━━')
  lines.push(`Signals today: *${p.newSignals}* new · ${p.eliteSignals} elite · ${p.niftyOptionSignals} NIFTY options`)
  lines.push(`Outcomes: ${p.t1Hits} T1 · ${p.t2Hits} T2 · ${p.t3Hits} T3 · *${p.slHits} SL* · ${p.stillOpen} open`)
  if (p.newSignals > 0 || p.t1Hits + p.t2Hits + p.t3Hits + p.slHits > 0) {
    lines.push(`Net day R: *${netSign}${p.netR.toFixed(2)}R* (avg ${avgSign}${p.avgR.toFixed(2)}R/trade)`)
  }
  if (p.wr30d > 0) lines.push(`30d WR: *${p.wr30d.toFixed(1)}%*`)

  if (p.topWinners.length > 0) {
    lines.push('')
    lines.push(`*Top winners:* ${p.topWinners.map(w => `${w.symbol} +${w.r.toFixed(1)}R`).join(' · ')}`)
  }
  if (p.topLosers.length > 0) {
    lines.push(`*Top losers:*  ${p.topLosers.map(l => `${l.symbol} ${l.r.toFixed(1)}R`).join(' · ')}`)
  }

  const topSources = Object.entries(p.sourcesToday).sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (topSources.length > 0) {
    lines.push('')
    lines.push(`Sources today: ${topSources.map(([k, v]) => `${k} (${v})`).join(' · ')}`)
  }

  lines.push('')
  lines.push('*#tradewithvarsha*')
  return lines.join('\n')
}

export async function sendDailyPerformanceSummary(): Promise<{ ok: boolean; sent: number; card?: string }> {
  const token = config.bots.telegramToken
  const chats = config.bots.telegramChatIds
  if (!token || chats.length === 0) {
    log.warn('DAILY-SUMMARY', 'no telegram credentials')
    return { ok: false, sent: 0 }
  }
  const perf = await computeDailyPerformance()
  const card = formatDailyCard(perf)
  let sent = 0
  for (const chatId of chats) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: card, parse_mode: 'Markdown' }),
      })
      if (res.ok) sent++
    } catch (e) {
      log.warn('DAILY-SUMMARY', `send failed: ${(e as Error).message}`)
    }
  }
  log.ok('DAILY-SUMMARY', `sent to ${sent}/${chats.length} chats`)
  return { ok: sent > 0, sent, card }
}
