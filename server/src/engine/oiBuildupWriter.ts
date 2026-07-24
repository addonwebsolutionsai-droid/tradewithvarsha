/**
 * Extracted OI Buildup snapshot writer.
 *
 * The full OI-buildup pipeline used to live only inside publicSnapshots.ts →
 * publishPublicSnapshots(), which is called ONLY by the localhost cron in
 * server/src/index.ts. On GH Actions runners (which is where the intraday
 * cron actually runs 24/5), that code path never fires — so oi-buildup.json
 * on GitHub raw was going stale for weeks at a time.
 *
 * This module is the standalone writer. It ticks the OI monitor + turns the
 * result into the same JSON shape publicSnapshots.ts produces, then writes
 * to server/data/public-snapshots/oi-buildup.json. Wired into
 * gh-tick-intraday so the file refreshes every 5 min during market hours.
 *
 * Preserves the existing UX contract:
 *   - Fields: symbols[], summary[], rows[], generatedAt, dataMode,
 *     isMarketHours, lastFlowAt
 *   - When live deltas are absent (weekend / pre-open), preserves the last
 *     non-empty snapshot's rows + lastFlowAt so the UI can show END-OF-DAY
 *     positioning instead of a blank page.
 */

import fs from 'fs/promises'
import path from 'path'
import { tickOiMonitor, getLatestOiAnalysis } from './oiMonitor'
import { log } from '../util/logger'

const SNAP_PATH = path.resolve(__dirname, '../../data/public-snapshots/oi-buildup.json')

export async function writeOiBuildupSnapshot(): Promise<{ rows: number; symbols: string[]; dataMode: string }> {
  try { await tickOiMonitor() } catch (e) { log.warn('OI-WRITER', `tickOiMonitor failed: ${(e as Error).message}`) }
  const oi = getLatestOiAnalysis()
  const ts = new Date().toISOString()

  const istNow = new Date(Date.now() + 5.5 * 3600_000)
  const istDow = istNow.getUTCDay()
  const istHour = istNow.getUTCHours()
  const istMin = istNow.getUTCMinutes()
  const minOfDay = istHour * 60 + istMin
  const isMarketHours = istDow >= 1 && istDow <= 5 && minOfDay >= 9 * 60 + 15 && minOfDay < 15 * 60 + 30

  // Drop rows whose expiry is already expired (daysToExpiry < 0)
  const expiredAnalysis: string[] = []
  for (const [u, a] of Object.entries(oi)) {
    const daysToExpiry = a && (a as any).daysToExpiry
    if (a && typeof daysToExpiry === 'number' && daysToExpiry < 0) {
      expiredAnalysis.push(`${u}@${(a as any).expiry}`)
    }
  }

  const buildupRows: any[] = []
  for (const [underlying, a] of Object.entries(oi)) {
    if (!a) continue
    if (expiredAnalysis.some(x => x.startsWith(underlying + '@'))) continue

    let flows = [...(a.top3Bullish ?? []), ...(a.top3Bearish ?? [])]
      .filter((f: any) => (f?.strength ?? 0) >= 35)
      .slice(0, 8)

    // Fallback: use largest absolute-OI parked strikes when no delta flows exist
    if (flows.length === 0 && (a as any).strikeFlows && (a as any).strikeFlows.length) {
      const all = (a as any).strikeFlows as any[]
      const ceHeavy = all
        .filter(f => f.side === 'CE' && f.strike >= a.spot)
        .sort((x, y) => (y.currentOI ?? 0) - (x.currentOI ?? 0))
        .slice(0, 3)
        .map(f => ({ ...f, bias: 'BEARISH', kind: f.kind || 'CE_PARKED', strength: Math.max(f.strength ?? 0, 35), note: f.note || `Heavy CE writing parked at ${f.strike} — institutional resistance` }))
      const peHeavy = all
        .filter(f => f.side === 'PE' && f.strike <= a.spot)
        .sort((x, y) => (y.currentOI ?? 0) - (x.currentOI ?? 0))
        .slice(0, 3)
        .map(f => ({ ...f, bias: 'BULLISH', kind: f.kind || 'PE_PARKED', strength: Math.max(f.strength ?? 0, 35), note: f.note || `Heavy PE writing parked at ${f.strike} — institutional support` }))
      flows = [...peHeavy, ...ceHeavy]
    }

    for (const f of flows) {
      const atrProxy = a.spot * 0.005
      const bullish = f.bias === 'BULLISH'
      const tradeSide: 'CE' | 'PE' = bullish ? 'CE' : 'PE'
      const tradeStrike = (a as any).atmStrike ?? Math.round(a.spot / 50) * 50
      const tradeLtp = bullish
        ? ((a as any).atmCeLtp ?? +(a.spot * 0.01).toFixed(2))
        : ((a as any).atmPeLtp ?? +(a.spot * 0.01).toFixed(2))
      const entry = +tradeLtp.toFixed(2)
      const spotEntry = a.spot
      const spotSL = bullish ? +(spotEntry - atrProxy * 2).toFixed(2) : +(spotEntry + atrProxy * 2).toFixed(2)
      const spotT1 = bullish ? +(spotEntry + atrProxy * 2).toFixed(2) : +(spotEntry - atrProxy * 2).toFixed(2)
      const spotT2 = bullish ? +(spotEntry + atrProxy * 4).toFixed(2) : +(spotEntry - atrProxy * 4).toFixed(2)
      buildupRows.push({
        underlying,
        expiry: (a as any).expiry ?? null,
        daysToExpiry: (a as any).daysToExpiry ?? null,
        strike: f.strike,
        side: f.side,
        kind: f.kind,
        bias: f.bias,
        strength: Math.round(f.strength ?? 0),
        oiChange: f.oiChange,
        oiChangePct: f.currentOI > 0 ? +(f.oiChange / f.currentOI * 100).toFixed(1) : null,
        ltpChange: f.ltpChange,
        ltpChangePct: f.ltpChangePct,
        currentOI: f.currentOI,
        currentLTP: f.currentLTP,
        currentIV: f.currentIV,
        currentVol: f.currentVol,
        spot: a.spot,
        pcr: a.pcr,
        maxPain: a.maxPain,
        note: f.note,
        tradeSide, tradeStrike,
        tradeInstrument: `${underlying} ${tradeStrike} ${tradeSide}`,
        tradeAction: `BUY ${underlying} ${tradeStrike} ${tradeSide}`,
        entry,
        stopLoss: +(entry * 0.7).toFixed(2),
        target1: +(entry * 1.4).toFixed(2),
        target2: +(entry * 1.8).toFixed(2),
        spotEntry, spotSL, spotT1, spotT2,
      })
    }
  }

  const summary = Object.entries(oi).filter(([, a]) => a).map(([u, a]: any) => ({
    underlying: u,
    expiry: a.expiry ?? null,
    daysToExpiry: a.daysToExpiry ?? null,
    spot: a.spot, pcr: a.pcr, maxPain: a.maxPain,
    dominantBias: a.dominantBias,
    summary: a.summary,
    biasBreakdown: a.biasBreakdown,
  }))

  const hasLiveDeltas = buildupRows.some(r => Math.abs(r.oiChange ?? 0) > 0)
  let dataMode: 'LIVE' | 'END_OF_DAY' | 'PRE_OPEN'
  if (isMarketHours) dataMode = hasLiveDeltas ? 'LIVE' : 'PRE_OPEN'
  else dataMode = 'END_OF_DAY'
  let lastFlowAt: string | null = hasLiveDeltas ? ts : null
  let rowsOut = buildupRows
  let summaryOut = summary

  // Preserve last non-empty snapshot for the UI when this tick has no data
  if (buildupRows.length === 0) {
    try {
      const prevRaw = await fs.readFile(SNAP_PATH, 'utf-8')
      const prev = JSON.parse(prevRaw)
      if ((prev.rows ?? []).length > 0) {
        rowsOut = prev.rows
        summaryOut = prev.summary ?? summary
        lastFlowAt = prev.lastFlowAt ?? prev.generatedAt
      }
    } catch { /* no prior file */ }
  } else if (!hasLiveDeltas) {
    try {
      const prevRaw = await fs.readFile(SNAP_PATH, 'utf-8')
      const prev = JSON.parse(prevRaw)
      if (prev.lastFlowAt) lastFlowAt = prev.lastFlowAt
    } catch { /* ignore */ }
  }

  const oiOut = {
    generatedAt: ts,
    dataMode,
    isMarketHours,
    lastFlowAt,
    symbols: Object.keys(oi).filter(k => oi[k]),
    summary: summaryOut,
    rows: rowsOut,
  }
  await fs.mkdir(path.dirname(SNAP_PATH), { recursive: true })
  await fs.writeFile(SNAP_PATH, JSON.stringify(oiOut, null, 2))
  log.info('OI-WRITER', `wrote ${oiOut.rows.length} rows · ${oiOut.symbols.length} symbols · mode=${dataMode}`)
  return { rows: oiOut.rows.length, symbols: oiOut.symbols, dataMode }
}
