/**
 * buildUnifiedReason — schema-consistent reason renderer.
 *
 * User directive 2026-07-18: unify the "reason" / "why" column across every
 * tab. Same 5 sections, same order, same atom vocabulary.
 *
 * §1 · IDENTITY      — tier badge + setup name(s) + superstar tag
 * §2 · SHAREHOLDING  — FII · DII · P · Pledge · MC (fixed order)
 * §3 · POSITION      — % off 52w-hi + % off 20d high + MA context + universe
 * §4 · TRIGGER       — vol × · RSI + qualifier · momentum · EMA stack · deliv %
 *                      + one tab-specific slot (pattern specs / wave count /
 *                      PRZ / VP setup / insider ₹Cr / etc.)
 * §5 · OUTLOOK       — historical rhyme · expected % · R:R · target logic
 *
 * ROLLBACK
 * ────────
 * This module is a PURE FUNCTION with no side effects — importing it is free.
 * Enrichment is gated by config.features.unifiedReasonEnabled (default OFF).
 * To disable: set UNIFIED_REASON_ENABLED=false (or omit) in env → the
 * enrichment step is skipped, snapshots stay in their pre-2026-07-18 shape,
 * UI falls back to the existing `reasons` / `reasoning` field. To fully
 * remove: `git revert` the shipping commit.
 */

// ─── Public schema ─────────────────────────────────────────────────────

export type ReasonTier =
  | 'NO_BRAINER'
  | 'ELITE'
  | 'STRONG_INSIDER'
  | 'PEDIGREE'
  | 'SUPERSTAR_HELD'
  | 'WATCHLIST'
  | 'RHYMES'
  | 'WATCH_OUT'

/** Every atom the engine can pass in; every atom is optional. */
export interface ReasonInput {
  // §1 — identity
  tier?: ReasonTier
  tierCriteriaMet?: number            // e.g. 15 (out of tierCriteriaTotal)
  tierCriteriaTotal?: number          // e.g. 24
  setups?: string[]                   // e.g. ['Cup & Handle', 'VP VA-Rotation']
  superstarHeld?: string[]            // e.g. ['Sugar King', 'Kacholia']

  // §2 — shareholding
  fiiPct?: number
  fiiDeltaQoQpp?: number              // percentage-point QoQ change
  diiPct?: number
  diiDeltaQoQpp?: number
  promoterPct?: number
  promoterDeltaQoQpp?: number
  pledgePct?: number
  marketCapCr?: number

  // §3 — position
  pctOff52wHi?: number                // positive number, we render "45% off"
  pctOff20dHi?: number
  vsMA?: string                       // 'above 200-DMA' | 'below 50-DMA' | ...
  universe?: string                   // 'NIFTY-500' | 'F&O' | 'Small-cap' | ...
  sectorLabel?: string
  sectorTrend?: string                // 'STRONG' | 'IMPROVING' | 'NEUTRAL' | ...

  // §4 — trigger
  volRatio20d?: number
  volRatio60d?: number
  rsi14?: number
  rsiQualifier?: string               // 'coiled' | 'overbought' | 'oversold' | 'bounce' | ...
  ret5dPct?: number
  ret20dPct?: number
  emaStack?: 'BULL' | 'BEAR' | 'MIXED'
  deliveryPct?: number
  atrMultiple?: number
  tabSpecific?: string                // free-form, tab-specific atom (e.g. "Cup 81-bar depth 15%")

  // §5 — outlook
  historicalRhyme?: {
    symbol: string
    retPct: number
    date: string                      // YYYY-MM-DD
    similarityPct: number
  }
  expectedReturnPct?: number
  horizonDays?: number
  rrRatio?: number                    // e.g. 2.5 → renders as "R:R 1:2.5"
  targetLogic?: string                // e.g. "rim + cup depth" | "Fib 1.272 ext"
}

export interface UnifiedReason {
  s1_identity: string
  s2_shareholding: string
  s3_position: string
  s4_trigger: string
  s5_outlook: string
  /** §1 + §4 joined — for compact one-line table cells */
  collapsed: string
  /** All 5 sections joined by newlines — for expanded views */
  expanded: string
}

// ─── Atom formatters ───────────────────────────────────────────────────

const ARROW_UP = '↑'
const ARROW_DN = '↓'
const ARROW_FLAT = '→'

function fmtPct(n: number, opts?: { forceSign?: boolean; digits?: number }): string {
  if (!Number.isFinite(n)) return ''
  const d = opts?.digits ?? 1
  const abs = Math.abs(n)
  const sign = opts?.forceSign
    ? (n > 0 ? '+' : n < 0 ? '−' : '')
    : (n < 0 ? '−' : '')
  const rounded = abs.toFixed(d)
  return `${sign}${rounded}%`
}

function fmtDelta(n: number | undefined, unit = 'pp'): string {
  if (n == null || !Number.isFinite(n) || n === 0) return ARROW_FLAT
  const arrow = n > 0 ? ARROW_UP : ARROW_DN
  return `${arrow}${Math.abs(n).toFixed(2)}${unit}`
}

function fmtMarketCap(cr: number): string {
  if (!Number.isFinite(cr)) return ''
  if (cr >= 100_000) return `₹${(cr / 100_000).toFixed(1)}LCr`
  if (cr >= 1_000) return `₹${(cr / 1_000).toFixed(1)}KCr`
  return `₹${Math.round(cr)}Cr`
}

function fmtRatio(x: number): string {
  return `${x.toFixed(1)}×`
}

function tierBadge(tier: ReasonTier): string {
  switch (tier) {
    case 'NO_BRAINER':      return '⭐ NO-BRAINER'
    case 'ELITE':           return '🎯 ELITE'
    case 'STRONG_INSIDER':  return '🔥 STRONG INSIDER'
    case 'PEDIGREE':        return '💎 PEDIGREE'
    case 'SUPERSTAR_HELD':  return '🌟 SUPERSTAR-HELD'
    case 'WATCHLIST':       return '🟡 WATCHLIST'
    case 'RHYMES':          return '🔬 RHYMES'
    case 'WATCH_OUT':       return '⚠ WATCH-OUT'
  }
}

// ─── Section builders ──────────────────────────────────────────────────

function joinAtoms(atoms: Array<string | undefined | null | false>): string {
  return atoms.filter((a): a is string => typeof a === 'string' && a.length > 0).join(' · ')
}

function buildS1(inp: ReasonInput): string {
  const atoms: Array<string | undefined> = []
  if (inp.tier) {
    let badge = tierBadge(inp.tier)
    if (typeof inp.tierCriteriaMet === 'number' && typeof inp.tierCriteriaTotal === 'number') {
      badge += ` (${inp.tierCriteriaMet}/${inp.tierCriteriaTotal})`
    }
    atoms.push(badge)
  }
  if (inp.setups && inp.setups.length > 0) atoms.push(inp.setups.join(', '))
  if (inp.superstarHeld && inp.superstarHeld.length > 0) {
    atoms.push(`🌟 held by ${inp.superstarHeld.join(', ')}`)
  }
  return joinAtoms(atoms)
}

function buildS2(inp: ReasonInput): string {
  if (
    inp.fiiPct == null && inp.diiPct == null && inp.promoterPct == null
    && inp.pledgePct == null && inp.marketCapCr == null
  ) return ''
  const atoms: string[] = []
  if (inp.fiiPct != null) atoms.push(`FII ${inp.fiiPct.toFixed(1)}% ${fmtDelta(inp.fiiDeltaQoQpp)}`)
  if (inp.diiPct != null) atoms.push(`DII ${inp.diiPct.toFixed(1)}% ${fmtDelta(inp.diiDeltaQoQpp)}`)
  if (inp.promoterPct != null) atoms.push(`P ${inp.promoterPct.toFixed(1)}% ${fmtDelta(inp.promoterDeltaQoQpp)}`)
  if (inp.pledgePct != null) atoms.push(`Pledge ${inp.pledgePct.toFixed(1)}%`)
  if (inp.marketCapCr != null) atoms.push(`MC ${fmtMarketCap(inp.marketCapCr)}`)
  return atoms.join(' · ')
}

function buildS3(inp: ReasonInput): string {
  const atoms: Array<string | undefined> = []
  if (inp.pctOff52wHi != null) atoms.push(`${inp.pctOff52wHi.toFixed(0)}% off 52w-hi`)
  if (inp.pctOff20dHi != null) atoms.push(`${inp.pctOff20dHi.toFixed(1)}% off 20d high`)
  if (inp.vsMA) atoms.push(inp.vsMA)
  if (inp.universe) atoms.push(inp.universe)
  if (inp.sectorLabel && inp.sectorTrend) atoms.push(`${inp.sectorLabel} ${inp.sectorTrend}`)
  else if (inp.sectorLabel) atoms.push(inp.sectorLabel)
  return joinAtoms(atoms)
}

function buildS4(inp: ReasonInput): string {
  const atoms: Array<string | undefined> = []
  if (inp.volRatio60d != null) atoms.push(`vol ${fmtRatio(inp.volRatio60d)} 60d`)
  else if (inp.volRatio20d != null) atoms.push(`vol ${fmtRatio(inp.volRatio20d)} 20d`)
  if (inp.rsi14 != null) {
    atoms.push(inp.rsiQualifier ? `RSI ${Math.round(inp.rsi14)} ${inp.rsiQualifier}` : `RSI ${Math.round(inp.rsi14)}`)
  }
  if (inp.ret5dPct != null) atoms.push(`5d ${fmtPct(inp.ret5dPct, { forceSign: true })}`)
  else if (inp.ret20dPct != null) atoms.push(`20d ${fmtPct(inp.ret20dPct, { forceSign: true })}`)
  if (inp.emaStack === 'BULL') atoms.push('EMA 9>21>50')
  else if (inp.emaStack === 'BEAR') atoms.push('EMA 9<21<50')
  if (inp.atrMultiple != null) atoms.push(`ATR ${fmtRatio(inp.atrMultiple)}`)
  if (inp.deliveryPct != null && inp.deliveryPct >= 60) {
    atoms.push(`deliv ${Math.round(inp.deliveryPct)}% institutional`)
  }
  if (inp.tabSpecific) atoms.push(inp.tabSpecific)
  return joinAtoms(atoms)
}

function buildS5(inp: ReasonInput): string {
  const atoms: Array<string | undefined> = []
  if (inp.historicalRhyme) {
    const h = inp.historicalRhyme
    atoms.push(`🔬 Rhymes ${h.symbol} ${fmtPct(h.retPct, { forceSign: true })} (${h.date}) sim ${Math.round(h.similarityPct)}%`)
  }
  if (inp.expectedReturnPct != null && inp.horizonDays != null) {
    atoms.push(`exp ${fmtPct(inp.expectedReturnPct, { forceSign: true })} in ${inp.horizonDays}d`)
  } else if (inp.expectedReturnPct != null) {
    atoms.push(`exp ${fmtPct(inp.expectedReturnPct, { forceSign: true })}`)
  }
  if (inp.rrRatio != null) atoms.push(`R:R 1:${inp.rrRatio.toFixed(2)}`)
  if (inp.targetLogic) atoms.push(`target ${inp.targetLogic}`)
  return joinAtoms(atoms)
}

// ─── The public function ───────────────────────────────────────────────

/**
 * Turn a structured ReasonInput into a UnifiedReason with all five sections.
 * Pure — no I/O, no throws (returns empty strings for missing sections).
 *
 * Consumers:
 *   - Server-side enrichment step attaches result to snapshot rows
 *     (guarded by config.features.unifiedReasonEnabled).
 *   - Client-side render prefers `unifiedReason.collapsed` when present,
 *     falls back to legacy `reasons`/`reasoning` when not.
 */
export function buildUnifiedReason(input: ReasonInput): UnifiedReason {
  const s1 = buildS1(input)
  const s2 = buildS2(input)
  const s3 = buildS3(input)
  const s4 = buildS4(input)
  const s5 = buildS5(input)
  const s1Prefix = s1 ? `📌 ${s1}` : ''
  const s2Prefix = s2 ? `📊 ${s2}` : ''
  const s3Prefix = s3 ? `📍 ${s3}` : ''
  const s4Prefix = s4 ? `⚡ ${s4}` : ''
  const s5Prefix = s5 ? `🔮 ${s5}` : ''
  const collapsedParts = [s1, s4].filter(Boolean)
  const collapsed = collapsedParts.join(' · ')
  const expanded = [s1Prefix, s2Prefix, s3Prefix, s4Prefix, s5Prefix].filter(Boolean).join('\n')
  return {
    s1_identity: s1,
    s2_shareholding: s2,
    s3_position: s3,
    s4_trigger: s4,
    s5_outlook: s5,
    collapsed,
    expanded,
  }
}

// ─── Rsi qualifier helper ──────────────────────────────────────────────

/**
 * Turn an RSI number into the small qualifier we append after it:
 *   ≤30 oversold · 30-40 bounce · 40-60 → no qualifier · 60-70 coiled ·
 *   ≥70 overbought
 * Consumers pass this to ReasonInput.rsiQualifier.
 */
export function rsiQualifier(rsi: number): string | undefined {
  if (!Number.isFinite(rsi)) return undefined
  if (rsi <= 30) return 'oversold'
  if (rsi <= 40) return 'bounce'
  if (rsi >= 70) return 'overbought'
  if (rsi >= 60) return 'coiled'
  return undefined
}
