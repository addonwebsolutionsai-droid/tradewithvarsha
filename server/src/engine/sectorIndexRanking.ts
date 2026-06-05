/**
 * Sector Index Ranking — ranks the 12 main NIFTY sectoral indices by
 * composite strength so the new public Sectors tab can show LEADING vs
 * LAGGING baskets at a glance.
 *
 * Distinct from the existing `sectorRotation.ts` engine which uses
 * custom stock baskets (FMCG/IT/AUTO etc.) to feed master-setup and
 * pre-move screeners. This module is index-based (CNXBANK / CNXIT /
 * CNXAUTO ...) and is purely a public-facing snapshot.
 *
 * For each sector: ret5d, ret20d, ret60d, RSI(14), distance from 20d
 * high, vol5/vol20. Composite "rotation score" = ret20d * 0.5 + ret5d
 * * 0.3 + (RSI - 50)/50 * 20, clamped [-100, +100].
 */
import * as data from '../data'
import { log } from '../util/logger'

export interface SectorIndexRanking {
  index: string
  label: string
  ltp: number
  ret5d: number
  ret20d: number
  ret60d: number
  rsi14: number
  distFromHigh20: number
  volRatio5_20: number
  rotationScore: number
  trend: 'LEADING' | 'IMPROVING' | 'WEAKENING' | 'LAGGING' | 'NEUTRAL'
  reasons: string[]
}

const SECTORS: { index: string; label: string }[] = [
  { index: 'CNXBANK',     label: 'Banking' },
  { index: 'CNXIT',       label: 'IT' },
  { index: 'CNXAUTO',     label: 'Auto' },
  { index: 'CNXPHARMA',   label: 'Pharma' },
  { index: 'CNXFMCG',     label: 'FMCG' },
  { index: 'CNXMETAL',    label: 'Metal' },
  { index: 'CNXREALTY',   label: 'Realty' },
  { index: 'CNXENERGY',   label: 'Energy' },
  { index: 'CNXINFRA',    label: 'Infra' },
  { index: 'CNXFINANCE',  label: 'Financial Services' },
  { index: 'CNXMEDIA',    label: 'Media' },
  { index: 'CNXPSUBANK',  label: 'PSU Bank' },
]

function rsi14(closes: number[]): number {
  if (closes.length < 15) return 50
  let g = 0, l = 0
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) g += d; else l -= d
  }
  if (l === 0) return 100
  return 100 - 100 / (1 + g / l)
}

export async function scanSectorIndexRanking(): Promise<SectorIndexRanking[]> {
  log.info('SECTOR-IDX', `scanning ${SECTORS.length} sector indices`)
  const out: SectorIndexRanking[] = []
  for (const s of SECTORS) {
    try {
      const candles = await data.getCandles(s.index, '1D' as any, 80)
      if (!candles || candles.length < 25) continue
      const closes = candles.map(c => c.close)
      const vols = candles.map(c => c.volume)
      const price = closes[closes.length - 1]
      const ret5d = ((price - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
      const ret20d = ((price - closes[closes.length - 21]) / closes[closes.length - 21]) * 100
      const ret60d = closes.length >= 61 ? ((price - closes[closes.length - 61]) / closes[closes.length - 61]) * 100 : 0
      const high20 = Math.max(...closes.slice(-20))
      const distFromHigh20 = ((high20 - price) / high20) * 100
      const v5 = vols.slice(-5).reduce((s, x) => s + x, 0) / 5
      const v20 = vols.slice(-20).reduce((s, x) => s + x, 0) / 20
      const volRatio = v20 > 0 ? v5 / v20 : 1
      const r = rsi14(closes)
      const rotationScore = Math.max(-100, Math.min(100,
        ret20d * 0.5 + ret5d * 0.3 + ((r - 50) / 50) * 20,
      ))
      let trend: SectorIndexRanking['trend'] = 'NEUTRAL'
      if (ret20d > 5 && ret5d > 0 && distFromHigh20 < 5) trend = 'LEADING'
      else if (ret5d > 0 && ret20d < 5 && r > 50) trend = 'IMPROVING'
      else if (ret20d < -5 && ret5d < 0) trend = 'LAGGING'
      else if (ret5d < 0 && ret20d > 0) trend = 'WEAKENING'
      const reasons: string[] = [
        `20d ${ret20d >= 0 ? '+' : ''}${ret20d.toFixed(1)}%`,
        `5d ${ret5d >= 0 ? '+' : ''}${ret5d.toFixed(1)}%`,
        `RSI ${r.toFixed(0)}`,
        `${distFromHigh20.toFixed(1)}% off 20d hi`,
      ]
      if (volRatio > 1.3) reasons.push(`vol ${volRatio.toFixed(2)}× rising`)
      out.push({
        index: s.index, label: s.label, ltp: +price.toFixed(2),
        ret5d: +ret5d.toFixed(2), ret20d: +ret20d.toFixed(2), ret60d: +ret60d.toFixed(2),
        rsi14: +r.toFixed(1), distFromHigh20: +distFromHigh20.toFixed(2),
        volRatio5_20: +volRatio.toFixed(2),
        rotationScore: +rotationScore.toFixed(1),
        trend, reasons,
      })
    } catch (e) {
      log.warn('SECTOR-IDX', `${s.index}: ${(e as Error).message}`)
    }
  }
  out.sort((a, b) => b.rotationScore - a.rotationScore)
  log.ok('SECTOR-IDX', `${out.length}/${SECTORS.length} scored · top: ${out[0]?.label} (${out[0]?.rotationScore})`)
  return out
}
