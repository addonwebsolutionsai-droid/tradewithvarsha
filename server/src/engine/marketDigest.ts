import { runSignalEngine } from './signalEngine'
import { runHarmonicScan } from './harmonicScanner'
import { getLatestPick } from './weeklyManagerPick'
import { getLatestDailyPick } from './dailyPickEngine'
import { runDailyPick } from './dailyPickEngine'
import { gradeMeetsThreshold } from './scoring'
import { config } from '../config'
import { log } from '../util/logger'
import type { Signal } from '../types'

/**
 * Pre-market (08:30 IST) and pre-close (15:20 IST) digest.
 *
 * The user complained that the engine surfaces signals AFTER moves have
 * already happened. The fix is two daily auto-scans BEFORE the action:
 *
 *   1. 08:30 IST — 45 min before NSE opens. Runs the snapshot engine,
 *      fresh harmonic scan, refreshes Daily Pick. Ships a compact
 *      Telegram digest with: "Today's high-conviction setups" — top 5
 *      by grade × score across all sources.
 *
 *   2. 15:20 IST — 10 min before NSE closes. Runs LIVE engine + harmonic.
 *      Ships an end-of-day digest with: positions to roll into tomorrow,
 *      fresh harmonic patterns that completed in the last hour, and any
 *      Daily Pick that turned during the session.
 *
 * Both digests use the same Telegram filter as broadcastSignal (NIFTY
 * options + SWING + POSITIONAL), but the digest itself is unconditional
 * — even if there are zero high-grade signals we still post a "no
 * actionable setups" summary so the user knows the engine is alive.
 */

export interface DigestSection {
  heading: string
  bullets: string[]
}

export interface MarketDigest {
  kind: 'pre-market' | 'pre-close'
  generatedAt: string
  sections: DigestSection[]
  /** Markdown-formatted full text ready to send to Telegram. */
  message: string
}

export async function runMarketDigest(kind: 'pre-market' | 'pre-close'): Promise<MarketDigest> {
  const generatedAt = new Date().toISOString()
  const sections: DigestSection[] = []

  // 1. Refresh signal engine. For pre-market we use snapshot mode so the
  //    relaxed confluence floor surfaces every name the engine has a stance
  //    on. For pre-close we use live mode.
  let live: Signal[] = []
  let snapshot: Signal[] = []
  try {
    if (kind === 'pre-market') {
      const snap = await runSignalEngine({ snapshot: true })
      snapshot = snap.signals
    } else {
      const r = await runSignalEngine()
      live = r.signals
      const s = await runSignalEngine({ snapshot: true })
      snapshot = s.signals
    }
  } catch (e) {
    log.warn('DIGEST', `engine pass failed: ${(e as Error).message}`)
  }
  const allEngineSignals = [...live, ...snapshot]

  // 2. Refresh harmonic scan in the background — short-circuit if it
  //    takes too long; the digest still goes out with the cached scan.
  let harmonicHits: Awaited<ReturnType<typeof runHarmonicScan>>['hits'] = []
  try {
    const hScan = await runHarmonicScan({ minConfidence: 65 })
    harmonicHits = hScan.hits
  } catch (e) {
    log.warn('DIGEST', `harmonic scan failed: ${(e as Error).message}`)
  }

  // 3. Refresh Daily Pick (only on pre-market — pre-close already runs it on its own cron)
  if (kind === 'pre-market') {
    try { await runDailyPick({ limit: 600, reason: 'digest-pre-market' }) }
    catch (e) { log.warn('DIGEST', `daily pick refresh failed: ${(e as Error).message}`) }
  }

  // ─── Build sections ──────────────────────────────────────────

  // (a) Top high-conviction signals — grade A/B + score >= 7
  const topSignals = allEngineSignals
    .filter(s => gradeMeetsThreshold(s.grade, 'B') && s.score >= 7)
    .filter(s => s.tier === 'LIVE' || s.tier === 'WATCH')
    .sort((a, b) => b.score - a.score || (a.grade < b.grade ? -1 : 1))
    .slice(0, 8)
  if (topSignals.length) {
    sections.push({
      heading: '🎯 *Top setups*',
      bullets: topSignals.map(s => {
        const dirEmoji = s.direction === 'BUY' ? '🟢' : '🔴'
        const tag = s.tier === 'WATCH' ? ' 👁' : ''
        return `${dirEmoji} *${s.instrument}* · ${s.grade}/${s.score} · entry \`${s.entry}\` · SL \`${s.stopLoss}\` · T1 \`${s.target1}\`${tag}`
      }),
    })
  }

  // (b) Fresh harmonic patterns (last 24h, conf ≥ 70)
  const dayAgo = Date.now() - 24 * 3600_000
  const freshHarmonics = harmonicHits
    .filter(h => h.confidence >= 70 && new Date(h.detectedAt).getTime() > dayAgo)
    .slice(0, 6)
  if (freshHarmonics.length) {
    sections.push({
      heading: '🔻 *Fresh harmonic patterns*',
      bullets: freshHarmonics.map(h => {
        const dirEmoji = h.direction === 'BULLISH' ? '🟢' : '🔴'
        return `${dirEmoji} *${h.symbol}* ${h.timeframe} · ${h.patternName} · ${h.confidence}% · entry \`${h.entry}\` · T1 \`${h.target1}\``
      }),
    })
  }

  // (c) Top 3 Daily Pick rows (BUY side only, conviction >= 70)
  try {
    const dp = getLatestDailyPick()
    if (dp?.rows.length) {
      const top = dp.rows
        .filter(r => r.direction === 'BUY' && r.conviction >= 70)
        .slice(0, 5)
      if (top.length) {
        sections.push({
          heading: '🤖 *Daily Pick (top 5 buys)*',
          bullets: top.map(r =>
            `🟢 *${r.symbol}* · conv ${r.conviction} · entry \`${r.entryPrice}\` · T1 \`${r.target1}\` (${r.target1Date.slice(5)}) · T3 \`${r.target3}\``,
          ),
        })
      }
    }
  } catch { /* daily-pick optional */ }

  // (d) Weekly watchlist names — surface if the session might trigger
  //     follow-up moves on the user's validated picks.
  try {
    const wp = await getLatestPick()
    if (wp?.rows.length) {
      const watchAlive = wp.rows
        .filter(r => r.source === 'WATCHLIST' && r.conviction >= 60)
        .slice(0, 6)
      if (watchAlive.length) {
        sections.push({
          heading: '📋 *Watchlist alive*',
          bullets: watchAlive.map(r =>
            `${r.direction === 'BUY' ? '🟢' : '🔴'} *${r.symbol}* · ${r.direction} · entry \`${r.entryPrice}\` · T1 \`${r.target1}\` · T3 \`${r.target3}\` (${r.target3Date.slice(5)})`,
          ),
        })
      }
    }
  } catch { /* weekly pick optional */ }

  // ─── Assemble Markdown message ───────────────────────────────
  const title = kind === 'pre-market'
    ? `🌅 *MORNING DIGEST · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}*\n_NSE opens 09:15 IST · Plan your day_`
    : `🌇 *PRE-CLOSE DIGEST · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}*\n_NSE closes 15:30 IST · Final 10 min_`

  const body = sections.length
    ? sections.map(s =>
        `${s.heading}\n${s.bullets.map(b => `· ${b}`).join('\n')}`,
      ).join('\n\n')
    : '_No actionable setups detected. Engine is alive — check dashboard for snapshots._'

  const message = `${title}\n\n${body}\n\n*#tradewithvarsha*`

  return { kind, generatedAt, sections, message }
}
