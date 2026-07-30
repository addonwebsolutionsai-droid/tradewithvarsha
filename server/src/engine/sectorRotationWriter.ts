/**
 * Standalone Sector-Rotation snapshot writer.
 *
 * Same rationale as `oiBuildupWriter.ts` — the sector-rotation snapshot
 * builder used to live inside `publishPublicSnapshots()` in
 * `publicSnapshots.ts`, which is fired only by the localhost cron in
 * `server/src/index.ts`. GH Actions never called that path, so
 * `sector-rotation.json` on GitHub raw was going 20+ days stale
 * (2026-07-10 last write). This module is the extracted writer; the EOD
 * cron in `scripts/gh-tick-eod.ts` calls it now so the snapshot refreshes
 * every trading day.
 *
 * Adds the money-flow columns the user asked for on 2026-07-30:
 *   - dayInflowCr / weekInflowCr per sector (MFI-style signed ₹ Cr)
 *   - dayTurnoverCr / dayFlowVsAvgPct
 *   - topInflowStocks[] — stock-wise breakdown for each sector
 */

import fs from 'fs/promises'
import path from 'path'
import { runSectorRotationScan } from './sectorRotation'
import { log } from '../util/logger'

const SNAP_PATH = path.resolve(__dirname, '../../data/public-snapshots/sector-rotation.json')

export async function writeSectorRotationSnapshot(): Promise<{ rows: number; leading: string[]; lagging: string[]; totalDayInflowCr: number }> {
  const ts = new Date().toISOString()
  const snap = await Promise.race<any>([
    runSectorRotationScan(),
    new Promise<any>((_, rej) => setTimeout(() => rej(new Error('sector-rotation timeout')), 180_000)),
  ])

  const rows = (snap?.baskets ?? []).map((b: any) => {
    const trend = b.rotatingIn ? 'LEADING' :
      b.rotatingOut ? 'LAGGING' :
      (b.relStr5d > 0 && b.relStr20d > 0) ? 'IMPROVING' :
      (b.relStr5d < 0 && b.relStr20d < 0) ? 'WEAKENING' : 'NEUTRAL'
    const rotationScore = +(
      b.relStr20d * 0.5 +
      b.relStr5d * 0.3 +
      (b.pctAboveEma21 - 50) / 5
    ).toFixed(1)
    return {
      index: b.key,
      label: b.label,
      ltp: 0,
      ret5d: b.ret5d,
      ret20d: b.ret20d,
      ret60d: 0,
      relStr5d: b.relStr5d,
      relStr20d: b.relStr20d,
      pctAboveEma21: b.pctAboveEma21,
      pctAboveEma50: b.pctAboveEma50,
      volRatio5_20: b.volRatio,
      rotationScore,
      trend,
      // Money-flow columns (₹ Cr) ─ what the user asked for on 30 Jul
      dayInflowCr: b.dayInflowCr ?? 0,
      weekInflowCr: b.weekInflowCr ?? 0,
      dayTurnoverCr: b.dayTurnoverCr ?? 0,
      dayFlowVsAvgPct: b.dayFlowVsAvgPct ?? 0,
      topInflowStocks: b.topInflowStocks ?? [],
      reasons: [
        `20d ${b.ret20d >= 0 ? '+' : ''}${b.ret20d.toFixed(1)}% (vs NIFTY ${b.relStr20d >= 0 ? '+' : ''}${b.relStr20d.toFixed(1)}%)`,
        `5d ${b.ret5d >= 0 ? '+' : ''}${b.ret5d.toFixed(1)}% (vs NIFTY ${b.relStr5d >= 0 ? '+' : ''}${b.relStr5d.toFixed(1)}%)`,
        `${b.pctAboveEma21.toFixed(0)}% above EMA21`,
        `vol ${b.volRatio.toFixed(2)}× 30d`,
        `flow ${b.dayInflowCr >= 0 ? '+' : ''}₹${(b.dayInflowCr ?? 0).toFixed(0)} Cr today · ${b.weekInflowCr >= 0 ? '+' : ''}₹${(b.weekInflowCr ?? 0).toFixed(0)} Cr past 5d`,
      ],
      topMovers: b.topMovers ?? [],
      note: b.note,
    }
  }).sort((a: any, b: any) => b.rotationScore - a.rotationScore)

  const totalDayInflowCr = rows.reduce((s: number, r: any) => s + (r.dayInflowCr ?? 0), 0)

  const out = {
    generatedAt: ts,
    niftyRet5d: snap?.niftyRet5d ?? 0,
    niftyRet20d: snap?.niftyRet20d ?? 0,
    total: rows.length,
    totalDayInflowCr: +totalDayInflowCr.toFixed(1),
    leading: rows.filter((s: any) => s.trend === 'LEADING').map((s: any) => s.label),
    lagging: rows.filter((s: any) => s.trend === 'LAGGING').map((s: any) => s.label),
    oneLineSummary: snap?.oneLineSummary ?? '',
    rows,
  }
  await fs.mkdir(path.dirname(SNAP_PATH), { recursive: true })
  await fs.writeFile(SNAP_PATH, JSON.stringify(out, null, 2))
  log.ok('SECTOR-WRITER', `wrote ${rows.length} sectors · net flow ${totalDayInflowCr >= 0 ? '+' : ''}₹${totalDayInflowCr.toFixed(0)} Cr today`)
  return { rows: rows.length, leading: out.leading, lagging: out.lagging, totalDayInflowCr: out.totalDayInflowCr }
}
