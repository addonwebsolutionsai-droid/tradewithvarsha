/**
 * Sector Rotation detector.
 *
 * Why this exists (2026-04-29):
 * The user pointed out we missed DMART, HINDUNILVR, VOLTAS — three FMCG /
 * consumer-discretionary names that ran ~10 % in 20 days while NIFTY itself
 * was getting sold (24717 → 23960 over 5 days). Money wasn't leaving the
 * market — it was rotating into defensive sectors. The signal engine was
 * treating each name in isolation and missing the collective bid.
 *
 * This module groups our universe into sectoral baskets, computes each
 * basket's 5d / 20d return relative to NIFTY, and flags baskets that are:
 *
 *   1. OUTPERFORMING NIFTY by ≥3% on the 5-day window
 *   2. Net BULLISH (more than 60 % of constituents above EMA21)
 *   3. With recent VOLUME PICKUP (basket-avg vol > 1.3× 30-day baseline)
 *
 * When all three fire, we publish "ROTATION INTO X" — the daily-pick / master
 * setup engines then over-weight names from that sector (so DMART surfaces
 * the day FMCG turns, not a week later when retail piles in).
 *
 * Output is a snapshot the master-setup engine and Telegram digest both read.
 */

import * as data from '../data'
import { ema } from '../indicators'
import { log } from '../util/logger'
import type { Candle } from '../types'

export type SectorKey =
  | 'FMCG' | 'IT' | 'AUTO' | 'PHARMA' | 'METALS' | 'BANKS_PVT' | 'BANKS_PSU'
  | 'ENERGY' | 'INFRA' | 'REALTY' | 'CONSUMPTION' | 'DEFENCE' | 'CAPITAL_GOODS'

export interface SectorBasket {
  key: SectorKey
  label: string
  members: string[]
}

export const SECTOR_BASKETS: SectorBasket[] = [
  { key: 'FMCG', label: 'FMCG / Consumer Staples', members: [
    'HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'DABUR', 'GODREJCP', 'COLPAL',
    'MARICO', 'TATACONSUM', 'EMAMILTD', 'VBL', 'UBL', 'RADICO', 'JUBLFOOD', 'DMART',
  ]},
  { key: 'IT', label: 'IT Services', members: [
    'TCS', 'INFY', 'HCLTECH', 'WIPRO', 'TECHM', 'LTIM', 'PERSISTENT', 'MPHASIS',
    'COFORGE', 'LTTS', 'CYIENT', 'KPITTECH', 'TATAELXSI', 'TANLA', 'INTELLECT',
  ]},
  { key: 'AUTO', label: 'Auto + Auto Anc', members: [
    'MARUTI', 'TATAMOTORS', 'M&M', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT',
    'TVSMOTOR', 'ASHOKLEY', 'ESCORTS', 'BHARATFORG', 'MOTHERSON', 'EXIDEIND',
    'BALKRISIND', 'MRF', 'APOLLOTYRE', 'BOSCHLTD', 'ENDURANCE', 'SUNDRMFAST',
  ]},
  { key: 'PHARMA', label: 'Pharma + Healthcare', members: [
    'SUNPHARMA', 'CIPLA', 'DRREDDY', 'DIVISLAB', 'TORNTPHARM', 'LUPIN', 'AUROPHARMA',
    'ZYDUSLIFE', 'GLENMARK', 'BIOCON', 'ALKEM', 'IPCALAB', 'MANKIND', 'LAURUSLABS',
    'APOLLOHOSP', 'MAXHEALTH', 'FORTIS', 'NH',
  ]},
  { key: 'METALS', label: 'Metals & Mining', members: [
    'TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'COALINDIA', 'VEDL', 'SAIL', 'JINDALSTEL',
    'NMDC', 'HINDZINC', 'HINDCOPPER', 'NATIONALUM', 'MOIL',
  ]},
  { key: 'BANKS_PVT', label: 'Private Banks', members: [
    'HDFCBANK', 'ICICIBANK', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK',
    'IDFCFIRSTB', 'FEDERALBNK', 'RBLBANK', 'BANDHANBNK',
  ]},
  { key: 'BANKS_PSU', label: 'PSU Banks', members: [
    'SBIN', 'PNB', 'CANBK', 'BANKBARODA', 'IOB', 'CENTRALBK', 'UCOBANK', 'IDBI',
  ]},
  { key: 'ENERGY', label: 'Energy / Oil & Gas', members: [
    'RELIANCE', 'ONGC', 'IOC', 'BPCL', 'HINDPETRO', 'GAIL', 'OIL',
  ]},
  { key: 'INFRA', label: 'Infra + Construction', members: [
    'LT', 'ULTRACEMCO', 'GRASIM', 'AMBUJACEM', 'SHREECEM', 'ACC', 'DALBHARAT',
    'JKCEMENT', 'RAMCOCEM',
  ]},
  { key: 'REALTY', label: 'Realty', members: [
    'DLF', 'OBEROIRLTY', 'PRESTIGE', 'GODREJPROP', 'LODHA', 'PHOENIXLTD', 'BRIGADE',
  ]},
  { key: 'CONSUMPTION', label: 'Consumer Discretionary', members: [
    'TITAN', 'ASIANPAINT', 'HAVELLS', 'CROMPTON', 'POLYCAB', 'VOLTAS', 'BLUESTARCO',
    'PIDILITIND', 'BERGEPAINT', 'TRENT', 'DMART', 'PAGEIND', 'RELAXO', 'BATAINDIA',
    'METROBRAND', 'AMBER', 'DIXON', 'WHIRLPOOL', 'IFBIND', 'SYMPHONY', 'TTKPRESTIG',
  ]},
  { key: 'DEFENCE', label: 'Defence + Railways', members: [
    'HAL', 'BEL', 'BHARATDYN', 'MAZDOCK', 'GRSE', 'COCHINSHIP', 'BEML', 'MIDHANI',
    'DATAPATTNS', 'IRCTC', 'IRFC', 'IRCON', 'RVNL', 'CONCOR', 'RAILTEL', 'RITES',
  ]},
  { key: 'CAPITAL_GOODS', label: 'Capital Goods', members: [
    'SIEMENS', 'ABB', 'CUMMINSIND', 'THERMAX', 'BHEL', 'KEC', 'KALPATPOWR',
    'POWERINDIA', 'KIRLOSIND',
  ]},
]

export interface SectorReading {
  key: SectorKey
  label: string
  // Returns (each %, vs nothing — relative-to-NIFTY computed separately)
  ret5d: number
  ret20d: number
  // Relative strength vs NIFTY
  relStr5d: number     // ret5d - NIFTY ret5d
  relStr20d: number    // ret20d - NIFTY ret20d
  // Breadth
  pctAboveEma21: number   // % of constituents above EMA21
  pctAboveEma50: number
  // Volume
  volRatio: number     // basket-avg today vs 30d basket-avg
  // Verdict
  rotatingIn: boolean      // money flowing IN
  rotatingOut: boolean     // money flowing OUT
  topMovers: Array<{ symbol: string; ret5d: number; ret20d: number; ltp: number }>
  note: string
}

export interface SectorRotationSnapshot {
  generatedAt: string
  niftyRet5d: number
  niftyRet20d: number
  baskets: SectorReading[]
  /** Sectors money is rotating INTO right now (≥3% relative outperformance + breadth + volume). */
  rotatingIntoSectors: SectorKey[]
  /** Sectors being abandoned. */
  rotatingOutSectors: SectorKey[]
  /** One-line verdict for Telegram/digest. */
  oneLineSummary: string
}

const REL_OUTPERF_BPS = 3.0     // ≥ 3% outperformance over 5d
const BREADTH_FLOOR = 60         // ≥ 60% of names above EMA21
const VOL_PICKUP = 1.3           // basket-avg vol ≥ 1.3× 30d

interface NameStats {
  symbol: string
  ret5d: number
  ret20d: number
  aboveEma21: boolean
  aboveEma50: boolean
  volRatio30: number
  ltp: number
}

async function statsFor(symbol: string): Promise<NameStats | null> {
  try {
    const [candles, quote] = await Promise.all([
      data.getCandles(symbol, '1D', 90),
      data.getQuote(symbol).catch(() => null),
    ])
    if (candles.length < 30) return null
    const last = candles[candles.length - 1]
    const ltp = quote?.price && quote.price > 0 ? quote.price : last.close
    const ref5 = candles[candles.length - 6]?.close ?? last.close
    const ref20 = candles[candles.length - 21]?.close ?? last.close
    const ret5d = ((ltp - ref5) / ref5) * 100
    const ret20d = ((ltp - ref20) / ref20) * 100
    const e21 = ema(candles, 21).slice(-1)[0]
    const e50 = ema(candles, 50).slice(-1)[0]
    const vols30 = candles.slice(-31, -1).map(c => c.volume)
    const avgVol30 = vols30.reduce((s, v) => s + v, 0) / Math.max(1, vols30.length)
    const volRatio30 = avgVol30 > 0 ? last.volume / avgVol30 : 0
    return {
      symbol,
      ret5d: +ret5d.toFixed(2),
      ret20d: +ret20d.toFixed(2),
      aboveEma21: !!(e21 && ltp > e21),
      aboveEma50: !!(e50 && ltp > e50),
      volRatio30: +volRatio30.toFixed(2),
      ltp: +ltp.toFixed(2),
    }
  } catch { return null }
}

let lastSnapshot: SectorRotationSnapshot | null = null

export async function runSectorRotationScan(): Promise<SectorRotationSnapshot> {
  const now = new Date()
  log.info('SECTOR', 'Sector-rotation scan starting...')

  // NIFTY baseline first
  const niftyCandles = await data.getCandles('NIFTY', '1D', 30).catch(() => [] as Candle[])
  let niftyRet5d = 0, niftyRet20d = 0
  if (niftyCandles.length >= 21) {
    const lastN = niftyCandles[niftyCandles.length - 1].close
    const ref5 = niftyCandles[niftyCandles.length - 6]?.close ?? lastN
    const ref20 = niftyCandles[niftyCandles.length - 21]?.close ?? lastN
    niftyRet5d = ((lastN - ref5) / ref5) * 100
    niftyRet20d = ((lastN - ref20) / ref20) * 100
  }

  const baskets: SectorReading[] = []
  for (const basket of SECTOR_BASKETS) {
    const stats: NameStats[] = []
    // Cap concurrency per basket; 4 parallel reads at a time keeps Angel inside budget.
    let cur = 0
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cur < basket.members.length) {
        const sym = basket.members[cur++]
        const s = await statsFor(sym)
        if (s) stats.push(s)
      }
    }))
    if (stats.length < 3) continue   // not enough data to call rotation

    const ret5d = avg(stats.map(s => s.ret5d))
    const ret20d = avg(stats.map(s => s.ret20d))
    const relStr5d = ret5d - niftyRet5d
    const relStr20d = ret20d - niftyRet20d
    const pctAboveEma21 = (stats.filter(s => s.aboveEma21).length / stats.length) * 100
    const pctAboveEma50 = (stats.filter(s => s.aboveEma50).length / stats.length) * 100
    const volRatio = avg(stats.map(s => s.volRatio30))
    const top = [...stats].sort((a, b) => b.ret5d - a.ret5d).slice(0, 5)
      .map(s => ({ symbol: s.symbol, ret5d: s.ret5d, ret20d: s.ret20d, ltp: s.ltp }))

    const rotatingIn = relStr5d >= REL_OUTPERF_BPS && pctAboveEma21 >= BREADTH_FLOOR && volRatio >= VOL_PICKUP
    const rotatingOut = relStr5d <= -REL_OUTPERF_BPS && pctAboveEma21 <= (100 - BREADTH_FLOOR)

    let note: string
    if (rotatingIn) {
      note = `🟢 ROTATING IN — basket ${ret5d > 0 ? '+' : ''}${ret5d.toFixed(1)}% (vs NIFTY ${niftyRet5d > 0 ? '+' : ''}${niftyRet5d.toFixed(1)}%) · breadth ${pctAboveEma21.toFixed(0)}% > EMA21 · vol ${volRatio.toFixed(1)}×`
    } else if (rotatingOut) {
      note = `🔴 ROTATING OUT — basket ${ret5d.toFixed(1)}% · breadth ${pctAboveEma21.toFixed(0)}% > EMA21`
    } else {
      note = `⚪ neutral — basket ${ret5d > 0 ? '+' : ''}${ret5d.toFixed(1)}% · rel ${relStr5d > 0 ? '+' : ''}${relStr5d.toFixed(1)}% vs NIFTY`
    }

    baskets.push({
      key: basket.key, label: basket.label,
      ret5d: +ret5d.toFixed(2), ret20d: +ret20d.toFixed(2),
      relStr5d: +relStr5d.toFixed(2), relStr20d: +relStr20d.toFixed(2),
      pctAboveEma21: +pctAboveEma21.toFixed(0), pctAboveEma50: +pctAboveEma50.toFixed(0),
      volRatio: +volRatio.toFixed(2),
      rotatingIn, rotatingOut,
      topMovers: top, note,
    })
  }

  const rotatingIntoSectors = baskets.filter(b => b.rotatingIn).map(b => b.key)
  const rotatingOutSectors = baskets.filter(b => b.rotatingOut).map(b => b.key)
  const inLabels = baskets.filter(b => b.rotatingIn).sort((a, b) => b.relStr5d - a.relStr5d).map(b => b.label).slice(0, 3)
  const outLabels = baskets.filter(b => b.rotatingOut).sort((a, b) => a.relStr5d - b.relStr5d).map(b => b.label).slice(0, 3)
  const oneLineSummary = inLabels.length || outLabels.length
    ? `Rotation: ${inLabels.length ? `IN → ${inLabels.join(', ')}` : 'no clear inflow'}${outLabels.length ? ` · OUT ← ${outLabels.join(', ')}` : ''}`
    : 'No clear sector rotation today — broad market in sync.'

  const snap: SectorRotationSnapshot = {
    generatedAt: now.toISOString(),
    niftyRet5d: +niftyRet5d.toFixed(2),
    niftyRet20d: +niftyRet20d.toFixed(2),
    baskets: baskets.sort((a, b) => b.relStr5d - a.relStr5d),
    rotatingIntoSectors,
    rotatingOutSectors,
    oneLineSummary,
  }
  lastSnapshot = snap
  log.ok('SECTOR', `Rotation scan: IN=[${rotatingIntoSectors.join(',')}] OUT=[${rotatingOutSectors.join(',')}]`)
  return snap
}

export function getLatestSectorRotation(): SectorRotationSnapshot | null { return lastSnapshot }

export function formatSectorRotationForTelegram(s: SectorRotationSnapshot): string {
  const lines: string[] = []
  lines.push(`🌀 *SECTOR ROTATION · ${s.generatedAt.slice(0, 10)}*`)
  lines.push(`NIFTY 5d ${s.niftyRet5d > 0 ? '+' : ''}${s.niftyRet5d.toFixed(1)}% · 20d ${s.niftyRet20d > 0 ? '+' : ''}${s.niftyRet20d.toFixed(1)}%`)
  lines.push('')
  const top = s.baskets.slice(0, 6)
  for (const b of top) {
    lines.push(`${b.rotatingIn ? '🟢' : b.rotatingOut ? '🔴' : '⚪'} *${b.label}* · 5d ${b.ret5d > 0 ? '+' : ''}${b.ret5d.toFixed(1)}% · rel ${b.relStr5d > 0 ? '+' : ''}${b.relStr5d.toFixed(1)}% · breadth ${b.pctAboveEma21}%`)
    if (b.rotatingIn && b.topMovers.length) {
      const movers = b.topMovers.slice(0, 3).map(m => `${m.symbol} ₹${m.ltp} (${m.ret5d > 0 ? '+' : ''}${m.ret5d}%)`).join(' · ')
      lines.push(`   _Top: ${movers}_`)
    }
  }
  lines.push('')
  lines.push(`💡 _${s.oneLineSummary}_`)
  lines.push('*#tradewithvarsha*')
  return lines.join('\n')
}

function avg(a: number[]): number { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0 }
