/**
 * Dataset export — converts any in-memory dataset (master setup, daily pick,
 * weekly pick, sector rotation, signals, OI flow) into a CSV stream the
 * dashboard can offer as a download from the per-tab Export button.
 *
 * Why this lives in the server and not the client:
 * The client already has each tab's data in state, but the user also wants to
 * grab CSVs of cached data WITHOUT loading the page (e.g. via curl, or for
 * archival). Centralising the schema here also guarantees the CSV columns
 * stay consistent regardless of which tab triggered the export.
 *
 * Zero new dependencies — string-built CSV with proper escaping, matches
 * what `signalLogger.ts` already does. PDF export is a print-styled HTML page
 * the browser's "Save as PDF" handles natively.
 */

import { getLatestMasterSetup } from './masterSetup'
import { getLatestSectorRotation } from './sectorRotation'
import { getLatestPick as getLatestWeeklyPick } from './weeklyManagerPick'
import { loadLatestDailyPick } from './dailyPickEngine'
import { getLatestTurtleSoupRun } from './turtleSoupEngine'
import { getLastHarmonicScan } from './harmonicScanner'
import type { Signal } from '../types'

export type ExportDataset =
  | 'master-setup'
  | 'sector-rotation'
  | 'weekly-pick'
  | 'daily-pick'
  | 'signals'
  | 'turtle-soup'
  | 'harmonic-scan'

export type ExportFormat = 'csv' | 'json' | 'html'

interface ExportResult {
  body: string
  mime: string
  filename: string
}

/**
 * Render any supported dataset into the requested format.
 * Throws when the dataset is empty (caller should 404).
 */
export async function exportDataset(
  dataset: ExportDataset,
  format: ExportFormat,
  signalsRef?: () => Signal[],
): Promise<ExportResult> {
  const today = new Date().toISOString().slice(0, 10)
  switch (dataset) {
    case 'master-setup': {
      const run = getLatestMasterSetup()
      if (!run) throw new Error('No master-setup run cached yet')
      return finalize('master-setup', today, format, masterSetupRows(run))
    }
    case 'sector-rotation': {
      const snap = getLatestSectorRotation()
      if (!snap) throw new Error('No sector-rotation snapshot cached yet')
      return finalize('sector-rotation', today, format, sectorRotationRows(snap))
    }
    case 'weekly-pick': {
      const wp = await getLatestWeeklyPick()
      if (!wp) throw new Error('No weekly pick cached yet')
      return finalize('weekly-pick', today, format, weeklyPickRows(wp))
    }
    case 'daily-pick': {
      const dp = await loadLatestDailyPick()
      if (!dp) throw new Error('No daily pick cached yet')
      return finalize('daily-pick', today, format, dailyPickRows(dp))
    }
    case 'signals': {
      const signals = signalsRef ? signalsRef() : []
      if (!signals.length) throw new Error('No active signals to export')
      return finalize('signals', today, format, signalsRows(signals))
    }
    case 'turtle-soup': {
      const ts = getLatestTurtleSoupRun()
      if (!ts) throw new Error('No turtle-soup run cached yet')
      return finalize('turtle-soup', today, format, turtleSoupRows(ts))
    }
    case 'harmonic-scan': {
      const hs = getLastHarmonicScan('ALL')
      if (!hs || !hs.hits.length) throw new Error('No harmonic scan cached yet')
      return finalize('harmonic-scan', today, format, harmonicRows(hs))
    }
  }
}

// ─── Per-dataset row mappers ──────────────────────────────────

interface RowSet {
  title: string
  columns: string[]
  rows: Array<Record<string, string | number | null>>
  subtitle?: string
}

function masterSetupRows(run: NonNullable<ReturnType<typeof getLatestMasterSetup>>): RowSet {
  return {
    title: 'Master Setups (5★/4★/3★)',
    subtitle: `Generated ${run.generatedAt} · scanned ${run.scanned} · qualified ${run.qualified}`,
    columns: [
      'Symbol', 'LTP', 'Direction', 'Stars', 'Setup', 'Horizon',
      'Entry Low', 'Entry', 'Entry High', 'SL',
      'T1', 'T1 Date', 'T2', 'T2 Date', 'T3', 'T3 Date',
      'R:R', 'Entry Date',
      'Option Strike', 'Option Side', 'Option Expiry', 'Expiry Tag', 'Premium', 'Prem SL', 'Prem T1', 'Prem T2',
      'BB Pctile', 'Vol Ratio', 'RSI', 'Sector',
      'Why Now',
    ],
    rows: run.setups.map(s => ({
      'Symbol': s.symbol,
      'LTP': s.ltp,
      'Direction': s.direction,
      'Stars': s.stars,
      'Setup': s.setupName,
      'Horizon': s.horizon,
      'Entry Low': s.entryPriceLow,
      'Entry': s.entryPrice,
      'Entry High': s.entryPriceHigh,
      'SL': s.stopLoss,
      'T1': s.target1,
      'T1 Date': s.target1Date,
      'T2': s.target2,
      'T2 Date': s.target2Date,
      'T3': s.target3,
      'T3 Date': s.target3Date,
      'R:R': s.riskReward,
      'Entry Date': s.entryDate,
      'Option Strike': s.options?.strike ?? '',
      'Option Side': s.options?.side ?? '',
      'Option Expiry': s.options?.expiry ?? '',
      'Expiry Tag': s.options?.expiryTag ?? '',
      'Premium': s.options?.premium ?? '',
      'Prem SL': s.options?.premiumSL ?? '',
      'Prem T1': s.options?.premiumT1 ?? '',
      'Prem T2': s.options?.premiumT2 ?? '',
      'BB Pctile': s.meta.bbWidthPctile,
      'Vol Ratio': s.meta.volRatio20,
      'RSI': s.meta.rsi,
      'Sector': s.meta.sectorKey ?? '',
      'Why Now': s.whyNow,
    })),
  }
}

function sectorRotationRows(snap: NonNullable<ReturnType<typeof getLatestSectorRotation>>): RowSet {
  return {
    title: 'Sector Rotation',
    subtitle: `Generated ${snap.generatedAt} · NIFTY 5d ${snap.niftyRet5d}% · 20d ${snap.niftyRet20d}%`,
    columns: [
      'Sector', 'Label', 'Ret 5d %', 'Ret 20d %', 'RelStr 5d %', 'RelStr 20d %',
      'Breadth >EMA21 %', 'Breadth >EMA50 %', 'Vol Ratio',
      'Rotating IN', 'Rotating OUT', 'Top Movers', 'Note',
    ],
    rows: snap.baskets.map(b => ({
      'Sector': b.key,
      'Label': b.label,
      'Ret 5d %': b.ret5d,
      'Ret 20d %': b.ret20d,
      'RelStr 5d %': b.relStr5d,
      'RelStr 20d %': b.relStr20d,
      'Breadth >EMA21 %': b.pctAboveEma21,
      'Breadth >EMA50 %': b.pctAboveEma50,
      'Vol Ratio': b.volRatio,
      'Rotating IN': b.rotatingIn ? 'YES' : '',
      'Rotating OUT': b.rotatingOut ? 'YES' : '',
      'Top Movers': b.topMovers.map(m => `${m.symbol} ₹${m.ltp} (${m.ret5d}%)`).join(' · '),
      'Note': b.note,
    })),
  }
}

function weeklyPickRows(wp: any): RowSet {
  return {
    title: 'Weekly Manager Pick',
    subtitle: `Week of ${wp.weekOf} · regime ${wp.regime}`,
    columns: [
      'Symbol', 'Source', 'LTP', 'Direction', 'Conviction',
      'Entry Low', 'Entry', 'Entry High', 'Entry Date', 'Best Time IST', 'Hora',
      'SL', 'T1', 'T1 Date', 'T2', 'T2 Date', 'T3', 'T3 Date',
      'Expected Return %', 'R:R',
      'SMC Note', 'Trend Note', 'Gann Note', 'Astro Note', 'Flow Note',
    ],
    rows: (wp.rows ?? []).map((r: any) => ({
      'Symbol': r.symbol,
      'Source': r.source,
      'LTP': r.ltp,
      'Direction': r.direction,
      'Conviction': r.conviction,
      'Entry Low': r.entryPriceLow,
      'Entry': r.entryPrice,
      'Entry High': r.entryPriceHigh,
      'Entry Date': r.entryDate,
      'Best Time IST': r.bestEntryTimeIST,
      'Hora': r.horaLord,
      'SL': r.stopLoss,
      'T1': r.target1, 'T1 Date': r.target1Date,
      'T2': r.target2, 'T2 Date': r.target2Date,
      'T3': r.target3, 'T3 Date': r.target3Date,
      'Expected Return %': r.expectedReturnPct,
      'R:R': r.riskRewardRatio,
      'SMC Note': r.smcNote,
      'Trend Note': r.trendNote,
      'Gann Note': r.gannNote,
      'Astro Note': r.astroNote,
      'Flow Note': r.flowNote,
    })),
  }
}

function dailyPickRows(dp: any): RowSet {
  return {
    title: 'Daily Pick',
    subtitle: `Generated ${dp.generatedAt} · regime ${dp.regime} · scanned ${dp.totalScanned}`,
    columns: [
      'Symbol', 'LTP', 'Direction', 'Pattern', 'Conviction',
      'Entry Low', 'Entry', 'Entry High', 'Entry Date', 'Best Time IST', 'Hora',
      'SL', 'T1', 'T1 Date', 'T2', 'T2 Date', 'T3', 'T3 Date',
      'Expected Return %', 'R:R',
      'Momentum', 'Rebound', 'RSI', 'Vol Ratio', 'Dist 52WH %', 'Above EMA50', 'Above EMA200',
      'Reasons',
    ],
    rows: (dp.rows ?? []).map((r: any) => ({
      'Symbol': r.symbol,
      'LTP': r.ltp,
      'Direction': r.direction,
      'Pattern': r.pattern,
      'Conviction': r.conviction,
      'Entry Low': r.entryPriceLow,
      'Entry': r.entryPrice,
      'Entry High': r.entryPriceHigh,
      'Entry Date': r.entryDate,
      'Best Time IST': r.bestEntryTimeIST,
      'Hora': r.horaLord,
      'SL': r.stopLoss,
      'T1': r.target1, 'T1 Date': r.target1Date,
      'T2': r.target2, 'T2 Date': r.target2Date,
      'T3': r.target3, 'T3 Date': r.target3Date,
      'Expected Return %': r.expectedReturnPct,
      'R:R': r.riskReward,
      'Momentum': r.momentumScore,
      'Rebound': r.reboundScore,
      'RSI': r.meta?.rsi ?? '',
      'Vol Ratio': r.meta?.volRatio ?? '',
      'Dist 52WH %': r.meta?.distFrom52WH ?? '',
      'Above EMA50': r.meta?.aboveEma50 ? 'YES' : 'NO',
      'Above EMA200': r.meta?.aboveEma200 ? 'YES' : 'NO',
      'Reasons': (r.reasons ?? []).join(' · '),
    })),
  }
}

function harmonicRows(hs: NonNullable<ReturnType<typeof getLastHarmonicScan>>): RowSet {
  return {
    title: 'Harmonic Patterns — Multi-Timeframe NSE Scan',
    subtitle: `Generated ${hs.generatedAt} · ${hs.symbolsScanned} symbols × ${hs.timeframesScanned} TFs · ${hs.totalPatterns} patterns`,
    columns: [
      'Symbol', 'Timeframe', 'Tier', 'Pattern', 'Direction', 'Trade', 'Confidence', 'LTP',
      'PRZ Low', 'PRZ High',
      'Entry', 'Entry Date', 'Entry Time IST', 'Hora',
      'SL', 'T1', 'T1 Date', 'T2', 'T2 Date', 'T3', 'T3 Date', 'R:R',
      'Invalidation Price', 'Invalidation Rule',
      'X', 'A', 'B', 'C', 'D', 'Detected At', 'Age Bars', 'Reasons',
    ],
    rows: hs.hits.map(h => ({
      'Symbol': h.symbol,
      'Timeframe': h.timeframe,
      'Tier': h.tier,
      'Pattern': h.patternName,
      'Direction': h.direction,
      'Trade': h.trade,
      'Confidence': h.confidence,
      'LTP': h.ltp,
      'PRZ Low': h.przLow,
      'PRZ High': h.przHigh,
      'Entry': h.entry,
      'Entry Date': h.entryDate,
      'Entry Time IST': h.entryTimeIST,
      'Hora': h.horaLord,
      'SL': h.stopLoss,
      'T1': h.target1, 'T1 Date': h.target1Date,
      'T2': h.target2, 'T2 Date': h.target2Date,
      'T3': h.target3, 'T3 Date': h.target3Date,
      'R:R': h.riskReward,
      'Invalidation Price': h.invalidationPrice,
      'Invalidation Rule': h.invalidationRule,
      'X': h.pivots[0]?.price ?? '',
      'A': h.pivots[1]?.price ?? '',
      'B': h.pivots[2]?.price ?? '',
      'C': h.pivots[3]?.price ?? '',
      'D': h.pivots[4]?.price ?? '',
      'Detected At': h.detectedAt,
      'Age Bars': h.ageBars,
      'Reasons': (h.reasons ?? []).join(' · '),
    })),
  }
}

function turtleSoupRows(run: NonNullable<ReturnType<typeof getLatestTurtleSoupRun>>): RowSet {
  return {
    title: 'ICT Turtle Soup — Pure Liquidity Sweep Reversal',
    subtitle: `Generated ${run.generatedAt} · scanned ${run.scanned} · qualified ${run.qualified}`,
    columns: [
      'Symbol', 'Timeframe', 'Direction', 'LTP',
      'Range Low', 'Range High', 'Range Mid', 'Range Size',
      'Swept Level', 'Sweep Wick', 'Sweep Close-back', 'Sweep Time',
      'HTF Order Flow',
      'Entry', 'SL', 'T1', 'T2', 'T3', 'R:R', 'Confidence',
      'Detected At', 'Reasons',
    ],
    rows: run.signals.map(s => ({
      'Symbol': s.symbol,
      'Timeframe': s.timeframe,
      'Direction': s.direction,
      'LTP': s.ltp,
      'Range Low': s.rangeLow,
      'Range High': s.rangeHigh,
      'Range Mid': s.rangeMidpoint,
      'Range Size': s.rangeSize,
      'Swept Level': s.sweptLevel,
      'Sweep Wick': s.sweepWickPrice,
      'Sweep Close-back': s.sweepCloseBack,
      'Sweep Time': s.sweepBarTime,
      'HTF Order Flow': s.htfOrderFlow,
      'Entry': s.entry,
      'SL': s.stopLoss,
      'T1': s.target1,
      'T2': s.target2,
      'T3': s.target3,
      'R:R': s.riskReward,
      'Confidence': s.confidence,
      'Detected At': s.detectedAt,
      'Reasons': (s.reasons ?? []).join(' · '),
    })),
  }
}

function signalsRows(signals: Signal[]): RowSet {
  return {
    title: 'Active Signals',
    subtitle: `${signals.length} signals · exported ${new Date().toISOString()}`,
    columns: [
      'Instrument', 'Type', 'Direction', 'Grade', 'Score',
      'Entry', 'SL', 'T1', 'T2', 'T3',
      'R:R', 'Risk %', 'Reward %', 'Pattern',
      'Source', 'Tier', 'Expires', 'Timestamp',
      'Reasons',
    ],
    rows: signals.map(s => ({
      'Instrument': s.instrument,
      'Type': s.type,
      'Direction': s.direction,
      'Grade': s.grade,
      'Score': s.score,
      'Entry': s.entry,
      'SL': s.stopLoss,
      'T1': s.target1,
      'T2': s.target2,
      'T3': s.target3 ?? '',
      'R:R': s.riskReward,
      'Risk %': s.riskPct,
      'Reward %': s.rewardPct,
      'Pattern': s.pattern,
      'Source': s.source,
      'Tier': s.tier ?? '',
      'Expires': s.expiresAt,
      'Timestamp': s.timestamp,
      'Reasons': (s.reasons ?? []).join(' · '),
    })),
  }
}

// ─── Format renderers ─────────────────────────────────────────

function finalize(slug: string, date: string, format: ExportFormat, rs: RowSet): ExportResult {
  if (format === 'csv') {
    return {
      body: toCsv(rs),
      mime: 'text/csv; charset=utf-8',
      filename: `${slug}-${date}.csv`,
    }
  }
  if (format === 'json') {
    return {
      body: JSON.stringify({ title: rs.title, subtitle: rs.subtitle, columns: rs.columns, rows: rs.rows }, null, 2),
      mime: 'application/json',
      filename: `${slug}-${date}.json`,
    }
  }
  return {
    body: toPrintableHtml(rs),
    mime: 'text/html; charset=utf-8',
    filename: `${slug}-${date}.html`,
  }
}

function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function toCsv(rs: RowSet): string {
  const lines: string[] = []
  lines.push(`# ${rs.title}`)
  if (rs.subtitle) lines.push(`# ${rs.subtitle}`)
  lines.push(rs.columns.join(','))
  for (const row of rs.rows) {
    lines.push(rs.columns.map(c => csvCell(row[c])).join(','))
  }
  return lines.join('\n')
}

/**
 * Print-friendly HTML — opens in a new tab and the browser's native "Save as
 * PDF" handles the rest. Avoids needing any PDF library on the server.
 */
function toPrintableHtml(rs: RowSet): string {
  const escape = (v: unknown) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const headerRow = rs.columns.map(c => `<th>${escape(c)}</th>`).join('')
  const dataRows = rs.rows.map(r =>
    `<tr>${rs.columns.map(c => `<td>${escape(r[c] ?? '')}</td>`).join('')}</tr>`,
  ).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escape(rs.title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font: 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #555; margin: 0 0 10px; font-size: 11px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; }
  tr:nth-child(even) td { background: #fafafa; }
  .footer { margin-top: 14px; font-size: 10px; color: #888; }
  @media print { .no-print { display: none; } }
  .actions { margin: 8px 0 16px; }
  .actions button {
    background: #111; color: #fff; border: 0; padding: 6px 12px;
    border-radius: 4px; font-size: 12px; cursor: pointer; margin-right: 6px;
  }
</style>
</head>
<body>
  <h1>${escape(rs.title)}</h1>
  <p class="sub">${escape(rs.subtitle ?? '')}</p>
  <div class="actions no-print">
    <button onclick="window.print()">🖨️ Save as PDF / Print</button>
    <button onclick="window.close()">Close</button>
  </div>
  <table>
    <thead><tr>${headerRow}</tr></thead>
    <tbody>${dataRows}</tbody>
  </table>
  <p class="footer">Generated by HedgeFund OS · #tradewithvarsha</p>
</body>
</html>`
}
