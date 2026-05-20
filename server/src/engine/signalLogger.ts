import fs from 'fs/promises'
import { open as fsOpen } from 'fs/promises'
import path from 'path'
import { log } from '../util/logger'
import type { Signal } from '../types'
import type { LifecycleEvent } from './tradeTracker'

/**
 * Tail-read a text file and return the last `maxLines` lines (plus the
 * header row) as a string. Used by the audit endpoint so we don't parse
 * a 15 MB CSV on every dashboard refresh.
 *
 * Implementation: read the file in 64 KB chunks from the end backwards
 * until we have enough newlines. Then prepend the original header line
 * (first line of the file) so parseCsv still gets a valid header.
 */
async function tailRead(file: string, maxLines: number): Promise<string> {
  const fh = await fsOpen(file, 'r')
  try {
    const stat = await fh.stat()
    const size = stat.size
    if (size === 0) return ''
    // Read header (first line)
    const headBuf = Buffer.alloc(Math.min(4096, size))
    await fh.read(headBuf, 0, headBuf.length, 0)
    const headStr = headBuf.toString('utf8')
    const headerEnd = headStr.indexOf('\n')
    const header = headerEnd >= 0 ? headStr.slice(0, headerEnd) : headStr
    // Read tail backwards in 64 KB chunks
    const CHUNK = 64 * 1024
    let pos = size
    let collected = ''
    let lines = 0
    while (pos > 0 && lines < maxLines + 1) {
      const len = Math.min(CHUNK, pos)
      pos -= len
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, pos)
      collected = buf.toString('utf8') + collected
      lines = (collected.match(/\n/g) || []).length
      if (pos === 0) break
    }
    // Trim partial first line (likely chopped mid-row by chunking)
    const firstNl = collected.indexOf('\n')
    const tail = firstNl >= 0 ? collected.slice(firstNl + 1) : collected
    return header + '\n' + tail
  } finally {
    await fh.close()
  }
}

/**
 * Append-only CSV audit trail of every signal generated and every lifecycle
 * event (T1/T2/SL/EXPIRED). Two files:
 *
 *   server/data/signals.csv   — one row per signal at emission time
 *   server/data/outcomes.csv  — one row per lifecycle event
 *
 * Both open directly in Excel. Join by `signal_id` to compute live win-rate,
 * average bars-to-T1, slippage etc. Used by the self-improvement loop and
 * exposed via the dashboard for the user to download.
 */

const DATA_DIR = path.resolve(__dirname, '../../data')
const SIGNALS_CSV = path.join(DATA_DIR, 'signals.csv')
const OUTCOMES_CSV = path.join(DATA_DIR, 'outcomes.csv')
const PNL_CSV = path.join(DATA_DIR, 'trades-pnl.csv')
const SIGNAL_DETAIL_DIR = path.join(DATA_DIR, 'signals-detail')

/** Standard quantity used when computing realised P&L per closed trade. */
export const PNL_QTY = 100

const SIGNALS_HEADER = [
  'timestamp', 'signal_id', 'symbol', 'instrument', 'type', 'source', 'tier',
  'direction', 'grade', 'score', 'conviction_score',
  'entry', 'stop_loss', 'target1', 'target2',
  'risk_pct', 'reward_pct', 'risk_reward',
  'ema9', 'ema21', 'ema50', 'ema200', 'rsi', 'adx', 'atr', 'vwap',
  'timeframe', 'pattern',
  'gann_note', 'astro_note', 'oi_note',
  'regime', 'reasons',
].join(',')

const OUTCOMES_HEADER = [
  'timestamp', 'signal_id', 'symbol', 'event', 'ltp', 'pnl_pct', 'bars_held', 'note',
].join(',')

const PNL_HEADER = [
  'signal_id', 'symbol', 'strategy', 'direction',
  'signal_date', 'exit_date',
  'entry', 'stop_loss', 'target1', 'target2', 'exit_price',
  'event', 'qty', 'pnl_inr', 'pnl_pct',
  'hold_days', 'win_loss', 'rr_realised',
].join(',')

let initPromise: Promise<void> | null = null

/** Lazy-init: create data dir + CSV headers if missing. */
async function ensureFiles(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    await fs.mkdir(DATA_DIR, { recursive: true })
    for (const [file, header] of [
      [SIGNALS_CSV, SIGNALS_HEADER],
      [OUTCOMES_CSV, OUTCOMES_HEADER],
      [PNL_CSV, PNL_HEADER],
    ] as const) {
      try {
        await fs.access(file)
      } catch {
        await fs.writeFile(file, header + '\n', 'utf8')
        log.ok('LOG', `Created ${path.basename(file)}`)
      }
    }
  })()
  return initPromise
}

/** In-memory cache of signal entries — needed to compute P&L without
 *  re-parsing the CSV on every outcome event. Built lazily. */
const signalCache: Record<string, { entry: number; sl: number; t1: number; t2: number; direction: 'BUY' | 'SELL'; symbol: string; source: string; signalDate: string }> = {}

function rememberSignal(s: Signal): void {
  signalCache[s.id] = {
    entry: s.entry, sl: s.stopLoss, t1: s.target1, t2: s.target2,
    direction: s.direction, symbol: s.instrument.split(' ')[0], source: s.source,
    signalDate: s.timestamp,
  }
}

/** Escape a CSV cell — quotes around anything containing comma/newline/quote. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

// 2026-05-07: per-day dedup ledger so the same (instrument|direction) only
// gets logged ONCE per day even if 50 strategy ticks emit it across the
// session. Cleared at midnight by the existing midnight-reset cron in
// index.ts. This is the second leg of the noise reduction — the score gate
// alone left 12,300 OPTIONS rows because each tick re-emitted the same
// strike. With dedup applied, that drops to ~50/day.
const dailyLogDedup = new Set<string>()
export function clearDailyLogDedup(): void { dailyLogDedup.clear() }

/** Append a signal-creation row.
 * HARD GATES:
 *   1. OPTIONS must score ≥ 9.0 AND conviction ≥ 90 (changed from && to ||
 *      semantics — earlier code allowed either gate to pass which let
 *      score=8 + conviction=80 noise leak through).
 *   2. Per-day dedup by (instrument | direction) — drops repeat emissions
 *      of the same strike from successive engine ticks.
 */
export async function logSignal(signal: Signal, regime?: string): Promise<void> {
  if (signal.type === 'OPTIONS') {
    const score = signal.score ?? 0
    const conviction = (signal as any).convictionScore ?? score * 10
    // Drop if EITHER fails — both must clear the bar.
    if (score < 9 || conviction < 90) return
  }
  // Per-day dedup — ledger key includes IST date so it auto-resets at midnight.
  const day = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
  const key = `${day}|${signal.type}|${signal.instrument}|${signal.direction}`
  if (dailyLogDedup.has(key)) return
  dailyLogDedup.add(key)
  await ensureFiles()
  rememberSignal(signal)

  // 2026-05-11: register every signal in the lifecycle store as PENDING
  // so the periodic LTP checker tracks entry/SL/target. Maps Signal.type
  // → lifecycle source enum. INTRADAY scalps skip lifecycle (too noisy,
  // would explode the store). Best-effort, never blocks the CSV log.
  try {
    if (signal.entry && signal.stopLoss && signal.target1) {
      // 2026-05-20: routing fix — use signal.source (e.g. 'turtle-soup',
      // 'fib-lrc', 'harmonic') to disambiguate engines that all use the
      // SWING type wrapper. Previously turtle-soup signals collapsed into
      // 'WEEKLY' bucket, making them invisible in Track Record by-source
      // filters. Now each engine gets its own lifecycle source.
      const srcStr = String(signal.source ?? '').toLowerCase()
      let lifeSrc: any
      if (srcStr.includes('turtle')) lifeSrc = 'TURTLE'
      else if (srcStr.includes('fib') || srcStr.includes('lrc')) lifeSrc = 'FIB'
      else if (srcStr.includes('harmonic')) lifeSrc = 'HARMONIC'
      else if (srcStr.includes('premove') || srcStr.includes('pre-move')) lifeSrc = 'PREMOVE'
      else if (signal.type === 'OPTIONS' || signal.type === 'FUTURES' || signal.type === 'COMMODITY') lifeSrc = 'OPTIONS'
      else if (signal.type === 'INTRADAY') lifeSrc = 'INTRADAY'
      else if (signal.type === 'SWING' || signal.type === 'POSITIONAL') lifeSrc = 'WEEKLY'
      else lifeSrc = 'INTRADAY'
      const { appendSignal } = await import('./signalLifecycle')

      // 2026-05-20: OPTIONS lifecycle fix. Previously we stored premium-space
      // entry/SL/T1/T2/T3 (e.g. entry=150, SL=105) but the lifecycle checker
      // fetches the UNDERLYING quote (e.g. NIFTY spot=23400). The two scales
      // never match, so every OPTIONS entry sat in PENDING until 5-day expiry.
      // Fix: when the engine has tagged `meta.spot` + `meta.underlyingDirection`,
      // store underlying-spot-equivalent levels so the existing spot LTP path
      // works. ATR-based offsets approximate delta=0.5 ATM behaviour:
      //   spot SL = spot ∓ 0.8 × ATR  (≈ 35% premium drop)
      //   spot T1 = spot ± 0.7 × ATR  (≈ 30% premium gain)
      //   spot T2 = spot ± 1.5 × ATR  (≈ 65% premium gain)
      //   spot T3 = spot ± 2.5 × ATR  (≈ 120% premium gain)
      const meta = (signal.meta ?? {}) as any
      const isOptions = lifeSrc === 'OPTIONS'
      const hasUnderlying = isOptions && Number.isFinite(meta.spot) && Number.isFinite(meta.atr) && meta.underlyingDirection
      let lifeSymbol = signal.instrument.split(' ')[0]
      let lifeDir: 'BUY' | 'SHORT' = signal.direction === 'SELL' ? 'SHORT' : (signal.direction as 'BUY' | 'SHORT')
      let lifeEntry = signal.entry
      let lifeSL = signal.stopLoss
      let lifeT1 = signal.target1
      let lifeT2 = signal.target2 ?? signal.target1
      let lifeT3 = (signal as any).target3 ?? signal.target2 ?? signal.target1
      let lifeLtp = signal.entry
      if (hasUnderlying) {
        const spot = meta.spot as number
        const atr = meta.atr as number
        const isBull = meta.underlyingDirection === 'BUY'
        lifeDir = isBull ? 'BUY' : 'SHORT'
        lifeEntry = +spot.toFixed(2)
        lifeLtp = lifeEntry
        lifeSL = +(isBull ? spot - 0.8 * atr : spot + 0.8 * atr).toFixed(2)
        lifeT1 = +(isBull ? spot + 0.7 * atr : spot - 0.7 * atr).toFixed(2)
        lifeT2 = +(isBull ? spot + 1.5 * atr : spot - 1.5 * atr).toFixed(2)
        lifeT3 = +(isBull ? spot + 2.5 * atr : spot - 2.5 * atr).toFixed(2)
      }

      await appendSignal({
        source: lifeSrc,
        symbol: lifeSymbol,
        direction: lifeDir,
        ltp: lifeLtp,
        entryPrice: lifeEntry,
        stopLoss: lifeSL,
        target1: lifeT1,
        target2: lifeT2,
        target3: lifeT3,
        conviction: (signal as any).convictionScore ?? signal.score * 10,
        reasoning: (signal.reasons ?? []).slice(0, 2).join(' · '),
      })
    }
  } catch { /* swallow — lifecycle is best-effort */ }
  const m = signal.meta ?? {}
  const reasons = (signal.reasons ?? []).slice(0, 4).join(' | ')
  const conviction = (signal as any).convictionScore ?? ''
  const row = [
    signal.timestamp,
    signal.id,
    signal.instrument.split(' ')[0],
    signal.instrument,
    signal.type,
    signal.source,
    signal.tier ?? 'LIVE',
    signal.direction,
    signal.grade,
    signal.score,
    conviction,
    signal.entry,
    signal.stopLoss,
    signal.target1,
    signal.target2,
    signal.riskPct,
    signal.rewardPct,
    signal.riskReward,
    m.ema9 ?? '',
    m.ema21 ?? '',
    m.ema50 ?? '',
    m.ema200 ?? '',
    m.rsi ?? '',
    m.adx ?? '',
    m.atr ?? '',
    m.vwap ?? '',
    m.timeframe ?? '',
    m.pattern ?? '',
    signal.gannNote,
    signal.astroNote,
    signal.oiNote,
    regime ?? '',
    reasons,
  ].map(csvCell).join(',')
  await fs.appendFile(SIGNALS_CSV, row + '\n', 'utf8')

  // Per-signal logic dump — one Markdown file per emission so the user
  // can audit "why did this signal fire" without parsing the CSV. Saved
  // to data/signals-detail/<signal_id>.md. User asked for this in #5.
  void writeSignalDetail(signal, regime).catch(() => undefined)
}

async function writeSignalDetail(signal: Signal, regime?: string): Promise<void> {
  await fs.mkdir(SIGNAL_DETAIL_DIR, { recursive: true }).catch(() => undefined)
  const tp = signal.tradePlan ?? null
  const lines: string[] = []
  lines.push(`# ${signal.instrument} · ${signal.direction}`)
  lines.push(``)
  lines.push(`- **Signal ID:** \`${signal.id}\``)
  lines.push(`- **Generated:** ${signal.timestamp}`)
  lines.push(`- **Source strategy:** ${signal.source}`)
  lines.push(`- **Type:** ${signal.type}  ·  **Tier:** ${signal.tier ?? 'LIVE'}  ·  **Market regime:** ${regime ?? 'n/a'}`)
  lines.push(`- **Conviction:** Grade ${signal.grade} · Score ${signal.score}/10 · ${signal.confluenceCount} confluence factors`)
  lines.push(``)
  lines.push(`## Trade plan`)
  lines.push(`| | Price | Date |`)
  lines.push(`|---|---|---|`)
  lines.push(`| Entry | ${signal.entry} | ${tp?.entryDate ?? '—'} |`)
  lines.push(`| Stop loss | ${signal.stopLoss} | — |`)
  lines.push(`| Target 1 | ${signal.target1} | ${tp?.target1Date ?? '—'} |`)
  lines.push(`| Target 2 | ${signal.target2} | ${tp?.target2Date ?? '—'} |`)
  lines.push(`| Target 3 | ${signal.target3 ?? '—'} | ${tp?.target3Date ?? '—'} |`)
  lines.push(``)
  lines.push(`- **Risk %:** ${signal.riskPct}%  ·  **Reward % (T1):** ${signal.rewardPct}%  ·  **R:R:** 1:${signal.riskReward}`)
  if (tp?.bestEntryTimeIST) {
    lines.push(`- **Best entry time:** ${tp.bestEntryTimeIST} IST  ·  **Hora:** ${tp.horaLord ?? '?'} (${tp.horaNote ?? ''})`)
  }
  if (tp?.entryPriceLow != null && tp?.entryPriceHigh != null) {
    lines.push(`- **Entry zone:** ₹${tp.entryPriceLow} – ₹${tp.entryPriceHigh}`)
  }
  if (tp?.optionLeg) {
    lines.push(``)
    lines.push(`### Option leg`)
    const o = tp.optionLeg
    lines.push(`- **${o.underlying} ${o.strike} ${o.side}** · expiry ${o.expiry} · ${o.lots} lot(s)`)
    lines.push(`- Premium: ₹${o.premium}  ·  SL: ₹${o.slPremium}  ·  T1: ₹${o.t1Premium}  ·  T2: ₹${o.t2Premium}`)
  }
  lines.push(``)
  lines.push(`## Confluence factors`)
  lines.push('```json')
  lines.push(JSON.stringify(signal.confluence, null, 2))
  lines.push('```')
  lines.push(``)
  lines.push(`## Reasoning`)
  for (const r of (signal.reasons ?? [])) lines.push(`- ${r}`)
  lines.push(``)
  if (signal.gannNote && signal.gannNote !== 'N/A') lines.push(`**Gann:** ${signal.gannNote}`)
  if (signal.astroNote && signal.astroNote !== 'N/A') lines.push(`**Astro:** ${signal.astroNote}`)
  if (signal.oiNote && signal.oiNote !== 'N/A') lines.push(`**OI:** ${signal.oiNote}`)
  if (signal.pattern) lines.push(`**Pattern:** ${signal.pattern}`)
  if (signal.stabilityNote) {
    lines.push(``)
    lines.push(`> ⚠️ **Stability warning:** ${signal.stabilityNote}`)
  }
  lines.push(``)
  if (signal.meta) {
    lines.push(`## Indicators (at emission)`)
    lines.push('```json')
    lines.push(JSON.stringify(signal.meta, null, 2))
    lines.push('```')
  }
  // Sanitize id for filesystem
  const safeId = signal.id.replace(/[^A-Za-z0-9_\-.]/g, '_').slice(0, 200)
  await fs.writeFile(path.join(SIGNAL_DETAIL_DIR, `${safeId}.md`), lines.join('\n'), 'utf8').catch(() => undefined)
}

/** Append a lifecycle-event row (T1/T2/SL/EXPIRED) AND a P&L row. */
export async function logOutcome(ev: LifecycleEvent): Promise<void> {
  await ensureFiles()
  const barsHeld = Math.round((Date.now() - ev.trade.openedAt) / (15 * 60_000))   // 15-min bars
  const outRow = [
    new Date().toISOString(),
    ev.trade.currentSignalId,
    ev.trade.symbol,
    ev.kind,
    ev.ltp,
    ev.pnlPct,
    barsHeld,
    ev.note,
  ].map(csvCell).join(',')
  await fs.appendFile(OUTCOMES_CSV, outRow + '\n', 'utf8')

  // Realised-P&L row — Excel-friendly trade ledger at 100 qty per trade.
  // Direction sign:  BUY → exit > entry = profit · SELL → exit < entry = profit
  const sigInfo = signalCache[ev.trade.currentSignalId] ?? {
    entry: ev.trade.entry, sl: ev.trade.originalSL,
    t1: ev.trade.target1, t2: ev.trade.target2,
    direction: ev.trade.direction, symbol: ev.trade.symbol,
    source: ev.trade.strategy,
    signalDate: new Date(ev.trade.openedAt).toISOString(),
  }
  const sign = sigInfo.direction === 'BUY' ? 1 : -1
  const pnlPerShare = (ev.ltp - sigInfo.entry) * sign
  const pnlInr = +(pnlPerShare * PNL_QTY).toFixed(2)
  const holdDays = Math.max(1, Math.round((Date.now() - ev.trade.openedAt) / 86_400_000))
  const win = ev.kind === 'T1_HIT' || ev.kind === 'T2_HIT'
  const lose = ev.kind === 'SL_HIT'
  const winLoss = win ? 'WIN' : lose ? 'LOSS' : 'BE'
  const risk = Math.abs(sigInfo.entry - sigInfo.sl)
  const reward = Math.abs(ev.ltp - sigInfo.entry)
  const rrRealised = risk > 0 ? +(reward / risk).toFixed(2) : 0

  const pnlRow = [
    ev.trade.currentSignalId, sigInfo.symbol, sigInfo.source, sigInfo.direction,
    sigInfo.signalDate.slice(0, 10), new Date().toISOString().slice(0, 10),
    sigInfo.entry, sigInfo.sl, sigInfo.t1, sigInfo.t2, ev.ltp,
    ev.kind, PNL_QTY, pnlInr, ev.pnlPct,
    holdDays, winLoss, rrRealised,
  ].map(csvCell).join(',')
  await fs.appendFile(PNL_CSV, pnlRow + '\n', 'utf8')
}

export function signalsCsvPath(): string { return SIGNALS_CSV }
export function outcomesCsvPath(): string { return OUTCOMES_CSV }
export function pnlCsvPath(): string { return PNL_CSV }

/** Quick portfolio P&L summary for the dashboard. */
export interface PnLSummary {
  totalTrades: number
  wins: number; losses: number; breakeven: number
  winRatePct: number
  totalPnlInr: number
  avgWinInr: number; avgLossInr: number
  expectancyInr: number
  bestTrade: { symbol: string; pnlInr: number } | null
  worstTrade: { symbol: string; pnlInr: number } | null
}

export async function readPnlSummary(): Promise<PnLSummary> {
  await ensureFiles()
  const raw = await fs.readFile(PNL_CSV, 'utf8').catch(() => '')
  const rows = parseCsv(raw)
  let wins = 0, losses = 0, breakeven = 0, totalPnl = 0, totalWin = 0, totalLoss = 0
  let best: PnLSummary['bestTrade'] = null
  let worst: PnLSummary['worstTrade'] = null
  for (const r of rows) {
    const pnl = Number(r.pnl_inr) || 0
    totalPnl += pnl
    if (r.win_loss === 'WIN') { wins++; totalWin += pnl }
    else if (r.win_loss === 'LOSS') { losses++; totalLoss += pnl }
    else { breakeven++ }
    if (!best || pnl > best.pnlInr) best = { symbol: r.symbol, pnlInr: pnl }
    if (!worst || pnl < worst.pnlInr) worst = { symbol: r.symbol, pnlInr: pnl }
  }
  const closed = wins + losses + breakeven
  const winRate = closed ? (wins / closed) * 100 : 0
  return {
    totalTrades: closed,
    wins, losses, breakeven,
    winRatePct: +winRate.toFixed(1),
    totalPnlInr: +totalPnl.toFixed(2),
    avgWinInr: wins ? +(totalWin / wins).toFixed(2) : 0,
    avgLossInr: losses ? +(totalLoss / losses).toFixed(2) : 0,
    expectancyInr: +((winRate / 100) * (wins ? totalWin / wins : 0) + (1 - winRate / 100) * (losses ? totalLoss / losses : 0)).toFixed(2),
    bestTrade: best,
    worstTrade: worst,
  }
}

/**
 * Compute live performance stats by joining signals.csv ⨝ outcomes.csv on
 * signal_id. Used by the self-improve loop and the /api/learning endpoint.
 */
export interface PerfStats {
  totalSignals: number
  closedSignals: number
  pending: number
  wins: number          // T1_HIT or T2_HIT
  losses: number        // SL_HIT
  expired: number
  winRatePct: number
  avgWinPct: number
  avgLossPct: number
  byStrategy: Record<string, { trades: number; wins: number; losses: number; winRatePct: number }>
}

export async function readPerfStats(): Promise<PerfStats> {
  await ensureFiles()
  const sigRaw = await fs.readFile(SIGNALS_CSV, 'utf8').catch(() => '')
  const outRaw = await fs.readFile(OUTCOMES_CSV, 'utf8').catch(() => '')
  const sigRows = parseCsv(sigRaw)
  const outRows = parseCsv(outRaw)
  // Map signal_id → strategy
  const stratById: Record<string, string> = {}
  for (const r of sigRows) stratById[r.signal_id] = r.source
  // Final outcome per signal_id (last event wins — covers SL after T1 trail-stop case)
  const finalById: Record<string, { event: string; pnl_pct: number }> = {}
  for (const r of outRows) finalById[r.signal_id] = { event: r.event, pnl_pct: Number(r.pnl_pct) }

  const byStrategy: PerfStats['byStrategy'] = {}
  let wins = 0, losses = 0, expired = 0
  let avgWin = 0, avgLoss = 0
  for (const [id, o] of Object.entries(finalById)) {
    const s = stratById[id] ?? 'unknown'
    byStrategy[s] ||= { trades: 0, wins: 0, losses: 0, winRatePct: 0 }
    byStrategy[s].trades++
    if (o.event === 'T1_HIT' || o.event === 'T2_HIT') {
      wins++; avgWin += o.pnl_pct; byStrategy[s].wins++
    } else if (o.event === 'SL_HIT') {
      losses++; avgLoss += o.pnl_pct; byStrategy[s].losses++
    } else if (o.event === 'EXPIRED') {
      expired++
    }
  }
  const closed = wins + losses + expired
  for (const k of Object.keys(byStrategy)) {
    const s = byStrategy[k]
    s.winRatePct = s.trades > 0 ? +((s.wins / s.trades) * 100).toFixed(1) : 0
  }
  return {
    totalSignals: sigRows.length,
    closedSignals: closed,
    pending: sigRows.length - closed,
    wins, losses, expired,
    winRatePct: closed > 0 ? +((wins / closed) * 100).toFixed(1) : 0,
    avgWinPct: wins > 0 ? +(avgWin / wins).toFixed(2) : 0,
    avgLossPct: losses > 0 ? +(avgLoss / losses).toFixed(2) : 0,
    byStrategy,
  }
}

/**
 * Joined signal+outcome view for the audit page.
 * Every signal we ever emitted, with its (latest) lifecycle event if any.
 * Limited to the most recent `limit` rows for the dashboard.
 */
export interface AuditRow {
  timestamp: string
  signal_id: string
  symbol: string
  instrument: string
  type: string
  source: string
  tier: string
  direction: string
  grade: string
  score: number
  entry: number
  stop_loss: number
  target1: number
  target2: number
  risk_reward: number
  reasons: string
  // Outcome (latest event if multiple)
  outcome?: string                    // OPEN / T1_HIT / T2_HIT / SL_HIT / EXPIRED / INVALIDATED
  outcome_pnl_pct?: number
  outcome_at?: string
  hold_days?: number
}

export async function readAuditRows(limit = 500): Promise<AuditRow[]> {
  await ensureFiles()
  // Tail-read the signals CSV — file is now ~15 MB+ and parsing the whole
  // thing on every dashboard refresh times the request out. We grab only
  // the last N×8 lines (8× headroom for older signals filtered out by the
  // outcome join), parse those, and dedupe.
  const sigRaw = await tailRead(SIGNALS_CSV, limit * 8).catch(() => '')
  const outRaw = await fs.readFile(OUTCOMES_CSV, 'utf8').catch(() => '')
  const sigs = parseCsv(sigRaw)
  const outs = parseCsv(outRaw)
  // Pick LATEST outcome per signal_id (so a SL after T1-trail wins over T1).
  const finalById: Record<string, { event: string; pnl_pct: number; ts: string }> = {}
  for (const r of outs) {
    const prior = finalById[r.signal_id]
    if (!prior || r.timestamp > prior.ts) {
      finalById[r.signal_id] = { event: r.event, pnl_pct: Number(r.pnl_pct), ts: r.timestamp }
    }
  }
  // Newest signals first; cap at `limit` for payload size.
  const recent = sigs.slice(-limit).reverse()
  return recent.map((r): AuditRow => {
    const final = finalById[r.signal_id]
    const holdDays = final
      ? Math.max(0, Math.floor((+new Date(final.ts) - +new Date(r.timestamp)) / 86_400_000))
      : undefined
    return {
      timestamp: r.timestamp,
      signal_id: r.signal_id,
      symbol: r.symbol,
      instrument: r.instrument,
      type: r.type,
      source: r.source,
      tier: r.tier,
      direction: r.direction,
      grade: r.grade,
      score: Number(r.score),
      entry: Number(r.entry),
      stop_loss: Number(r.stop_loss),
      target1: Number(r.target1),
      target2: Number(r.target2),
      risk_reward: Number(r.risk_reward),
      reasons: r.reasons,
      outcome: final?.event,
      outcome_pnl_pct: final?.pnl_pct,
      outcome_at: final?.ts,
      hold_days: holdDays,
    }
  })
}

// Tiny CSV parser — quoted fields, comma delimiter
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []
  const headers = splitCsvLine(lines[0])
  const out: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cells[j] ?? ''
    out.push(row)
  }
  return out
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = '', inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuote = false
      else cur += ch
    } else {
      if (ch === ',') { out.push(cur); cur = '' }
      else if (ch === '"') inQuote = true
      else cur += ch
    }
  }
  out.push(cur)
  return out
}
