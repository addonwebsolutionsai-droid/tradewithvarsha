/**
 * Paper Trading Book — the "let's test it for 1 month" simulator.
 *
 * State machine over ₹10,00,000 starting capital that:
 *   - Reads today's high-quality-setups.json
 *   - Opens new positions per the sizing + quality rules below
 *   - Marks-to-market the currently open book
 *   - Executes partial/full exits when candles cross T1/T2/T3/SL
 *   - Persists the ledger + trades to disk
 *   - Publishes trading-journal.json for stocksbyvarsha.vercel.app to consume
 *
 * Runs once per day (EOD tick) after all engines complete. Book state
 * lives in server/data/paper-trading-book.json (private); the human-
 * readable journal + performance summary lives in the public snapshot
 * so any external consumer (stocksbyvarsha /journal, dashboards) can
 * fetch it via raw.githubusercontent.com.
 *
 * Rules — DELIBERATELY hedge-fund conservative:
 *
 *   POSITION SIZING (tier-based)
 *     ELITE (5★, score ≥ 80) → target 15% of book value
 *     STRONG (3★, score 60-79) → target 8% of book value
 *     DECENT (score < 60) → SKIP
 *     Cap per position: 20% of book value
 *     Cap risk per trade: 1% of book value (entry − SL) × qty ≤ ₹10k on ₹10L
 *     Final qty = min(tier-based, risk-based, cash-available)
 *
 *   QUALITY GATES (avoid pump-and-dump)
 *     - Market cap (from shareholdingNote) ≥ ₹500 Cr
 *     - Promoter pledge < 20%
 *     - No existing open position on same symbol
 *     - Skip ETFs (they belong in the SIP journal, not tactical trades)
 *     - Max 15 concurrent open positions (concentration cap)
 *
 *   EXIT LOGIC
 *     40% of qty exits at T1 · 30% at T2 · 30% at T3
 *     Full exit on SL hit
 *     Time stop: exit remaining qty at close if no T-hit after 15 trading days
 *     Same-day entries + exits blocked (need next-day candle to test T/SL)
 *
 * Uses Yahoo daily candles to mark-to-market and detect T-hits.
 */

import fs from 'fs'
import path from 'path'
import { getCandles, getQuote } from '../data/index'
import { isEtfSymbol } from '../util/etfDetect'
import { log } from '../util/logger'
import type { Candle } from '../types'

// ─── Types ──────────────────────────────────────────────────────────

export interface TradeExit {
  date: string             // ISO date
  price: number
  qty: number
  reason: 'T1_HIT' | 'T2_HIT' | 'T3_HIT' | 'SL_HIT' | 'TIME_STOP' | 'MANUAL'
  pnl: number              // realised P&L for this partial exit (₹)
}

export interface TradeEntry {
  id: string               // stable id, e.g. `RELIANCE-2026-07-23-BUY`
  symbol: string
  segment: 'FNO' | 'CASH' | 'MCX'
  direction: 'LONG' | 'SHORT'
  source: string           // VP+FIB · PRO-EDGE · CROSS-CONFLUENCE · WEEKLY-PICK
  tier: 'ELITE' | 'STRONG'
  score: number

  entryDate: string        // ISO date the position was opened
  entryTime: string        // HH:mm IST (or "EOD" for daily close entries)
  entryPrice: number
  qty: number              // original qty at open
  remainingQty: number     // qty not yet exited
  positionValue: number    // qty × entryPrice at open (₹)
  riskAmount: number       // (entry - SL) × qty (₹ — the theoretical max loss)

  stopLoss: number
  target1: number
  target2: number
  target3: number

  entryReason: string      // one-liner why we took this trade
  shareholdingNote?: string
  marketCapCr?: number

  status: 'OPEN' | 'T1_HIT' | 'T2_HIT' | 'T3_HIT' | 'SL_HIT' | 'TIME_STOP' | 'CLOSED'
  exits: TradeExit[]
  daysHeld: number
  totalRealisedPnl: number  // sum of exits' pnl
  unrealisedPnl: number     // remainingQty × (currentLtp - entryPrice), sign-adjusted
  totalPnl: number          // realised + unrealised at last mark
  returnPct: number         // totalPnl / positionValue × 100
}

export interface Ledger {
  startingCapital: number
  currentCash: number
  openPositionsValue: number    // marked-to-market
  totalRealisedPnl: number
  totalUnrealisedPnl: number
  bookValue: number             // cash + openPositionsValue
  totalReturnPct: number        // (bookValue - startingCapital) / startingCapital × 100
}

export interface PerformanceStats {
  totalTrades: number
  openTrades: number
  closedTrades: number
  wins: number                  // trades with totalPnl > 0 at close
  losses: number                // trades with totalPnl < 0 at close
  winRatePct: number
  avgWinPct: number             // average return % on winning trades
  avgLossPct: number
  biggestWinInr: number
  biggestLossInr: number
  avgDaysHeld: number
}

export interface Book {
  version: 1
  startedAt: string             // ISO — the day the book opened
  lastUpdatedAt: string
  startingCapital: number
  trades: TradeEntry[]
  ledger: Ledger
  performance: PerformanceStats
  rules: {
    tierAlloc: { ELITE: number; STRONG: number }
    positionCapPct: number
    riskPerTradePct: number
    maxConcurrentPositions: number
    minMarketCapCr: number
    maxPledgePct: number
    exitPartials: { T1: number; T2: number; T3: number }
    timeStopBars: number
  }
}

// ─── File paths ─────────────────────────────────────────────────────
// Both the persistent state AND the public feed live in the same file
// under public-snapshots/. Why: GitHub Actions runners are ephemeral;
// the only way to preserve state across nightly runs is to commit it
// to git, and the existing snapshot-publisher cron only commits files
// under public-snapshots/. Keeping state there means the book runs
// with zero manual intervention forever.

const JOURNAL_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'trading-journal.json')
const HQS_SNAPSHOT_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'high-quality-setups.json')

// ─── Constants ──────────────────────────────────────────────────────

const STARTING_CAPITAL = 10_00_000

// Segment allocation model — total book value split across three risk buckets.
//   CASH  60% → high-quality-setups.json (cash tab, LONG only)
//   FNO   20% → high-quality-setups.json (fno tab, LONG or SHORT)
//                 F&O stock signals traded as SPOT proxy (delta-1 approx)
//   MCX   20% → commodity-signals.json (Gold/Silver/Crude/NatGas/Copper)
// Cap per position within each segment: 20% of that segment's allocation.
const SEGMENT_TARGET_PCT = {
  CASH: 0.60,
  FNO: 0.20,
  MCX: 0.20,
} as const

const RULES = {
  // Per-tier weight within the trade's segment allocation
  tierAlloc: { ELITE: 0.15, STRONG: 0.08 },
  positionCapPct: 0.20,           // cap per position: 20% of book
  riskPerTradePct: 0.01,          // 1% of book per trade
  maxConcurrentPositions: 20,     // across ALL segments
  maxPerSegment: { CASH: 12, FNO: 6, MCX: 4 },
  minMarketCapCr: 500,
  maxPledgePct: 20,
  segmentTargetPct: SEGMENT_TARGET_PCT,
  exitPartials: { T1: 0.4, T2: 0.3, T3: 0.3 },
  timeStopBars: 15,
} as const

// ─── Helpers ────────────────────────────────────────────────────────

function todayIST(): string {
  const ms = Date.now() + 5.5 * 3600_000
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function nowTimeIST(): string {
  const ms = Date.now() + 5.5 * 3600_000
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function isoDaysDiff(fromIso: string, toIso: string): number {
  const a = new Date(fromIso).getTime()
  const b = new Date(toIso).getTime()
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

function parseShareholdingMc(note?: string): number | undefined {
  if (!note) return undefined
  // "MC ₹390.4KCr" or "MC ₹120Cr"
  const m = /MC\s*₹\s*([\d.]+)\s*(KCr|Cr)/i.exec(note)
  if (!m) return undefined
  const n = parseFloat(m[1])
  return m[2].toLowerCase() === 'kcr' ? n * 1000 : n
}

function parseShareholdingPledge(note?: string): number | undefined {
  if (!note) return undefined
  const m = /Pledge\s*([\d.]+)%/i.exec(note)
  return m ? parseFloat(m[1]) : undefined
}

// ─── State I/O ──────────────────────────────────────────────────────

function loadBook(): Book {
  if (fs.existsSync(JOURNAL_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf-8')) as any
      // Backward-compat: earlier version split trades into openTrades[] +
      // closedTrades[]. Merge them back so we have a single trades[] source
      // of truth. New writes go through saveBook() with the merged shape.
      if (Array.isArray(parsed.trades)) return parsed as Book
      if (Array.isArray(parsed.openTrades) || Array.isArray(parsed.closedTrades)) {
        const trades = [...(parsed.openTrades ?? []), ...(parsed.closedTrades ?? [])]
        return {
          version: 1,
          startedAt: parsed.startedAt ?? todayIST(),
          lastUpdatedAt: parsed.lastUpdatedAt ?? todayIST(),
          startingCapital: parsed.startingCapital ?? STARTING_CAPITAL,
          trades,
          ledger: parsed.ledger,
          performance: parsed.performance,
          rules: parsed.rules ?? { ...RULES },
        }
      }
    } catch (e) {
      log.warn('PAPER', `journal file unreadable, starting fresh: ${(e as Error).message}`)
    }
  }
  return {
    version: 1,
    startedAt: todayIST(),
    lastUpdatedAt: todayIST(),
    startingCapital: STARTING_CAPITAL,
    trades: [],
    ledger: {
      startingCapital: STARTING_CAPITAL,
      currentCash: STARTING_CAPITAL,
      openPositionsValue: 0,
      totalRealisedPnl: 0,
      totalUnrealisedPnl: 0,
      bookValue: STARTING_CAPITAL,
      totalReturnPct: 0,
    },
    performance: {
      totalTrades: 0, openTrades: 0, closedTrades: 0,
      wins: 0, losses: 0, winRatePct: 0,
      avgWinPct: 0, avgLossPct: 0,
      biggestWinInr: 0, biggestLossInr: 0,
      avgDaysHeld: 0,
    },
    rules: { ...RULES },
  }
}

/**
 * Write the book to disk. Same file serves as both the persistent state
 * (survives GH Actions ephemeral runners via git commit) AND the public
 * feed stocksbyvarsha consumes.
 */
function saveBook(book: Book): void {
  fs.mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true })
  const out = {
    ...book,
    generatedAt: new Date().toISOString(),
    daysRunning: isoDaysDiff(book.startedAt, todayIST()),
    allTradesCount: book.trades.length,
    // Also expose split views for consumers that prefer them
    openTrades: book.trades.filter(t => t.status === 'OPEN' || /^T[12]_HIT$/.test(t.status)),
    closedTrades: book.trades.filter(t => t.status === 'SL_HIT' || t.status === 'T3_HIT' || t.status === 'TIME_STOP' || t.status === 'CLOSED').slice(-100),
  }
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(out, null, 2), 'utf-8')
}

// ─── Position sizing ────────────────────────────────────────────────

function computeQty(entry: number, stopLoss: number, tier: 'ELITE' | 'STRONG', bookValue: number, cash: number): number {
  if (entry <= 0 || stopLoss <= 0) return 0
  const riskPerShare = Math.abs(entry - stopLoss)
  if (riskPerShare <= 0) return 0

  // 1. Risk-based cap: risk per trade ≤ 1% of book value
  const maxRiskInr = bookValue * RULES.riskPerTradePct
  const riskBasedQty = Math.floor(maxRiskInr / riskPerShare)

  // 2. Tier-based target: 15% of book (ELITE) or 8% (STRONG)
  const tierAllocInr = bookValue * RULES.tierAlloc[tier]
  const tierBasedQty = Math.floor(tierAllocInr / entry)

  // 3. Position cap: 20% of book value (single-name concentration)
  const capInr = bookValue * RULES.positionCapPct
  const capBasedQty = Math.floor(capInr / entry)

  // 4. Cash-available cap
  const cashBasedQty = Math.floor(cash / entry)

  return Math.max(0, Math.min(riskBasedQty, tierBasedQty, capBasedQty, cashBasedQty))
}

// ─── Trade opening ──────────────────────────────────────────────────

const COMMODITY_SNAPSHOT_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'commodity-signals.json')
const NIFTY_OUTLOOK_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'nifty-outlook.json')
const OPTIONS_RADAR_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'options-radar.json')
// Additional signal sources — extend the book's universe beyond just HQS
// so all engines' output can actually make the book money.
const CHART_PATTERNS_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'chart-patterns.json')
const HARMONIC_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'harmonic.json')
const ELLIOTT_WAVE_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'elliott-wave.json')
const FNO_FUTURES_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'fno-futures.json')
const STOCK_FNO_VP_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'stock-fno-volume-profile.json')

/**
 * Gather candidate signals across all three segments, tag them with the
 * segment their allocation comes from, then filter + size per segment budget.
 */
// F&O eligibility check — cached for the tick. NIFTY-Angel scrip master
// carries the FUTSTK entries; anything appearing there is F&O eligible.
let _fnoEligibleCache: Set<string> | null = null
async function isFnoEligible(symbol: string): Promise<boolean> {
  if (!_fnoEligibleCache) {
    _fnoEligibleCache = new Set<string>()
    try {
      const angel = await import('../data/angel')
      const sm = await angel.loadScripMaster()
      if (sm) {
        for (const s of sm) {
          if (s.exch_seg === 'NFO' && s.instrumenttype === 'FUTSTK' && s.name) {
            _fnoEligibleCache.add(s.name.toUpperCase())
          }
        }
      }
    } catch { /* if Angel fails, treat everything as CASH */ }
    // Always include indices
    _fnoEligibleCache.add('NIFTY').add('BANKNIFTY').add('FINNIFTY').add('MIDCPNIFTY').add('SENSEX')
  }
  return _fnoEligibleCache.has(symbol.toUpperCase())
}

/**
 * Normalise a row from any engine snapshot into the paper-book candidate
 * shape. Returns null if the row is unusable (missing entry/SL/targets).
 */
function normaliseCandidate(row: any, source: string, defaultTier?: 'ELITE' | 'STRONG'): any | null {
  if (!row || !row.symbol) return null
  if (!row.entry || !row.stopLoss || !row.target1) return null
  // Score fallback chain: score → conviction → confidence numeric → compositeStrength
  const score = row.score ?? row.conviction ?? row.compositeStrength ??
                (typeof row.confidence === 'number' ? row.confidence : undefined) ?? 0
  const numericScore = Number(score)
  if (!Number.isFinite(numericScore) || numericScore <= 0) return null
  // Tier from score if not present
  const tier: 'ELITE' | 'STRONG' | 'DECENT' =
    row.tier ?? (numericScore >= 80 ? 'ELITE' : numericScore >= 60 ? 'STRONG' : 'DECENT')
  const side = String(row.direction ?? row.side ?? 'BUY').toUpperCase()
  return {
    symbol: row.symbol,
    side, direction: side,
    source,
    tier: defaultTier ?? tier,
    score: numericScore,
    ltp: row.ltp ?? row.entry,
    entry: row.entry,
    stopLoss: row.stopLoss,
    target1: row.target1,
    target2: row.target2 ?? row.target1,
    target3: row.target3 ?? row.target2 ?? row.target1,
    entryDate: row.entryDate,
    target1Date: row.target1Date,
    target2Date: row.target2Date,
    target3Date: row.target3Date,
    slDate: row.slDate,
    shareholdingNote: row.shareholdingNote,
    marketCapCr: row.marketCapCr,
    reasoning: Array.isArray(row.reasons) ? row.reasons : Array.isArray(row.reasoning) ? row.reasoning : [],
    unifiedReason: typeof row.unifiedReason === 'string' ? row.unifiedReason :
                   (row.unifiedReason?.collapsed ?? row.pattern ?? row.setup ?? ''),
    pattern: row.pattern,
  }
}

async function gatherCandidates(): Promise<Array<any & { _segment: 'CASH' | 'FNO' | 'MCX' }>> {
  const out: any[] = []
  const seen = new Set<string>()   // dedup by (symbol, source-family) so same signal from HQS + raw engine doesn't double-count

  const push = async (c: any, seg?: 'CASH' | 'FNO' | 'MCX') => {
    if (!c || !c.symbol) return
    const key = `${c.symbol}-${c.side}`
    if (seen.has(key)) return
    seen.add(key)
    // Auto-classify segment if not provided (async F&O eligibility check)
    let _segment = seg
    if (!_segment) _segment = (await isFnoEligible(c.symbol)) ? 'FNO' : 'CASH'
    out.push({ ...c, _segment, segment: _segment })
  }

  // ─── HQS (existing) — vp-fib + pro-edge + cross-confluence + weekly/daily
  if (fs.existsSync(HQS_SNAPSHOT_FILE)) {
    try {
      const hqs = JSON.parse(fs.readFileSync(HQS_SNAPSHOT_FILE, 'utf-8'))
      for (const c of (hqs.cash ?? [])) await push({ ...c, _segment: 'CASH' }, 'CASH')
      for (const c of (hqs.fno ?? [])) await push({ ...c, _segment: 'FNO' }, 'FNO')
    } catch (e) { log.warn('PAPER', `HQS read failed: ${(e as Error).message}`) }
  }

  // ─── Chart Patterns (193 signals typical) — segment inferred from F&O eligibility
  if (fs.existsSync(CHART_PATTERNS_FILE)) {
    try {
      const cp = JSON.parse(fs.readFileSync(CHART_PATTERNS_FILE, 'utf-8'))
      let added = 0
      for (const r of (cp.rows ?? [])) {
        // Chart-patterns uses `confidence` as a string label sometimes;
        // treat "HIGH" as 85, "MEDIUM" as 70, "LOW" as 55
        const conf = typeof r.confidence === 'string'
          ? (r.confidence === 'HIGH' ? 85 : r.confidence === 'MEDIUM' ? 70 : 55)
          : (r.confidence ?? r.score ?? 0)
        const norm = normaliseCandidate({ ...r, score: conf }, 'CHART-PATTERN')
        if (norm && norm.score >= 70) { await push(norm); added++ }
      }
      if (added > 0) log.info('PAPER', `+${added} chart-pattern candidates`)
    } catch (e) { log.warn('PAPER', `chart-patterns read failed: ${(e as Error).message}`) }
  }

  // ─── Harmonic (74 signals typical) — CASH/FNO by eligibility
  if (fs.existsSync(HARMONIC_FILE)) {
    try {
      const h = JSON.parse(fs.readFileSync(HARMONIC_FILE, 'utf-8'))
      let added = 0
      for (const r of (h.rows ?? [])) {
        const norm = normaliseCandidate(r, 'HARMONIC')
        if (norm && norm.score >= 70) { await push(norm); added++ }
      }
      if (added > 0) log.info('PAPER', `+${added} harmonic candidates`)
    } catch (e) { log.warn('PAPER', `harmonic read failed: ${(e as Error).message}`) }
  }

  // ─── Elliott Wave (25 signals typical)
  if (fs.existsSync(ELLIOTT_WAVE_FILE)) {
    try {
      const ew = JSON.parse(fs.readFileSync(ELLIOTT_WAVE_FILE, 'utf-8'))
      let added = 0
      for (const r of (ew.rows ?? [])) {
        const norm = normaliseCandidate(r, 'ELLIOTT-WAVE')
        if (norm && norm.score >= 70) { await push(norm); added++ }
      }
      if (added > 0) log.info('PAPER', `+${added} elliott-wave candidates`)
    } catch (e) { log.warn('PAPER', `elliott-wave read failed: ${(e as Error).message}`) }
  }

  // ─── F&O Futures scanner (25 signals typical) — always FNO segment
  if (fs.existsSync(FNO_FUTURES_FILE)) {
    try {
      const fno = JSON.parse(fs.readFileSync(FNO_FUTURES_FILE, 'utf-8'))
      let added = 0
      for (const r of (fno.rows ?? [])) {
        const conf = typeof r.confidence === 'string'
          ? (r.confidence === 'HIGH' ? 85 : r.confidence === 'MEDIUM' ? 70 : 55)
          : (r.confidence ?? r.score ?? 0)
        const norm = normaliseCandidate({ ...r, score: conf }, 'FNO-FUTURES')
        if (norm && norm.score >= 70) { await push(norm, 'FNO'); added++ }
      }
      if (added > 0) log.info('PAPER', `+${added} fno-futures candidates`)
    } catch (e) { log.warn('PAPER', `fno-futures read failed: ${(e as Error).message}`) }
  }

  // ─── Stock F&O Volume Profile scanner (191 signals typical) — FNO segment
  if (fs.existsSync(STOCK_FNO_VP_FILE)) {
    try {
      const svp = JSON.parse(fs.readFileSync(STOCK_FNO_VP_FILE, 'utf-8'))
      let added = 0
      for (const r of (svp.rows ?? [])) {
        const norm = normaliseCandidate({ ...r, score: r.compositeStrength }, 'STOCK-FNO-VP')
        if (norm && norm.score >= 70) { await push(norm, 'FNO'); added++ }
      }
      if (added > 0) log.info('PAPER', `+${added} stock-fno-vp candidates`)
    } catch (e) { log.warn('PAPER', `stock-fno-vp read failed: ${(e as Error).message}`) }
  }
  // MCX — commodity signals from dedicated scanner (Gold/XAUUSD/Silver/Crude/NatGas/Copper)
  if (fs.existsSync(COMMODITY_SNAPSHOT_FILE)) {
    try {
      const mcx = JSON.parse(fs.readFileSync(COMMODITY_SNAPSHOT_FILE, 'utf-8'))
      for (const c of (mcx.rows ?? [])) out.push({ ...c, _segment: 'MCX' })
    } catch (e) { log.warn('PAPER', `commodity-signals read failed: ${(e as Error).message}`) }
  }
  // Options Accumulation Radar — the "smart-money BEFORE the move" feed.
  // Every signal is a specific (underlying, expiry, strike, side) with a
  // premium-based trade plan (entry/SL/T1/T2/T3 all in ₹ premium). Route
  // to FNO segment. ELITE (score ≥ 75) only; STRONG needs multi-tick
  // confirmation before we commit real paper capital.
  if (fs.existsSync(OPTIONS_RADAR_FILE)) {
    try {
      const rad = JSON.parse(fs.readFileSync(OPTIONS_RADAR_FILE, 'utf-8'))
      for (const s of (rad.signals ?? [])) {
        if (s.strikeScore < 75) continue                      // ELITE only for radar signals
        const symbol = `${s.underlying}-${s.strike}-${s.side}-${(s.expiry ?? '').replace(/[^A-Z0-9]/gi, '')}`
        out.push({
          symbol,
          underlying: s.underlying,
          _segment: 'FNO',
          segment: 'FNO',
          side: s.side === 'CE' ? 'LONG' : 'LONG',            // Always LONG (buying the option)
          direction: 'LONG',
          source: 'OPT-RADAR',
          tier: 'ELITE',
          stars: 5,
          score: s.strikeScore,
          ltp: s.currentLTP,
          entry: s.entry,
          stopLoss: s.stopLoss,
          target1: s.target1,
          target2: s.target2,
          target3: s.target3,
          entryDate: todayIST(),
          reasoning: s.reasoning,
          unifiedReason: `🎯 OPT RADAR · ${s.underlying} ${s.strike} ${s.side} ${s.expiry} · score ${s.strikeScore} · ${s.bias} · ${s.unifiedReason}`,
          isOption: true,                                     // sizing hint for computeQty
        })
      }
    } catch (e) { log.warn('PAPER', `options-radar read failed: ${(e as Error).message}`) }
  }
  // NIFTY Index Options — routed to FNO segment. NIFTY foresight emits a
  // single directional trade plan per tick (side + entry + SL + T1/T2/T3).
  // We take it only when confidence is HIGH or MEDIUM; conviction < that
  // is the engine explicitly saying "wait — I don't have a strong read."
  if (fs.existsSync(NIFTY_OUTLOOK_FILE)) {
    try {
      const nout = JSON.parse(fs.readFileSync(NIFTY_OUTLOOK_FILE, 'utf-8'))
      const tp = nout?.tradePlan
      if (tp && (nout.confidence === 'HIGH' || nout.confidence === 'MEDIUM')) {
        const side = String(tp.side ?? '').toUpperCase()
        out.push({
          symbol: `NIFTY-${(tp.instrument || '').replace(/\s+/g, '-').slice(0, 40)}`,
          underlying: 'NIFTY',
          _segment: 'FNO',
          segment: 'FNO',
          side: side === 'SELL' || side === 'SHORT' ? 'SHORT' : 'LONG',
          direction: side,
          source: 'NIFTY-FORESIGHT',
          tier: nout.confidence === 'HIGH' ? 'ELITE' : 'STRONG',
          stars: nout.confidence === 'HIGH' ? 5 : 3,
          score: nout.confidence === 'HIGH' ? 90 : 75,
          ltp: tp.entry,
          entry: tp.entry,
          stopLoss: tp.stopLoss,
          target1: tp.target1,
          target2: tp.target2,
          target3: tp.target3,
          entryDate: tp.entryDate,
          target1Date: tp.target1Date,
          target2Date: tp.target2Date,
          target3Date: tp.target3Date,
          slDate: tp.slDate,
          reasoning: Array.isArray(nout.reasoning) ? nout.reasoning.slice(0, 6) : [],
          unifiedReason: `NIFTY Foresight · ${nout.direction} · ${nout.confidence} · ${tp.instrument}`,
        })
      }
    } catch (e) { log.warn('PAPER', `nifty-outlook read failed: ${(e as Error).message}`) }
  }
  return out
}

async function scanForNewTrades(book: Book): Promise<TradeEntry[]> {
  const candidates = await gatherCandidates()
  if (candidates.length === 0) {
    log.warn('PAPER', 'no candidates from HQS or commodity-signals — skipping open pass')
    return []
  }

  const openTrades = book.trades.filter(t => t.status === 'OPEN' || /^T[12]_HIT$/.test(t.status))
  const openSymbols = new Set(openTrades.map(t => t.symbol))
  const perSegmentOpenCount: Record<'CASH' | 'FNO' | 'MCX', number> = { CASH: 0, FNO: 0, MCX: 0 }
  const perSegmentDeployed: Record<'CASH' | 'FNO' | 'MCX', number> = { CASH: 0, FNO: 0, MCX: 0 }
  for (const t of openTrades) {
    perSegmentOpenCount[t.segment]++
    perSegmentDeployed[t.segment] += t.remainingQty * t.entryPrice
  }
  const totalOpen = openTrades.length

  const bookValue = book.ledger.bookValue
  const availableCash = book.ledger.currentCash
  const opened: TradeEntry[] = []
  const now = todayIST()
  const time = nowTimeIST()

  // Compute per-segment budget remaining
  const segmentBudget: Record<'CASH' | 'FNO' | 'MCX', number> = {
    CASH: bookValue * SEGMENT_TARGET_PCT.CASH - perSegmentDeployed.CASH,
    FNO:  bookValue * SEGMENT_TARGET_PCT.FNO  - perSegmentDeployed.FNO,
    MCX:  bookValue * SEGMENT_TARGET_PCT.MCX  - perSegmentDeployed.MCX,
  }

  // Sort candidates highest score first — the best signals fill first
  const sorted = candidates.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  for (const c of sorted) {
    if (opened.length + totalOpen >= RULES.maxConcurrentPositions) break
    const seg = c._segment as 'CASH' | 'FNO' | 'MCX'

    // Per-segment concurrent-position cap
    if (perSegmentOpenCount[seg] + opened.filter(t => t.segment === seg).length >= (RULES.maxPerSegment as any)[seg]) continue

    // Quality gates
    if (c.tier !== 'ELITE' && c.tier !== 'STRONG') continue
    if (isEtfSymbol(c.symbol)) continue
    if (openSymbols.has(c.symbol)) continue
    if (!c.entry || !c.stopLoss) continue

    // CASH gates: MC ≥ ₹500 Cr, pledge < 20%, LONG only
    if (seg === 'CASH') {
      const mc = c.marketCapCr ?? parseShareholdingMc(c.shareholdingNote)
      if (mc !== undefined && mc < RULES.minMarketCapCr) continue
      const pledge = parseShareholdingPledge(c.shareholdingNote)
      if (pledge !== undefined && pledge >= RULES.maxPledgePct) continue
      if (c.direction === 'SHORT' || c.side === 'SHORT') continue
    }
    // FNO gates: MC ≥ ₹500 Cr, pledge < 20% (but allow SHORT — it's derivatives)
    if (seg === 'FNO') {
      const mc = c.marketCapCr ?? parseShareholdingMc(c.shareholdingNote)
      if (mc !== undefined && mc < RULES.minMarketCapCr) continue
      const pledge = parseShareholdingPledge(c.shareholdingNote)
      if (pledge !== undefined && pledge >= RULES.maxPledgePct) continue
    }
    // MCX: no shareholding gate (commodities don't have that concept)

    // Segment budget remaining
    if (segmentBudget[seg] <= 0) continue

    // Determine direction — cash is LONG, FNO/MCX honour signal side
    const dirRaw = String(c.side ?? c.direction ?? 'LONG').toUpperCase()
    const direction: 'LONG' | 'SHORT' = dirRaw === 'SHORT' || dirRaw === 'SELL' || dirRaw === 'BEARISH' ? 'SHORT' : 'LONG'

    // Confidence-scaled sizing — HIGHER SCORE = HIGHER QUANTITY.
    //   Previously flat 15% ELITE / 8% STRONG; now scales linearly within
    //   the tier band so a score-95 ELITE gets 2x the qty of a score-60
    //   STRONG. User directive: "higher the confidence higher the quantity".
    //
    //   Stocks (Cash / F&O eligibles / MCX futures):
    //     score 100 →  20% of book
    //     score  90 →  17%
    //     score  80 →  15%
    //     score  70 →  10%
    //     score  60 →   7%
    //     Below 60  →  skipped upstream
    //
    //   Options (OPT-RADAR / NIFTY-FORESIGHT) — smaller because options can
    //     go to zero. Multiple small trades > one big bet.
    //     score 100 →   8% of book
    //     score  90 →   6.5%
    //     score  80 →   5%
    //     score  75 →   4%
    //     Below 75  →  skipped upstream
    const segBudgetLeft = segmentBudget[seg]
    const isOptionRow = c.isOption === true || c.source === 'OPT-RADAR' || c.source === 'NIFTY-FORESIGHT'
    const confidenceScale = (score: number, isOption: boolean): number => {
      const s = Math.max(60, Math.min(100, Number(score) || 60))
      if (isOption) {
        // Options: linear 60→75 gets nothing, 75→100 maps to 4%→8%
        if (s < 75) return 0
        return 0.04 + (s - 75) / 25 * 0.04
      }
      // Stocks: linear 60→100 maps to 7% → 20%
      return 0.07 + (s - 60) / 40 * 0.13
    }
    const scaledAllocPct = confidenceScale(c.score, isOptionRow)
    if (scaledAllocPct <= 0) continue
    const tierAllocInr = Math.min(segBudgetLeft, bookValue * scaledAllocPct)
    const availableAfter = availableCash - opened.reduce((s, t) => s + t.positionValue, 0)
    const qty = computeQtyWithSegCap(c.entry, c.stopLoss, c.tier as 'ELITE' | 'STRONG', bookValue, availableAfter, tierAllocInr)
    if (qty <= 0) continue

    const positionValue = qty * c.entry
    const riskAmount = qty * Math.abs(c.entry - c.stopLoss)

    const trade: TradeEntry = {
      id: `${c.symbol}-${now}-${direction}`,
      symbol: c.symbol,
      segment: seg,
      direction,
      source: c.source,
      tier: c.tier,
      score: c.score,
      entryDate: now,
      entryTime: time,
      entryPrice: c.entry,
      qty,
      remainingQty: qty,
      positionValue,
      riskAmount,
      stopLoss: c.stopLoss,
      target1: c.target1,
      target2: c.target2,
      target3: c.target3,
      entryReason: c.unifiedReason ?? (Array.isArray(c.reasoning) ? c.reasoning.join(' · ') : ''),
      shareholdingNote: c.shareholdingNote,
      marketCapCr: c.marketCapCr,
      status: 'OPEN',
      exits: [],
      daysHeld: 0,
      totalRealisedPnl: 0,
      unrealisedPnl: 0,
      totalPnl: 0,
      returnPct: 0,
    }
    opened.push(trade)
    openSymbols.add(c.symbol)
    segmentBudget[seg] -= positionValue

    // ─── Hedge construction ─────────────────────────────────────────
    // For option trades (OPT-RADAR / NIFTY-FORESIGHT), open a small
    // opposite-side tail hedge sized ~25% of the primary. Reduces max
    // loss from ~100% (option → 0) to ~65% because the hedge profits
    // when the primary goes to zero. User directive: "best way is to
    // trade with hedge — this way we can make huge money".
    //
    // Hedge parameters:
    //   qty        = ceil(primary_qty * 0.25)
    //   entry      = ~40% of primary premium (rough 3-5% OTM proxy)
    //   SL         = 50% of hedge premium (hedge is cheap → wide SL OK)
    //   T1/T2/T3   = 100%, 200%, 400% (tail hedge only pays when things go wrong)
    if (isOptionRow && qty > 0) {
      const hedgeQty = Math.max(1, Math.ceil(qty * 0.25))
      const hedgePremium = Math.max(1, c.entry * 0.4)
      const hedgePositionValue = hedgeQty * hedgePremium
      const hedgeSegBudgetLeft = segmentBudget[seg]
      if (hedgePositionValue > 0 && hedgePositionValue <= hedgeSegBudgetLeft && hedgePositionValue <= (availableCash - opened.reduce((s, t) => s + t.positionValue, 0))) {
        const hedgeSide = c.source === 'OPT-RADAR' && c.symbol.includes('-CE-') ? 'PE'
                         : c.source === 'OPT-RADAR' && c.symbol.includes('-PE-') ? 'CE'
                         : direction === 'LONG' ? 'PE' : 'CE'
        const hedgeSymbol = `${trade.symbol}-HEDGE-${hedgeSide}`
        const hedgeTrade: TradeEntry = {
          id: `${hedgeSymbol}-${now}-LONG`,
          symbol: hedgeSymbol,
          segment: seg,
          direction: 'LONG',
          source: `${c.source}-HEDGE`,
          tier: c.tier,
          score: c.score,
          entryDate: now,
          entryTime: time,
          entryPrice: hedgePremium,
          qty: hedgeQty,
          remainingQty: hedgeQty,
          positionValue: hedgePositionValue,
          riskAmount: hedgeQty * hedgePremium * 0.5,
          stopLoss: hedgePremium * 0.5,
          target1: hedgePremium * 2,      // +100%
          target2: hedgePremium * 3,      // +200%
          target3: hedgePremium * 5,      // +400%
          entryReason: `🛡 TAIL HEDGE for ${trade.symbol} · pays if primary goes to zero · sized 25% of primary`,
          status: 'OPEN',
          exits: [],
          daysHeld: 0,
          totalRealisedPnl: 0,
          unrealisedPnl: 0,
          totalPnl: 0,
          returnPct: 0,
        }
        opened.push(hedgeTrade)
        segmentBudget[seg] -= hedgePositionValue
      }
    }
  }
  log.info('PAPER', `opened ${opened.length} · CASH ${opened.filter(t => t.segment === 'CASH').length} · FNO ${opened.filter(t => t.segment === 'FNO').length} · MCX ${opened.filter(t => t.segment === 'MCX').length}`)
  return opened
}

/**
 * Sizing variant with an explicit tier/segment cap in ₹ — used when the
 * segment budget or tier target is smaller than the default 15/8% weights.
 */
function computeQtyWithSegCap(entry: number, stopLoss: number, tier: 'ELITE' | 'STRONG', bookValue: number, cash: number, segCapInr: number): number {
  if (entry <= 0 || stopLoss <= 0) return 0
  const riskPerShare = Math.abs(entry - stopLoss)
  if (riskPerShare <= 0) return 0
  const maxRiskInr = bookValue * RULES.riskPerTradePct
  const riskBasedQty = Math.floor(maxRiskInr / riskPerShare)
  const segBasedQty = Math.floor(segCapInr / entry)
  const capBasedQty = Math.floor((bookValue * RULES.positionCapPct) / entry)
  const cashBasedQty = Math.floor(cash / entry)
  // Suppress unused-var warning while keeping the same tier-aware sizing helper API
  void tier
  return Math.max(0, Math.min(riskBasedQty, segBasedQty, capBasedQty, cashBasedQty))
}

// ─── Exit management ────────────────────────────────────────────────

async function markToMarketAndExit(trade: TradeEntry): Promise<void> {
  // Pull recent daily candles to detect T/SL touches since entry. Use the
  // underlying symbol for MCX rows (they carry an `underlying` key when
  // the display symbol has a suffix like "-MCX").
  const fetchKey = (trade as any).underlying ?? trade.symbol.replace('-MCX', '')
  const candles: Candle[] = await getCandles(fetchKey, '1D', 30).catch(() => [])
  if (candles.length === 0) return

  const entryEndMs = new Date(trade.entryDate + 'T23:59:59+05:30').getTime()
  const barsSinceEntry = candles.filter(c => c.time > entryEndMs)
  const isShort = trade.direction === 'SHORT'
  if (barsSinceEntry.length === 0) {
    const lastAvailable = candles[candles.length - 1]
    const pnlPerUnit = isShort ? (trade.entryPrice - lastAvailable.close) : (lastAvailable.close - trade.entryPrice)
    trade.unrealisedPnl = trade.remainingQty * pnlPerUnit
    trade.totalPnl = trade.totalRealisedPnl + trade.unrealisedPnl
    trade.returnPct = trade.positionValue > 0 ? (trade.totalPnl / trade.positionValue) * 100 : 0
    return
  }

  // Walk each bar chronologically; for LONG check T1 → T2 → T3 (bar.high) and
  // SL on bar.low. For SHORT the sign flips: SL is bar.high >= stopLoss (SL
  // is above entry), targets are bar.low <= target (targets are below entry).
  for (const bar of barsSinceEntry) {
    if (trade.remainingQty <= 0) break
    const barDate = new Date(bar.time + 5.5 * 3600_000).toISOString().slice(0, 10)

    // SL check (direction-aware)
    const slHit = isShort ? (bar.high >= trade.stopLoss) : (bar.low <= trade.stopLoss)
    if (slHit && !trade.exits.some(e => e.reason === 'SL_HIT')) {
      const exitQty = trade.remainingQty
      const pnl = (isShort ? (trade.entryPrice - trade.stopLoss) : (trade.stopLoss - trade.entryPrice)) * exitQty
      trade.exits.push({ date: barDate, price: trade.stopLoss, qty: exitQty, reason: 'SL_HIT', pnl })
      trade.remainingQty = 0
      trade.totalRealisedPnl += pnl
      trade.status = 'SL_HIT'
      break
    }
    // T1 partial (direction-aware)
    const t1Hit = isShort ? (bar.low <= trade.target1) : (bar.high >= trade.target1)
    if (t1Hit && !trade.exits.some(e => e.reason === 'T1_HIT')) {
      const t1Qty = Math.floor(trade.qty * RULES.exitPartials.T1)
      const exitQty = Math.min(t1Qty, trade.remainingQty)
      const pnl = (isShort ? (trade.entryPrice - trade.target1) : (trade.target1 - trade.entryPrice)) * exitQty
      trade.exits.push({ date: barDate, price: trade.target1, qty: exitQty, reason: 'T1_HIT', pnl })
      trade.remainingQty -= exitQty
      trade.totalRealisedPnl += pnl
      trade.status = 'T1_HIT'
    }
    // T2 partial (direction-aware)
    const t2Hit = isShort ? (bar.low <= trade.target2) : (bar.high >= trade.target2)
    if (t2Hit && !trade.exits.some(e => e.reason === 'T2_HIT')) {
      const t2Qty = Math.floor(trade.qty * RULES.exitPartials.T2)
      const exitQty = Math.min(t2Qty, trade.remainingQty)
      const pnl = (isShort ? (trade.entryPrice - trade.target2) : (trade.target2 - trade.entryPrice)) * exitQty
      trade.exits.push({ date: barDate, price: trade.target2, qty: exitQty, reason: 'T2_HIT', pnl })
      trade.remainingQty -= exitQty
      trade.totalRealisedPnl += pnl
      trade.status = 'T2_HIT'
    }
    // T3 final exit (direction-aware)
    const t3Hit = isShort ? (bar.low <= trade.target3) : (bar.high >= trade.target3)
    if (t3Hit && trade.remainingQty > 0) {
      const exitQty = trade.remainingQty
      const pnl = (isShort ? (trade.entryPrice - trade.target3) : (trade.target3 - trade.entryPrice)) * exitQty
      trade.exits.push({ date: barDate, price: trade.target3, qty: exitQty, reason: 'T3_HIT', pnl })
      trade.remainingQty = 0
      trade.totalRealisedPnl += pnl
      trade.status = 'T3_HIT'
      break
    }
  }

  // Time stop: if no T1 hit after RULES.timeStopBars bars, exit at last close
  if (trade.remainingQty > 0 && barsSinceEntry.length >= RULES.timeStopBars && !trade.exits.some(e => /^T[123]_HIT$/.test(e.reason))) {
    const lastBar = barsSinceEntry[barsSinceEntry.length - 1]
    const lastDate = new Date(lastBar.time + 5.5 * 3600_000).toISOString().slice(0, 10)
    const exitQty = trade.remainingQty
    const pnl = (isShort ? (trade.entryPrice - lastBar.close) : (lastBar.close - trade.entryPrice)) * exitQty
    trade.exits.push({ date: lastDate, price: lastBar.close, qty: exitQty, reason: 'TIME_STOP', pnl })
    trade.remainingQty = 0
    trade.totalRealisedPnl += pnl
    trade.status = 'TIME_STOP'
  }

  // Mark-to-market on the leftover qty (direction-aware)
  const lastClose = barsSinceEntry[barsSinceEntry.length - 1].close
  const perUnit = isShort ? (trade.entryPrice - lastClose) : (lastClose - trade.entryPrice)
  trade.unrealisedPnl = trade.remainingQty * perUnit
  trade.totalPnl = trade.totalRealisedPnl + trade.unrealisedPnl
  trade.returnPct = trade.positionValue > 0 ? (trade.totalPnl / trade.positionValue) * 100 : 0
  trade.daysHeld = barsSinceEntry.length
}

// ─── Book roll-up ───────────────────────────────────────────────────

function recomputeLedgerAndPerf(book: Book): void {
  let realised = 0, unrealised = 0, openValue = 0
  let wins = 0, losses = 0
  let winPctSum = 0, lossPctSum = 0
  let biggestWin = 0, biggestLoss = 0
  let daysHeldSum = 0, closedCount = 0

  for (const t of book.trades) {
    realised += t.totalRealisedPnl
    unrealised += t.unrealisedPnl
    if (t.status === 'OPEN' || /^T[12]_HIT$/.test(t.status)) {
      // Currently held remaining qty × current mark ≈ entry + unrealised
      openValue += t.remainingQty * (t.entryPrice + (t.remainingQty > 0 ? t.unrealisedPnl / t.remainingQty : 0))
    } else {
      closedCount++
      daysHeldSum += t.daysHeld
      if (t.totalPnl > 0) {
        wins++
        winPctSum += t.returnPct
        if (t.totalPnl > biggestWin) biggestWin = t.totalPnl
      } else if (t.totalPnl < 0) {
        losses++
        lossPctSum += t.returnPct
        if (t.totalPnl < biggestLoss) biggestLoss = t.totalPnl
      }
    }
  }

  const cashAdjustment = book.trades.reduce((s, t) => s - t.positionValue + (t.totalRealisedPnl + t.qty * t.entryPrice - t.remainingQty * t.entryPrice), 0)
  // Cash flow ledger:
  //   -positionValue when opened, +(exited qty × exit price) as exits happen.
  //   Equivalent: cash = startingCapital + totalRealisedPnl - sum(remainingQty × entryPrice)
  const stillHeldValueAtEntry = book.trades.reduce((s, t) => s + t.remainingQty * t.entryPrice, 0)
  const cash = book.startingCapital + realised - stillHeldValueAtEntry
  const openMarkValue = book.trades.reduce((s, t) => s + t.remainingQty * (t.entryPrice + (t.remainingQty > 0 ? t.unrealisedPnl / t.remainingQty : 0)), 0)
  const bookValue = cash + openMarkValue

  book.ledger = {
    startingCapital: book.startingCapital,
    currentCash: Math.round(cash * 100) / 100,
    openPositionsValue: Math.round(openMarkValue * 100) / 100,
    totalRealisedPnl: Math.round(realised * 100) / 100,
    totalUnrealisedPnl: Math.round(unrealised * 100) / 100,
    bookValue: Math.round(bookValue * 100) / 100,
    totalReturnPct: Math.round(((bookValue - book.startingCapital) / book.startingCapital) * 10000) / 100,
  }
  book.performance = {
    totalTrades: book.trades.length,
    openTrades: book.trades.filter(t => t.status === 'OPEN' || /^T[12]_HIT$/.test(t.status)).length,
    closedTrades: closedCount,
    wins, losses,
    winRatePct: wins + losses > 0 ? Math.round((wins / (wins + losses)) * 10000) / 100 : 0,
    avgWinPct: wins > 0 ? Math.round((winPctSum / wins) * 100) / 100 : 0,
    avgLossPct: losses > 0 ? Math.round((lossPctSum / losses) * 100) / 100 : 0,
    biggestWinInr: Math.round(biggestWin * 100) / 100,
    biggestLossInr: Math.round(biggestLoss * 100) / 100,
    avgDaysHeld: closedCount > 0 ? Math.round((daysHeldSum / closedCount) * 100) / 100 : 0,
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * The main daily entrypoint. Called from EOD cron:
 *   1. Loads existing book (or opens fresh with ₹10L)
 *   2. Marks all open positions to market + processes exits
 *   3. Scans for new entries from today's HQS feed
 *   4. Recomputes ledger + performance stats
 *   5. Persists book state + publishes public journal snapshot
 */
export async function runPaperTradingDailyTick(): Promise<Book & { newTradesThisTick?: TradeEntry[] }> {
  const book = loadBook()
  const dayStart = Date.now()

  // 1. Update all existing open positions
  for (const t of book.trades) {
    if (t.status === 'CLOSED' || t.status === 'SL_HIT' || t.status === 'T3_HIT' || t.status === 'TIME_STOP') continue
    try { await markToMarketAndExit(t) }
    catch (e) { log.warn('PAPER', `mark-to-market failed for ${t.symbol}: ${(e as Error).message}`) }
  }

  // 2. Scan for new entries on EVERY intraday tick (options radar signals
  //    fire mid-day when institutional positioning changes — we want the
  //    book to react in real time, not wait for tomorrow). scanForNewTrades
  //    already dedups on symbol so we won't double-open the same trade.
  recomputeLedgerAndPerf(book)   // fresh cash figure first
  const newTrades = await scanForNewTrades(book)
  book.trades.push(...newTrades)
  if (newTrades.length > 0) log.info('PAPER', `opened ${newTrades.length} new positions this tick`)
  // Expose the trades opened THIS tick so the caller (cron) can broadcast
  // them to Telegram + downstream consumers.
  ;(book as any).newTradesThisTick = newTrades

  // 3. Final recompute + persist (same file serves as state + public feed)
  recomputeLedgerAndPerf(book)
  book.lastUpdatedAt = todayIST()
  saveBook(book)

  log.ok('PAPER', `book done in ${((Date.now() - dayStart) / 1000).toFixed(1)}s · value ₹${book.ledger.bookValue.toLocaleString('en-IN')} · return ${book.ledger.totalReturnPct.toFixed(2)}% · open ${book.performance.openTrades} · WR ${book.performance.winRatePct}%`)
  return book
}

/**
 * Reset the book — wipes state, starts fresh with ₹10L. Use this only
 * when you want to restart the 30-day test cleanly.
 */
export function resetBook(): void {
  if (fs.existsSync(JOURNAL_FILE)) fs.unlinkSync(JOURNAL_FILE)
  log.info('PAPER', 'book reset — next tick will start fresh with ₹10L')
}
