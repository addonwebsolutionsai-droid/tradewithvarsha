/**
 * STAGE ANALYSIS (Weinstein-style lifecycle detector) — criterion 20.
 *
 * Algorithmic implementation. Attribution: the 4-stage framework is
 * commonly associated with Stan Weinstein's published technical-analysis
 * work; the math below is our own implementation, not a transcription.
 *
 * Stage 1 — BASING        (sideways after a downtrend, 30W MA flattening)
 * Stage 2 — ADVANCING     (price > 30W MA + 30W MA rising) ← buy zone
 * Stage 3 — TOPPING       (sideways after an uptrend, 30W MA flattening)
 * Stage 4 — DECLINING     (price < 30W MA + 30W MA falling)
 *
 * Edge: ~80% of multi-week swings happen during Stage 2. Stage 1 → 2
 * transitions are the highest-probability long entries.
 *
 * We approximate the 30-WEEK MA with a 150-day SMA (5 trading days/week).
 */
import type { Candle } from '../types'
import type { CriterionResult } from './fnoFutures12Criteria'

export type Stage = 'STAGE_1_BASE' | 'STAGE_2_ADVANCE' | 'STAGE_3_TOP' | 'STAGE_4_DECLINE' | 'UNKNOWN'

function sma(values: number[]): number {
  return values.reduce((s, x) => s + x, 0) / Math.max(1, values.length)
}

function slope(values: number[]): number {
  if (values.length < 2) return 0
  return (values[values.length - 1] - values[0]) / Math.max(1, values.length - 1)
}

export function detectStage(candles: Candle[]): { stage: Stage; detail: string } {
  if (candles.length < 160) return { stage: 'UNKNOWN', detail: `<160 bars (need ~30 weeks)` }
  const closes = candles.map(c => c.close)
  const last = closes[closes.length - 1]
  // 30-week MA ≈ 150-day SMA
  const ma30wSeries: number[] = []
  for (let i = 149; i < closes.length; i++) {
    ma30wSeries.push(sma(closes.slice(i - 149, i + 1)))
  }
  const ma30wNow = ma30wSeries[ma30wSeries.length - 1]
  const ma30wPrior = ma30wSeries[Math.max(0, ma30wSeries.length - 21)]   // 20 bars ago

  // 30-week MA slope as % of value
  const slopePct = ma30wPrior > 0 ? ((ma30wNow - ma30wPrior) / ma30wPrior) * 100 : 0
  const aboveMA = last > ma30wNow
  const rising = slopePct > 0.5            // ≥0.5% over 20 bars = clearly rising
  const falling = slopePct < -0.5
  const flat = !rising && !falling

  let stage: Stage = 'UNKNOWN'
  if (aboveMA && rising) stage = 'STAGE_2_ADVANCE'
  else if (!aboveMA && falling) stage = 'STAGE_4_DECLINE'
  else if (aboveMA && flat) stage = 'STAGE_3_TOP'
  else if (!aboveMA && flat) stage = 'STAGE_1_BASE'
  else if (aboveMA && falling) stage = 'STAGE_3_TOP'        // price still above but MA rolling — distribution
  else if (!aboveMA && rising) stage = 'STAGE_1_BASE'       // price below but MA improving — accumulation

  const detail = `${stage.replace('_', '-')} · price ${last.toFixed(1)} vs 30W-MA ${ma30wNow.toFixed(1)} (${aboveMA ? '+' : ''}${((last - ma30wNow) / ma30wNow * 100).toFixed(1)}%) · MA slope ${slopePct >= 0 ? '+' : ''}${slopePct.toFixed(2)}%`
  return { stage, detail }
}

/**
 * Criterion 20: Stage Analysis scoring.
 *   Stage 2 LONG / Stage 4 SHORT  = +10 (textbook setup)
 *   Stage 1 LONG / Stage 3 SHORT  = +6  (transition zone — early entry)
 *   Stage 3 LONG / Stage 1 SHORT  = 0  (avoid)
 *   Stage 4 LONG / Stage 2 SHORT  = -8 (counter-trend — strong penalty)
 */
export function criterion20StageAnalysis(candles: Candle[], side: 'LONG' | 'SHORT'): CriterionResult {
  const { stage, detail } = detectStage(candles)
  let score = 0, pass = false
  if (side === 'LONG') {
    if (stage === 'STAGE_2_ADVANCE') { score = 10; pass = true }
    else if (stage === 'STAGE_1_BASE') { score = 6; pass = true }
    else if (stage === 'STAGE_4_DECLINE') score = -8
  } else {
    if (stage === 'STAGE_4_DECLINE') { score = 10; pass = true }
    else if (stage === 'STAGE_3_TOP') { score = 6; pass = true }
    else if (stage === 'STAGE_2_ADVANCE') score = -8
  }
  return {
    key: 'stage_analysis',
    label: 'Stage Analysis (30W lifecycle)',
    pass,
    score,
    detail,
  }
}
