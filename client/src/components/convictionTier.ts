import type { Signal } from '../types'

/**
 * Star conviction rating — surfaced on every signal in the UI and in
 * Telegram alerts. Rules:
 *
 *   5★  grade A + score ≥ 8            (take this trade)
 *   3★  grade A (score < 8)  OR  grade B
 *   2★  grade C or below (includes WATCH snapshots)
 *
 * Exposed as three input-shaped factories because different tabs carry
 * different source data (full Signal vs. 0–100 conviction vs. screener tier).
 */
export type StarRating = 2 | 3 | 5

export function starsForSignal(s: {
  grade: Signal['grade']
  score: number
  confluenceCount?: number
  tier?: Signal['tier']
}): StarRating {
  if (s.tier === 'WATCH') return 2
  if (s.grade === 'A' && s.score >= 8) return 5
  if (s.grade === 'A' || s.grade === 'B') return 3
  return 2
}

/** Daily-Pick / Weekly-Pick use a 0–100 conviction score. */
export function starsForScore(score: number): StarRating {
  if (score >= 80) return 5
  if (score >= 60) return 3
  return 2
}

/** Screener rows carry an A/B/C tier plus a 0–10 score. */
export function starsForScreener(tier: 'A' | 'B' | 'C', score: number): StarRating {
  if (tier === 'A' && score >= 8) return 5
  if (tier === 'A' || tier === 'B') return 3
  return 2
}

/** Plain-text star glyph sequence — used by the Telegram formatter. */
export function renderStars(n: StarRating): string {
  return '⭐'.repeat(n)
}

/** Tailwind colour for the star glyph inside the UI. */
export function starColor(n: StarRating): string {
  return n === 5 ? 'text-accent-amber' : n === 3 ? 'text-accent-cyan' : 'text-neutral-500'
}

// ─── Sort comparators — always "best first" ─────────────────────────────
// All three functions sort descending by star rating, then by the
// appropriate secondary key (score / conviction / tier) so ties break
// predictably.

export function bySignalQuality<T extends { grade: Signal['grade']; score: number; confluenceCount: number; tier?: Signal['tier'] }>(a: T, b: T): number {
  const sa = starsForSignal(a), sb = starsForSignal(b)
  if (sa !== sb) return sb - sa
  return (b.score || 0) - (a.score || 0)
}

export function byScoreQuality<T extends { conviction: number }>(a: T, b: T): number {
  const sa = starsForScore(a.conviction), sb = starsForScore(b.conviction)
  if (sa !== sb) return sb - sa
  return b.conviction - a.conviction
}

export function byScreenerQuality<T extends { tier: 'A' | 'B' | 'C'; score: number }>(a: T, b: T): number {
  const sa = starsForScreener(a.tier, a.score), sb = starsForScreener(b.tier, b.score)
  if (sa !== sb) return sb - sa
  return (b.score || 0) - (a.score || 0)
}
