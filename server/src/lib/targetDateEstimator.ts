/**
 * targetDateEstimator — computes WHEN T1/T2/T3 are likely to hit.
 *
 * Model
 * ─────
 * We treat each target as a distance measured in ATR-days.
 *
 *   distancePct       = |target - entry| / entry × 100
 *   dailyMovePct      = atrPctOfPrice (fallback 2.5 if unknown)
 *   speedFactor       = pattern/momentum/direction-aware multiplier
 *   sessionsToTarget  = distancePct / (dailyMovePct × speedFactor)
 *
 * Speed factor components (all ≥ 0.5 and ≤ 1.6):
 *   1.  Pattern factor — how fast the pattern historically resolves
 *       (Cup & Handle 0.75, Flag 0.6, H&S 1.0, momentum thrusts 0.5, …)
 *   2.  Momentum factor — if the last 5-day return in the signal
 *       direction is strong (≥ 3%), the market is already moving —
 *       compress the timeline (×0.85); if flat/opposing, expand it.
 *   3.  Direction factor — SHORT setups on NSE equities historically
 *       take slightly longer than LONG setups → 1.10 for SHORT.
 *   4.  Instrument factor — options move much faster than the
 *       underlying → 0.55 when the instrument symbol contains " CE"
 *       or " PE".
 *
 * Then we add business days from entryDate.
 *
 * The estimator is DETERMINISTIC and PURE — no I/O, no randomness. It
 * never throws; when required inputs are missing we return the input's
 * existing dates (or empty strings) unchanged so callers can safely
 * enrich blindly.
 *
 * Rollback
 * ────────
 * The calling enrichment layer is gated by
 * config.features.targetDatesEnabled — set to false in .env to disable
 * without touching code, or git revert the shipping commit for full
 * removal.
 */

export interface TargetDateInput {
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  direction: 'BUY' | 'SHORT' | 'SELL' | string
  entryDate?: string           // ISO or 'YYYY-MM-DD'. Defaults to today.

  // Optional context — the richer, the better the estimate.
  atr14?: number               // absolute rupee/point ATR of the underlying
  atrPctOfPrice?: number       // e.g. 2.5 → 2.5% daily ATR
  ret5dPct?: number
  ret20dPct?: number
  pattern?: string
  speedFactor?: number         // explicit override
  isOption?: boolean
  symbol?: string
}

export interface TargetDatesOut {
  entryDate: string
  target1Date: string
  target2Date: string
  target3Date: string
  slDate: string
  sessionsToT1: number
  sessionsToT2: number
  sessionsToT3: number
  speedFactorUsed: number
  atrPctUsed: number
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  method: string
}

// ─── Speed factor derivation ───────────────────────────────────────────

const PATTERN_SPEED: Array<[RegExp, number]> = [
  [/cup.*handle/i,                0.75],
  [/inverse.*head.*shoulder/i,    0.95],
  [/head.*shoulder/i,             1.00],
  [/double.*top/i,                1.00],
  [/double.*bottom/i,             0.95],
  [/triangle.*ascend/i,           0.85],
  [/triangle.*descend/i,          0.90],
  [/triangle/i,                   0.90],
  [/flag/i,                       0.60],
  [/pennant/i,                    0.60],
  [/wedge/i,                      0.95],
  [/three white soldiers/i,       0.50],
  [/three black crows/i,          0.55],
  [/marubozu/i,                   0.55],
  [/hammer/i,                     0.70],
  [/engulfing/i,                  0.65],
  [/darvas/i,                     0.85],
  [/vcp|volatility contraction/i, 0.75],
  [/wyckoff/i,                    1.00],
  [/bb squeeze|bollinger squeeze/i, 0.65],
  [/breakout/i,                   0.70],
  [/breakdown/i,                  0.70],
  [/vp[_ ]?rotation|va[_ ]?rotation/i, 0.65],
  [/vp[_ ]?breakout|va[_ ]?breakout/i, 0.60],
  [/ib[_ ]?break|initial[_ ]?balance/i, 0.50],
  [/failed[_ ]?auction/i,         0.55],
  [/hvn[_ ]?reject/i,             0.75],
  [/lvn[_ ]?slice/i,               0.50],
]

function patternSpeed(pattern: string | undefined): number {
  if (!pattern) return 1.00
  for (const [re, sp] of PATTERN_SPEED) if (re.test(pattern)) return sp
  return 1.00
}

function momentumSpeed(direction: string, ret5d?: number, ret20d?: number): number {
  const dirMul = direction === 'SHORT' || direction === 'SELL' ? -1 : 1
  const r5 = typeof ret5d === 'number' && Number.isFinite(ret5d) ? ret5d * dirMul : 0
  const r20 = typeof ret20d === 'number' && Number.isFinite(ret20d) ? ret20d * dirMul : 0
  // Signed momentum in the SIGNAL's favour. Positive = already moving.
  if (r5 >= 5)  return 0.75    // very hot — compress timeline
  if (r5 >= 3)  return 0.85
  if (r5 >= 1)  return 0.95
  if (r5 >= -1) return 1.00
  if (r5 >= -3) return 1.10    // moving against — expand timeline
  return 1.20 + Math.min(0.2, Math.max(0, -r20) / 40)
}

// ─── ATR percent derivation ────────────────────────────────────────────

function derivedAtrPct(inp: TargetDateInput): number {
  if (typeof inp.atrPctOfPrice === 'number' && inp.atrPctOfPrice > 0) return inp.atrPctOfPrice
  if (typeof inp.atr14 === 'number' && inp.atr14 > 0 && inp.entry > 0) {
    return (inp.atr14 / inp.entry) * 100
  }
  // No ATR provided — pick a sensible default from typical NSE mid-cap ATR.
  // Empirically most NIFTY-500 names live in 1.5%-3.5% band; we split the
  // difference and lean slightly cautious.
  return 2.5
}

// ─── Business-day math ────────────────────────────────────────────────

function parseIso(iso: string | undefined): Date {
  if (!iso) return new Date()
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return new Date()
  return new Date(t)
}

function toIstDateOnly(d: Date): string {
  // Return YYYY-MM-DD in IST.
  const ms = d.getTime() + 5.5 * 3600_000
  const shifted = new Date(ms)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function addBusinessDays(from: Date, n: number): Date {
  let d = new Date(from.getTime())
  let added = 0
  const step = n >= 0 ? 1 : -1
  const target = Math.abs(Math.round(n))
  while (added < target) {
    d = new Date(d.getTime() + step * 86_400_000)
    const dow = d.getUTCDay()   // 0 Sun · 6 Sat
    if (dow !== 0 && dow !== 6) added++
  }
  return d
}

// ─── Main estimator ────────────────────────────────────────────────────

export function estimateTargetDates(inp: TargetDateInput): TargetDatesOut {
  const entryDate = inp.entryDate ?? toIstDateOnly(new Date())
  const emptyDate = ''
  // Guard rails: require enough context.
  if (
    !Number.isFinite(inp.entry) || inp.entry <= 0 ||
    !Number.isFinite(inp.target1) || inp.target1 <= 0
  ) {
    return {
      entryDate,
      target1Date: emptyDate, target2Date: emptyDate, target3Date: emptyDate, slDate: emptyDate,
      sessionsToT1: 0, sessionsToT2: 0, sessionsToT3: 0,
      speedFactorUsed: 1, atrPctUsed: 2.5,
      confidence: 'LOW',
      method: 'skipped: insufficient inputs',
    }
  }

  const atrPct = derivedAtrPct(inp)
  const patSpeed = patternSpeed(inp.pattern)
  const momSpeed = momentumSpeed(inp.direction, inp.ret5dPct, inp.ret20dPct)
  const dirFactor = (inp.direction === 'SHORT' || inp.direction === 'SELL') ? 1.10 : 1.00
  const isOption = inp.isOption === true ||
    (typeof inp.symbol === 'string' && /\s(CE|PE)\b/i.test(inp.symbol))
  const optFactor = isOption ? 0.55 : 1.00
  const explicit = typeof inp.speedFactor === 'number' && inp.speedFactor > 0 ? inp.speedFactor : 1.00

  const speed = clamp(patSpeed * momSpeed * dirFactor * optFactor * explicit, 0.35, 1.60)

  const distPct = (target: number) =>
    inp.entry > 0 ? (Math.abs(target - inp.entry) / inp.entry) * 100 : 0

  const sessions = (target: number) => {
    if (target <= 0) return 0
    const d = distPct(target)
    if (d <= 0) return 1
    const raw = d / (atrPct * speed)
    return Math.max(1, Math.round(raw))
  }

  const s1 = sessions(inp.target1)
  const s2 = Math.max(s1 + 1, sessions(inp.target2 || inp.target1))
  const s3 = Math.max(s2 + 1, sessions(inp.target3 || inp.target2 || inp.target1))

  // SL "date" = midpoint of T2 timeline — that's the invalidation window
  // after which we drop the setup regardless of outcome.
  const slSessions = Math.max(1, Math.round((s1 + s3) / 2))

  const entryAsDate = parseIso(inp.entryDate)
  const t1 = addBusinessDays(entryAsDate, s1)
  const t2 = addBusinessDays(entryAsDate, s2)
  const t3 = addBusinessDays(entryAsDate, s3)
  const sl = addBusinessDays(entryAsDate, slSessions)

  // Confidence — HIGH when we had real ATR + pattern; MEDIUM when we had one; LOW when defaults.
  const hasATR = (typeof inp.atr14 === 'number' && inp.atr14 > 0)
    || (typeof inp.atrPctOfPrice === 'number' && inp.atrPctOfPrice > 0)
  const hasPattern = !!inp.pattern
  const conf: TargetDatesOut['confidence'] =
    (hasATR && hasPattern) ? 'HIGH' :
    (hasATR || hasPattern) ? 'MEDIUM' : 'LOW'

  return {
    entryDate,
    target1Date: toIstDateOnly(t1),
    target2Date: toIstDateOnly(t2),
    target3Date: toIstDateOnly(t3),
    slDate: toIstDateOnly(sl),
    sessionsToT1: s1,
    sessionsToT2: s2,
    sessionsToT3: s3,
    speedFactorUsed: Math.round(speed * 100) / 100,
    atrPctUsed: Math.round(atrPct * 100) / 100,
    confidence: conf,
    method: `ATR ${atrPct.toFixed(2)}% · speed ${speed.toFixed(2)} (pat ${patSpeed.toFixed(2)} · mom ${momSpeed.toFixed(2)}${isOption ? ' · opt 0.55' : ''}${dirFactor !== 1 ? ' · short 1.10' : ''})`,
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}
