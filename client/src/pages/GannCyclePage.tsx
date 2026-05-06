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
interface ReversalDate {
  date: string; daysAway: number; cycleDays: number; cycleLabel: string
  seedName: string; seedDate: string; importance: 'HIGH' | 'MED' | 'LOW'
  bucket: 'MINOR' | 'MAJOR' | 'LARGER'
}
interface SquareOf9Snapshot {
  seed: number; seedLabel: string; currentPrice: number
  support: { price: number; angle: number; label: string }[]
  resistance: { price: number; angle: number; label: string }[]
  nearest: { price: number; label: string; angle: number; distancePct: number } | null
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
  cycleBias?: 'BUY' | 'SELL'
  conflicts?: string[]
  overridden?: boolean
  harmonic?: {
    name: string; direction: 'BULLISH' | 'BEARISH'; confidence: number
    X: { price: number }; A: { price: number }; B: { price: number }; C: { price: number }; D: { price: number }
    targets: { t1: number; t2: number; sl: number }
    completedAt: number; ageBars: number
  } | null
  elliott?: {
    phase: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'
    reasoning: string[]; bottomingComplete: boolean; toppingComplete: boolean
    pivotsAnalysed: number
  }
}

interface GannCycleStatus {
  symbol: string; asOf: string; currentPrice: number
  livePrice?: number; change?: number; changePct?: number
  activeCycles: ActiveCycle[]
  byBucket: Record<'MINOR' | 'MAJOR' | 'LARGER', ActiveCycle[]>
  reversals: ReversalDate[]
  nextMajorReversal: ReversalDate | null
  squareOf9: SquareOf9Snapshot
  angles: { ratio: string; slope: number; startDate: string; startPrice: number; currentLine: number; distancePct: number }[]
  degreeStatus: { daysFromSeed: number; sqrtSeedPrice: number; expectedTimeSquare: number; isSquared: boolean; note: string }
  bestTrade?: BestCycleTrade | null
}

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'GOLD', 'CRUDE']

export function GannCyclePage() {
  const [symbol, setSymbol] = useState('NIFTY')

  const cycle = useQuery<GannCycleStatus>({
    queryKey: ['gann-cycle', symbol],
    queryFn: async () => {
      const r = await fetch(`/api/gann/cycle-status?symbol=${symbol}`)
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json()
    },
    staleTime: 5 * 60_000,
  })

  const c = cycle.data
  if (!c) return <div className="text-xs text-neutral-500 p-6">Loading Gann cycle data…</div>

  return (
    <div className="space-y-5">
      {/* ── Big price + symbol selector ─────────────────── */}
      <div className="p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-neutral-500">Gann Cycle · {c.symbol}</div>
            <div className="flex items-baseline gap-3 mt-1">
              <div className="text-3xl font-mono font-bold text-neutral-100">
                ₹{(c.livePrice ?? c.currentPrice).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </div>
              {c.change != null && (
                <div className={clsx('text-sm font-mono font-semibold', c.change >= 0 ? 'text-accent-green' : 'text-accent-red')}>
                  {c.change >= 0 ? '+' : ''}{c.change.toFixed(2)} ({c.changePct! >= 0 ? '+' : ''}{c.changePct!.toFixed(2)}%)
                </div>
              )}
            </div>
            <div className="text-[11px] text-neutral-500 mt-1">
              Square-of-9 · 1×1/2×1/4×1 angles · price-time squaring · cycles MINOR/MAJOR/LARGER
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
        {/* Inline snapshot: 3 key levels (nearest Gann + 1×1 angle + next reversal) */}
        <div className="grid grid-cols-3 gap-2 mt-3 text-[11px]">
          <div className="bg-ink-800 border border-ink-500 rounded p-2">
            <div className="text-[10px] text-neutral-500">NEAREST GANN LEVEL</div>
            {c.squareOf9.nearest ? (
              <div className="mt-1 font-mono">
                <span className="text-accent-amber font-bold">₹{c.squareOf9.nearest.price.toFixed(2)}</span>
                <span className="text-neutral-500 ml-1">{c.squareOf9.nearest.label}</span>
                <span className="text-neutral-600 ml-1">({c.squareOf9.nearest.distancePct.toFixed(2)}% away)</span>
              </div>
            ) : <div className="mt-1 text-neutral-600">—</div>}
          </div>
          <div className="bg-ink-800 border border-ink-500 rounded p-2">
            <div className="text-[10px] text-neutral-500">1×1 ANGLE</div>
            {(() => {
              const one = c.angles.find(a => a.ratio === '1×1')
              if (!one) return <div className="text-neutral-600">—</div>
              const above = one.distancePct >= 0
              return (
                <div className="mt-1 font-mono">
                  <span className={clsx(above ? 'text-accent-green' : 'text-accent-red', 'font-bold')}>
                    {above ? 'ABOVE' : 'BELOW'}
                  </span>
                  <span className="text-neutral-500 ml-1">line ₹{one.currentLine.toFixed(0)}</span>
                </div>
              )
            })()}
          </div>
          <div className="bg-ink-800 border border-ink-500 rounded p-2">
            <div className="text-[10px] text-neutral-500">NEXT MAJOR REVERSAL</div>
            {c.nextMajorReversal ? (
              <div className="mt-1 font-mono">
                <span className="text-accent-red font-bold">{c.nextMajorReversal.date}</span>
                <span className="text-neutral-500 ml-1">+{c.nextMajorReversal.daysAway}d</span>
                <span className="text-neutral-600 ml-1">{c.nextMajorReversal.cycleLabel}</span>
              </div>
            ) : <div className="mt-1 text-neutral-600">none in 30d</div>}
          </div>
        </div>
      </div>

      {/* ── Best Cycle Trade — hero card ───────────────────── */}
      {c.bestTrade && <BestCycleTradeHero trade={c.bestTrade} symbol={c.symbol} spot={c.livePrice ?? c.currentPrice} />}

      {/* Top: Next Major Reversal + Degree Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <NextReversalCard rev={c.nextMajorReversal} />
        <DegreeStatusCard d={c.degreeStatus} />
      </div>

      {/* Active Cycles by Bucket */}
      <div>
        <SectionTitle>📊 Active Cycles · By Bucket</SectionTitle>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <BucketColumn label="🟢 MINOR (≤60 days)" bucket="MINOR" cycles={c.byBucket.MINOR} accent="cyan" />
          <BucketColumn label="🔵 MAJOR (90-180 days)" bucket="MAJOR" cycles={c.byBucket.MAJOR} accent="violet" />
          <BucketColumn label="🟣 LARGER (≥270 days)" bucket="LARGER" cycles={c.byBucket.LARGER} accent="amber" />
        </div>
      </div>

      {/* Square of 9 levels */}
      <div>
        <SectionTitle>🎯 Square-of-9 Price Levels</SectionTitle>
        <div className="bg-ink-700 border border-ink-500 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm text-neutral-300">Anchor: <b>{c.squareOf9.seedLabel}</b> (price {c.squareOf9.seed.toFixed(2)})</div>
              <div className="text-[11px] text-neutral-500 mt-0.5">Levels are degrees from anchor on the Square of 9. Each angle (45°/90°/180°/360°) is a high-probability reaction zone.</div>
            </div>
            {c.squareOf9.nearest && (
              <div className="text-right">
                <div className="text-[10px] text-neutral-500">NEAREST</div>
                <div className="text-sm font-mono text-accent-amber">₹{c.squareOf9.nearest.price.toFixed(2)}</div>
                <div className="text-[10px] text-neutral-500">{c.squareOf9.nearest.label} ({c.squareOf9.nearest.distancePct.toFixed(2)}% away)</div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] uppercase text-accent-green mb-1">Resistance ↑</div>
              {c.squareOf9.resistance.map((l, i) => (
                <div key={i} className="flex justify-between text-xs py-1 border-b border-ink-500 font-mono">
                  <span className="text-neutral-500">{l.label}</span>
                  <span className="text-accent-green">₹{l.price.toFixed(2)}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-[10px] uppercase text-accent-red mb-1">Support ↓</div>
              {c.squareOf9.support.map((l, i) => (
                <div key={i} className="flex justify-between text-xs py-1 border-b border-ink-500 font-mono">
                  <span className="text-neutral-500">{l.label}</span>
                  <span className="text-accent-red">₹{l.price.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-3 text-center font-mono text-base">
            <span className="text-neutral-500">Spot: </span><b className="text-neutral-200">₹{c.currentPrice.toFixed(2)}</b>
          </div>
        </div>
      </div>

      {/* Gann Angles */}
      <div>
        <SectionTitle>📐 Gann Angles · 1×1, 2×1, 4×1, 1×2, 1×4</SectionTitle>
        <div className="overflow-x-auto bg-ink-700 border border-ink-500 rounded-lg">
          <table className="w-full text-xs">
            <thead className="bg-ink-800 text-neutral-400">
              <tr>
                <th className="text-left px-3 py-2">Angle</th>
                <th className="text-right px-3 py-2">Slope ₹/day</th>
                <th className="text-left px-3 py-2">From</th>
                <th className="text-right px-3 py-2">Start ₹</th>
                <th className="text-right px-3 py-2 text-accent-cyan">Current line</th>
                <th className="text-right px-3 py-2">Price vs line</th>
              </tr>
            </thead>
            <tbody>
              {c.angles.map((a, i) => (
                <tr key={i} className="border-t border-ink-500 font-mono">
                  <td className="px-3 py-2 font-bold text-neutral-200">{a.ratio}</td>
                  <td className="px-3 py-2 text-right">{a.slope.toFixed(3)}</td>
                  <td className="px-3 py-2 text-[10px] text-neutral-500">{a.startDate}</td>
                  <td className="px-3 py-2 text-right">₹{a.startPrice.toFixed(2)}</td>
                  <td className="px-3 py-2 text-right text-accent-cyan">₹{a.currentLine.toFixed(2)}</td>
                  <td className={clsx('px-3 py-2 text-right', a.distancePct >= 0 ? 'text-accent-green' : 'text-accent-red')}>
                    {a.distancePct >= 0 ? '+' : ''}{a.distancePct.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[10px] text-neutral-600 px-3 py-2 border-t border-ink-500">
            1×1 = canonical 45° angle (most important). Price holding above 1×1 = strong trend. Cross below 1×1 = weakness.
          </div>
        </div>
      </div>

      {/* Reversal Calendar */}
      <div>
        <SectionTitle>📅 Upcoming Reversal Dates · next 120 days</SectionTitle>
        <div className="overflow-x-auto bg-ink-700 border border-ink-500 rounded-lg">
          <table className="w-full text-xs">
            <thead className="bg-ink-800 text-neutral-400">
              <tr>
                <th className="text-left px-3 py-2">Date</th>
                <th className="text-right px-3 py-2">Days away</th>
                <th className="text-left px-3 py-2">Cycle</th>
                <th className="text-left px-3 py-2">Bucket</th>
                <th className="text-left px-3 py-2">From seed</th>
                <th className="text-center px-3 py-2">Importance</th>
              </tr>
            </thead>
            <tbody>
              {c.reversals.slice(0, 30).map((r, i) => (
                <tr key={i} className="border-t border-ink-500">
                  <td className="px-3 py-2 font-mono font-bold text-neutral-200">{r.date}</td>
                  <td className="px-3 py-2 text-right text-accent-cyan">+{r.daysAway}d</td>
                  <td className="px-3 py-2 text-[11px]">{r.cycleLabel}</td>
                  <td className="px-3 py-2">
                    <span className={clsx('text-[9px] px-1.5 py-0.5 rounded',
                      r.bucket === 'LARGER' ? 'bg-accent-amber/15 text-accent-amber' :
                      r.bucket === 'MAJOR'  ? 'bg-accent-violet/15 text-accent-violet' :
                                              'bg-accent-cyan/15 text-accent-cyan')}>
                      {r.bucket}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-neutral-400">{r.seedName} ({r.seedDate})</td>
                  <td className="px-3 py-2 text-center">
                    <span className={clsx('text-[9px] px-1.5 py-0.5 rounded',
                      r.importance === 'HIGH' ? 'bg-accent-red/15 text-accent-red' :
                      r.importance === 'MED'  ? 'bg-accent-amber/15 text-accent-amber' :
                                                'bg-ink-500 text-neutral-500')}>
                      {r.importance}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="text-[11px] text-neutral-600 p-3 bg-ink-800 rounded leading-relaxed">
        <b className="text-neutral-400">Method:</b> Cycles 30/45/60/90/120/144/180/270/360 days projected from
        historical pivots (see <a href="/api/gann?symbol=NIFTY" className="text-accent-cyan hover:underline">/api/gann</a>).
        Square-of-9 anchored to most recent HIGH-importance pivot. Angles use 1% of seed price as the canonical
        1×1 unit (a software adaptation; classical Gann uses 1 cent per day on commodities). Price-time squaring
        flagged when (days from seed) ≈ √(seed price) × harmonic.
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-sm font-semibold text-neutral-200 mb-2 pt-2">{children}</div>
}

function BestCycleTradeHero({ trade, symbol, spot }: { trade: BestCycleTrade; symbol: string; spot: number }) {
  const bull = trade.direction === 'BUY'
  const confColor = trade.confidence === 'HIGH' ? 'green' : trade.confidence === 'MEDIUM' ? 'amber' : 'neutral'
  const border = bull ? 'border-accent-green/40 bg-accent-green/5' : 'border-accent-red/40 bg-accent-red/5'
  const accent = bull ? 'text-accent-green' : 'text-accent-red'
  const riskPct = Math.abs((trade.entry - trade.stopLoss) / trade.entry) * 100
  const t1Pct = Math.abs((trade.target1 - trade.entry) / trade.entry) * 100
  const t2Pct = Math.abs((trade.target2 - trade.entry) / trade.entry) * 100

  return (
    <div className={clsx('rounded-lg border p-4', border)}>
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">🎯 Best Cycle Trade</div>
          <div className="text-xl font-bold mt-1">
            <span className={accent}>{trade.direction}</span>
            <span className="text-neutral-200"> {symbol}</span>
            <span className="text-neutral-500 text-sm ml-2">on {trade.cycle.cycleLabel}</span>
          </div>
          <div className="text-[11px] text-neutral-500 mt-0.5">
            Cycle {trade.cycle.pctComplete}% complete · {trade.cycle.daysRemaining}d remaining · anchored to {trade.cycle.seedKind === 'HIGH' ? '🔻' : '🔺'} {trade.cycle.seedName}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">Confidence</div>
          <div className={clsx('text-xl font-bold mt-1',
            confColor === 'green' ? 'text-accent-green' :
            confColor === 'amber' ? 'text-accent-amber' : 'text-neutral-400')}>
            {trade.confidence}
          </div>
          <div className="text-[10px] text-neutral-500">RR {trade.riskReward}:1 to T1</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
        <TradeBox label="Entry" sub={`Spot ₹${spot.toFixed(2)}`} value={`₹${trade.entry}`} colorCls="text-accent-cyan" />
        <TradeBox label="Stop Loss" sub={`-${riskPct.toFixed(1)}%`} value={`₹${trade.stopLoss}`} colorCls="text-accent-red" />
        <TradeBox label="Target 1" sub={`+${t1Pct.toFixed(1)}%`} value={`₹${trade.target1}`} colorCls="text-accent-green" />
        <TradeBox label="Target 2" sub={`+${t2Pct.toFixed(1)}%`} value={`₹${trade.target2}`} colorCls="text-accent-green" />
        <TradeBox label="Hold" sub={`Exit by ${trade.exitByDate}`} value={`${trade.holdDays}d`} colorCls="text-neutral-200" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3 text-[11px]">
        <div className="bg-ink-800 border border-ink-500 rounded p-2">
          <div className="text-[10px] uppercase text-neutral-500">Entry by date</div>
          <div className="font-mono text-accent-cyan font-semibold mt-0.5">{trade.entryByDate}</div>
        </div>
        <div className="bg-ink-800 border border-ink-500 rounded p-2">
          <div className="text-[10px] uppercase text-neutral-500">Exit by date</div>
          <div className="font-mono text-accent-amber font-semibold mt-0.5">{trade.exitByDate}</div>
        </div>
      </div>

      {/* OVERRIDE banner */}
      {trade.overridden && trade.cycleBias && (
        <div className="mb-3 p-2 rounded bg-accent-amber/10 border border-accent-amber/40 text-[11px]">
          <b className="text-accent-amber">⚠ Cycle override:</b>{' '}
          <span className="text-neutral-300">
            Cycle alone said <b>{trade.cycleBias}</b>, but harmonic + Elliott consensus flipped this to{' '}
            <b className={accent}>{trade.direction}</b>.
          </span>
        </div>
      )}

      {/* CONFLICTS banner (when present but not overridden) */}
      {trade.conflicts && trade.conflicts.length > 0 && !trade.overridden && (
        <div className="mb-3 p-2 rounded bg-accent-red/10 border border-accent-red/40 text-[11px]">
          <b className="text-accent-red">⚠ Conflicts detected:</b>
          <ul className="mt-1 space-y-0.5">
            {trade.conflicts.map((c, i) => <li key={i} className="text-neutral-300">• {c}</li>)}
          </ul>
        </div>
      )}

      <div className="text-[12px] text-neutral-300 leading-relaxed mb-2">
        <b>Rationale:</b> {trade.rationale}
      </div>

      {/* Harmonic + Elliott context cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-3">
        {trade.harmonic && (
          <div className={clsx('p-2 rounded border text-[11px]',
            trade.harmonic.direction === 'BULLISH' ? 'border-accent-green/30 bg-accent-green/5' : 'border-accent-red/30 bg-accent-red/5')}>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase text-neutral-500">Harmonic</span>
                <span className={clsx('ml-1 text-[10px] px-1 py-0.5 rounded',
                  trade.harmonic.direction === 'BULLISH' ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red')}>
                  {trade.harmonic.name} {trade.harmonic.direction}
                </span>
              </div>
              <span className="text-[10px] text-neutral-500">{trade.harmonic.confidence}% match · {trade.harmonic.ageBars}d old</span>
            </div>
            <div className="text-[10px] text-neutral-400 mt-1 font-mono">
              X ₹{trade.harmonic.X.price.toFixed(0)} → A ₹{trade.harmonic.A.price.toFixed(0)} → B ₹{trade.harmonic.B.price.toFixed(0)} → C ₹{trade.harmonic.C.price.toFixed(0)} → <b>D ₹{trade.harmonic.D.price.toFixed(0)}</b>
            </div>
            <div className="text-[10px] mt-1">
              Pattern targets: <span className="text-accent-green">T1 ₹{trade.harmonic.targets.t1.toFixed(0)}</span> · <span className="text-accent-green">T2 ₹{trade.harmonic.targets.t2.toFixed(0)}</span> · <span className="text-accent-red">SL ₹{trade.harmonic.targets.sl.toFixed(0)}</span>
            </div>
          </div>
        )}
        {trade.elliott && (
          <div className="p-2 rounded border border-accent-cyan/30 bg-accent-cyan/5 text-[11px]">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] uppercase text-neutral-500">Elliott context</span>
                <span className="ml-1 text-[10px] px-1 py-0.5 rounded bg-accent-cyan/15 text-accent-cyan">
                  {trade.elliott.phase.replace(/_/g, ' ')}
                </span>
              </div>
              <span className="text-[10px] text-neutral-500">conf {trade.elliott.confidence} · {trade.elliott.pivotsAnalysed} pivots</span>
            </div>
            <div className="mt-1 space-y-0.5">
              {trade.elliott.reasoning.map((r, i) => (
                <div key={i} className="text-[10px] text-neutral-400">• {r}</div>
              ))}
            </div>
            <div className="text-[10px] mt-1">
              Bottoming: <b className={trade.elliott.bottomingComplete ? 'text-accent-green' : 'text-neutral-500'}>{trade.elliott.bottomingComplete ? 'YES' : 'NOT yet'}</b>
              {' · '}
              Topping: <b className={trade.elliott.toppingComplete ? 'text-accent-red' : 'text-neutral-500'}>{trade.elliott.toppingComplete ? 'YES' : 'NOT yet'}</b>
            </div>
          </div>
        )}
      </div>

      {trade.confidenceNotes.length > 0 && (
        <div className="text-[11px] text-neutral-400 space-y-0.5 mt-2">
          {trade.confidenceNotes.map((n, i) => <div key={i}>• {n}</div>)}
        </div>
      )}
    </div>
  )
}

function TradeBox({ label, sub, value, colorCls }: { label: string; sub: string; value: string; colorCls: string }) {
  return (
    <div className="bg-ink-800 border border-ink-500 rounded p-2">
      <div className="text-[10px] uppercase text-neutral-500">{label}</div>
      <div className={clsx('font-mono text-lg font-semibold mt-0.5', colorCls)}>{value}</div>
      <div className="text-[10px] text-neutral-600">{sub}</div>
    </div>
  )
}

function NextReversalCard({ rev }: { rev: ReversalDate | null }) {
  if (!rev) {
    return (
      <div className="bg-ink-700 border border-ink-500 rounded-lg p-4">
        <div className="text-[10px] uppercase text-neutral-500 tracking-wider">Next Major Reversal</div>
        <div className="text-sm text-neutral-500 mt-3">No high-importance reversal in next 30 days.</div>
      </div>
    )
  }
  return (
    <div className="bg-accent-red/5 border border-accent-red/40 rounded-lg p-4">
      <div className="text-[10px] uppercase text-accent-red tracking-wider">⚠ Next Major Reversal</div>
      <div className="text-2xl font-bold text-accent-red mt-2">{rev.date}</div>
      <div className="text-xs text-neutral-300 mt-1">in <b>{rev.daysAway} days</b> · {rev.cycleLabel} from {rev.seedName}</div>
      <div className="text-[10px] text-neutral-500 mt-2">Reduce size around this date. High-conviction trades only.</div>
    </div>
  )
}

function DegreeStatusCard({ d }: { d: GannCycleStatus['degreeStatus'] }) {
  return (
    <div className={clsx('rounded-lg p-4 border',
      d.isSquared ? 'bg-accent-amber/5 border-accent-amber/40' : 'bg-ink-700 border-ink-500')}>
      <div className={clsx('text-[10px] uppercase tracking-wider', d.isSquared ? 'text-accent-amber' : 'text-neutral-500')}>
        Degree (price-time square)
      </div>
      <div className={clsx('text-lg font-bold mt-2', d.isSquared ? 'text-accent-amber' : 'text-neutral-200')}>
        {d.isSquared ? '🎯 SQUARED' : 'Not yet squared'}
      </div>
      <div className="text-[11px] text-neutral-400 mt-1">{d.note}</div>
      <div className="text-[10px] text-neutral-500 mt-2 font-mono">
        Days from seed: <b>{d.daysFromSeed}</b> · √(seed price): <b>{d.sqrtSeedPrice}</b> · next harmonic at day <b>{d.expectedTimeSquare}</b>
      </div>
    </div>
  )
}

function BucketColumn({ label, cycles, accent }: { label: string; bucket: string; cycles: ActiveCycle[]; accent: 'cyan' | 'violet' | 'amber' }) {
  const headerCls = accent === 'cyan' ? 'border-accent-cyan/30 bg-accent-cyan/5 text-accent-cyan'
    : accent === 'violet' ? 'border-accent-violet/30 bg-accent-violet/5 text-accent-violet'
    : 'border-accent-amber/30 bg-accent-amber/5 text-accent-amber'
  return (
    <div>
      <div className={clsx('px-3 py-2 rounded-t-lg border border-b-0 font-bold text-xs', headerCls)}>{label}</div>
      <div className={clsx('border rounded-b-lg p-2 space-y-2 min-h-[200px]', headerCls.split(' ')[0])}>
        {cycles.length === 0 ? <div className="py-12 text-center text-[11px] text-neutral-600">No active cycles</div> :
          cycles.slice(0, 8).map((cy, i) => (
            <div key={i} className="bg-ink-700 border border-ink-500 rounded p-2 text-[11px]">
              <div className="flex items-center justify-between">
                <div className="font-mono font-bold text-neutral-200">{cy.cycleLabel}</div>
                <div className={clsx('text-[9px] px-1.5 py-0.5 rounded',
                  cy.importance === 'HIGH' ? 'bg-accent-red/15 text-accent-red' :
                  cy.importance === 'MED'  ? 'bg-accent-amber/15 text-accent-amber' :
                                              'bg-ink-500 text-neutral-500')}>{cy.importance}</div>
              </div>
              <div className="text-neutral-500 text-[10px] mt-0.5">
                from {cy.seedKind === 'HIGH' ? '🔻' : '🔺'} {cy.seedName}
              </div>
              <div className="mt-1.5 h-1.5 bg-ink-500 rounded overflow-hidden">
                <div className={clsx('h-full',
                  cy.pctComplete > 85 ? 'bg-accent-red' :
                  cy.pctComplete > 60 ? 'bg-accent-amber' :
                                         'bg-accent-cyan')}
                  style={{ width: `${cy.pctComplete}%` }} />
              </div>
              <div className="flex justify-between mt-1 text-[10px] font-mono text-neutral-500">
                <span>{cy.pctComplete}% done</span>
                <span>ends {cy.cycleEnd} · {cy.daysRemaining}d left</span>
              </div>
            </div>
          ))}
      </div>
    </div>
  )
}
