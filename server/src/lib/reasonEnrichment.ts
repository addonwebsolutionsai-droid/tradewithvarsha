/**
 * reasonEnrichment — attaches a UnifiedReason to snapshot rows.
 *
 * Called from publishPublicSnapshots BEFORE writing JSON to disk, and only
 * when config.features.unifiedReasonEnabled is true. Every enrichment path
 * is defensive — missing fields drop atoms silently, never throw.
 *
 * ROLLBACK
 * ────────
 * Set UNIFIED_REASON_ENABLED=false (or remove the env var) → this function
 * is never called, snapshots stay in their prior shape, UI falls back to
 * existing `reasons` / `reasoning`.
 */

import { config } from '../config'
import { buildUnifiedReason, rsiQualifier, type ReasonInput, type UnifiedReason } from './unifiedReason'

/** Return the enriched row (or the row unchanged when the flag is off). */
export function enrichRow<T extends Record<string, unknown>>(
  row: T,
  tab: 'elite' | 'insider' | 'chartPattern' | 'pedigree' | 'earlyMomentum' | 'proEdge' | 'weeklyPick' | 'niftyOutlook' | 'volumeProfile' | 'stockFnoVp',
): T & { unifiedReason?: UnifiedReason } {
  if (!config.features.unifiedReasonEnabled) return row
  try {
    const input = mapRowToReasonInput(row, tab)
    const unified = buildUnifiedReason(input)
    // Only attach if at least one section produced content — otherwise it's
    // noise. Downstream renderers fall back to legacy fields.
    if (!unified.s1_identity && !unified.s4_trigger && !unified.s2_shareholding) return row
    return { ...row, unifiedReason: unified }
  } catch {
    // Never let enrichment failure break a snapshot publish.
    return row
  }
}

/** Bulk-enrich an array (no-op when the flag is off). */
export function enrichRows<T extends Record<string, unknown>>(
  rows: T[] | undefined,
  tab: Parameters<typeof enrichRow>[1],
): T[] {
  if (!Array.isArray(rows)) return []
  if (!config.features.unifiedReasonEnabled) return rows
  return rows.map(r => enrichRow(r, tab))
}

// ─── Per-tab row → ReasonInput mapping ─────────────────────────────────

function mapRowToReasonInput(
  row: Record<string, unknown>,
  tab: Parameters<typeof enrichRow>[1],
): ReasonInput {
  const commonShareholding: Partial<ReasonInput> = {
    fiiPct: numOrUndef(row.fiiPct ?? row.fii),
    fiiDeltaQoQpp: numOrUndef(row.fiiDeltaQoQ),
    diiPct: numOrUndef(row.diiPct ?? row.dii),
    diiDeltaQoQpp: numOrUndef(row.diiDeltaQoQ),
    promoterPct: numOrUndef(row.promoterPct ?? row.promoter),
    promoterDeltaQoQpp: numOrUndef(row.promoterDeltaQoQ),
    pledgePct: numOrUndef(row.pledgePct ?? row.pledge),
    marketCapCr: numOrUndef(row.marketCapCr ?? row.mcCr ?? row.mc),
  }
  const commonPosition: Partial<ReasonInput> = {
    pctOff52wHi: numOrUndef(row.pctOffHigh52w ?? row.pctOffHigh ?? row.pctOff52wHi),
    pctOff20dHi: numOrUndef(row.pctOff20dHi),
    universe: strOrUndef(row.universe),
    sectorLabel: strOrUndef(row.sectorLabel),
    sectorTrend: strOrUndef(row.sectorTrend),
  }
  const commonTrigger: Partial<ReasonInput> = {
    volRatio20d: numOrUndef(row.volRatio20d),
    volRatio60d: numOrUndef(row.volRatio60d),
    rsi14: numOrUndef(row.rsi14 ?? row.rsi),
    rsiQualifier: (() => {
      const r = numOrUndef(row.rsi14 ?? row.rsi)
      return r != null ? rsiQualifier(r) : undefined
    })(),
    ret5dPct: numOrUndef(row.ret5d ?? row.ret5dPct),
    ret20dPct: numOrUndef(row.ret20d ?? row.ret20dPct),
    deliveryPct: numOrUndef(row.deliveryPct ?? row.deliv),
    atrMultiple: numOrUndef(row.atrMultiple),
  }

  switch (tab) {
    case 'elite': {
      const sources = strArr(row.sources)
      const isDouble = sources.length >= 2
      return {
        ...commonShareholding,
        ...commonPosition,
        ...commonTrigger,
        tier: isDouble ? 'ELITE' : undefined,
        setups: sources.map(prettySourceName),
        superstarHeld: strArr(row.superstarHeld),
        expectedReturnPct: computeExpectedReturn(row),
        horizonDays: numOrUndef(row.horizonDays),
        rrRatio: computeRR(row),
      }
    }
    case 'insider': {
      const promoterCr = numOrUndef(row.promoterNetBuyCr)
      const kmpCr = numOrUndef(row.kmpNetBuyCr)
      const sastCr = numOrUndef(row.externalAcquirerBuyCr)
      const totalCr = numOrUndef(row.totalNetBuyCr)
      const parts: string[] = []
      if (promoterCr != null && promoterCr > 0) parts.push(`Promoter net ₹${promoterCr.toFixed(1)} Cr`)
      if (kmpCr != null && kmpCr > 0) parts.push(`KMP ₹${kmpCr.toFixed(1)} Cr`)
      if (sastCr != null && sastCr > 0) parts.push(`SAST ₹${sastCr.toFixed(1)} Cr`)
      if (totalCr != null && totalCr > 0) parts.push(`Total ₹${totalCr.toFixed(1)} Cr`)
      const isStrong = row.signal === 'STRONG_INSIDER_BUY' || (promoterCr != null && promoterCr >= 5)
      return {
        ...commonShareholding,
        ...commonPosition,
        ...commonTrigger,
        tier: isStrong ? 'STRONG_INSIDER' : undefined,
        setups: ['Insider filing'],
        tabSpecific: parts.length > 0 ? parts.join(' + ') : undefined,
        expectedReturnPct: numOrUndef(row.expectedReturnPct),
        horizonDays: numOrUndef(row.horizonDays),
      }
    }
    case 'chartPattern': {
      const patternName = strOrUndef(row.pattern) ?? strOrUndef(row.patternName)
      const setups: string[] = []
      if (patternName) setups.push(patternName)
      return {
        ...commonShareholding,
        ...commonPosition,
        ...commonTrigger,
        setups,
        tabSpecific: strOrUndef(row.patternDetail),
        expectedReturnPct: computeExpectedReturn(row),
        horizonDays: numOrUndef(row.horizonDays),
        rrRatio: computeRR(row),
        targetLogic: strOrUndef(row.targetLogic),
      }
    }
    case 'pedigree': {
      return {
        ...commonShareholding,
        ...commonPosition,
        ...commonTrigger,
        tier: 'PEDIGREE',
        setups: ['Institutional accumulation'],
        expectedReturnPct: numOrUndef(row.expectedReturnPct),
        horizonDays: numOrUndef(row.horizonDays),
      }
    }
    case 'earlyMomentum': {
      const tierName = strOrUndef(row.tier)
      return {
        ...commonShareholding,
        ...commonPosition,
        ...commonTrigger,
        tier: tierName === 'ELITE' ? 'ELITE' : undefined,
        setups: ['Early Momentum'],
        expectedReturnPct: computeExpectedReturn(row),
        horizonDays: numOrUndef(row.horizonDays),
        rrRatio: computeRR(row),
      }
    }
    case 'proEdge': {
      const sources = strArr(row.sources)
      const conv = numOrUndef(row.conviction) ?? 0
      return {
        ...commonShareholding,
        ...commonPosition,
        ...commonTrigger,
        tier: conv >= 95 ? 'NO_BRAINER' : 'ELITE',
        setups: sources.map(prettySourceName),
        expectedReturnPct: computeExpectedReturn(row),
        horizonDays: numOrUndef(row.horizonDays),
        rrRatio: computeRR(row),
      }
    }
    case 'weeklyPick': {
      return {
        ...commonShareholding,
        ...commonPosition,
        ...commonTrigger,
        setups: ['Weekly Pick'],
        expectedReturnPct: computeExpectedReturn(row),
        horizonDays: numOrUndef(row.horizonDays) ?? 20,
        rrRatio: computeRR(row),
      }
    }
    case 'niftyOutlook': {
      const direction = strOrUndef(row.direction)
      return {
        setups: ['NIFTY Composite', direction ? `bias ${direction}` : ''].filter(Boolean),
        tabSpecific: strOrUndef(row.playbookNote),
        expectedReturnPct: computeExpectedReturn(row),
        horizonDays: numOrUndef(row.horizonDays),
        rrRatio: computeRR(row),
      }
    }
    case 'volumeProfile': {
      const setup = strOrUndef(row.setup) ?? strOrUndef(row.bestSetup)
      return {
        ...commonShareholding,
        ...commonPosition,
        ...commonTrigger,
        setups: setup ? [setup] : ['Volume Profile'],
        tabSpecific: strOrUndef(row.vpDetail),
        expectedReturnPct: computeExpectedReturn(row),
        horizonDays: numOrUndef(row.horizonDays),
        rrRatio: computeRR(row),
      }
    }
    case 'stockFnoVp': {
      const setup = strOrUndef(row.bestSetup) ?? strOrUndef(row.setup)
      const tfs = numOrUndef(row.agreementScore)
      return {
        ...commonShareholding,
        ...commonPosition,
        ...commonTrigger,
        setups: setup ? [setup] : ['Volume Profile'],
        tabSpecific: tfs != null ? `agreement ${tfs}/3 TFs` : undefined,
        expectedReturnPct: computeExpectedReturn(row),
        horizonDays: numOrUndef(row.horizonDays),
        rrRatio: computeRR(row),
      }
    }
  }
}

// ─── Small helpers ─────────────────────────────────────────────────────

function numOrUndef(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return v
}
function strOrUndef(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined
  return v
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
}

function prettySourceName(src: string): string {
  switch (src) {
    case 'WEEKLY':          return 'Weekly Pick'
    case 'DAILY':           return 'Daily Pick'
    case 'PREMOVE':         return 'Pre-Move'
    case 'PEDIGREE':        return 'Pedigree'
    case 'INSIDER_BUYS':    return 'Insider'
    case 'FNO_FUTURES':     return 'F&O Futures'
    case 'CROSS_CONFLUENCE':return 'Cross-Confluence'
    case 'HARMONIC':        return 'Harmonic'
    case 'FIB':             return 'Fibonacci'
    case 'CHART_PATTERNS':  return 'Chart Patterns'
    case 'EARLY_MOMENTUM':  return 'Early Momentum'
    case 'BULK_DEALS':      return 'Bulk Deals'
    case 'SUPERSTAR':       return 'Superstar'
    default:                return src
  }
}

/** entry vs target1 → expected % move. Returns undefined if impossible. */
function computeExpectedReturn(row: Record<string, unknown>): number | undefined {
  const entry = numOrUndef(row.entry)
  const t1 = numOrUndef(row.target1)
  const dir = strOrUndef(row.direction)
  if (entry == null || t1 == null || entry <= 0) return undefined
  const move = dir === 'SHORT' || dir === 'SELL'
    ? ((entry - t1) / entry) * 100
    : ((t1 - entry) / entry) * 100
  return Number.isFinite(move) ? Math.round(move * 10) / 10 : undefined
}

/** R:R from entry / SL / T1. */
function computeRR(row: Record<string, unknown>): number | undefined {
  const entry = numOrUndef(row.entry)
  const sl = numOrUndef(row.stopLoss ?? row.sl)
  const t1 = numOrUndef(row.target1 ?? row.t1)
  if (entry == null || sl == null || t1 == null) return undefined
  const risk = Math.abs(entry - sl)
  const reward = Math.abs(t1 - entry)
  if (risk === 0) return undefined
  return Math.round((reward / risk) * 100) / 100
}
