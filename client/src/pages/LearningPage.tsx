import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'

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

interface PreMoveFeatures {
  volRatio20: number
  volRatio60: number
  rsi: number
  distFrom52wHighPct: number
  above50EMA: boolean
  above200EMA: boolean
  emaStackBull: boolean
  ret5dPct: number
  ret20dPct: number
  range5dPct: number
}
interface LearnedSignature {
  symbol: string
  gainPct: number
  lookbackDays: number
  capturedAt: string
  detectedAt: string
  features: PreMoveFeatures
}
interface LearnedPatterns {
  lastRunAt: string
  totalSignatures: number
  centroids: {
    volRatio20: number
    rsi: number
    distFrom52wHighPct: number
    above50EMA: number
    above200EMA: number
    ret20dPct: number
  }
  signatures: LearnedSignature[]
}

interface AutoTune {
  lastRunAt: string
  overrides: Record<string, { minConfluence?: number; minAdx?: number }>
  adjustments: { ts: string; strategy: string; metric: string; from: number; to: number; reason: string }[]
  lastPerf: PerfStats | null
}

export function LearningPage() {
  const qc = useQueryClient()
  const [running, setRunning] = useState<'patterns' | 'autotune' | null>(null)

  const stats = useQuery({
    queryKey: ['perf-stats'],
    queryFn: async () => {
      const r = await fetch('/api/log/stats')
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<PerfStats>
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  const patterns = useQuery({
    queryKey: ['learned-patterns'],
    queryFn: async () => {
      const r = await fetch('/api/learning/patterns')
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<LearnedPatterns>
    },
    staleTime: 5 * 60_000,
  })

  const autotune = useQuery({
    queryKey: ['autotune'],
    queryFn: async () => {
      const r = await fetch('/api/learning/autotune')
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<AutoTune>
    },
    staleTime: 5 * 60_000,
  })

  const runPatterns = async () => {
    setRunning('patterns')
    try {
      const r = await fetch('/api/learning/patterns/run', { method: 'POST' })
      if (r.ok) qc.setQueryData(['learned-patterns'], await r.json())
    } finally { setRunning(null) }
  }
  const runAutotune = async () => {
    setRunning('autotune')
    try {
      const r = await fetch('/api/learning/autotune/run', { method: 'POST' })
      if (r.ok) qc.setQueryData(['autotune'], await r.json())
      qc.invalidateQueries({ queryKey: ['perf-stats'] })
    } finally { setRunning(null) }
  }

  const s = stats.data
  const p = patterns.data
  const a = autotune.data
  const target = 80

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">🧪</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-neutral-200">Learning &amp; Self-Improvement</div>
          <div className="text-xs text-neutral-500 mt-1">
            Every LIVE signal is logged to <code>signals.csv</code>; every T1/T2/SL/EXPIRED outcome is logged to{' '}
            <code>outcomes.csv</code>. The pattern learner mines today's 5-day winners (≥10%) and captures their
            pre-move snapshot 5/10/15 days BEFORE the move started — that becomes a "winner fingerprint" the engine
            uses to score future candidates. The self-improve loop tightens entry filters whenever live win-rate
            falls below 80% on ≥10 closed trades. Both run daily at 16:30 IST.
          </div>
        </div>
      </div>

      {/* Live Accuracy */}
      <section>
        <SectionTitle>📊 Live Accuracy (from CSV audit trail)</SectionTitle>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Stat label="Total signals logged" value={s?.totalSignals ?? 0} />
          <Stat label="Closed (T1/T2/SL/EXP)" value={s?.closedSignals ?? 0} />
          <Stat label="Pending" value={s?.pending ?? 0} />
          <Stat
            label="Live win rate"
            value={`${s?.winRatePct ?? 0}%`}
            color={s == null ? undefined : s.winRatePct >= target ? 'green' : s.winRatePct >= 60 ? 'amber' : 'red'}
            sub={`Target ${target}% · ${s?.wins ?? 0}W / ${s?.losses ?? 0}L / ${s?.expired ?? 0} exp`}
          />
        </div>
        <div className="mt-2 grid grid-cols-2 lg:grid-cols-3 gap-3">
          <Stat label="Avg win" value={`${s?.avgWinPct ?? 0}%`} color="green" />
          <Stat label="Avg loss" value={`${s?.avgLossPct ?? 0}%`} color="red" />
          <Stat
            label="Expectancy / trade"
            value={s ? `${expectancyOf(s).toFixed(2)}%` : '—'}
            color={s && expectancyOf(s) > 0 ? 'green' : 'red'}
            sub="(WR × AvgWin) − (1−WR) × |AvgLoss|"
          />
        </div>

        {/* Per-strategy breakdown */}
        {s && Object.keys(s.byStrategy).length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-xs border border-ink-500 rounded-lg overflow-hidden">
              <thead className="bg-ink-800 text-neutral-400">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Strategy</th>
                  <th className="text-right px-3 py-2 font-semibold">Trades</th>
                  <th className="text-right px-3 py-2 font-semibold text-accent-green">Wins</th>
                  <th className="text-right px-3 py-2 font-semibold text-accent-red">Losses</th>
                  <th className="text-right px-3 py-2 font-semibold">Win rate</th>
                  <th className="text-right px-3 py-2 font-semibold">vs target</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(s.byStrategy).map(([name, st]) => {
                  const delta = st.winRatePct - target
                  return (
                    <tr key={name} className="border-t border-ink-500">
                      <td className="px-3 py-2 font-mono">{name}</td>
                      <td className="px-3 py-2 text-right">{st.trades}</td>
                      <td className="px-3 py-2 text-right text-accent-green">{st.wins}</td>
                      <td className="px-3 py-2 text-right text-accent-red">{st.losses}</td>
                      <td className={clsx('px-3 py-2 text-right font-mono', st.winRatePct >= target ? 'text-accent-green' : 'text-accent-red')}>
                        {st.winRatePct}%
                      </td>
                      <td className={clsx('px-3 py-2 text-right text-[11px]', delta >= 0 ? 'text-accent-green' : 'text-accent-red')}>
                        {delta >= 0 ? '+' : ''}{delta.toFixed(1)} pts
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 flex gap-2 text-xs">
          <a href="/api/log/signals.csv" download
            className="px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20">
            ⬇ Download signals.csv
          </a>
          <a href="/api/log/outcomes.csv" download
            className="px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20">
            ⬇ Download outcomes.csv
          </a>
        </div>
      </section>

      {/* Pattern Learner */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <SectionTitle>🧠 Pattern Learner — pre-move winner fingerprints</SectionTitle>
          <button onClick={runPatterns} disabled={running === 'patterns'}
            className="text-xs px-3 py-1.5 rounded bg-accent-violet/10 text-accent-violet hover:bg-accent-violet/20 disabled:opacity-50">
            {running === 'patterns' ? 'Mining ~600 NSE stocks…' : 'Run pattern learner now'}
          </button>
        </div>
        {p ? (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
              <Stat label="Signatures stored" value={p.totalSignatures} />
              <Stat label="Last mined" value={p.lastRunAt ? new Date(p.lastRunAt).toLocaleString('en-IN') : 'never'} />
              <Stat label="Centroid: vol ratio" value={`${p.centroids.volRatio20.toFixed(1)}× avg`} color="violet"
                sub="Avg today-vs-20d on the day before winners broke out" />
              <Stat label="Centroid: RSI" value={p.centroids.rsi.toFixed(1)} color="violet"
                sub={`${(p.centroids.above50EMA * 100).toFixed(0)}% were above 50-EMA · 20d ret avg ${p.centroids.ret20dPct.toFixed(1)}%`} />
            </div>
            {p.signatures.length === 0 ? (
              <div className="bg-ink-700 border border-ink-500 rounded p-6 text-center text-xs text-neutral-600">
                No signatures captured yet. Click "Run pattern learner now" — takes ~3-5 min over ~600 NSE stocks.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px] border border-ink-500 rounded-lg overflow-hidden">
                  <thead className="bg-ink-800 text-neutral-400">
                    <tr>
                      <th className="text-left px-3 py-2">Symbol</th>
                      <th className="text-right px-3 py-2 text-accent-green">5d gain</th>
                      <th className="text-right px-3 py-2">Captured</th>
                      <th className="text-right px-3 py-2">Days before</th>
                      <th className="text-right px-3 py-2">Vol×</th>
                      <th className="text-right px-3 py-2">RSI</th>
                      <th className="text-right px-3 py-2">% off 52WH</th>
                      <th className="text-center px-3 py-2">EMA50/200</th>
                      <th className="text-right px-3 py-2">20d ret</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.signatures.slice(0, 25).map((sig, i) => (
                      <tr key={i} className="border-t border-ink-500 font-mono">
                        <td className="px-3 py-2">{sig.symbol}</td>
                        <td className="px-3 py-2 text-right text-accent-green">+{sig.gainPct.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-right">{sig.capturedAt}</td>
                        <td className="px-3 py-2 text-right">{sig.lookbackDays}d</td>
                        <td className="px-3 py-2 text-right">{sig.features.volRatio20.toFixed(1)}×</td>
                        <td className="px-3 py-2 text-right">{sig.features.rsi.toFixed(0)}</td>
                        <td className="px-3 py-2 text-right">{sig.features.distFrom52wHighPct.toFixed(1)}%</td>
                        <td className="px-3 py-2 text-center">
                          {sig.features.above50EMA ? '✓' : '✗'}/{sig.features.above200EMA ? '✓' : '✗'}
                        </td>
                        <td className="px-3 py-2 text-right">{sig.features.ret20dPct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {p.signatures.length > 25 && (
                  <div className="text-[10px] text-neutral-600 mt-1">Showing 25 of {p.signatures.length} signatures</div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="bg-ink-700 border border-ink-500 rounded p-6 text-center text-xs text-neutral-600">Loading patterns…</div>
        )}
      </section>

      {/* Auto-tune */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <SectionTitle>⚙️ Self-Improve Auto-Tune</SectionTitle>
          <button onClick={runAutotune} disabled={running === 'autotune'}
            className="text-xs px-3 py-1.5 rounded bg-accent-amber/10 text-accent-amber hover:bg-accent-amber/20 disabled:opacity-50">
            {running === 'autotune' ? 'Reviewing…' : 'Run self-improve now'}
          </button>
        </div>
        {a ? (
          <div className="space-y-3">
            <div className="text-[11px] text-neutral-500">
              Last run: {a.lastRunAt ? new Date(a.lastRunAt).toLocaleString('en-IN') : 'never'} ·
              {' '}min trades to decide: 10 ·
              {' '}target win rate: 80%
            </div>

            {/* Current overrides */}
            {Object.keys(a.overrides).length > 0 ? (
              <div>
                <div className="text-[10px] text-neutral-600 uppercase mb-1">Active overrides</div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  {Object.entries(a.overrides).map(([strat, ov]) => (
                    <div key={strat} className="bg-ink-700 border border-ink-500 rounded p-2 text-[11px]">
                      <div className="font-semibold text-neutral-200">{strat}</div>
                      {ov.minConfluence != null && (
                        <div className="text-accent-amber">minConfluence → {ov.minConfluence}</div>
                      )}
                      {ov.minAdx != null && (
                        <div className="text-accent-amber">minAdx → {ov.minAdx}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="bg-ink-700 border border-ink-500 rounded p-3 text-[11px] text-neutral-600">
                No overrides yet — defaults still apply (waiting for ≥10 closed trades per strategy).
              </div>
            )}

            {/* Adjustments history */}
            {a.adjustments.length > 0 && (
              <div>
                <div className="text-[10px] text-neutral-600 uppercase mb-1">Adjustment history (last {a.adjustments.length})</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px] border border-ink-500 rounded">
                    <thead className="bg-ink-800 text-neutral-400">
                      <tr>
                        <th className="text-left px-3 py-1.5">When</th>
                        <th className="text-left px-3 py-1.5">Strategy</th>
                        <th className="text-left px-3 py-1.5">Metric</th>
                        <th className="text-right px-3 py-1.5">From → To</th>
                        <th className="text-left px-3 py-1.5">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.adjustments.map((adj, i) => (
                        <tr key={i} className="border-t border-ink-500">
                          <td className="px-3 py-1.5">{new Date(adj.ts).toLocaleDateString('en-IN')}</td>
                          <td className="px-3 py-1.5 font-mono">{adj.strategy}</td>
                          <td className="px-3 py-1.5">{adj.metric}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{adj.from} → <b className="text-accent-amber">{adj.to}</b></td>
                          <td className="px-3 py-1.5 text-neutral-400">{adj.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="bg-ink-700 border border-ink-500 rounded p-6 text-center text-xs text-neutral-600">Loading auto-tune…</div>
        )}
      </section>

      {/* Footer */}
      <div className="text-[11px] text-neutral-600 p-3 bg-ink-800 rounded leading-relaxed">
        <b className="text-neutral-400">Honesty note:</b> Self-improve only tightens ENTRY filters
        (raises confluence floor, raises ADX gate). It never silently changes scoring weights to inflate
        the displayed score — that would corrupt the audit trail. Real path to 90% accuracy: (1) more
        closed trades land in the CSV → tighter parameter decisions, (2) pattern learner
        accumulates more winner signatures over weeks → more accurate match-scoring, (3) connecting
        Screener.in fundamentals API unlocks the missing 25 conviction points (FII/DII + EPS).
      </div>
    </div>
  )
}

function expectancyOf(s: PerfStats): number {
  const wr = s.winRatePct / 100
  return (wr * s.avgWinPct) - ((1 - wr) * Math.abs(s.avgLossPct))
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-sm font-semibold text-neutral-200 mb-2">{children}</div>
}

function Stat({ label, value, sub, color }: { label: string; value: React.ReactNode; sub?: string; color?: 'green'|'red'|'amber'|'violet' }) {
  const cls = color === 'green' ? 'text-accent-green' : color === 'red' ? 'text-accent-red' : color === 'amber' ? 'text-accent-amber' : color === 'violet' ? 'text-accent-violet' : 'text-neutral-200'
  return (
    <div className="bg-ink-700 border border-ink-500 rounded p-3">
      <div className="text-[10px] text-neutral-500 uppercase tracking-wider">{label}</div>
      <div className={clsx('text-lg font-mono font-semibold mt-1', cls)}>{value}</div>
      {sub && <div className="text-[10px] text-neutral-600 mt-0.5">{sub}</div>}
    </div>
  )
}
