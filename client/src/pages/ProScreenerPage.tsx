import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { byScreenerQuality } from '../components/convictionTier'

interface ProRow {
  symbol: string
  price: number
  change: number
  changePct: number
  score: number               // 0-10 (storage)
  convictionScore?: number    // 0-100 (true conviction from screener.md)
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
  category?: 'INTRADAY' | 'SHORT_SWING' | 'SWING' | 'POSITIONAL'
  queryId?: string
}

interface RegimeChecklist { name: string; ok: boolean; note: string }
interface Regime {
  regime: 'BULL' | 'MIXED' | 'BEAR'
  greenCount: number
  checklist: RegimeChecklist[]
  niftyAbove200ema: boolean
  niftyAbove50ema: boolean
  vix: number | null
  asOf: string
  recommendation: string
}

const CATEGORIES: { key: ProRow['category']; label: string; emoji: string; subtitle: string }[] = [
  { key: 'INTRADAY',    label: 'Intraday',     emoji: '⚡', subtitle: 'Same-session 5–12% moves · Q-A volume surge · Q-C catalyst' },
  { key: 'SHORT_SWING', label: 'Short Swing',  emoji: '🎯', subtitle: '1–3 day 8–15% moves · Q-D bull-flag breakout' },
  { key: 'SWING',       label: 'Swing',        emoji: '📈', subtitle: '5–10 day 12–20% moves · Q-G VCP · Q-I multi-month base' },
  { key: 'POSITIONAL',  label: 'Positional',   emoji: '🚀', subtitle: '15–20 day 10–20% moves · Q-M early momentum cross' },
]

export function ProScreenerPage() {
  const qc = useQueryClient()
  const [activeCat, setActiveCat] = useState<ProRow['category']>('SWING')
  const [refreshing, setRefreshing] = useState(false)

  const proQuery = useQuery({
    queryKey: ['screener', '/api/scan/pro'],
    queryFn: async () => {
      const res = await fetch('/api/scan/pro')
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json() as Promise<{ results: ProRow[]; finishedAt: number; totalScanned: number }>
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const regimeQuery = useQuery({
    queryKey: ['regime'],
    queryFn: async () => {
      const res = await fetch('/api/regime')
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json() as Promise<Regime>
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  const rows: ProRow[] = proQuery.data?.results ?? []
  const regime = regimeQuery.data

  // Fallback — when strict 12-query spec returns 0, surface Daily Pick rows
  // so the user always sees PRE-move ideas (Daily Pick uses hybrid scoring
  // including the learned-rebound centroid which catches what the strict
  // momentum spec misses).
  const dailyPick = useQuery<any>({
    queryKey: ['daily-pick'],
    queryFn: async () => {
      const r = await fetch('/api/daily-pick')
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json()
    },
    staleTime: 60_000, refetchInterval: 60_000,
    enabled: rows.length === 0,
  })

  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const c of CATEGORIES) out[c.key as string] = rows.filter(r => r.category === c.key).length
    return out
  }, [rows])

  // Sort ⭐⭐⭐⭐⭐ first, then ⭐⭐⭐, then ⭐⭐; break ties by convictionScore desc.
  const filtered = rows
    .filter(r => r.category === activeCat)
    .slice()
    .sort((a, b) => {
      const s = byScreenerQuality(a, b)
      if (s !== 0) return s
      return (b.convictionScore ?? 0) - (a.convictionScore ?? 0)
    })
  const tier1 = filtered.filter(r => r.tier === 'A')
  const tier2 = filtered.filter(r => r.tier === 'B')
  const tier3 = filtered.filter(r => r.tier === 'C')

  const refresh = async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/scan/pro/refresh?limit=400', { method: 'POST' })
      if (res.ok) {
        const fresh = await res.json()
        qc.setQueryData(['screener', '/api/scan/pro'], fresh)
      }
      const reg = await fetch('/api/regime')
      if (reg.ok) qc.setQueryData(['regime'], await reg.json())
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">🧠</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-neutral-200">Pro Screener — pre-move stock picker</div>
          <div className="text-xs text-neutral-500 mt-1">
            12-query system from <span className="text-accent-cyan">screener.md</span> with 100-point conviction scoring.
            Identifies setups 15–20 days <b>before</b> a 10–20% move, not after. Re-scans the curated CNX 500 (override
            with NSE_ALL on refresh). Tier 1 = ≥80 (full size) · Tier 2 = 65–79 (60-70% size) · Tier 3 = 50–64 (watchlist).
          </div>
        </div>
        <button onClick={refresh} disabled={refreshing}
          className="text-xs px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50 whitespace-nowrap">
          {refreshing ? 'Scanning…' : 'Re-scan + regime'}
        </button>
      </div>

      {/* Market Regime */}
      <RegimeBanner regime={regime} />

      {/* Category sub-tabs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {CATEGORIES.map(c => (
          <button key={c.key} onClick={() => setActiveCat(c.key)}
            className={clsx(
              'text-left px-3 py-2 rounded-lg border transition-all',
              activeCat === c.key
                ? 'border-accent-cyan/50 bg-accent-cyan/10'
                : 'border-ink-500 bg-ink-700 hover:border-ink-400',
            )}>
            <div className="text-xs font-semibold text-neutral-200">
              {c.emoji} {c.label}
              <span className={clsx(
                'ml-2 px-1.5 py-0.5 rounded text-[10px]',
                activeCat === c.key ? 'bg-accent-cyan/20 text-accent-cyan' : 'bg-ink-500 text-neutral-500',
              )}>{counts[c.key as string] ?? 0}</span>
            </div>
            <div className="text-[10px] text-neutral-500 mt-0.5 leading-tight">{c.subtitle}</div>
          </button>
        ))}
      </div>

      {/* Tier sections */}
      {proQuery.isLoading && (
        <div className="bg-ink-700 border border-ink-500 rounded-lg p-8 text-center text-xs text-neutral-500">Loading screener…</div>
      )}
      {filtered.length === 0 && !proQuery.isLoading && (
        <div className="space-y-3">
          <div className="bg-accent-amber/5 border border-accent-amber/40 rounded-lg p-4 text-xs text-neutral-300">
            <div className="font-semibold text-accent-amber mb-1">Strict 12-query spec returned 0 for {activeCat}.</div>
            <div className="text-neutral-400">
              In MIXED/BEAR regime the screener.md filters reject most names. Showing <b>Daily Pick</b> rows below — same
              "10–20% in 5–15 sessions" thesis but using the <b>hybrid scorer</b> (momentum + learned-rebound centroid)
              that catches oversold setups the strict spec misses.
            </div>
          </div>
          {dailyPick.data?.rows?.length > 0 && (
            <div className="overflow-auto rounded-lg border border-ink-500" style={{ maxHeight: '75vh' }}>
              <table className="w-full text-[11px] bg-ink-800">
                <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
                  <tr>
                    <th className="text-left px-3 py-2">Symbol</th>
                    <th className="text-center px-3 py-2">Dir</th>
                    <th className="text-center px-3 py-2">Pattern</th>
                    <th className="text-center px-3 py-2">Conv</th>
                    <th className="text-right px-3 py-2">LTP</th>
                    <th className="text-right px-3 py-2 text-accent-cyan">Entry</th>
                    <th className="text-right px-3 py-2 text-accent-red">SL</th>
                    <th className="text-right px-3 py-2 text-accent-green">T1 (10%)</th>
                    <th className="text-right px-3 py-2 text-accent-green">T2 (20%)</th>
                    <th className="text-center px-3 py-2">RR</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyPick.data.rows.slice(0, 20).map((r: any) => (
                    <tr key={r.symbol} className="border-t border-ink-500 hover:bg-ink-700 font-mono">
                      <td className="px-3 py-2 font-semibold text-neutral-200">{r.symbol}</td>
                      <td className="px-3 py-2 text-center">
                        <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold',
                          r.direction === 'BUY' ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red')}>
                          {r.direction}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center text-[10px] text-neutral-500">{r.pattern}</td>
                      <td className="px-3 py-2 text-center font-bold text-accent-cyan">{r.conviction}</td>
                      <td className="px-3 py-2 text-right">₹{r.ltp}</td>
                      <td className="px-3 py-2 text-right text-accent-cyan">₹{r.entryPrice}</td>
                      <td className="px-3 py-2 text-right text-accent-red">₹{r.stopLoss}</td>
                      <td className="px-3 py-2 text-right text-accent-green">₹{r.target1}</td>
                      <td className="px-3 py-2 text-right text-accent-green">₹{r.target2}</td>
                      <td className="px-3 py-2 text-center">{r.riskReward}:1</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-[10px] text-neutral-600 px-3 py-2 border-t border-ink-500 bg-ink-700/50">
                Source: Daily Pick · auto-refreshed every 30 min during market hours · <a href="/picks/daily" className="text-accent-cyan hover:underline">View full Daily Pick →</a>
              </div>
            </div>
          )}
        </div>
      )}

      <TierSection title="🏆 TIER 1 — High Conviction (≥80)" rows={tier1} accent="green" sizing="Full size" />
      <TierSection title="✅ TIER 2 — Good Setup (65-79)"   rows={tier2} accent="cyan"  sizing="60-70% size" />
      <TierSection title="👀 TIER 3 — Watchlist (50-64)"     rows={tier3} accent="amber" sizing="Wait for trigger · no entry yet" />

      {/* Footer note about partial coverage */}
      <div className="text-[11px] text-neutral-600 p-3 bg-ink-800 rounded leading-relaxed">
        <b className="text-neutral-400">Coverage status:</b> Queries A, C, D, G, I, M run on technical data alone (volume, price, RSI, EMA, 52W range).
        Queries B (intraday ORB), E (earnings beat), H (FII/DII accumulation), J (fundamental turnaround), K (CANSLIM), L (sector cycle) need
        Screener.in fundamentals or BSE delivery feeds — not wired yet, so the conviction score caps at <b>~75/100</b> instead of 100. Adding the
        fundamental pipeline is a separate task.
      </div>
    </div>
  )
}

// ─── Regime banner ─────────────────────────────────────────────

function RegimeBanner({ regime }: { regime: Regime | undefined }) {
  if (!regime) return null
  const color = regime.regime === 'BULL' ? 'green' : regime.regime === 'MIXED' ? 'amber' : 'red'
  const cls = color === 'green'
    ? 'border-accent-green/40 bg-accent-green/5'
    : color === 'amber'
      ? 'border-accent-amber/40 bg-accent-amber/5'
      : 'border-accent-red/40 bg-accent-red/5'
  const textCls = color === 'green' ? 'text-accent-green' : color === 'amber' ? 'text-accent-amber' : 'text-accent-red'

  return (
    <div className={clsx('p-3 border rounded-lg', cls)}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={clsx('text-base font-bold', textCls)}>{regime.regime} REGIME</span>
          <span className="text-[10px] text-neutral-500">·  {regime.greenCount}/{regime.checklist.length} green</span>
          {regime.vix != null && (
            <span className="text-[10px] text-neutral-500">·  VIX {regime.vix.toFixed(2)}</span>
          )}
        </div>
        <span className={clsx('text-[11px] font-semibold', textCls)}>{regime.recommendation}</span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
        {regime.checklist.map(c => (
          <div key={c.name} className={clsx(
            'text-[10px] px-2 py-1 rounded border',
            c.ok ? 'border-accent-green/30 bg-accent-green/5 text-accent-green' : 'border-accent-red/30 bg-accent-red/5 text-accent-red',
          )}>
            <div className="font-semibold">{c.ok ? '✓' : '✗'} {c.name}</div>
            <div className="text-neutral-400 mt-0.5">{c.note}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Tier sections + cards ─────────────────────────────────────

function TierSection({ title, rows, accent, sizing }: { title: string; rows: ProRow[]; accent: 'green'|'cyan'|'amber'; sizing: string }) {
  if (rows.length === 0) return null
  const headerCls = accent === 'green'
    ? 'border-accent-green/30 bg-accent-green/5 text-accent-green'
    : accent === 'cyan'
      ? 'border-accent-cyan/30 bg-accent-cyan/5 text-accent-cyan'
      : 'border-accent-amber/30 bg-accent-amber/5 text-accent-amber'
  return (
    <div>
      <div className={clsx('flex items-center justify-between px-3.5 py-2 rounded-t-lg border border-b-0', headerCls)}>
        <div className="font-bold text-sm tracking-wide">{title}</div>
        <div className="text-[11px]">{rows.length} setup{rows.length !== 1 ? 's' : ''} · {sizing}</div>
      </div>
      <div className={clsx('border rounded-b-lg p-3 space-y-2', headerCls.replace(/text-\w+-\w+/, '').replace(/bg-\S+/, ''))}>
        {rows.map(r => <ProCard key={r.symbol + (r.queryId ?? '')} row={r} />)}
      </div>
    </div>
  )
}

function ProCard({ row }: { row: ProRow }) {
  const [open, setOpen] = useState(false)
  const dirColor = row.direction === 'BULL' ? '#00c853' : '#ff1744'
  const tierColor = row.tier === 'A' ? '#00c853' : row.tier === 'B' ? '#00bcd4' : '#ff9800'
  const conv = row.convictionScore ?? Math.round(row.score * 10)
  const planLine = row.reasons.find(r => r.startsWith('Plan:'))
  const setupLine = row.reasons.find(r => r.startsWith('🎯'))

  return (
    <div className="bg-ink-700 border border-ink-500 rounded-lg p-3 hover:border-ink-400 transition-colors cursor-pointer"
      onClick={() => setOpen(o => !o)}
      style={{ borderLeft: `3px solid ${tierColor}` }}>
      <div className="flex justify-between items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold text-neutral-200">{row.symbol}</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold"
              style={{ background: `${dirColor}22`, color: dirColor }}>{row.direction}</span>
            {row.queryId && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-accent-violet/15 text-accent-violet border border-accent-violet/30">
                Q-{row.queryId}
              </span>
            )}
            {row.timeframeLabel && (
              <span className="text-[10px] text-neutral-500">{row.timeframeLabel}</span>
            )}
          </div>
          <div className="flex gap-3 text-xs mt-1 flex-wrap">
            <span className="text-neutral-200">₹{row.price?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
            <span className={row.change >= 0 ? 'text-accent-green' : 'text-accent-red'}>
              {row.change >= 0 ? '+' : ''}{row.change?.toFixed(2)} ({row.changePct >= 0 ? '+' : ''}{row.changePct?.toFixed(2)}%)
            </span>
            {row.expectedMovePct != null && (
              <span className="text-neutral-500">→ Target <b className="text-accent-green">+{row.expectedMovePct.toFixed(1)}%</b></span>
            )}
          </div>
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            {row.tags.map((t, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-ink-500 text-neutral-400">{t}</span>
            ))}
          </div>
          {setupLine && <div className="text-[11px] text-neutral-300 mt-1.5">{setupLine}</div>}
        </div>
        <div className="text-right flex flex-col items-end">
          <div className="w-12 h-12 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: `${tierColor}22`, border: `2px solid ${tierColor}`, color: tierColor }}>
            {conv}
          </div>
          <div className="text-[10px] text-neutral-600 mt-1">/100</div>
          <div className="text-[10px] text-neutral-600">Tier {row.tier === 'A' ? '1' : row.tier === 'B' ? '2' : '3'}</div>
        </div>
      </div>
      {open && (
        <div className="mt-3 pt-3 border-t border-ink-500 space-y-2">
          {planLine && (
            <div className="text-[11px] font-mono bg-ink-800 p-2 rounded text-neutral-300">{planLine}</div>
          )}
          {row.suggestedEntry && row.suggestedSL && row.suggestedTarget && (
            <>
              <div className="grid grid-cols-3 gap-2 text-[11px]">
                <PlanBox
                  label="Entry"
                  value={row.entryPriceLow != null && row.entryPriceHigh != null
                    ? `₹${row.entryPriceLow}–${row.entryPriceHigh}`
                    : `₹${row.suggestedEntry}`}
                  color="text-accent-cyan"
                />
                <PlanBox label="Stop Loss" value={`₹${row.suggestedSL}`} color="text-accent-red" />
                <PlanBox
                  label="Target 1"
                  value={`₹${row.target1 ?? row.suggestedTarget}${row.target1Date ? ` · ${row.target1Date.slice(5)}` : ''}`}
                  color="text-accent-green"
                />
              </div>
              {(row.target2 != null || row.target3 != null) && (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  {row.target2 != null && (
                    <PlanBox label="Target 2" value={`₹${row.target2}${row.target2Date ? ` · ${row.target2Date.slice(5)}` : ''}`} color="text-accent-green" />
                  )}
                  {row.target3 != null && (
                    <PlanBox label="Target 3" value={`₹${row.target3}${row.target3Date ? ` · ${row.target3Date.slice(5)}` : ''}`} color="text-accent-green" />
                  )}
                  {(row.bestEntryTimeIST || row.entryDate) && (
                    <PlanBox
                      label="Best entry time"
                      value={`${row.entryDate ? row.entryDate.slice(5) + ' ' : ''}${row.bestEntryTimeIST ?? ''} IST${row.horaLord ? ` · ${row.horaLord}` : ''}`}
                      color="text-accent-cyan"
                    />
                  )}
                </div>
              )}
              {row.entryNote && (
                <div className="text-[11px] text-neutral-400 italic">{row.entryNote}</div>
              )}
            </>
          )}
          <div>
            <div className="text-[10px] text-neutral-600 uppercase tracking-wider mb-1">Conviction breakdown</div>
            {row.reasons.filter(r => !r.startsWith('🎯') && !r.startsWith('Plan:')).map((r, i) => (
              <div key={i} className="text-xs text-neutral-400 pl-2 border-l-2 border-ink-400">{r}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PlanBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-ink-800 px-2 py-1.5 rounded">
      <div className="text-[9px] text-neutral-600 uppercase">{label}</div>
      <div className={clsx('font-mono font-semibold', color)}>{value}</div>
    </div>
  )
}
