import type { Candle } from '../types'

/**
 * Harmonic pattern detector — Bat / Gartley / Butterfly / Crab / Cypher.
 *
 * Each pattern is a 5-pivot structure (X → A → B → C → D) where the Fib
 * ratios between legs match a specific recipe. When point D forms inside
 * its Potential Reversal Zone (PRZ), the pattern projects a high-probability
 * reversal AGAINST the XA→D direction.
 *
 * Bullish pattern (X high, A low, B high, C low, D low) → BUY at D
 * Bearish pattern (X low, A high, B low, C high, D high) → SELL at D
 *
 * References: Scott M. Carney's "Harmonic Trading" + standard Fib tolerances.
 *
 * Algorithm:
 *   1. Find ZigZag swing pivots (≥ minSwingPct deviation, default 1.5 %).
 *   2. Take the last 5 alternating pivots (XABCD).
 *   3. Compute the four Fib ratios (B/XA, C/AB, BC projection, D/XA).
 *   4. Match against each pattern's tolerance bands.
 *   5. Return the strongest match (highest confidence score).
 */

export type HarmonicName = 'BAT' | 'GARTLEY' | 'BUTTERFLY' | 'CRAB' | 'CYPHER' | 'SHARK' | 'ABCD'
export type HarmonicDirection = 'BULLISH' | 'BEARISH'

export interface Pivot {
  index: number
  time: number          // unix ms
  price: number
  kind: 'HIGH' | 'LOW'
}

export interface HarmonicPattern {
  name: HarmonicName
  direction: HarmonicDirection      // BULLISH = expect price up from D · BEARISH = expect price down
  X: Pivot; A: Pivot; B: Pivot; C: Pivot; D: Pivot
  ratios: {
    B_over_XA: number             // B retracement of XA leg
    C_over_AB: number             // C retracement of AB leg
    D_over_XA: number             // D retracement/extension of XA leg
    BCProjection: number          // BC projection at D
  }
  prz: { low: number; high: number }   // tolerance band around D for entry
  targets: { t1: number; t2: number; sl: number }
  confidence: number               // 0-100 (how tightly the ratios match the spec)
  completedAt: number              // unix ms (D candle time)
  ageBars: number                  // how many bars since D formed (less = more relevant)
}

// ─── ZigZag pivot detector ────────────────────────────────────

export function findZigZagPivots(candles: Candle[], minSwingPct = 1.5): Pivot[] {
  if (candles.length < 5) return []
  const pivots: Pivot[] = []
  let lastPivotIdx = 0
  let trend: 'UP' | 'DOWN' | null = null
  let extreme = candles[0].close

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    if (trend === null) {
      const upDiff = (c.high - extreme) / extreme * 100
      const dnDiff = (extreme - c.low) / extreme * 100
      if (upDiff >= minSwingPct) { trend = 'UP'; pivots.push({ index: lastPivotIdx, time: candles[lastPivotIdx].time, price: candles[lastPivotIdx].low, kind: 'LOW' }); extreme = c.high; lastPivotIdx = i }
      else if (dnDiff >= minSwingPct) { trend = 'DOWN'; pivots.push({ index: lastPivotIdx, time: candles[lastPivotIdx].time, price: candles[lastPivotIdx].high, kind: 'HIGH' }); extreme = c.low; lastPivotIdx = i }
      continue
    }
    if (trend === 'UP') {
      if (c.high > extreme) { extreme = c.high; lastPivotIdx = i }
      const dropPct = (extreme - c.low) / extreme * 100
      if (dropPct >= minSwingPct) {
        pivots.push({ index: lastPivotIdx, time: candles[lastPivotIdx].time, price: extreme, kind: 'HIGH' })
        trend = 'DOWN'; extreme = c.low; lastPivotIdx = i
      }
    } else {
      if (c.low < extreme) { extreme = c.low; lastPivotIdx = i }
      const risePct = (c.high - extreme) / extreme * 100
      if (risePct >= minSwingPct) {
        pivots.push({ index: lastPivotIdx, time: candles[lastPivotIdx].time, price: extreme, kind: 'LOW' })
        trend = 'UP'; extreme = c.high; lastPivotIdx = i
      }
    }
  }
  // Add the final extreme as a tentative pivot
  if (lastPivotIdx > 0 && pivots[pivots.length - 1]?.index !== lastPivotIdx) {
    pivots.push({
      index: lastPivotIdx,
      time: candles[lastPivotIdx].time,
      price: extreme,
      kind: trend === 'UP' ? 'HIGH' : 'LOW',
    })
  }
  return pivots
}

// ─── Pattern recipes ──────────────────────────────────────────

interface PatternSpec {
  name: HarmonicName
  B_over_XA: [number, number]      // tolerance band
  C_over_AB: [number, number]
  D_over_XA: [number, number]
  BCProjection: [number, number]
}

// Ratios verified against Scott M. Carney's "Harmonic Trading" + the
// Trading Strategy Guides "Ultimate Harmonic Pattern" PDF (2026-04-28).
const SPECS: PatternSpec[] = [
  // Bat: B = 0.382-0.50 of XA · C = 0.382-0.886 of AB · D = 0.886 of XA · BC projection 1.618-2.618
  { name: 'BAT',       B_over_XA: [0.382, 0.50], C_over_AB: [0.382, 0.886], D_over_XA: [0.85, 0.92],   BCProjection: [1.618, 2.618] },
  // Gartley: B = 0.618 of XA (tight) · C = 0.382-0.886 of AB · D = 0.786 of XA · BC projection 1.272-1.618
  { name: 'GARTLEY',   B_over_XA: [0.59, 0.65], C_over_AB: [0.382, 0.886], D_over_XA: [0.76, 0.82],   BCProjection: [1.272, 1.618] },
  // Butterfly: B = 0.786 of XA · C = 0.382-0.886 of AB · D = 1.272-1.618 of XA · BC projection 1.618-2.618
  { name: 'BUTTERFLY', B_over_XA: [0.76, 0.82], C_over_AB: [0.382, 0.886], D_over_XA: [1.27, 1.65],   BCProjection: [1.618, 2.618] },
  // Crab: B = 0.382-0.618 of XA · C = 0.382-0.886 of AB · D = 1.618 of XA · BC projection 2.24-3.618
  { name: 'CRAB',      B_over_XA: [0.382, 0.618],C_over_AB: [0.382, 0.886], D_over_XA: [1.55, 1.72],   BCProjection: [2.24, 3.618] },
  // Cypher: B = 0.382-0.618 of XA · C = 1.272-1.414 of XA (extends past A — measured vs XA, not AB!) · D = 0.786 of XC
  // Note: for Cypher we treat `C_over_AB` as C-projection-over-XA (handled by detector).
  { name: 'CYPHER',    B_over_XA: [0.382, 0.618],C_over_AB: [1.272, 1.414], D_over_XA: [0.74, 0.84],   BCProjection: [1.13, 2.0] },
]

function inBand(v: number, [lo, hi]: [number, number]): boolean { return v >= lo && v <= hi }

/** How tightly the ratio sits in the band — used for confidence score. */
function bandFit(v: number, [lo, hi]: [number, number]): number {
  if (v < lo || v > hi) return 0
  const center = (lo + hi) / 2
  const halfWidth = (hi - lo) / 2 || 1
  return Math.max(0, 1 - Math.abs(v - center) / halfWidth)
}

// ─── Main detection ───────────────────────────────────────────

export function detectHarmonic(candles: Candle[], opts?: { minSwingPct?: number; maxAgeBars?: number }): HarmonicPattern | null {
  if (candles.length < 30) return null
  const minSwingPct = opts?.minSwingPct ?? 1.5
  const maxAgeBars = opts?.maxAgeBars ?? 10
  const pivots = findZigZagPivots(candles, minSwingPct)
  if (pivots.length < 5) return null

  // Try every 5-pivot window from the most recent backwards (latest first)
  const candidates: HarmonicPattern[] = []
  const lastIdx = candles.length - 1
  for (let i = pivots.length - 5; i >= 0; i--) {
    const X = pivots[i], A = pivots[i + 1], B = pivots[i + 2], C = pivots[i + 3], D = pivots[i + 4]
    // Pivots must alternate kind
    if (X.kind === A.kind || A.kind === B.kind || B.kind === C.kind || C.kind === D.kind) continue
    // Determine direction — bearish pattern: X low, A high, ... D high (selling at D)
    const direction: HarmonicDirection = D.kind === 'HIGH' ? 'BEARISH' : 'BULLISH'

    const XA = Math.abs(A.price - X.price)
    const AB = Math.abs(B.price - A.price)
    const BC = Math.abs(C.price - B.price)
    const CD = Math.abs(D.price - C.price)
    const XD = Math.abs(D.price - X.price)
    if (!XA || !AB || !BC) continue

    // Cypher uses C-projection-over-XA (C extends past A); all others use C-over-AB.
    const ratios = {
      B_over_XA: AB / XA,
      C_over_AB: BC / AB,
      D_over_XA: XD / XA,
      BCProjection: CD / BC,
    }
    const cypherCRatio = Math.abs(C.price - X.price) / XA   // |XC| / |XA|

    for (const spec of SPECS) {
      const fitB  = bandFit(ratios.B_over_XA, spec.B_over_XA)
      const fitC  = spec.name === 'CYPHER'
        ? bandFit(cypherCRatio, spec.C_over_AB)         // for Cypher this band is C/XA
        : bandFit(ratios.C_over_AB, spec.C_over_AB)
      const fitD  = bandFit(ratios.D_over_XA, spec.D_over_XA)
      const fitBC = bandFit(ratios.BCProjection, spec.BCProjection)
      if (fitD === 0 || fitB === 0) continue       // hard fails on B and D
      if (fitC === 0) continue
      const confidence = Math.round((fitB * 0.20 + fitC * 0.15 + fitD * 0.45 + fitBC * 0.20) * 100)
      if (confidence < 50) continue

      // PRZ — tolerance ±0.5 % around D
      const prz = { low: D.price * 0.995, high: D.price * 1.005 }
      // Targets (Carney conventions)
      const xaSize = XA
      const sl = direction === 'BEARISH'
        ? D.price + xaSize * 0.10           // 10 % of XA above D
        : D.price - xaSize * 0.10
      const t1 = direction === 'BEARISH' ? D.price - (D.price - C.price) * 0.382 : D.price + (C.price - D.price) * 0.382
      const t2 = direction === 'BEARISH' ? D.price - (D.price - C.price) * 0.618 : D.price + (C.price - D.price) * 0.618

      const ageBars = lastIdx - D.index
      if (ageBars > maxAgeBars) continue        // too old to be actionable

      candidates.push({
        name: spec.name,
        direction,
        X, A, B, C, D,
        ratios,
        prz,
        targets: { t1: +t1.toFixed(2), t2: +t2.toFixed(2), sl: +sl.toFixed(2) },
        confidence,
        completedAt: D.time,
        ageBars,
      })
    }
  }

  // SHARK pattern — 5-point O,X,A,B,C structure (no D; C is the entry).
  // Per Carney + the PDF:
  //   AB = 1.13-1.618 of XA (B extends past X)
  //   BC = 1.618-2.24 of AB
  //   |OC| / |OX| ≈ 0.886-1.13 (C closes near 1.13 extension of OX) — entry zone
  // Entry: at C with target at 50 % retracement of BC and stop at 1.15 × XA.
  for (let i = pivots.length - 5; i >= 0; i--) {
    const O = pivots[i], X = pivots[i + 1], A = pivots[i + 2], B = pivots[i + 3], C = pivots[i + 4]
    if (O.kind === X.kind || X.kind === A.kind || A.kind === B.kind || B.kind === C.kind) continue
    const direction: HarmonicDirection = C.kind === 'HIGH' ? 'BEARISH' : 'BULLISH'
    const OX = Math.abs(X.price - O.price)
    const XA_s = Math.abs(A.price - X.price)
    const AB_s = Math.abs(B.price - A.price)
    const BC_s = Math.abs(C.price - B.price)
    const OC = Math.abs(C.price - O.price)
    if (!OX || !XA_s || !AB_s || !BC_s) continue

    const ab_xa = AB_s / XA_s
    const bc_ab = BC_s / AB_s
    const oc_ox = OC / OX
    const fitAB = bandFit(ab_xa, [1.13, 1.618])
    const fitBC = bandFit(bc_ab, [1.618, 2.24])
    const fitOC = bandFit(oc_ox, [0.886, 1.15])
    if (!fitAB || !fitBC || !fitOC) continue
    const confidence = Math.round((fitAB * 0.30 + fitBC * 0.30 + fitOC * 0.40) * 100)
    if (confidence < 60) continue

    const ageBars = lastIdx - C.index
    if (ageBars > maxAgeBars) continue

    // Targets: T1 = 50% retrace of BC, T2 = retest of B; SL = 15 % of XA past C.
    const t1 = direction === 'BEARISH'
      ? C.price - (C.price - B.price) * 0.50
      : C.price + (B.price - C.price) * 0.50
    const t2 = direction === 'BEARISH'
      ? B.price + (C.price - B.price) * 0.05
      : B.price - (B.price - C.price) * 0.05
    const sl = direction === 'BEARISH'
      ? C.price + XA_s * 0.15
      : C.price - XA_s * 0.15

    candidates.push({
      name: 'SHARK',
      direction,
      // We don't have a true D in the Shark; reuse C as both C and D so the
      // shape of HarmonicPattern stays uniform for downstream consumers.
      X: O, A: X, B: A, C: B, D: C,
      ratios: {
        B_over_XA: ab_xa,
        C_over_AB: bc_ab,
        D_over_XA: oc_ox,
        BCProjection: bc_ab,
      },
      prz: { low: C.price * 0.995, high: C.price * 1.005 },
      targets: { t1: +t1.toFixed(2), t2: +t2.toFixed(2), sl: +sl.toFixed(2) },
      confidence,
      completedAt: C.time,
      ageBars,
    })
  }

  if (!candidates.length) return null
  // Return the freshest pattern with highest confidence
  candidates.sort((a, b) => (b.confidence - a.confidence) || (a.ageBars - b.ageBars))
  return candidates[0]
}

/**
 * Detect ALL valid harmonic patterns (all five XABCD shapes + Shark) on a
 * candle series, not just the best one. Used by the multi-TF scanner so
 * every candidate that satisfies its Fibonacci recipe surfaces, sorted by
 * confidence × freshness.
 */
export function detectAllHarmonics(
  candles: Candle[],
  opts?: { minSwingPct?: number; maxAgeBars?: number; minConfidence?: number },
): HarmonicPattern[] {
  const minConfidence = opts?.minConfidence ?? 60
  const out: HarmonicPattern[] = []
  const seen = new Set<string>()
  // Try a sequence of swing thresholds — captures both micro and macro patterns.
  for (const swing of [opts?.minSwingPct ?? 0.6, 1.0, 1.5, 2.5]) {
    const p = detectHarmonic(candles, { minSwingPct: swing, maxAgeBars: opts?.maxAgeBars ?? 12 })
    if (!p || p.confidence < minConfidence) continue
    const k = `${p.name}|${p.direction}|${p.D.index}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out.sort((a, b) => (b.confidence - a.confidence) || (a.ageBars - b.ageBars))
}
