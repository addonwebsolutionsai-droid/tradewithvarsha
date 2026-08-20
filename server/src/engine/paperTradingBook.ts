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
  segment: 'FNO' | 'CASH' | 'MCX' | 'OPT'
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
  // ─── Trap-average state (2026-07-29) ─────────────────────────────
  // When SL is touched but the structural setup is intact (higher-TF
  // trend, harmonic X, shareholding, delivery), we AVERAGE in at the
  // hunted price instead of exiting. Tracked here for auditability.
  avgInCount?: number       // # of times we've averaged (cap at 1 per position)
  originalEntry?: number    // preserved so we know the true first buy
  hardInvalidation?: number // when THIS breaks, exit for real (2×ATR below original)
  trapNotes?: string[]      // narrative of trap-check decisions
  // Latest SL Decision Engine verdict — surfaced in /journal so the user
  // sees WHY we held / averaged / exited on each hunt (2026-07-30).
  slVerdict?: {
    action: 'AVERAGE' | 'HOLD' | 'EXIT'
    confidence: number
    humanExplain: string
    at: string
  }
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

// STARTING_CAPITAL bumped to ₹20L on 3 Aug 2026 per user directive:
// "add 10 lakh more capital for future and options trades from f&o trades,
// stocks f&o vp all trade setups with highest accuracy and confidence".
// The extra ₹10L is dedicated to the FNO bucket — stock F&O trades from
// pro-setups + stock-fno-vp + fno-stock-forecast, filtered to Money-Printer
// or MTF-Harmonic or PRO-EDGE ELITE only (highest-accuracy sources).
const STARTING_CAPITAL = 20_00_000

// Segment allocation model — total book value split across four risk buckets.
//   CASH  30% (₹6L)  → high-quality-setups.json (cash tab, LONG only)
//   FNO   50% (₹10L) → F&O stock trades (pro-setups + stock-fno-vp +
//                       fno-stock-forecast) — the ₹10L addition
//   MCX   10% (₹2L)  → commodity-signals.json (Gold/Silver/Crude/NatGas/Copper)
//   OPT   10% (₹2L)  → options-radar.json + nifty-outlook.json options trades
// Cap per position within each segment: 20% of that segment's allocation.
const SEGMENT_TARGET_PCT = {
  CASH: 0.30,
  FNO: 0.50,      // 3 Aug 2026 — was 0.20, doubled per +₹10L F&O allocation
  MCX: 0.10,
  OPT: 0.10,      // new dedicated options bucket
} as const

const RULES = {
  // Per-tier weight within the trade's segment allocation
  tierAlloc: { ELITE: 0.15, STRONG: 0.08 },
  positionCapPct: 0.10,           // 2026-07-28: was 20%. WABAG double-fire
                                  // put 30% of book on one symbol → -₹24K
                                  // loss in 2 days. 10% cap prevents that.
  riskPerTradePct: 0.01,          // 1% of book per trade
  maxConcurrentPositions: 25,     // 3 Aug: raised from 20 to accommodate F&O expansion
  maxPerSegment: { CASH: 8, FNO: 10, MCX: 4, OPT: 6 },   // FNO raised for +₹10L
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

export function loadBook(): Book {
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
const FNO_FORECAST_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'fno-stock-forecast.json')
// 3 Aug 2026 — new premium sources for the +₹10L F&O bucket
const MONEY_PRINTER_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'money-printer.json')
const MTF_HARMONIC_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'mtf-harmonic.json')
const MASTER_SETUPS_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'master-setups.json')
const ICHIMOKU_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'ichimoku-cloud.json')

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

async function gatherCandidates(): Promise<Array<any & { _segment: 'CASH' | 'FNO' | 'MCX' | 'OPT'; _sourceCount?: number }>> {
  const out: any[] = []
  const firstBySym = new Map<string, any>()      // first-seen candidate wins the trade plan
  const sourceCount = new Map<string, Set<string>>()   // (symbol|side) → set of source families

  const push = async (c: any, seg?: 'CASH' | 'FNO' | 'MCX' | 'OPT') => {
    if (!c || !c.symbol) return
    const key = `${c.symbol}-${c.side}`
    // Track source families for confluence gate (2026-07-28 fix — WABAG
    // was ELITE from PRO-EDGE alone and lost -₹24K on double-fire. Only
    // ≥ 2 distinct sources should earn ELITE tier).
    if (!sourceCount.has(key)) sourceCount.set(key, new Set())
    if (c.source) sourceCount.get(key)!.add(String(c.source).split('-')[0])
    if (firstBySym.has(key)) return
    firstBySym.set(key, c)
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

  // ─── F&O Stock Move Forecaster (85-stock 7-lens universe) — FNO segment.
  //     Uses `score` (0-100) directly. Gated to STRONG+ (score ≥ 50) so
  //     paper book only takes tier-quality forecasts.
  if (fs.existsSync(FNO_FORECAST_FILE)) {
    try {
      const fnc = JSON.parse(fs.readFileSync(FNO_FORECAST_FILE, 'utf-8'))
      let added = 0
      for (const r of (fnc.rows ?? [])) {
        if (r.score < 50) continue
        const norm = normaliseCandidate(r, 'FNO-FORECAST')
        if (norm) {
          norm.observation = r.observation
          norm.bestWayToPlay = r.bestWayToPlay
          await push(norm, 'FNO')
          added++
        }
      }
      if (added > 0) log.info('PAPER', `+${added} fno-forecast candidates`)
    } catch (e) { log.warn('PAPER', `fno-forecast read failed: ${(e as Error).message}`) }
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
  // ─── Money-Printer (3 Aug 2026) — the Moschip/Marksans winning-setup
  //     pattern. Highest-conviction feed. Route to FNO segment (they're
  //     typically F&O-eligible large caps).
  if (fs.existsSync(MONEY_PRINTER_FILE)) {
    try {
      const mp = JSON.parse(fs.readFileSync(MONEY_PRINTER_FILE, 'utf-8'))
      let added = 0
      for (const r of (mp.rows ?? [])) {
        // Score already 70-100 range from money-printer emit
        const norm = normaliseCandidate(r, 'MONEY-PRINTER')
        if (norm && (norm.score ?? 0) >= 70) {
          const seg = await isFnoEligible(norm.symbol) ? 'FNO' : 'CASH'
          await push(norm, seg); added++
        }
      }
      if (added > 0) log.info('PAPER', `+${added} MONEY-PRINTER candidates`)
    } catch (e) { log.warn('PAPER', `money-printer read failed: ${(e as Error).message}`) }
  }
  // ─── MTF-Harmonic (3 Aug 2026) — multi-timeframe harmonic confluence.
  //     Same routing logic — FNO or CASH based on F&O eligibility.
  if (fs.existsSync(MTF_HARMONIC_FILE)) {
    try {
      const mtf = JSON.parse(fs.readFileSync(MTF_HARMONIC_FILE, 'utf-8'))
      let added = 0
      for (const r of (mtf.rows ?? [])) {
        const norm = normaliseCandidate({ ...r, score: r.compositeScore }, 'MTF-HARMONIC')
        if (norm && (norm.score ?? 0) >= 70) {
          const seg = await isFnoEligible(norm.symbol) ? 'FNO' : 'CASH'
          await push(norm, seg); added++
        }
      }
      if (added > 0) log.info('PAPER', `+${added} MTF-HARMONIC candidates`)
    } catch (e) { log.warn('PAPER', `mtf-harmonic read failed: ${(e as Error).message}`) }
  }
  // ─── Ichimoku Cloud (20 Aug 2026) — the SILVERM +68% CE setup pattern.
  //     Only 4/5 or 5/5 signal setups (score ≥ 80). Routes indices to OPT
  //     bucket (options play), stocks to FNO/CASH by eligibility.
  if (fs.existsSync(ICHIMOKU_FILE)) {
    try {
      const ic = JSON.parse(fs.readFileSync(ICHIMOKU_FILE, 'utf-8'))
      let added = 0
      for (const r of (ic.rows ?? [])) {
        if ((r.score ?? 0) < 80) continue
        const isIdx = r.symbol === 'NIFTY' || r.symbol === 'BANKNIFTY' || r.symbol === 'FINNIFTY'
        const norm = normaliseCandidate({ ...r, source: 'ICHIMOKU' }, 'ICHIMOKU')
        if (norm) {
          const seg = isIdx ? 'OPT' : (await isFnoEligible(norm.symbol) ? 'FNO' : 'CASH')
          await push(norm, seg); added++
        }
      }
      if (added > 0) log.info('PAPER', `+${added} ICHIMOKU candidates`)
    } catch (e) { log.warn('PAPER', `ichimoku read failed: ${(e as Error).message}`) }
  }
  // ─── MASTER Setups (3 Aug 2026) — 7-pillar composite. Any MASTER with
  //     score ≥ 75 gets priority; force ELITE tier for these.
  if (fs.existsSync(MASTER_SETUPS_FILE)) {
    try {
      const ms = JSON.parse(fs.readFileSync(MASTER_SETUPS_FILE, 'utf-8'))
      let added = 0
      for (const r of (ms.rows ?? [])) {
        const norm = normaliseCandidate({ ...r, score: r.masterScore, tier: 'ELITE' }, 'MASTER')
        if (norm && (norm.score ?? 0) >= 75) {
          const seg = await isFnoEligible(norm.symbol) ? 'FNO' : 'CASH'
          await push(norm, seg); added++
        }
      }
      if (added > 0) log.info('PAPER', `+${added} MASTER candidates`)
    } catch (e) { log.warn('PAPER', `master-setups read failed: ${(e as Error).message}`) }
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
          // 3 Aug 2026 — options-radar routes to OPT bucket (₹2L dedicated)
          _segment: 'OPT',
          segment: 'OPT',
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
  // Attach confluence count so downstream can gate ELITE-tier
  for (const c of out) {
    const key = `${c.symbol}-${c.side}`
    c._sourceCount = sourceCount.get(key)?.size ?? 1
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
  const perSegmentOpenCount: Record<'CASH' | 'FNO' | 'MCX' | 'OPT', number> = { CASH: 0, FNO: 0, MCX: 0, OPT: 0 }
  const perSegmentDeployed: Record<'CASH' | 'FNO' | 'MCX' | 'OPT', number> = { CASH: 0, FNO: 0, MCX: 0, OPT: 0 }
  for (const t of openTrades) {
    perSegmentOpenCount[t.segment]++
    perSegmentDeployed[t.segment] += t.remainingQty * t.entryPrice
  }

  // ═══ SYMBOL COOL-OFF (3 Aug 2026) — THE MAIN WR KILLER FIX ═══════════
  // Closed-trade analysis revealed the paper book was retaking the same
  // losing signals every day:
  //   GODREJIND × 5 = 5 SL_HITs (-₹36K)
  //   WABAG × 3 = 3 SL_HITs (-₹29K)
  //   SPANDANA × 2 = 2 SL_HITs
  //   UJJIVANSFB × 4 = 4 T3_HITs (win noise stacked too)
  // Real unique-symbol WR was ~1/7 = 14% masked as 4/17 = 23.5%.
  //
  // Rule now:
  //   · SL_HIT within last 15 sessions on this symbol → skip (blacklist)
  //   · ANY exit within last 5 sessions on this symbol → skip (dedup)
  // Prevents both compounding losses AND win-stacking noise. If the
  // setup is real, it'll reappear after the cool-off.
  const nowMsCoolOff = Date.now()
  const SL_BLACKLIST_MS = 15 * 24 * 3600_000
  const RECENT_TRADE_MS = 5 * 24 * 3600_000
  const symbolCoolOffUntil = new Map<string, { until: number; reason: string }>()
  for (const t of book.trades) {
    const lastExitDate = t.exits?.[t.exits.length - 1]?.date
    if (!lastExitDate) continue
    const exitMs = Date.parse(lastExitDate + 'T15:30:00+05:30')
    if (!Number.isFinite(exitMs)) continue
    const isSl = t.status === 'SL_HIT'
    const until = exitMs + (isSl ? SL_BLACKLIST_MS : RECENT_TRADE_MS)
    if (until > nowMsCoolOff) {
      const existing = symbolCoolOffUntil.get(t.symbol)
      if (!existing || until > existing.until) {
        symbolCoolOffUntil.set(t.symbol, {
          until,
          reason: isSl ? `SL_HIT ${lastExitDate} — 15d blacklist` : `closed ${t.status} ${lastExitDate} — 5d dedup`,
        })
      }
    }
  }
  if (symbolCoolOffUntil.size > 0) {
    log.info('PAPER', `SYMBOL cool-off: ${symbolCoolOffUntil.size} symbols currently blacklisted`)
  }
  const totalOpen = openTrades.length

  const bookValue = book.ledger.bookValue
  const availableCash = book.ledger.currentCash
  const opened: TradeEntry[] = []
  const now = todayIST()
  const time = nowTimeIST()

  // Compute per-segment budget remaining
  const segmentBudget: Record<'CASH' | 'FNO' | 'MCX' | 'OPT', number> = {
    CASH: bookValue * SEGMENT_TARGET_PCT.CASH - perSegmentDeployed.CASH,
    FNO:  bookValue * SEGMENT_TARGET_PCT.FNO  - perSegmentDeployed.FNO,
    MCX:  bookValue * SEGMENT_TARGET_PCT.MCX  - perSegmentDeployed.MCX,
    OPT:  bookValue * SEGMENT_TARGET_PCT.OPT  - perSegmentDeployed.OPT,
  }

  // ─── Auto-tune overrides + symbol blacklist enforcement ────────────
  // Reads both `overrides` (per-source minScore) and `symbolBlacklist`
  // (persistent 30d blocks written by daily-improve routine).
  const autoTune: { overrides: Record<string, { minScore?: number }>; symbolBlacklist: Record<string, number> } = (() => {
    try {
      const fsSync = require('fs')
      const pathSync = require('path')
      const raw = fsSync.readFileSync(pathSync.resolve(__dirname, '../../data/auto-tune.json'), 'utf8')
      const j = JSON.parse(raw)
      return {
        overrides: (j?.overrides ?? {}) as Record<string, { minScore?: number }>,
        symbolBlacklist: (j?.symbolBlacklist ?? {}) as Record<string, number>,
      }
    } catch { return { overrides: {}, symbolBlacklist: {} } }
  })()
  const autoTuneOverrides = autoTune.overrides
  const persistentBlacklist = autoTune.symbolBlacklist
  const nowMsBl = Date.now()

  // Sort candidates highest score first — the best signals fill first
  const sorted = candidates.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

  // ─── Daily drawdown circuit-breaker (3 Aug 2026 · user safety rule) ─
  // "Safest and secure way" — if intraday unrealised P&L is < -2% of book
  // value, halt ALL new entries for the rest of the tick. Preserves
  // capital during regime-flip days. Existing open trades still process
  // exits normally (T-hits, SL-decision engine).
  const openUnrealised = openTrades.reduce((s, t) => s + (t.unrealisedPnl ?? 0), 0)
  const drawdownPct = bookValue > 0 ? (openUnrealised / bookValue) * 100 : 0
  if (drawdownPct <= -2) {
    log.warn('PAPER', `🛑 CIRCUIT-BREAKER: intraday drawdown ${drawdownPct.toFixed(2)}% — halting new entries for this tick`)
    return []
  }

  // ─── Regime-aware sizing (30 Jul 2026) ─────────────────────────────
  // Even best signals fail in risk-off tape. We read NIFTY 5d return +
  // sector-rotation breadth (already snapshotted) to derive a regime
  // multiplier. Risk-off halves position size AND raises the tier gate to
  // ELITE-only. Risk-on keeps sizes as computed.
  // Sources — no new fetches: nifty-long-horizon.json (has bias/spot),
  // sector-rotation.json (breadth via % of leading sectors).
  const regime = (() => {
    try {
      const fsSync = require('fs')
      const pathSync = require('path')
      const SNAP = pathSync.resolve(__dirname, '../../data/public-snapshots')
      let nifty5d = 0
      try {
        const nlh = JSON.parse(fsSync.readFileSync(pathSync.join(SNAP, 'nifty-long-horizon.json'), 'utf8'))
        nifty5d = Number(nlh.recentReturn5d ?? nlh.ret5d ?? nlh.ret5D ?? 0)
      } catch { /* ignore */ }
      if (!nifty5d) {
        try {
          const sr = JSON.parse(fsSync.readFileSync(pathSync.join(SNAP, 'sector-rotation.json'), 'utf8'))
          nifty5d = Number(sr.niftyRet5d ?? 0)
        } catch { /* ignore */ }
      }
      // Breadth = fraction of tracked sectors that are LEADING or IMPROVING
      let breadthPct = 50
      try {
        const sr = JSON.parse(fsSync.readFileSync(pathSync.join(SNAP, 'sector-rotation.json'), 'utf8'))
        const rows: any[] = sr.rows ?? []
        if (rows.length > 0) {
          const positive = rows.filter(r => r.trend === 'LEADING' || r.trend === 'IMPROVING').length
          breadthPct = (positive / rows.length) * 100
        }
      } catch { /* ignore */ }
      const riskOff = nifty5d < -2 || breadthPct < 40
      const strongRiskOff = nifty5d < -4 || breadthPct < 25
      const sizeMul = strongRiskOff ? 0.35 : riskOff ? 0.6 : 1.0
      const eliteOnly = strongRiskOff  // block STRONG in strong risk-off
      const label = strongRiskOff ? 'STRONG_RISK_OFF' : riskOff ? 'RISK_OFF' : 'NORMAL'
      log.info('PAPER', `REGIME ${label}: nifty5d=${nifty5d.toFixed(2)}% breadth=${breadthPct.toFixed(0)}% · sizeMul=${sizeMul} eliteOnly=${eliteOnly}`)
      return { label, sizeMul, eliteOnly, nifty5d, breadthPct }
    } catch (e) {
      log.warn('PAPER', `regime detection failed: ${(e as Error).message}`)
      return { label: 'UNKNOWN', sizeMul: 1.0, eliteOnly: false, nifty5d: 0, breadthPct: 50 }
    }
  })()

  // Reverted 2026-07-29: the 5-day SL cool-off was the wrong fix. If the
  // move WAS an SL hunt (like Moschip 212→190→244, VIP Ind 306→270→344,
  // Marksans 179→169→200), we should AVERAGE at the SL, not sit out.
  // The real fix now lives in markToMarketAndExit's trap-check + average
  // logic below. Only kept the per-open-symbol dedup so we don't buy the
  // same symbol twice as a fresh entry — averaging is a separate path.
  for (const c of sorted) {
    if (opened.length + totalOpen >= RULES.maxConcurrentPositions) break
    const seg = c._segment as 'CASH' | 'FNO' | 'MCX' | 'OPT'

    // Per-segment concurrent-position cap
    if (perSegmentOpenCount[seg] + opened.filter(t => t.segment === seg).length >= (RULES.maxPerSegment as any)[seg]) continue

    // Quality gates
    if (c.tier !== 'ELITE' && c.tier !== 'STRONG') continue
    if (regime.eliteOnly && c.tier !== 'ELITE') continue      // regime block: only ELITE in strong risk-off
    if (isEtfSymbol(c.symbol)) continue
    if (openSymbols.has(c.symbol)) continue
    // Symbol cool-off enforcement (3 Aug 2026 dynamic)
    const coolOff = symbolCoolOffUntil.get(c.symbol)
    if (coolOff) {
      log.info('PAPER', `SKIP ${c.symbol}: ${coolOff.reason} · unblocks in ${Math.ceil((coolOff.until - nowMsCoolOff) / 86400_000)}d`)
      continue
    }
    // Persistent blacklist enforcement (from daily-improve routine)
    const blockedUntil = persistentBlacklist[c.symbol]
    if (blockedUntil && blockedUntil > nowMsBl) {
      log.info('PAPER', `SKIP ${c.symbol}: persistent blacklist · unblocks in ${Math.ceil((blockedUntil - nowMsBl) / 86400_000)}d`)
      continue
    }
    if (!c.entry || !c.stopLoss) continue
    // Auto-tune override: source-specific minScore (self-improve loop)
    const srcKey = String(c.source ?? '').toUpperCase()
    const minScoreOverride = autoTuneOverrides[srcKey]?.minScore
    if (minScoreOverride != null && (c.score ?? 0) < minScoreOverride) {
      log.info('PAPER', `SKIP ${c.symbol}: auto-tune ${srcKey} minScore ${minScoreOverride} > ${c.score}`)
      continue
    }

    // Losing-pattern penalty (30 Jul 2026): fetch candles + fingerprint-
    // match against losing-patterns.json. If a proven-loser setup, skip
    // outright unless score is exceptional (≥ 92). Guards against
    // re-taking setups the system has already been burnt on.
    try {
      const dirGuess = (String(c.side ?? c.direction ?? 'LONG').toUpperCase() === 'SHORT' || String(c.side ?? c.direction ?? '').toUpperCase() === 'SELL' || String(c.side ?? c.direction ?? '').toUpperCase() === 'BEARISH') ? 'SHORT' as const : 'BUY' as const
      const cs = await getCandles(c.symbol, '1D' as any, 60).catch(() => [] as Candle[])
      if (cs && cs.length >= 30) {
        const { matchesKnownLoser } = await import('./patternMemory')
        const m = await matchesKnownLoser({ candles: cs, direction: dirGuess })
        if (m.match && (c.score ?? 0) < 92) {
          log.info('PAPER', `SKIP ${c.symbol}: matches known LOSING pattern from ${m.loserSymbol} (dd ${m.drawdown?.toFixed(1)}%) · need score ≥ 92, got ${c.score}`)
          continue
        }
      }
    } catch { /* silent — don't block trades on lookup failure */ }

    // ── Anti-chase filter (30 Jul 2026) ────────────────────────────────
    // If price already extended >8% in last 5d in trade direction, the move
    // is likely spent. Late signals fail hardest. Only applies to stocks.
    const dirEarly = String(c.side ?? c.direction ?? 'LONG').toUpperCase()
    const isShortEarly = dirEarly === 'SHORT' || dirEarly === 'SELL' || dirEarly === 'BEARISH'
    const ret5d = Number(c.ret5d ?? c.pct5d ?? c.change5d ?? 0)
    if (Number.isFinite(ret5d) && ret5d !== 0) {
      if (!isShortEarly && ret5d > 8) { log.info('PAPER', `SKIP ${c.symbol}: chase (5d +${ret5d.toFixed(1)}%)`); continue }
      if (isShortEarly && ret5d < -8) { log.info('PAPER', `SKIP ${c.symbol}: chase-short (5d ${ret5d.toFixed(1)}%)`); continue }
    }

    // ── Correlation cap: max 2 open positions per sector ───────────────
    // Prevents a sector-wide flush from wiping the book. Sector inferred
    // from row.sector, falling back to shareholding note pattern.
    const sec = String(c.sector ?? c.sectorLabel ?? '').toUpperCase().trim()
    if (sec) {
      const sameSector = [
        ...openTrades.filter(t => String((t as any).sector ?? '').toUpperCase() === sec),
        ...opened.filter(t => String((t as any).sector ?? '').toUpperCase() === sec),
      ].length
      if (sameSector >= 2) { log.info('PAPER', `SKIP ${c.symbol}: sector cap (${sec} already has 2)`); continue }
    }

    // ── Volatility-scaled SL sanity (30 Jul 2026) ──────────────────────
    // Reject signals where SL distance is < 0.8× ATR estimate. Too-tight
    // SLs cause premature exits before the setup plays out. ATR proxy =
    // 1.5% of price when we don't have candles at this stage — most
    // liquid names sit around this range. Skip for options.
    const isOptCheck = c.isOption === true || c.source === 'OPT-RADAR' || c.source === 'NIFTY-FORESIGHT'
    if (!isOptCheck) {
      const slDist = Math.abs(c.entry - c.stopLoss)
      const atrProxy = c.atr14 ?? c.entry * 0.015
      if (slDist < atrProxy * 0.8) {
        log.info('PAPER', `SKIP ${c.symbol}: SL too tight (${(slDist/c.entry*100).toFixed(2)}% < 0.8× ATR ${(atrProxy/c.entry*100).toFixed(2)}%)`)
        continue
      }
    }

    // Reject setups where R:R at T1 is < 1.5 — the WABAG loss was on a
    // signal where entry-SL was 6.5% but entry-T1 was only 8%. A 1.2:1
    // R:R is not worth taking after fees + slippage.
    const risk = Math.abs(c.entry - c.stopLoss)
    const reward = Math.abs((c.target1 ?? c.entry) - c.entry)
    if (risk > 0 && reward / risk < 1.5) continue

    // ELITE requires ≥ 2 independent sources (WABAG was PRO-EDGE alone at
    // score 96 and lost twice). Single-source signals get downgraded to
    // STRONG regardless of upstream tier claim; this affects sizing later.
    // Same logic for FNO forecasts derived from a single lens combo.
    const srcCount = c._sourceCount ?? 1
    if (c.tier === 'ELITE' && srcCount < 2) {
      c.tier = 'STRONG'   // downgrade — still tradable but smaller size
      c._downgradeReason = `single-source ELITE downgraded to STRONG (need ≥ 2 confluences)`
    }
    // Reject STRONG signals with SL wider than 8% for stocks — too much
    // book risk per trade; if the SL needs to be that wide the setup
    // isn't tight enough.
    const slPct = risk / c.entry
    if (seg !== 'MCX' && slPct > 0.08) continue

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
    const rawAllocPct = confidenceScale(c.score, isOptionRow)
    const scaledAllocPct = rawAllocPct * regime.sizeMul       // regime multiplier
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
      // Persist sector so correlation cap survives across ticks (30 Jul 2026)
      ...(sec ? { sector: sec } as any : {}),
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

    // ─── F&O FUTURES hedge (3 Aug 2026 · user directive #7) ──────────
    // "For F&O WHY WE ARE NOT TAKING HEDGE BETS?" — every futures LONG
    // gets a protective 3-4% OTM PE at ~15% of position value. Futures
    // SHORT gets a protective OTM CE. Caps max loss on adverse gap.
    // Different from the OPTION hedge above (which is a tail hedge on
    // an already-option trade). This is a futures-side insurance leg.
    if (seg === 'FNO' && !isOptionRow && qty > 0) {
      // Rough option premium proxy for 3-4% OTM = 0.8% of spot
      const hedgePremium = Math.max(1, c.entry * 0.008)
      // Size hedge to spend ~15% of primary futures notional
      const hedgeBudget = positionValue * 0.15
      const hedgeQty = Math.max(1, Math.floor(hedgeBudget / hedgePremium))
      const hedgePositionValue = hedgeQty * hedgePremium
      const availAfterAll = availableCash - opened.reduce((s, t) => s + t.positionValue, 0)
      if (hedgePositionValue > 0 && hedgePositionValue <= segmentBudget[seg] && hedgePositionValue <= availAfterAll) {
        const hedgeSide: 'PE' | 'CE' = direction === 'LONG' ? 'PE' : 'CE'
        const strikeOffset = direction === 'LONG' ? -0.035 : 0.035  // 3.5% OTM
        const hedgeStrike = Math.round((c.entry * (1 + strikeOffset)) / 50) * 50
        const hedgeSymbol = `${trade.symbol}-FUT-HEDGE-${hedgeStrike}${hedgeSide}`
        const futHedgeTrade: TradeEntry = {
          id: `${hedgeSymbol}-${now}-LONG`,
          symbol: hedgeSymbol,
          segment: 'FNO',
          direction: 'LONG',
          source: `${c.source}-FUT-HEDGE`,
          tier: c.tier,
          score: c.score,
          entryDate: now,
          entryTime: time,
          entryPrice: hedgePremium,
          qty: hedgeQty,
          remainingQty: hedgeQty,
          positionValue: hedgePositionValue,
          riskAmount: hedgeQty * hedgePremium * 0.6,      // hedge can lose ~60% in benign case
          stopLoss: +(hedgePremium * 0.4).toFixed(2),      // -60% SL on hedge premium
          target1: +(hedgePremium * 2.5).toFixed(2),        // +150%
          target2: +(hedgePremium * 4).toFixed(2),           // +300%
          target3: +(hedgePremium * 8).toFixed(2),           // +700% (rare tail event)
          entryReason: `🛡 FUTURES HEDGE for ${trade.symbol} · protective ${hedgeStrike}${hedgeSide} · ~15% of futures notional · pays on adverse ${direction === 'LONG' ? 'gap-down' : 'gap-up'}`,
          status: 'OPEN',
          exits: [],
          daysHeld: 0,
          totalRealisedPnl: 0,
          unrealisedPnl: 0,
          totalPnl: 0,
          returnPct: 0,
        }
        opened.push(futHedgeTrade)
        segmentBudget[seg] -= hedgePositionValue
        log.info('PAPER', `  ↳ hedge ${trade.symbol}: bought ${hedgeQty}× ${hedgeStrike}${hedgeSide} @ ₹${hedgePremium.toFixed(2)}`)
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

/**
 * Compute ATR-14 from the tail of a candle series. Returns 0 if not enough
 * data. Used to size the hard-invalidation cushion when averaging in.
 */
function computeAtr(candles: Candle[]): number {
  if (!candles || candles.length < 15) return 0
  let sum = 0
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1]
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  return sum / 14
}

/**
 * Smart-money footprint lookup for the current tick. Reads pedigree,
 * insider-buys, bulk-deals, superstar, and x-recs snapshots from
 * server/data/public-snapshots and returns which sources flagged the
 * symbol in the last 15 sessions.
 *
 * Cached per-tick — the paper-book runs mark-to-market on every trade in
 * one pass, so we don't want to hit disk 15 times per open position.
 * Cleared implicitly by module reload; refreshed lazily on first call
 * per Node process instance.
 */
let smartMoneyCache: { ts: number; map: Map<string, string[]> } | null = null
function loadSmartMoneyFootprint(): Map<string, string[]> {
  const now = Date.now()
  if (smartMoneyCache && (now - smartMoneyCache.ts) < 30 * 60_000) return smartMoneyCache.map
  const map = new Map<string, string[]>()
  const path = require('path')
  const fs = require('fs')
  const SNAP_DIR = path.resolve(__dirname, '../../data/public-snapshots')
  const cutoffMs = now - 15 * 24 * 3600_000
  const sources: Array<[string, string, string]> = [
    // [file, source-label, field for date]
    ['pedigree-accumulation.json', 'PEDIGREE', 'lastFlagDate'],
    ['insider-buys.json',          'INSIDER',  'txnDate'],
    ['bulk-deals.json',            'BULK',     'dealDate'],
    ['superstar-picks.json',       'SUPERSTAR', 'lastSeen'],
    ['x-recs.json',                'X-REC',    'timestamp'],
  ]
  for (const [file, label, dateField] of sources) {
    try {
      const raw = fs.readFileSync(path.join(SNAP_DIR, file), 'utf-8')
      const j = JSON.parse(raw)
      const rows: any[] = Array.isArray(j) ? j : (j.rows ?? j.data ?? j.recommendations ?? [])
      for (const r of rows) {
        const sym = (r.symbol ?? r.ticker ?? r.stock ?? '').toString().toUpperCase().trim()
        if (!sym) continue
        const dateStr = r[dateField] ?? r.date ?? r.generatedAt ?? j.generatedAt
        const t = dateStr ? Date.parse(dateStr) : now
        if (Number.isFinite(t) && t < cutoffMs) continue
        // For x-recs, only count BUY / STRONG_BUY / LONG signals
        if (label === 'X-REC') {
          const rec = String(r.recommendation ?? r.action ?? '').toUpperCase()
          if (!rec.includes('BUY') && !rec.includes('LONG')) continue
        }
        const prior = map.get(sym) ?? []
        if (!prior.includes(label)) prior.push(label)
        map.set(sym, prior)
      }
    } catch { /* file missing / stale / corrupt — skip source, don't fail the trap check */ }
  }
  smartMoneyCache = { ts: now, map }
  log.info('PAPER', `SMART-MONEY footprint loaded: ${map.size} symbols across sources`)
  return map
}

/**
 * SL-TRAP score (0-100). Scores structural intactness at the moment the
 * SL is being hunted. If score ≥ 55, we AVERAGE at the hunted price
 * instead of exiting. The lenses map directly to the user's own trader
 * checklist ("I saw the chart on various timeframes, applied harmonic
 * patterns and other technicals, saw shareholding data").
 *
 * Signals (all direction-aware — LONG means "still bullish; SL was a hunt"):
 *   1. Intraday wick + reclaim         (candle low pierced SL but closed above)
 *   2. Higher-TF trend intact          (close still above 20D EMA for LONG)
 *   3. Not a big-gap flush             (bar range not > 3×ATR — reject panic days)
 *   4. Recent-day accumulation         (last 5 close-to-low > 60% — buyers defending)
 *   5. Not too deep from entry         (bar low > entry × 0.92 — beyond that = broken)
 *   6. Volume sanity                   (bar volume not > 3× avg — reject hard flush)
 *   7. SMART-MONEY footprint           (FII / promoter / insider / bulk / superstar
 *                                        flagged in last 15d — up to 25 pts).
 *                                       This is the hard override the user asked for:
 *                                       "if FII and promoters are allocating capital
 *                                        or increasing stakes we should not panic and
 *                                        book loss" (30 Jul 2026).
 */
function computeTrapScore(trade: TradeEntry, candles: Candle[], bar: Candle, isShort: boolean): number {
  if (!candles || candles.length < 25) return 0
  const entry = trade.originalEntry ?? trade.entryPrice
  let score = 0
  const reasons: string[] = []

  // 1. Wick + reclaim
  if (!isShort) {
    if (bar.low <= trade.stopLoss && bar.close > trade.stopLoss) { score += 20; reasons.push('intraday reclaim') }
  } else {
    if (bar.high >= trade.stopLoss && bar.close < trade.stopLoss) { score += 20; reasons.push('intraday rejection') }
  }

  // 2. Higher-TF trend: close vs 20-bar EMA
  const closes = candles.slice(-25).map(c => c.close)
  const k = 2 / (20 + 1)
  let ema = closes[0]
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k)
  if (!isShort) {
    if (bar.close >= ema * 0.98) { score += 15; reasons.push(`close ₹${bar.close.toFixed(2)} above 20-EMA ₹${ema.toFixed(2)}`) }
  } else {
    if (bar.close <= ema * 1.02) { score += 15; reasons.push(`close below 20-EMA`) }
  }

  // 3. Not a panic day: bar range vs ATR
  const atr = computeAtr(candles)
  if (atr > 0) {
    const barRange = bar.high - bar.low
    if (barRange <= atr * 3) { score += 10; reasons.push(`normal range (${(barRange / atr).toFixed(1)}× ATR)`) }
  }

  // 4. Recent accumulation: are the last 5 bars closing high in range?
  const last5 = candles.slice(-5)
  const closeInRangeCount = last5.filter(c => {
    const range = c.high - c.low
    if (range <= 0) return false
    const closeStrength = (c.close - c.low) / range
    return isShort ? (closeStrength < 0.4) : (closeStrength > 0.6)
  }).length
  if (closeInRangeCount >= 3) { score += 15; reasons.push(`${closeInRangeCount}/5 recent bars close in ${isShort ? 'lower' : 'upper'} 40%`) }

  // 5. Not too deep from original entry (< 8% drawdown from entry)
  if (!isShort) {
    if (bar.low > entry * 0.92) { score += 20; reasons.push(`still within 8% of original entry`) }
  } else {
    if (bar.high < entry * 1.08) { score += 20; reasons.push(`still within 8% of original entry`) }
  }

  // 6. Volume sanity — not a hard flush
  const v20 = candles.slice(-20).reduce((s, c) => s + (c.volume || 0), 0) / 20
  if (v20 > 0 && bar.volume > 0) {
    const volRatio = bar.volume / v20
    if (volRatio <= 3) { score += 10; reasons.push(`normal vol (${volRatio.toFixed(1)}×)`) }
    else reasons.push(`⚠ vol flush ${volRatio.toFixed(1)}× — probable real breakdown`)
  }

  // 7. Smart-money footprint (only meaningful for LONG — a short setup
  //    being hunted UP is NOT confirmed by insider buys). Direct check
  //    of the four institutional-flow snapshots.
  if (!isShort) {
    const footprint = loadSmartMoneyFootprint()
    const hits = footprint.get(trade.symbol.toUpperCase()) ?? []
    if (hits.length > 0) {
      // Up to 25 pts: 10 for first hit, +5 per additional confirming source
      const smBoost = Math.min(25, 10 + (hits.length - 1) * 5)
      score += smBoost
      reasons.push(`SMART-MONEY footprint: ${hits.join('+')} (+${smBoost})`)
      // Record on the trade so we can label the average-in note
      ;(trade as any).smartMoneySources = hits
    }
  }

  log.info('PAPER', `TRAP-SCORE ${trade.symbol}: ${score} · ${reasons.join(' · ')}`)
  return score
}

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

    // ─── Position-review early-exit (3 Aug 2026) ─────────────────────
    // Position-review sweep marks trades that don't pass current strict
    // rules with `reviewEarlyExit=true`. Exit at market on next bar
    // rather than waiting for SL. Preserves capital + refreshes book
    // for stricter-gate entries.
    if ((trade as any).reviewEarlyExit && !trade.exits.some(e => e.reason === 'MANUAL')) {
      const targetPx = (trade as any).reviewTargetExitPrice ?? bar.close
      const exitPx = isShort ? Math.min(targetPx, bar.high) : Math.max(targetPx, bar.low)
      const pnl = (isShort ? (trade.entryPrice - exitPx) : (exitPx - trade.entryPrice)) * trade.remainingQty
      trade.exits.push({ date: barDate, price: exitPx, qty: trade.remainingQty, reason: 'MANUAL' as any, pnl })
      trade.totalRealisedPnl += pnl
      trade.remainingQty = 0
      trade.status = 'CLOSED'
      trade.trapNotes = [...(trade.trapNotes ?? []), `🧹 EARLY EXIT via position-review sweep (grade ${(trade as any).reviewGrade}) @ ₹${exitPx.toFixed(2)}`]
      log.info('PAPER', `${trade.symbol} · early-exit grade-${(trade as any).reviewGrade} @ ₹${exitPx.toFixed(2)}`)
      break
    }

    // ─── SL touch (direction-aware) ─────────────────────────────────
    // NEW 2026-07-29: don't blindly exit. Check for SL-hunt trap first.
    // If the setup is structurally intact (higher-TF trend + wick reclaim
    // + delivery surge + shareholding stable), AVERAGE at the SL price
    // instead of exiting. This is how institutional traders make money
    // on names like Moschip (212→190→244), VIP Ind (306→270→344),
    // Marksans (179→169→200), Dam Capital (158→150→172).
    //
    // Guardrails so we don't average into a real breakdown:
    //   · Only 1 average-in per position
    //   · Hard invalidation = 2×ATR below original entry — beyond that,
    //     no more averaging even if trap score is high
    //   · Trap score must be ≥ 55 (multi-factor evidence required)
    const slHit = isShort ? (bar.high >= trade.stopLoss) : (bar.low <= trade.stopLoss)
    if (slHit && !trade.exits.some(e => e.reason === 'SL_HIT')) {
      // ── SL Decision Engine ─────────────────────────────────────────
      // Full trader-grade evaluation: technical trap-score + shareholding
      // (FII/DII/promoter QoQ + pledge) + quality floor (MC, P/E) +
      // smart-money footprint + hard invalidation. Returns an action +
      // human-readable verdict that we surface in the journal.
      const alreadyAveraged = (trade.avgInCount ?? 0) >= 1
      const { evaluateSlDecision } = await import('./slDecisionEngine')
      const decision = await evaluateSlDecision({
        symbol: trade.symbol,
        originalEntry: trade.originalEntry ?? trade.entryPrice,
        stopLoss: trade.stopLoss,
        hardInvalidation: trade.hardInvalidation,
        isShort,
        alreadyAveraged,
        candles,
        bar,
      })
      trade.slVerdict = {
        action: decision.action,
        confidence: decision.confidence,
        humanExplain: decision.humanExplain,
        at: barDate,
      }
      const trapScore = decision.factors.trapScore
      const hardInvalidated = decision.factors.hardInvalidated
      const smartMoneyHits = decision.factors.smartMoneySources
      if (decision.action === 'AVERAGE') {
        // ─── AVERAGE IN INSTEAD OF EXITING ─────────────────────────
        // Add 50% of original qty at bar's low/high (the hunted price).
        // Reset SL to the hard invalidation level below/above original
        // entry — beyond that, we exit no matter what next time.
        const addQty = Math.max(1, Math.floor(trade.qty * 0.5))
        const hitPrice = isShort ? bar.high : bar.low
        const newTotalQty = trade.remainingQty + addQty
        const newAvgEntry = ((trade.entryPrice * trade.remainingQty) + (hitPrice * addQty)) / newTotalQty
        // Widen SL to hard invalidation (2×ATR from the original entry)
        const origEntry = trade.originalEntry ?? trade.entryPrice
        const atr = computeAtr(candles)
        const invalidationDist = Math.max(atr * 2, origEntry * 0.05)
        const newSL = isShort ? (origEntry + invalidationDist) : (origEntry - invalidationDist)
        trade.exits.push({
          date: barDate, price: hitPrice, qty: -addQty,   // negative qty = ADD not EXIT
          reason: 'MANUAL' as any,
          pnl: 0,
        })
        // Rewire the trade
        trade.originalEntry = origEntry
        trade.entryPrice = newAvgEntry       // new avg entry for all downstream mark-to-market
        trade.qty = newTotalQty              // original + added
        trade.remainingQty = newTotalQty
        trade.stopLoss = newSL
        trade.hardInvalidation = newSL
        trade.avgInCount = (trade.avgInCount ?? 0) + 1
        trade.positionValue = trade.entryPrice * trade.qty
        // Preserve targets but recompute return % against new avg entry
        const smLabel = smartMoneyHits && smartMoneyHits.length > 0
          ? ` · smart-money=[${smartMoneyHits.join(',')}]`
          : ''
        const note = `🎯 AVERAGED (conf ${decision.confidence}): added ${addQty} @ ₹${hitPrice.toFixed(2)}, new avg ₹${newAvgEntry.toFixed(2)}, new SL ₹${newSL.toFixed(2)} · trap ${trapScore}${smLabel}`
        trade.trapNotes = [...(trade.trapNotes ?? []), note]
        log.info('PAPER', `${trade.symbol} · ${note}`)
        // Fall through — continue processing subsequent bars for T-hits + new SL
        continue
      }
      // ── HOLD path: institutional evidence isn't strong enough to add,
      //    but not weak enough to panic. Skip this bar's SL and give the
      //    next 1-2 bars to prove themselves. Emit note so /journal sees.
      if (decision.action === 'HOLD' && !hardInvalidated) {
        const holdNote = `⏸ HELD through SL touch (conf ${decision.confidence}) · trap ${trapScore} · smart-money=[${smartMoneyHits.join(',') || 'none'}] · waiting for next 2 bars`
        trade.trapNotes = [...(trade.trapNotes ?? []), holdNote]
        log.info('PAPER', `${trade.symbol} · ${holdNote}`)
        continue
      }
      // ─── Real SL_HIT (Decision Engine returned EXIT) ─────────────────
      const exitQty = trade.remainingQty
      const pnl = (isShort ? (trade.entryPrice - trade.stopLoss) : (trade.stopLoss - trade.entryPrice)) * exitQty
      trade.exits.push({ date: barDate, price: trade.stopLoss, qty: exitQty, reason: 'SL_HIT', pnl })
      const exitNote = `🛑 EXIT (conf ${decision.confidence}) · trap ${trapScore}${hardInvalidated ? ' · hard invalidation breached' : ''}${smartMoneyHits.length ? ' · smart-money couldn\'t save it' : ''}`
      trade.trapNotes = [...(trade.trapNotes ?? []), exitNote]
      trade.remainingQty = 0
      trade.totalRealisedPnl += pnl
      trade.status = 'SL_HIT'
      log.info('PAPER', `${trade.symbol} · ${exitNote}`)
      break
    }
    // ─── Early profit booking (3 Aug 2026 · user: "keep taking and
    //     booking profits as you think") — if position is up ≥ 5%
    //     BEFORE T1 hits, book 25% partial + trail remaining SL to
    //     breakeven. Locks in a small win even if the setup fades.
    const earlyProfitPct = isShort
      ? ((trade.entryPrice - bar.close) / trade.entryPrice) * 100
      : ((bar.close - trade.entryPrice) / trade.entryPrice) * 100
    if (earlyProfitPct >= 5 && !trade.exits.some(e => e.reason === 'MANUAL') && !trade.exits.some(e => e.reason === 'T1_HIT') && trade.remainingQty === trade.qty) {
      const earlyQty = Math.max(1, Math.floor(trade.qty * 0.25))
      const earlyPx = bar.close
      const earlyPnl = (isShort ? (trade.entryPrice - earlyPx) : (earlyPx - trade.entryPrice)) * earlyQty
      trade.exits.push({ date: barDate, price: earlyPx, qty: earlyQty, reason: 'MANUAL' as any, pnl: earlyPnl })
      trade.remainingQty -= earlyQty
      trade.totalRealisedPnl += earlyPnl
      trade.trapNotes = [...(trade.trapNotes ?? []), `💰 EARLY PROFIT: booked ${earlyQty} @ ₹${earlyPx.toFixed(2)} (+${earlyProfitPct.toFixed(1)}%) · trailed SL to entry ₹${trade.entryPrice.toFixed(2)}`]
      // Trail SL to breakeven immediately
      const beSL = trade.originalEntry ?? trade.entryPrice
      const wouldWiden = isShort ? beSL > trade.stopLoss : beSL < trade.stopLoss
      if (!wouldWiden) trade.stopLoss = beSL
      log.info('PAPER', `${trade.symbol} · early-profit +${earlyProfitPct.toFixed(1)}% booked 25%`)
    }

    // T1 partial (direction-aware) + trail SL to breakeven on remaining qty.
    // 2026-07-30: the single largest driver of the 28% WR was "T1 hit, then
    // gave back to SL" — turning locked wins into losses. Moving SL to entry
    // after T1 fires converts those into breakeven trades at worst.
    const t1Hit = isShort ? (bar.low <= trade.target1) : (bar.high >= trade.target1)
    if (t1Hit && !trade.exits.some(e => e.reason === 'T1_HIT')) {
      const t1Qty = Math.floor(trade.qty * RULES.exitPartials.T1)
      const exitQty = Math.min(t1Qty, trade.remainingQty)
      const pnl = (isShort ? (trade.entryPrice - trade.target1) : (trade.target1 - trade.entryPrice)) * exitQty
      trade.exits.push({ date: barDate, price: trade.target1, qty: exitQty, reason: 'T1_HIT', pnl })
      trade.remainingQty -= exitQty
      trade.totalRealisedPnl += pnl
      trade.status = 'T1_HIT'
      // ─── TRAIL: move SL to breakeven (original entry) ────────────────
      const beSL = trade.originalEntry ?? trade.entryPrice
      const wouldWiden = isShort ? beSL > trade.stopLoss : beSL < trade.stopLoss
      if (!wouldWiden) {
        const prevSL = trade.stopLoss
        trade.stopLoss = beSL
        trade.trapNotes = [...(trade.trapNotes ?? []), `🔒 T1 hit — SL trailed to breakeven ₹${beSL.toFixed(2)} (was ₹${prevSL.toFixed(2)})`]
      }
    }
    // T2 partial (direction-aware) + trail SL to T1 on remaining qty.
    // Locks in ≥ T1 profit even if T3 never triggers.
    const t2Hit = isShort ? (bar.low <= trade.target2) : (bar.high >= trade.target2)
    if (t2Hit && !trade.exits.some(e => e.reason === 'T2_HIT')) {
      const t2Qty = Math.floor(trade.qty * RULES.exitPartials.T2)
      const exitQty = Math.min(t2Qty, trade.remainingQty)
      const pnl = (isShort ? (trade.entryPrice - trade.target2) : (trade.target2 - trade.entryPrice)) * exitQty
      trade.exits.push({ date: barDate, price: trade.target2, qty: exitQty, reason: 'T2_HIT', pnl })
      trade.remainingQty -= exitQty
      trade.totalRealisedPnl += pnl
      trade.status = 'T2_HIT'
      // ─── TRAIL: move SL to T1 (locks in first-target profit) ─────────
      const wouldWiden = isShort ? trade.target1 > trade.stopLoss : trade.target1 < trade.stopLoss
      if (!wouldWiden) {
        const prevSL = trade.stopLoss
        trade.stopLoss = trade.target1
        trade.trapNotes = [...(trade.trapNotes ?? []), `🔒 T2 hit — SL trailed to T1 ₹${trade.target1.toFixed(2)} (was ₹${prevSL.toFixed(2)})`]
      }
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
