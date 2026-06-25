/**
 * SEED PATTERN MEMORY from the user's 9 historical winners.
 *
 * User input 2026-06-25: "Our entries that gave 35% in 3 months were
 * MOSCHIP @193, MARKSANS @175, FINPIPE @174, HIKAL @215, MOULDTEK @555,
 * NEWGEN @465, LATENT VIEW @293, HARIOMPIPE @417, DAMCAP @153. Reverse-
 * engineer these and improve the scanner."
 *
 * What this script does:
 *   1. Fetch ~250 daily candles per symbol
 *   2. Find the candle whose close is nearest the user's entry price
 *   3. Compute the 30-day fingerprint AT that entry date
 *   4. Append to winning-patterns.json as a `PROVEN_WINNER` entry
 *
 * After this seed, the live weekly + early-momentum scanners will recognize
 * setups that match these specific fingerprints and award +5 conviction +
 * "🧠 matches MOSCHIP/MARKSANS/..." tag — closing the loop between past
 * winners and future detection.
 *
 * Run: cd server && npm exec -- ts-node-dev --transpile-only scripts/seedWinnerPatterns.ts
 */
import fs from 'fs/promises'
import path from 'path'
import { getCandles } from '../src/data'
import { computeFingerprint } from '../src/engine/patternMemory'
import { log } from '../src/util/logger'

const WINNERS: Array<{ symbol: string; entryPrice: number; note: string }> = [
  { symbol: 'MOSCHIP',     entryPrice: 193, note: 'electronics design / semiconductor' },
  { symbol: 'MARKSANS',    entryPrice: 175, note: 'pharma' },
  { symbol: 'FINPIPE',     entryPrice: 174, note: 'Finolex Industries pipes' },
  { symbol: 'HIKAL',       entryPrice: 215, note: 'specialty chemicals / pharma intermediates' },
  { symbol: 'MOLDTKPAC',   entryPrice: 555, note: 'Mold-Tek Packaging' },
  { symbol: 'NEWGEN',      entryPrice: 465, note: 'Newgen Software' },
  { symbol: 'LATENTVIEW',  entryPrice: 293, note: 'Latent View Analytics' },
  { symbol: 'HARIOMPIPE',  entryPrice: 417, note: 'Hariom Pipe Industries' },
  { symbol: 'DAMCAPITAL',  entryPrice: 153, note: 'DAM Capital Advisors' },
]

interface ProvenWinnerEntry {
  symbol: string
  status: 'PROVEN_WINNER'
  direction: 'BUY'
  capturedAt: string
  entryPrice: number
  entryDate: string
  note: string
  atrPct: number
  emaStack: -2 | -1 | 0 | 1 | 2
  adx: number
  rsi: number
  volRatio: number
  range20Pct: number
  baseDays: number
  distFrom20High: number
}

async function findNearestEntryDate(symbol: string, entryPrice: number): Promise<{ idx: number; date: string; close: number } | null> {
  const candles = await getCandles(symbol, '1D' as any, 250)
  if (!candles || candles.length < 60) return null
  // Find the candle whose close is closest to entryPrice, but bias toward
  // earlier dates (we want the original entry, not a later retest).
  let best = { idx: -1, diff: Infinity }
  for (let i = 30; i < candles.length - 5; i++) {
    const diff = Math.abs(candles[i].close - entryPrice) / entryPrice
    if (diff < best.diff) best = { idx: i, diff }
  }
  if (best.idx === -1) return null
  const c = candles[best.idx]
  return { idx: best.idx, date: new Date(c.time).toISOString().slice(0, 10), close: c.close }
}

async function main(): Promise<void> {
  log.info('SEED', `Seeding pattern memory from ${WINNERS.length} historical winners...`)
  const captured: ProvenWinnerEntry[] = []
  for (const w of WINNERS) {
    try {
      const candles = await getCandles(w.symbol, '1D' as any, 250)
      if (!candles || candles.length < 60) {
        log.warn('SEED', `${w.symbol}: insufficient history (${candles?.length ?? 0} bars)`)
        continue
      }
      // Find entry date
      let bestIdx = -1, bestDiff = Infinity
      for (let i = 30; i < candles.length - 5; i++) {
        const diff = Math.abs(candles[i].close - w.entryPrice) / w.entryPrice
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i }
      }
      if (bestIdx === -1) {
        log.warn('SEED', `${w.symbol}: no entry date found near ₹${w.entryPrice}`)
        continue
      }
      // Compute fingerprint using only the candles UP TO entry (no lookahead)
      const candlesAtEntry = candles.slice(0, bestIdx + 1)
      const fp = computeFingerprint(candlesAtEntry)
      if (!fp) {
        log.warn('SEED', `${w.symbol}: fingerprint compute failed`)
        continue
      }
      const entryCandle = candles[bestIdx]
      const entryDate = new Date(entryCandle.time).toISOString().slice(0, 10)
      // Also report subsequent return so the user sees we found the right entry
      const future10 = candles[Math.min(bestIdx + 10, candles.length - 1)]
      const future30 = candles[Math.min(bestIdx + 30, candles.length - 1)]
      const ret10d = ((future10.close - entryCandle.close) / entryCandle.close * 100).toFixed(1)
      const ret30d = ((future30.close - entryCandle.close) / entryCandle.close * 100).toFixed(1)
      log.ok('SEED', `${w.symbol} entry ₹${entryCandle.close.toFixed(0)} on ${entryDate} (${bestDiff < 0.05 ? '✓ exact' : '~ near'}); ret 10d=${ret10d}% 30d=${ret30d}% · stack=${fp.emaStack} adx=${fp.adx} rsi=${fp.rsi} vol=${fp.volRatio}× tightness=${fp.range20Pct}%`)
      captured.push({
        symbol: w.symbol,
        status: 'PROVEN_WINNER',
        direction: 'BUY',
        capturedAt: new Date().toISOString(),
        entryPrice: entryCandle.close,
        entryDate,
        note: w.note,
        ...fp,
      })
    } catch (e) {
      log.warn('SEED', `${w.symbol} failed: ${(e as Error).message}`)
    }
  }

  if (captured.length === 0) {
    log.warn('SEED', 'No winners captured — bailing without writing.')
    return
  }

  // Append to existing winning-patterns store (don't clobber)
  const PATTERN_FILE = path.resolve(__dirname, '../data/winning-patterns.json')
  let existing: { patterns: any[]; lastUpdated: string } = { patterns: [], lastUpdated: '' }
  try {
    const raw = await fs.readFile(PATTERN_FILE, 'utf8')
    existing = JSON.parse(raw)
  } catch { /* fresh */ }
  // Dedup: remove any prior PROVEN_WINNER entries for these symbols
  const winnerSymbols = new Set(captured.map(c => c.symbol))
  existing.patterns = existing.patterns.filter(p => !(p.status === 'PROVEN_WINNER' && winnerSymbols.has(p.symbol)))
  // Prepend the captured proven-winners so they're matched first
  existing.patterns = [...captured, ...existing.patterns].slice(0, 600)   // bumped cap for proven set
  existing.lastUpdated = new Date().toISOString()
  await fs.writeFile(PATTERN_FILE, JSON.stringify(existing, null, 2))
  log.ok('SEED', `Wrote ${captured.length} PROVEN_WINNER fingerprints to ${PATTERN_FILE}`)
  log.ok('SEED', `Pattern store total: ${existing.patterns.length} entries`)
}

main().catch(e => { log.warn('SEED', `fatal: ${e.message}`); process.exit(1) })
