import axios from 'axios'
import { log } from './logger'

/**
 * Time sync — compensates for system clock drift.
 *
 * TOTP is unforgiving: a 30-second drift already breaks authentication.
 * We query an authoritative time source on startup and cache the offset
 * (real UTC − local UTC). All TOTP-sensitive callers should use
 * `correctedNow()` instead of Date.now().
 *
 * Strategy: try multiple sources in order, accept the first one that works.
 */

let offsetMs = 0
let lastSyncAt = 0

const SOURCES: { url: string; extract: (data: any) => number | null }[] = [
  {
    url: 'https://worldtimeapi.org/api/timezone/Etc/UTC',
    extract: (d) => d?.unixtime ? d.unixtime * 1000 : null,
  },
  {
    url: 'https://timeapi.io/api/Time/current/zone?timeZone=UTC',
    extract: (d) => d?.dateTime ? new Date(d.dateTime + 'Z').getTime() : null,
  },
]

/** Also try an HTTP HEAD to Google — their Date header is always current. */
async function fetchGoogleTime(): Promise<number | null> {
  try {
    const res = await axios.head('https://www.google.com', { timeout: 5000 })
    const dateHeader = res.headers['date']
    if (dateHeader) return new Date(dateHeader).getTime()
  } catch { /* ignore */ }
  return null
}

export async function syncTime(): Promise<number> {
  const localBefore = Date.now()
  for (const s of SOURCES) {
    try {
      const res = await axios.get(s.url, { timeout: 5000 })
      const realMs = s.extract(res.data)
      if (realMs && Number.isFinite(realMs)) {
        const localAfter = Date.now()
        const roundTrip = (localAfter - localBefore) / 2
        offsetMs = realMs - (localBefore + roundTrip)
        lastSyncAt = Date.now()
        log.ok('TIME', `Synced via ${s.url.split('//')[1].split('/')[0]}: offset ${offsetMs > 0 ? '+' : ''}${offsetMs}ms`)
        return offsetMs
      }
    } catch {
      /* try next source */
    }
  }
  // Last-resort: Google's Date header
  const google = await fetchGoogleTime()
  if (google) {
    offsetMs = google - Date.now()
    lastSyncAt = Date.now()
    log.ok('TIME', `Synced via google.com Date header: offset ${offsetMs > 0 ? '+' : ''}${offsetMs}ms`)
    return offsetMs
  }
  log.warn('TIME', 'All time-sync sources failed — using raw system clock')
  return 0
}

/** Timestamp corrected to true UTC. Use this for TOTP, JWT validation, API signing, etc. */
export function correctedNow(): number {
  return Date.now() + offsetMs
}

export function getOffsetMs(): number {
  return offsetMs
}

export function getLastSyncAt(): number {
  return lastSyncAt
}
