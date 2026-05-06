import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'

interface ActiveCycle {
  bucket: 'MINOR' | 'MAJOR' | 'LARGER'
  cycleDays: number
  cycleLabel: string
  seedName: string
  seedDate: string
  seedKind: 'HIGH' | 'LOW'
  importance: 'HIGH' | 'MED' | 'LOW'
  cycleStart: string
  cycleEnd: string
  daysElapsed: number
  daysRemaining: number
  pctComplete: number
}

interface BestCycleTrade {
  cycle: ActiveCycle
  direction: 'BUY' | 'SELL'
  rationale: string
  entry: number; stopLoss: number; target1: number; target2: number
  entryByDate: string; exitByDate: string
  holdDays: number; riskReward: number
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  confidenceNotes: string[]
}

interface TimeCycleStatus {
  symbol: string
  asOf: string
  livePrice?: number; change?: number; changePct?: number
  nearestGannLevel?: { price: number; label: string; angle: number; distancePct: number } | null
  bestTrade?: BestCycleTrade | null
  activeCycles: ActiveCycle[]
  byBucket: Record<'MINOR' | 'MAJOR' | 'LARGER', ActiveCycle[]>
  reversals: { date: string; daysAway: number; cycleLabel: string; seedName: string; importance: 'HIGH' | 'MED' | 'LOW'; bucket: string }[]
  anniversaries: { yearsAgo: number; date: string; seedName: string; seedDate: string }[]
}

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'GOLD', 'CRUDE']

export function TimeCyclePage() {
  const [symbol, setSymbol] = useState('NIFTY')

  const tc = useQuery<TimeCycleStatus>({
    queryKey: ['time-cycle', symbol],
    queryFn: async () => {
      const r = await fetch(`/api/gann/time-cycle?symbol=${symbol}`)
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json()
    },
    staleTime: 5 * 60_000,
  })

  const astro = useQuery<any>({
    queryKey: ['astro'],
    queryFn: async () => (await fetch('/api/astro')).json(),
    staleTime: 30 * 60_000,
  })

  const t = tc.data
  if (!t) return <div className="text-xs text-neutral-500 p-6">Loading time cycle data…</div>

  // Filter active cycles ending soonest (next 30d) — these are "ending now" cycles
  const endingSoon = t.activeCycles
    .filter(c => c.daysRemaining <= 30 && c.importance !== 'LOW')
    .sort((a, b) => a.daysRemaining - b.daysRemaining)
    .slice(0, 8)

  // Cycles freshly started (< 10% complete + HIGH/MED importance)
  const justStarted = t.activeCycles
    .filter(c => c.pctComplete < 15 && c.importance !== 'LOW')
    .sort((a, b) => a.pctComplete - b.pctComplete)
    .slice(0, 8)

  // Cycles in mid-phase
  const inProgress = t.activeCycles
    .filter(c => c.pctComplete >= 30 && c.pctComplete <= 70 && c.importance === 'HIGH')
    .slice(0, 8)

  return (
    <div className="space-y-5">
      {/* Price header */}
      <div className="p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-neutral-500">Time Cycle · {t.symbol}</div>
            <div className="flex items-baseline gap-3 mt-1">
              <div className="text-3xl font-mono font-bold text-neutral-100">
                {t.livePrice != null ? `₹${t.livePrice.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
              </div>
              {t.change != null && (
                <div className={clsx('text-sm font-mono font-semibold', t.change >= 0 ? 'text-accent-green' : 'text-accent-red')}>
                  {t.change >= 0 ? '+' : ''}{t.change.toFixed(2)} ({t.changePct! >= 0 ? '+' : ''}{t.changePct!.toFixed(2)}%)
                </div>
              )}
            </div>
            <div className="text-[11px] text-neutral-500 mt-1">
              Active cycles · anniversaries · reversal calendar · planetary overlay
            </div>
          </div>
          <div className="flex gap-1">
            {SYMBOLS.map(s => (
              <button key={s} onClick={() => setSymbol(s)}
                className={`text-xs px-3 py-1.5 rounded ${symbol === s ? 'bg-accent-cyan/20 text-accent-cyan font-semibold' : 'bg-ink-500 text-neutral-500'}`}>
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3 text-[11px]">
          <div className="bg-ink-800 border border-ink-500 rounded p-2">
            <div className="text-[10px] text-neutral-500">NEAREST GANN LEVEL</div>
            {t.nearestGannLevel ? (
              <div className="mt-1 font-mono">
                <span className="text-accent-amber font-bold">₹{t.nearestGannLevel.price.toFixed(2)}</span>
                <span className="text-neutral-500 ml-1">{t.nearestGannLevel.label}</span>
                <span className="text-neutral-600 ml-1">({t.nearestGannLevel.distancePct.toFixed(2)}% away)</span>
              </div>
            ) : <div className="mt-1 text-neutral-600">—</div>}
          </div>
          <div className="bg-ink-800 border border-ink-500 rounded p-2">
            <div className="text-[10px] text-neutral-500">CYCLES ACTIVE</div>
            <div className="mt-1 font-mono text-neutral-200">
              {t.activeCycles.length} total
              <span className="text-neutral-500 text-[10px] ml-1">
                (L:{t.byBucket.LARGER.length} · Maj:{t.byBucket.MAJOR.length} · Min:{t.byBucket.MINOR.length})
              </span>
            </div>
          </div>
          <div className="bg-ink-800 border border-ink-500 rounded p-2">
            <div className="text-[10px] text-neutral-500">REVERSAL DATES (180d)</div>
            <div className="mt-1 font-mono text-neutral-200">
              {t.reversals.length} ahead
              <span className="text-neutral-500 text-[10px] ml-1">
                ({t.reversals.filter(r => r.importance === 'HIGH').length} HIGH-imp)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Best Cycle to Play hero */}
      {t.bestTrade && <BestCycleToPlay trade={t.bestTrade} symbol={t.symbol} spot={t.livePrice ?? 0} />}

      {/* Three time-state buckets */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CycleStateColumn
          title="🛬 Cycles ending in ≤30 days"
          subtitle="Reversal pressure builds as these complete"
          cycles={endingSoon}
          accent="red"
          showColumn="end"
        />
        <CycleStateColumn
          title="🛫 Cycles just started"
          subtitle="Trend establishment phase — direction sets the next major move"
          cycles={justStarted}
          accent="green"
          showColumn="start"
        />
        <CycleStateColumn
          title="🌊 In-progress major cycles"
          subtitle="Currently driving the macro trend"
          cycles={inProgress}
          accent="violet"
          showColumn="middle"
        />
      </div>

      {/* Reversal calendar */}
      <div>
        <SectionTitle>📅 Reversal Date Calendar · next 180 days</SectionTitle>
        <ReversalCalendar reversals={t.reversals} />
      </div>

      {/* Anniversary table */}
      <div>
        <SectionTitle>🎂 Anniversaries · same calendar dates from prior years</SectionTitle>
        <div className="bg-ink-700 border border-ink-500 rounded-lg p-3">
          <div className="text-[11px] text-neutral-500 mb-2">
            Historical reaction dates often repeat on the calendar 1y / 2y / 3y / 4y later. Watch these dates for echo moves.
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {t.anniversaries.length === 0 ? <div className="text-xs text-neutral-600">No prior-year pivots loaded</div> :
              t.anniversaries.map((a, i) => (
                <div key={i} className="bg-ink-800 border border-ink-500 rounded p-2 text-[11px]">
                  <div className="font-mono text-accent-violet font-bold">{a.date.slice(5)}</div>
                  <div className="text-neutral-300">{a.seedName}</div>
                  <div className="text-[10px] text-neutral-500">{a.yearsAgo} year{a.yearsAgo !== 1 ? 's' : ''} ago</div>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Astro overlay */}
      {astro.data && (
        <div>
          <SectionTitle>🪐 Planetary overlay · today</SectionTitle>
          <div className="bg-ink-700 border border-ink-500 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className={clsx('text-[10px] px-2 py-0.5 rounded font-bold',
                astro.data.bias?.bullish ? 'bg-accent-green/15 text-accent-green' :
                astro.data.bias?.bearish ? 'bg-accent-red/15 text-accent-red' :
                                            'bg-ink-500 text-neutral-500')}>
                {astro.data.bias?.bullish ? 'BULLISH' : astro.data.bias?.bearish ? 'BEARISH' : 'NEUTRAL'}
              </span>
              {astro.data.bias?.volatile && (
                <span className="text-[10px] px-2 py-0.5 rounded bg-accent-amber/15 text-accent-amber">VOLATILE</span>
              )}
              <span className="text-[10px] text-neutral-500">strength {(astro.data.bias?.strength ?? 0).toFixed(2)}</span>
            </div>
            <div className="text-xs text-neutral-300">{astro.data.bias?.note}</div>
            {astro.data.bias?.aspects?.length > 0 && (
              <div className="mt-3">
                <div className="text-[10px] uppercase text-neutral-500 mb-1">Active aspects</div>
                <div className="flex flex-wrap gap-1.5">
                  {astro.data.bias.aspects.map((a: string, i: number) => (
                    <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-ink-500 text-neutral-400">{a}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="mt-3 grid grid-cols-3 md:grid-cols-5 gap-2">
              {(astro.data.bias?.planets ?? []).map((p: any, i: number) => (
                <div key={i} className="bg-ink-800 border border-ink-500 rounded p-2 text-[10px]">
                  <div className="font-bold text-neutral-200">{p.planet}</div>
                  <div className="text-neutral-500">{p.sign} · {p.degree.toFixed(1)}°{p.retrograde ? ' R' : ''}</div>
                  <div className={clsx(
                    p.influence === 'Bullish' ? 'text-accent-green' :
                    p.influence === 'Bearish' ? 'text-accent-red' :
                    p.influence === 'Volatile' ? 'text-accent-amber' :
                    'text-neutral-500',
                  )}>{p.influence}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="text-[11px] text-neutral-600 p-3 bg-ink-800 rounded leading-relaxed">
        <b className="text-neutral-400">Method:</b> All cycles anchored to historical major swings. Three time-states surfaced —
        ending soon (reversal risk), just started (trend setting), in-progress (driving the move). Anniversary dates from prior years
        flagged for echo-move watch. Planetary overlay layers Vedic + Mundane bias on the same date.
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-sm font-semibold text-neutral-200 mb-2 pt-2">{children}</div>
}

function BestCycleToPlay({ trade, symbol, spot }: { trade: BestCycleTrade; symbol: string; spot: number }) {
  const bull = trade.direction === 'BUY'
  const border = bull ? 'border-accent-green/40 bg-accent-green/5' : 'border-accent-red/40 bg-accent-red/5'
  const accent = bull ? 'text-accent-green' : 'text-accent-red'
  const confCls = trade.confidence === 'HIGH' ? 'text-accent-green' : trade.confidence === 'MEDIUM' ? 'text-accent-amber' : 'text-neutral-400'
  return (
    <div className={clsx('rounded-lg border p-4', border)}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">🎯 Best Cycle to Play right now</div>
          <div className="text-xl font-bold mt-1">
            <span className={accent}>{trade.direction}</span>
            <span className="text-neutral-200"> {symbol}</span>
            <span className="text-neutral-500 text-sm ml-2">· on {trade.cycle.cycleLabel}</span>
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5">
            {trade.cycle.pctComplete}% complete · {trade.cycle.daysRemaining}d left · anchored to {trade.cycle.seedKind === 'HIGH' ? '🔻' : '🔺'} {trade.cycle.seedName}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">Confidence</div>
          <div className={clsx('text-xl font-bold mt-1', confCls)}>{trade.confidence}</div>
          <div className="text-[10px] text-neutral-500">RR {trade.riskReward}:1</div>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3 font-mono text-[12px]">
        <MiniBox label="Entry" value={`₹${trade.entry}`} by={trade.entryByDate} color="text-accent-cyan" />
        <MiniBox label="Stop Loss" value={`₹${trade.stopLoss}`} by="risk" color="text-accent-red" />
        <MiniBox label="Target 1" value={`₹${trade.target1}`} by="T1 date ≈ +30%" color="text-accent-green" />
        <MiniBox label="Target 2" value={`₹${trade.target2}`} by="T2 ≈ exit" color="text-accent-green" />
        <MiniBox label="Exit by" value={trade.exitByDate} by={`${trade.holdDays}d hold`} color="text-accent-amber" />
      </div>
      <div className="text-[12px] text-neutral-300 leading-relaxed">
        <b>Why this cycle:</b> {trade.rationale}
      </div>
      {trade.confidenceNotes.length > 0 && (
        <div className="mt-2 text-[11px] text-neutral-400 space-y-0.5">
          {trade.confidenceNotes.map((n, i) => <div key={i}>• {n}</div>)}
        </div>
      )}
      <div className="mt-3 text-[10px] text-neutral-600">
        Spot: ₹{spot.toFixed(2)} · Same trade plan also on the Gann Cycle tab with full Square-of-9 levels.
      </div>
    </div>
  )
}

function MiniBox({ label, value, by, color }: { label: string; value: string; by: string; color: string }) {
  return (
    <div className="bg-ink-800 border border-ink-500 rounded p-2">
      <div className="text-[10px] uppercase text-neutral-500">{label}</div>
      <div className={clsx('font-bold mt-0.5', color)}>{value}</div>
      <div className="text-[9px] text-neutral-600">{by}</div>
    </div>
  )
}

function CycleStateColumn({
  title, subtitle, cycles, accent, showColumn,
}: {
  title: string
  subtitle: string
  cycles: ActiveCycle[]
  accent: 'red' | 'green' | 'violet'
  showColumn: 'start' | 'end' | 'middle'
}) {
  const headerCls = accent === 'red' ? 'border-accent-red/30 bg-accent-red/5 text-accent-red'
    : accent === 'green' ? 'border-accent-green/30 bg-accent-green/5 text-accent-green'
    : 'border-accent-violet/30 bg-accent-violet/5 text-accent-violet'
  return (
    <div>
      <div className={clsx('px-3 py-2 rounded-t-lg border border-b-0', headerCls)}>
        <div className="font-bold text-xs">{title}</div>
        <div className="text-[10px] mt-0.5 opacity-80">{subtitle}</div>
      </div>
      <div className={clsx('border rounded-b-lg p-2 space-y-2 min-h-[200px]', headerCls.split(' ')[0])}>
        {cycles.length === 0 ? <div className="py-12 text-center text-[11px] text-neutral-600">Nothing right now</div> :
          cycles.map((c, i) => (
            <div key={i} className="bg-ink-700 border border-ink-500 rounded p-2 text-[11px]">
              <div className="flex items-center justify-between">
                <div className="font-mono font-bold text-neutral-200">{c.cycleLabel}</div>
                <div className={clsx('text-[9px] px-1.5 py-0.5 rounded',
                  c.importance === 'HIGH' ? 'bg-accent-red/15 text-accent-red' : 'bg-ink-500 text-neutral-500')}>
                  {c.importance}
                </div>
              </div>
              <div className="text-[10px] text-neutral-500 mt-0.5">{c.seedKind === 'HIGH' ? '🔻' : '🔺'} {c.seedName}</div>
              <div className="mt-1 h-1 bg-ink-500 rounded overflow-hidden">
                <div className={clsx('h-full',
                  c.pctComplete > 85 ? 'bg-accent-red' :
                  c.pctComplete > 60 ? 'bg-accent-amber' :
                                        'bg-accent-cyan')}
                  style={{ width: `${c.pctComplete}%` }} />
              </div>
              <div className="text-[10px] font-mono text-neutral-500 mt-1">
                {showColumn === 'start' && <>started {c.cycleStart} · {c.daysElapsed}d in</>}
                {showColumn === 'end'   && <>ends {c.cycleEnd} · {c.daysRemaining}d left</>}
                {showColumn === 'middle'&& <>{c.daysElapsed} of {c.cycleDays}d ({c.pctComplete}%)</>}
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}

function ReversalCalendar({ reversals }: { reversals: TimeCycleStatus['reversals'] }) {
  // Group by month
  const byMonth: Record<string, TimeCycleStatus['reversals']> = {}
  for (const r of reversals.slice(0, 60)) {
    const m = r.date.slice(0, 7)
    byMonth[m] ||= []
    byMonth[m].push(r)
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {Object.entries(byMonth).map(([month, items]) => (
        <div key={month} className="bg-ink-700 border border-ink-500 rounded-lg p-3">
          <div className="text-xs font-bold text-neutral-200 mb-2">{monthLabel(month)}</div>
          {items.map((r, i) => (
            <div key={i} className="flex items-center justify-between text-[11px] py-1 border-b border-ink-500 last:border-b-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-neutral-300">{r.date.slice(8)}</span>
                <span className="text-neutral-500 truncate">{r.cycleLabel}</span>
              </div>
              <span className={clsx('text-[9px] px-1 py-0.5 rounded ml-2',
                r.importance === 'HIGH' ? 'bg-accent-red/15 text-accent-red' :
                r.importance === 'MED'  ? 'bg-accent-amber/15 text-accent-amber' :
                                          'bg-ink-500 text-neutral-500')}>
                {r.importance}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map(Number)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[m - 1]} ${y}`
}
