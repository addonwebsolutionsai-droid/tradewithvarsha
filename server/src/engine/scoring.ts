import type { Confluence, ConfluenceKey, Grade } from '../types'

/**
 * Confluence scoring — calibrated for a 0–10 displayed score.
 *
 * Weights raised in 2026-04 so a typical "good" setup (4–5 strong factors
 * aligned) reads 7–8, and a top-tier "all-stars-aligned" setup (7+ factors)
 * reads 9–10. Below 4 factors → 3–5 (noise, correctly filtered out).
 *
 * New factors (2026-04):
 *   - `flow`: FII + DII flow matches the signal direction (daily feed)
 *   - `fundamentals`: EPS growth ≥ 20 % + promoter pledge < 10 % + no major
 *     red flag (from Screener.in fundamentals cache — see
 *     engine/fundamentals.ts). Only fires when data is present; otherwise
 *     the factor is simply absent, not a red flag.
 *
 * The score is the SUM of weights for factors that fired, capped at 10.
 * A factor only "fires" (contributes) when the strategy's boolean flag is
 * explicitly set to true; missing data is silent, not penalised.
 */
export const CONFLUENCE_WEIGHTS: Record<ConfluenceKey, number> = {
  smc:          2.0,   // highest-edge — institutional footprint
  gann:         1.75,
  trend:        1.75,  // raised — EMA stack is a strong indicator
  pattern:      1.5,
  volume:       1.5,
  vwap:         1.5,
  rsi:          1.25,
  flow:         1.5,   // NEW — FII/DII net flow confirms direction
  fundamentals: 2.0,   // NEW — EPS growth + low pledge + stable promoter
  oi:           1.25,
  astro:        1.0,
  supertrend:   1.0,
}

/** Compute the raw weighted score + the count of factors that fired. */
export function scoreConfluence(c: Confluence): { score: number; count: number } {
  let score = 0
  let count = 0
  for (const key of Object.keys(c) as ConfluenceKey[]) {
    if (c[key]) {
      score += CONFLUENCE_WEIGHTS[key] ?? 0
      count++
    }
  }
  // Cap at 10 so the displayed score stays in a 0-10 scale. A really strong
  // setup with 8-9 factors firing will sum to 12-14 — cap surfaces as 10.
  const capped = Math.min(10, score)
  return { score: +capped.toFixed(2), count }
}

/**
 * Grade thresholds shifted up with the new weighting so grading matches what
 * the user expects from the 0-10 display scale.
 *
 *   A (high conviction): score ≥ 8   — 5+ strong factors aligned
 *   B (good setup):      score ≥ 6   — 4 factors aligned
 *   C (watchlist):       score ≥ 4   — 3 factors aligned
 *   D (discard):         < 4         — not enough confluence
 */
export function gradeFromScore(score: number): Grade {
  if (score >= 8) return 'A'
  if (score >= 6) return 'B'
  if (score >= 4) return 'C'
  return 'D'
}

export function gradeMeetsThreshold(grade: Grade, min: Grade): boolean {
  const order: Grade[] = ['A', 'B', 'C', 'D']
  return order.indexOf(grade) <= order.indexOf(min)
}
