import { readPerfStats, readPnlSummary } from './signalLogger'
import fs from 'fs/promises'
import path from 'path'

/**
 * End-of-day audit report — summarises the day's signal generation + P&L.
 *
 * Pulls from signals.csv, outcomes.csv and trades-pnl.csv (already written
 * by signalLogger). Produces a Telegram-friendly Markdown string and a
 * JSON snapshot persisted under `data/daily-reports/<YYYY-MM-DD>.json`.
 */

const DATA_DIR = path.resolve(__dirname, '../../data')
const REPORTS_DIR = path.join(DATA_DIR, 'daily-reports')
const SIGNALS_CSV = path.join(DATA_DIR, 'signals.csv')

export interface DailyReport {
  date: string
  totalSignals: number
  byType: Record<string, number>
  byDirection: Record<string, number>
  closedToday: number
  winsToday: number
  lossesToday: number
  realisedPnlInr: number
  bestTrade: { symbol: string; pnlInr: number } | null
  worstTrade: { symbol: string; pnlInr: number } | null
  winRatePct: number
  avgWinInr: number
  avgLossInr: number
  expectancyInr: number
  message: string                    // Markdown for Telegram
}

interface CsvRow { [k: string]: string }

function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) return []
  const headers = splitCsv(lines[0])
  return lines.slice(1).map(l => {
    const cells = splitCsv(l); const r: CsvRow = {}
    for (let i = 0; i < headers.length; i++) r[headers[i]] = cells[i] ?? ''
    return r
  })
}
function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c }
    else { if (c === ',') { out.push(cur); cur = '' } else if (c === '"') q = true; else cur += c }
  }
  out.push(cur); return out
}

export async function generateDailyReport(today: Date = new Date()): Promise<DailyReport> {
  const dateStr = today.toISOString().slice(0, 10)

  // Today's signals
  const sigRaw = await fs.readFile(SIGNALS_CSV, 'utf8').catch(() => '')
  const sigRows = parseCsv(sigRaw).filter(r => (r.timestamp ?? '').startsWith(dateStr))
  const byType: Record<string, number> = {}
  const byDirection: Record<string, number> = {}
  for (const r of sigRows) {
    const t = r.type || '?'; byType[t] = (byType[t] ?? 0) + 1
    const d = r.direction || '?'; byDirection[d] = (byDirection[d] ?? 0) + 1
  }

  const perf = await readPerfStats()
  const pnl  = await readPnlSummary()

  // "Closed today" — approximate via trades-pnl.csv exit_date
  const pnlFile = path.join(DATA_DIR, 'trades-pnl.csv')
  const pnlRaw = await fs.readFile(pnlFile, 'utf8').catch(() => '')
  const pnlRows = parseCsv(pnlRaw).filter(r => (r.exit_date ?? '') === dateStr)
  const winsToday = pnlRows.filter(r => r.win_loss === 'WIN').length
  const lossesToday = pnlRows.filter(r => r.win_loss === 'LOSS').length
  const closedToday = pnlRows.length
  const realisedPnl = pnlRows.reduce((s, r) => s + (Number(r.pnl_inr) || 0), 0)

  const top = [...sigRows].slice(0, 5)

  const lines: string[] = []
  lines.push(`📊 *Daily Report — ${dateStr}*`)
  lines.push(`━━━━━━━━━━━━━━━━━━`)
  lines.push(`*Signals generated*: ${sigRows.length}`)
  if (Object.keys(byType).length) {
    lines.push(`  by type: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  }
  if (Object.keys(byDirection).length) {
    lines.push(`  directions: ${Object.entries(byDirection).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  }
  lines.push(``)
  lines.push(`*Closed today*: ${closedToday}`)
  lines.push(`  ${winsToday} wins · ${lossesToday} losses · realised P&L ₹${realisedPnl.toFixed(0)} (100 qty)`)
  lines.push(``)
  lines.push(`*All-time performance*:`)
  lines.push(`  ${perf.wins}W / ${perf.losses}L · win-rate ${perf.winRatePct}%`)
  lines.push(`  Total P&L ₹${pnl.totalPnlInr.toFixed(0)} · expectancy ₹${pnl.expectancyInr.toFixed(0)}/trade`)
  if (pnl.bestTrade)  lines.push(`  🏆 Best: ${pnl.bestTrade.symbol} +₹${pnl.bestTrade.pnlInr}`)
  if (pnl.worstTrade) lines.push(`  ❌ Worst: ${pnl.worstTrade.symbol} ₹${pnl.worstTrade.pnlInr}`)
  if (top.length) {
    lines.push(``)
    lines.push(`*Today's first 5 setups*:`)
    for (const r of top) {
      const t = (r.timestamp ?? '').slice(11, 16)
      lines.push(`  \`${t}\` ${r.type} ${r.direction} ${r.symbol} · entry ₹${r.entry}`)
    }
  }

  const report: DailyReport = {
    date: dateStr,
    totalSignals: sigRows.length,
    byType, byDirection,
    closedToday, winsToday, lossesToday,
    realisedPnlInr: +realisedPnl.toFixed(2),
    bestTrade: pnl.bestTrade,
    worstTrade: pnl.worstTrade,
    winRatePct: perf.winRatePct,
    avgWinInr: pnl.avgWinInr,
    avgLossInr: pnl.avgLossInr,
    expectancyInr: pnl.expectancyInr,
    message: lines.join('\n'),
  }

  await fs.mkdir(REPORTS_DIR, { recursive: true })
  await fs.writeFile(path.join(REPORTS_DIR, `${dateStr}.json`), JSON.stringify(report, null, 2), 'utf8')
  return report
}

export async function readLatestDailyReport(): Promise<DailyReport | null> {
  try {
    const files = await fs.readdir(REPORTS_DIR)
    if (!files.length) return null
    files.sort()
    const latest = files[files.length - 1]
    const raw = await fs.readFile(path.join(REPORTS_DIR, latest), 'utf8')
    return JSON.parse(raw)
  } catch { return null }
}
