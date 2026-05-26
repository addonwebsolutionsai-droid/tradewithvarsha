import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { StickyScrollBox, StickyTable, STICKY_THEAD, STICKY_FIRST_COL_HEADER, STICKY_FIRST_COL_BODY } from '../components/StickyTable'
import { useSortableTable } from '../components/useSortableTable'

/**
 * 5–20% Move — Pre-Move Identifier
 *
 * 8-signal composite scorer (24-point max) from the master prompt
 * framework. Reuses the live screeners + shareholding + sector-rotation
 * data behind the scenes. Auto-runs at 16:00 IST weekdays via cron;
 * manual re-run via "Run now" button.
 *
 * UX parity with Weekly Pick: desktop table with sticky header + sticky
 * Symbol column inside a 75vh scroll container. Mobile (< md) → vertical
 * cards. Click a row to expand the 8-signal breakdown.
 */

interface SignalBreakdown { score: number; reason: string }
interface Candidate {
  symbol: string
  ltp: number
  totalScore: number
  tier: 1 | 2 | 3 | 4
  tierLabel: string
  s1_institutional: SignalBreakdown
  s2_volume: SignalBreakdown
  s3_pattern: SignalBreakdown
  s4_fundamentals: SignalBreakdown
  s5_news: SignalBreakdown
  s6_sector: SignalBreakdown
  s7_pumpDump: SignalBreakdown
  s8_entryTiming: SignalBreakdown
  entry: number
  stopLoss: number
  target1: number; target2: number; target3: number
  riskPct: number
  rewardPct: number
  riskReward: number
  expectedMovePct: number
  primarySignal: string
  shareholdingNote?: string
  passedQualityFilter: boolean
  futuristicBucket?: { key: string; label: string; emoji: string }
  volumeRatio?: number
  volumeRatio5d?: number
  smartMoneyUp?: boolean
  fiiDelta?: number
  promoterDelta?: number
  diiDelta?: number
  entryDate?: string
  target1Date?: string; target2Date?: string; target3Date?: string
}

function fmtD(iso?: string): string {
  if (!iso) return '—'
  const [, m, d] = iso.split('-').map(Number)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${d} ${months[m - 1] ?? '?'}`
}
function volCls(r?: number): string {
  if (r == null) return 'text-neutral-500'
  if (r >= 3) return 'text-accent-green font-bold'      // unusual volume → confirms move
  if (r >= 1.5) return 'text-accent-cyan'               // above-avg
  if (r < 0.8) return 'text-accent-amber'               // dry-up (also bullish in some setups)
  return 'text-neutral-400'
}
interface PreMoveRun {
  generatedAt: string
  universeSize: number
  evaluated: number
  qualityPassed: number
  candidates: Candidate[]
  tier1Count: number
  tier2Count: number
  tier3Count: number
  notes: string[]
}

export function PreMoveIdentifierPage(): JSX.Element {
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [filter, setFilter] = useState<'ALL' | 1 | 2 | 3>('ALL')

  const q = useQuery({
    queryKey: ['pre-move-identifier'],
    queryFn: async () => {
      const r = await fetch('/api/pre-move-identifier')
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<PreMoveRun>
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  })

  const runNow = async (): Promise<void> => {
    setRunning(true)
    try {
      const r = await fetch('/api/pre-move-identifier/run', { method: 'POST' })
      if (r.ok) qc.setQueryData(['pre-move-identifier'], await r.json())
    } finally { setRunning(false) }
  }

  const data = q.data
  const filtered = (data?.candidates ?? []).filter(c => filter === 'ALL' || c.tier === filter)
  // 2026-05-26: column-wise sortable headers. Default = score desc (highest
  // conviction first). Click a column header to sort by that field; second
  // click reverses; third resets.
  const { rows: candidates, headerProps, sortIndicator } = useSortableTable<Candidate>(
    filtered,
    { key: 'score', dir: 'desc' },
    {
      symbol: c => c.symbol,
      ltp: c => c.ltp,
      vol: c => c.volumeRatio ?? 0,
      vol5d: c => c.volumeRatio5d ?? 0,
      smart: c => (c.smartMoneyUp ? 1 : 0),
      fii: c => c.fiiDelta ?? 0,
      score: c => c.totalScore,
      tier: c => -c.tier,                     // tier 1 = best, so invert for desc
      entry: c => c.entry,
      sl: c => c.stopLoss,
      t1: c => c.target1,
      t2: c => c.target2,
      t3: c => c.target3,
      rr: c => c.riskReward,
      exp: c => c.expectedMovePct,
    },
  )

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">🎯</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-neutral-200 flex items-center gap-2">
            5–20% Move · Pre-Move Identifier
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-accent-green/20 text-accent-green border border-accent-green/40">NEW</span>
          </div>
          <div className="text-xs text-neutral-500 mt-1">
            8-signal composite scorer (institutional · volume · pattern · fundamentals · news · sector · pump-dump · entry-timing).
            Quality-filtered against pump-and-dump. Auto-runs 16:00 IST weekdays.
          </div>
          {data && (
            <div className="text-[11px] text-neutral-400 font-mono mt-2 flex flex-wrap gap-x-3 gap-y-1">
              <span>Tier 1 <b className="text-accent-green">{data.tier1Count}</b></span>
              <span>Tier 2 <b className="text-accent-cyan">{data.tier2Count}</b></span>
              <span>Tier 3 <b className="text-accent-amber">{data.tier3Count}</b></span>
              <span className="text-neutral-600">· universe {data.universeSize} · evaluated {data.evaluated} · quality-pass {data.qualityPassed}</span>
              <span className="text-neutral-600">· updated {new Date(data.generatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} IST</span>
            </div>
          )}
        </div>
        <button onClick={runNow} disabled={running}
          className="flex-shrink-0 text-xs px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50">
          {running ? 'Running… (~30s)' : 'Run now'}
        </button>
      </div>

      {/* Filter chips */}
      <div className="flex gap-2 flex-wrap">
        {[
          { key: 'ALL' as const, label: 'All' },
          { key: 1 as const, label: '🟢 Tier 1 — Buy Alert' },
          { key: 2 as const, label: '🟡 Tier 2 — Watchlist' },
          { key: 3 as const, label: '🟠 Tier 3 — Monitor' },
        ].map(f => (
          <button key={String(f.key)} onClick={() => setFilter(f.key)}
            className={clsx('px-2 py-1 rounded text-[11px] border',
              filter === f.key ? 'bg-accent-violet/20 border-accent-violet text-accent-violet' : 'bg-ink-700 border-ink-500 text-neutral-500',
            )}>
            {f.label}
          </button>
        ))}
      </div>

      {q.isLoading && <div className="text-center text-neutral-500 text-xs p-8">Loading… first scan takes ~30s.</div>}
      {q.error && <div className="text-center text-accent-amber text-xs p-8">Couldn't load. Try "Run now".</div>}
      {!q.isLoading && data && candidates.length === 0 && (
        <div className="text-center text-neutral-500 text-xs p-8">No candidates pass the current filter. Try widening tier filter or "Run now".</div>
      )}

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {candidates.map((c, i) => <CandidateCard key={c.symbol + i} c={c} />)}
      </div>

      {/* Desktop layout — two-row per pick:
          Row 1 = compact numeric grid (sortable headers).
          Row 2 = always-visible Stake (FII/DII/Promoter) + Signal mix.
          T1/T2/T3 each combine the price + date into one cell.
          Vol×, 5dVol×, Smart-$, FIIΔ collapsed into one "Money Flow" cell
          showing all four signals stacked vertically. Reduces ~21 columns
          → 12 so the whole row fits without horizontal scroll on 1280px+. */}
      {candidates.length > 0 && (
        <div className="hidden md:block">
          <StickyScrollBox>
            <StickyTable minWidth={1240} className="text-[11px]">
              <thead className={STICKY_THEAD}>
                <tr>
                  <th {...headerProps('symbol')} className={`text-left px-3 py-2 ${STICKY_FIRST_COL_HEADER} ${headerProps('symbol').className}`}>Stock {sortIndicator('symbol')}</th>
                  <th {...headerProps('ltp')} className={`text-right px-2 py-2 ${headerProps('ltp').className}`}>LTP {sortIndicator('ltp')}</th>
                  <th {...headerProps('smart')} className={`text-center px-2 py-2 ${headerProps('smart').className}`} title="Sort by Smart Money flag (🔥 first).">Money Flow {sortIndicator('smart')}</th>
                  <th {...headerProps('score')} className={`text-center px-2 py-2 ${headerProps('score').className}`}>Score {sortIndicator('score')}</th>
                  <th {...headerProps('entry')} className={`text-right px-2 py-2 text-accent-cyan ${headerProps('entry').className}`}>Entry {sortIndicator('entry')}</th>
                  <th {...headerProps('sl')} className={`text-right px-2 py-2 text-accent-red ${headerProps('sl').className}`}>SL {sortIndicator('sl')}</th>
                  <th {...headerProps('t1')} className={`text-right px-2 py-2 text-accent-green ${headerProps('t1').className}`}>T1 · date {sortIndicator('t1')}</th>
                  <th {...headerProps('t2')} className={`text-right px-2 py-2 text-accent-green ${headerProps('t2').className}`}>T2 · date {sortIndicator('t2')}</th>
                  <th {...headerProps('t3')} className={`text-right px-2 py-2 text-accent-green ${headerProps('t3').className}`}>T3 · date {sortIndicator('t3')}</th>
                  <th {...headerProps('rr')} className={`text-center px-2 py-2 ${headerProps('rr').className}`}>R:R {sortIndicator('rr')}</th>
                  <th {...headerProps('exp')} className={`text-center px-2 py-2 ${headerProps('exp').className}`}>Exp% {sortIndicator('exp')}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c, i) => <CandidateRow key={c.symbol + i} c={c} />)}
              </tbody>
            </StickyTable>
          </StickyScrollBox>
        </div>
      )}

      {/* Notes */}
      {data?.notes && data.notes.length > 0 && (
        <div className="bg-ink-800 border border-ink-500 rounded-lg p-3 text-[11px] text-neutral-500 leading-relaxed">
          {data.notes.map((n, i) => <div key={i}>· {n}</div>)}
        </div>
      )}
    </div>
  )
}

function tierCls(tier: number): string {
  return tier === 1 ? 'text-accent-green' : tier === 2 ? 'text-accent-cyan' : tier === 3 ? 'text-accent-amber' : 'text-neutral-500'
}

function CandidateRow({ c }: { c: Candidate }): JSX.Element {
  const [open, setOpen] = useState(false)
  const rowBg = c.tier === 1 ? 'bg-accent-green/5' : 'bg-ink-800'
  const td = `px-2 py-2 ${rowBg} group-hover:bg-ink-700 cursor-pointer`
  // Sub-row gets a slightly different bg so the two rows visually pair as one
  // "card" while keeping table alignment for sortable numerics above.
  const subBg = c.tier === 1 ? 'bg-accent-green/[0.025]' : 'bg-ink-900/40'
  return (
    <>
      {/* Row 1 — main numeric grid */}
      <tr className="group border-t border-ink-500" onClick={() => setOpen(o => !o)}>
        <td className={`${td} px-3 ${STICKY_FIRST_COL_BODY}`}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <b className="text-neutral-200">{c.symbol}</b>
            {c.futuristicBucket && (
              <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-accent-violet/20 text-accent-violet border border-accent-violet/40"
                title={`${c.futuristicBucket.label} — futuristic high-growth sector (+score bonus)`}>
                {c.futuristicBucket.emoji}
              </span>
            )}
          </div>
        </td>
        <td className={`${td} text-right`}>₹{c.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
        {/* Money Flow — stacked: today vol / 5d vol / smart-money badge / FIIΔ */}
        <td className={`${td} text-center`} title="Vol = today×, 5dVol = 5d/20d avg, 🔥 = FII↑+Promoter stable">
          <div className="flex items-center justify-center gap-1.5 text-[10px] leading-tight whitespace-nowrap">
            <span className={volCls(c.volumeRatio)}>{c.volumeRatio ? `${c.volumeRatio}×` : '—'}</span>
            <span className="text-neutral-700">·</span>
            <span className={volCls(c.volumeRatio5d)}>5d {c.volumeRatio5d ? `${c.volumeRatio5d}×` : '—'}</span>
            <span className="text-neutral-700">·</span>
            {c.smartMoneyUp ? <span className="text-accent-green font-bold">🔥</span> : <span className="text-neutral-700">·</span>}
            {c.fiiDelta != null && c.fiiDelta !== 0 && (
              <span className={c.fiiDelta > 0 ? 'text-accent-green' : 'text-accent-red'}>FII {c.fiiDelta > 0 ? '+' : ''}{c.fiiDelta}</span>
            )}
          </div>
        </td>
        <td className={`${td} text-center`}>
          <div className={`font-bold ${tierCls(c.tier)}`}>{c.totalScore}/24</div>
          <div className={`text-[9px] font-bold ${tierCls(c.tier)}`}>{c.tierLabel}</div>
        </td>
        <td className={`${td} text-right text-accent-cyan`}>
          <div>₹{c.entry}</div>
          <div className="text-[9px] text-accent-cyan/70">by {fmtD(c.entryDate)}</div>
        </td>
        <td className={`${td} text-right text-accent-red`}>₹{c.stopLoss}</td>
        <td className={`${td} text-right text-accent-green`}>
          <div>₹{c.target1}</div>
          <div className="text-[9px] text-accent-green/70">{fmtD(c.target1Date)}</div>
        </td>
        <td className={`${td} text-right text-accent-green`}>
          <div>₹{c.target2}</div>
          <div className="text-[9px] text-accent-green/70">{fmtD(c.target2Date)}</div>
        </td>
        <td className={`${td} text-right text-accent-green font-bold`}>
          <div>₹{c.target3}</div>
          <div className="text-[9px] text-accent-green/70 font-normal">{fmtD(c.target3Date)}</div>
        </td>
        <td className={`${td} text-center`}>1:{c.riskReward}</td>
        <td className={`${td} text-center text-accent-green`}>+{c.expectedMovePct}%</td>
      </tr>
      {/* Row 2 — always-visible Stake + Signal mix sub-row */}
      <tr className={`${subBg}`}>
        <td className={`${subBg} px-3 py-1.5 ${STICKY_FIRST_COL_BODY} text-[10px] text-neutral-500`}>
          {c.futuristicBucket?.label || ''}
        </td>
        <td colSpan={10} className={`${subBg} px-3 py-1.5 text-[10px] text-neutral-400`}>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5">
            <span><span className="text-neutral-600 font-semibold">📊 Stake:</span> {c.shareholdingNote || <span className="text-neutral-600">unavailable</span>}</span>
            <span><span className="text-neutral-600 font-semibold">⚡ Setup:</span> {c.primarySignal}</span>
          </div>
        </td>
      </tr>
      {open && (
        <tr className="bg-ink-700">
          <td colSpan={11} className="px-4 py-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono">
              <SignalCell n={1} label="Institutional" b={c.s1_institutional} />
              <SignalCell n={2} label="Volume" b={c.s2_volume} />
              <SignalCell n={3} label="Pattern" b={c.s3_pattern} />
              <SignalCell n={4} label="Fundamentals" b={c.s4_fundamentals} />
              <SignalCell n={5} label="News" b={c.s5_news} />
              <SignalCell n={6} label="Sector" b={c.s6_sector} />
              <SignalCell n={7} label="Pump-Dump" b={c.s7_pumpDump} />
              <SignalCell n={8} label="Entry/Risk" b={c.s8_entryTiming} />
            </div>
            <div className="mt-2 text-[10px] text-neutral-500">
              Risk {c.riskPct}% · Reward {c.rewardPct}% to T1 · expected +{c.expectedMovePct}% to T2 · Click row to collapse
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function SignalCell({ n, label, b }: { n: number; label: string; b: SignalBreakdown }): JSX.Element {
  const cls = b.score >= 3 ? 'text-accent-green border-accent-green/40'
    : b.score >= 2 ? 'text-accent-cyan border-accent-cyan/40'
    : b.score >= 1 ? 'text-accent-amber border-accent-amber/40'
    : 'text-neutral-600 border-ink-500'
  return (
    <div className={clsx('bg-ink-800 border rounded p-2', cls)}>
      <div className="text-neutral-500 text-[9px] uppercase">[{n}] {label}</div>
      <div className="font-bold">{b.score}/3</div>
      <div className="text-neutral-400 text-[10px]" style={{ whiteSpace: 'normal' }}>{b.reason}</div>
    </div>
  )
}

function CandidateCard({ c }: { c: Candidate }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={clsx('rounded-lg border p-3 font-mono text-[12px]',
      c.tier === 1 ? 'bg-accent-green/5 border-accent-green/40' :
      c.tier === 2 ? 'bg-accent-cyan/5 border-accent-cyan/40' :
      'bg-ink-800 border-ink-500')}
      onClick={() => setOpen(o => !o)}>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
        <div className="flex items-center gap-1.5">
          <b className="text-neutral-100 text-[13px]">{c.symbol}</b>
          {c.futuristicBucket && (
            <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-accent-violet/20 text-accent-violet border border-accent-violet/40">
              {c.futuristicBucket.emoji} {c.futuristicBucket.key}
            </span>
          )}
        </div>
        <span className={clsx('text-[12px] font-bold', tierCls(c.tier))}>{c.totalScore}/24 {c.tierLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <div className="text-neutral-500">LTP</div><div className="text-right">₹{c.ltp}</div>
        <div className="text-neutral-500">Vol×</div><div className={clsx('text-right', volCls(c.volumeRatio))}>{c.volumeRatio ? `${c.volumeRatio}×` : '—'}</div>
        <div className="text-accent-cyan">Entry</div><div className="text-right text-accent-cyan">₹{c.entry} <span className="text-neutral-500 text-[10px]">· {fmtD(c.entryDate)}</span></div>
        <div className="text-accent-red">Stop Loss</div><div className="text-right text-accent-red">₹{c.stopLoss}</div>
        <div className="text-accent-green">T1</div><div className="text-right text-accent-green">₹{c.target1} <span className="text-neutral-500 text-[10px]">· {fmtD(c.target1Date)}</span></div>
        <div className="text-accent-green">T2</div><div className="text-right text-accent-green">₹{c.target2} <span className="text-neutral-500 text-[10px]">· {fmtD(c.target2Date)}</span></div>
        <div className="text-accent-green">T3</div><div className="text-right text-accent-green font-bold">₹{c.target3} <span className="text-neutral-500 text-[10px]">· {fmtD(c.target3Date)}</span></div>
        <div className="text-neutral-500">R:R</div><div className="text-right">1:{c.riskReward}</div>
        <div className="text-neutral-500">Exp move</div><div className="text-right text-accent-green">+{c.expectedMovePct}%</div>
      </div>
      <div className="mt-2 pt-2 border-t border-ink-500 text-[10px] text-neutral-400">
        <span className="text-neutral-600 font-semibold">Signal: </span>{c.primarySignal}
      </div>
      {c.shareholdingNote && (
        <div className="mt-1 text-[10px] text-neutral-400">
          <span className="text-neutral-600 font-semibold">Stake: </span>{c.shareholdingNote}
        </div>
      )}
      {open && (
        <div className="mt-2 pt-2 border-t border-ink-500 grid grid-cols-2 gap-1.5 text-[10px]">
          <SignalCell n={1} label="Inst" b={c.s1_institutional} />
          <SignalCell n={2} label="Vol" b={c.s2_volume} />
          <SignalCell n={3} label="Pattern" b={c.s3_pattern} />
          <SignalCell n={4} label="Fund" b={c.s4_fundamentals} />
          <SignalCell n={5} label="News" b={c.s5_news} />
          <SignalCell n={6} label="Sector" b={c.s6_sector} />
          <SignalCell n={7} label="P&D" b={c.s7_pumpDump} />
          <SignalCell n={8} label="Entry" b={c.s8_entryTiming} />
        </div>
      )}
    </div>
  )
}
