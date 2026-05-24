import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'

/**
 * Backtest Results / Signal Audit page.
 *
 * Shows every signal the engine has ever emitted with its outcome joined in —
 * T1/T2/SL hits, expirations, and (new) INVALIDATED rows where a flipped
 * view cancelled a prior call. Built after the user said he needs a way to
 * "track accuracy on a daily / weekly basis" and see "reasons for failed
 * signals so it can help in improvising".
 *
 * Three panes:
 *   1. Stats header — win-rate, avg P&L, invalidation count
 *   2. Per-strategy bar chart — where does the edge come from?
 *   3. Full table — filterable, sortable, CSV-exportable
 *
 * Raw CSVs still downloadable via /api/log/*.csv (server-side).
 */

interface AuditRow {
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
  outcome?: string
  outcome_pnl_pct?: number
  outcome_at?: string
  hold_days?: number
}

interface PerfStats {
  totalSignals: number
  closedSignals: number
  pending: number
  wins: number
  losses: number
  expired: number
  winRatePct: number
  avgWinPct: number
  avgLossPct: number
  byStrategy: Record<string, { trades: number; wins: number; losses: number; winRatePct: number }>
}

type OutcomeFilter = 'ALL' | 'OPEN' | 'T1_HIT' | 'T2_HIT' | 'SL_HIT' | 'EXPIRED' | 'INVALIDATED' | 'PENDING'

export function BacktestResultsPage() {
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>('ALL')
  const [symbolQuery, setSymbolQuery] = useState('')
  const [strategyFilter, setStrategyFilter] = useState<string>('ALL')
  const [gradeFilter, setGradeFilter] = useState<string>('ALL')

  const audit = useQuery({
    queryKey: ['audit-signals'],
    queryFn: async () => {
      const r = await fetch('/api/log/signals?limit=1000')
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<{ rows: AuditRow[]; count: number; asOf: string }>
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const stats = useQuery({
    queryKey: ['audit-stats'],
    queryFn: async () => {
      const r = await fetch('/api/log/stats')
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<PerfStats>
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const rows = audit.data?.rows ?? []
  const strategies = useMemo(() => [...new Set(rows.map(r => r.source))].sort(), [rows])
  const grades = useMemo(() => [...new Set(rows.map(r => r.grade))].sort(), [rows])

  const filtered = useMemo(() => rows.filter(r => {
    if (outcomeFilter === 'PENDING' && r.outcome) return false
    if (outcomeFilter !== 'ALL' && outcomeFilter !== 'PENDING' && r.outcome !== outcomeFilter) return false
    if (symbolQuery && !r.symbol.toLowerCase().includes(symbolQuery.toLowerCase())
        && !r.instrument.toLowerCase().includes(symbolQuery.toLowerCase())) return false
    if (strategyFilter !== 'ALL' && r.source !== strategyFilter) return false
    if (gradeFilter !== 'ALL' && r.grade !== gradeFilter) return false
    return true
  }), [rows, outcomeFilter, symbolQuery, strategyFilter, gradeFilter])

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: rows.length, PENDING: 0 }
    for (const r of rows) {
      if (!r.outcome) c.PENDING++
      else c[r.outcome] = (c[r.outcome] ?? 0) + 1
    }
    return c
  }, [rows])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">📒</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-neutral-200">Backtest Results — Signal Audit & Accuracy</div>
          <div className="text-xs text-neutral-500 mt-1">
            Every signal the engine has emitted, with its final outcome (T1/T2/SL/EXPIRED or INVALIDATED if the view
            was flipped and cancelled). Track accuracy, identify failed-signal patterns, and export to CSV/Excel for
            your own backtesting workflow.
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <a href="/api/log/signals.csv"
            className="text-xs px-3 py-1.5 rounded bg-accent-green/10 text-accent-green hover:bg-accent-green/20">
            📥 signals.csv
          </a>
          <a href="/api/log/outcomes.csv"
            className="text-xs px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20">
            📥 outcomes.csv
          </a>
          <a href="/api/log/trades-pnl.csv"
            className="text-xs px-3 py-1.5 rounded bg-accent-violet/10 text-accent-violet hover:bg-accent-violet/20">
            📥 pnl.csv
          </a>
          <button onClick={() => exportFilteredCsv(filtered)}
            className="text-xs px-3 py-1.5 rounded bg-ink-500 text-neutral-300 hover:text-neutral-100">
            📤 Export filtered
          </button>
        </div>
      </div>

      {/* Stats header */}
      {stats.data && <StatsGrid s={stats.data} invalidated={counts.INVALIDATED ?? 0} />}

      {/* Per-strategy win-rate chart */}
      {stats.data && <StrategyChart byStrategy={stats.data.byStrategy} />}

      {/* Filters */}
      <div className="bg-ink-800 border border-ink-500 rounded-lg p-3 flex flex-wrap gap-3 items-end">
        <div>
          <div className="text-[10px] text-neutral-500 uppercase mb-1">Symbol</div>
          <input
            value={symbolQuery}
            onChange={e => setSymbolQuery(e.target.value)}
            placeholder="e.g. NIFTY, EPACK, GOLD"
            className="bg-ink-700 border border-ink-500 rounded px-2 py-1 text-xs font-mono w-40 focus:outline-none focus:border-accent-cyan text-neutral-200"
          />
        </div>
        <div>
          <div className="text-[10px] text-neutral-500 uppercase mb-1">Strategy</div>
          <select value={strategyFilter} onChange={e => setStrategyFilter(e.target.value)}
            className="bg-ink-700 border border-ink-500 rounded px-2 py-1 text-xs">
            <option value="ALL">All</option>
            {strategies.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <div className="text-[10px] text-neutral-500 uppercase mb-1">Grade</div>
          <select value={gradeFilter} onChange={e => setGradeFilter(e.target.value)}
            className="bg-ink-700 border border-ink-500 rounded px-2 py-1 text-xs">
            <option value="ALL">All</option>
            {grades.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div className="flex-1 flex flex-wrap gap-1 justify-end">
          {(['ALL', 'PENDING', 'T1_HIT', 'T2_HIT', 'SL_HIT', 'EXPIRED', 'INVALIDATED'] as OutcomeFilter[]).map(f => (
            <button key={f} onClick={() => setOutcomeFilter(f)}
              className={clsx('text-[11px] px-2 py-1 rounded border',
                outcomeFilter === f
                  ? 'bg-accent-cyan/20 text-accent-cyan border-accent-cyan/40'
                  : 'bg-ink-700 text-neutral-400 border-ink-500 hover:text-neutral-200')}>
              {f.replace('_', ' ')}
              <span className="ml-1 text-[9px] opacity-70">{counts[f] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Per-instrument lineage — only when symbolQuery narrows to one name */}
      {symbolQuery && filtered.length > 0 && filtered.length <= 80 && (
        <Lineage rows={filtered} symbol={symbolQuery} />
      )}

      {/* Table */}
      <section>
        <div className="text-xs text-neutral-500 mb-2">
          Showing <b className="text-neutral-200">{filtered.length}</b> of {rows.length} signals
          {audit.data?.asOf && <> · refreshed {new Date(audit.data.asOf).toLocaleTimeString('en-IN')}</>}
        </div>
        <div className="overflow-auto rounded-lg border border-ink-500" style={{ maxHeight: '75vh' }}>
          <table className="w-full text-[11px] bg-ink-800">
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th className="text-left px-3 py-2">Emitted</th>
                <th className="text-left px-3 py-2">Instrument</th>
                <th className="text-center px-3 py-2">Dir</th>
                <th className="text-center px-3 py-2">Grade</th>
                <th className="text-right px-3 py-2">Score</th>
                <th className="text-right px-3 py-2">Entry</th>
                <th className="text-right px-3 py-2 text-accent-red">SL</th>
                <th className="text-right px-3 py-2 text-accent-green">T1</th>
                <th className="text-right px-3 py-2 text-accent-green">T2</th>
                <th className="text-right px-3 py-2">RR</th>
                <th className="text-left px-3 py-2">Source</th>
                <th className="text-center px-3 py-2">Outcome</th>
                <th className="text-right px-3 py-2">P&amp;L%</th>
                <th className="text-right px-3 py-2">Hold</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 500).map(r => <Row key={r.signal_id} r={r} />)}
              {filtered.length === 0 && (
                <tr><td colSpan={14} className="py-10 text-center text-neutral-500 text-xs">No rows match the current filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > 500 && (
          <div className="mt-2 text-[11px] text-neutral-500">Showing first 500 of {filtered.length} — narrow filters or use CSV export for the full set.</div>
        )}
      </section>
    </div>
  )
}

/**
 * Lineage — chronological view of every signal on a single instrument
 * with flips highlighted. Built after the user complained about EPACK
 * being BUY then SELL on consecutive days; this view shows the FULL chain
 * so you can audit "did the engine flip on me" at a glance.
 */
function Lineage({ rows, symbol }: { rows: AuditRow[]; symbol: string }) {
  const sorted = [...rows].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  let prevDir: string | null = null
  let flips = 0
  const annotated = sorted.map(r => {
    const flipped = prevDir != null && prevDir !== r.direction
    if (flipped) flips++
    prevDir = r.direction
    return { ...r, flipped }
  })
  // Net P&L from closed rows
  const closed = annotated.filter(r => r.outcome && r.outcome !== 'PENDING' && r.outcome !== 'INVALIDATED')
  const netPnl = closed.reduce((s, r) => s + (r.outcome_pnl_pct ?? 0), 0)
  const wins = closed.filter(r => r.outcome === 'T1_HIT' || r.outcome === 'T2_HIT').length

  return (
    <section className="bg-ink-800 border border-accent-cyan/30 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-semibold text-accent-cyan">📜 Signal lineage — {symbol.toUpperCase()}</div>
          <div className="text-[11px] text-neutral-500 mt-0.5">
            {annotated.length} signals · {flips} direction flip{flips !== 1 ? 's' : ''} · {wins}/{closed.length} winners · net {netPnl >= 0 ? '+' : ''}{netPnl.toFixed(1)}%
          </div>
        </div>
      </div>
      <div className="space-y-1.5 max-h-80 overflow-y-auto">
        {annotated.map(r => {
          const dirColor = r.direction === 'BUY' ? 'text-accent-green' : 'text-accent-red'
          const outcome = r.outcome ?? 'PENDING'
          return (
            <div key={r.signal_id} className={clsx(
              'flex items-center gap-3 text-[11px] font-mono px-2 py-1.5 rounded border-l-2',
              r.flipped ? 'border-accent-amber bg-accent-amber/5' : 'border-ink-500',
              outcome === 'INVALIDATED' && 'opacity-50 line-through',
            )}>
              <span className="text-neutral-500 w-32 shrink-0">{shortTs(r.timestamp)}</span>
              <span className={clsx('font-bold w-12', dirColor)}>{r.direction}</span>
              <span className="text-neutral-400 w-16">@ {r.entry}</span>
              <span className="text-neutral-500 w-16 text-[10px]">SL {r.stop_loss}</span>
              <span className="text-accent-green w-20 text-[10px]">T1 {r.target1}</span>
              <span className="text-neutral-500 truncate flex-1">{r.source} · {r.grade}/{r.score}</span>
              <span className={clsx('font-semibold text-[10px] w-20 text-right', outcomeColor(outcome))}>{outcome.replace('_', ' ')}</span>
              <span className={clsx('text-[10px] w-16 text-right',
                (r.outcome_pnl_pct ?? 0) > 0 ? 'text-accent-green'
                : (r.outcome_pnl_pct ?? 0) < 0 ? 'text-accent-red' : 'text-neutral-500')}>
                {r.outcome_pnl_pct != null ? `${r.outcome_pnl_pct >= 0 ? '+' : ''}${r.outcome_pnl_pct.toFixed(1)}%` : '—'}
              </span>
              {r.flipped && <span className="text-[9px] text-accent-amber font-bold">⚠ FLIP</span>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Row({ r }: { r: AuditRow }) {
  const dirColor = r.direction === 'BUY' ? 'text-accent-green' : 'text-accent-red'
  const outcome = r.outcome ?? 'PENDING'
  const invalidated = outcome === 'INVALIDATED'
  return (
    <tr className={clsx(
      'border-t border-ink-500 hover:bg-ink-700 font-mono',
      invalidated && 'opacity-50 line-through',
    )}>
      <td className="px-3 py-2 text-neutral-400 whitespace-nowrap">{shortTs(r.timestamp)}</td>
      <td className="px-3 py-2">
        <div className="text-neutral-200">{r.instrument}</div>
        <div className="text-[9px] text-neutral-600">{r.type}</div>
      </td>
      <td className={clsx('px-3 py-2 text-center font-bold', dirColor)}>{r.direction}</td>
      <td className="px-3 py-2 text-center">{r.grade}</td>
      <td className="px-3 py-2 text-right">{r.score.toFixed(1)}</td>
      <td className="px-3 py-2 text-right">{r.entry}</td>
      <td className="px-3 py-2 text-right text-accent-red">{r.stop_loss}</td>
      <td className="px-3 py-2 text-right text-accent-green">{r.target1}</td>
      <td className="px-3 py-2 text-right text-accent-green">{r.target2}</td>
      <td className="px-3 py-2 text-right">{r.risk_reward}</td>
      <td className="px-3 py-2 text-neutral-500 text-[10px]">{r.source}</td>
      <td className={clsx('px-3 py-2 text-center text-[10px] font-semibold', outcomeColor(outcome))}>{outcome.replace('_', ' ')}</td>
      <td className={clsx('px-3 py-2 text-right',
        (r.outcome_pnl_pct ?? 0) > 0 ? 'text-accent-green'
        : (r.outcome_pnl_pct ?? 0) < 0 ? 'text-accent-red'
        : 'text-neutral-500')}>
        {r.outcome_pnl_pct != null ? `${r.outcome_pnl_pct >= 0 ? '+' : ''}${r.outcome_pnl_pct.toFixed(2)}%` : '—'}
      </td>
      <td className="px-3 py-2 text-right text-neutral-500">{r.hold_days != null ? `${r.hold_days}d` : '—'}</td>
    </tr>
  )
}

function StatsGrid({ s, invalidated }: { s: PerfStats; invalidated: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
      <Stat label="Total signals"   value={s.totalSignals} accent="text-neutral-200" />
      <Stat label="Closed"          value={s.closedSignals} accent="text-neutral-200" />
      <Stat label="Pending"         value={s.pending} accent="text-accent-cyan" />
      <Stat label="Win rate"        value={`${s.winRatePct}%`} accent={s.winRatePct >= 50 ? 'text-accent-green' : 'text-accent-amber'} />
      <Stat label="Avg win / loss"  value={`${s.avgWinPct >= 0 ? '+' : ''}${s.avgWinPct}% / ${s.avgLossPct}%`} accent="text-neutral-200" />
      <Stat label="Invalidated"     value={invalidated} accent={invalidated > 0 ? 'text-accent-amber' : 'text-neutral-500'} />
    </div>
  )
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent: string }) {
  return (
    <div className="bg-ink-800 border border-ink-500 rounded p-3">
      <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">{label}</div>
      <div className={clsx('text-lg font-bold font-mono', accent)}>{value}</div>
    </div>
  )
}

function StrategyChart({ byStrategy }: { byStrategy: PerfStats['byStrategy'] }) {
  const entries = Object.entries(byStrategy).sort((a, b) => b[1].trades - a[1].trades)
  if (!entries.length) return null
  const maxTrades = Math.max(...entries.map(([, v]) => v.trades), 1)
  return (
    <div className="bg-ink-800 border border-ink-500 rounded-lg p-4">
      <div className="text-xs font-semibold text-neutral-300 mb-3">📊 Per-strategy accuracy</div>
      <div className="space-y-1.5">
        {entries.map(([name, s]) => (
          <div key={name} className="flex items-center gap-3 text-[11px]">
            <div className="w-32 text-neutral-400 font-mono truncate">{name}</div>
            <div className="flex-1 h-5 bg-ink-700 rounded relative overflow-hidden">
              <div
                className={clsx('absolute left-0 top-0 bottom-0',
                  s.winRatePct >= 60 ? 'bg-accent-green/40'
                  : s.winRatePct >= 45 ? 'bg-accent-cyan/40'
                  : 'bg-accent-red/40')}
                style={{ width: `${Math.max(2, (s.trades / maxTrades) * 100)}%` }}
              />
              <div className="absolute inset-0 flex items-center px-2 text-[10px] font-mono text-neutral-200">
                {s.trades} trades · {s.wins}W / {s.losses}L · {s.winRatePct}% win
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function shortTs(iso: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso.slice(0, 16)
  const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
  return `${d.getDate()} ${mo} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function outcomeColor(o: string): string {
  switch (o) {
    case 'T1_HIT':
    case 'T2_HIT':     return 'text-accent-green'
    case 'SL_HIT':     return 'text-accent-red'
    case 'EXPIRED':    return 'text-neutral-500'
    case 'INVALIDATED': return 'text-accent-amber'
    default:           return 'text-accent-cyan'
  }
}

function exportFilteredCsv(rows: AuditRow[]): void {
  if (!rows.length) return
  const headers: (keyof AuditRow)[] = [
    'timestamp', 'signal_id', 'symbol', 'instrument', 'type', 'source', 'tier',
    'direction', 'grade', 'score',
    'entry', 'stop_loss', 'target1', 'target2', 'risk_reward',
    'outcome', 'outcome_pnl_pct', 'outcome_at', 'hold_days',
    'reasons',
  ]
  const esc = (v: unknown): string => {
    if (v === undefined || v === null) return ''
    const s = String(v)
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const out = [
    headers.join(','),
    ...rows.map(r => headers.map(h => esc(r[h])).join(',')),
  ].join('\n')
  const blob = new Blob([out], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `signals-audit-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}
