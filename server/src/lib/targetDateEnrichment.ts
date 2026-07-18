/**
 * targetDateEnrichment — attaches computed T1/T2/T3/SL dates to snapshot
 * rows. Called from every runAndPublish* path (guarded by
 * config.features.targetDatesEnabled).
 *
 * The estimator is pure; this bridge extracts inputs from whatever fields
 * each engine's row shape actually carries. Missing atoms drop silently.
 * Never throws — a bad row is returned unchanged.
 *
 * Rollback = set TARGET_DATES_ENABLED=false in env.
 */

import { config } from '../config'
import { estimateTargetDates, type TargetDateInput, type TargetDatesOut } from './targetDateEstimator'

export type DateTab =
  | 'elite' | 'proEdge' | 'insider' | 'pedigree' | 'earlyMomentum'
  | 'chartPattern' | 'weeklyPick' | 'niftyOutlook' | 'volumeProfile'
  | 'stockFnoVp'

export function enrichRowDates<T extends Record<string, unknown>>(row: T, tab: DateTab): T {
  if (!config.features.targetDatesEnabled) return row
  try {
    const input = mapRowToDateInput(row, tab)
    if (!input) return row
    const dates = estimateTargetDates(input)
    // Attach as top-level fields — matches shape UI already expects.
    return {
      ...row,
      entryDate: dates.entryDate,
      target1Date: dates.target1Date,
      target2Date: dates.target2Date,
      target3Date: dates.target3Date,
      slDate: dates.slDate,
      targetDateMeta: {
        sessionsToT1: dates.sessionsToT1,
        sessionsToT2: dates.sessionsToT2,
        sessionsToT3: dates.sessionsToT3,
        speedFactor: dates.speedFactorUsed,
        atrPct: dates.atrPctUsed,
        confidence: dates.confidence,
        method: dates.method,
      } as unknown,
    }
  } catch {
    return row
  }
}

export function enrichRowsDates<T extends Record<string, unknown>>(rows: T[] | undefined, tab: DateTab): T[] {
  if (!Array.isArray(rows)) return []
  if (!config.features.targetDatesEnabled) return rows
  return rows.map(r => enrichRowDates(r, tab))
}

// ─── Row → estimator input mapping ─────────────────────────────────────

function mapRowToDateInput(row: Record<string, unknown>, tab: DateTab): TargetDateInput | null {
  const entry = numOrNaN(row.entry ?? row.entryPrice)
  const target1 = numOrNaN(row.target1 ?? row.t1)
  const target2 = numOrNaN(row.target2 ?? row.t2)
  const target3 = numOrNaN(row.target3 ?? row.t3)
  const stopLoss = numOrNaN(row.stopLoss ?? row.sl)
  if (!Number.isFinite(entry) || !Number.isFinite(target1)) return null

  const direction = String(row.direction ?? 'BUY') as TargetDateInput['direction']
  const symbol = strOrUndef(row.symbol ?? row.instrument)
  const pattern = strOrUndef(row.pattern ?? row.patternName ?? row.bestSetup ?? row.setup)
  const ret5d = numOrUndef(row.ret5d ?? row.ret5dPct)
  const ret20d = numOrUndef(row.ret20d ?? row.ret20dPct)
  const atr14 = numOrUndef(row.atr14 ?? row.atr)
  let atrPct = numOrUndef(row.atrPctOfPrice)

  // 2026-07-18 · If no ATR was provided by the engine, infer it from the
  // SL distance — traders typically set SL at ~1.75× ATR. This lifts most
  // rows from LOW-confidence defaults to MEDIUM with a plausible ATR.
  if (atrPct == null && atr14 == null && Number.isFinite(stopLoss) && stopLoss > 0 && Number.isFinite(entry) && entry > 0 && stopLoss !== entry) {
    const slDistPct = (Math.abs(entry - stopLoss) / entry) * 100
    if (slDistPct > 0.3 && slDistPct < 25) atrPct = slDistPct / 1.75
  }

  // Tab-specific tuning of the pattern hint.
  let effectivePattern = pattern
  if (!effectivePattern) {
    switch (tab) {
      case 'insider':        effectivePattern = 'insider filing accumulation'; break
      case 'pedigree':       effectivePattern = 'wyckoff accumulation'; break
      case 'earlyMomentum':  effectivePattern = 'momentum thrust'; break
      case 'weeklyPick':     effectivePattern = 'swing base'; break
      case 'chartPattern':   /* uses row.pattern */ break
      case 'volumeProfile':
      case 'stockFnoVp':     effectivePattern = 'va_rotation'; break
      case 'niftyOutlook':   effectivePattern = 'breakout'; break
    }
  }

  return {
    entry,
    stopLoss: Number.isFinite(stopLoss) ? stopLoss : entry * 0.95,
    target1,
    target2: Number.isFinite(target2) ? target2 : target1,
    target3: Number.isFinite(target3) ? target3 : target1,
    direction,
    entryDate: strOrUndef(row.entryDate),
    atr14,
    atrPctOfPrice: atrPct,
    ret5dPct: ret5d,
    ret20dPct: ret20d,
    pattern: effectivePattern,
    isOption: typeof symbol === 'string' && /\s(CE|PE)\b/i.test(symbol),
    symbol,
  }
}

function numOrNaN(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return NaN
}
function numOrUndef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return undefined
}
function strOrUndef(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v
  return undefined
}

export type { TargetDatesOut }
