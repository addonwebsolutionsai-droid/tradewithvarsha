/**
 * Miss Digest → Telegram · daily post-EOD card.
 *
 * Reads today's fresh miss-analysis + gainer-postmortem snapshots and
 * distills them into an actionable card:
 *
 *   🔬 Miss Report · 18 Jul (Sat)
 *   ━━━━━━━━━━━━━━━━━━
 *   Caught: 12 of 23 gainers (52%)
 *   Would have caught with rule tune: 6 more → 78% projected
 *
 *   Top 5 misses (5-20% today):
 *     SHARDUL +20.0% · pattern wyckoff · missed: not_in_universe
 *     NBIFIN  +18.4% · pattern breakout  · missed: rule_fired_but_not_emitted
 *     ...
 *
 *   Miss reasons: not_in_universe (30) · conviction_floor (50) ·
 *                 vol_too_low (22) · prebreakout ret5d>6% (20)
 *
 *   Suggested tune: relax ret5d cap 6% → 7% (would catch 15 more/mo)
 *
 *   *#tradewithvarsha*
 *
 * Never throws — if snapshots aren't present, sends nothing.
 */

import path from 'path'
import fs from 'fs/promises'
import { log } from '../util/logger'
import { config } from '../config'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

interface MissRow {
  symbol: string
  gainPct: number
  caught: boolean
  diagnosis: string[]
}
interface PostmortemRow {
  symbol: string
  gainPct: number
  caughtTodayByOurTabs: boolean
  wouldHaveFiredDaysAgo: number | null
  patternDetected: string
  missReason: string
  recommendation: string
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as T } catch { return null }
}

function isRealSymbol(s: string): boolean {
  return typeof s === 'string' && s.length >= 3 && s.length <= 15 && /^[A-Z][A-Z0-9&-]+$/.test(s)
}

/**
 * Turn the raw diagnosis-count map into a short list of actionable tune
 * suggestions. Threshold hints are conservative — never suggest relaxing
 * a rule by more than 20% of its current value in a single step.
 */
function suggestTunes(diagnoses: Record<string, number>): string[] {
  const out: string[] = []
  const top = Object.entries(diagnoses).sort((a, b) => b[1] - a[1])
  for (const [reason, count] of top) {
    if (count < 3) continue
    if (reason === 'prebreakout_ret5d>6%') out.push(`Relax ret5d cap 6% → 7% (would catch ${count} more this window)`)
    else if (reason === 'prebreakout_ret20d>25%') out.push(`Relax ret20d cap 25% → 28% (would catch ${count} more)`)
    else if (reason === 'vol_too_low') out.push(`Consider vol dry-up requirement — currently rejecting ${count} legit low-vol coils`)
    else if (reason === 'not_in_universe') out.push(`Expand universe past NIFTY-500 core (${count} misses were outside)`)
    else if (reason === 'conviction_floor') out.push(`${count} misses passed all filters but no engine flagged them — audit conviction floor`)
    else if (reason === 'rule_fired_but_not_emitted') out.push(`${count} names WOULD have fired but got dropped downstream — check dedup / lifecycle emission floor`)
    if (out.length >= 3) break
  }
  return out
}

export async function sendMissDigest(): Promise<{ ok: boolean; sent: number; card?: string }> {
  const token = config.bots.telegramToken
  const chats = config.bots.telegramChatIds
  if (!token || chats.length === 0) return { ok: false, sent: 0 }

  const miss = await readJson<{
    totalGainers: number; caughtCount: number; catchRate: number;
    rows: MissRow[]; diagnoses: Record<string, number>
  }>(path.join(SNAP_DIR, 'miss-analysis.json'))
  const pm = await readJson<{
    totalGainers: number; caughtCount: number; wouldHaveCaughtCount: number;
    rows: PostmortemRow[]; topMissReasons: Record<string, number>;
    patternBreakdown: Record<string, number>
  }>(path.join(SNAP_DIR, 'gainer-postmortem.json'))

  if (!miss && !pm) {
    log.info('MISS-DIGEST', 'no snapshots yet — skipping')
    return { ok: false, sent: 0 }
  }

  const today = new Date().toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', weekday: 'short', timeZone: 'Asia/Kolkata',
  })
  const catchPct = miss ? Math.round(miss.catchRate * 100) : 0
  const projPct = pm && pm.totalGainers > 0
    ? Math.round(((pm.caughtCount + (pm.wouldHaveCaughtCount - pm.caughtCount)) / pm.totalGainers) * 100)
    : catchPct
  const extraWithTune = pm ? Math.max(0, pm.wouldHaveCaughtCount - pm.caughtCount) : 0

  const cleanMisses = (miss?.rows ?? [])
    .filter(r => !r.caught && isRealSymbol(r.symbol) && r.gainPct >= 5 && r.gainPct <= 20)
    .sort((a, b) => b.gainPct - a.gainPct)
    .slice(0, 5)

  const lines: string[] = []
  lines.push(`🔬 *Miss Report · ${today}*`)
  lines.push('━━━━━━━━━━━━━━━━━━')
  if (miss) {
    lines.push(`Caught: *${miss.caughtCount}* of ${miss.totalGainers} gainers 5%+ · *${catchPct}%*`)
  }
  if (pm && extraWithTune > 0) {
    lines.push(`With rule tune: +${extraWithTune} more → *${projPct}%* projected`)
  }

  if (cleanMisses.length > 0) {
    lines.push('')
    lines.push('*Top misses (5-20% today):*')
    for (const r of cleanMisses) {
      const pmRow = pm?.rows.find(p => p.symbol.toUpperCase() === r.symbol.toUpperCase())
      const pattern = pmRow?.patternDetected ?? '—'
      const reason = (r.diagnosis[0] ?? pmRow?.missReason ?? 'unknown').slice(0, 45)
      lines.push(`  ${r.symbol} +${r.gainPct.toFixed(1)}% · ${pattern} · ${reason}`)
    }
  }

  if (miss && Object.keys(miss.diagnoses).length > 0) {
    const topReasons = Object.entries(miss.diagnoses).sort((a, b) => b[1] - a[1]).slice(0, 4)
    lines.push('')
    lines.push(`*Miss reasons:* ${topReasons.map(([k, v]) => `${k.replace(/_/g, ' ')} (${v})`).join(' · ')}`)
  }

  const tunes = suggestTunes(miss?.diagnoses ?? pm?.topMissReasons ?? {})
  if (tunes.length > 0) {
    lines.push('')
    lines.push('*Suggested tunes:*')
    for (const t of tunes) lines.push(`  → ${t}`)
  }

  if (pm && Object.keys(pm.patternBreakdown).length > 0) {
    const top = Object.entries(pm.patternBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 3)
    lines.push('')
    lines.push(`*Pattern breakdown:* ${top.map(([k, v]) => `${k} (${v})`).join(' · ')}`)
  }

  lines.push('')
  lines.push('*#tradewithvarsha*')
  const card = lines.join('\n')

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
      log.warn('MISS-DIGEST', `send failed: ${(e as Error).message}`)
    }
  }
  log.ok('MISS-DIGEST', `sent to ${sent}/${chats.length} chats · catch ${catchPct}% · misses ${cleanMisses.length}`)
  return { ok: sent > 0, sent, card }
}
