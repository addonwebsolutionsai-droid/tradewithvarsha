/**
 * SL Decision Engine — "act like a top-notch trader + smart investor"
 * ==================================================================
 *
 * User directive (2026-07-30):
 *   "When SL gets hunted we should know the quality, shareholding, and
 *    what FII/DII/promoters are doing. Are they increasing stakes or
 *    dumping it? What is there for the SL? Why should we not take the
 *    SL and hold it?"
 *
 * This module answers those questions on every SL touch. It produces a
 * structured verdict that the paper-book (and the /journal UI) can use
 * to make the average-in-vs-exit decision AND explain it back to the
 * user in plain English.
 *
 * Inputs it inspects:
 *   1. TECHNICAL trap-score (structural — reclaim / trend / vol / range)
 *   2. SHAREHOLDING deltas (FII / DII / promoter QoQ + pledge %)
 *   3. QUALITY floor  (market cap · pledge · P/E sanity)
 *   4. SMART-MONEY footprint (pedigree / insider / bulk / superstar / x-recs)
 *   5. HARD invalidation floor (2×ATR from original entry)
 *
 * Output verdict:
 *   { action: 'AVERAGE' | 'HOLD' | 'EXIT',
 *     confidence: 0-100,
 *     humanExplain: "…",       ← surfaced verbatim in journal UI
 *     factors: {…},            ← every input, so the trader can audit
 *     scoreBreakdown: [{name, pts, reason}] }
 *
 * Design principle: NEVER exit on a hunt when the case is fundamentally
 * intact. NEVER hold through a real break just because trap-score is
 * bullish. The hard invalidation always wins.
 */

import type { Candle } from '../types'
import { getShareholding } from '../data/shareholding'
import { log } from '../util/logger'
import fs from 'fs'
import path from 'path'

const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')

export interface SlDecisionInput {
  symbol: string
  originalEntry: number
  stopLoss: number
  hardInvalidation?: number      // 2×ATR floor — beyond this always EXIT
  isShort: boolean
  alreadyAveraged: boolean
  candles: Candle[]              // last ~30 daily candles for structural checks
  bar: Candle                    // the bar that hunted the SL
}

export interface ScoreLine {
  name: string
  pts: number                   // +/- contribution (roughly capped ±25)
  reason: string
}

export interface SlDecision {
  action: 'AVERAGE' | 'HOLD' | 'EXIT'
  confidence: number             // 0-100 — how strong the case is either way
  humanExplain: string           // multi-line, journal-ready
  factors: {
    trapScore: number
    shareholding: {
      fiiPct: number | null
      fiiDeltaQoQ: number | null
      diiPct: number | null
      diiDeltaQoQ: number | null
      promoterPct: number | null
      promoterDeltaQoQ: number | null
      promoterPledgePct: number | null
    }
    quality: {
      marketCapCr: number | null
      pe: number | null
      pledgeSafe: boolean | null
    }
    smartMoneySources: string[]        // ['PEDIGREE', 'INSIDER', ...]
    hardInvalidated: boolean
  }
  scoreBreakdown: ScoreLine[]
}

// Smart-money snapshot cache (30-min TTL, per Node process)
let smCache: { ts: number; map: Map<string, string[]> } | null = null
function loadSmartMoneyMap(): Map<string, string[]> {
  const now = Date.now()
  if (smCache && (now - smCache.ts) < 30 * 60_000) return smCache.map
  const map = new Map<string, string[]>()
  const cutoffMs = now - 15 * 24 * 3600_000
  const sources: Array<[string, string, string]> = [
    ['pedigree-accumulation.json', 'PEDIGREE',  'lastFlagDate'],
    ['insider-buys.json',          'INSIDER',   'txnDate'],
    ['bulk-deals.json',            'BULK',      'dealDate'],
    ['superstar-picks.json',       'SUPERSTAR', 'lastSeen'],
    ['x-recs.json',                'X-REC',     'timestamp'],
  ]
  for (const [file, label, dateField] of sources) {
    try {
      const raw = fs.readFileSync(path.join(SNAP_DIR, file), 'utf-8')
      const j = JSON.parse(raw)
      const rows: any[] = Array.isArray(j) ? j : (j.rows ?? j.data ?? j.recommendations ?? [])
      for (const r of rows) {
        const sym = (r.symbol ?? r.ticker ?? r.stock ?? '').toString().toUpperCase().trim()
        if (!sym) continue
        const dateStr = r[dateField] ?? r.date ?? r.generatedAt ?? j.generatedAt
        const t = dateStr ? Date.parse(dateStr) : now
        if (Number.isFinite(t) && t < cutoffMs) continue
        if (label === 'X-REC') {
          const rec = String(r.recommendation ?? r.action ?? '').toUpperCase()
          if (!rec.includes('BUY') && !rec.includes('LONG')) continue
        }
        const prior = map.get(sym) ?? []
        if (!prior.includes(label)) prior.push(label)
        map.set(sym, prior)
      }
    } catch { /* skip missing/corrupt source */ }
  }
  smCache = { ts: now, map }
  return map
}

function computeAtr(candles: Candle[]): number {
  if (!candles || candles.length < 15) return 0
  let sum = 0
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return sum / 14
}

/**
 * Compose the trap-score from structural lenses (mirror of the paper-book
 * function so this module remains independent).
 */
function computeTrapScore(input: SlDecisionInput, breakdown: ScoreLine[]): number {
  const { candles, bar, isShort, originalEntry, stopLoss } = input
  if (!candles || candles.length < 25) return 0
  let score = 0

  // 1. Wick + reclaim
  const reclaim = !isShort
    ? (bar.low <= stopLoss && bar.close > stopLoss)
    : (bar.high >= stopLoss && bar.close < stopLoss)
  if (reclaim) {
    score += 20
    breakdown.push({ name: 'Intraday reclaim', pts: 20, reason: `close ₹${bar.close.toFixed(2)} back on right side of SL ₹${stopLoss.toFixed(2)}` })
  } else {
    breakdown.push({ name: 'Intraday reclaim', pts: 0, reason: 'no reclaim — bar closed on wrong side of SL' })
  }

  // 2. Higher-TF trend intact
  const closes = candles.slice(-25).map(c => c.close)
  const k = 2 / (20 + 1)
  let ema = closes[0]
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k)
  const trendIntact = !isShort ? bar.close >= ema * 0.98 : bar.close <= ema * 1.02
  if (trendIntact) {
    score += 15
    breakdown.push({ name: '20-EMA trend', pts: 15, reason: `close ${!isShort ? '≥' : '≤'} 20-EMA ₹${ema.toFixed(2)} — trend intact` })
  } else {
    breakdown.push({ name: '20-EMA trend', pts: 0, reason: `close broke ${!isShort ? 'below' : 'above'} 20-EMA — trend fading` })
  }

  // 3. Not a panic day
  const atr = computeAtr(candles)
  const barRange = bar.high - bar.low
  if (atr > 0 && barRange <= atr * 3) {
    score += 10
    breakdown.push({ name: 'Range sanity', pts: 10, reason: `bar range ${(barRange / atr).toFixed(1)}× ATR — not a panic flush` })
  } else if (atr > 0) {
    breakdown.push({ name: 'Range sanity', pts: 0, reason: `⚠ bar range ${(barRange / atr).toFixed(1)}× ATR — panic day` })
  }

  // 4. Recent accumulation
  const last5 = candles.slice(-5)
  const closeStrong = last5.filter(c => {
    const range = c.high - c.low
    if (range <= 0) return false
    const cs = (c.close - c.low) / range
    return isShort ? cs < 0.4 : cs > 0.6
  }).length
  if (closeStrong >= 3) {
    score += 15
    breakdown.push({ name: 'Bar-close strength', pts: 15, reason: `${closeStrong}/5 recent bars close in ${isShort ? 'lower' : 'upper'} 40% — buyers defending` })
  } else {
    breakdown.push({ name: 'Bar-close strength', pts: 0, reason: `only ${closeStrong}/5 bars showed defence` })
  }

  // 5. Still within 8% of original entry
  const withinBand = !isShort ? bar.low > originalEntry * 0.92 : bar.high < originalEntry * 1.08
  if (withinBand) {
    score += 20
    breakdown.push({ name: '≤ 8% from entry', pts: 20, reason: `still within 8% of original entry ₹${originalEntry.toFixed(2)}` })
  } else {
    breakdown.push({ name: '≤ 8% from entry', pts: 0, reason: `beyond 8% from entry — case weakening` })
  }

  // 6. Volume sanity
  const v20 = candles.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20
  if (v20 > 0 && bar.volume > 0) {
    const vr = bar.volume / v20
    if (vr <= 3) {
      score += 10
      breakdown.push({ name: 'Volume sanity', pts: 10, reason: `${vr.toFixed(1)}× 20d avg — not a flush` })
    } else {
      breakdown.push({ name: 'Volume sanity', pts: 0, reason: `⚠ ${vr.toFixed(1)}× 20d — real distribution` })
    }
  }
  return score
}

/**
 * The main entry point. Given an SL touch, returns the full decision.
 */
export async function evaluateSlDecision(input: SlDecisionInput): Promise<SlDecision> {
  const breakdown: ScoreLine[] = []

  // ── 1. Hard invalidation always wins ─────────────────────────────
  const hardInvalidated = input.hardInvalidation != null && (
    input.isShort
      ? input.bar.high >= input.hardInvalidation
      : input.bar.low <= input.hardInvalidation
  )
  if (hardInvalidated) {
    breakdown.push({ name: 'Hard invalidation', pts: -100, reason: `bar breached ₹${input.hardInvalidation!.toFixed(2)} floor` })
  }

  // ── 2. Trap-score (structural) ───────────────────────────────────
  const trapScore = computeTrapScore(input, breakdown)

  // ── 3. Shareholding (institutional intent) ───────────────────────
  const shp = await getShareholding(input.symbol).catch(() => null)
  const sh = {
    fiiPct: shp?.fiiPct ?? null,
    fiiDeltaQoQ: shp?.fiiDeltaQoQ ?? null,
    diiPct: shp?.diiPct ?? null,
    diiDeltaQoQ: shp?.diiDeltaQoQ ?? null,
    promoterPct: shp?.promoterPct ?? null,
    promoterDeltaQoQ: shp?.promoterDeltaQoQ ?? null,
    promoterPledgePct: shp?.promoterPledgePct ?? null,
  }
  const q = {
    marketCapCr: shp?.marketCapCr ?? null,
    pe: shp?.pe ?? null,
    pledgeSafe: shp?.promoterPledgePct != null ? shp.promoterPledgePct < 15 : null,
  }

  // Shareholding scoring (only meaningful for LONG — inverted for SHORT)
  let shScore = 0
  if (shp) {
    const bullMult = input.isShort ? -1 : 1

    // FII: +25 for strong buying, -25 for strong selling
    if (shp.fiiDeltaQoQ != null && Math.abs(shp.fiiDeltaQoQ) > 0.3) {
      const pts = Math.min(25, Math.abs(shp.fiiDeltaQoQ) * 10) * Math.sign(shp.fiiDeltaQoQ) * bullMult
      shScore += pts
      breakdown.push({
        name: 'FII stance',
        pts: Math.round(pts),
        reason: `FII ${shp.fiiDeltaQoQ > 0 ? '↑' : '↓'} ${Math.abs(shp.fiiDeltaQoQ).toFixed(2)} pp QoQ (now ${shp.fiiPct.toFixed(1)}%) — ${shp.fiiDeltaQoQ > 0 ? 'accumulating' : 'distributing'}`,
      })
    } else if (shp.fiiPct != null) {
      breakdown.push({ name: 'FII stance', pts: 0, reason: `FII stable at ${shp.fiiPct.toFixed(1)}%` })
    }

    // Promoter: even a tiny promoter add is very meaningful
    if (shp.promoterDeltaQoQ != null && Math.abs(shp.promoterDeltaQoQ) > 0.1) {
      const pts = (shp.promoterDeltaQoQ > 0 ? 25 : -30) * bullMult
      shScore += pts
      breakdown.push({
        name: 'Promoter action',
        pts,
        reason: `Promoter ${shp.promoterDeltaQoQ > 0 ? '↑' : '↓'} ${Math.abs(shp.promoterDeltaQoQ).toFixed(2)} pp QoQ — ${shp.promoterDeltaQoQ > 0 ? 'buying own stock (very bullish)' : 'reducing stake (bearish)'}`,
      })
    } else if (shp.promoterPct != null) {
      breakdown.push({ name: 'Promoter action', pts: 0, reason: `Promoter stable at ${shp.promoterPct.toFixed(1)}%` })
    }

    // DII: +10 confirmation only
    if (shp.diiDeltaQoQ != null && Math.abs(shp.diiDeltaQoQ) > 0.5) {
      const pts = Math.sign(shp.diiDeltaQoQ) * 10 * bullMult
      shScore += pts
      breakdown.push({ name: 'DII stance', pts, reason: `DII ${shp.diiDeltaQoQ > 0 ? '↑' : '↓'} ${Math.abs(shp.diiDeltaQoQ).toFixed(2)} pp QoQ` })
    }

    // Pledge risk
    if (shp.promoterPledgePct != null && shp.promoterPledgePct > 25) {
      shScore -= 20
      breakdown.push({ name: 'Pledge risk', pts: -20, reason: `⚠ promoter pledge ${shp.promoterPledgePct.toFixed(1)}% — margin-call risk` })
    } else if (shp.promoterPledgePct != null && shp.promoterPledgePct < 5) {
      shScore += 5
      breakdown.push({ name: 'Pledge risk', pts: 5, reason: `clean books — pledge ${shp.promoterPledgePct.toFixed(1)}%` })
    }
  } else {
    breakdown.push({ name: 'Shareholding', pts: 0, reason: 'shareholding data unavailable — decision based on price + smart-money only' })
  }

  // ── 4. Smart-money footprint ─────────────────────────────────────
  const smMap = loadSmartMoneyMap()
  const smSources = input.isShort ? [] : (smMap.get(input.symbol.toUpperCase()) ?? [])
  if (smSources.length > 0) {
    const pts = Math.min(25, 10 + (smSources.length - 1) * 5)
    shScore += pts
    breakdown.push({
      name: 'Smart-money footprint',
      pts,
      reason: `flagged in last 15d by ${smSources.join(' + ')} — institutions accumulating`,
    })
  }

  // ── 5. Quality floor ─────────────────────────────────────────────
  if (shp) {
    if (q.marketCapCr != null && q.marketCapCr > 0 && q.marketCapCr < 500) {
      shScore -= 15
      breakdown.push({ name: 'Micro-cap risk', pts: -15, reason: `⚠ MC ₹${q.marketCapCr.toFixed(0)} Cr — micro-cap, wider risk` })
    } else if (q.marketCapCr != null && q.marketCapCr > 5000) {
      breakdown.push({ name: 'Quality floor', pts: 0, reason: `MC ₹${q.marketCapCr.toFixed(0)} Cr — institutional-grade` })
    }
  }

  // ── 6. Compose action ─────────────────────────────────────────────
  const totalScore = trapScore + shScore
  let action: SlDecision['action']
  let confidence: number
  let verdictLine: string

  if (hardInvalidated) {
    action = 'EXIT'
    confidence = 95
    verdictLine = `EXIT · hard invalidation floor breached at ₹${input.hardInvalidation!.toFixed(2)}. Case is broken — no averaging.`
  } else if (input.alreadyAveraged) {
    action = 'EXIT'
    confidence = 80
    verdictLine = `EXIT · already averaged once. Position is at max risk allocation; taking the SL now.`
  } else if (totalScore >= 55) {
    action = 'AVERAGE'
    confidence = Math.min(100, 50 + totalScore / 3)
    verdictLine = `AVERAGE IN · combined score ${totalScore.toFixed(0)} (trap ${trapScore} + institutional ${shScore.toFixed(0)}). Adding 50% at hunted price and widening SL to hard invalidation.`
  } else if (totalScore >= 30 || smSources.length > 0) {
    action = 'HOLD'
    confidence = 55
    verdictLine = `HOLD (partial confidence ${totalScore.toFixed(0)}). Structural case is intact enough not to panic sell, but not strong enough to add. Watching next 2 bars.`
  } else {
    action = 'EXIT'
    confidence = 70
    verdictLine = `EXIT · combined score ${totalScore.toFixed(0)}. Structural + institutional both point to a real break, not a hunt.`
  }

  // ── 7. Build human explanation ───────────────────────────────────
  const explainLines: string[] = [verdictLine, '']
  explainLines.push(`Symbol · ${input.symbol}   Bar · ₹${input.bar.low.toFixed(2)}–${input.bar.high.toFixed(2)}   SL · ₹${input.stopLoss.toFixed(2)}`)
  if (shp) {
    explainLines.push(
      `Shareholding · FII ${shp.fiiPct.toFixed(1)}% (${shp.fiiDeltaQoQ >= 0 ? '+' : ''}${shp.fiiDeltaQoQ.toFixed(2)} QoQ)` +
      ` · DII ${shp.diiPct.toFixed(1)}% (${shp.diiDeltaQoQ >= 0 ? '+' : ''}${shp.diiDeltaQoQ.toFixed(2)})` +
      ` · Promoter ${shp.promoterPct.toFixed(1)}% (${shp.promoterDeltaQoQ >= 0 ? '+' : ''}${shp.promoterDeltaQoQ.toFixed(2)})` +
      ` · Pledge ${shp.promoterPledgePct.toFixed(1)}%`
    )
    if (q.marketCapCr != null && q.marketCapCr > 0) {
      explainLines.push(`Quality · MC ₹${q.marketCapCr.toFixed(0)} Cr · P/E ${(q.pe ?? 0) > 0 ? (q.pe ?? 0).toFixed(1) : '—'}`)
    }
  }
  if (smSources.length > 0) {
    explainLines.push(`Smart-money · flagged in last 15d by ${smSources.join(' + ')}`)
  }
  explainLines.push('')
  explainLines.push('Score breakdown:')
  for (const b of breakdown) {
    const sign = b.pts > 0 ? '+' : ''
    explainLines.push(`  ${sign}${b.pts.toFixed(0).padStart(4)}  ${b.name}  —  ${b.reason}`)
  }

  const decision: SlDecision = {
    action,
    confidence: Math.round(confidence),
    humanExplain: explainLines.join('\n'),
    factors: {
      trapScore,
      shareholding: sh,
      quality: q,
      smartMoneySources: smSources,
      hardInvalidated,
    },
    scoreBreakdown: breakdown,
  }

  log.info('SL-DECISION', `${input.symbol}: ${action} · trap=${trapScore} sh=${shScore.toFixed(0)} total=${totalScore.toFixed(0)}`)
  return decision
}
