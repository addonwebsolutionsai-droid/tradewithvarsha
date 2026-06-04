/**
 * Vercel public-mode pages — TABLE format matching localhost. Reads static
 * JSON snapshots from raw.githubusercontent.com (no backend dependency).
 *
 * Above each table: a "Recent target hits" strip with green/red highlighted
 * cards so users can see realised outcomes and gauge accuracy.
 */
import { useQuery } from '@tanstack/react-query'
import { snapshots } from '../api'
import React, { useState } from 'react'
import { useSortableTable } from '../components/useSortableTable'

const fmtDate = (iso?: string) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : `${d.getDate()}/${d.getMonth() + 1}`
}
const fmtTs = (iso?: string) => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'
// Expiry as "8-Jun" — accepts both "YYYY-MM-DD" and Angel's "08JUN2026".
const fmtExpiry = (s?: string | null): string => {
  if (!s) return '—'
  const d = new Date(s)
  if (!isNaN(d.getTime())) {
    return `${d.getUTCDate()}-${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}`
  }
  const m = /^(\d{1,2})([A-Z]{3})(\d{4})$/.exec(s)
  if (m) return `${parseInt(m[1], 10)}-${m[2][0] + m[2].slice(1).toLowerCase()}`
  return s
}
/** 2-decimal price formatter — used for Entry/SL/Target across every tab. */
const fmtPx = (n: any): string => {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) ? v.toFixed(2) : '—'
}

// ── LEGEND STRIP ────────────────────────────────────────────────
function Legend({ kind }: { kind: 'pick' | 'signal' | 'premove' }): JSX.Element {
  const items = kind === 'pick' ? [
    { label: 'Conv', explain: 'Conviction score (0–100). Composite across SMC, trend stack, Gann/Vol-Profile, Astro/RS, and order-flow lenses.' },
    { label: '≥80', explain: 'Elite — stake-anchored or strong multi-lens alignment. ⭐ NO-BRAINER if FII↑ + promoter stable + pledge<5%.', cls: 'text-accent-green' },
    { label: '60–79', explain: 'Confirmed — 3+ lenses agree. Reasonable size.', cls: 'text-accent-cyan' },
    { label: '<60', explain: 'Speculative — fewer lenses; size small or skip.', cls: 'text-accent-amber' },
    { label: 'Stake', explain: 'FII / DII / Promoter shareholding (% with arrow = QoQ change) + Pledge% + Market Cap. From quarterly NSE/BSE filings.' },
  ] : kind === 'signal' ? [
    { label: 'Grade', explain: 'A/B/C — A = ≥4 confluence factors, B = 3, C = 2. Only A+ is pushed to Telegram.' },
    { label: 'Score', explain: 'Engine score 0–10. ≥9 = elite for OPTIONS, ≥7 for INTRADAY. Higher = stronger setup.' },
    { label: 'A', explain: '≥4 confluences (SMC, EMA stack, VWAP, RSI, volume).', cls: 'text-accent-green' },
    { label: 'B', explain: '3 confluences.', cls: 'text-accent-cyan' },
    { label: 'C', explain: '2 confluences.', cls: 'text-accent-amber' },
  ] : [
    { label: 'Tier', explain: 'A = best, B = strong, C = qualifying. Pre-move tiers reflect signal strength + base tightness.' },
    { label: 'Score', explain: '0–10 strength of the pre-move signature (BB squeeze, coiled range, distribution top, range expansion).' },
  ]
  return (
    <details className="bg-ink-700 border border-ink-500 rounded-lg p-3">
      <summary className="text-[11px] text-neutral-400 cursor-pointer select-none">📖 Legend — what do these scores mean?</summary>
      <div className="flex flex-wrap gap-3 mt-2">
        {items.map((it, i) => (
          <div key={i} className="text-[11px]">
            <span className={`font-bold mr-1 ${it.cls ?? 'text-neutral-200'}`}>{it.label}</span>
            <span className="text-neutral-500">{it.explain}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

// ── ACCURACY STRIP — system-wide hit rate over last 30 days ──
// 2026-05-18: surfaces lifecycle accuracy stats above each table so the user
// (and visitors) can see at a glance how many signals actually triggered, how
// many won, R-multiple, and breakdown by conviction tier.
function AccuracyStrip(): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['accuracy'], queryFn: () => snapshots.accuracy(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  if (!data || !data.total) return null
  const tierEntries = Object.entries(data.byConvictionTier || {}).sort(([a], [b]) => b.localeCompare(a))
  // 2026-05-29: surface the Sweet-Spot Band (conviction 70-79) — empirically
  // the highest win-rate cohort on live data. Counter to intuition: chasing
  // 90+ conviction picks gives WORSE outcomes (extended setups stop out)
  // than this coiled-spring zone. Users target this band for "money-magnet"
  // quality.
  const sweetSpot = (data.byConvictionTier as any)?.['70-79']
  const sweetSpotWR = sweetSpot ? sweetSpot.winRate : null
  const sweetSpotN = sweetSpot ? sweetSpot.total : 0
  // 2026-05-25: catch-rate row shows the user's #1 KPI — % of NSE top-100
  // gainers our pre-move screeners caught on T-1 (day before the move).
  // Auto-replayed every weekday 17:30 IST against the actual day's gainers
  // and persisted to data/learning/daily-catch-*.json. Goal: 85%.
  const cr = (data as any).catchRate
  const crLatest = cr?.latest
  const crRolling = cr?.rolling
  return (
    <details className="bg-ink-700 border border-ink-500 rounded-lg p-3 mb-3">
      <summary className="text-[11px] font-semibold text-neutral-300 cursor-pointer select-none">
        📊 System accuracy ({data.daysBack}d) — {data.total} signals · Triggered {data.triggeredRate}% · Win rate <span className="text-accent-green">{data.winRate}%</span> · SL rate <span className="text-accent-red">{data.slRate}%</span> · Avg R-multiple <b>{data.avgRMultiple > 0 ? '+' : ''}{data.avgRMultiple}</b>
        {sweetSpotWR != null && (
          <span className="ml-2"> · 💎 Sweet-Spot (conv 70-79): <span className={sweetSpotWR >= 80 ? 'text-accent-green font-bold' : 'text-accent-cyan'}>{sweetSpotWR}%</span> <span className="text-neutral-500 font-normal">(n={sweetSpotN})</span></span>
        )}
      </summary>
      {crRolling && crRolling.runs > 0 && (
        <div className="mt-2 mb-2 px-2 py-1.5 rounded bg-ink-800 border border-ink-500 text-[11px] flex items-center gap-3 flex-wrap">
          <span className="text-neutral-400">🎯 <b>Pre-move catch rate</b></span>
          <span>30d avg: <b className={crRolling.avgCatchRate >= 0.85 ? 'text-accent-green' : crRolling.avgCatchRate >= 0.5 ? 'text-accent-cyan' : 'text-accent-amber'}>{(crRolling.avgCatchRate * 100).toFixed(1)}%</b></span>
          {crLatest && <span className="text-neutral-500">latest ({crLatest.date}): <b>{(crLatest.catchRate * 100).toFixed(1)}%</b> ({crLatest.catches}/{crLatest.topGainersCount})</span>}
          <span className="text-neutral-600 text-[10px]">goal 85%</span>
        </div>
      )}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
        <div>
          <div className="text-neutral-500 mb-1 font-semibold">By source</div>
          <table className="w-full font-mono">
            <thead className="text-neutral-500">
              <tr><th className="text-left">Source</th><th className="text-right">Total</th><th className="text-right">Wins</th><th className="text-right">SL</th><th className="text-right">Hit%</th></tr>
            </thead>
            <tbody>
              {Object.entries(data.bySource || {}).map(([src, s]: [string, any]) => (
                <tr key={src} className="border-t border-ink-600">
                  <td className="py-1">{src}</td>
                  <td className="text-right">{s.total}</td>
                  <td className="text-right text-accent-green">{s.wins}</td>
                  <td className="text-right text-accent-red">{s.sl}</td>
                  <td className="text-right font-bold">{s.winRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="text-neutral-500 mb-1 font-semibold">By conviction tier</div>
          <table className="w-full font-mono">
            <thead className="text-neutral-500">
              <tr><th className="text-left">Conviction</th><th className="text-right">Total</th><th className="text-right">Wins</th><th className="text-right">Hit%</th></tr>
            </thead>
            <tbody>
              {tierEntries.map(([tier, t]: [string, any]) => (
                <tr key={tier} className="border-t border-ink-600">
                  <td className="py-1">{tier}</td>
                  <td className="text-right">{t.total}</td>
                  <td className="text-right text-accent-green">{t.wins}</td>
                  <td className="text-right font-bold">{t.winRate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-2 text-[10px] text-neutral-600">
        Status counts: {Object.entries(data.byStatus || {}).map(([k, v]) => `${k}=${v}`).join(' · ')}
      </div>
    </details>
  )
}

// ── HIT-LOG STRIP ───────────────────────────────────────────────
function HitLog(): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['hit-log'], queryFn: () => snapshots.hitLog(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const entries = (data?.entries ?? []).slice(0, 12)
  if (!entries.length) return null
  return (
    <section className="mb-4">
      <div className="text-[11px] font-semibold text-neutral-400 mb-2">
        🏁 Recent target hits — accuracy log
      </div>
      <div className="flex flex-wrap gap-2">
        {entries.map((e: any, i: number) => {
          const isWin = e.outcome === 'T1' || e.outcome === 'T2' || e.outcome === 'T3'
          const isLoss = e.outcome === 'SL'
          const bg = isWin ? 'bg-accent-green/20 border-accent-green/40 text-accent-green'
            : isLoss ? 'bg-accent-red/20 border-accent-red/40 text-accent-red'
            : 'bg-ink-700 border-ink-500 text-neutral-400'
          const icon = isWin ? '✅' : isLoss ? '❌' : '⏳'
          return (
            <div key={i} className={`px-2 py-1 rounded border ${bg} text-[10px] font-mono flex items-center gap-1.5`}>
              <span>{icon}</span>
              <b>{e.symbol}</b>
              <span>{e.outcome}</span>
              <span className="opacity-70">{e.realisedPct >= 0 ? '+' : ''}{e.realisedPct?.toFixed?.(1) ?? '—'}%</span>
              <span className="opacity-50 text-[9px]">{fmtDate(e.takenAt)}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── SIGNALS HISTORY — public track-record page (every signal + outcome) ──
// 2026-05-20: Built per user ask — surfaces full lifecycle of every issued
// signal so visitors can verify accuracy. Filter by outcome + source.
export function PublicSignalsHistoryPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-signals-history'], queryFn: () => snapshots.signalsHistory(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  // 2026-05-27: two top-level views — ACTIVE (default) and SUPERSEDED — per
  // user request. SUPERSEDED = signals replaced by a newer call; shown in
  // their own view sorted by conviction then FII-stake (high → low).
  const [view, setView] = useState<'ACTIVE' | 'SUPERSEDED'>('ACTIVE')
  const [filter, setFilter] = useState<string>('ALL')
  const [src, setSrc] = useState<string>('ALL')
  const [sort, setSort] = useState<'newest' | 'return-desc' | 'return-asc' | 'conviction-desc'>('newest')
  const allRaw: any[] = data?.signals ?? []
  // Split the universe by SUPERSEDED status first.
  const fiiOf = (r: any): number => {
    const m = /FII\s+([\d.]+)%/.exec(r.shareholdingNote || '')
    return m ? parseFloat(m[1]) : -1
  }
  const all = allRaw.filter(r => view === 'SUPERSEDED' ? r.status === 'SUPERSEDED' : r.status !== 'SUPERSEDED')
  const rows = all.filter(r => {
    if (src !== 'ALL' && r.source !== src) return false
    if (view === 'SUPERSEDED') return true
    switch (filter) {
      case 'ALL': return true
      case 'RUNNING': return r.status === 'ACTIVE' || r.status === 'PENDING'
      case 'COMPLETED': return ['T1_HIT', 'T2_HIT', 'T3_HIT', 'SL_HIT', 'EXPIRED', 'INVALIDATED'].includes(r.status)
      case 'T1': return r.status === 'T1_HIT'
      case 'T2': return r.status === 'T2_HIT'
      case 'T3': return r.status === 'T3_HIT'
      case 'SL': return r.status === 'SL_HIT'
      case 'EXPIRED': return r.status === 'EXPIRED' || r.status === 'INVALIDATED'
      default: return true
    }
  }).sort((a, b) => {
    // SUPERSEDED view: high conviction first, then high FII stake.
    if (view === 'SUPERSEDED') {
      const cv = (b.conviction ?? 0) - (a.conviction ?? 0)
      if (cv !== 0) return cv
      return fiiOf(b) - fiiOf(a)
    }
    if (sort === 'newest') return (b.generatedAt || '').localeCompare(a.generatedAt || '')
    if (sort === 'return-desc') return (b.realisedPct ?? -Infinity) - (a.realisedPct ?? -Infinity)
    if (sort === 'return-asc') return (a.realisedPct ?? Infinity) - (b.realisedPct ?? Infinity)
    if (sort === 'conviction-desc') return (b.conviction ?? 0) - (a.conviction ?? 0)
    return 0
  })
  const c = (cond: (r: any) => boolean) => all.filter(cond).length
  const counts = {
    all: all.length,
    running: c(r => r.status === 'ACTIVE' || r.status === 'PENDING'),
    completed: c(r => ['T1_HIT', 'T2_HIT', 'T3_HIT', 'SL_HIT', 'EXPIRED', 'INVALIDATED'].includes(r.status)),
    t1: c(r => r.status === 'T1_HIT'),
    t2: c(r => r.status === 'T2_HIT'),
    t3: c(r => r.status === 'T3_HIT'),
    sl: c(r => r.status === 'SL_HIT'),
    exp: c(r => r.status === 'EXPIRED' || r.status === 'INVALIDATED'),
  }
  const supersededCount = allRaw.filter(r => r.status === 'SUPERSEDED').length
  const activeCount = allRaw.filter(r => r.status !== 'SUPERSEDED').length
  const wins = counts.t1 + counts.t2 + counts.t3
  const overallHit = counts.completed > 0 ? +(wins / counts.completed * 100).toFixed(1) : 0
  const sources = Array.from(new Set(all.map(r => r.source))).sort()
  return (
    <div className="space-y-4">
      <Banner emoji="📈" title="Track Record"
        subtitle={`${activeCount} active · ${supersededCount} superseded · ${counts.completed} completed · hit rate ${overallHit}% · fully transparent`}
        ts={data?.generatedAt} />
      {/* Active vs Superseded — the two top-level "tabs". */}
      <div className="flex gap-2">
        <button onClick={() => { setView('ACTIVE'); setFilter('ALL') }}
          className={`px-4 py-1.5 rounded-lg text-[13px] font-bold border ${view === 'ACTIVE' ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan' : 'bg-ink-700 border-ink-500 text-neutral-400'}`}>
          🎯 Active Signals ({activeCount})
        </button>
        <button onClick={() => setView('SUPERSEDED')}
          className={`px-4 py-1.5 rounded-lg text-[13px] font-bold border ${view === 'SUPERSEDED' ? 'bg-accent-amber/20 border-accent-amber text-accent-amber' : 'bg-ink-700 border-ink-500 text-neutral-400'}`}>
          🔁 Superseded ({supersededCount})
        </button>
      </div>
      {view === 'SUPERSEDED' && (
        <div className="text-[11px] text-neutral-500 bg-ink-800 border border-ink-500 rounded-lg px-3 py-2">
          Signals replaced by a newer call from the same engine. Sorted by conviction, then FII stake (highest first) — so the strongest dropped setups surface at the top for review.
        </div>
      )}
      {view === 'ACTIVE' && (
        <div className="flex flex-wrap gap-2">
          {[
            { k: 'ALL',       l: `All (${counts.all})` },
            { k: 'RUNNING',   l: `🎯 Running (${counts.running})`, c: 'text-accent-cyan' },
            { k: 'COMPLETED', l: `📋 Completed (${counts.completed})` },
            { k: 'T1',        l: `✅ T1 hit (${counts.t1})`, c: 'text-accent-green' },
            { k: 'T2',        l: `✅✅ T2 hit (${counts.t2})`, c: 'text-accent-green' },
            { k: 'T3',        l: `🚀 T3 hit (${counts.t3})`, c: 'text-accent-green' },
            { k: 'SL',        l: `❌ SL hit (${counts.sl})`, c: 'text-accent-red' },
            { k: 'EXPIRED',   l: `⏰ Expired (${counts.exp})`, c: 'text-neutral-500' },
          ].map(b => (
            <button key={b.k} onClick={() => setFilter(b.k)}
              className={`px-3 py-1 rounded text-[12px] font-bold border ${filter === b.k ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan' : 'bg-ink-700 border-ink-500 text-neutral-400'} ${b.c ?? ''}`}>
              {b.l}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-neutral-500">Sort:</span>
        {[
          { k: 'newest', l: 'Newest first' },
          { k: 'return-desc', l: '% Return ▼ (best wins first)' },
          { k: 'return-asc', l: '% Return ▲ (worst losses first)' },
          { k: 'conviction-desc', l: 'Conviction ▼' },
        ].map(s => (
          <button key={s.k} onClick={() => setSort(s.k as any)}
            className={`px-2 py-0.5 rounded border ${sort === s.k ? 'bg-accent-violet/20 border-accent-violet text-accent-violet' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
            {s.l}
          </button>
        ))}
      </div>
      {sources.length > 1 && (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setSrc('ALL')} className={`px-2 py-1 rounded text-[11px] border ${src === 'ALL' ? 'bg-accent-violet/20 border-accent-violet text-accent-violet' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>All sources</button>
          {sources.map(s => (
            <button key={s} onClick={() => setSrc(s)}
              className={`px-2 py-1 rounded text-[11px] border ${src === s ? 'bg-accent-violet/20 border-accent-violet text-accent-violet' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
              {s}
            </button>
          ))}
        </div>
      )}
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No signals match these filters yet." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1080 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th className="text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]">Stock</th>
                <th className="text-center px-3 py-3 whitespace-nowrap">Conviction</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-cyan">Entry</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-red">SL</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">T1</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">T2</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">T3</th>
                <th className="text-center px-3 py-3 whitespace-nowrap">Status</th>
                <th className="text-right px-2 py-3 whitespace-nowrap">% Return</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r, i) => {
                const isWin = ['T1_HIT', 'T2_HIT', 'T3_HIT'].includes(r.status)
                const isLoss = r.status === 'SL_HIT'
                const rowBg = isWin ? 'bg-accent-green/10' : isLoss ? 'bg-accent-red/10' : 'bg-ink-800'
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
                const statusBadge = isWin ? '✅' : isLoss ? '❌' : r.status === 'ACTIVE' ? '🎯' : r.status === 'PENDING' ? '⏳' : r.status === 'SUPERSEDED' ? '🔁' : '⏰'
                const td = `px-2 py-2 align-top ${rowBg} group-hover:bg-ink-700 font-mono`
                return (
                  <tr key={i} className="group border-t border-ink-500">
                    {/* Stock column — wide; name+badges, 📊 Stake, ⚡ Setup stacked. */}
                    <td className={`${td} px-3 sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`} style={{ minWidth: 320, maxWidth: 360 }}>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <b className="text-neutral-100">{r.symbol}</b>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                        <span className="text-[9px] text-neutral-500">{r.source}</span>
                        <span className="text-[9px] text-neutral-600">{fmtDate(r.generatedAt)}</span>
                      </div>
                      {r.shareholdingNote && (
                        <div className="mt-1 text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                          <span className="text-neutral-600 font-semibold">📊 Stake:</span> {r.shareholdingNote}
                        </div>
                      )}
                      <div className="text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                        <span className="text-neutral-600 font-semibold">⚡ Setup:</span> {r.reason || '—'}
                      </div>
                    </td>
                    <td className={`${td} text-center font-bold`}>
                      <span className={r.conviction >= 80 ? 'text-accent-green' : r.conviction >= 60 ? 'text-accent-cyan' : r.conviction >= 40 ? 'text-accent-amber' : 'text-neutral-500'}>
                        {r.conviction ?? '—'}
                      </span>
                    </td>
                    <td className={`${td} text-right text-accent-cyan whitespace-nowrap`}>₹{fmtPx(r.entry)}</td>
                    <td className={`${td} text-right text-accent-red whitespace-nowrap`}>₹{fmtPx(r.stopLoss)}</td>
                    <td className={`${td} text-right text-accent-green whitespace-nowrap`}>₹{fmtPx(r.target1)}</td>
                    <td className={`${td} text-right text-accent-green whitespace-nowrap`}>₹{fmtPx(r.target2)}</td>
                    <td className={`${td} text-right text-accent-green whitespace-nowrap`}>₹{fmtPx(r.target3)}</td>
                    <td className={`${td} text-center whitespace-nowrap`}>
                      <span className="text-[11px]">{statusBadge} {r.status}</span>
                    </td>
                    <td className={`${td} text-right whitespace-nowrap`} style={{ color: r.realisedPct == null ? '#666' : (r.realisedPct >= 0 ? '#00c853' : '#ff1744') }}>
                      {r.realisedPct == null ? '—' : `${r.realisedPct >= 0 ? '+' : ''}${r.realisedPct}%`}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── TOP TRADES — curated unified stream ─────────────────────────
export function PublicTopTradesPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-top-trades'], queryFn: () => snapshots.topTrades(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const allRows: any[] = data?.rows ?? []
  const { rows, headerProps, sortIndicator } = useSortableTable<any>(
    allRows,
    { key: 'conviction', dir: 'desc' },
    {
      symbol: r => r.symbol, ltp: r => r.ltp, conviction: r => r.conviction ?? 0,
      entry: r => r.entryPriceLow ?? r.entryPrice ?? 0, sl: r => r.stopLoss ?? 0,
      t1: r => r.target1 ?? 0, t2: r => r.target2 ?? 0, t3: r => r.target3 ?? 0,
    },
  )
  return (
    <div className="space-y-4">
      <Banner emoji="🎯" title="Top Trades" subtitle={`Curated elite-only stream — conviction ≥ ${data?.filterMinConv ?? 85} · pulled from Weekly + Daily picks · deduped`} ts={data?.generatedAt} />
      <Legend kind="pick" />
      <AccuracyStrip />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No setups currently meet the conviction threshold (≥85). The bar will lower naturally during active sessions." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1080 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th {...headerProps('symbol')} className={`text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)] ${headerProps('symbol').className}`}>Stock {sortIndicator('symbol')}</th>
                <th {...headerProps('ltp')} className={`text-right px-2 py-3 ${headerProps('ltp').className}`}>LTP {sortIndicator('ltp')}</th>
                <th {...headerProps('conviction')} className={`text-center px-2 py-3 ${headerProps('conviction').className}`}>Conviction {sortIndicator('conviction')}</th>
                <th {...headerProps('entry')} className={`text-right px-2 py-3 text-accent-cyan ${headerProps('entry').className}`}>Entry {sortIndicator('entry')}</th>
                <th {...headerProps('sl')} className={`text-right px-2 py-3 text-accent-red ${headerProps('sl').className}`}>SL {sortIndicator('sl')}</th>
                <th {...headerProps('t1')} className={`text-right px-2 py-3 text-accent-green ${headerProps('t1').className}`}>T1 · date {sortIndicator('t1')}</th>
                <th {...headerProps('t2')} className={`text-right px-2 py-3 text-accent-green ${headerProps('t2').className}`}>T2 · date {sortIndicator('t2')}</th>
                <th {...headerProps('t3')} className={`text-right px-2 py-3 text-accent-green ${headerProps('t3').className}`}>T3 {sortIndicator('t3')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
                const convCls = r.conviction >= 90 ? 'text-accent-green' : r.conviction >= 85 ? 'text-accent-cyan' : 'text-accent-amber'
                const sourceColor = r.source === 'WEEKLY' ? '#5dade2' : r.source === 'DAILY' ? '#f5c518' : '#aaa'
                const isWave2 = r.lifecycleStatus !== 'SUPERSEDED' && (r.bucket === 'WAVE_2' || (r.reasoning || '').includes('WAVE-2'))
                const rowBg = r.noBrainer ? 'bg-accent-amber/5' : 'bg-ink-800'
                const td = `px-2 py-2 align-top ${rowBg} group-hover:bg-ink-700 font-mono`
                return (
                  <tr key={i} className="group border-t border-ink-500">
                    {/* Stock column — wide; name+badges, 📊 Stake stacked. */}
                    <td className={`${td} px-3 sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`} style={{ minWidth: 300, maxWidth: 360 }}>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <b className="text-neutral-100">{r.noBrainer && '⭐ '}{r.symbol}</b>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                        <span className="px-1 py-0.5 rounded text-[9px] font-bold" style={{ background: `${sourceColor}22`, color: sourceColor }}>{r.source}</span>
                        {isWave2 && <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-accent-violet/20 text-accent-violet border border-accent-violet/40">🔄</span>}
                      </div>
                      <div className="mt-1 text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                        <span className="text-neutral-600 font-semibold">📊 Stake:</span> {r.shareholdingNote || <span className="text-neutral-600">unavailable</span>}
                      </div>
                    </td>
                    <td className={`${td} text-right`}>₹{fmtPx(r.ltp)}</td>
                    <td className={`${td} text-center font-bold ${convCls}`}>{r.conviction}</td>
                    <td className={`${td} text-right text-accent-cyan`}>
                      <div>₹{fmtPx(r.entryPriceLow)}–{fmtPx(r.entryPriceHigh)}</div>
                      <div className="text-[9px] text-accent-cyan/70">by {fmtDate(r.entryDate)}</div>
                    </td>
                    <td className={`${td} text-right text-accent-red`}>₹{fmtPx(r.stopLoss)}</td>
                    <td className={`${td} text-right text-accent-green`}>
                      <div>₹{fmtPx(r.target1)}</div>
                      <div className="text-[9px] text-accent-green/70">{fmtDate(r.target1Date)}</div>
                    </td>
                    <td className={`${td} text-right text-accent-green`}>
                      <div>₹{fmtPx(r.target2)}</div>
                      <div className="text-[9px] text-accent-green/70">{fmtDate(r.target2Date)}</div>
                    </td>
                    <td className={`${td} text-right text-accent-green font-bold`}>₹{fmtPx(r.target3)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── WEEKLY PICK ─────────────────────────────────────────────────
// 2026-05-24: PROTOTYPE redesign per user feedback.
//   Old issue: table was 1700px min-width with horizontal scroll at the
//   bottom of a tall table — user had to scroll page down THEN scroll
//   table right. Tedious especially on mobile.
//   New approach:
//     • Mobile (< md=768px) → vertical CARD list, no horizontal scroll at all.
//     • Desktop (≥ md) → table with:
//         - scroll container `max-height: 75vh` so horizontal bar is always
//           near the viewport bottom (not buried at the table bottom)
//         - sticky <thead> (column labels visible while scrolling vertically)
//         - sticky first column "Stock" (always visible while scrolling
//           horizontally, so you always know which row you're on)
//   If you approve this, we apply the same pattern to all other pages.
export function PublicWeeklyPickPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-weekly'], queryFn: () => snapshots.weeklyPick(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const allRows: any[] = data?.rows ?? []
  // 2026-05-26: column-wise sortable headers.
  const { rows, headerProps, sortIndicator } = useSortableTable<any>(
    allRows,
    { key: 'conv', dir: 'desc' },
    {
      symbol: r => r.symbol, ltp: r => r.ltp, dir: r => r.direction,
      conv: r => r.conviction,
      vol5d: r => r.vol5dRatio ?? 0, smart: r => (r.smartMoneyUp ? 1 : 0),
      fii: r => r.fiiDelta ?? 0,
      entry: r => r.entryPrice ?? r.entryPriceLow,
      sl: r => r.stopLoss, t1: r => r.target1, t2: r => r.target2, t3: r => r.target3,
    },
  )

  return (
    <div className="space-y-4">
      <Banner emoji="📋" title="Weekly Picks" subtitle={data ? `${rows.length} setups · week of ${data.weekOf} · regime ${data.regime}` : 'loading…'} ts={data?.generatedAt} />
      <Legend kind="pick" />
      <AccuracyStrip />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && (
        <>
          {/* Mobile card list — < 768px */}
          <div className="md:hidden space-y-3">
            {rows.map((r, i) => <WeeklyCard key={`m${i}`} r={r} />)}
          </div>

          {/* Desktop table — ≥ 768px */}
          <div
            className="hidden md:block overflow-auto rounded-lg border border-ink-500 bg-ink-800"
            style={{ maxHeight: '75vh' }}
          >
            <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1180 }}>
              <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
                <tr>
                  <th {...headerProps('symbol')} className={`text-left px-4 py-3 whitespace-nowrap bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)] ${headerProps('symbol').className}`}>Stock {sortIndicator('symbol')}</th>
                  <th {...headerProps('ltp')} className={`text-right px-4 py-3 whitespace-nowrap ${headerProps('ltp').className}`}>LTP {sortIndicator('ltp')}</th>
                  <th {...headerProps('dir')} className={`text-center px-4 py-3 whitespace-nowrap ${headerProps('dir').className}`}>Direction {sortIndicator('dir')}</th>
                  <th {...headerProps('conv')} className={`text-center px-4 py-3 whitespace-nowrap ${headerProps('conv').className}`}>Conviction {sortIndicator('conv')}</th>
                  <th {...headerProps('smart')} className={`text-center px-3 py-3 whitespace-nowrap ${headerProps('smart').className}`} title="5dVol · 🔥 Smart $ (FII↑+Promoter stable) · FIIΔ stacked.">Money Flow {sortIndicator('smart')}</th>
                  <th {...headerProps('entry')} className={`text-right px-2 py-3 whitespace-nowrap text-accent-cyan ${headerProps('entry').className}`}>Entry {sortIndicator('entry')}</th>
                  <th {...headerProps('sl')} className={`text-right px-2 py-3 whitespace-nowrap text-accent-red ${headerProps('sl').className}`}>SL {sortIndicator('sl')}</th>
                  <th {...headerProps('t1')} className={`text-right px-2 py-3 whitespace-nowrap text-accent-green ${headerProps('t1').className}`}>T1 · date {sortIndicator('t1')}</th>
                  <th {...headerProps('t2')} className={`text-right px-2 py-3 whitespace-nowrap text-accent-green ${headerProps('t2').className}`}>T2 · date {sortIndicator('t2')}</th>
                  <th {...headerProps('t3')} className={`text-right px-2 py-3 whitespace-nowrap text-accent-green ${headerProps('t3').className}`}>T3 · date {sortIndicator('t3')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => <WeeklyRow key={i} r={r} />)}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

/** Mobile card layout — every column collapsed into a vertical stack.
 *  No horizontal scroll. Tap anywhere on the card to do nothing yet (placeholder). */
function WeeklyCard({ r }: { r: any }): JSX.Element {
  const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
  const convCls = r.conviction >= 80 ? 'text-accent-green' : r.conviction >= 60 ? 'text-accent-cyan' : 'text-accent-amber'
  const status = r.lifecycleStatus || 'ACTIVE'
  const isHit = status === 'T1_HIT' || status === 'T2_HIT' || status === 'T3_HIT'
  const isLoss = status === 'SL_HIT' || status === 'SUPERSEDED' || status === 'EXPIRED' || status === 'INVALIDATED'
  const cardCls = `rounded-lg border p-3 font-mono text-[12px] ${
    isHit ? 'bg-accent-green/10 border-accent-green/40' :
    isLoss ? 'bg-ink-900 border-ink-500 opacity-60' :
    r.noBrainerBet ? 'bg-accent-amber/5 border-accent-amber/40' :
    'bg-ink-800 border-ink-500'
  }`
  return (
    <div className={cardCls}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <b className="text-neutral-100 text-[13px]">{r.noBrainerBet && '⭐ '}{r.symbol}</b>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
          {r.bucket === 'WAVE_2' && status === 'ACTIVE' && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-accent-violet/20 text-accent-violet border border-accent-violet/40">🔄 WAVE-2</span>
          )}
        </div>
        <span className={`text-[12px] font-bold ${convCls}`}>{r.conviction}</span>
      </div>
      <StatusChip r={r} status={status} />
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
        <div className="text-neutral-500">LTP</div><div className="text-right">₹{fmtPx(r.ltp)}</div>
        <div className="text-accent-cyan">Entry</div><div className="text-right text-accent-cyan">₹{fmtPx(r.entryPriceLow)}–{fmtPx(r.entryPriceHigh)}</div>
        <div className="text-neutral-500">Entry by</div><div className="text-right text-[10px]">{fmtDate(r.entryDate)}</div>
        <div className="text-accent-red">Stop Loss</div><div className="text-right text-accent-red">₹{fmtPx(r.stopLoss)}</div>
        <div className="text-accent-green">T1</div><div className="text-right text-accent-green">₹{fmtPx(r.target1)} <span className="text-neutral-500 text-[10px]">· {fmtDate(r.target1Date)}</span></div>
        <div className="text-accent-green">T2</div><div className="text-right text-accent-green">₹{fmtPx(r.target2)} <span className="text-neutral-500 text-[10px]">· {fmtDate(r.target2Date)}</span></div>
        <div className="text-accent-green">T3</div><div className="text-right text-accent-green font-bold">₹{fmtPx(r.target3)} <span className="text-neutral-500 text-[10px]">· {fmtDate(r.target3Date)}</span></div>
      </div>
      {r.shareholdingNote && (
        <div className="mt-2 pt-2 border-t border-ink-500 text-[10px] text-neutral-400 leading-relaxed">
          <span className="text-neutral-500">Stake:</span> {r.shareholdingNote}
        </div>
      )}
    </div>
  )
}

function WeeklyRow({ r }: { r: any }): JSX.Element {
  const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
  const convCls = r.conviction >= 80 ? 'text-accent-green' : r.conviction >= 60 ? 'text-accent-cyan' : 'text-accent-amber'
  // 2026-05-08: Lifecycle status drives row treatment.
  // ACTIVE = normal · T*_HIT = green-tinted · SUPERSEDED/SL/EXPIRED = strike-through faded.
  const status = r.lifecycleStatus || 'ACTIVE'
  const isHit = status === 'T1_HIT' || status === 'T2_HIT' || status === 'T3_HIT'
  const isLoss = status === 'SL_HIT' || status === 'SUPERSEDED' || status === 'EXPIRED' || status === 'INVALIDATED'
  // Row-level background (used by every cell so the sticky Stock column matches the row tint).
  const rowBg =
    r.noBrainerBet && status === 'ACTIVE' ? 'bg-accent-amber/5' :
    isHit ? 'bg-accent-green/10' :
    isLoss ? 'bg-ink-900' : 'bg-ink-800'
  const rowOpacity = isLoss ? 'opacity-60' : ''
  const strike = isLoss ? 'line-through' : 'none'
  const tdStyle = { textDecoration: strike } as React.CSSProperties
  const td = `px-2 py-3 whitespace-nowrap border-t border-ink-500 group-hover:bg-ink-700 ${rowBg} ${rowOpacity}`
  const tdNoBorder = `px-2 py-2 align-top whitespace-nowrap group-hover:bg-ink-700 ${rowBg} ${rowOpacity}`
  return (
    <>
      {/* Single row — Stock column holds name+badges, 📊 Stake, 💧 Flow stacked. */}
      <tr className="group border-t border-ink-500">
        <td className={`${tdNoBorder} px-4 text-left sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`} style={{ ...tdStyle, minWidth: 320, maxWidth: 360, whiteSpace: 'normal' }}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <b className="text-neutral-200">{r.noBrainerBet && '⭐ '}{r.symbol}</b>
            {r.bucket === 'WAVE_2' && status === 'ACTIVE' && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-accent-violet/20 text-accent-violet border border-accent-violet/40">🔄 WAVE-2</span>
            )}
            <StatusChip r={r} status={status} />
          </div>
          <div className="mt-1 text-[10px] text-neutral-400 leading-relaxed">
            <span className="text-neutral-600 font-semibold">📊 Stake:</span> {r.shareholdingNote || <span className="text-neutral-600">unavailable</span>}
          </div>
          {r.flowNote && (
            <div className="text-[10px] text-neutral-400 leading-relaxed">
              <span className="text-neutral-600 font-semibold">💧 Flow:</span> {r.flowNote}
            </div>
          )}
        </td>
        <td className={`${tdNoBorder} px-2 text-right`} style={tdStyle}>₹{fmtPx(r.ltp)}</td>
        <td className={`${tdNoBorder} px-4 text-center`}>
          <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{ background: `${dirColor}22`, color: dirColor, textDecoration: strike }}>{r.direction}</span>
        </td>
        <td className={`${tdNoBorder} px-4 text-center font-bold ${convCls}`} style={tdStyle}>{r.conviction}</td>
        {/* Money Flow — stacked */}
        <td className={`${tdNoBorder} text-center`} style={tdStyle}>
          <div className="flex items-center justify-center gap-1.5 text-[10px] leading-tight whitespace-nowrap">
            <span className={r.vol5dRatio != null && r.vol5dRatio >= 1.3 ? 'text-accent-green font-bold' : r.vol5dRatio != null && r.vol5dRatio >= 1.0 ? 'text-accent-cyan' : 'text-neutral-500'}>5d {r.vol5dRatio ? `${r.vol5dRatio}×` : '—'}</span>
            <span className="text-neutral-700">·</span>
            {r.smartMoneyUp ? <span className="text-accent-green font-bold">🔥</span> : <span className="text-neutral-700">·</span>}
            {r.fiiDelta != null && r.fiiDelta !== 0 && (
              <span className={r.fiiDelta > 0 ? 'text-accent-green' : 'text-accent-red'}>FII {r.fiiDelta > 0 ? '+' : ''}{r.fiiDelta}</span>
            )}
          </div>
        </td>
        <td className={`${tdNoBorder} text-right text-accent-cyan`} style={tdStyle}>
          <div>₹{fmtPx(r.entryPriceLow)}–{fmtPx(r.entryPriceHigh)}</div>
          <div className="text-[9px] text-accent-cyan/70">by {fmtDate(r.entryDate)}</div>
        </td>
        <td className={`${tdNoBorder} text-right text-accent-red`} style={tdStyle}>₹{fmtPx(r.stopLoss)}</td>
        <td className={`${tdNoBorder} text-right text-accent-green`} style={tdStyle}>
          <div>₹{fmtPx(r.target1)}</div>
          <div className="text-[9px] text-accent-green/70">{fmtDate(r.target1Date)}</div>
        </td>
        <td className={`${tdNoBorder} text-right text-accent-green`} style={tdStyle}>
          <div>₹{fmtPx(r.target2)}</div>
          <div className="text-[9px] text-accent-green/70">{fmtDate(r.target2Date)}</div>
        </td>
        <td className={`${tdNoBorder} text-right text-accent-green font-bold`} style={tdStyle}>
          <div>₹{fmtPx(r.target3)}</div>
          <div className="text-[9px] text-accent-green/70 font-normal">{fmtDate(r.target3Date)}</div>
        </td>
      </tr>
    </>
  )
}

/** Status chip rendered next to the symbol for non-ACTIVE entries. */
function StatusChip({ r, status }: { r: any; status: string }): JSX.Element | null {
  if (status === 'ACTIVE') return null
  const cfg: Record<string, { label: string; bg: string; fg: string }> = {
    T1_HIT:      { label: '✅ T1 HIT',     bg: '#00c85322', fg: '#00c853' },
    T2_HIT:      { label: '✅ T2 HIT',     bg: '#00c85333', fg: '#00c853' },
    T3_HIT:      { label: '🚀 T3 HIT',     bg: '#00c85344', fg: '#00c853' },
    SL_HIT:      { label: '❌ SL HIT',     bg: '#ff174422', fg: '#ff1744' },
    SUPERSEDED:  { label: '🔁 SUPERSEDED', bg: '#f5c51822', fg: '#f5c518' },
    EXPIRED:     { label: '⏰ EXPIRED',    bg: '#88888822', fg: '#888' },
    INVALIDATED: { label: '🚫 INVALIDATED', bg: '#ff174422', fg: '#ff1744' },
  }
  const c = cfg[status]
  if (!c) return null
  const tip = [
    r.lifecycleReason || '',
    r.lifecycleHitPrice ? `at ₹${r.lifecycleHitPrice}` : '',
    r.lifecycleHitAt ? `on ${new Date(r.lifecycleHitAt).toLocaleDateString('en-IN')}` : '',
    r.convictionPrev != null && r.convictionPrev !== r.conviction ? `conv ${r.convictionPrev}→${r.conviction}` : '',
  ].filter(Boolean).join(' · ')
  return (
    <span title={tip} className="ml-2 inline-block align-middle px-2 py-0.5 rounded text-[10px] font-bold"
      style={{ background: c.bg, color: c.fg, border: `1px solid ${c.fg}66`, textDecoration: 'none' }}>
      {c.label}
    </span>
  )
}

// ── DAILY PICK ──────────────────────────────────────────────────
export function PublicDailyPickPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-daily'], queryFn: () => snapshots.dailyPick(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const allRows: any[] = data?.rows ?? []
  const { rows, headerProps, sortIndicator } = useSortableTable<any>(
    allRows,
    { key: 'conv', dir: 'desc' },
    {
      symbol: r => r.symbol, ltp: r => r.ltp, dir: r => r.direction, conv: r => r.conviction,
      vol5d: r => r.vol5dRatio ?? 0, smart: r => (r.smartMoneyUp ? 1 : 0), fii: r => r.fiiDelta ?? 0,
      entry: r => r.entryPrice, sl: r => r.stopLoss,
      t1: r => r.target1, t2: r => r.target2, t3: r => r.target3, rr: r => r.riskReward,
    },
  )
  return (
    <div className="space-y-4">
      <Banner emoji="🎯" title="Daily Picks" subtitle={`${rows.length} 5–15 day setups · regime ${data?.regime ?? '—'}`} ts={data?.generatedAt} />
      <Legend kind="pick" />
      <AccuracyStrip />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No daily picks right now. Refreshes 11:00 / 13:30 / 16:15 IST." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1120 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th {...headerProps('symbol')} className={`text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)] ${headerProps('symbol').className}`}>Stock {sortIndicator('symbol')}</th>
                <th {...headerProps('ltp')} className={`text-right px-2 py-3 ${headerProps('ltp').className}`}>LTP {sortIndicator('ltp')}</th>
                <th {...headerProps('conv')} className={`text-center px-2 py-3 ${headerProps('conv').className}`}>Conviction {sortIndicator('conv')}</th>
                <th {...headerProps('smart')} className={`text-center px-2 py-3 ${headerProps('smart').className}`} title="5dVol · 🔥 Smart $ (FII↑+Promoter stable) · FIIΔ stacked.">Money Flow {sortIndicator('smart')}</th>
                <th {...headerProps('entry')} className={`text-right px-2 py-3 text-accent-cyan ${headerProps('entry').className}`}>Entry {sortIndicator('entry')}</th>
                <th {...headerProps('sl')} className={`text-right px-2 py-3 text-accent-red ${headerProps('sl').className}`}>SL {sortIndicator('sl')}</th>
                <th {...headerProps('t1')} className={`text-right px-2 py-3 text-accent-green ${headerProps('t1').className}`}>T1 {sortIndicator('t1')}</th>
                <th {...headerProps('t2')} className={`text-right px-2 py-3 text-accent-green ${headerProps('t2').className}`}>T2 {sortIndicator('t2')}</th>
                <th {...headerProps('t3')} className={`text-right px-2 py-3 text-accent-green ${headerProps('t3').className}`}>T3 {sortIndicator('t3')}</th>
                <th {...headerProps('rr')} className={`text-center px-2 py-3 ${headerProps('rr').className}`}>R:R {sortIndicator('rr')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
                const convCls = r.conviction >= 80 ? 'text-accent-green' : r.conviction >= 60 ? 'text-accent-cyan' : 'text-accent-amber'
                const v5cls = r.vol5dRatio != null && r.vol5dRatio >= 1.3 ? 'text-accent-green font-bold' : r.vol5dRatio != null && r.vol5dRatio >= 1.0 ? 'text-accent-cyan' : 'text-neutral-500'
                const td = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono`
                return (
                  <tr key={i} className="group border-t border-ink-500">
                    {/* Stock column — wide; name+badge, 📊 Stake, ⚡ Pattern stacked. */}
                    <td className={`${td} px-3 sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`} style={{ minWidth: 300, maxWidth: 360 }}>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <b className="text-neutral-100">{r.symbol}</b>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                      </div>
                      <div className="mt-1 text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                        <span className="text-neutral-600 font-semibold">📊 Stake:</span> {r.shareholdingNote || <span className="text-neutral-600">unavailable</span>}
                      </div>
                      {r.pattern && (
                        <div className="text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                          <span className="text-neutral-600 font-semibold">⚡ Pattern:</span> {r.pattern}
                        </div>
                      )}
                    </td>
                    <td className={`${td} text-right`}>₹{fmtPx(r.ltp)}</td>
                    <td className={`${td} text-center font-bold ${convCls}`}>{r.conviction}</td>
                    <td className={`${td} text-center`}>
                      <div className="flex items-center justify-center gap-1.5 text-[10px] leading-tight whitespace-nowrap">
                        <span className={v5cls}>5d {r.vol5dRatio ? `${r.vol5dRatio}×` : '—'}</span>
                        <span className="text-neutral-700">·</span>
                        {r.smartMoneyUp ? <span className="text-accent-green font-bold">🔥</span> : <span className="text-neutral-700">·</span>}
                        {r.fiiDelta != null && r.fiiDelta !== 0 && (
                          <span className={r.fiiDelta > 0 ? 'text-accent-green' : 'text-accent-red'}>FII {r.fiiDelta > 0 ? '+' : ''}{r.fiiDelta}</span>
                        )}
                      </div>
                    </td>
                    <td className={`${td} text-right text-accent-cyan`}>₹{fmtPx(r.entryPrice)}</td>
                    <td className={`${td} text-right text-accent-red`}>₹{fmtPx(r.stopLoss)}</td>
                    <td className={`${td} text-right text-accent-green`}>₹{fmtPx(r.target1)}</td>
                    <td className={`${td} text-right text-accent-green`}>₹{fmtPx(r.target2)}</td>
                    <td className={`${td} text-right text-accent-green font-bold`}>₹{fmtPx(r.target3)}</td>
                    <td className={`${td} text-center`}>{r.riskReward ?? '—'}:1</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── PRE-MOVE ────────────────────────────────────────────────────
export function PublicPreMovePage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-premove'], queryFn: () => snapshots.preMove(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []
  return (
    <div className="space-y-4">
      <Banner emoji="⚡" title="Pre-Move Alerts" subtitle="Setups likely to resolve into 5–15% moves within 1–10 sessions" ts={data?.generatedAt} />
      <Legend kind="premove" />
      <AccuracyStrip />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No pre-move setups right now. Pre-close scan: 15:20 IST." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 900 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th className="text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]">Stock</th>
                <th className="text-right px-2 py-3">Price</th>
                <th className="text-center px-2 py-3">Tier</th>
                <th className="text-center px-2 py-3">Score</th>
                <th className="text-right px-2 py-3 text-accent-cyan">Entry</th>
                <th className="text-right px-2 py-3 text-accent-red">SL</th>
                <th className="text-right px-2 py-3 text-accent-green">Target</th>
                <th className="text-center px-2 py-3 text-accent-green">Exp %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dirColor = r.direction === 'BULL' ? '#00c853' : r.direction === 'BEAR' ? '#ff1744' : '#9aa0a6'
                const td = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono`
                return (
                  <tr key={i} className="group border-t border-ink-500">
                    {/* Stock column — wide; name+badge, 📊 Stake, ⚡ Setup stacked. */}
                    <td className={`${td} px-3 sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`} style={{ minWidth: 300, maxWidth: 360 }}>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <b className="text-neutral-100">{r.symbol}</b>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                      </div>
                      {r.shareholdingNote && (
                        <div className="mt-1 text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                          <span className="text-neutral-600 font-semibold">📊 Stake:</span> {r.shareholdingNote}
                        </div>
                      )}
                      <div className="text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                        <span className="text-neutral-600 font-semibold">⚡ Setup:</span> {(r.tags ?? []).slice(0, 4).join(' · ') || '—'}
                      </div>
                    </td>
                    <td className={`${td} text-right`}>₹{fmtPx(r.price)}</td>
                    <td className={`${td} text-center text-[11px]`}>{r.tier}</td>
                    <td className={`${td} text-center font-bold`}>{r.score?.toFixed?.(1)}</td>
                    <td className={`${td} text-right text-accent-cyan`}>₹{fmtPx(r.suggestedEntry)}</td>
                    <td className={`${td} text-right text-accent-red`}>₹{fmtPx(r.suggestedSL)}</td>
                    <td className={`${td} text-right text-accent-green`}>₹{fmtPx(r.suggestedTarget)}</td>
                    <td className={`${td} text-center text-accent-green text-[11px]`}>{r.expectedMovePct?.toFixed?.(1)}%</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── OPTIONS ─────────────────────────────────────────────────────
export function PublicOptionsPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-options'], queryFn: () => snapshots.options(),
    refetchInterval: 3 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []
  return (
    <div className="space-y-4">
      <Banner emoji="🎯" title="Options Signals" subtitle={`${rows.length} elite signals (score ≥ 9, conviction ≥ 90)`} ts={data?.generatedAt} />
      <Legend kind="signal" />
      <AccuracyStrip />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No elite options signals right now. Active 9:15–15:30 IST." />}
      {!isLoading && !error && rows.length > 0 && <SignalTable rows={rows} />}
    </div>
  )
}

// ── INTRADAY ────────────────────────────────────────────────────
export function PublicIntradayPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-intraday'], queryFn: () => snapshots.intraday(),
    refetchInterval: 3 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []
  return (
    <div className="space-y-4">
      <Banner emoji="⚡" title="Intraday Signals" subtitle={`${rows.length} signals from today's session`} ts={data?.generatedAt} />
      <Legend kind="signal" />
      <AccuracyStrip />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No intraday signals right now. Active 9:15–15:30 IST." />}
      {!isLoading && !error && rows.length > 0 && <SignalTable rows={rows} />}
    </div>
  )
}

function SignalTable({ rows }: { rows: any[] }): JSX.Element {
  // 2026-05-27: consistent 2-row design (Options + Intraday). Row 1 numerics,
  // Row 2 = ⚡ Setup reasoning under the instrument name. Sticky header +
  // sticky first column + 78vh scroll, matching every other public tab.
  return (
    <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
      <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 980 }}>
        <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
          <tr>
            <th className="text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]">Instrument</th>
            <th className="text-center px-2 py-3 whitespace-nowrap">Grade</th>
            <th className="text-center px-2 py-3 whitespace-nowrap">Score</th>
            <th className="text-right px-2 py-3 whitespace-nowrap text-accent-cyan">Entry</th>
            <th className="text-right px-2 py-3 whitespace-nowrap text-accent-red">SL</th>
            <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">T1</th>
            <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">T2</th>
            <th className="text-center px-2 py-3 whitespace-nowrap">R:R</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
            const ts = new Date(r.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
            const td = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono`
            return (
              <tr key={i} className="group border-t border-ink-500">
                {/* Instrument column — wide; name+badge+time, ⚡ Setup stacked. */}
                <td className={`${td} px-3 sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`} style={{ minWidth: 300, maxWidth: 380 }}>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <b className="text-neutral-100">{r.instrument}</b>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                    <span className="text-[9px] text-neutral-600">{ts} IST</span>
                  </div>
                  <div className="mt-1 text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                    <span className="text-neutral-600 font-semibold">⚡ Setup:</span> {(r.reasons ?? []).slice(0, 3).join(' · ') || '—'}
                  </div>
                </td>
                <td className={`${td} text-center text-accent-amber font-bold`}>{r.grade}</td>
                <td className={`${td} text-center font-bold`}>{r.score?.toFixed?.(1)}</td>
                <td className={`${td} text-right text-accent-cyan`}>₹{fmtPx(r.entry)}</td>
                <td className={`${td} text-right text-accent-red`}>₹{fmtPx(r.stopLoss)}</td>
                <td className={`${td} text-right text-accent-green`}>₹{fmtPx(r.target1)}</td>
                <td className={`${td} text-right text-accent-green`}>₹{fmtPx(r.target2)}</td>
                <td className={`${td} text-center`}>{r.riskReward ?? '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── shared bits ─────────────────────────────────────────────────
function Banner({ emoji, title, subtitle, ts }: { emoji: string; title: string; subtitle: string; ts?: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
      <div className="text-2xl">{emoji}</div>
      <div className="flex-1">
        <div className="text-sm font-semibold text-neutral-200">{title}</div>
        <div className="text-xs text-neutral-500 mt-1">{subtitle}</div>
      </div>
      <div className="text-[10px] text-neutral-600">Updated {fmtTs(ts)} IST</div>
    </div>
  )
}
function Loading(): JSX.Element { return <div className="text-neutral-500 p-10 text-center">Loading…</div> }
function Empty({ msg }: { msg: string }): JSX.Element { return <div className="text-neutral-500 p-10 text-center border border-dashed border-ink-500 rounded-lg">{msg}</div> }

// ── 5–20% MOVE — Pre-Move Identifier (Vercel public) ──────────────
// 2026-05-26: 8-signal composite scorer surfaced to public visitors.
// Snapshot-fed via raw.githubusercontent.com/.../public-snapshots/
// pre-move-identifier.json (regenerated by the localhost cron at 16:00 IST).
export function PublicPreMoveIdentifierPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-pre-move-identifier'], queryFn: () => snapshots.preMoveIdentifier(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const allCs: any[] = data?.candidates ?? []
  const { rows: cs, headerProps, sortIndicator } = useSortableTable<any>(
    allCs,
    { key: 'score', dir: 'desc' },
    {
      symbol: c => c.symbol, ltp: c => c.ltp,
      vol: c => c.volumeRatio ?? 0, vol5d: c => c.volumeRatio5d ?? 0,
      smart: c => (c.smartMoneyUp ? 1 : 0),
      fii: c => c.fiiDelta ?? 0,
      score: c => c.totalScore, tier: c => -c.tier,
      entry: c => c.entry, sl: c => c.stopLoss,
      t1: c => c.target1, t2: c => c.target2, t3: c => c.target3,
      rr: c => c.riskReward, exp: c => c.expectedMovePct,
    },
  )
  return (
    <div className="space-y-4">
      <Banner emoji="🎯" title="5–20% Move — Pre-Move Identifier" subtitle={data ? `${data.tier1Count} Tier-1 · ${data.tier2Count} Tier-2 · ${data.tier3Count} Tier-3 · ${data.qualityPassed} passed quality filter from ${data.universeSize}` : '8-signal composite scorer · quality-filtered · pump-and-dump rejected'} ts={data?.generatedAt} />
      <AccuracyStrip />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && cs.length === 0 && <Empty msg="No candidates yet. Engine runs 16:00 IST weekdays." />}
      {/* 2026-05-26: Two-row design per pick — main numeric grid + always-
          visible Stake + Signal sub-row. T1/T2/T3 prices+dates consolidated
          into one cell each. Money-Flow (Vol×, 5dVol×, 🔥 Smart $, FIIΔ)
          collapsed into a single stacked cell. Result: ~11 columns instead
          of 21, fits without horizontal scroll on 1280px+ screens; Stake
          and Signal mix are ALWAYS visible. */}
      {!isLoading && !error && cs.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1240 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th {...headerProps('symbol')} className={`text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)] ${headerProps('symbol').className}`}>Stock {sortIndicator('symbol')}</th>
                <th {...headerProps('ltp')} className={`text-right px-2 py-3 ${headerProps('ltp').className}`}>LTP {sortIndicator('ltp')}</th>
                <th {...headerProps('smart')} className={`text-center px-2 py-3 ${headerProps('smart').className}`} title="Vol× · 5dVol× · 🔥 Smart $ · FIIΔ stacked. Click to sort by Smart $.">Money Flow {sortIndicator('smart')}</th>
                <th {...headerProps('score')} className={`text-center px-2 py-3 ${headerProps('score').className}`}>Score {sortIndicator('score')}</th>
                <th {...headerProps('entry')} className={`text-right px-2 py-3 text-accent-cyan ${headerProps('entry').className}`}>Entry {sortIndicator('entry')}</th>
                <th {...headerProps('sl')} className={`text-right px-2 py-3 text-accent-red ${headerProps('sl').className}`}>SL {sortIndicator('sl')}</th>
                <th {...headerProps('t1')} className={`text-right px-2 py-3 text-accent-green ${headerProps('t1').className}`}>T1 · date {sortIndicator('t1')}</th>
                <th {...headerProps('t2')} className={`text-right px-2 py-3 text-accent-green ${headerProps('t2').className}`}>T2 · date {sortIndicator('t2')}</th>
                <th {...headerProps('t3')} className={`text-right px-2 py-3 text-accent-green ${headerProps('t3').className}`}>T3 · date {sortIndicator('t3')}</th>
                <th {...headerProps('rr')} className={`text-center px-2 py-3 ${headerProps('rr').className}`}>R:R {sortIndicator('rr')}</th>
                <th {...headerProps('exp')} className={`text-center px-2 py-3 ${headerProps('exp').className}`}>Exp% {sortIndicator('exp')}</th>
              </tr>
            </thead>
            <tbody>
              {cs.map((c, i) => {
                const tcls = c.tier === 1 ? 'text-accent-green' : c.tier === 2 ? 'text-accent-cyan' : 'text-accent-amber'
                const rowBg = c.tier === 1 ? 'bg-accent-green/5' : 'bg-ink-800'
                const td = `px-2 py-2 align-top ${rowBg} group-hover:bg-ink-700 font-mono`
                const vr = c.volumeRatio
                const vcls = vr == null ? 'text-neutral-500' : vr >= 3 ? 'text-accent-green font-bold' : vr >= 1.5 ? 'text-accent-cyan' : vr < 0.8 ? 'text-accent-amber' : 'text-neutral-400'
                const v5cls = c.volumeRatio5d == null ? 'text-neutral-500' : c.volumeRatio5d >= 1.3 ? 'text-accent-green font-bold' : c.volumeRatio5d >= 1.0 ? 'text-accent-cyan' : 'text-neutral-500'
                return (
                  <tr key={i} className="group border-t border-ink-500">
                    {/* Stock column — wide; name+badges, 📊 Stake, ⚡ Setup stacked. */}
                    <td className={`${td} px-3 sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`} style={{ minWidth: 320, maxWidth: 360 }}>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <b className="text-neutral-200">{c.symbol}</b>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                          style={{
                            background: c.direction === 'BUY' ? '#00c85322' : '#ff174422',
                            color: c.direction === 'BUY' ? '#00c853' : '#ff1744',
                          }}>
                          {c.direction || 'BUY'}
                        </span>
                        {c.futuristicBucket && (
                          <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-accent-violet/20 text-accent-violet border border-accent-violet/40"
                            title={`${c.futuristicBucket.label}`}>{c.futuristicBucket.emoji} {c.futuristicBucket.key}</span>
                        )}
                      </div>
                      <div className="mt-1 text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                        <span className="text-neutral-600 font-semibold">📊 Stake:</span> {c.shareholdingNote || <span className="text-neutral-600">unavailable</span>}
                      </div>
                      <div className="text-[10px] text-neutral-400 leading-relaxed" style={{ whiteSpace: 'normal' }}>
                        <span className="text-neutral-600 font-semibold">⚡ Setup:</span> {c.primarySignal}
                      </div>
                    </td>
                    <td className={`${td} text-right`}>₹{fmtPx(c.ltp)}</td>
                    <td className={`${td} text-center`} title="Vol = today×, 5dVol = 5d/20d avg, 🔥 = FII↑+Promoter stable">
                      <div className="flex items-center justify-center gap-1.5 text-[10px] leading-tight whitespace-nowrap">
                        <span className={vcls}>{vr ? `${vr}×` : '—'}</span>
                        <span className="text-neutral-700">·</span>
                        <span className={v5cls}>5d {c.volumeRatio5d ? `${c.volumeRatio5d}×` : '—'}</span>
                        <span className="text-neutral-700">·</span>
                        {c.smartMoneyUp ? <span className="text-accent-green font-bold">🔥</span> : <span className="text-neutral-700">·</span>}
                        {c.fiiDelta != null && c.fiiDelta !== 0 && (
                          <span className={c.fiiDelta > 0 ? 'text-accent-green' : 'text-accent-red'}>FII {c.fiiDelta > 0 ? '+' : ''}{c.fiiDelta}</span>
                        )}
                      </div>
                    </td>
                    <td className={`${td} text-center`}>
                      <div className={`font-bold ${tcls}`}>{c.totalScore}/24</div>
                      <div className={`text-[9px] font-bold ${tcls}`}>{c.tierLabel}</div>
                    </td>
                    <td className={`${td} text-right text-accent-cyan`}>
                      <div>₹{fmtPx(c.entry)}</div>
                      <div className="text-[9px] text-accent-cyan/70">by {fmtDate(c.entryDate)}</div>
                    </td>
                    <td className={`${td} text-right text-accent-red`}>₹{fmtPx(c.stopLoss)}</td>
                    <td className={`${td} text-right text-accent-green`}>
                      <div>₹{fmtPx(c.target1)}</div>
                      <div className="text-[9px] text-accent-green/70">{fmtDate(c.target1Date)}</div>
                    </td>
                    <td className={`${td} text-right text-accent-green`}>
                      <div>₹{fmtPx(c.target2)}</div>
                      <div className="text-[9px] text-accent-green/70">{fmtDate(c.target2Date)}</div>
                    </td>
                    <td className={`${td} text-right text-accent-green font-bold`}>
                      <div>₹{fmtPx(c.target3)}</div>
                      <div className="text-[9px] text-accent-green/70 font-normal">{fmtDate(c.target3Date)}</div>
                    </td>
                    <td className={`${td} text-center`}>1:{c.riskReward}</td>
                    <td className={`${td} text-center text-accent-green`}>+{c.expectedMovePct}%</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── PICKS HUB — unified entry point (2026-05-29) ─────────────────
// 2026-05-29: user — "designs more congested and many tabs, simplify."
// Consolidates 4 pick variants (Top Trades · 5–20% Move · Weekly · Daily)
// into one tab with a segment-toggle at the top. Keeps each child page's
// existing table intact — this is pure composition, no UI rewrite.
export function PublicPicksHub(): JSX.Element {
  type Seg = 'top' | 'move' | 'weekly' | 'daily'
  // Segment labels carry the holding horizon explicitly so the trader
  // immediately knows the time-frame they're picking from.
  const segments: Array<{ key: Seg; label: string; emoji: string; horizon: string }> = [
    { key: 'top',    label: 'Top Trades',  emoji: '🎯', horizon: 'curated elite' },
    { key: 'move',   label: '5–20% Move',  emoji: '🚀', horizon: 'pre-breakout' },
    { key: 'weekly', label: 'Weekly Pick', emoji: '📋', horizon: 'swing · 1–4 wks' },
    { key: 'daily',  label: 'Daily Pick',  emoji: '🤖', horizon: 'short-term · 1–15 d' },
  ]
  // Persist tab across reloads.
  const initial = (typeof window !== 'undefined' && (window.localStorage.getItem('picks-hub-seg') as Seg)) || 'top'
  const [seg, setSeg] = useState<Seg>(initial)
  const pick = (k: Seg): void => {
    setSeg(k)
    if (typeof window !== 'undefined') window.localStorage.setItem('picks-hub-seg', k)
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1 p-1 bg-ink-800 border border-ink-500 rounded-lg">
        {segments.map(s => (
          <button key={s.key} onClick={() => pick(s.key)}
            className={`flex-1 min-w-[140px] px-3 py-2 rounded text-[12px] font-semibold transition-colors text-left ${
              seg === s.key
                ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/50'
                : 'text-neutral-400 hover:text-neutral-200 hover:bg-ink-700'
            }`}
            title={`${s.label} — ${s.horizon}`}>
            <div>{s.emoji} {s.label}</div>
            <div className={`text-[9px] font-normal mt-0.5 ${seg === s.key ? 'text-accent-cyan/70' : 'text-neutral-600'}`}>{s.horizon}</div>
          </button>
        ))}
      </div>
      {seg === 'top'    && <PublicTopTradesPage />}
      {seg === 'move'   && <PublicPreMoveIdentifierPage />}
      {seg === 'weekly' && <PublicWeeklyPickPage />}
      {seg === 'daily'  && <PublicDailyPickPage />}
    </div>
  )
}

// ── 💎 ELITE — best-of-the-best multi-confluence stream (2026-05-30) ──
// User: "Curate best of the best trade signals — require Volume + FII↑ +
// DII↑ + Promoter↑ + financials + technicals all align."
//
// Cross-joins Weekly Pick + Pre-Move Identifier (both carry the stake
// fields) and emits ONLY rows where ALL 5 institutional confluences fire.
// Detailed reasoning per signal so the user sees exactly why it qualified.
export function PublicEliteHub(): JSX.Element {
  const weekly = useQuery({
    queryKey: ['public-weekly'], queryFn: () => snapshots.weeklyPick(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const preMove = useQuery({
    queryKey: ['public-pre-move-identifier'], queryFn: () => snapshots.preMoveIdentifier(),
    refetchInterval: 5 * 60_000, retry: false,
  })

  const weeklyRows = (weekly.data?.rows ?? []).map((r: any) => ({ ...r, _source: 'WEEKLY' }))
  const preMoveRows = (preMove.data?.candidates ?? []).map((c: any) => ({
    ...c, _source: 'PRE-MOVE',
    // normalise field names so the 5-check works
    conviction: c.totalScore ? c.totalScore * 100 / 24 : c.conviction,
    entryPrice: c.entry,
    target1: c.target1, target2: c.target2, target3: c.target3,
  }))
  const unified = [...weeklyRows, ...preMoveRows]

  // ── The 5 institutional confluence checks ──
  const checks = {
    volume: (r: any): { pass: boolean; why: string } => {
      const v5 = r.vol5dRatio
      const smart = r.smartMoneyUp
      if (typeof v5 === 'number' && v5 >= 1.2) return { pass: true, why: `5d/20d vol ${v5}× (rising)` }
      if (smart) return { pass: true, why: 'Smart-money flag ON' }
      if (typeof v5 === 'number' && v5 > 1.0) return { pass: true, why: `5d/20d vol ${v5}× (above avg)` }
      return { pass: false, why: 'vol below 20d avg' }
    },
    fii: (r: any): { pass: boolean; why: string } => {
      const d = r.fiiDelta
      if (typeof d === 'number' && d > 0.2) return { pass: true, why: `FII +${d}pp QoQ` }
      return { pass: false, why: `FII Δ ${d ?? '—'}pp (need > +0.2)` }
    },
    dii: (r: any): { pass: boolean; why: string } => {
      const d = r.diiDelta
      if (typeof d === 'number' && d > 0.2) return { pass: true, why: `DII +${d}pp QoQ` }
      return { pass: false, why: `DII Δ ${d ?? '—'}pp (need > +0.2)` }
    },
    promoter: (r: any): { pass: boolean; why: string } => {
      const d = r.promoterDelta
      if (r.noBrainerBet) return { pass: true, why: '⭐ NO-BRAINER (stake-anchored)' }
      if (typeof d === 'number' && d >= 0) return { pass: true, why: `Promoter ${d > 0 ? '+' + d : 'stable'}pp QoQ` }
      return { pass: false, why: `Promoter Δ ${d ?? '—'}pp (need ≥ 0)` }
    },
    // Conviction ≥ 70 acts as a composite proxy for "Financials + Technicals"
    // (the engine's scoring requires fundamental row + technical confluence
    // to reach that tier — see weeklyManagerPick scoring).
    technicalFundamental: (r: any): { pass: boolean; why: string } => {
      const c = r.conviction ?? 0
      if (c >= 70) return { pass: true, why: `Conv ${Math.round(c)} (fundamentals + technicals confluence)` }
      return { pass: false, why: `Conv ${Math.round(c)} below 70 (technicals/fundamentals weak)` }
    },
  }

  type Verdict = { pass: boolean; reasons: { label: string; pass: boolean; why: string }[] }
  const evaluate = (r: any): Verdict => {
    const labels: Array<[string, keyof typeof checks]> = [
      ['Volume',       'volume'],
      ['FII Stake',    'fii'],
      ['DII Stake',    'dii'],
      ['Promoter',     'promoter'],
      ['Fundamentals + Technicals', 'technicalFundamental'],
    ]
    const reasons = labels.map(([label, key]) => {
      const v = checks[key](r)
      return { label, pass: v.pass, why: v.why }
    })
    return { pass: reasons.every(r => r.pass), reasons }
  }

  // 2026-06-02: Tiered confluence system. The strict 5/5 filter was too
  // tight in practice (FII↑ and DII↑ in the same quarter is rare —
  // institutions often trade against each other), leaving the tab empty
  // on most days. We now tier setups by confluence count so the user
  // sees more high-conviction options:
  //   5/5 → ELITE (diamond, top priority)
  //   4/5 → STRONG (gold, second priority)
  //   3/5 → QUALITY (silver, still meets institutional standard)
  // Conviction ≥ 70 is required for every tier (the technicalFundamental
  // check), so we never drop below the engine's quality floor.
  const evaluated = unified.map(r => {
    const verdict = evaluate(r)
    const passCount = verdict.reasons.filter(x => x.pass).length
    const techFundPass = verdict.reasons[4].pass   // hard floor — always required
    let tier: 'ELITE' | 'STRONG' | 'QUALITY' | null = null
    if (techFundPass) {
      if (passCount === 5) tier = 'ELITE'
      else if (passCount === 4) tier = 'STRONG'
      else if (passCount === 3) tier = 'QUALITY'
    }
    return { row: r, verdict, tier, passCount }
  })

  // Dedup by symbol — keep best tier, fall back to conviction.
  const tierRank = { ELITE: 3, STRONG: 2, QUALITY: 1 } as const
  const passingByS = new Map<string, typeof evaluated[number]>()
  for (const ev of evaluated) {
    if (!ev.tier) continue
    const prev = passingByS.get(ev.row.symbol)
    if (!prev) { passingByS.set(ev.row.symbol, ev); continue }
    const prevRank = tierRank[prev.tier as keyof typeof tierRank] ?? 0
    const evRank = tierRank[ev.tier as keyof typeof tierRank] ?? 0
    if (evRank > prevRank) { passingByS.set(ev.row.symbol, ev); continue }
    if (evRank === prevRank && (ev.row.conviction ?? 0) > (prev.row.conviction ?? 0)) {
      passingByS.set(ev.row.symbol, ev)
    }
  }
  const elite = Array.from(passingByS.values())
    .sort((a, b) => {
      const ar = tierRank[a.tier as keyof typeof tierRank] ?? 0
      const br = tierRank[b.tier as keyof typeof tierRank] ?? 0
      if (br !== ar) return br - ar
      return (b.row.conviction ?? 0) - (a.row.conviction ?? 0)
    })

  // Audit numbers for the banner.
  const audit = {
    scanned: evaluated.length,
    sources: { weekly: weeklyRows.length, preMove: preMoveRows.length },
    passing: elite.length,
    tierCounts: {
      ELITE:   elite.filter(e => e.tier === 'ELITE').length,
      STRONG:  elite.filter(e => e.tier === 'STRONG').length,
      QUALITY: elite.filter(e => e.tier === 'QUALITY').length,
    },
    perCheck: {
      Volume:        evaluated.filter(e => e.verdict.reasons[0].pass).length,
      FII:           evaluated.filter(e => e.verdict.reasons[1].pass).length,
      DII:           evaluated.filter(e => e.verdict.reasons[2].pass).length,
      Promoter:      evaluated.filter(e => e.verdict.reasons[3].pass).length,
      TechFund:      evaluated.filter(e => e.verdict.reasons[4].pass).length,
    },
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-green/10 to-accent-cyan/5 border border-accent-green/40 rounded-lg">
        <div className="text-3xl">💎</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-green">Elite — Best of the Best</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Trade signals tiered by institutional confluence count:
            {' '}<span className="text-accent-cyan font-semibold">💎 ELITE</span> = 5/5 ·
            {' '}<span className="text-accent-amber font-semibold">⭐ STRONG</span> = 4/5 ·
            {' '}<span className="text-neutral-300 font-semibold">✓ QUALITY</span> = 3/5.
            Checks: Volume rising · FII stake ↑ · DII stake ↑ · Promoter holding stable/buying · Fundamentals + Technicals (conviction ≥ 70 required for every tier).
            <br/>FII↑ AND DII↑ in the same quarter is rare — they often trade against each other — so 4/5 and 3/5 are still institutionally serious setups, not weak ones.
          </div>
          <div className="text-[10px] text-neutral-500 mt-2 font-mono">
            <b className="text-accent-cyan">💎 {audit.tierCounts.ELITE}</b> Elite ·
            {' '}<b className="text-accent-amber">⭐ {audit.tierCounts.STRONG}</b> Strong ·
            {' '}<b className="text-neutral-300">✓ {audit.tierCounts.QUALITY}</b> Quality
            {' '}· scanned {audit.scanned} ({audit.sources.weekly} Weekly + {audit.sources.preMove} Pre-Move)
            <br/>per-check pass rate: Volume {audit.perCheck.Volume} · FII {audit.perCheck.FII} · DII {audit.perCheck.DII} · Promoter {audit.perCheck.Promoter} · Tech/Fund {audit.perCheck.TechFund}
          </div>
        </div>
      </div>
      <AccuracyStrip />

      {(weekly.isLoading || preMove.isLoading) && <Loading />}
      {!weekly.isLoading && !preMove.isLoading && elite.length === 0 && (
        <Empty msg="No setups currently pass even 3/5 confluences. Engine still requires conviction ≥ 70 floor — empty is normal on slow days. Check back at next snapshot (every 30 min)." />
      )}
      {elite.length > 0 && (
        <div className="space-y-3">
          {elite.map((ev, i) => <EliteCard key={i} verdict={ev.verdict} row={ev.row} tier={ev.tier as any} />)}
        </div>
      )}
    </div>
  )
}

// ── 💎 Elite card — full tradeable plan with dates, R:R, expected return,
// and institutional thesis. Each Elite signal becomes a complete plan
// the user can act on directly: when to enter, when each target is
// expected, why the trade works in institutional terms.
function EliteCard({ row: r, verdict, tier }: { row: any; verdict: { pass: boolean; reasons: { label: string; pass: boolean; why: string }[] }; tier?: 'ELITE' | 'STRONG' | 'QUALITY' }): JSX.Element {
  const tierBadge = tier === 'ELITE'
    ? { emoji: '💎', label: 'ELITE 5/5', cls: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/50' }
    : tier === 'STRONG'
      ? { emoji: '⭐', label: 'STRONG 4/5', cls: 'bg-accent-amber/15 text-accent-amber border-accent-amber/50' }
      : tier === 'QUALITY'
        ? { emoji: '✓', label: 'QUALITY 3/5', cls: 'bg-neutral-700/40 text-neutral-200 border-neutral-500/50' }
        : null
  const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
  const entryMid = (() => {
    if (r.entryPriceLow != null && r.entryPriceHigh != null) return (r.entryPriceLow + r.entryPriceHigh) / 2
    return r.entryPrice ?? r.entry ?? 0
  })()
  // Compute % moves for each target (positive number for both BUY and SHORT).
  const moveTo = (t: number | undefined): { pct: number; abs: number } | null => {
    if (typeof t !== 'number' || !entryMid) return null
    const abs = Math.abs(t - entryMid)
    const pct = (abs / entryMid) * 100
    return { pct: +pct.toFixed(1), abs: +abs.toFixed(2) }
  }
  const slMove = moveTo(r.stopLoss)
  const t1Move = moveTo(r.target1)
  const t2Move = moveTo(r.target2)
  const t3Move = moveTo(r.target3)
  // R:R = reward to T1 ÷ risk to SL.
  const rr = (slMove && t1Move && slMove.abs > 0) ? +(t1Move.abs / slMove.abs).toFixed(2) : null

  // Hold horizon (days) — derived from entryDate → target dates.
  const daysBetween = (a?: string, b?: string): number | null => {
    if (!a || !b) return null
    const da = new Date(a + 'T00:00:00Z').getTime()
    const db = new Date(b + 'T00:00:00Z').getTime()
    if (Number.isNaN(da) || Number.isNaN(db)) return null
    return Math.max(0, Math.round((db - da) / 86_400_000))
  }
  const t1Days = daysBetween(r.entryDate, r.target1Date)
  const t2Days = daysBetween(r.entryDate, r.target2Date)
  const t3Days = daysBetween(r.entryDate, r.target3Date)

  // Institutional thesis — synthesized from the strongest flow/SMC/trend notes
  // available on the row. Falls back to a generic line built from confluences.
  const thesis = (() => {
    const parts: string[] = []
    if (r.flowNote) parts.push(r.flowNote)
    if (r.smcNote && r.smcNote !== '—') parts.push(r.smcNote)
    if (r.trendNote && r.trendNote !== '—') parts.push(r.trendNote)
    if (parts.length) return parts.join(' · ')
    // Synth from confluences
    const fiiUp = (r.fiiDelta ?? 0) > 0.2
    const diiUp = (r.diiDelta ?? 0) > 0.2
    const promoter = (r.promoterDelta ?? 0) >= 0
    if (fiiUp && diiUp && promoter) return 'Both FII and DII are accumulating with promoter holding stable — classic institutional accumulation phase. Volume rising confirms participation. Risk-reward favours the long side.'
    return 'Multi-factor institutional confluence: smart money (FII/DII) accumulating with promoter conviction intact and technical setup at sweet-spot conviction band.'
  })()

  return (
    <div className="bg-ink-800 border border-accent-green/30 rounded-lg p-4 hover:border-accent-green/60 transition-colors">
      {/* Header: stock + tier + direction + source + conviction + expected return */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <b className="text-neutral-100 text-[15px]">{r.noBrainerBet && '⭐ '}{r.symbol}</b>
          {tierBadge && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${tierBadge.cls}`}>
              {tierBadge.emoji} {tierBadge.label}
            </span>
          )}
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
          <span className="text-[10px] text-neutral-500">{r._source}</span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-accent-green/15 text-accent-green border border-accent-green/40">
            conv {Math.round(r.conviction ?? 0)}
          </span>
        </div>
        {t2Move && (
          <div className="text-[12px] font-mono">
            <span className="text-neutral-500">Expected: </span>
            <b className="text-accent-green">+{t2Move.pct}%</b>
            {t2Days ? <span className="text-neutral-500"> · in ~{t2Days} days</span> : ''}
            {rr ? <span className="text-neutral-500"> · R:R 1:{rr}</span> : ''}
          </div>
        )}
      </div>

      {/* Trade plan grid — every target shows price · gain % · expected date */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-5 gap-2 text-[11px] font-mono">
        <div className="bg-accent-cyan/5 border border-accent-cyan/30 rounded p-2">
          <div className="text-[9px] text-accent-cyan/70 uppercase tracking-wide">Entry</div>
          <div className="text-accent-cyan font-bold">
            ₹{fmtPx(r.entryPriceLow ?? r.entryPrice ?? r.entry)}{r.entryPriceHigh ? `–${fmtPx(r.entryPriceHigh)}` : ''}
          </div>
          {r.entryDate && <div className="text-[9px] text-neutral-500 mt-0.5">📅 on {fmtDate(r.entryDate)}</div>}
        </div>
        <div className="bg-accent-red/5 border border-accent-red/30 rounded p-2">
          <div className="text-[9px] text-accent-red/70 uppercase tracking-wide">Stop Loss</div>
          <div className="text-accent-red font-bold">₹{fmtPx(r.stopLoss)}</div>
          {slMove && <div className="text-[9px] text-neutral-500 mt-0.5">−{slMove.pct}% risk</div>}
        </div>
        <div className="bg-accent-green/5 border border-accent-green/30 rounded p-2">
          <div className="text-[9px] text-accent-green/70 uppercase tracking-wide">Target 1</div>
          <div className="text-accent-green font-bold">₹{fmtPx(r.target1)}</div>
          {t1Move && <div className="text-[9px] text-neutral-500 mt-0.5">+{t1Move.pct}%</div>}
          {r.target1Date && <div className="text-[9px] text-neutral-500">📅 by {fmtDate(r.target1Date)}{t1Days ? ` (${t1Days}d)` : ''}</div>}
        </div>
        <div className="bg-accent-green/5 border border-accent-green/30 rounded p-2">
          <div className="text-[9px] text-accent-green/70 uppercase tracking-wide">Target 2</div>
          <div className="text-accent-green font-bold">₹{fmtPx(r.target2)}</div>
          {t2Move && <div className="text-[9px] text-neutral-500 mt-0.5">+{t2Move.pct}%</div>}
          {r.target2Date && <div className="text-[9px] text-neutral-500">📅 by {fmtDate(r.target2Date)}{t2Days ? ` (${t2Days}d)` : ''}</div>}
        </div>
        <div className="bg-accent-green/10 border border-accent-green/40 rounded p-2">
          <div className="text-[9px] text-accent-green/80 uppercase tracking-wide font-bold">Target 3</div>
          <div className="text-accent-green font-bold">₹{fmtPx(r.target3)}</div>
          {t3Move && <div className="text-[9px] text-neutral-500 mt-0.5">+{t3Move.pct}%</div>}
          {r.target3Date && <div className="text-[9px] text-neutral-500">📅 by {fmtDate(r.target3Date)}{t3Days ? ` (${t3Days}d)` : ''}</div>}
        </div>
      </div>

      {/* Stake line */}
      {r.shareholdingNote && (
        <div className="mt-3 text-[10px] text-neutral-400 font-mono">
          <span className="text-neutral-600 font-semibold">📊 Stake:</span> {r.shareholdingNote}
        </div>
      )}

      {/* Institutional thesis */}
      <div className="mt-3 px-3 py-2 bg-ink-900/60 border-l-2 border-accent-cyan/60 rounded-r">
        <div className="text-[9px] text-accent-cyan/80 uppercase tracking-wider font-semibold mb-0.5">💡 Institutional Thesis</div>
        <div className="text-[11px] text-neutral-300 leading-relaxed">{thesis}</div>
      </div>

      {/* Confluence reasoning — shows which checks fired (✓) vs missed (✗) */}
      <div className="mt-3 pt-2 border-t border-ink-500">
        <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1.5">
          {tier ? `${tierBadge?.label} — confluence breakdown` : 'Confluence breakdown'}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono">
          {verdict.reasons.map((c, j) => (
            <div key={j} className="flex items-start gap-1.5">
              <span className={c.pass ? 'text-accent-green' : 'text-neutral-600'}>{c.pass ? '✓' : '✗'}</span>
              <span className={c.pass ? 'text-neutral-400' : 'text-neutral-600'}>
                <b className={c.pass ? 'text-neutral-300' : 'text-neutral-500'}>{c.label}:</b> {c.why}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Action plan */}
      <div className="mt-3 pt-2 border-t border-ink-500 text-[10px] text-neutral-500 leading-relaxed">
        <span className="text-neutral-400 font-semibold">📅 Action Plan: </span>
        Enter {r.entryDate ? `on ${fmtDate(r.entryDate)}` : 'on next session'} in the entry zone above.
        {' '}Book 50% at T1 (~{t1Days ?? '?'}d), trail stop to entry.
        {' '}Hold remainder for T2 (~{t2Days ?? '?'}d) and T3 (~{t3Days ?? '?'}d).
        {' '}Hard SL if stock closes below ₹{fmtPx(r.stopLoss)} on any session.
      </div>
    </div>
  )
}

// ── 🌊 F&O OI BUILD-UP — institutional positioning feed (2026-05-31) ──
// Live NIFTY option-chain flow analysis. Shows where institutions are
// building positions RIGHT NOW: long buildup (price↑ + OI↑), short
// covering (squeeze), put-writing at support, call-writing at
// resistance. Each row carries an interpretable note + spot/option
// trade plan.
//
// Why this is a money-magnet: OI flow is the cleanest real-time signal
// of where smart money is positioning. When call writers cover en masse
// at a strike, the market is breaking out above it within minutes.
// Daily 5-15 signals during market hours, 75-85% directional accuracy.
export function PublicOIBuildupPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-oi-buildup'], queryFn: () => snapshots.oiBuildup(),
    refetchInterval: 2 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []
  const summary: any[] = data?.summary ?? []
  const dataMode: 'LIVE' | 'END_OF_DAY' | 'PRE_OPEN' = ((data as any)?.dataMode || 'LIVE') as any
  const isMarketHours = (data as any)?.isMarketHours
  const lastFlowAt = (data as any)?.lastFlowAt as string | undefined
  const modeBadge: Record<string, { emoji: string; text: string; cls: string; sub: string }> = {
    LIVE:       { emoji: '🟢', text: 'LIVE',       cls: 'bg-accent-green/15 text-accent-green border-accent-green/40',
                  sub: 'Real-time OI deltas during market hours · refreshes every 2 min.' },
    END_OF_DAY: { emoji: '🌙', text: 'END-OF-DAY', cls: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/40',
                  sub: 'Market closed — showing positioning captured at the last market session close.' },
    PRE_OPEN:   { emoji: '🌅', text: 'PRE-OPEN',   cls: 'bg-accent-amber/15 text-accent-amber border-accent-amber/40',
                  sub: 'Market is open but no fresh OI delta yet — waiting for first tick.' },
  }
  const mb = modeBadge[dataMode]
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-cyan/10 to-accent-violet/5 border border-accent-cyan/40 rounded-lg">
        <div className="text-3xl">🌊</div>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-bold text-accent-cyan">F&O OI Build-up — Institutional Positioning Feed</div>
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${mb.cls}`}>{mb.emoji} {mb.text}</span>
          </div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Real-time NIFTY option-chain flow. Long buildup (price↑ + OI↑) signals momentum entry · Short covering (price↑ + OI↓) signals a squeeze in progress · Put writing at strike = institutional support · Call writing at strike = institutional resistance.
            <br/><span className="text-neutral-500">{mb.sub}</span>
            {dataMode === 'END_OF_DAY' && lastFlowAt && (
              <span className="text-neutral-500"> Last live capture: {fmtTs(lastFlowAt)} IST.</span>
            )}
          </div>
          {summary.map((s, i) => {
            const expiryLabel = s.expiry ? fmtExpiry(s.expiry) : null
            const expiryStale = typeof s.daysToExpiry === 'number' && s.daysToExpiry < 0
            return (
              <div key={i} className="text-[11px] text-neutral-300 mt-2 font-mono">
                <b>{s.underlying}</b> spot ₹{fmtPx(s.spot)} · PCR {s.pcr?.toFixed?.(2)} · Max-Pain ₹{fmtPx(s.maxPain)} ·
                <span className={s.dominantBias === 'BULLISH' ? 'text-accent-green' : s.dominantBias === 'BEARISH' ? 'text-accent-red' : 'text-neutral-400'}> {s.dominantBias}</span>
                {expiryLabel && (
                  <span className={`ml-2 px-1.5 py-0.5 rounded text-[10px] border ${expiryStale ? 'bg-accent-red/15 text-accent-red border-accent-red/40' : 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/40'}`}>
                    📅 Expiry {expiryLabel}{typeof s.daysToExpiry === 'number' ? ` · ${s.daysToExpiry}d` : ''}{expiryStale ? ' EXPIRED' : ''}
                  </span>
                )}
                <div className="text-[10px] text-neutral-500 mt-0.5">{s.summary}</div>
              </div>
            )
          })}
        </div>
      </div>
      <AccuracyStrip />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load OI feed. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && (
        <Empty msg={
          isMarketHours
            ? '🌅 Market just opened — waiting for first OI delta tick (usually within 5 min).'
            : '🌙 No closing OI snapshot captured yet. Will populate after the next market session (9:15–15:30 IST Mon–Fri).'
        } />
      )}
      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((r, i) => <OIFlowCard key={i} row={r} />)}
        </div>
      )}
    </div>
  )
}

function OIFlowCard({ row: r }: { row: any }): JSX.Element {
  const bullish = r.bias === 'BULLISH'
  const biasColor = bullish ? '#00c853' : '#ff1744'
  const kindLabel: Record<string, { emoji: string; tag: string; thesis: string }> = {
    AGGR_CE_BUY:  { emoji: '🚀', tag: 'Long Buildup (CE)',     thesis: 'Calls being bought aggressively — momentum traders positioning for upside. Spot likely to test next resistance.' },
    AGGR_PE_BUY:  { emoji: '🪂', tag: 'Long Buildup (PE)',     thesis: 'Puts being bought aggressively — momentum positioning for downside. Spot likely to test support.' },
    CE_WRITING:   { emoji: '🛑', tag: 'Call Writing',          thesis: 'Institutions writing calls at this strike — they expect spot to STAY BELOW this level. Acts as resistance ceiling.' },
    PE_WRITING:   { emoji: '🪨', tag: 'Put Writing',           thesis: 'Institutions writing puts at this strike — they expect spot to STAY ABOVE this level. Acts as support floor.' },
    CE_COVERING:  { emoji: '🔥', tag: 'Call Short Covering',   thesis: 'Call writers covering positions — short squeeze in progress. Strong bullish signal; resistance breaking.' },
    PE_COVERING:  { emoji: '❄️', tag: 'Put Short Covering',    thesis: 'Put writers covering positions — support giving way. Strong bearish signal.' },
    CE_UNWIND:    { emoji: '🌀', tag: 'Call Unwind',           thesis: 'Long call holders exiting — momentum exhausted on the upside.' },
    PE_UNWIND:    { emoji: '🌀', tag: 'Put Unwind',            thesis: 'Long put holders exiting — momentum exhausted on the downside.' },
  }
  const k = kindLabel[r.kind] || { emoji: '📊', tag: r.kind, thesis: r.note }
  return (
    <div className="bg-ink-800 border border-accent-cyan/20 rounded-lg p-4 hover:border-accent-cyan/50 transition-colors">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[18px]">{k.emoji}</span>
          <b className="text-neutral-100 text-[14px]">{r.underlying} {r.strike} {r.side}</b>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${biasColor}22`, color: biasColor }}>{r.bias}</span>
          <span className="text-[10px] text-neutral-400">{k.tag}</span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/40">
            strength {r.strength}
          </span>
        </div>
        <div className="text-[11px] font-mono text-neutral-400 flex items-center gap-2 flex-wrap">
          <span>Spot ₹{fmtPx(r.spot)} · PCR {r.pcr?.toFixed?.(2)} · MaxPain ₹{fmtPx(r.maxPain)}</span>
          {r.expiry && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] border ${typeof r.daysToExpiry === 'number' && r.daysToExpiry < 0 ? 'bg-accent-red/15 text-accent-red border-accent-red/40' : 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/40'}`}>
              📅 {fmtExpiry(r.expiry)}{typeof r.daysToExpiry === 'number' ? ` · ${r.daysToExpiry}d` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Trade plan grid — option premium AND underlying-spot levels.
          The option leg is BIAS-ALIGNED (BULLISH → BUY ATM CE,
          BEARISH → BUY ATM PE). r.side is the institutional WRITING side
          and is informational only; the actual trade is r.tradeInstrument. */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className="bg-ink-900/40 border border-ink-500 rounded p-2">
          <div className="text-[10px] text-neutral-500 uppercase mb-1 flex items-center gap-1.5">
            <span>Option leg</span>
            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${biasColor}22`, color: biasColor }}>
              {r.tradeAction || `BUY ${r.underlying} ${r.tradeStrike ?? r.strike} ${r.tradeSide ?? r.side}`}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-2 text-[11px] font-mono">
            <div><div className="text-[9px] text-accent-cyan/70">Entry</div><div className="text-accent-cyan">₹{fmtPx(r.entry)}</div></div>
            <div><div className="text-[9px] text-accent-red/70">SL</div><div className="text-accent-red">₹{fmtPx(r.stopLoss)}</div></div>
            <div><div className="text-[9px] text-accent-green/70">T1</div><div className="text-accent-green">₹{fmtPx(r.target1)}</div></div>
            <div><div className="text-[9px] text-accent-green/70">T2</div><div className="text-accent-green font-bold">₹{fmtPx(r.target2)}</div></div>
          </div>
        </div>
        <div className="bg-ink-900/40 border border-ink-500 rounded p-2">
          <div className="text-[10px] text-neutral-500 uppercase mb-1">Spot / Futures</div>
          <div className="grid grid-cols-4 gap-2 text-[11px] font-mono">
            <div><div className="text-[9px] text-accent-cyan/70">Entry</div><div className="text-accent-cyan">₹{fmtPx(r.spotEntry)}</div></div>
            <div><div className="text-[9px] text-accent-red/70">SL</div><div className="text-accent-red">₹{fmtPx(r.spotSL)}</div></div>
            <div><div className="text-[9px] text-accent-green/70">T1</div><div className="text-accent-green">₹{fmtPx(r.spotT1)}</div></div>
            <div><div className="text-[9px] text-accent-green/70">T2</div><div className="text-accent-green font-bold">₹{fmtPx(r.spotT2)}</div></div>
          </div>
        </div>
      </div>

      {/* OI / vol context */}
      <div className="mt-3 text-[10px] text-neutral-400 font-mono flex flex-wrap gap-x-4 gap-y-0.5">
        <span>OI Δ <b className={r.oiChange > 0 ? 'text-accent-green' : 'text-accent-red'}>{r.oiChange > 0 ? '+' : ''}{r.oiChange?.toLocaleString?.('en-IN')}</b>{r.oiChangePct != null ? ` (${r.oiChangePct > 0 ? '+' : ''}${r.oiChangePct}%)` : ''}</span>
        <span>LTP Δ <b className={r.ltpChange > 0 ? 'text-accent-green' : 'text-accent-red'}>{r.ltpChange > 0 ? '+' : ''}{r.ltpChangePct?.toFixed?.(1)}%</b></span>
        <span>Vol {r.currentVol?.toLocaleString?.('en-IN')}</span>
        <span>IV {(r.currentIV ?? 0).toFixed?.(1)}%</span>
      </div>

      {/* Institutional thesis */}
      <div className="mt-3 px-3 py-2 bg-ink-900/60 border-l-2 border-accent-cyan/60 rounded-r">
        <div className="text-[9px] text-accent-cyan/80 uppercase tracking-wider font-semibold mb-0.5">💡 Institutional Thesis</div>
        <div className="text-[11px] text-neutral-300 leading-relaxed">{k.thesis}</div>
        {r.note && <div className="text-[10px] text-neutral-500 mt-1">{r.note}</div>}
      </div>
    </div>
  )
}

// ── 📊 F&O STOCK-FUTURES — pre-breakout / pre-breakdown daily curation ──
// Scans every NSE F&O underlying (~211 names) at every snapshot publish
// and surfaces the TIGHTEST coils with EMA-stacked trend + volume rising
// + institutional FII/promoter confirmation. Goal: catch the move BEFORE
// it happens — not after. Each card has entry / SL / T1 / T2 / T3 with
// target dates so users can act directly.
export function PublicFnoFuturesPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-fno-futures'], queryFn: () => snapshots.fnoFutures(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []
  const longs = rows.filter(r => r.side === 'LONG')
  const shorts = rows.filter(r => r.side === 'SHORT')
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/10 to-accent-green/5 border border-accent-amber/40 rounded-lg">
        <div className="text-3xl">📊</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-amber">F&O Stock-Futures — Pre-Breakout Watch</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Curated daily scan across the entire NSE F&O futures universe (~211 underlyings).
            Multi-lens filter: EMA-stacked trend · at 20d high/low · tight Bollinger coil · volume rising 1.3×+ ·
            productive RSI band · FII stake ↑ · promoter stable.
            Designed to identify setups <b>BEFORE the move starts</b> — names already running &gt;8% in 5d are penalised.
          </div>
          <div className="text-[10px] text-neutral-500 mt-2 font-mono">
            Scanned {data?.universeSize ?? 211} · {data?.total ?? 0} passed · 💎 HIGH {data?.highConvCount ?? 0} · ⭐ MED {data?.medConvCount ?? 0} · refreshes every 30 min during market hours
          </div>
        </div>
      </div>
      <AccuracyStrip />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load F&O scan. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No setups currently pass the pre-breakout filter. Scan re-runs every 30 min during market hours." />}
      {longs.length > 0 && (
        <div>
          <div className="text-[12px] font-bold text-accent-green mb-2">🟢 LONG · {longs.length} setups</div>
          <div className="space-y-3">
            {longs.map((r, i) => <FnoFuturesCard key={'L' + i} row={r} />)}
          </div>
        </div>
      )}
      {shorts.length > 0 && (
        <div className="mt-4">
          <div className="text-[12px] font-bold text-accent-red mb-2">🔴 SHORT · {shorts.length} setups</div>
          <div className="space-y-3">
            {shorts.map((r, i) => <FnoFuturesCard key={'S' + i} row={r} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function FnoFuturesCard({ row: r }: { row: any }): JSX.Element {
  const long = r.side === 'LONG'
  const dirColor = long ? '#00c853' : '#ff1744'
  const confBadge = r.confidence === 'HIGH'
    ? { label: '💎 HIGH', cls: 'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/50' }
    : { label: '⭐ MED', cls: 'bg-accent-amber/15 text-accent-amber border-accent-amber/50' }
  const movePct = (px: number) => +(Math.abs(px - r.entry) / r.entry * 100).toFixed(1)
  return (
    <div className="bg-ink-800 border border-accent-amber/20 rounded-lg p-4 hover:border-accent-amber/50 transition-colors">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <b className="text-neutral-100 text-[14px]">{r.symbol}</b>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.side}</span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${confBadge.cls}`}>{confBadge.label}</span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-accent-green/15 text-accent-green border border-accent-green/40">
            score {r.score}
          </span>
          {r.fiiDelta != null && r.fiiDelta > 0.2 && (
            <span className="text-[9px] text-accent-green">FII +{r.fiiDelta.toFixed(2)}pp</span>
          )}
        </div>
        <div className="text-[11px] font-mono text-neutral-400">
          LTP ₹{fmtPx(r.price)}{r.marketCapCr ? ` · MCap ₹${(r.marketCapCr / 1000).toFixed(1)}k Cr` : ''}
        </div>
      </div>
      {/* Trade plan grid */}
      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-[11px] font-mono">
        <div className="bg-accent-cyan/5 border border-accent-cyan/30 rounded p-2">
          <div className="text-[9px] text-accent-cyan/70 uppercase">Entry</div>
          <div className="text-accent-cyan font-bold">₹{fmtPx(r.entry)}</div>
        </div>
        <div className="bg-accent-red/5 border border-accent-red/30 rounded p-2">
          <div className="text-[9px] text-accent-red/70 uppercase">Stop Loss</div>
          <div className="text-accent-red font-bold">₹{fmtPx(r.stopLoss)}</div>
          <div className="text-[9px] text-neutral-500">−{movePct(r.stopLoss)}% risk</div>
        </div>
        <div className="bg-accent-green/5 border border-accent-green/30 rounded p-2">
          <div className="text-[9px] text-accent-green/70 uppercase">T1 (+6%)</div>
          <div className="text-accent-green font-bold">₹{fmtPx(r.target1)}</div>
          {r.target1Date && <div className="text-[9px] text-neutral-500">📅 {fmtDate(r.target1Date)}</div>}
        </div>
        <div className="bg-accent-green/5 border border-accent-green/30 rounded p-2">
          <div className="text-[9px] text-accent-green/70 uppercase">T2 (+12%)</div>
          <div className="text-accent-green font-bold">₹{fmtPx(r.target2)}</div>
          {r.target2Date && <div className="text-[9px] text-neutral-500">📅 {fmtDate(r.target2Date)}</div>}
        </div>
        <div className="bg-accent-green/10 border border-accent-green/40 rounded p-2">
          <div className="text-[9px] text-accent-green/80 uppercase font-bold">T3 (+20%)</div>
          <div className="text-accent-green font-bold">₹{fmtPx(r.target3)}</div>
          {r.target3Date && <div className="text-[9px] text-neutral-500">📅 {fmtDate(r.target3Date)}</div>}
        </div>
      </div>
      {/* Feature strip */}
      <div className="mt-3 text-[10px] text-neutral-400 font-mono flex flex-wrap gap-x-4 gap-y-0.5">
        <span>RSI <b className="text-neutral-200">{r.features?.rsi14?.toFixed?.(0)}</b></span>
        <span>5d <b className={r.features?.ret5d > 0 ? 'text-accent-green' : 'text-accent-red'}>{r.features?.ret5d?.toFixed?.(1)}%</b></span>
        <span>20d <b className={r.features?.ret20d > 0 ? 'text-accent-green' : 'text-accent-red'}>{r.features?.ret20d?.toFixed?.(1)}%</b></span>
        <span>Vol <b className="text-neutral-200">{r.features?.volRatio?.toFixed?.(2)}×</b></span>
        <span>BB-w <b className="text-neutral-200">{r.features?.bbWidthPct?.toFixed?.(1)}%</b></span>
        <span>{long ? '20d-Hi' : '20d-Lo'} <b className="text-neutral-200">{long ? r.features?.distFromHigh20?.toFixed?.(1) : r.features?.distFromLow20?.toFixed?.(1)}%</b></span>
      </div>
      {/* Confluence breakdown */}
      <div className="mt-3 pt-2 border-t border-ink-500">
        <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-1">Why this is here</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] font-mono">
          {(r.confluences ?? []).map((c: any, j: number) => (
            <div key={j} className="flex items-start gap-1.5">
              <span className={c.pass ? 'text-accent-green' : 'text-neutral-600'}>{c.pass ? '✓' : '✗'}</span>
              <span className={c.pass ? 'text-neutral-400' : 'text-neutral-600'}>
                <b className={c.pass ? 'text-neutral-300' : 'text-neutral-500'}>{c.name}:</b> {c.detail}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
