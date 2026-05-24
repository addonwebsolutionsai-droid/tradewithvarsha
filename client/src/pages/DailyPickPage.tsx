import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { starsForScore, byScoreQuality } from '../components/convictionTier'
import { Stars } from '../components/Stars'
import { ExportButtons } from '../components/ExportButtons'

interface DailyPickRow {
  symbol: string
  ltp: number
  direction: 'BUY' | 'SHORT'
  pattern: 'MOMENTUM' | 'REBOUND' | 'BOTH'
  conviction: number
  entryPrice: number
  entryPriceLow?: number
  entryPriceHigh?: number
  entryDate?: string
  entryNote: string
  bestEntryTimeIST?: string
  horaLord?: string
  horaNote?: string
  stopLoss: number
  target1: number; target1Date: string
  target2: number; target2Date: string
  target3?: number; target3Date?: string
  expectedReturnPct: number
  riskReward: number
  momentumScore: number
  reboundScore: number
  reasons: string[]
  shareholdingNote?: string         // 2026-05-25: FII/DII/Promoter/Pledge/MC
  noBrainerBet?: boolean
  meta: {
    rsi: number
    distFrom52WH: number
    volRatio: number
    aboveEma50: boolean
    aboveEma200: boolean
    ret5dPct: number
  }
  detectedAt: string
}

interface DailyPick {
  generatedAt: string
  marketState: string
  regime: string
  totalScanned: number
  rows: DailyPickRow[]
  notes: string[]
  newSinceLastRun: string[]
}

export function DailyPickPage() {
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [filter, setFilter] = useState<'ALL' | 'MOMENTUM' | 'REBOUND' | 'BOTH'>('ALL')

  const pick = useQuery({
    queryKey: ['daily-pick'],
    queryFn: async () => {
      const r = await fetch('/api/daily-pick')
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<DailyPick>
    },
    staleTime: 30_000,
    refetchInterval: 60_000,        // poll every 60 s — caught by cron writes
  })

  const runNow = async () => {
    setRunning(true)
    try {
      const r = await fetch('/api/daily-pick/run', { method: 'POST' })
      if (r.ok) qc.setQueryData(['daily-pick'], await r.json())
    } finally { setRunning(false) }
  }

  const p = pick.data
  const filtered = (p?.rows ?? []).filter(r => filter === 'ALL' || r.pattern === filter)
  const buys = filtered.filter(r => r.direction === 'BUY').slice().sort(byScoreQuality)
  const shorts = filtered.filter(r => r.direction === 'SHORT').slice().sort(byScoreQuality)
  const newSet = new Set(p?.newSinceLastRun ?? [])
  const lastRun = p ? new Date(p.generatedAt) : null

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">🤖</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
            Daily Pick — autonomous 10–20 % movers
            <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-accent-green/15 text-accent-green border border-accent-green/30">AUTO</span>
          </div>
          <div className="text-xs text-neutral-500 mt-1">
            Wide-NSE sweep that runs <b>every 30 min during market hours</b> + once post-close (16:15 IST). Hybrid scorer takes
            the <b>max(MOMENTUM, REBOUND)</b> signal — momentum = classic breakout, rebound = pattern-learner-derived oversold
            recovery (the empirical fingerprint of recent NSE winners). Targets <b>+10 % in ~5 sessions</b>, <b>+20 % in ~12 sessions</b>.
            New picks are pushed to Telegram automatically.
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button onClick={runNow} disabled={running}
            className="text-xs px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50 whitespace-nowrap">
            {running ? 'Scanning…' : 'Refresh now'}
          </button>
          <ExportButtons dataset="daily-pick" slug="daily-pick" />
        </div>
      </div>

      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-neutral-500">
        {lastRun && <span>Last sweep: <b className="text-neutral-300">{lastRun.toLocaleString('en-IN')}</b></span>}
        {p && <>
          <span>·</span>
          <span>Scanned <b className="text-neutral-300">{p.totalScanned}</b> stocks</span>
          <span>·</span>
          <span>Found <b className="text-accent-green">{p.rows.length}</b> candidates</span>
          {p.newSinceLastRun.length > 0 && <>
            <span>·</span>
            <span>🆕 <b className="text-accent-amber">{p.newSinceLastRun.length} new</b> since last run</span>
          </>}
        </>}
      </div>

      {/* Notes */}
      {p && p.notes.length > 0 && (
        <div className="bg-ink-800 border border-ink-500 rounded p-3 space-y-1 text-[11px] text-neutral-400">
          {p.notes.map((n, i) => <div key={i}>• {n}</div>)}
        </div>
      )}

      {/* Pattern filter */}
      <div className="flex gap-1.5 text-[11px]">
        {(['ALL', 'MOMENTUM', 'REBOUND', 'BOTH'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={clsx('px-3 py-1 rounded',
              filter === f ? 'bg-accent-cyan/20 text-accent-cyan' : 'bg-ink-500 text-neutral-500 hover:text-neutral-300')}>
            {f === 'ALL' ? 'All patterns' :
             f === 'MOMENTUM' ? '⚡ Momentum (breakout)' :
             f === 'REBOUND'  ? '🔄 Rebound (oversold)' :
             '🎯 Both signals'}
            {p && (
              <span className="ml-1.5 text-[9px] opacity-70">
                {f === 'ALL' ? p.rows.length : p.rows.filter(r => r.pattern === f).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {!p && !pick.isLoading && (
        <div className="bg-ink-700 border border-ink-500 rounded p-8 text-center text-sm text-neutral-500">
          No daily pick yet — click <b className="text-accent-cyan">Refresh now</b> to trigger the first scan.
        </div>
      )}

      {/* Two-column Buy / Short */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Side label="BUY (Long)" accent="green" rows={buys} newSet={newSet} />
        <Side label="SHORT (Bear)" accent="red" rows={shorts} newSet={newSet} />
      </div>
    </div>
  )
}

function Side({ label, accent, rows, newSet }: {
  label: string
  accent: 'green' | 'red'
  rows: DailyPickRow[]
  newSet: Set<string>
}) {
  const isGreen = accent === 'green'
  return (
    <div>
      <div className={clsx(
        'flex items-center justify-between px-3.5 py-2 rounded-t-lg border border-b-0',
        isGreen ? 'border-accent-green/30 bg-accent-green/5' : 'border-accent-red/30 bg-accent-red/5',
      )}>
        <div className={clsx('font-bold text-sm tracking-wide flex items-center gap-2',
          isGreen ? 'text-accent-green' : 'text-accent-red')}>
          <span>{isGreen ? '▲' : '▼'}</span><span>{label}</span>
        </div>
        <div className={clsx('text-xs font-semibold px-2 py-0.5 rounded border',
          isGreen ? 'text-accent-green bg-accent-green/15 border-accent-green/30'
                  : 'text-accent-red bg-accent-red/15 border-accent-red/30')}>
          {rows.length}
        </div>
      </div>
      <div className={clsx('border rounded-b-lg p-3 min-h-[200px] grid gap-2',
        isGreen ? 'border-accent-green/30' : 'border-accent-red/30')}>
        {rows.length === 0 ? (
          <div className="py-12 text-center text-xs text-neutral-600">No setups in this direction</div>
        ) : (
          rows.map(r => <DailyPickCard key={r.symbol} row={r} isNew={newSet.has(r.symbol)} />)
        )}
      </div>
    </div>
  )
}

function DailyPickCard({ row, isNew }: { row: DailyPickRow; isNew: boolean }) {
  const [open, setOpen] = useState(false)
  const dirColor = row.direction === 'BUY' ? '#00c853' : '#ff1744'
  const convColor = row.conviction >= 80 ? 'text-accent-green' :
                    row.conviction >= 65 ? 'text-accent-cyan' :
                    'text-accent-amber'
  const stars = starsForScore(row.conviction)
  const patternBg =
    row.pattern === 'MOMENTUM' ? 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/30' :
    row.pattern === 'REBOUND'  ? 'bg-accent-violet/15 text-accent-violet border-accent-violet/30' :
                                  'bg-accent-amber/15 text-accent-amber border-accent-amber/30'

  return (
    <div onClick={() => setOpen(o => !o)}
      className="bg-ink-700 border border-ink-500 rounded p-3 hover:border-ink-400 cursor-pointer transition-colors"
      style={{ borderLeft: `3px solid ${dirColor}` }}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold text-neutral-200">{row.noBrainerBet && '⭐ '}{row.symbol}</span>
            <Stars count={stars} />
            <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-semibold border', patternBg)}>
              {row.pattern}
            </span>
            {isNew && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-accent-amber/15 text-accent-amber border border-accent-amber/30">
                🆕 NEW
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs mt-1 font-mono">
            <span className="text-neutral-200">₹{row.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
            <span className="text-neutral-500">RSI {row.meta.rsi.toFixed(0)}</span>
            <span className="text-neutral-500">{row.meta.distFrom52WH.toFixed(0)}% off 52WH</span>
            <span className="text-neutral-500">vol {row.meta.volRatio.toFixed(1)}×</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] mt-1.5 font-mono">
            <span className="text-neutral-500">
              Entry <b className="text-accent-cyan">
                {row.entryPriceLow != null && row.entryPriceHigh != null
                  ? `₹${row.entryPriceLow}–${row.entryPriceHigh}`
                  : `₹${row.entryPrice}`}
              </b>
            </span>
            {row.entryDate && (
              <span className="text-neutral-500">
                on <b className="text-accent-cyan">{shortDate(row.entryDate)}</b>
              </span>
            )}
            {row.bestEntryTimeIST && (
              <span className="text-neutral-500">
                @ <b className="text-accent-cyan">{row.bestEntryTimeIST} IST</b>
                {row.horaLord && <span className="text-neutral-600"> ({row.horaLord})</span>}
              </span>
            )}
            <span className="text-neutral-500">SL <b className="text-accent-red">₹{row.stopLoss}</b></span>
            <span className="text-neutral-500">T1 <b className="text-accent-green">₹{row.target1}</b> ({shortDate(row.target1Date)})</span>
            <span className="text-neutral-500">T2 <b className="text-accent-green">₹{row.target2}</b> ({shortDate(row.target2Date)})</span>
            {row.target3 != null && row.target3Date && (
              <span className="text-neutral-500">T3 <b className="text-accent-green">₹{row.target3}</b> ({shortDate(row.target3Date)})</span>
            )}
          </div>
          {row.shareholdingNote && (
            <div className="mt-1.5 text-[10px] text-neutral-400 leading-relaxed font-mono">
              <span className="text-neutral-600 font-semibold">Stake: </span>{row.shareholdingNote}
            </div>
          )}
        </div>
        <div className="text-right ml-3">
          <div className={clsx('w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold',
            row.conviction >= 80 ? 'border-2 border-accent-green bg-accent-green/15' :
            row.conviction >= 65 ? 'border-2 border-accent-cyan bg-accent-cyan/15' :
                                   'border-2 border-accent-amber bg-accent-amber/15')}>
            <span className={convColor}>{row.conviction}</span>
          </div>
          <div className="text-[9px] text-neutral-600 mt-1">RR {row.riskReward}:1</div>
        </div>
      </div>
      {open && (
        <div className="mt-3 pt-3 border-t border-ink-500 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="bg-ink-800 border border-ink-500 rounded p-2">
              <div className="text-[10px] text-neutral-500 uppercase mb-1">⚡ Momentum score</div>
              <div className="font-mono text-accent-cyan font-semibold">{row.momentumScore}/100</div>
            </div>
            <div className="bg-ink-800 border border-ink-500 rounded p-2">
              <div className="text-[10px] text-neutral-500 uppercase mb-1">🔄 Rebound score</div>
              <div className="font-mono text-accent-violet font-semibold">{row.reboundScore}/100</div>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-neutral-500 uppercase mb-1">Reasons</div>
            {row.reasons.map((r, i) => (
              <div key={i} className="text-[11px] text-neutral-400 pl-2 border-l-2 border-ink-400">{r}</div>
            ))}
          </div>
          <div className="text-[10px] text-neutral-600">
            EMA50 {row.meta.aboveEma50 ? '✓' : '✗'} · EMA200 {row.meta.aboveEma200 ? '✓' : '✗'} ·
            5d ret {row.meta.ret5dPct >= 0 ? '+' : ''}{row.meta.ret5dPct}% · expected {row.expectedReturnPct >= 0 ? '+' : ''}{row.expectedReturnPct}% by {row.target2Date}
          </div>
        </div>
      )}
    </div>
  )
}

function shortDate(iso: string): string {
  if (!iso) return '—'
  const [, m, d] = iso.split('-').map(Number)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${d} ${months[m - 1] ?? '?'}`
}
