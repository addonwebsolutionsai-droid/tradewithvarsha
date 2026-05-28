/**
 * Expiry selector — single source of truth for which expiry an OPTIONS signal
 * should recommend.
 *
 * Why this exists (2026-04-29):
 * The user pointed out that when monthly expiry is days away, every strategy
 * was still defaulting to the nearest weekly. On the day BEFORE monthly expiry
 * a "buy this weekly CE" call has zero positive expectancy — theta wipes the
 * premium overnight regardless of direction.
 *
 * Rule for INDEX (NIFTY / FINNIFTY) options:
 *   - If monthly expiry is within 3 calendar days  → recommend NEXT MONTH (skip current)
 *   - Else if weekly expiry is within 1 day        → recommend NEXT WEEK (skip current)
 *   - Else                                          → use current weekly
 *
 * Rule for STOCK options (no weeklies on most names):
 *   - If current month expiry within 5 days → recommend NEXT MONTH
 *   - Else                                  → current month
 *
 * The selector returns a label, an absolute expiry date string and a
 * "label-tag" the bot/UI can show (e.g. "next-week", "next-month").
 */

import { addDays } from '../util/time'

export type ExpiryBucket = 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'
export type ExpiryTag = 'current-week' | 'next-week' | 'current-month' | 'next-month' | 'next-quarter'

export interface ExpiryChoice {
  expiry: string         // YYYY-MM-DD
  daysToExpiry: number   // calendar days
  tag: ExpiryTag
  bucket: ExpiryBucket
  reason: string         // why we picked this one (for the signal card)
}

const PROXIMITY_MONTHLY_DAYS = 3   // within 3d of monthly → roll to next month
const PROXIMITY_WEEKLY_DAYS = 1    // within 1d of weekly  → roll to next week
const STOCK_MONTHLY_ROLL_DAYS = 5

/** Next NSE Thursday from a given date (returns same date if it IS Thursday and intraday). */
function nextThursdayUtc(from: Date, includeToday = false): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()))
  const dow = d.getUTCDay()
  // 4 = Thursday. If today is Thursday and includeToday, return today.
  if (dow === 4 && includeToday) return d
  const off = ((4 - dow + 7) % 7) || 7
  return addDays(d, off)
}

/** Last Thursday of a calendar month (UTC). */
function lastThursdayOfMonth(year: number, monthIndex: number): Date {
  // Day 0 of next month = last day of THIS month
  const d = new Date(Date.UTC(year, monthIndex + 1, 0))
  while (d.getUTCDay() !== 4) d.setUTCDate(d.getUTCDate() - 1)
  return d
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function diffCalendarDays(target: Date, from: Date): number {
  const t = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate())).getTime()
  const f = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())).getTime()
  return Math.max(0, Math.round((t - f) / 86_400_000))
}

/** Pick the right expiry for a NIFTY / FINNIFTY index option. */
/**
 * 2026-05-28: Pick from REAL listed NSE expiries (passed in from Angel's
 * ScripMaster via listIndexExpiries()). This is the correct source of
 * truth — NSE has shifted weekly schedules multiple times and discontinued
 * some entirely. Calculated "next Thursday" math is unreliable.
 *
 * Picks the first expiry > PROXIMITY_WEEKLY_DAYS away (avoid same-day or
 * T-1 theta wipe). Returns null if the list is empty so the caller can
 * fall back to the legacy calculated logic.
 */
export function selectIndexExpiryFromList(expiries: string[], now: Date = new Date()): ExpiryChoice | null {
  if (!expiries || !expiries.length) return null
  const futureOrToday = expiries
    .slice()
    .sort()
    .map(s => ({ s, d: new Date(s + 'T00:00:00Z') }))
    .filter(e => !Number.isNaN(e.d.getTime()) && diffCalendarDays(e.d, now) >= 0)
  if (!futureOrToday.length) return null
  const tradable = futureOrToday.filter(e => diffCalendarDays(e.d, now) > PROXIMITY_WEEKLY_DAYS)
  const picked = tradable.length ? tradable[0] : futureOrToday[futureOrToday.length - 1]
  const dte = diffCalendarDays(picked.d, now)
  const bucket: ExpiryBucket = dte > 14 ? 'MONTHLY' : 'WEEKLY'
  const isFirst = futureOrToday[0].s === picked.s
  const tag: ExpiryTag = bucket === 'MONTHLY'
    ? (isFirst ? 'current-month' : 'next-month')
    : (isFirst ? 'current-week' : 'next-week')
  return {
    expiry: picked.s,
    daysToExpiry: dte,
    tag, bucket,
    reason: `Picked from ${expiries.length} NSE-listed expiries · ${dte}d to expiry.`,
  }
}

export function selectIndexExpiry(now: Date = new Date()): ExpiryChoice {
  const monthlyThis = lastThursdayOfMonth(now.getUTCFullYear(), now.getUTCMonth())
  const monthlyNext = lastThursdayOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1)
  const weeklyThis = nextThursdayUtc(now, true)
  const weeklyNext = nextThursdayUtc(addDays(weeklyThis, 1), false)

  const dteMonthlyThis = diffCalendarDays(monthlyThis, now)
  const dteWeeklyThis = diffCalendarDays(weeklyThis, now)

  // Rule 1: monthly expiry imminent → roll to next monthly (skip last-week scalps)
  if (dteMonthlyThis >= 0 && dteMonthlyThis <= PROXIMITY_MONTHLY_DAYS) {
    const dteNext = diffCalendarDays(monthlyNext, now)
    return {
      expiry: ymd(monthlyNext),
      daysToExpiry: dteNext,
      tag: 'next-month',
      bucket: 'MONTHLY',
      reason: `Monthly expiry ${dteMonthlyThis === 0 ? 'today' : `in ${dteMonthlyThis}d`} — rolling to next-month (${dteNext}d) to avoid theta wipe.`,
    }
  }

  // Rule 2: this week's weekly expiry tomorrow/today → roll to next weekly
  if (dteWeeklyThis >= 0 && dteWeeklyThis <= PROXIMITY_WEEKLY_DAYS) {
    const dteNext = diffCalendarDays(weeklyNext, now)
    return {
      expiry: ymd(weeklyNext),
      daysToExpiry: dteNext,
      tag: 'next-week',
      bucket: 'WEEKLY',
      reason: `Weekly expiry ${dteWeeklyThis === 0 ? 'today' : `in ${dteWeeklyThis}d`} — rolling to next-week (${dteNext}d).`,
    }
  }

  // Default: current weekly
  return {
    expiry: ymd(weeklyThis),
    daysToExpiry: dteWeeklyThis,
    tag: 'current-week',
    bucket: 'WEEKLY',
    reason: `Current weekly (${dteWeeklyThis}d to expiry) — adequate runway.`,
  }
}

/** Pick the right expiry for a STOCK option (no weeklies for most). */
export function selectStockExpiry(now: Date = new Date()): ExpiryChoice {
  const monthlyThis = lastThursdayOfMonth(now.getUTCFullYear(), now.getUTCMonth())
  const monthlyNext = lastThursdayOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1)
  const dteThis = diffCalendarDays(monthlyThis, now)

  if (dteThis >= 0 && dteThis <= STOCK_MONTHLY_ROLL_DAYS) {
    const dteNext = diffCalendarDays(monthlyNext, now)
    return {
      expiry: ymd(monthlyNext),
      daysToExpiry: dteNext,
      tag: 'next-month',
      bucket: 'MONTHLY',
      reason: `Stock monthly expiry ${dteThis === 0 ? 'today' : `in ${dteThis}d`} — rolling to next-month (${dteNext}d).`,
    }
  }
  return {
    expiry: ymd(monthlyThis),
    daysToExpiry: dteThis,
    tag: 'current-month',
    bucket: 'MONTHLY',
    reason: `Current month expiry (${dteThis}d to expiry).`,
  }
}

/** Pick the next-quarter (third-Friday-of-quarter-end) for far-month positionals. */
export function selectQuarterlyExpiry(now: Date = new Date()): ExpiryChoice {
  // Use last-Thursday of (current-month + 3) for simplicity
  const t = lastThursdayOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 3)
  const dte = diffCalendarDays(t, now)
  return {
    expiry: ymd(t),
    daysToExpiry: dte,
    tag: 'next-quarter',
    bucket: 'QUARTERLY',
    reason: `Quarterly horizon (${dte}d) — positional / Gann-major-cycle play.`,
  }
}

/** Higher-level helper used by every options strategy. */
export function selectExpiry(args: {
  symbol: string
  bucketHint?: ExpiryBucket
  now?: Date
}): ExpiryChoice {
  const now = args.now ?? new Date()
  const isIndex = ['NIFTY', 'FINNIFTY', 'BANKNIFTY'].includes(args.symbol.toUpperCase())
  if (args.bucketHint === 'QUARTERLY') return selectQuarterlyExpiry(now)
  if (args.bucketHint === 'MONTHLY' || !isIndex) return selectStockExpiry(now)
  return selectIndexExpiry(now)
}
