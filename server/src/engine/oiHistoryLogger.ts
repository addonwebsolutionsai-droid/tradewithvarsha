/**
 * OI history logger — persists per-tick option-chain snapshots per strike
 * so we can compute velocity (dOI/dT, dPremium/dT, dIV/dT) and detect
 * institutional accumulation BEFORE the price move.
 *
 * Reads the live OI analysis from oiMonitor (in-memory state, refreshed
 * every intraday tick) and appends one line per (underlying, expiry,
 * strike, side) tuple to JSONL files under data/oi-history/.
 *
 * File shape (append-only JSONL):
 *   data/oi-history/NIFTY-31JUL2026.jsonl
 *     {"ts":"2026-07-25T09:20:00Z","strike":23600,"side":"CE","oi":150000,"oiPrev":149000,"ltp":159,"iv":18.4,"vol":12345,"spot":23540}
 *     {"ts":"2026-07-25T09:25:00Z","strike":23600,"side":"CE","oi":175000,"oiPrev":150000,"ltp":168,"iv":19.1,"vol":18220,"spot":23555}
 *
 * Downstream (optionsRadar.ts) reads the last N ticks per strike and
 * computes velocity. The radar cannot work without this log building up
 * over a few ticks — that's the intentional bootstrap delay.
 *
 * File-size discipline: each expiry file is trimmed to the last 500 lines
 * per (strike, side) tuple on every write (keeps files under ~2 MB).
 */

import fs from 'fs'
import path from 'path'
import { getLatestOiAnalysis } from './oiMonitor'
import { log } from '../util/logger'

const HISTORY_DIR = path.resolve(process.cwd(), 'data', 'oi-history')
const MAX_LINES_PER_FILE = 20_000

function ensureDir(): void {
  fs.mkdirSync(HISTORY_DIR, { recursive: true })
}

function expiryToFileTag(expiry: string): string {
  // "31JUL2026" or "2026-07-31" → "31JUL2026"
  const m = expiry.match(/(\d{2})[-\/]?([A-Z]{3})[-\/]?(\d{4})/i)
  if (m) return `${m[1]}${m[2].toUpperCase()}${m[3]}`
  const m2 = expiry.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (m2) {
    const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC']
    return `${m2[3]}${MONTHS[+m2[2] - 1]}${m2[1]}`
  }
  return expiry.replace(/[^A-Z0-9]/gi, '').toUpperCase()
}

export interface OiHistoryTick {
  ts: string
  strike: number
  side: 'CE' | 'PE'
  oi: number
  oiPrev?: number
  ltp: number
  iv?: number
  vol?: number
  spot: number
}

/**
 * Read the last N history ticks for a given (underlying, expiry, strike, side).
 * Returns [] if the file doesn't exist. Used by optionsRadar to compute velocity.
 */
export function readOiHistory(
  underlying: string,
  expiry: string,
  strike: number,
  side: 'CE' | 'PE',
  maxTicks = 20,
): OiHistoryTick[] {
  const file = path.join(HISTORY_DIR, `${underlying.toUpperCase()}-${expiryToFileTag(expiry)}.jsonl`)
  if (!fs.existsSync(file)) return []
  try {
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
    const rows: OiHistoryTick[] = []
    for (let i = lines.length - 1; i >= 0 && rows.length < maxTicks; i--) {
      try {
        const r = JSON.parse(lines[i])
        if (r.strike === strike && r.side === side) rows.unshift(r)
      } catch { /* skip malformed */ }
    }
    return rows
  } catch { return [] }
}

/**
 * Read ALL last-tick snapshots per (strike, side) for a given expiry.
 * Used by the radar to find candidate strikes without scanning every strike.
 */
export function readAllLatestPerStrike(underlying: string, expiry: string): OiHistoryTick[] {
  const file = path.join(HISTORY_DIR, `${underlying.toUpperCase()}-${expiryToFileTag(expiry)}.jsonl`)
  if (!fs.existsSync(file)) return []
  try {
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
    const latest = new Map<string, OiHistoryTick>()
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as OiHistoryTick
        latest.set(`${r.strike}-${r.side}`, r)
      } catch { /* skip */ }
    }
    return Array.from(latest.values())
  } catch { return [] }
}

/**
 * Append one tick per (strike, side) to the appropriate expiry file for
 * every strike we currently have live OI data for. Called on every
 * intraday-tick before the OI-buildup writer.
 */
export function logCurrentOiTick(): { underlyings: string[]; ticksLogged: number; files: string[] } {
  ensureDir()
  const analysis = getLatestOiAnalysis()
  const filesTouched = new Set<string>()
  let ticksLogged = 0
  const ts = new Date().toISOString()

  for (const [underlying, a] of Object.entries(analysis)) {
    if (!a || !(a as any).expiry) continue
    const spot: number = (a as any).spot ?? 0
    const expiry: string = (a as any).expiry
    const file = path.join(HISTORY_DIR, `${underlying.toUpperCase()}-${expiryToFileTag(expiry)}.jsonl`)

    // strikeFlows carries the ATM ± 5% band with currentOI, currentLTP,
    // currentIV, currentVol, side (CE/PE), strike. Log every strike we
    // saw this tick so the radar can compute velocity next tick.
    const strikeFlows = ((a as any).strikeFlows ?? []) as any[]
    if (strikeFlows.length === 0) continue

    // Load previous-tick OI for delta computation (dOI compared to what we
    // last wrote — helps the radar bootstrap on the very first read).
    const prevLatest = readAllLatestPerStrike(underlying, expiry)
    const prevByKey = new Map(prevLatest.map(p => [`${p.strike}-${p.side}`, p]))

    const lines: string[] = []
    for (const f of strikeFlows) {
      const strike = f.strike
      const side = f.side as 'CE' | 'PE'
      if (typeof strike !== 'number' || (side !== 'CE' && side !== 'PE')) continue
      const prev = prevByKey.get(`${strike}-${side}`)
      const row: OiHistoryTick = {
        ts,
        strike,
        side,
        oi: f.currentOI ?? 0,
        oiPrev: prev?.oi,
        ltp: f.currentLTP ?? 0,
        iv: f.currentIV,
        vol: f.currentVol,
        spot,
      }
      lines.push(JSON.stringify(row))
      ticksLogged++
    }
    if (lines.length === 0) continue

    // Append (create if missing)
    fs.appendFileSync(file, lines.join('\n') + '\n', 'utf-8')
    filesTouched.add(file)

    // Rotate: cap file size by keeping only the last MAX_LINES_PER_FILE lines
    try {
      const all = fs.readFileSync(file, 'utf-8').trim().split('\n')
      if (all.length > MAX_LINES_PER_FILE) {
        const kept = all.slice(-MAX_LINES_PER_FILE)
        fs.writeFileSync(file, kept.join('\n') + '\n', 'utf-8')
      }
    } catch { /* rotate best-effort */ }
  }

  const files = Array.from(filesTouched)
  log.info('OI-HIST', `logged ${ticksLogged} ticks across ${files.length} expiry files (${Object.keys(analysis).length} underlyings)`)
  return { underlyings: Object.keys(analysis), ticksLogged, files }
}
