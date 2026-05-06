import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { starsForScreener, byScreenerQuality } from './convictionTier'
import { Stars } from './Stars'

export interface ScreenerRow {
  symbol: string
  price: number
  change: number
  changePct: number
  score: number
  tier: 'A' | 'B' | 'C'
  direction: 'BULL' | 'BEAR' | 'NEUTRAL'
  reasons: string[]
  tags: string[]
  expectedMovePct?: number
  timeframeLabel?: string
  suggestedEntry?: number
  suggestedSL?: number
  suggestedTarget?: number
  entryPriceLow?: number
  entryPriceHigh?: number
  entryDate?: string
  entryNote?: string
  bestEntryTimeIST?: string
  horaLord?: string
  horaNote?: string
  target1?: number; target1Date?: string
  target2?: number; target2Date?: string
  target3?: number; target3Date?: string
  detectedAt: number
  setupKind: string
}

interface Props {
  title: string
  subtitle?: string
  endpoint: string   // e.g. "/api/scan/moneyflow"
  refreshLabel?: string
  /** Heading on the left (BULL) column. Defaults to "Inflow (Buy)". */
  bullLabel?: string
  /** Heading on the right (BEAR) column. Defaults to "Outflow (Sell)". */
  bearLabel?: string
}

export function ScreenerGrid({
  title, subtitle, endpoint, refreshLabel = 'Re-run Scan',
  bullLabel = 'Inflow (Buy)', bearLabel = 'Outflow (Sell)',
}: Props) {
  const qc = useQueryClient()
  const [refreshing, setRefreshing] = useState(false)

  const query = useQuery({
    queryKey: ['screener', endpoint],
    queryFn: async () => {
      const res = await fetch(endpoint)
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json() as Promise<{ results: ScreenerRow[]; finishedAt: number; totalScanned: number }>
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  })

  const rows: ScreenerRow[] = query.data?.results ?? []
  const scannedAt = query.data?.finishedAt ?? null
  const loading = query.isLoading || refreshing
  const error = query.error ? (query.error as Error).message : null

  const refresh = async () => {
    setRefreshing(true)
    try {
      const res = await fetch(`${endpoint}/refresh`, { method: 'POST' })
      if (!res.ok) throw new Error(`${res.status}`)
      const fresh = await res.json()
      qc.setQueryData(['screener', endpoint], fresh)
    } catch (e) { /* surfaced via query state */ }
    finally { setRefreshing(false) }
  }

  const bull = rows.filter(r => r.direction === 'BULL').sort(byScreenerQuality)
  const bear = rows.filter(r => r.direction === 'BEAR').sort(byScreenerQuality)
  const neutral = rows.filter(r => r.direction === 'NEUTRAL')

  return (
    <div>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-sm font-semibold text-neutral-200">{title}</div>
          {subtitle && <div className="text-xs text-neutral-500 mt-0.5">{subtitle}</div>}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50"
        >
          {loading ? 'Scanning...' : refreshLabel}
        </button>
      </div>
      {scannedAt && (
        <div className="text-[11px] text-neutral-600 mb-3">
          Last scan: {new Date(scannedAt).toLocaleTimeString('en-IN')} · {rows.length} setups
          {neutral.length > 0 && <> · {neutral.length} neutral hidden</>}
        </div>
      )}
      {error && <div className="text-accent-red text-xs mb-3">{error}</div>}
      {rows.length === 0 && !loading ? (
        <div className="bg-ink-700 border border-ink-500 rounded-lg p-8 text-center text-neutral-600">
          No setups yet. Scans run post-close (16:10 IST) + pre-close (15:20 IST).
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Side label={bullLabel} accent="green" triangle="▲" rows={bull} empty="No bullish setups" />
          <Side label={bearLabel} accent="red"   triangle="▼" rows={bear} empty="No bearish setups" />
        </div>
      )}
    </div>
  )
}

function Side({
  label, accent, triangle, rows, empty,
}: {
  label: string
  accent: 'green' | 'red'
  triangle: string
  rows: ScreenerRow[]
  empty: string
}) {
  if (accent === 'green') {
    return (
      <div>
        <div className="flex items-center justify-between px-3.5 py-2.5 rounded-t-lg border border-b-0 border-accent-green/30 bg-accent-green/5">
          <div className="text-accent-green font-bold text-sm tracking-wide flex items-center gap-2">
            <span>{triangle}</span><span>{label.toUpperCase()}</span>
          </div>
          <div className="text-accent-green text-xs font-semibold bg-accent-green/15 border border-accent-green/30 px-2 py-0.5 rounded">
            {rows.length}
          </div>
        </div>
        <div className="border border-accent-green/30 rounded-b-lg p-3 min-h-[200px] grid gap-2">
          {rows.length === 0
            ? <div className="py-12 text-center text-xs text-neutral-600">{empty}</div>
            : rows.map(r => <ScreenerCard key={r.symbol + r.setupKind} row={r} />)}
        </div>
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-center justify-between px-3.5 py-2.5 rounded-t-lg border border-b-0 border-accent-red/30 bg-accent-red/5">
        <div className="text-accent-red font-bold text-sm tracking-wide flex items-center gap-2">
          <span>{triangle}</span><span>{label.toUpperCase()}</span>
        </div>
        <div className="text-accent-red text-xs font-semibold bg-accent-red/15 border border-accent-red/30 px-2 py-0.5 rounded">
          {rows.length}
        </div>
      </div>
      <div className="border border-accent-red/30 rounded-b-lg p-3 min-h-[200px] grid gap-2">
        {rows.length === 0
          ? <div className="py-12 text-center text-xs text-neutral-600">{empty}</div>
          : rows.map(r => <ScreenerCard key={r.symbol + r.setupKind} row={r} />)}
      </div>
    </div>
  )
}

function ScreenerCard({ row }: { row: ScreenerRow }) {
  const tierColor = row.tier === 'A' ? '#00c853' : row.tier === 'B' ? '#00bcd4' : '#ff9800'
  const dirColor = row.direction === 'BULL' ? '#00c853' : row.direction === 'BEAR' ? '#ff1744' : '#888'
  const stars = starsForScreener(row.tier, row.score)
  return (
    <div className="bg-ink-700 border border-ink-500 rounded-lg p-3 hover:border-ink-400 transition-colors"
      style={{ borderLeft: `3px solid ${tierColor}` }}>
      <div className="flex justify-between items-start">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold text-neutral-200">{row.symbol}</span>
            <Stars count={stars} />
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold"
              style={{ background: `${dirColor}22`, color: dirColor }}>
              {row.direction}
            </span>
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-ink-500 text-neutral-500">{row.setupKind}</span>
            {row.timeframeLabel && (
              <span className="text-[11px] text-neutral-600">{row.timeframeLabel}</span>
            )}
          </div>
          <div className="flex gap-3 text-xs mt-1">
            <span className="text-neutral-200">₹{row.price?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
            <span className={row.change >= 0 ? 'text-accent-green' : 'text-accent-red'}>
              {row.change >= 0 ? '+' : ''}{row.change?.toFixed(2)} ({row.changePct >= 0 ? '+' : ''}{row.changePct?.toFixed(2)}%)
            </span>
            {row.expectedMovePct != null && (
              <span className="text-neutral-500">Target <b className={row.expectedMovePct >= 0 ? 'text-accent-green' : 'text-accent-red'}>
                {row.expectedMovePct >= 0 ? '+' : ''}{row.expectedMovePct.toFixed(1)}%
              </b></span>
            )}
          </div>
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            {row.tags.map((t, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-ink-500 text-neutral-400">{t}</span>
            ))}
          </div>
          {row.suggestedEntry && row.suggestedSL && row.suggestedTarget && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] mt-1.5 text-neutral-500">
              <span>E <b className="text-neutral-300">
                {row.entryPriceLow != null && row.entryPriceHigh != null
                  ? `${row.entryPriceLow}–${row.entryPriceHigh}`
                  : row.suggestedEntry.toFixed(2)}
              </b></span>
              <span>SL <b className="text-accent-red">{row.suggestedSL.toFixed(2)}</b></span>
              <span>T1 <b className="text-accent-green">{(row.target1 ?? row.suggestedTarget).toFixed(2)}</b>
                {row.target1Date && <span className="text-neutral-600"> · {row.target1Date.slice(5)}</span>}
              </span>
              {row.target2 != null && (
                <span>T2 <b className="text-accent-green">{row.target2.toFixed(2)}</b>
                  {row.target2Date && <span className="text-neutral-600"> · {row.target2Date.slice(5)}</span>}
                </span>
              )}
              {row.target3 != null && (
                <span>T3 <b className="text-accent-green">{row.target3.toFixed(2)}</b>
                  {row.target3Date && <span className="text-neutral-600"> · {row.target3Date.slice(5)}</span>}
                </span>
              )}
              {row.bestEntryTimeIST && (
                <span>⏱ <b className="text-accent-cyan">{row.bestEntryTimeIST} IST</b>
                  {row.horaLord && <span className="text-neutral-600"> · {row.horaLord}</span>}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="ml-3 text-right">
          <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold"
            style={{ background: `${tierColor}22`, border: `2px solid ${tierColor}`, color: tierColor }}>
            {row.tier}
          </div>
          <div className="text-[10px] text-neutral-600 mt-1">{row.score.toFixed(1)}/10</div>
        </div>
      </div>
      <details className="mt-2">
        <summary className="text-[11px] text-neutral-600 cursor-pointer">Why</summary>
        <div className="mt-1.5 text-xs text-neutral-400 space-y-0.5">
          {row.reasons.map((r, i) => <div key={i}>• {r}</div>)}
        </div>
      </details>
    </div>
  )
}
