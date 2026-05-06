import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ExportButtons } from '../components/ExportButtons'

/**
 * ICT Turtle Soup tab.
 *
 * Pure liquidity-sweep + reclaim signals on NIFTY 50 and XAUUSD (GOLD)
 * across 11 timeframes (5m → 1mo). Source of truth: server cron writes the
 * latest run; this page polls /api/turtle-soup every 60s.
 *
 * No other indicators are mixed in — this strategy lives on its own per the
 * user's directive: only swing pivots, range identification, sweep + reclaim
 * + HTF order-flow filter. See .claude/STRATEGIES_TURTLE_SOUP.md for spec.
 */

type Direction = 'BUY' | 'SELL'
type HtfFlow = 'BULLISH' | 'BEARISH' | 'RANGING'

interface TurtleSoupRow {
  symbol: 'NIFTY' | 'GOLD'
  timeframe: string
  detectedAt: string
  ltp: number
  direction: Direction
  rangeHigh: number
  rangeLow: number
  rangeMidpoint: number
  rangeSize: number
  sweptLevel: number
  sweepWickPrice: number
  sweepCloseBack: number
  sweepBarTime: string
  htfOrderFlow: HtfFlow
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  riskReward: number
  confidence: number
  reasons: string[]
  sigKey: string
}

interface TurtleSoupRun {
  generatedAt: string
  scanned: number
  qualified: number
  signals: TurtleSoupRow[]
  summary: string
}

const TF_ORDER = ['5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '1d', '1w', '1mo']

export function TurtleSoupPage() {
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [filterSym, setFilterSym] = useState<'ALL' | 'NIFTY' | 'GOLD'>('ALL')
  const [filterDir, setFilterDir] = useState<'ALL' | 'BUY' | 'SELL'>('ALL')

  const run = useQuery({
    queryKey: ['turtle-soup'],
    queryFn: async () => {
      const r = await fetch('/api/turtle-soup')
      if (r.status === 404) return null
      if (!r.ok) throw new Error(String(r.status))
      return r.json() as Promise<TurtleSoupRun>
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const runNow = async () => {
    setRunning(true)
    try {
      const r = await fetch('/api/turtle-soup/run', { method: 'POST' })
      if (r.ok) qc.setQueryData(['turtle-soup'], await r.json())
    } finally { setRunning(false) }
  }

  const data = run.data
  const allRows = data?.signals ?? []
  const filtered = allRows.filter(s =>
    (filterSym === 'ALL' || s.symbol === filterSym) &&
    (filterDir === 'ALL' || s.direction === filterDir),
  )
  const niftyRows = filtered.filter(s => s.symbol === 'NIFTY')
  const goldRows = filtered.filter(s => s.symbol === 'GOLD')

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">🐢</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
            ICT Turtle Soup — Liquidity Sweep & Reclaim
            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-accent-green/15 text-accent-green border border-accent-green/30">PURE ICT</span>
          </div>
          <div className="text-xs text-neutral-500 mt-1">
            Pattern hunts <b>fake breakouts</b> at established swing highs/lows. After price raids the
            external liquidity (stops above the high or below the low) and reclaims back into range,
            we enter the reversal in the direction of the higher-timeframe order flow.
            Scans <b>NIFTY 50</b> and <b>XAUUSD (GOLD)</b> across <b>11 timeframes</b>
            (5m / 15m / 30m / 45m / 1h / 2h / 3h / 4h / 1d / 1w / 1mo).
            Refresh every 15 min during market hours; fresh signals push to Telegram automatically.
            <span className="text-neutral-400"> No other indicators are mixed in — pure ICT only.</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button onClick={runNow} disabled={running}
            className="text-xs px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50 whitespace-nowrap">
            {running ? 'Scanning…' : 'Refresh now'}
          </button>
          <ExportButtons dataset="turtle-soup" slug="turtle-soup" />
        </div>
      </div>

      {/* Status strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-neutral-500">
        <div className="flex flex-wrap items-center gap-3">
          {data && <>
            <span>Last scan: <b className="text-neutral-300">{new Date(data.generatedAt).toLocaleString('en-IN')}</b></span>
            <span>·</span>
            <span>Scanned <b className="text-neutral-300">{data.scanned}</b> (symbol × TF)</span>
            <span>·</span>
            <span>Found <b className="text-accent-green">{data.qualified}</b> signals</span>
          </>}
        </div>
        <div className="flex items-center gap-2">
          <FilterPill label="ALL" active={filterSym === 'ALL'} onClick={() => setFilterSym('ALL')} />
          <FilterPill label="NIFTY" active={filterSym === 'NIFTY'} onClick={() => setFilterSym('NIFTY')} />
          <FilterPill label="GOLD" active={filterSym === 'GOLD'} onClick={() => setFilterSym('GOLD')} />
          <span className="mx-2 text-ink-400">|</span>
          <FilterPill label="ALL" active={filterDir === 'ALL'} onClick={() => setFilterDir('ALL')} />
          <FilterPill label="BUY" active={filterDir === 'BUY'} onClick={() => setFilterDir('BUY')} accent="green" />
          <FilterPill label="SELL" active={filterDir === 'SELL'} onClick={() => setFilterDir('SELL')} accent="red" />
        </div>
      </div>

      {/* Summary banner */}
      {data && (
        <div className="rounded border border-ink-500 bg-ink-800 px-3 py-2 text-xs text-neutral-300">
          {data.summary}
        </div>
      )}

      {/* Empty state */}
      {data && data.qualified === 0 && (
        <div className="rounded border border-ink-500 bg-ink-800 p-6 text-center text-sm text-neutral-400">
          🐢 No qualifying turtle-soup setups across {data.scanned} (symbol × TF) pairs right now.
          <br /><span className="text-neutral-500 text-xs">Pattern fires only on confirmed sweep + reclaim. Sit out — the next setup is coming.</span>
        </div>
      )}

      {/* Two-column grid: NIFTY | GOLD */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SymbolColumn title="NIFTY 50" rows={niftyRows} />
        <SymbolColumn title="XAUUSD (GOLD)" rows={goldRows} />
      </div>

      {/* Footnote / how-to */}
      <div className="rounded border border-ink-500 bg-ink-800 p-3 text-[11px] text-neutral-500 space-y-1">
        <div><b className="text-neutral-300">How to read:</b> the top of each card shows the swept level + sweep wick. Entry is the
          confirm-bar close (after price closes back through the swept level). SL sits 5% of range size beyond the wick. T1 = mid-range
          (book 50%), T2 = opposite range extreme (book 30%), T3 = 1× range extension (trail).</div>
        <div><b className="text-neutral-300">HTF filter:</b> BUY setups need HTF order flow ∈ &#123;BULLISH, RANGING&#125;.
          SELL setups need &#123;BEARISH, RANGING&#125;. Counter-HTF setups are filtered out automatically.</div>
        <div><b className="text-neutral-300">Telegram:</b> fresh signals (not seen earlier today) push to the bot immediately. Dedup resets at midnight IST.</div>
      </div>
    </div>
  )
}

// ─── Pieces ───────────────────────────────────────────────────

function FilterPill({ label, active, onClick, accent }: { label: string; active: boolean; onClick: () => void; accent?: 'green' | 'red' }) {
  const accentCls = accent === 'green' ? 'text-accent-green border-accent-green/40 bg-accent-green/10'
    : accent === 'red' ? 'text-accent-red border-accent-red/40 bg-accent-red/10'
    : 'text-neutral-300 border-ink-400 bg-ink-700'
  return (
    <button onClick={onClick}
      className={clsx('px-2 py-0.5 rounded text-[10px] font-semibold border transition',
        active ? accentCls : 'text-neutral-500 border-ink-500 hover:text-neutral-300 hover:border-ink-400')}>
      {label}
    </button>
  )
}

function SymbolColumn({ title, rows }: { title: string; rows: TurtleSoupRow[] }) {
  // Group by timeframe, ordered by TF_ORDER
  const byTf: Record<string, TurtleSoupRow[]> = {}
  for (const r of rows) (byTf[r.timeframe] ||= []).push(r)
  const ordered = TF_ORDER.filter(tf => byTf[tf]?.length).map(tf => ({ tf, rows: byTf[tf] }))

  return (
    <section>
      <div className="text-sm font-semibold text-neutral-200 mb-2 flex items-center gap-2">
        {title}
        <span className="text-[10px] text-neutral-500">({rows.length} signal{rows.length !== 1 ? 's' : ''})</span>
      </div>
      {!rows.length && (
        <div className="rounded border border-dashed border-ink-500 bg-ink-800/50 p-4 text-xs text-neutral-500 text-center">
          No turtle-soup setup on any timeframe right now.
        </div>
      )}
      <div className="space-y-2">
        {ordered.map(({ tf, rows }) =>
          rows.map(r => <SignalCard key={r.sigKey} row={r} tfLabel={tf} />),
        )}
      </div>
    </section>
  )
}

function SignalCard({ row, tfLabel }: { row: TurtleSoupRow; tfLabel: string }) {
  const isBuy = row.direction === 'BUY'
  const arrow = isBuy ? '🟢 BUY' : '🔴 SELL'
  const accent = isBuy ? 'border-accent-green/30 bg-accent-green/5' : 'border-accent-red/30 bg-accent-red/5'
  const htfBadge = row.htfOrderFlow === 'BULLISH' ? 'bg-accent-green/15 text-accent-green border-accent-green/30'
    : row.htfOrderFlow === 'BEARISH' ? 'bg-accent-red/15 text-accent-red border-accent-red/30'
    : 'bg-ink-700 text-neutral-400 border-ink-400'
  return (
    <div className={clsx('rounded-lg border p-3 space-y-1.5', accent)}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-semibold text-neutral-100 flex items-center gap-2 flex-wrap">
          <span className="px-1.5 py-0.5 rounded bg-ink-700 text-neutral-200 text-[10px] font-bold border border-ink-500">{tfLabel}</span>
          <span>{arrow}</span>
          <span className="text-neutral-500">·</span>
          <span>LTP <span className="text-neutral-300">₹{row.ltp.toLocaleString('en-IN')}</span></span>
          <span className={clsx('px-1.5 py-0.5 rounded text-[9px] font-bold border', htfBadge)}>HTF: {row.htfOrderFlow}</span>
          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-ink-700 text-neutral-300 border border-ink-500">conf {row.confidence}%</span>
        </div>
        <div className="text-[10px] text-neutral-500 whitespace-nowrap">
          {new Date(row.detectedAt).toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5 text-[11px] text-neutral-300">
        <div>
          <span className="text-neutral-500">Range:</span>{' '}
          <span className="text-neutral-200">{row.rangeLow} – {row.rangeHigh}</span>
        </div>
        <div>
          <span className="text-neutral-500">Mid:</span>{' '}
          <span className="text-neutral-200">{row.rangeMidpoint}</span>
        </div>
        <div>
          <span className="text-neutral-500">Sweep {isBuy ? 'low' : 'high'}:</span>{' '}
          <span className={isBuy ? 'text-accent-red' : 'text-accent-green'}>{row.sweepWickPrice}</span>
        </div>
        <div>
          <span className="text-neutral-500">Reclaim close:</span>{' '}
          <span className="text-neutral-200">{row.sweepCloseBack}</span>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-1.5 text-[11px] mt-1">
        <Cell label="Entry" value={row.entry} accent="cyan" />
        <Cell label="SL" value={row.stopLoss} accent="red" />
        <Cell label="T1" value={row.target1} accent="green" />
        <Cell label="T2" value={row.target2} accent="green" />
        <Cell label="T3" value={row.target3} accent="green" />
      </div>

      <div className="text-[10px] text-neutral-500 flex items-center justify-between">
        <span>R:R 1:{row.riskReward}</span>
        <span className="italic truncate">{row.reasons[1] ?? row.reasons[0]}</span>
      </div>
    </div>
  )
}

function Cell({ label, value, accent }: { label: string; value: number; accent: 'cyan' | 'red' | 'green' }) {
  const cls = accent === 'cyan' ? 'text-accent-cyan' : accent === 'red' ? 'text-accent-red' : 'text-accent-green'
  return (
    <div className="rounded bg-ink-800 border border-ink-500 px-1.5 py-1 text-center">
      <div className="text-[9px] uppercase text-neutral-500">{label}</div>
      <div className={clsx('text-[11px] font-semibold tabular-nums', cls)}>{value}</div>
    </div>
  )
}

export default TurtleSoupPage
