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
  segment: 'FNO' | 'CASH'
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

const BOOK_STATE_FILE = path.resolve(process.cwd(), 'data', 'paper-trading-book.json')
const JOURNAL_SNAPSHOT_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'trading-journal.json')
const HQS_SNAPSHOT_FILE = path.resolve(process.cwd(), 'data', 'public-snapshots', 'high-quality-setups.json')

// ─── Constants ──────────────────────────────────────────────────────

const STARTING_CAPITAL = 10_00_000
const RULES = {
  tierAlloc: { ELITE: 0.15, STRONG: 0.08 },
  positionCapPct: 0.20,
  riskPerTradePct: 0.01,
  maxConcurrentPositions: 15,
  minMarketCapCr: 500,
  maxPledgePct: 20,
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
  if (!fs.existsSync(BOOK_STATE_FILE)) {
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
  return JSON.parse(fs.readFileSync(BOOK_STATE_FILE, 'utf-8')) as Book
}

function saveBook(book: Book): void {
  fs.mkdirSync(path.dirname(BOOK_STATE_FILE), { recursive: true })
  fs.writeFileSync(BOOK_STATE_FILE, JSON.stringify(book, null, 2), 'utf-8')
}

function publishJournal(book: Book): void {
  fs.mkdirSync(path.dirname(JOURNAL_SNAPSHOT_FILE), { recursive: true })
  // Public snapshot with pretty presentation fields for stocksbyvarsha /v2/
  const open = book.trades.filter(t => t.status === 'OPEN' || /^T[12]_HIT$/.test(t.status))
  const closed = book.trades.filter(t => t.status === 'SL_HIT' || t.status === 'T3_HIT' || t.status === 'TIME_STOP' || t.status === 'CLOSED')
  const out = {
    generatedAt: new Date().toISOString(),
    startedAt: book.startedAt,
    lastUpdatedAt: book.lastUpdatedAt,
    daysRunning: isoDaysDiff(book.startedAt, todayIST()),
    startingCapital: book.startingCapital,
    ledger: book.ledger,
    performance: book.performance,
    rules: book.rules,
    openTrades: open,
    closedTrades: closed.slice(-100),  // last 100 closed trades
    allTradesCount: book.trades.length,
  }
  fs.writeFileSync(JOURNAL_SNAPSHOT_FILE, JSON.stringify(out, null, 2), 'utf-8')
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

async function scanForNewTrades(book: Book): Promise<TradeEntry[]> {
  if (!fs.existsSync(HQS_SNAPSHOT_FILE)) {
    log.warn('PAPER', 'no high-quality-setups.json found — skipping open pass')
    return []
  }
  const hqs = JSON.parse(fs.readFileSync(HQS_SNAPSHOT_FILE, 'utf-8'))
  const candidates: any[] = [...(hqs.fno ?? []), ...(hqs.cash ?? [])]

  const openSymbols = new Set(book.trades.filter(t => t.status === 'OPEN' || /^T[12]_HIT$/.test(t.status)).map(t => t.symbol))
  const openCount = openSymbols.size

  const bookValue = book.ledger.bookValue
  const availableCash = book.ledger.currentCash

  const opened: TradeEntry[] = []
  const now = todayIST()
  const time = nowTimeIST()

  for (const c of candidates) {
    if (opened.length + openCount >= RULES.maxConcurrentPositions) break

    // Quality gates
    if (c.tier !== 'ELITE' && c.tier !== 'STRONG') continue
    if (isEtfSymbol(c.symbol)) continue                        // ETFs excluded
    if (openSymbols.has(c.symbol)) continue                    // already have position

    const mc = c.marketCapCr ?? parseShareholdingMc(c.shareholdingNote)
    if (mc !== undefined && mc < RULES.minMarketCapCr) continue // pump-and-dump risk
    const pledge = parseShareholdingPledge(c.shareholdingNote)
    if (pledge !== undefined && pledge >= RULES.maxPledgePct) continue

    if (!c.entry || !c.stopLoss) continue                      // incomplete trade plan
    if (c.direction === 'SHORT') continue                      // paper account long-only for cash equities

    // Sizing
    const availableAfter = availableCash - opened.reduce((s, t) => s + t.positionValue, 0)
    const qty = computeQty(c.entry, c.stopLoss, c.tier, bookValue, availableAfter)
    if (qty <= 0) continue

    const positionValue = qty * c.entry
    const riskAmount = qty * Math.abs(c.entry - c.stopLoss)

    const trade: TradeEntry = {
      id: `${c.symbol}-${now}-LONG`,
      symbol: c.symbol,
      segment: c.segment === 'FNO' ? 'FNO' : 'CASH',
      direction: 'LONG',
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
      marketCapCr: mc,
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
  }
  return opened
}

// ─── Exit management ────────────────────────────────────────────────

async function markToMarketAndExit(trade: TradeEntry): Promise<void> {
  // Pull yesterday's daily candle to detect T/SL touches. Use last few
  // bars since we may be running once a day and want to catch any hit
  // that occurred since the last book update.
  const candles: Candle[] = await getCandles(trade.symbol, '1D', 10).catch(() => [])
  if (candles.length === 0) return
  const cutoffMs = new Date(trade.entryDate).getTime()
  const barsSinceEntry = candles.filter(c => c.time > cutoffMs)
  if (barsSinceEntry.length === 0) {
    // Same-day open — mark to last close, no exit check
    trade.unrealisedPnl = 0
    trade.totalPnl = trade.totalRealisedPnl
    trade.returnPct = trade.positionValue > 0 ? (trade.totalPnl / trade.positionValue) * 100 : 0
    return
  }

  // Walk each bar chronologically; check T1 → T2 → T3 → SL in order.
  for (const bar of barsSinceEntry) {
    if (trade.remainingQty <= 0) break

    const barDate = new Date(bar.time + 5.5 * 3600_000).toISOString().slice(0, 10)

    // SL check (LONG only for now)
    if (bar.low <= trade.stopLoss && !trade.exits.some(e => e.reason === 'SL_HIT')) {
      const exitQty = trade.remainingQty
      const pnl = (trade.stopLoss - trade.entryPrice) * exitQty
      trade.exits.push({ date: barDate, price: trade.stopLoss, qty: exitQty, reason: 'SL_HIT', pnl })
      trade.remainingQty = 0
      trade.totalRealisedPnl += pnl
      trade.status = 'SL_HIT'
      break
    }
    // T1 partial exit
    if (bar.high >= trade.target1 && !trade.exits.some(e => e.reason === 'T1_HIT')) {
      const t1Qty = Math.floor(trade.qty * RULES.exitPartials.T1)
      const exitQty = Math.min(t1Qty, trade.remainingQty)
      const pnl = (trade.target1 - trade.entryPrice) * exitQty
      trade.exits.push({ date: barDate, price: trade.target1, qty: exitQty, reason: 'T1_HIT', pnl })
      trade.remainingQty -= exitQty
      trade.totalRealisedPnl += pnl
      trade.status = 'T1_HIT'
    }
    // T2 partial exit
    if (bar.high >= trade.target2 && !trade.exits.some(e => e.reason === 'T2_HIT')) {
      const t2Qty = Math.floor(trade.qty * RULES.exitPartials.T2)
      const exitQty = Math.min(t2Qty, trade.remainingQty)
      const pnl = (trade.target2 - trade.entryPrice) * exitQty
      trade.exits.push({ date: barDate, price: trade.target2, qty: exitQty, reason: 'T2_HIT', pnl })
      trade.remainingQty -= exitQty
      trade.totalRealisedPnl += pnl
      trade.status = 'T2_HIT'
    }
    // T3 final exit
    if (bar.high >= trade.target3 && trade.remainingQty > 0) {
      const exitQty = trade.remainingQty
      const pnl = (trade.target3 - trade.entryPrice) * exitQty
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
    const pnl = (lastBar.close - trade.entryPrice) * exitQty
    trade.exits.push({ date: lastDate, price: lastBar.close, qty: exitQty, reason: 'TIME_STOP', pnl })
    trade.remainingQty = 0
    trade.totalRealisedPnl += pnl
    trade.status = 'TIME_STOP'
  }

  // Mark-to-market on the leftover qty
  const lastClose = barsSinceEntry[barsSinceEntry.length - 1].close
  trade.unrealisedPnl = trade.remainingQty * (lastClose - trade.entryPrice)
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
export async function runPaperTradingDailyTick(): Promise<Book> {
  const book = loadBook()
  const dayStart = Date.now()

  // 1. Update all existing open positions
  for (const t of book.trades) {
    if (t.status === 'CLOSED' || t.status === 'SL_HIT' || t.status === 'T3_HIT' || t.status === 'TIME_STOP') continue
    try { await markToMarketAndExit(t) }
    catch (e) { log.warn('PAPER', `mark-to-market failed for ${t.symbol}: ${(e as Error).message}`) }
  }

  // 2. Scan for new entries only if we've got room + cash + it's the same day
  //    as today (avoid double-opens if the tick runs twice).
  const alreadyOpenedToday = book.trades.some(t => t.entryDate === todayIST())
  if (!alreadyOpenedToday) {
    recomputeLedgerAndPerf(book)   // fresh cash figure first
    const newTrades = await scanForNewTrades(book)
    book.trades.push(...newTrades)
    log.info('PAPER', `opened ${newTrades.length} new positions on ${todayIST()}`)
  } else {
    log.info('PAPER', `already opened positions today, skipping entry scan`)
  }

  // 3. Final recompute + persist
  recomputeLedgerAndPerf(book)
  book.lastUpdatedAt = todayIST()
  saveBook(book)
  publishJournal(book)

  log.ok('PAPER', `book done in ${((Date.now() - dayStart) / 1000).toFixed(1)}s · value ₹${book.ledger.bookValue.toLocaleString('en-IN')} · return ${book.ledger.totalReturnPct.toFixed(2)}% · open ${book.performance.openTrades} · WR ${book.performance.winRatePct}%`)
  return book
}

/**
 * Reset the book — wipes state, starts fresh with ₹10L. Use this only
 * when you want to restart the 30-day test cleanly.
 */
export function resetBook(): void {
  if (fs.existsSync(BOOK_STATE_FILE)) fs.unlinkSync(BOOK_STATE_FILE)
  log.info('PAPER', 'book reset — next tick will start fresh with ₹10L')
}
