// IST helpers — Indian markets trade in Asia/Kolkata (UTC+5:30)
const IST_OFFSET_MIN = 330

// Shift epoch by +5:30 so the returned Date's UTC fields read as IST clock.
// (Earlier version added the host's timezone offset too, which cancelled the
// IST shift on machines already in Asia/Kolkata — leaving market checks
// 5h30 behind reality.)
export function toIST(d: Date = new Date()): Date {
  return new Date(d.getTime() + IST_OFFSET_MIN * 60_000)
}

export function istNow(): Date {
  return toIST(new Date())
}

export function istDateStr(d: Date = istNow()): string {
  return d.toISOString().slice(0, 10)
}

export function istTimeStr(d: Date = istNow()): string {
  return d.toISOString().slice(11, 19)
}

/** NSE market hours: 09:15 — 15:30 IST, Mon-Fri (excluding public holidays) */
export function isMarketOpen(d: Date = istNow()): boolean {
  const day = d.getUTCDay() // using IST-shifted date, so UTC day === IST day
  if (day === 0 || day === 6) return false
  const hours = d.getUTCHours()
  const minutes = d.getUTCMinutes()
  const t = hours * 60 + minutes
  return t >= 9 * 60 + 15 && t <= 15 * 60 + 30
}

/** MCX: 09:00 — 23:30 (Mon-Fri), 09:00 — 17:00 (Saturday). */
export function isCommodityMarketOpen(d: Date = istNow()): boolean {
  const day = d.getUTCDay()
  if (day === 0) return false
  const t = d.getUTCHours() * 60 + d.getUTCMinutes()
  if (day === 6) return t >= 9 * 60 && t <= 17 * 60
  return t >= 9 * 60 && t <= 23 * 60 + 30
}

export function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime())
  return Math.floor(ms / 86_400_000)
}

export function addDays(d: Date, days: number): Date {
  const x = new Date(d)
  x.setUTCDate(x.getUTCDate() + days)
  return x
}

/**
 * Add `n` NSE trading days to an IST date — skips Sat/Sun.
 * Public-holiday calendar is not modeled; close enough for entry/target hints.
 * Returns a YYYY-MM-DD string.
 */
export function addTradingDays(from: Date, n: number): string {
  let d = toIST(from)
  let added = 0
  while (added < n) {
    d = addDays(d, 1)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) added++
  }
  return d.toISOString().slice(0, 10)
}

/** Today's IST date — YYYY-MM-DD. */
export function todayIST(): string {
  return istNow().toISOString().slice(0, 10)
}
