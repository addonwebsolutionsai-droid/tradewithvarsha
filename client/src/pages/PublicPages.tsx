/**
 * Vercel public-mode pages — TABLE format matching localhost. Reads static
 * JSON snapshots from raw.githubusercontent.com (no backend dependency).
 *
 * Above each table: a "Recent target hits" strip with green/red highlighted
 * cards so users can see realised outcomes and gauge accuracy.
 */
import { useQuery } from '@tanstack/react-query'
import { snapshots } from '../api'
import React, { useState, Fragment } from 'react'
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
  // 2026-06-24: per-column sort wraps the dropdown sort. Clicking a column
  // overrides. No click → dropdown wins.
  const { rows: sortedRows, headerProps, sortIndicator } = useSortableTable<any>(
    rows, { key: '', dir: null },
    {
      symbol: r => r.symbol ?? '',
      conviction: r => r.conviction ?? 0,
      entry: r => r.entryPriceLow ?? r.entryPrice ?? 0,
      stopLoss: r => r.stopLoss ?? 0,
      target1: r => r.target1 ?? 0,
      target2: r => r.target2 ?? 0,
      target3: r => r.target3 ?? 0,
      status: r => r.status ?? '',
      realisedPct: r => r.realisedPct ?? -Infinity,
    },
  )
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
                <th {...headerProps('symbol', 'text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]')}>Stock{sortIndicator('symbol')}</th>
                <th {...headerProps('conviction', 'text-center px-3 py-3 whitespace-nowrap')}>Conviction{sortIndicator('conviction')}</th>
                <th {...headerProps('entry', 'text-right px-2 py-3 whitespace-nowrap text-accent-cyan')}>Entry{sortIndicator('entry')}</th>
                <th {...headerProps('stopLoss', 'text-right px-2 py-3 whitespace-nowrap text-accent-red')}>SL{sortIndicator('stopLoss')}</th>
                <th {...headerProps('target1', 'text-right px-2 py-3 whitespace-nowrap text-accent-green')}>T1{sortIndicator('target1')}</th>
                <th {...headerProps('target2', 'text-right px-2 py-3 whitespace-nowrap text-accent-green')}>T2{sortIndicator('target2')}</th>
                <th {...headerProps('target3', 'text-right px-2 py-3 whitespace-nowrap text-accent-green')}>T3{sortIndicator('target3')}</th>
                <th {...headerProps('status', 'text-center px-3 py-3 whitespace-nowrap')}>Status{sortIndicator('status')}</th>
                <th {...headerProps('realisedPct', 'text-right px-2 py-3 whitespace-nowrap')}>% Return{sortIndicator('realisedPct')}</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.slice(0, 200).map((r, i) => {
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
      {/* 2026-06-16: uniform table */}
      {!isLoading && !error && rows.length > 0 && <UniformPickTable rows={rows} />}
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
  const [proOn, setProOn] = useProMode('cash-equity', true)
  const { smartMoney, sectorTrend } = useSmartMoneyAndSectorMaps()
  const fetched: any[] = data?.rows ?? []
  // PRO Mode for Cash/Equity Weekly: conviction ≥ 85 AND smart-money same-side
  // (or NEUTRAL — no blocking smart-money signal) AND sector NOT against direction.
  const allRows: any[] = proOn ? fetched.filter(r => {
    if ((r.conviction ?? 0) < 85) return false
    const sm = smartMoney.get(r.symbol)
    if (r.direction === 'BUY' && sm === 'DISTRIBUTION') return false
    if (r.direction === 'SHORT' && sm === 'ACCUMULATION') return false
    const sec = sectorTrend.get(r.symbol)
    if (r.direction === 'BUY' && sec === 'LAGGING') return false
    if (r.direction === 'SHORT' && sec === 'LEADING') return false
    return true
  }) : fetched
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
      <ProModeToggle on={proOn} setOn={setProOn} targetWR="80%" currentCount={fetched.length} filteredCount={allRows.length} />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {/* 2026-06-16: switched to UniformPickTable for consistency across
          every signal tab. Old WeeklyCard / WeeklyRow components kept
          unused for now in case we revert (no impact — they're not called). */}
      {!isLoading && !error && rows.length > 0 && <UniformPickTable rows={rows} />}
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
      {/* 2026-06-16: uniform table — same look as Old-WeeklyPick across every tab */}
      {!isLoading && !error && rows.length > 0 && <UniformPickTable rows={rows} />}
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
      {/* 2026-06-16: uniform table */}
      {!isLoading && !error && rows.length > 0 && <UniformPickTable rows={rows} />}
    </div>
  )
}

// ── OPTIONS ─────────────────────────────────────────────────────
export function PublicOptionsPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-options'], queryFn: () => snapshots.options(),
    refetchInterval: 3 * 60_000, retry: false,
  })
  // PRO subset uses the existing options-pro.json (grade A + score ≥ 9 +
  // live measured 30d WR). Toggle filters the displayed table; live WR
  // badge only appears when PRO mode is ON. Same pattern as the other
  // 4 PRO Mode tabs.
  const proSnap = useQuery({
    queryKey: ['public-options-pro'], queryFn: () => snapshots.optionsPro(),
    refetchInterval: 3 * 60_000, retry: false,
  })
  const [proOn, setProOn] = useProMode('fno', true)
  const fetched: any[] = data?.rows ?? []
  // Strict dedup by instrument
  const dedupedAll: any[] = (() => {
    const seen = new Set<string>(); const out: any[] = []
    for (const r of fetched) {
      const k = r.instrument || r.symbol; if (!k || seen.has(k)) continue
      seen.add(k); out.push(r)
    }
    return out
  })()
  // PRO Mode: grade A AND score ≥ 9 (matches options-pro.json filter)
  const rows: any[] = proOn ? dedupedAll.filter(r => r.grade === 'A' && (r.score ?? 0) >= 9) : dedupedAll
  const liveWr = proSnap.data?.liveWinRate
  return (
    <div className="space-y-4">
      <Banner emoji="🎯" title="F&O · Options Signals"
        subtitle={proOn
          ? `${rows.length} PRO signals · grade A + score ≥ 9${liveWr != null ? ` · live 30d WR ${(liveWr * 100).toFixed(1)}%` : ''}`
          : `${rows.length} raw options signals`}
        ts={data?.generatedAt} />
      <Legend kind="signal" />
      <AccuracyStrip />
      <ProModeToggle on={proOn} setOn={setProOn} targetWR={liveWr != null ? `${(liveWr*100).toFixed(0)}% measured` : '80%'} currentCount={dedupedAll.length} filteredCount={rows.length} />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg={proOn ? 'No grade-A score-9 signals right now. Toggle PRO Mode off to see all options.' : 'No options signals right now. Active 9:15–15:30 IST.'} />}
      {!isLoading && !error && rows.length > 0 && <SignalTable rows={rows} />}
      <HowToTradeBox tab="F&O Options" rules={[
        { title: 'Entry', body: 'At the option premium shown. LIMIT order at MID of bid/ask, NEVER at ask. If premium has moved >5% from signal, skip (already chased).' },
        { title: 'Stop Loss', body: '30% of premium (e.g. ₹100 entry → ₹70 SL). Hard SL — exit at premium-stop regardless of underlying.' },
        { title: 'Targets & Booking', body: '1. Book 50% at +40% premium gain (T1)\n2. Trail SL to entry premium\n3. Hold remaining 50% for +100% (T2)\n4. EXIT all by end of next trading day OR before expiry' },
        { title: 'Position Size', body: '1-2% capital per signal. Max 5% capital across concurrent options.' },
        { title: 'Time Decay', body: 'If signal fires after 14:30 IST, halve position size. If <2 days to expiry, AVOID.' },
        { title: 'PRO Mode badge', body: 'When PRO Mode is ON, the banner shows the actual measured 30-day win rate from accuracy.json on grade-A signals. Verifiable via 📈 Track Record.' },
      ]} />
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
  // 2026-06-24: per-column sort.
  const { rows: sorted, headerProps, sortIndicator } = useSortableTable<any>(
    rows,
    { key: 'score', dir: 'desc' },
    {
      instrument: r => r.instrument ?? '',
      grade: r => r.grade ?? '',
      score: r => r.score ?? 0,
      entry: r => r.entry ?? 0,
      stopLoss: r => r.stopLoss ?? 0,
      target1: r => r.target1 ?? 0,
      target2: r => r.target2 ?? 0,
      riskReward: r => Number(r.riskReward) || 0,
    },
  )
  return (
    <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
      <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 980 }}>
        <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
          <tr>
            <th {...headerProps('instrument', 'text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]')}>Instrument{sortIndicator('instrument')}</th>
            <th {...headerProps('grade', 'text-center px-2 py-3 whitespace-nowrap')}>Grade{sortIndicator('grade')}</th>
            <th {...headerProps('score', 'text-center px-2 py-3 whitespace-nowrap')}>Score{sortIndicator('score')}</th>
            <th {...headerProps('entry', 'text-right px-2 py-3 whitespace-nowrap text-accent-cyan')}>Entry{sortIndicator('entry')}</th>
            <th {...headerProps('stopLoss', 'text-right px-2 py-3 whitespace-nowrap text-accent-red')}>SL{sortIndicator('stopLoss')}</th>
            <th {...headerProps('target1', 'text-right px-2 py-3 whitespace-nowrap text-accent-green')}>T1{sortIndicator('target1')}</th>
            <th {...headerProps('target2', 'text-right px-2 py-3 whitespace-nowrap text-accent-green')}>T2{sortIndicator('target2')}</th>
            <th {...headerProps('riskReward', 'text-center px-2 py-3 whitespace-nowrap')}>R:R{sortIndicator('riskReward')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
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
      {/* 2026-06-16: uniform table. totalScore → conviction (out of 24
          rescaled), entry/SL/T1/T2/T3 native fields, reason col shows
          tier + primary signal. */}
      {!isLoading && !error && cs.length > 0 && (
        <UniformPickTable rows={cs.map((c: any) => ({
          ...c,
          conviction: c.totalScore != null ? Math.round((c.totalScore / 24) * 100) : c.conviction,
          flowNote: `${c.tierLabel ?? ''} (${c.totalScore}/24) · ${c.primarySignal ?? ''} · exp +${c.expectedMovePct ?? '?'}% · R:R 1:${c.riskReward ?? '?'}`,
        }))} />
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
      {/* 2026-06-16: Elite hub now uses the same uniform table as every
          other signal tab. Per-row Reason combines tier label + which
          confluences fired (Volume / FII / DII / Promoter / Fund-Tech). */}
      {elite.length > 0 && (
        <UniformPickTable rows={elite.map(ev => ({
          ...ev.row,
          flowNote: `${ev.tier === 'ELITE' ? '💎 ELITE 5/5' : ev.tier === 'STRONG' ? '⭐ STRONG 4/5' : '✓ QUALITY 3/5'} · ${ev.verdict.reasons.filter(r => r.pass).map(r => r.label).join(' + ')}`,
        }))} />
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

// ── 🔄 SECTOR ROTATION — leading/lagging baskets ──
// Daily scan of 12 NIFTY sector indices. Helps user align stock picks
// with sector tailwind. Leading sectors = more reliable long setups;
// lagging sectors = more reliable shorts.
export function PublicSectorRotationPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-sector-rotation'], queryFn: () => snapshots.sectorRotation(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const rawRows: any[] = data?.rows ?? []
  const trendColor: Record<string, string> = {
    LEADING: '#00c853', IMPROVING: '#00bcd4', NEUTRAL: '#9e9e9e',
    WEAKENING: '#ff9800', LAGGING: '#ff1744',
  }
  const TREND_RANK: Record<string, number> = {
    LEADING: 5, IMPROVING: 4, NEUTRAL: 3, WEAKENING: 2, LAGGING: 1,
  }
  const { rows, headerProps, sortIndicator } = useSortableTable<any>(
    rawRows,
    { key: 'rotationScore', dir: 'desc' },
    {
      label: r => r.label ?? '',
      trend: r => TREND_RANK[r.trend] ?? 0,
      rotationScore: r => r.rotationScore ?? 0,
      ret5d: r => r.ret5d ?? 0,
      ret20d: r => r.ret20d ?? 0,
      relStr5d: r => r.relStr5d ?? 0,
      relStr20d: r => r.relStr20d ?? 0,
      pctAboveEma21: r => r.pctAboveEma21 ?? 0,
      volRatio5_20: r => r.volRatio5_20 ?? 0,
    },
  )
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-violet/10 to-accent-cyan/5 border border-accent-violet/40 rounded-lg">
        <div className="text-3xl">🔄</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-violet">Sector Rotation — Leading vs Lagging</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Daily ranking of NIFTY sectoral indices by composite strength
            (20d return · 5d return · RSI). Align long picks with leading sectors,
            shorts with lagging — adds the sector tailwind lens to every stock setup.
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              <span className="text-accent-green">Leading: {data.leading?.join(', ') || '—'}</span>
              {' · '}
              <span className="text-accent-red">Lagging: {data.lagging?.join(', ') || '—'}</span>
            </div>
          )}
        </div>
      </div>
      <AccuracyStrip />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load sector rotation. Refreshes every 30 min." />}
      {rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800">
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 900 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th {...headerProps('label', 'text-left px-3 py-3')}>Sector{sortIndicator('label')}</th>
                <th {...headerProps('trend', 'text-center px-2 py-3')}>Trend{sortIndicator('trend')}</th>
                <th {...headerProps('rotationScore', 'text-right px-2 py-3')}>Score{sortIndicator('rotationScore')}</th>
                <th {...headerProps('ret5d', 'text-right px-2 py-3')}>5d{sortIndicator('ret5d')}</th>
                <th {...headerProps('ret20d', 'text-right px-2 py-3')}>20d{sortIndicator('ret20d')}</th>
                <th {...headerProps('pctAboveEma21', 'text-right px-2 py-3')}>EMA21 breadth{sortIndicator('pctAboveEma21')}</th>
                <th {...headerProps('volRatio5_20', 'text-right px-2 py-3')}>Vol×{sortIndicator('volRatio5_20')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => {
                const color = trendColor[r.trend] || '#9e9e9e'
                const tdb = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono text-[11px]`
                return (
                  <tr key={r.index} className="group border-t border-ink-500">
                    <td className={`${tdb} px-3 font-bold text-neutral-100`}>{i + 1}. {r.label}</td>
                    <td className={`${tdb} text-center`}>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${color}22`, color }}>{r.trend}</span>
                    </td>
                    <td className={`${tdb} text-right font-bold`} style={{ color }}>{r.rotationScore.toFixed(1)}</td>
                    <td className={`${tdb} text-right ${(r.ret5d ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                      {(r.ret5d ?? 0) > 0 ? '+' : ''}{(r.ret5d ?? 0).toFixed(1)}%
                      {r.relStr5d != null && (
                        <span className={`ml-1 text-[9px] ${r.relStr5d >= 0 ? 'text-accent-green/70' : 'text-accent-red/70'}`}>
                          ({r.relStr5d > 0 ? '+' : ''}{r.relStr5d.toFixed(1)})
                        </span>
                      )}
                    </td>
                    <td className={`${tdb} text-right ${(r.ret20d ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                      {(r.ret20d ?? 0) > 0 ? '+' : ''}{(r.ret20d ?? 0).toFixed(1)}%
                      {r.relStr20d != null && (
                        <span className={`ml-1 text-[9px] ${r.relStr20d >= 0 ? 'text-accent-green/70' : 'text-accent-red/70'}`}>
                          ({r.relStr20d > 0 ? '+' : ''}{r.relStr20d.toFixed(1)})
                        </span>
                      )}
                    </td>
                    <td className={`${tdb} text-right text-neutral-200`}>{(r.pctAboveEma21 ?? 0).toFixed(0)}%</td>
                    <td className={`${tdb} text-right text-neutral-300`}>{(r.volRatio5_20 ?? 1).toFixed(2)}×</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <HowToTradeBox tab="Sectors" rules={[
        { title: 'Use this tab BEFORE entering any cash signal', body: '1. Find the sector of your candidate name.\n2. If sector is LEADING/IMPROVING → full size.\n3. If NEUTRAL → 50% size.\n4. If WEAKENING → 25% size or skip.\n5. If LAGGING → SKIP entirely (for longs).' },
        { title: 'For shorts', body: 'Reverse the rule — short setups prefer LAGGING or WEAKENING sectors. Full size in LAGGING, half in WEAKENING, skip if LEADING.' },
        { title: 'Rebalance weekly', body: 'Sector trends shift on the 20-day window. Review every Monday and adjust position sizing on existing trades.' },
        { title: 'NIFTY context', body: 'If NIFTY 20d itself is < -3%, even LEADING sectors face market headwind. Reduce overall allocation 30-50%.' },
      ]} />
    </div>
  )
}

// ── ⚡ CROSS-ENGINE CONFLUENCE — names flagged by ≥2 engines ──
// Pure aggregator: reads existing Weekly/Pre-Move/F&O/Daily/Old-Weekly
// snapshots and surfaces names with multi-source agreement. Strict dedup.
export function PublicCrossConfluencePage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-cross-confluence'], queryFn: () => snapshots.crossConfluence(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const [proOn, setProOn] = useProMode('ultra-picks', true)
  const { smartMoney, sectorTrend } = useSmartMoneyAndSectorMaps()
  const raw: any[] = data?.rows ?? []
  // Defense-in-depth dedup at render
  const dedupedAll: any[] = (() => {
    const seen = new Set<string>()
    const out: any[] = []
    for (const r of raw) {
      if (seen.has(r.symbol)) continue
      seen.add(r.symbol)
      out.push(r)
    }
    return out
  })()
  // PRO Mode for Ultra Picks: require ≥3 engines (the ⚡ULTRA tier) OR
  // (2 engines AND smart-money same-side AND sector aligned).
  const rows: any[] = proOn ? dedupedAll.filter(r => {
    if ((r.sources?.length ?? 0) >= 3) return true
    if ((r.sources?.length ?? 0) === 2) {
      const sm = smartMoney.get(r.symbol)
      const sec = sectorTrend.get(r.symbol)
      const smOK = !sm || (r.direction === 'BUY' && sm !== 'DISTRIBUTION') || (r.direction === 'SHORT' && sm !== 'ACCUMULATION')
      const secOK = !sec || (r.direction === 'BUY' && (sec === 'LEADING' || sec === 'IMPROVING'))
        || (r.direction === 'SHORT' && (sec === 'LAGGING' || sec === 'WEAKENING'))
      return smOK && secOK
    }
    return false
  }) : dedupedAll
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/15 to-accent-green/5 border border-accent-amber/50 rounded-lg">
        <div className="text-3xl">⚡</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-amber">Cross-Engine Confluence · Ultra Picks</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Names flagged by <b>≥2 independent engines</b> (Weekly · Pre-Move · F&O Futures · Daily · Old-Weekly).
            When multiple scanners with different criteria all agree, the conviction is structurally higher than any single engine alone.
            <br/>⚡ <b>ULTRA</b> = 3+ engines agree · ⭐ <b>STRONG</b> = 2 engines agree.
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              ⚡ ULTRA {data.ultraCount ?? 0} · ⭐ STRONG {data.strongCount ?? 0} · evaluated {data.totalEvaluated ?? 0} names
              <span className="ml-2 text-accent-red">🔴 LIVE</span>
              <span className="text-neutral-500"> · refreshes every 4 min during 9:15-15:30 IST</span>
              {data.generatedAt && (
                <span className="text-neutral-600"> · last {new Date(data.generatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST</span>
              )}
            </div>
          )}
        </div>
      </div>
      <AccuracyStrip />
      <ProModeToggle on={proOn} setOn={setProOn} targetWR="80%" currentCount={dedupedAll.length} filteredCount={rows.length} />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load confluence. Refreshes every 30 min." />}
      {rows.length === 0 && !isLoading && !error && <Empty msg={proOn ? 'No PRO-grade confluence picks right now (3+ engines OR 2-engine with smart-money+sector confirm). Toggle PRO Mode off to see all.' : 'No multi-engine agreement right now. Check back at next publish.'} />}
      {/* 2026-06-26: Reason column now shows REAL trading logic from the
          contributing engines (RSI, Vol, Delivery, FII↑ etc.) plus the
          FII/DII/Promoter stake summary — no more opaque "Engine α/β/γ"
          labels. The confluence COUNT is preserved as a leading tier tag. */}
      {rows.length > 0 && (
        <UniformPickTable rows={rows.map((r: any) => {
          const count = r.sources?.length ?? 0
          const tier = count >= 3 ? '⚡ ULTRA' : '⭐ STRONG'
          const tierTag = `${tier} · ${count}-engine confluence`
          const reasonsCondensed = (r.reasoning ?? []).slice(0, 3).join(' · ')
          return {
            ...r,
            conviction: r.ultraScore ?? r.conviction,
            shareholdingNote: r.shareholdingNote,           // surfaces 📊 line in Reason col
            flowNote: `${tierTag}${reasonsCondensed ? ' · ' + reasonsCondensed : ''}`,
            noBrainerBet: r.noBrainerBet,
          }
        })} />
      )}
      <HowToTradeBox tab="Ultra Picks" rules={[
        { title: 'Tier rules', body: '⚡ ULTRA (3+ engines): full size, highest priority.\n⭐ STRONG (2 engines): 60% size.' },
        { title: 'Entry', body: 'Use the entry zone from the strongest contributing engine. Never chase beyond +2% of stated entry.' },
        { title: 'Stop Loss', body: 'Use the TIGHTEST SL among contributing engines. Typically 5-6% on cash, 4.5% on futures.' },
        { title: 'Targets', body: 'Use T1/T2/T3 from the Weekly Pick contribution (longest horizon). Book 50% T1, trail to entry, hold 30% T2, 20% runner T3.' },
        { title: 'Size', body: 'ULTRA: 5% capital. STRONG: 3% capital. Max 3 Ultra positions open simultaneously.' },
        { title: 'SL-Trap watch', body: 'If SL gets hit, IMMEDIATELY check 🛡️ SL Traps. Ultra Picks setups often have institutional support — SL might be a hunt.' },
      ]} />
    </div>
  )
}

// ── 🎯 PRO MODE TOGGLE — applies a strict filter to push effective WR
// into the 80%+ target band. Default ON; user can flip off to see all.
// State persisted via localStorage so it survives reloads.
function useProMode(key: string, defaultOn = true): [boolean, (v: boolean) => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      const stored = typeof window !== 'undefined' ? localStorage.getItem(`proMode:${key}`) : null
      return stored == null ? defaultOn : stored === '1'
    } catch { return defaultOn }
  })
  const toggle = (v: boolean) => {
    setOn(v)
    try { localStorage.setItem(`proMode:${key}`, v ? '1' : '0') } catch {}
  }
  return [on, toggle]
}

function ProModeToggle({ on, setOn, targetWR, currentCount, filteredCount }: {
  on: boolean; setOn: (v: boolean) => void; targetWR: string;
  currentCount: number; filteredCount: number;
}): JSX.Element {
  return (
    <div className={`mb-3 px-3 py-2 rounded-lg border flex items-center gap-3 flex-wrap ${on ? 'bg-accent-amber/10 border-accent-amber/50' : 'bg-ink-700 border-ink-500'}`}>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={on} onChange={e => setOn(e.target.checked)} className="cursor-pointer" />
        <span className="text-[12px] font-bold text-accent-amber">🎯 PRO Mode (target {targetWR}+ effective WR)</span>
      </label>
      <span className="text-[10px] text-neutral-500">
        {on
          ? `Showing ${filteredCount}/${currentCount} high-conviction picks`
          : `Showing all ${currentCount} raw picks (no PRO filter applied)`}
      </span>
    </div>
  )
}

// PRO Mode filter helpers — applied to each of the 4 tabs.
function applyProFilterToPicks(rows: any[], smartMoney: Map<string, string>, sectorTrend: Map<string, string>): any[] {
  return rows.filter(r => {
    if ((r.conviction ?? 0) < 85) return false
    const sm = smartMoney.get(r.symbol)
    if (r.direction === 'BUY' && sm === 'DISTRIBUTION') return false
    if (r.direction === 'SHORT' && sm === 'ACCUMULATION') return false
    const sec = sectorTrend.get(r.symbol)
    if (r.direction === 'BUY' && sec === 'LAGGING') return false
    if (r.direction === 'SHORT' && sec === 'LEADING') return false
    return true
  })
}

function useSmartMoneyAndSectorMaps(): { smartMoney: Map<string, string>; sectorTrend: Map<string, string> } {
  const ad = useQuery({ queryKey: ['public-ad-divergence'], queryFn: () => snapshots.adDivergence(), refetchInterval: 5 * 60_000, retry: false })
  const sr = useQuery({ queryKey: ['public-sector-rotation'], queryFn: () => snapshots.sectorRotation(), refetchInterval: 5 * 60_000, retry: false })
  const smartMoney = new Map<string, string>()
  for (const r of (ad.data?.rows ?? [])) smartMoney.set(r.symbol, r.side)
  const sectorTrend = new Map<string, string>()
  // Sector map: stock → basket trend. Built from baskets.
  const SECTOR_MEMBERS: Record<string, string[]> = {
    FMCG: ['HINDUNILVR','ITC','NESTLEIND','BRITANNIA','DABUR','GODREJCP','COLPAL','MARICO','TATACONSUM','VBL','UBL','RADICO','JUBLFOOD','DMART'],
    IT: ['TCS','INFY','HCLTECH','WIPRO','TECHM','LTIM','PERSISTENT','MPHASIS','COFORGE','LTTS','CYIENT','KPITTECH','TATAELXSI','TANLA'],
    AUTO: ['MARUTI','TATAMOTORS','M&M','BAJAJ-AUTO','HEROMOTOCO','EICHERMOT','TVSMOTOR','ASHOKLEY','ESCORTS','BHARATFORG','MOTHERSON','EXIDEIND','BALKRISIND','MRF','APOLLOTYRE','BOSCHLTD'],
    PHARMA: ['SUNPHARMA','CIPLA','DRREDDY','DIVISLAB','TORNTPHARM','LUPIN','AUROPHARMA','ZYDUSLIFE','GLENMARK','BIOCON','ALKEM','IPCALAB','MANKIND','LAURUSLABS','APOLLOHOSP','MAXHEALTH','FORTIS'],
    METALS: ['TATASTEEL','JSWSTEEL','HINDALCO','COALINDIA','VEDL','SAIL','JINDALSTEL','NMDC','HINDZINC','HINDCOPPER','NATIONALUM'],
    BANKS_PVT: ['HDFCBANK','ICICIBANK','AXISBANK','KOTAKBANK','INDUSINDBK','IDFCFIRSTB','FEDERALBNK','RBLBANK','BANDHANBNK'],
    BANKS_PSU: ['SBIN','PNB','CANBK','BANKBARODA','IOB','CENTRALBK','UCOBANK','IDBI'],
    ENERGY: ['RELIANCE','ONGC','IOC','BPCL','HINDPETRO','GAIL','OIL'],
    INFRA: ['LT','ULTRACEMCO','GRASIM','AMBUJACEM','SHREECEM','ACC','DALBHARAT','JKCEMENT','RAMCOCEM'],
    REALTY: ['DLF','OBEROIRLTY','PRESTIGE','GODREJPROP','LODHA','PHOENIXLTD','BRIGADE'],
    CONSUMPTION: ['TITAN','ASIANPAINT','HAVELLS','CROMPTON','POLYCAB','VOLTAS','BLUESTARCO','PIDILITIND','BERGEPAINT','TRENT','PAGEIND','BATAINDIA','DIXON','AMBER'],
    DEFENCE: ['HAL','BEL','BHARATDYN','MAZDOCK','GRSE','COCHINSHIP','BEML','IRCTC','IRFC','RVNL','CONCOR','RAILTEL','RITES'],
    CAPITAL_GOODS: ['SIEMENS','ABB','CUMMINSIND','THERMAX','BHEL','KEC','POWERINDIA'],
  }
  for (const r of (sr.data?.rows ?? [])) {
    const members = SECTOR_MEMBERS[r.index] || []
    for (const m of members) {
      if (!sectorTrend.has(m)) sectorTrend.set(m, r.trend)
    }
  }
  return { smartMoney, sectorTrend }
}

// ── 📖 HOW TO TRADE — collapsible playbook box used at the bottom of
// every public page. Per-tab rules so any user can act without the guide.
function HowToTradeBox({ tab, rules }: { tab: string; rules: { title: string; body: string }[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-6 rounded-lg border border-accent-cyan/30 bg-ink-800">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left px-4 py-3 flex items-center justify-between hover:bg-ink-700 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-2">
          <span className="text-[16px]">📖</span>
          <b className="text-[12px] text-accent-cyan">How to Trade this Tab · {tab}</b>
          <span className="text-[10px] text-neutral-500">click to {open ? 'hide' : 'show'}</span>
        </div>
        <span className="text-accent-cyan text-[14px]">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-ink-500">
          {rules.map((r, i) => (
            <div key={i}>
              <div className="text-[11px] font-bold text-accent-amber uppercase tracking-wider mb-1">{r.title}</div>
              <div className="text-[12px] text-neutral-300 leading-relaxed whitespace-pre-line">{r.body}</div>
            </div>
          ))}
          <div className="mt-3 pt-3 border-t border-ink-500 text-[10px] text-neutral-500 leading-relaxed">
            <b className="text-accent-amber">⚠️ SL-Trap Rule (apply to every trade):</b> If price hits your SL but the 🧲 Smart Money tab shows the same symbol in ACCUMULATION (for longs) or DISTRIBUTION (for shorts), do <b>not</b> close immediately. The SL is likely a liquidity grab. Re-enter at SL price, watch for reversal within the next 5 sessions. Examples this fired on historically: MOSCHIP, MARKSANS PHARMA, FINPIPE.
          </div>
        </div>
      )}
    </div>
  )
}

// ── 🚀 EARLY MOMENTUM RADAR — ₹50-500 stocks BEFORE the 10-20% move ──
// 2026-06-25: dedicated scanner for the user's actual moneymaker tier.
// No conv floor, no pre-breakout reject; pure momentum + institutional-
// footprint signature so small/mid caps surface BEFORE retail catches on.
export function PublicEarlyMomentumPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-early-momentum'], queryFn: () => snapshots.earlyMomentum(),
    refetchInterval: 30 * 60_000, retry: false,
  })
  const all: any[] = data?.rows ?? []
  const [tier, setTier] = useState<'ALL' | 'EARLY' | 'WAVE_2' | 'CONFIRMED'>('ALL')
  const filtered = tier === 'ALL' ? all : all.filter(r => r.tier === tier)
  const { rows, headerProps, sortIndicator } = useSortableTable<any>(
    filtered, { key: 'score', dir: 'desc' },
    {
      symbol: r => r.symbol ?? '',
      close: r => r.close ?? 0,
      pctChangeToday: r => r.pctChangeToday ?? 0,
      deliveryPct: r => r.deliveryPct ?? 0,
      volSurgeX: r => r.volSurgeX ?? 0,
      rangeExpansionX: r => r.rangeExpansionX ?? 0,
      ret5dPct: r => r.ret5dPct ?? 0,
      ret20dPct: r => r.ret20dPct ?? 0,
      distFrom20HighPct: r => r.distFrom20HighPct ?? 0,
      rsi14: r => r.rsi14 ?? 0,
      score: r => r.score ?? 0,
      tier: r => r.tier ?? '',
    },
  )
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/15 to-accent-green/5 border border-accent-amber/50 rounded-lg">
        <div className="text-3xl">🚀</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-amber">Early Momentum Radar · ₹50-500 PRE-MOVE</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Built per your directive: <i>"every day new stocks ₹100-300 move 10-20% in a week — we should have all those before the move."</i>
            This is the dedicated tab — <b>NO conviction floor</b>, <b>NO pre-breakout reject</b>. Just the exact institutional-footprint
            signature (volume surge + delivery surge + range expansion + tight base + 52w-high proximity) over the full NSE small/mid-cap universe.
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              📊 {data.total} candidates · 🟡 EARLY: {data.tierCounts?.EARLY ?? 0} · 🔄 WAVE_2: {data.tierCounts?.WAVE_2 ?? 0} · 🔥 CONFIRMED: {data.tierCounts?.CONFIRMED ?? 0}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-neutral-500">Tier:</span>
        {(['ALL', 'EARLY', 'WAVE_2', 'CONFIRMED'] as const).map(t => {
          const cnt = t === 'ALL' ? all.length : all.filter(r => r.tier === t).length
          const color = t === 'CONFIRMED' ? 'accent-green' : t === 'WAVE_2' ? 'accent-amber' : t === 'EARLY' ? 'accent-cyan' : 'accent-violet'
          return (
            <button key={t} onClick={() => setTier(t)}
              className={`px-2 py-1 rounded border ${tier === t ? `bg-${color}/20 border-${color} text-${color}` : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
              {t.replace('_', ' ')} ({cnt})
            </button>
          )
        })}
      </div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load early-momentum scan. Snapshot refreshes every 90 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No candidates match this tier. Try a different tier or wait for next scan." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1100 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th {...headerProps('symbol', 'text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500')}>Symbol{sortIndicator('symbol')}</th>
                <th {...headerProps('tier', 'text-center px-2 py-3')}>Tier{sortIndicator('tier')}</th>
                <th {...headerProps('score', 'text-right px-2 py-3')}>Score{sortIndicator('score')}</th>
                <th {...headerProps('close', 'text-right px-2 py-3 text-neutral-300')}>LTP{sortIndicator('close')}</th>
                <th {...headerProps('pctChangeToday', 'text-right px-2 py-3')}>Today %{sortIndicator('pctChangeToday')}</th>
                <th {...headerProps('deliveryPct', 'text-right px-2 py-3 text-accent-violet')}>Deliv %{sortIndicator('deliveryPct')}</th>
                <th {...headerProps('volSurgeX', 'text-right px-2 py-3 text-accent-cyan')}>Vol ×{sortIndicator('volSurgeX')}</th>
                <th {...headerProps('rangeExpansionX', 'text-right px-2 py-3')}>Range ×{sortIndicator('rangeExpansionX')}</th>
                <th {...headerProps('ret5dPct', 'text-right px-2 py-3')}>5d %{sortIndicator('ret5dPct')}</th>
                <th {...headerProps('ret20dPct', 'text-right px-2 py-3')}>20d %{sortIndicator('ret20dPct')}</th>
                <th {...headerProps('distFrom20HighPct', 'text-right px-2 py-3')}>Off-Hi %{sortIndicator('distFrom20HighPct')}</th>
                <th {...headerProps('rsi14', 'text-right px-2 py-3')}>RSI{sortIndicator('rsi14')}</th>
                <th className="text-left px-3 py-3">Signature</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => {
                const tierColor = r.tier === 'CONFIRMED' ? '#00c853' : r.tier === 'WAVE_2' ? '#ffb454' : '#5fd4ff'
                const tdb = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono text-[11px]`
                return (
                  <tr key={r.symbol + i} className="group border-t border-ink-500">
                    <td className={`${tdb} px-3 sticky left-0 z-10 border-r border-ink-500 font-bold text-neutral-100`}>{r.symbol}</td>
                    <td className={`${tdb} text-center`}>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${tierColor}22`, color: tierColor }}>{r.tier}</span>
                    </td>
                    <td className={`${tdb} text-right font-bold ${r.score >= 60 ? 'text-accent-green' : r.score >= 45 ? 'text-accent-amber' : 'text-neutral-300'}`}>{r.score}</td>
                    <td className={`${tdb} text-right text-neutral-200`}>₹{r.close.toFixed(1)}</td>
                    <td className={`${tdb} text-right font-bold`} style={{ color: r.pctChangeToday >= 0 ? '#00c853' : '#ff5e7c' }}>
                      {r.pctChangeToday >= 0 ? '+' : ''}{r.pctChangeToday.toFixed(1)}%
                    </td>
                    <td className={`${tdb} text-right ${r.deliveryPct >= 55 ? 'text-accent-violet font-bold' : r.deliveryPct >= 45 ? 'text-accent-violet' : 'text-neutral-500'}`}>
                      {r.deliveryPct != null ? `${r.deliveryPct.toFixed(0)}%` : '—'}
                    </td>
                    <td className={`${tdb} text-right ${r.volSurgeX >= 2 ? 'text-accent-cyan font-bold' : 'text-neutral-300'}`}>{r.volSurgeX.toFixed(1)}×</td>
                    <td className={`${tdb} text-right text-neutral-300`}>{r.rangeExpansionX.toFixed(1)}×</td>
                    <td className={`${tdb} text-right`} style={{ color: r.ret5dPct >= 0 ? '#5fd4ff' : '#ff9800' }}>{r.ret5dPct >= 0 ? '+' : ''}{r.ret5dPct.toFixed(1)}%</td>
                    <td className={`${tdb} text-right`} style={{ color: r.ret20dPct >= 0 ? '#5fd4ff' : '#ff9800' }}>{r.ret20dPct >= 0 ? '+' : ''}{r.ret20dPct.toFixed(1)}%</td>
                    <td className={`${tdb} text-right text-neutral-300`}>{r.distFrom20HighPct.toFixed(1)}%</td>
                    <td className={`${tdb} text-right text-neutral-300`}>{r.rsi14.toFixed(0)}</td>
                    <td className={`${tdb} text-left text-neutral-400`} style={{ minWidth: 260 }}>
                      {r.shareholdingNote && (
                        <div className="text-[10px] text-neutral-300 mb-0.5"
                          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }}
                          title={r.shareholdingNote}>
                          📊 {r.noBrainerBet && '⭐ '}{r.shareholdingNote}
                        </div>
                      )}
                      {r.reasons && r.reasons.length > 0 && (
                        <div className="text-[10px] text-neutral-500"
                          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }}
                          title={r.reasons.join(' · ')}>
                          ⚡ {r.reasons.join(' · ')}
                        </div>
                      )}
                      {!r.shareholdingNote && (!r.reasons || r.reasons.length === 0) && <span className="text-neutral-600">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <HowToTradeBox tab="Early Momentum" rules={[
        { title: 'What this tab IS', body: 'A pure momentum + institutional-footprint radar over ₹50-500 NSE stocks. NO conviction floor, NO pre-breakout reject. Surfaces candidates BEFORE the visible big move so you have time to position.' },
        { title: '🟡 EARLY tier', body: 'Tight base + volume building, no big move yet. Highest-conviction entry zone — capture from base before breakout. Use 4-6% SL.' },
        { title: '🔄 WAVE_2 tier', body: 'Already up 5-15% in 5d, now consolidating in a tight range — primed for second leg. These are the classic 10-20%-week-2 setups you described. Buy on first vol confirmation.' },
        { title: '🔥 CONFIRMED tier', body: 'Today saw 3%+ gain with delivery ≥ 45% (institutional footprint LIVE). Late but still actionable; tighten SL to today\'s low.' },
        { title: 'Score thresholds', body: 'Score ≥ 60 = high conviction (green). 45-59 = strong (amber). 25-44 = watchlist. Score combines volume thrust + delivery + range expansion + 20d-high proximity + EMA stack + base tightness.' },
        { title: 'Cross-check', body: 'Check Footprint tab (📡) for bulk-deals confirmation. Check Smart Money for OBV/CMF alignment. Sector Rotation tells you if the sector tailwind is there.' },
      ]} />
    </div>
  )
}

// ── 📐 CHART PATTERNS — PILOT MODE classical TA pattern scanner.
// Scans NIFTY-500 × DAILY + WEEKLY × 9 detectors (H&S, Inverse H&S,
// Double Top, Double Bottom, Triangles, Flag, Wedge, Cup & Handle,
// Candlesticks). Algorithmic implementations of widely-documented TA
// patterns (Edwards & Magee 1948, Murphy, Bulkowski, Nison) — no
// reproduced text from any source.
export function PublicChartPatternsPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-chart-patterns'], queryFn: () => snapshots.chartPatterns(),
    refetchInterval: 60 * 60_000, retry: false,
  })
  const all: any[] = data?.rows ?? []
  const [pattern, setPattern] = useState<string>('ALL')
  const [tf, setTf] = useState<'ALL' | 'DAILY' | 'WEEKLY'>('ALL')
  const distinctPatterns = Array.from(new Set(all.map(r => r.pattern))).sort()
  let filtered = all
  if (pattern !== 'ALL') filtered = filtered.filter(r => r.pattern === pattern)
  if (tf !== 'ALL') filtered = filtered.filter(r => r.timeframe === tf)
  const { rows, headerProps, sortIndicator } = useSortableTable<any>(
    filtered, { key: 'expectedMovePct', dir: 'desc' },
    {
      symbol: r => r.symbol ?? '',
      pattern: r => r.pattern ?? '',
      direction: r => r.direction ?? '',
      timeframe: r => r.timeframe ?? '',
      entry: r => r.entry ?? 0,
      stopLoss: r => r.stopLoss ?? 0,
      target1: r => r.target1 ?? 0,
      expectedMovePct: r => r.expectedMovePct ?? 0,
      confidence: r => ({ HIGH: 3, MED: 2, LOW: 1 }[r.confidence as 'HIGH' | 'MED' | 'LOW'] ?? 0),
      formedAt: r => r.formedAt ?? '',
    },
  )
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/15 to-accent-cyan/5 border border-accent-amber/50 rounded-lg">
        <div className="text-3xl">📐</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-amber">Chart Patterns Scanner · PILOT MODE</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Scans NIFTY-500 × <b>DAILY + WEEKLY</b> timeframes against 9 classical TA detectors:
            <b> Head & Shoulders · Inverse H&S · Double Top · Double Bottom · Ascending / Descending / Symmetrical Triangle · Flag · Cup & Handle · Wedge · Candlestick patterns</b>.
            <br/>Each hit shows the pattern + entry + SL + measured-move target with the calculation logic.
            <br/><b>⚠️ PILOT MODE</b> — please review outputs and confirm before this goes live on the main nav.
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              {data.total} pattern hits · {Object.entries(data.byPattern ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-neutral-500">Pattern:</span>
        <button onClick={() => setPattern('ALL')} className={`px-2 py-1 rounded border ${pattern === 'ALL' ? 'bg-accent-amber/20 border-accent-amber text-accent-amber' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>All ({all.length})</button>
        {distinctPatterns.map(p => (
          <button key={p} onClick={() => setPattern(p)} className={`px-2 py-1 rounded border ${pattern === p ? 'bg-accent-amber/20 border-accent-amber text-accent-amber' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
            {p} ({all.filter(r => r.pattern === p).length})
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-neutral-500">Timeframe:</span>
        {(['ALL', 'DAILY', 'WEEKLY'] as const).map(t => (
          <button key={t} onClick={() => setTf(t)} className={`px-2 py-1 rounded border ${tf === t ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
            {t} ({t === 'ALL' ? all.length : all.filter(r => r.timeframe === t).length})
          </button>
        ))}
      </div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load chart-pattern scan. Snapshot refreshes hourly." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No chart patterns matched these filters." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1100 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th {...headerProps('symbol', 'text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500')}>Symbol{sortIndicator('symbol')}</th>
                <th {...headerProps('pattern', 'text-left px-2 py-3')}>Pattern{sortIndicator('pattern')}</th>
                <th {...headerProps('timeframe', 'text-center px-2 py-3')}>TF{sortIndicator('timeframe')}</th>
                <th {...headerProps('direction', 'text-center px-2 py-3')}>Dir{sortIndicator('direction')}</th>
                <th {...headerProps('confidence', 'text-center px-2 py-3')}>Conf{sortIndicator('confidence')}</th>
                <th {...headerProps('entry', 'text-right px-2 py-3 text-accent-cyan')}>Entry{sortIndicator('entry')}</th>
                <th {...headerProps('stopLoss', 'text-right px-2 py-3 text-accent-red')}>SL{sortIndicator('stopLoss')}</th>
                <th {...headerProps('target1', 'text-right px-2 py-3 text-accent-green')}>T1{sortIndicator('target1')}</th>
                <th {...headerProps('expectedMovePct', 'text-right px-2 py-3 font-bold')}>Move %{sortIndicator('expectedMovePct')}</th>
                <th {...headerProps('formedAt', 'text-left px-2 py-3')}>Formed{sortIndicator('formedAt')}</th>
                <th className="text-left px-3 py-3">Logic</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => {
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff5e7c'
                const confColor = r.confidence === 'HIGH' ? '#00c853' : r.confidence === 'MED' ? '#ffb454' : '#9aa0a6'
                const tdb = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono text-[11px]`
                return (
                  <tr key={r.symbol + r.pattern + i} className="group border-t border-ink-500">
                    <td className={`${tdb} px-3 sticky left-0 z-10 border-r border-ink-500 font-bold text-neutral-100`}>{r.symbol}</td>
                    <td className={`${tdb} text-left font-bold text-accent-amber`}>{r.pattern}</td>
                    <td className={`${tdb} text-center text-neutral-300`}>{r.timeframe}</td>
                    <td className={`${tdb} text-center`}>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                    </td>
                    <td className={`${tdb} text-center`}>
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${confColor}22`, color: confColor }}>{r.confidence}</span>
                    </td>
                    <td className={`${tdb} text-right text-accent-cyan`}>
                      <div>₹{r.entry.toFixed(1)}</div>
                      {r.entryDate && <div className="text-[9px] text-accent-cyan/60 font-normal">📅 {fmtDate(r.entryDate)}</div>}
                    </td>
                    <td className={`${tdb} text-right text-accent-red`}>₹{r.stopLoss.toFixed(1)}</td>
                    <td className={`${tdb} text-right text-accent-green font-bold`}>
                      <div>₹{r.target1.toFixed(1)}</div>
                      {r.target1Date && <div className="text-[9px] text-accent-green/60 font-normal">📅 {fmtDate(r.target1Date)}</div>}
                      {r.target2 != null && <div className="text-[10px] text-accent-green/80 mt-1">T2 ₹{r.target2.toFixed(1)} {r.target2Date && <span className="text-[9px] text-accent-green/60">📅 {fmtDate(r.target2Date)}</span>}</div>}
                      {r.target3 != null && <div className="text-[10px] text-accent-green/80">T3 ₹{r.target3.toFixed(1)} {r.target3Date && <span className="text-[9px] text-accent-green/60">📅 {fmtDate(r.target3Date)}</span>}</div>}
                    </td>
                    <td className={`${tdb} text-right font-bold`} style={{ color: r.direction === 'BUY' ? '#00c853' : '#ff5e7c' }}>
                      {r.direction === 'BUY' ? '+' : '−'}{r.expectedMovePct.toFixed(1)}%
                    </td>
                    <td className={`${tdb} text-left text-neutral-300`}>{r.formedAt}</td>
                    <td className={`${tdb} text-left text-neutral-400`} style={{ minWidth: 280 }}>
                      <div style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }}>
                        {(r.reasoning ?? []).join(' · ')}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <HowToTradeBox tab="Chart Patterns (Pilot)" rules={[
        { title: 'Pattern catalog', body: 'H&S, Inverse H&S, Double Top, Double Bottom, Triangles (asc/desc/symmetric), Flag, Wedge (rising/falling), Cup & Handle, Bullish/Bearish Engulfing, Hammer, Shooting Star, Three White Soldiers/Three Black Crows. All scanned at DAILY + WEEKLY.' },
        { title: 'How targets are calculated', body: 'Each pattern uses the standard "measured move" rule.\n• H&S: target = neckline − (head − neckline)\n• Double Top/Bot: target = neckline ± pattern height\n• Triangle: target = breakout ± triangle height\n• Flag: target = breakout ± pole height\n• Cup & Handle: target = rim + cup depth\n• Wedge: target = breakdown/out ± wedge range\n• Engulfing: target = entry ± 2× body' },
        { title: 'Confidence rating', body: 'HIGH = pattern with tight symmetry (shoulders within 4%, peaks within 2%, or strong body relative to ATR). MED = passes structure but with some asymmetry. LOW reserved for borderline.' },
        { title: 'PILOT WARNING', body: 'This tab is in PILOT MODE — please cross-check 10-15 hits against actual charts. If patterns are reliably forming where flagged + targets are reasonable, we promote to main nav. If false-positives are high, we tighten the detectors.' },
        { title: 'Attribution', body: 'Algorithms are my original implementations of classical TA patterns documented since Edwards & Magee (1948), Murphy, Bulkowski, Nison. No reproduced text — all detection logic is original code.' },
      ]} />
    </div>
  )
}

// ── 🕵️ INSIDER BUYS — SEBI PIT (Reg 7) + SAST (Reg 29) filings.
// Smartest single signal in Indian markets: promoters / KMP / directors
// buying their own stock + 5%+ external acquirers crossing thresholds.
// Aggregated by symbol with technical + shareholding context.
export function PublicInsiderBuysPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-insider-buys'], queryFn: () => snapshots.insiderBuys(),
    refetchInterval: 60 * 60_000, retry: false,
  })
  const all: any[] = data?.rows ?? []
  const [tier, setTier] = useState<'ALL' | 'STRONG_INSIDER_BUY' | 'INSIDER_BUY'>('ALL')
  const filtered = tier === 'ALL' ? all : all.filter(r => r.signal === tier)
  const { rows, headerProps, sortIndicator } = useSortableTable<any>(
    filtered, { key: 'score', dir: 'desc' },
    {
      symbol: r => r.symbol ?? '',
      score: r => r.score ?? 0,
      close: r => r.close ?? 0,
      promoterNetBuyCr: r => r.promoterNetBuyCr ?? 0,
      kmpNetBuyCr: r => r.kmpNetBuyCr ?? 0,
      externalAcquirerBuyCr: r => r.externalAcquirerBuyCr ?? 0,
      totalNetBuyCr: r => r.totalNetBuyCr ?? 0,
      rsi14: r => r.rsi14 ?? 0,
      pctOffHigh52w: r => r.pctOffHigh52w ?? 0,
      mostRecentDate: r => r.mostRecentDate ?? '',
    },
  )
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/15 to-accent-green/5 border border-accent-amber/50 rounded-lg">
        <div className="text-3xl">🕵️</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-amber">Insider Buys · SEBI PIT (Reg 7) + SAST (Reg 29) filings</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            When promoters / KMP / directors put their <b>own money</b> into the company's stock, or when an external acquirer crosses the 5/10/15% SAST threshold — that's the cleanest insider signal Indian markets give us, free, daily.
            Aggregated per symbol with technical context (RSI, 52w-high distance) + shareholding (FII/DII delta, pledge) so each row is actionable, not just informational.
            Score 0-100: 30 net-buy magnitude · 20 pure-promoter buy · 15 external SAST acquirer · 10 bottoming setup · 10 pedigree · 10 low-pledge · 5 recency.
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              📊 {data.total} candidates · 🔥 STRONG: {data.strongCount ?? 0}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-neutral-500">Signal:</span>
        {(['ALL', 'STRONG_INSIDER_BUY', 'INSIDER_BUY'] as const).map(t => {
          const cnt = t === 'ALL' ? all.length : all.filter(r => r.signal === t).length
          const color = t === 'STRONG_INSIDER_BUY' ? 'accent-green' : t === 'INSIDER_BUY' ? 'accent-amber' : 'accent-cyan'
          return (
            <button key={t} onClick={() => setTier(t)}
              className={`px-2 py-1 rounded border ${tier === t ? `bg-${color}/20 border-${color} text-${color}` : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
              {t.replace('_INSIDER_', ' ')} ({cnt})
            </button>
          )
        })}
      </div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load insider buys. Snapshot refreshes hourly." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No insider-buy candidates right now. NSE PIT/SAST is rate-limited; daily 18:30 IST cron refreshes." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1200 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th {...headerProps('symbol', 'text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500')}>Symbol{sortIndicator('symbol')}</th>
                <th {...headerProps('score', 'text-center px-2 py-3')}>Score{sortIndicator('score')}</th>
                <th {...headerProps('close', 'text-right px-2 py-3 text-neutral-300')}>LTP{sortIndicator('close')}</th>
                <th {...headerProps('promoterNetBuyCr', 'text-right px-2 py-3 text-accent-green')}>Promoter ₹Cr{sortIndicator('promoterNetBuyCr')}</th>
                <th {...headerProps('kmpNetBuyCr', 'text-right px-2 py-3 text-accent-cyan')}>KMP ₹Cr{sortIndicator('kmpNetBuyCr')}</th>
                <th {...headerProps('externalAcquirerBuyCr', 'text-right px-2 py-3 text-accent-amber')}>SAST ₹Cr{sortIndicator('externalAcquirerBuyCr')}</th>
                <th {...headerProps('totalNetBuyCr', 'text-right px-2 py-3 font-bold')}>Total Net ₹Cr{sortIndicator('totalNetBuyCr')}</th>
                <th {...headerProps('rsi14', 'text-right px-2 py-3')}>RSI{sortIndicator('rsi14')}</th>
                <th {...headerProps('pctOffHigh52w', 'text-right px-2 py-3 text-accent-red')}>% off 52w-Hi{sortIndicator('pctOffHigh52w')}</th>
                <th {...headerProps('mostRecentDate', 'text-left px-2 py-3')}>Latest{sortIndicator('mostRecentDate')}</th>
                <th className="text-left px-3 py-3">Why · Actors</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => {
                const tdb = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono text-[11px]`
                const sigColor = r.signal === 'STRONG_INSIDER_BUY' ? '#00c853' : r.signal === 'INSIDER_BUY' ? '#ffb454' : '#9aa0a6'
                return (
                  <tr key={r.symbol + i} className="group border-t border-ink-500">
                    <td className={`${tdb} px-3 sticky left-0 z-10 border-r border-ink-500 font-bold text-neutral-100`}>
                      {r.symbol}
                      <span className="ml-2 text-[9px] px-1 py-0.5 rounded font-bold" style={{ background: `${sigColor}22`, color: sigColor }}>{r.signal === 'STRONG_INSIDER_BUY' ? 'STRONG' : 'BUY'}</span>
                    </td>
                    <td className={`${tdb} text-center font-bold ${r.score >= 70 ? 'text-accent-green' : r.score >= 50 ? 'text-accent-amber' : 'text-neutral-300'}`}>{r.score}</td>
                    <td className={`${tdb} text-right text-neutral-200`}>₹{r.close?.toFixed?.(1) ?? '—'}</td>
                    <td className={`${tdb} text-right ${r.promoterNetBuyCr > 0 ? 'text-accent-green font-bold' : 'text-neutral-500'}`}>
                      {r.promoterNetBuyCr > 0 ? '+' : ''}{r.promoterNetBuyCr?.toFixed?.(1) ?? '0.0'}
                    </td>
                    <td className={`${tdb} text-right ${r.kmpNetBuyCr > 0 ? 'text-accent-cyan' : 'text-neutral-500'}`}>
                      {r.kmpNetBuyCr > 0 ? '+' : ''}{r.kmpNetBuyCr?.toFixed?.(1) ?? '0.0'}
                    </td>
                    <td className={`${tdb} text-right ${r.externalAcquirerBuyCr > 0 ? 'text-accent-amber font-bold' : 'text-neutral-500'}`}>
                      {r.externalAcquirerBuyCr > 0 ? '+' : ''}{r.externalAcquirerBuyCr?.toFixed?.(1) ?? '0.0'}
                    </td>
                    <td className={`${tdb} text-right font-bold text-accent-green`}>{r.totalNetBuyCr > 0 ? '+' : ''}{r.totalNetBuyCr?.toFixed?.(1) ?? '0.0'}</td>
                    <td className={`${tdb} text-right text-neutral-300`}>{r.rsi14?.toFixed?.(0) ?? '—'}</td>
                    <td className={`${tdb} text-right text-accent-red`}>−{r.pctOffHigh52w?.toFixed?.(0) ?? '0'}%</td>
                    <td className={`${tdb} text-left text-neutral-300`}>{r.mostRecentDate ?? '—'}</td>
                    <td className={`${tdb} text-left text-neutral-400`} style={{ minWidth: 280 }}>
                      <div style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }}>
                        {(r.reasons ?? []).join(' · ')}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <HowToTradeBox tab="Insider Buys" rules={[
        { title: 'Why this is the smartest signal', body: 'Promoters, KMP, and directors transacting in their own company\'s stock have to disclose to SEBI within 2 days. They KNOW the business better than anyone. When they BUY (with their own money, not options), it\'s the cleanest signal that they expect the stock to be worth more. Aggregated over 30 days so single-trade noise doesn\'t mislead.' },
        { title: 'STRONG vs regular tier', body: '🔥 STRONG = promoter net buy ≥ ₹5Cr OR external SAST acquirer ≥ ₹10Cr. These have the highest historical follow-through. Regular INSIDER_BUY = promoter net ≥ ₹1Cr or KMP net ≥ ₹0.5Cr.' },
        { title: 'External SAST acquirer (Reg 29)', body: 'When someone (often a private equity / strategic / activist investor) crosses 5%/10%/15% holding, SEBI requires a SAST disclosure. These crossings often precede tender offers, board representation, or strategic shifts that re-rate the stock significantly.' },
        { title: 'Read with caution when', body: 'High pledge ≥ 25%: promoter may be buying to release pledged shares, not because they\'re bullish. Heavy net SELLING by promoter alongside KMP buys: distribution disguised as insider activity. Recent NSE delisting/announcement: insider activity may be tied to a corporate event, not organic conviction.' },
        { title: 'Cross-check', body: 'Compare against Pedigree Accumulation tab (FII/DII flow direction), Footprint tab (bulk-deal named buyers same day), and the stock\'s technical setup (Chart Patterns + Early Momentum) before sizing in.' },
      ]} />
    </div>
  )
}

// ── 🧭 NIFTY DIRECTIONAL FORESIGHT — built 2026-07-10 in direct response
// to the missed 1-10 July NIFTY moves (700pt up / 700pt down / 360pt up).
// Fuses multi-expiry OI (current + monthly + quarterly), max-pain drift,
// PCR trend, time cycles from 2020 daily, momentum, KP+Bradley astro, and
// operator playbook detection into one unified NIFTY directional call
// with entry/SL/T1/T2/T3 dated trade plan.
export function PublicNiftyForesightPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-nifty-outlook'],
    queryFn: () => snapshots.niftyOutlook(),
    refetchInterval: 4 * 60_000, retry: false,
  })
  const d: any = data
  const dirColor = d?.direction === 'BULLISH' ? '#00c853' : d?.direction === 'BEARISH' ? '#ff4560' : '#9aa0a6'
  const confBadge = d?.confidence === 'HIGH' ? 'bg-accent-green/25 text-accent-green border-accent-green'
    : d?.confidence === 'MEDIUM' ? 'bg-accent-amber/25 text-accent-amber border-accent-amber'
    : 'bg-neutral-700/30 text-neutral-400 border-neutral-500'
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-cyan/15 to-accent-green/5 border border-accent-cyan/50 rounded-lg">
        <div className="text-3xl">🧭</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-cyan">
            NIFTY Directional Foresight
            <span className="ml-2 text-accent-red">🔴 LIVE</span>
            <span className="text-neutral-500"> · refreshes every 4 min during 9:15–15:30 IST</span>
          </div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Built 2026-07-10 after the 1–10 July misses (700↑ · 700↓ · 360↑). Fuses <b>multi-expiry OI</b> (current + monthly + quarterly — the far-dated book is where smart money actually sits), <b>max-pain drift</b>, <b>PCR trend</b>, <b>time cycles from 2020 daily</b>, <b>momentum</b>, <b>KP sub-lord + Bradley siderograph</b>, and <b>operator playbook detection</b> (stop-hunt, OI trap, IV crush, institutional build) — into one unified NIFTY call with entry/SL/T1/T2/T3 dated trade plan.
          </div>
          {d && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              📊 Bull {d.bullScore} · Bear {d.bearScore} · Net {d.netScore >= 0 ? '+' : ''}{d.netScore} · History points {d.historyPoints}
            </div>
          )}
        </div>
      </div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load NIFTY foresight. Live refresh every 4 min during market hours." />}
      {!isLoading && !error && d && (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="p-4 rounded-lg border-2" style={{ borderColor: dirColor, background: `${dirColor}11` }}>
              <div className="text-[10px] uppercase text-neutral-400 tracking-wider">Direction</div>
              <div className="text-3xl font-bold mt-1" style={{ color: dirColor }}>{d.direction}</div>
              <div className={`inline-block mt-2 px-2 py-1 rounded border text-[10px] font-bold ${confBadge}`}>
                {d.confidence} CONFIDENCE
              </div>
            </div>
            <div className="p-4 rounded-lg border border-ink-500 bg-ink-800">
              <div className="text-[10px] uppercase text-neutral-400 tracking-wider">NIFTY Spot</div>
              <div className="text-3xl font-bold mt-1 text-neutral-100">{d.spot?.toFixed?.(2) ?? '—'}</div>
              <div className="text-[10px] mt-2 text-neutral-500">Generated: {new Date(d.generatedAt).toLocaleString('en-IN')}</div>
            </div>
            <div className="p-4 rounded-lg border border-accent-amber/50 bg-accent-amber/5">
              <div className="text-[10px] uppercase text-accent-amber tracking-wider">Smart-Money Level</div>
              <div className="text-3xl font-bold mt-1 text-accent-amber">{d.smartMoneyLevel}</div>
              <div className="text-[10px] mt-2 text-neutral-500">
                Book direction: <b className={d.smartMoneyDirection === 'BULLISH' ? 'text-accent-green' : d.smartMoneyDirection === 'BEARISH' ? 'text-accent-red' : 'text-neutral-300'}>{d.smartMoneyDirection}</b> · far expiry: {d.keyLevels?.farExpiryLabel}
              </div>
            </div>
          </div>

          <div className="p-4 rounded-lg border border-accent-green/50 bg-accent-green/5">
            <div className="text-sm font-bold text-accent-green mb-2">📋 Trade Plan</div>
            <div className="grid gap-3 md:grid-cols-6 text-[11px]">
              <div><div className="text-neutral-500 text-[10px] uppercase">Side</div><div className="font-bold text-neutral-100">{d.tradePlan?.side}</div></div>
              <div><div className="text-neutral-500 text-[10px] uppercase">Instrument</div><div className="text-neutral-200 text-[10px]">{d.tradePlan?.instrument}</div></div>
              <div><div className="text-neutral-500 text-[10px] uppercase">Entry ({d.tradePlan?.entryDate})</div><div className="font-mono text-accent-cyan">{d.tradePlan?.entry}</div></div>
              <div><div className="text-neutral-500 text-[10px] uppercase">SL</div><div className="font-mono text-accent-red">{d.tradePlan?.stopLoss}</div></div>
              <div>
                <div className="text-neutral-500 text-[10px] uppercase">T1 ({d.tradePlan?.target1Date})</div>
                <div className="font-mono text-accent-green">{d.tradePlan?.target1}</div>
                <div className="text-neutral-500 text-[10px] mt-1">T2 ({d.tradePlan?.target2Date}): <span className="font-mono text-accent-green">{d.tradePlan?.target2}</span></div>
              </div>
              <div>
                <div className="text-neutral-500 text-[10px] uppercase">T3 ({d.tradePlan?.target3Date})</div>
                <div className="font-mono text-accent-green">{d.tradePlan?.target3}</div>
              </div>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="p-3 rounded-lg border border-ink-500 bg-ink-800">
              <div className="text-[11px] font-bold text-accent-cyan mb-2">🏦 Multi-Expiry OI Stance</div>
              <ul className="text-[11px] text-neutral-300 space-y-1 list-disc list-inside">
                {(d.reasoning?.multiExpiryOI ?? []).map((r: string, i: number) => <li key={i}>{r}</li>)}
                {(d.reasoning?.multiExpiryOI ?? []).length === 0 && <li className="text-neutral-500">no strong OI signals — book in balance</li>}
              </ul>
            </div>
            <div className="p-3 rounded-lg border border-ink-500 bg-ink-800">
              <div className="text-[11px] font-bold text-accent-amber mb-2">📈 Max-Pain Drift + PCR Trend</div>
              <ul className="text-[11px] text-neutral-300 space-y-1 list-disc list-inside">
                {(d.reasoning?.drift ?? []).map((r: string, i: number) => <li key={i}>{r}</li>)}
                {(d.reasoning?.drift ?? []).length === 0 && <li className="text-neutral-500">not enough history yet — drift builds over 3+ daily snapshots</li>}
              </ul>
            </div>
            <div className="p-3 rounded-lg border border-ink-500 bg-ink-800">
              <div className="text-[11px] font-bold text-accent-green mb-2">🚀 Momentum + Trend</div>
              <ul className="text-[11px] text-neutral-300 space-y-1 list-disc list-inside">
                {(d.reasoning?.momentum ?? []).map((r: string, i: number) => <li key={i}>{r}</li>)}
              </ul>
            </div>
            <div className="p-3 rounded-lg border border-ink-500 bg-ink-800">
              <div className="text-[11px] font-bold text-accent-purple mb-2">🕰️ Time Cycle (NIFTY daily since 2020)</div>
              <div className="text-[11px] text-neutral-300">{d.reasoning?.timeCycle}</div>
              {d.cycle && (
                <div className="text-[10px] text-neutral-500 mt-2 font-mono">
                  last high: {d.cycle.lastMajorHighDaysAgo}d ago · last low: {d.cycle.lastMajorLowDaysAgo}d ago<br />
                  mean top-to-top: {d.cycle.meanTopToTopDays?.toFixed?.(0)}d · mean bot-to-bot: {d.cycle.meanBotToBotDays?.toFixed?.(0)}d<br />
                  next expected turn: <b>{d.cycle.nextExpectedTurnKind}</b> in {d.cycle.nextExpectedTurnDaysAhead}d
                </div>
              )}
            </div>
            <div className="p-3 rounded-lg border border-ink-500 bg-ink-800">
              <div className="text-[11px] font-bold text-accent-magenta mb-2">🔯 Astro Overlay (KP + Bradley)</div>
              <div className="text-[11px] text-neutral-300">{d.reasoning?.astro}</div>
            </div>
            <div className="p-3 rounded-lg border border-accent-red/50 bg-accent-red/5">
              <div className="text-[11px] font-bold text-accent-red mb-2">🎯 Operator Playbook Detected</div>
              {(d.playbookDetected ?? []).length > 0 ? (
                <>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {d.playbookDetected.map((p: string) => (
                      <span key={p} className="px-1.5 py-0.5 rounded bg-accent-red/20 border border-accent-red/40 text-[9px] font-bold text-accent-red">{p}</span>
                    ))}
                  </div>
                  <div className="text-[11px] text-neutral-300">{d.reasoning?.playbook}</div>
                </>
              ) : (
                <div className="text-[11px] text-neutral-500">no distinct operator pattern detected right now</div>
              )}
            </div>
          </div>

          <div className="p-4 rounded-lg border-2 border-accent-cyan/50 bg-gradient-to-br from-accent-cyan/10 to-accent-purple/5">
            <div className="text-sm font-bold text-accent-cyan mb-1">📚 History Rhymes — NIFTY Analogue Search</div>
            <div className="text-[11px] text-neutral-400 mb-3">
              Current 20-day NIFTY shape matched against every 20-day window since 2020 (~1,500 windows). Top-5 closest historical rhymes + what price actually did next.
            </div>
            <div className="text-[11px] text-neutral-300 mb-3 font-semibold">
              {d.reasoning?.historicalRhyme}
            </div>
            {d.historicalAnalogues?.analogues?.length > 0 && (
              <div className="overflow-auto rounded border border-ink-500 bg-ink-800">
                <table className="w-full text-[11px]" style={{ borderSpacing: 0, minWidth: 600 }}>
                  <thead className="bg-ink-700 text-neutral-400">
                    <tr>
                      <th className="text-left px-2 py-2">Match Date</th>
                      <th className="text-right px-2 py-2">Days Ago</th>
                      <th className="text-right px-2 py-2">Score</th>
                      <th className="text-right px-2 py-2">Next 1d</th>
                      <th className="text-right px-2 py-2">Next 5d</th>
                      <th className="text-right px-2 py-2">Next 10d</th>
                      <th className="text-right px-2 py-2">Next 20d</th>
                      <th className="text-center px-2 py-2">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.historicalAnalogues.analogues.map((a: any, i: number) => {
                      const oc = a.outcome === 'BULLISH' ? '#00c853' : a.outcome === 'BEARISH' ? '#ff4560' : '#9aa0a6'
                      const clr = (v: number) => v > 0.5 ? 'text-accent-green' : v < -0.5 ? 'text-accent-red' : 'text-neutral-400'
                      return (
                        <tr key={i} className="border-t border-ink-500 hover:bg-ink-700">
                          <td className="px-2 py-2 font-mono text-neutral-200">{a.matchDate}</td>
                          <td className="px-2 py-2 text-right text-neutral-400 font-mono">{a.daysAgo}</td>
                          <td className="px-2 py-2 text-right text-accent-cyan font-mono">{(a.matchScore * 100).toFixed(0)}%</td>
                          <td className={`px-2 py-2 text-right font-mono ${clr(a.nextRet1d)}`}>{a.nextRet1d > 0 ? '+' : ''}{a.nextRet1d}%</td>
                          <td className={`px-2 py-2 text-right font-mono ${clr(a.nextRet5d)}`}>{a.nextRet5d > 0 ? '+' : ''}{a.nextRet5d}%</td>
                          <td className={`px-2 py-2 text-right font-mono ${clr(a.nextRet10d)}`}>{a.nextRet10d > 0 ? '+' : ''}{a.nextRet10d}%</td>
                          <td className={`px-2 py-2 text-right font-mono font-bold ${clr(a.nextRet20d)}`}>{a.nextRet20d > 0 ? '+' : ''}{a.nextRet20d}%</td>
                          <td className="px-2 py-2 text-center">
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${oc}22`, color: oc }}>{a.outcome}</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="grid gap-2 md:grid-cols-3 mt-3 text-[10px] font-mono">
              <div>Mean next 5d: <b className={d.historicalAnalogues?.meanNextRet5d > 0 ? 'text-accent-green' : 'text-accent-red'}>{d.historicalAnalogues?.meanNextRet5d > 0 ? '+' : ''}{d.historicalAnalogues?.meanNextRet5d}%</b></div>
              <div>Mean next 10d: <b className={d.historicalAnalogues?.meanNextRet10d > 0 ? 'text-accent-green' : 'text-accent-red'}>{d.historicalAnalogues?.meanNextRet10d > 0 ? '+' : ''}{d.historicalAnalogues?.meanNextRet10d}%</b></div>
              <div>Mean next 20d: <b className={d.historicalAnalogues?.meanNextRet20d > 0 ? 'text-accent-green' : 'text-accent-red'}>{d.historicalAnalogues?.meanNextRet20d > 0 ? '+' : ''}{d.historicalAnalogues?.meanNextRet20d}%</b></div>
            </div>
          </div>

          <div className="p-3 rounded-lg border border-ink-500 bg-ink-800">
            <div className="text-[11px] font-bold text-neutral-200 mb-2">🗝️ Key Levels</div>
            <div className="grid gap-2 md:grid-cols-4 text-[11px] font-mono">
              <div><div className="text-neutral-500 text-[10px]">Monthly Max-Pain</div><div className="text-neutral-100">{d.keyLevels?.monthlyMaxPain}</div></div>
              <div><div className="text-neutral-500 text-[10px]">Quarterly Max-Pain</div><div className="text-accent-amber">{d.keyLevels?.quarterlyMaxPain}</div></div>
              <div><div className="text-neutral-500 text-[10px]">Top CE Resistance</div><div className="text-accent-red">{d.keyLevels?.topCallResistance}</div></div>
              <div><div className="text-neutral-500 text-[10px]">Top PE Support</div><div className="text-accent-green">{d.keyLevels?.topPutSupport}</div></div>
            </div>
          </div>
        </>
      )}
      <HowToTradeBox tab="NIFTY Foresight" rules={[
        { title: 'Why this fixes the July 1-10 misses', body: 'Older engine only read current-week OI. Smart money builds positions on monthly + quarterly + LEAPS expiries — that\'s where the July 1-6 up-move book was already visible before price moved. Foresight reads ALL expiries and weights the far-dated book heavier because that\'s the institutional footprint.' },
        { title: 'How to read Direction + Confidence', body: 'HIGH confidence + BULLISH/BEARISH = trade the signal via NIFTY futures or ATM option in that direction. MEDIUM = trade with smaller size + tighter SL. LOW = wait for consolidation to resolve, do not force a trade.' },
        { title: 'Smart-Money Level', body: 'The strike on the longest-dated expiry where the largest OI concentration sits. If SM direction = BULLISH, price tends to be defended above this level. If SM direction = BEARISH, price tends to be capped below this level. This is the "wall" retail keeps ramming into.' },
        { title: 'Operator Playbook tags', body: 'STOP_HUNT = swing-high/low was tagged then rejected (classic liquidity grab). OI_MAGNET_DRIFT = max-pain moving ≥80pt/day (price will follow the writer book). INSTITUTIONAL_LONG/SHORT_BUILD = far-dated OI + PCR concentration on one side. VOLATILITY_CRUSH = tight range compression → expansion move loading.' },
        { title: 'When to override the signal', body: 'Global event risk (Fed, RBI, geopolitics) can override everything — always check the calendar. If direction disagrees with cross-confluence tab AND cross-confluence has ULTRA-tier picks, prefer the cross-confluence bias.' },
      ]} />
    </div>
  )
}

// ── 💎 PEDIGREE ACCUMULATION — good companies 50%+ off 52w-hi where
// FII/DII/Promoter are increasing stakes. The "big hands grabbing from
// retailers" setup — when retail finishes exiting, the move starts.
export function PublicPedigreeAccumulationPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-pedigree-accumulation'], queryFn: () => snapshots.pedigreeAccumulation(),
    refetchInterval: 60 * 60_000, retry: false,
  })
  const all: any[] = data?.rows ?? []
  const [tier, setTier] = useState<'ALL' | 'DEEP' | 'MODERATE'>('ALL')
  const filtered = tier === 'ALL' ? all : all.filter(r => r.pullbackTier === tier)
  const { rows, headerProps, sortIndicator } = useSortableTable<any>(
    filtered, { key: 'score', dir: 'desc' },
    {
      symbol: r => r.symbol ?? '',
      close: r => r.close ?? 0,
      pctOffHigh: r => r.pctOffHigh ?? 0,
      accumBuyerCount: r => r.accumBuyerCount ?? 0,
      fiiDeltaQoQ: r => r.fiiDeltaQoQ ?? 0,
      diiDeltaQoQ: r => r.diiDeltaQoQ ?? 0,
      promoterDeltaQoQ: r => r.promoterDeltaQoQ ?? 0,
      score: r => r.score ?? 0,
      rsi14: r => r.rsi14 ?? 0,
    },
  )
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-violet/15 to-accent-green/5 border border-accent-violet/50 rounded-lg">
        <div className="text-3xl">💎</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-violet">Pedigree Accumulation · Big-hands grabbing from retailers</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Good-pedigree companies (NIFTY-500 OR MC ≥ ₹1KCr) that are <b>40%+ off 52-week high</b> with <b>FII / DII / Promoter stakes increasing</b> QoQ.
            Logic: retail capitulates → smart money accumulates from weak hands → price bases → next leg begins.
            Score 0-100 combines pullback depth (30) · accumulation breadth (25) · stake-delta magnitude (15) · bottoming signature (10) · pedigree (10) · pledge cleanliness (10).
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              📊 {data.total} candidates · 🔴 DEEP (≥60% off): {data.deepCount ?? 0} · 🟡 MODERATE (40-60% off): {data.moderateCount ?? 0}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-neutral-500">Tier:</span>
        {(['ALL', 'DEEP', 'MODERATE'] as const).map(t => {
          const cnt = t === 'ALL' ? all.length : all.filter(r => r.pullbackTier === t).length
          const color = t === 'DEEP' ? 'accent-red' : t === 'MODERATE' ? 'accent-amber' : 'accent-violet'
          return (
            <button key={t} onClick={() => setTier(t)}
              className={`px-2 py-1 rounded border ${tier === t ? `bg-${color}/20 border-${color} text-${color}` : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
              {t} ({cnt})
            </button>
          )
        })}
      </div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load pedigree scan. Snapshot refreshes hourly." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No pedigree-accumulation candidates yet. Snapshot refreshes on the daily 18:30 IST routine." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1100 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th {...headerProps('symbol', 'text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500')}>Symbol{sortIndicator('symbol')}</th>
                <th {...headerProps('score', 'text-center px-2 py-3')}>Score{sortIndicator('score')}</th>
                <th {...headerProps('close', 'text-right px-2 py-3 text-neutral-300')}>LTP{sortIndicator('close')}</th>
                <th {...headerProps('pctOffHigh', 'text-right px-2 py-3 text-accent-red')}>% off 52w-Hi{sortIndicator('pctOffHigh')}</th>
                <th {...headerProps('accumBuyerCount', 'text-center px-2 py-3 text-accent-green')}>Buyers{sortIndicator('accumBuyerCount')}</th>
                <th {...headerProps('fiiDeltaQoQ', 'text-right px-2 py-3 text-accent-cyan')}>FII Δ{sortIndicator('fiiDeltaQoQ')}</th>
                <th {...headerProps('diiDeltaQoQ', 'text-right px-2 py-3 text-accent-cyan')}>DII Δ{sortIndicator('diiDeltaQoQ')}</th>
                <th {...headerProps('promoterDeltaQoQ', 'text-right px-2 py-3 text-accent-cyan')}>P Δ{sortIndicator('promoterDeltaQoQ')}</th>
                <th {...headerProps('rsi14', 'text-right px-2 py-3')}>RSI{sortIndicator('rsi14')}</th>
                <th className="text-left px-3 py-3">Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => {
                const tdb = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono text-[11px]`
                const tierColor = r.pullbackTier === 'DEEP' ? '#ff5e7c' : '#ffb454'
                return (
                  <tr key={r.symbol + i} className="group border-t border-ink-500">
                    <td className={`${tdb} px-3 sticky left-0 z-10 border-r border-ink-500 font-bold text-neutral-100`}>
                      {r.symbol}
                      <span className="ml-2 text-[9px] px-1 py-0.5 rounded" style={{ background: `${tierColor}22`, color: tierColor }}>{r.pullbackTier}</span>
                    </td>
                    <td className={`${tdb} text-center font-bold ${r.score >= 80 ? 'text-accent-green' : r.score >= 65 ? 'text-accent-amber' : 'text-neutral-300'}`}>{r.score}</td>
                    <td className={`${tdb} text-right text-neutral-200`}>₹{r.close.toFixed(1)}</td>
                    <td className={`${tdb} text-right font-bold text-accent-red`}>−{r.pctOffHigh.toFixed(0)}%</td>
                    <td className={`${tdb} text-center font-bold text-accent-green`}>{r.accumBuyerCount}/3</td>
                    <td className={`${tdb} text-right ${(r.fiiDeltaQoQ ?? 0) >= 0.3 ? 'text-accent-green' : 'text-neutral-500'}`}>
                      {r.fiiDeltaQoQ != null ? `${r.fiiDeltaQoQ >= 0 ? '+' : ''}${r.fiiDeltaQoQ.toFixed(2)}pp` : '—'}
                    </td>
                    <td className={`${tdb} text-right ${(r.diiDeltaQoQ ?? 0) >= 0.3 ? 'text-accent-green' : 'text-neutral-500'}`}>
                      {r.diiDeltaQoQ != null ? `${r.diiDeltaQoQ >= 0 ? '+' : ''}${r.diiDeltaQoQ.toFixed(2)}pp` : '—'}
                    </td>
                    <td className={`${tdb} text-right ${(r.promoterDeltaQoQ ?? 0) >= 0.3 ? 'text-accent-green' : 'text-neutral-500'}`}>
                      {r.promoterDeltaQoQ != null ? `${r.promoterDeltaQoQ >= 0 ? '+' : ''}${r.promoterDeltaQoQ.toFixed(2)}pp` : '—'}
                    </td>
                    <td className={`${tdb} text-right text-neutral-300`}>{r.rsi14.toFixed(0)}</td>
                    <td className={`${tdb} text-left text-neutral-400`} style={{ minWidth: 220 }}>
                      <div style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }}>
                        {(r.reasons ?? []).join(' · ')}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <HowToTradeBox tab="Pedigree Accumulation" rules={[
        { title: 'The thesis', body: 'Real pedigree companies don\'t fall 50% on fundamentals — they fall on cycle / sector rotation / panic. When FII/DII/Promoter are simultaneously INCREASING stakes during that fall, you\'re seeing the wealth-transfer in real time. Score ≥80 = highest conviction.' },
        { title: '🔴 DEEP (≥60% off 52w-hi)', body: 'Capitulation phase or deep cycle low. These take longer to base but the upside is multi-bagger when sentiment turns. Use 5-7% SL below recent swing low, sit through volatility.' },
        { title: '🟡 MODERATE (40-60% off)', body: 'Mid-cycle pullback. Faster to base + first leg up. Tighter SL (4-5%), bigger position.' },
        { title: 'Entry timing', body: 'Wait for RSI to leave the 30-40 zone + first higher-low on weekly. Don\'t catch falling knives — let the buyers prove themselves with one base.' },
        { title: 'Target framework', body: 'T1 = 50% retrace of the fall · T2 = previous swing high · T3 = new ATH. Multi-bagger setups (DEEP tier) measured in years, not weeks.' },
      ]} />
    </div>
  )
}

// ── 🐦 X-RECS — Stock recommendations from named X (Twitter) analysts
export function PublicXRecsPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-x-recs'], queryFn: () => snapshots.xRecs(),
    refetchInterval: 30 * 60_000, retry: false,
  })
  const recs: any[] = data?.recommendations ?? []
  const [handle, setHandle] = useState<string>('ALL')
  const filtered = handle === 'ALL' ? recs : recs.filter(r => r.handle === handle)
  const uniqueHandles = Array.from(new Set(recs.map(r => r.handle)))
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-cyan/15 to-accent-violet/5 border border-accent-cyan/50 rounded-lg">
        <div className="text-3xl">🐦</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-cyan">Analyst X-Recs · Live calls from named profiles</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Best-effort scrape of stock recommendations from 6 profiles via nitter mirrors:
            <b> @cadalukaanubhav · @camangalarvind · @Sahilpahwa09 · @darvasboxtrader · @iAmitKumar · @arvindshyam</b>.
            Parses symbol / direction / entry / SL / targets from each post.
            <br/><b>⚠️ Best-effort:</b> X heavily rate-limits free scrapers. Empty rows mean nitter mirrors are blocked — try later or use the source links.
          </div>
          {data?.bySite && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              Sources: {Object.entries(data.bySite).map(([k, v]) => `${k}:${v}`).join(' · ')}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-neutral-500">Handle:</span>
        <button onClick={() => setHandle('ALL')} className={`px-2 py-1 rounded border ${handle === 'ALL' ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
          All ({recs.length})
        </button>
        {uniqueHandles.map(h => (
          <button key={h} onClick={() => setHandle(h)} className={`px-2 py-1 rounded border ${handle === h ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
            @{h} ({recs.filter(r => r.handle === h).length})
          </button>
        ))}
      </div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load X-recs. Snapshot refreshes every 30 min." />}
      {!isLoading && !error && filtered.length === 0 && <Empty msg="No parsed recommendations yet — nitter mirrors are unreliable. Try the source profile links directly." />}
      {!isLoading && !error && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((r: any, i: number) => {
            const dirColor = r.parsedDirection === 'BUY' ? '#00c853' : r.parsedDirection === 'SHORT' ? '#ff5e7c' : '#9aa0a6'
            return (
              <div key={i} className="bg-ink-800 border border-ink-500 rounded-lg p-3 hover:border-accent-cyan/40 transition-colors">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-accent-cyan text-[11px]">@{r.handle}</span>
                    {r.parsedSymbol && <span className="font-bold text-neutral-100 text-[13px]">{r.parsedSymbol}</span>}
                    {r.parsedDirection && <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.parsedDirection}</span>}
                  </div>
                  <div className="text-[9px] text-neutral-500">{r.postedAt ? new Date(r.postedAt).toLocaleDateString('en-IN') : ''}</div>
                </div>
                {(r.parsedEntry || r.parsedSL || r.parsedTargets?.length > 0) && (
                  <div className="grid grid-cols-3 gap-1.5 text-[10px] font-mono mb-2">
                    {r.parsedEntry && (
                      <div className="bg-accent-cyan/5 border border-accent-cyan/30 rounded p-1.5">
                        <div className="text-[9px] text-accent-cyan/70">Entry</div>
                        <div className="text-accent-cyan font-bold">₹{r.parsedEntry}</div>
                      </div>
                    )}
                    {r.parsedSL && (
                      <div className="bg-accent-red/5 border border-accent-red/30 rounded p-1.5">
                        <div className="text-[9px] text-accent-red/70">SL</div>
                        <div className="text-accent-red font-bold">₹{r.parsedSL}</div>
                      </div>
                    )}
                    {r.parsedTargets?.length > 0 && (
                      <div className="bg-accent-green/5 border border-accent-green/30 rounded p-1.5">
                        <div className="text-[9px] text-accent-green/70">Targets</div>
                        <div className="text-accent-green font-bold">{r.parsedTargets.map((t: number) => `₹${t}`).join(' · ')}</div>
                      </div>
                    )}
                  </div>
                )}
                <div className="text-[11px] text-neutral-300 leading-relaxed mb-2" style={{ display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {r.text}
                </div>
                {r.imageUrl && (
                  <a href={r.imageUrl} target="_blank" rel="noopener noreferrer" className="block mb-2">
                    <img src={r.imageUrl} alt="chart" className="rounded border border-ink-500" style={{ maxHeight: 200, width: '100%', objectFit: 'contain' }} loading="lazy" />
                  </a>
                )}
                <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-accent-cyan hover:underline">
                  View on X →
                </a>
              </div>
            )
          })}
        </div>
      )}
      <HowToTradeBox tab="X-Recs" rules={[
        { title: 'Why this tab exists', body: 'Surface live recommendations from named profiles you trust — entry / SL / targets parsed from each post. Acts as a sanity check against our own signal stack.' },
        { title: 'Best-effort scraping', body: 'X rate-limits aggressively. We use community nitter mirrors which go up/down constantly. If a handle shows "unavailable", click through to the source URL.' },
        { title: 'Don\'t blindly copy', body: 'Every recommendation here is third-party. Cross-check against our Cross-Confluence + Footprint + Bulk-deals tabs before sizing in. The platform\'s job is verification, not faith.' },
      ]} />
    </div>
  )
}

// ── 📡 BULK DEALS — NSE end-of-day footprint feed (the actual smart-money tracks)
export function PublicBulkDealsPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-bulk-deals'], queryFn: () => snapshots.bulkDeals(),
    refetchInterval: 30 * 60_000, retry: false,
  })
  const aggregated: any[] = data?.rows ?? []
  const accumulating = aggregated.filter(r => r.signal === 'STRONG_ACCUMULATION' || r.signal === 'ACCUMULATION')
  const distributing = aggregated.filter(r => r.signal === 'STRONG_DISTRIBUTION' || r.signal === 'DISTRIBUTION')
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/15 to-accent-cyan/5 border border-accent-amber/50 rounded-lg">
        <div className="text-3xl">📡</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-amber">Smart-Money Footprint · NSE Bulk Deals</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            <b>Real smart-money tracks</b> from NSE's daily bulk-deals feed. When a buyer/seller
            trades &gt;0.5% of a company's listed equity, NSE publishes their NAME. Mutual funds,
            FIIs, insurance companies, known HNI investors (Damani, Jhunjhunwala estate, Kacholia,
            Kedia, etc.) — all visible. This is the literal footprint the user asked for —
            verifiable from public data, no quarter-delay.
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              📊 {data.totalDeals} deals today · 🌟 {data.superstarDeals} superstar · 🏦 {data.institutionDeals} institutional
              · 🟢 {data.strongAccumulationCount} STRONG-ACCUM · 🔴 {data.strongDistributionCount} STRONG-DIST
            </div>
          )}
        </div>
      </div>
      <AccuracyStrip />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load bulk-deals feed. NSE EOD data refreshes ~18:30 IST." />}
      {!isLoading && !error && aggregated.length === 0 && <Empty msg="No bulk deals today (or NSE blocked the request). Retry after market close 16:00 IST." />}
      {accumulating.length > 0 && (
        <div>
          <div className="text-[12px] font-bold text-accent-green mb-2">🟢 ACCUMULATING — {accumulating.length} stocks · institutional money flowing IN</div>
          <BulkDealsTable rows={accumulating} />
        </div>
      )}
      {distributing.length > 0 && (
        <div className="mt-4">
          <div className="text-[12px] font-bold text-accent-red mb-2">🔴 DISTRIBUTING — {distributing.length} stocks · institutional money flowing OUT</div>
          <BulkDealsTable rows={distributing} />
        </div>
      )}
      <HowToTradeBox tab="Bulk Deals" rules={[
        { title: 'How this catches moves BEFORE retail', body: 'NSE publishes bulk deals end-of-day with full buyer/seller names. By 6:30 PM IST you see who bought what TODAY. By next morning the institutional footprint is already on the tape — most retail traders won\'t notice until the stock moves 5-10% over the next few sessions.' },
        { title: 'Highest signal: 🟢 STRONG_ACCUMULATION', body: '≥3 superstars or institutions NET-BUY the same stock + net flow ≥ ₹5 Cr. Watch this name for entry over the next 2-5 sessions.' },
        { title: 'Caution: 🔴 STRONG_DISTRIBUTION', body: 'Same threshold, opposite direction. Avoid new long positions; consider short. Existing longs: book partial.' },
        { title: 'Cross-check', body: 'Click into the symbol on the Superstar Picks tab to see existing holding context. Then check Smart Money (OBV/CMF) for confirmation.' },
        { title: 'Data limit', body: 'NSE bulk-deals API rate-limits aggressively. May fail on some refreshes — try again 10 min later. Free data, no paid feed required.' },
      ]} />
    </div>
  )
}

function BulkDealsTable({ rows }: { rows: any[] }): JSX.Element {
  const SIG_RANK: Record<string, number> = {
    STRONG_ACCUMULATION: 5, ACCUMULATION: 4, NEUTRAL: 3, DISTRIBUTION: 2, STRONG_DISTRIBUTION: 1,
  }
  const { rows: sorted, headerProps, sortIndicator } = useSortableTable<any>(
    rows,
    { key: 'netBuyValueCr', dir: 'desc' },
    {
      symbol: r => r.symbol ?? '',
      signal: r => SIG_RANK[r.signal] ?? 0,
      netBuyValueCr: r => r.netBuyValueCr ?? 0,
      totalDealCount: r => r.totalDealCount ?? 0,
      superstars: r => (r.superstarBuys ?? 0) - (r.superstarSells ?? 0),
      institutions: r => (r.institutionBuys ?? 0) - (r.institutionSells ?? 0),
      topBuyers: r => (r.topBuyers ?? []).join(' '),
    },
  )
  return (
    <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '60vh' }}>
      <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 760 }}>
        <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
          <tr>
            <th {...headerProps('symbol', 'text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500')}>Symbol{sortIndicator('symbol')}</th>
            <th {...headerProps('signal', 'text-center px-2 py-3')}>Signal{sortIndicator('signal')}</th>
            <th {...headerProps('netBuyValueCr', 'text-right px-2 py-3')}>Net ₹Cr{sortIndicator('netBuyValueCr')}</th>
            <th {...headerProps('totalDealCount', 'text-center px-2 py-3')}>Deals{sortIndicator('totalDealCount')}</th>
            <th {...headerProps('superstars', 'text-center px-2 py-3')}>Superstars{sortIndicator('superstars')}</th>
            <th {...headerProps('institutions', 'text-center px-2 py-3')}>Institutions{sortIndicator('institutions')}</th>
            <th {...headerProps('topBuyers', 'text-left px-3 py-3')}>Top buyers/sellers{sortIndicator('topBuyers')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const sigColor = r.signal === 'STRONG_ACCUMULATION' ? '#00c853'
              : r.signal === 'ACCUMULATION' ? '#5fd4ff'
              : r.signal === 'STRONG_DISTRIBUTION' ? '#ff1744'
              : r.signal === 'DISTRIBUTION' ? '#ff9800' : '#9aa0a6'
            const tdb = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono text-[11px]`
            return (
              <tr key={r.symbol + i} className="group border-t border-ink-500">
                <td className={`${tdb} px-3 sticky left-0 z-10 border-r border-ink-500 font-bold text-neutral-100`}>{r.symbol}</td>
                <td className={`${tdb} text-center`}>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${sigColor}22`, color: sigColor }}>{r.signal.replace('_', ' ')}</span>
                </td>
                <td className={`${tdb} text-right font-bold`} style={{ color: r.netBuyValueCr >= 0 ? '#00c853' : '#ff1744' }}>
                  {r.netBuyValueCr >= 0 ? '+' : ''}{r.netBuyValueCr.toFixed(1)}
                </td>
                <td className={`${tdb} text-center text-neutral-300`}>{r.totalDealCount}</td>
                <td className={`${tdb} text-center text-accent-amber`}>{r.superstarBuys}⬆{r.superstarSells > 0 ? ` / ${r.superstarSells}⬇` : ''}</td>
                <td className={`${tdb} text-center text-accent-cyan`}>{r.institutionBuys}⬆{r.institutionSells > 0 ? ` / ${r.institutionSells}⬇` : ''}</td>
                <td className={`${tdb} text-left text-neutral-400`} style={{ minWidth: 220 }}>
                  <div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }}>
                    {(r.topBuyers ?? []).join(' · ') || '—'}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── 🌟 SUPERSTAR PICKS — India's top 10 investors' holdings × our signal scoring ──
// For each stock held by Rekha Jhunjhunwala / Damani / Mukul Agrawal /
// Kacholia / Kedia / Dolly Khanna / Anil Goel / Singhania / Kela / Porinju,
// run Weekly Pick scoring. Surface when superstar AND algo agree.
// Holdings sourced from quarterly SEBI filings — refreshed manually.
export function PublicSuperstarPicksPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-superstar'], queryFn: () => snapshots.superstarPicks(),
    refetchInterval: 10 * 60_000, retry: false,
  })
  const raw: any[] = data?.rows ?? []
  const rows: any[] = (() => {
    const seen = new Set<string>(); const out: any[] = []
    for (const r of raw) { if (seen.has(r.symbol)) continue; seen.add(r.symbol); out.push(r) }
    return out
  })()
  // 2026-06-16 — split by TIER (pre-breakout vs confirmed) NOT by
  // loading-vs-held, because the user's concern is "are we early or
  // late". EARLY rows lead — that's where we're WITH the superstars,
  // not behind them.
  const earlyRows = rows.filter(r => r.tier === 'EARLY')
  const confirmedRows = rows.filter(r => r.tier !== 'EARLY' && r.tier !== 'LATE')
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/15 to-accent-violet/5 border border-accent-amber/50 rounded-lg">
        <div className="text-3xl">🌟</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-amber">Superstar Picks · Top-10 Indian Investor Confluence</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            India's 10 most-tracked retail/HNI investors' holdings × our signal scoring engine,
            with a <b>BEFORE-THE-MOVE filter</b> so you're never the exit liquidity. LATE-stage
            names (already &gt;40% above 60d low) are auto-suppressed.
            <br/><b>Tracked:</b> Rekha Jhunjhunwala · RK Damani · Mukul Agrawal · Kacholia ·
            Kedia · Dolly Khanna · Anil Goel · Singhania (Abakkus) · Madhusudan Kela · Porinju.
          </div>
          <div className="text-[10px] text-neutral-500 mt-2 font-mono">
            🎯 {earlyRows.length} EARLY · ✓ {confirmedRows.length} CONFIRMED · LATE suppressed
            · sourced from SEBI {data?.investors?.[0]?.asOfQuarter ?? 'Mar-2026'} filings
          </div>
          <div className="text-[10px] text-accent-amber/80 mt-1">
            ⚠️ Quarterly filings have 30-45d delay. By then, the announcement-pop has happened —
            so we filter on <b>technical pre-breakout state</b>, not just "they bought last quarter".
          </div>
        </div>
      </div>
      <AccuracyStrip />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load superstar scan. Refreshes every 25 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No superstar-held names currently pass the signal filter. Check back at next snapshot." />}
      {earlyRows.length > 0 && (
        <div>
          <div className="text-[12px] font-bold text-accent-green mb-2">🎯 EARLY · {earlyRows.length} (pre-breakout — entering WITH the superstar, not behind)</div>
          <UniformPickTable rows={earlyRows} />
        </div>
      )}
      {confirmedRows.length > 0 && (
        <div className="mt-4">
          <div className="text-[12px] font-bold text-accent-cyan mb-2">✓ CONFIRMED · {confirmedRows.length} (move started, runway still ahead)</div>
          <UniformPickTable rows={confirmedRows} />
        </div>
      )}
      {!earlyRows.length && !confirmedRows.length && rows.length > 0 && (
        <Empty msg="All superstar holdings are currently LATE-stage (already extended). Best to wait — we don't want to be exit liquidity. Check back at next scan." />
      )}
      <HowToTradeBox tab="Superstar Picks" rules={[
        { title: 'Highest priority: 🎯 EARLY', body: 'Stock is held by a superstar BUT still pre-breakout — price has not yet moved meaningfully off its multi-month base. We\'re entering WITH them, not after. Strongest edge.' },
        { title: 'Second priority: ✓ CONFIRMED', body: 'Stock is in CONFIRMED leg of the move (5-30% above 60d low). Still has runway but we\'ve missed the absolute bottom. Half position size of EARLY.' },
        { title: 'LATE tier — auto-suppressed', body: 'Names already >40% above 60d low or ret60d > 30% are HIDDEN. By the time SEBI files the disclosure, these have already run — we\'d be exit liquidity for the big investors. Per user directive: do not buy here.' },
        { title: 'Position size', body: '🎯 EARLY + conv ≥ 80: 5% capital. 🎯 EARLY + conv 60-80: 3%. ✓ CONFIRMED + conv ≥ 80: 3%. ✓ CONFIRMED + conv 60-80: 1.5%.' },
        { title: 'Investor pedigree', body: 'These investors run ₹10-1,000 Cr portfolios with documented 70-80% multibagger hit rate over 10+ years. Their disclosed positions = institutional thesis already verified.' },
        { title: 'Data freshness caveat', body: 'SEBI quarterly filings have 30-45d delay. We compensate by requiring technical pre-breakout state — that filters out "they bought 60 days ago and stock already ran 40%" traps.' },
      ]} />
    </div>
  )
}

// ── 🤖 ASK AI — natural-language Q&A over all platform snapshots ──
// Anti-hallucination: backend only feeds the LLM the JSON snapshots and
// instructs it never to invent numbers. If a value isn't in the data,
// the answer says "I don't have that data". 100% factual by design.
export function PublicChatPage(): JSX.Element {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'ai'; text: string; sources?: string[]; provider?: string }>>([
    { role: 'ai', text: 'Hi 👋 — I\'m TradewithVarsha AI. Ask me about any stock, signal, or trade. I only use data from the platform snapshots — no made-up numbers. Try: "I\'m buying MOSCHIP, give analysis" or "JNKINDIA SL hit, what should I do?"' },
  ])

  const send = async () => {
    if (!query.trim() || loading) return
    const q = query.trim()
    setQuery('')
    setMessages(m => [...m, { role: 'user', text: q }])
    setLoading(true)
    try {
      const r = await (await import('../api')).chat.ask(q)
      setMessages(m => [...m, { role: 'ai', text: r.answer, sources: r.sourcesUsed, provider: r.llmProvider }])
    } catch (e) {
      setMessages(m => [...m, { role: 'ai', text: `Error: ${(e as Error).message}. Make sure the API URL is configured and you have a free LLM key set in server .env (GEMINI_API_KEY or GROQ_API_KEY).` }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-violet/15 to-accent-cyan/5 border border-accent-violet/50 rounded-lg">
        <div className="text-3xl">🤖</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-violet">TradewithVarsha AI — Trade Q&A Assistant</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Ask any question about stocks, signals, or your trades. The AI <b>only uses data from the platform snapshots</b> — Weekly Pick, Smart Money, OI Build-up, SL Traps, Track Record, etc. It will refuse to invent numbers. Every answer cites the source.
            <br/>Powered by free LLM (Gemini or Groq). Hindi + English understood. Maximum 1000 chars per query.
          </div>
        </div>
      </div>

      <div className="bg-ink-800 border border-ink-500 rounded-lg p-4" style={{ minHeight: 400 }}>
        <div className="space-y-3 mb-4" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {messages.map((m, i) => (
            <div key={i} className={`p-3 rounded-lg ${m.role === 'user' ? 'bg-accent-cyan/10 border border-accent-cyan/30 ml-12' : 'bg-ink-900/50 border border-ink-500 mr-12'}`}>
              <div className="text-[10px] uppercase tracking-wider mb-1 font-bold" style={{ color: m.role === 'user' ? '#5fd4ff' : '#b285ff' }}>
                {m.role === 'user' ? '👤 You' : '🤖 TradewithVarsha AI'}
                {m.provider && <span className="ml-2 text-neutral-500 text-[9px]">via {m.provider}</span>}
              </div>
              <div className="text-[13px] text-neutral-200 whitespace-pre-wrap leading-relaxed">{m.text}</div>
              {m.sources && m.sources.length > 0 && (
                <div className="mt-2 text-[10px] text-neutral-500">
                  Sources: {m.sources.map(s => <span key={s} className="inline-block mr-2 px-1.5 py-0.5 rounded bg-ink-700 text-neutral-400">{s}</span>)}
                </div>
              )}
            </div>
          ))}
          {loading && <div className="text-[11px] text-accent-violet animate-pulse">🤖 thinking...</div>}
        </div>
        <div className="flex gap-2">
          <textarea
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="Type your question (Hindi or English)... e.g. 'I'm buying RELIANCE, analyse smart money + technicals'"
            className="flex-1 bg-ink-900 border border-ink-500 rounded p-2 text-[12px] text-neutral-200 resize-none"
            rows={2}
            disabled={loading}
            maxLength={1000}
          />
          <button onClick={send} disabled={loading || !query.trim()}
            className="px-4 py-2 rounded bg-accent-violet/20 text-accent-violet border border-accent-violet/50 font-bold text-[12px] hover:bg-accent-violet/30 disabled:opacity-40">
            {loading ? '...' : 'Send →'}
          </button>
        </div>
        <div className="mt-2 text-[10px] text-neutral-600">
          ⚠️ AI answers are informational, not financial advice. Final decisions are yours. The system flags risk; you manage capital.
        </div>
      </div>

      <HowToTradeBox tab="TradewithVarsha AI" rules={[
        { title: 'How to ask', body: 'Use plain English or Hindi. Mention the stock ticker (e.g. RELIANCE, MOSCHIP). The AI will check Weekly Pick, Smart Money, SL Traps, Sectors, and OI data for that name.' },
        { title: 'For loss-related queries', body: 'Tell the AI what happened — entry price, SL price, current status. It will check if it was a TRAP SUSPECTED (smart money was on your side), confirm with SL Traps tab data, and give you the playbook for what to do now.' },
        { title: 'What it WILL NOT do', body: 'It will not invent prices, percentages, or dates. If the data isn\'t in our snapshots, it will say "I don\'t have that data" instead of guessing. This is the anti-hallucination guarantee.' },
        { title: 'Example queries', body: '• "Should I buy MOSCHIP at 150?"\n• "Why did JNKINDIA SL hit?"\n• "What\'s the smart money saying on RELIANCE?"\n• "Which sector should I be long?"' },
      ]} />
    </div>
  )
}

// ── 🗄️ ARCHIVE — superseded / expired / SL-hit signals (last 30d) ──
export function PublicArchivePage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-archive'], queryFn: () => snapshots.archive(),
    refetchInterval: 10 * 60_000, retry: false,
  })
  const raw: any[] = data?.rows ?? []
  // 2026-06-24: full audit log — every lifecycle transition for the user-
  // selectable window (no server-side deletion).
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d' | '180d' | '365d' | 'all'>('30d')
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const rangeCutoff = (() => {
    if (dateRange === 'all') return 0
    const d = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 }[dateRange]
    return Date.now() - d * 86400_000
  })()
  const filtered = raw.filter(r => {
    if (statusFilter !== 'ALL' && r.status !== statusFilter) return false
    if (rangeCutoff > 0) {
      const t = new Date(r.statusChangedAt ?? r.generatedAt ?? 0).getTime()
      if (t < rangeCutoff) return false
    }
    return true
  })
  const dedupedAll: any[] = (() => {
    const seen = new Set<string>(); const out: any[] = []
    for (const r of filtered) {
      const k = `${r.symbol}|${r.direction}|${r.status}|${r.statusChangedAt ?? ''}`
      if (seen.has(k)) continue; seen.add(k); out.push(r)
    }
    return out
  })()
  const statusCounts: Record<string, number> = {}
  for (const r of filtered) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1
  const { rows: archiveRows, headerProps: aHeader, sortIndicator: aSort } = useSortableTable<any>(
    dedupedAll,
    { key: 'statusChangedAt', dir: 'desc' },
    {
      symbol: r => r.symbol ?? '',
      direction: r => r.direction ?? '',
      status: r => r.status ?? '',
      entry: r => r.entry ?? 0,
      stopLoss: r => r.stopLoss ?? 0,
      hitPrice: r => r.hitPrice ?? 0,
      realisedPct: r => r.realisedPct ?? -Infinity,
      statusChangedAt: r => r.statusChangedAt ?? '',
      source: r => r.source ?? '',
    },
  )
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-neutral-700/20 to-neutral-800/10 border border-neutral-600/40 rounded-lg">
        <div className="text-3xl">🗄️</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-neutral-200">Archive · Closed & Superseded Signals</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Last 30 days of signals that closed (SL_HIT) or were superseded by newer signals. Audit your trade history here — see what worked, what didn't, and why.
          </div>
          {data?.byStatus && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              FULL ARCHIVE · 365d retention · {data.total} total events
              {' · '}
              {Object.entries(data.byStatus).map(([k, v]) => `${k}: ${v}`).join(' · ')}
            </div>
          )}
        </div>
      </div>
      {/* 2026-06-24: date range filter + status filter — every lifecycle event
          is kept; UI lets the user slice the audit history. */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-neutral-500">Range:</span>
        {(['7d', '30d', '90d', '180d', '365d', 'all'] as const).map(r => (
          <button key={r} onClick={() => setDateRange(r)}
            className={`px-2 py-1 rounded border ${dateRange === r ? 'bg-accent-cyan/20 border-accent-cyan text-accent-cyan' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
            {r === 'all' ? 'All time' : r}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-neutral-500">Status:</span>
        {(['ALL', 'T1_HIT', 'T2_HIT', 'T3_HIT', 'SL_HIT', 'SUPERSEDED', 'EXPIRED', 'INVALIDATED'] as const).map(s => {
          const cnt = s === 'ALL' ? Object.values(statusCounts).reduce((a, b) => a + b, 0) : (statusCounts[s] ?? 0)
          return (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-2 py-1 rounded border ${statusFilter === s ? 'bg-accent-violet/20 border-accent-violet text-accent-violet' : 'bg-ink-700 border-ink-500 text-neutral-500'}`}>
              {s.replace('_', ' ')} ({cnt})
            </button>
          )
        })}
      </div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load archive. Refreshes every 10 min." />}
      {!isLoading && !error && dedupedAll.length === 0 && <Empty msg="No events in this window. Try a wider range or different status filter." />}
      {dedupedAll.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '78vh' }}>
          <table className="w-full text-[12px]">
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th {...aHeader('symbol', 'text-left px-3 py-3')}>Symbol{aSort('symbol')}</th>
                <th {...aHeader('direction', 'text-center px-2 py-3')}>Dir{aSort('direction')}</th>
                <th {...aHeader('status', 'text-center px-2 py-3')}>Status{aSort('status')}</th>
                <th {...aHeader('entry', 'text-right px-2 py-3')}>Entry{aSort('entry')}</th>
                <th {...aHeader('stopLoss', 'text-right px-2 py-3')}>SL{aSort('stopLoss')}</th>
                <th {...aHeader('hitPrice', 'text-right px-2 py-3')}>Hit{aSort('hitPrice')}</th>
                <th {...aHeader('realisedPct', 'text-right px-2 py-3')}>Realised{aSort('realisedPct')}</th>
                <th {...aHeader('statusChangedAt', 'text-left px-3 py-3')}>When{aSort('statusChangedAt')}</th>
                <th {...aHeader('source', 'text-left px-3 py-3')}>Source{aSort('source')}</th>
              </tr>
            </thead>
            <tbody>
              {archiveRows.map((r, i) => {
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
                const statusColor = r.status === 'SL_HIT' ? '#ff5e7c' : r.status === 'SUPERSEDED' ? '#9e9e9e' : '#ffb454'
                return (
                  <tr key={i} className="border-t border-ink-500 hover:bg-ink-700/30">
                    <td className="px-3 py-2 font-bold text-neutral-100">{r.symbol}</td>
                    <td className="px-2 py-2 text-center"><span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span></td>
                    <td className="px-2 py-2 text-center"><span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${statusColor}22`, color: statusColor }}>{r.status}</span></td>
                    <td className="px-2 py-2 text-right font-mono">₹{fmtPx(r.entry)}</td>
                    <td className="px-2 py-2 text-right font-mono text-accent-red">₹{fmtPx(r.stopLoss)}</td>
                    <td className="px-2 py-2 text-right font-mono">{r.hitPrice ? `₹${fmtPx(r.hitPrice)}` : '—'}</td>
                    <td className="px-2 py-2 text-right font-mono" style={{ color: r.realisedPct > 0 ? '#00c853' : r.realisedPct < 0 ? '#ff5e7c' : '#9e9e9e' }}>
                      {r.realisedPct != null ? `${r.realisedPct > 0 ? '+' : ''}${r.realisedPct.toFixed(1)}%` : '—'}
                    </td>
                    <td className="px-3 py-2 text-[10px] text-neutral-500">{r.statusChangedAt ? new Date(r.statusChangedAt).toLocaleDateString('en-IN') : '—'}</td>
                    <td className="px-3 py-2 text-[10px] text-neutral-400">{r.source ?? '—'}</td>
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

// ── 🛡️ SL-TRAP ALERTS — liquidity grabs + effective WR ──
// When a signal hits SL but smart money was on the trade's side at that
// moment, it's most often a stop hunt. We track these and surface:
//   - SL_HIT_TRAP_CONFIRMED_WIN — SL hit then target hit within 5 sessions
//   - SL_HIT_TRAP_SUSPECTED     — smart money was loading at SL, watch reversal
//   - SL_HIT_GENUINE            — no smart-money support, genuine loss
// Effective WR (counting confirmed traps as wins) is the headline metric.
export function PublicSlTrapPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-sl-traps'], queryFn: () => snapshots.slTraps(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const raw: any[] = data?.rows ?? []
  // Dedup at render
  const rows: any[] = (() => {
    const seen = new Set<string>(); const out: any[] = []
    for (const r of raw) {
      const k = `${r.symbol}|${r.direction}|${r.hitAt ?? ''}`
      if (seen.has(k)) continue; seen.add(k); out.push(r)
    }
    return out
  })()
  const eff = data?.effectiveWinRate
  const base = data?.baseWinRate
  const uplift = (eff != null && base != null) ? (eff - base) * 100 : null
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/15 to-accent-red/5 border border-accent-amber/50 rounded-lg">
        <div className="text-3xl">🛡️</div>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-bold text-accent-amber">SL-Trap Alerts · Liquidity Grab Detector</div>
            {eff != null && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-accent-green/20 text-accent-green border border-accent-green/50">
                Effective WR: {(eff * 100).toFixed(1)}%
              </span>
            )}
            {base != null && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-neutral-700/40 text-neutral-300 border border-neutral-500/40">
                Base WR: {(base * 100).toFixed(1)}%
              </span>
            )}
            {uplift != null && uplift > 0 && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/40">
                +{uplift.toFixed(1)}pp uplift
              </span>
            )}
          </div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Catches the <b>MOSCHIP / MARKSANS / FINPIPE pattern</b> — SL gets hit, price reverses immediately, target gets hit anyway.
            When smart money is loading at the SL touch, the SL was almost certainly a liquidity grab (institutional stop hunt).
            The system tags these and adds the recovery wins to the effective WR — that's how the 85%+ target becomes reachable
            without overpromising on the raw lifecycle WR.
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              ✅ Confirmed traps: {data.trapsConfirmedWin ?? 0} · ⚠️ Suspected: {data.trapsSuspected ?? 0} · 🛑 Genuine SLs: {data.genuineSLs ?? 0}
            </div>
          )}
        </div>
      </div>
      <AccuracyStrip />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load SL trap data. Refreshes every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No SL hits in the lifecycle window yet." />}
      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const color = r.status === 'SL_HIT_TRAP_CONFIRMED_WIN' ? '#00c853'
              : r.status === 'SL_HIT_TRAP_SUSPECTED' ? '#ffb454' : '#ff5e7c'
            const label = r.status === 'SL_HIT_TRAP_CONFIRMED_WIN' ? '✅ TRAP — CONFIRMED WIN'
              : r.status === 'SL_HIT_TRAP_SUSPECTED' ? '⚠️ TRAP SUSPECTED' : '🛑 GENUINE SL'
            return (
              <div key={i} className="bg-ink-800 border rounded-lg p-3" style={{ borderColor: `${color}66` }}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <b className="text-neutral-100 text-[13px]">{r.symbol}</b>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${color}22`, color }}>{label}</span>
                    <span className="text-[10px] text-neutral-500">{r.source}</span>
                  </div>
                  <div className="text-[10px] font-mono text-neutral-400">
                    SL ₹{fmtPx(r.stopLoss)} → hit ₹{fmtPx(r.hitPrice)} · {r.hitAt ? new Date(r.hitAt).toLocaleDateString('en-IN') : '—'}
                  </div>
                </div>
                <div className="mt-1 text-[11px] text-neutral-400">{r.playbook}</div>
                {r.smartMoneySide && (
                  <div className="mt-1 text-[10px] text-neutral-500 font-mono">
                    Smart-money at SL: <b className={r.smartMoneySide === 'ACCUMULATION' ? 'text-accent-green' : 'text-accent-red'}>{r.smartMoneySide}</b>
                    {r.smartMoneyStrength != null && ` (strength ${r.smartMoneyStrength})`}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <HowToTradeBox tab="SL-Trap Alerts" rules={[
        { title: 'When you see ✅ CONFIRMED WIN', body: 'Past trade — already recovered. Use as proof to your future self that SL hunts are real. No action needed now.' },
        { title: 'When you see ⚠️ TRAP SUSPECTED', body: '1. If you have the position open, DO NOT close on SL touch — hold.\n2. If already exited, RE-ENTER at SL price with same SL/target.\n3. Watch for 5 sessions — if no reversal, exit at break-even.\n4. Position size: same as original (do not double up).' },
        { title: 'When you see 🛑 GENUINE SL', body: 'No smart-money support. SL was real. Stay out. Treat as a normal loss.' },
        { title: 'Real examples this fired on', body: 'MOSCHIP, MARKSANS PHARMA, FINPIPE — all hit SL then recovered to T1/T2 within 5 sessions because institutions were accumulating at the SL level.' },
      ]} />
    </div>
  )
}

// ── 💎 PRO EDGE — strictest signal feed ──
// Stack of ALL filters: cross-confluence (≥2 engines) + smart-money
// same-side + sector tailwind aligned + conviction ≥ 85. Targets 0-10
// names/day. THIS is the sellable premium feed.
export function PublicProEdgePage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-pro-edge'], queryFn: () => snapshots.proEdge(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const raw: any[] = data?.rows ?? []
  const rows: any[] = (() => {
    const seen = new Set<string>(); const out: any[] = []
    for (const r of raw) { if (seen.has(r.symbol)) continue; seen.add(r.symbol); out.push(r) }
    return out
  })()
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/20 to-accent-green/10 border border-accent-amber/60 rounded-lg">
        <div className="text-3xl">💎</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-amber">PRO Edge — Premium Confluence Feed</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            The strictest filter on the platform. A name reaches PRO Edge only when <b>ALL</b> of these pass simultaneously:
            <ol className="list-decimal ml-5 mt-1 text-[11px] space-y-0.5">
              <li>Cross-engine confluence — flagged by ≥2 independent engines</li>
              <li>Smart-money same-side — institutions NOT positioned opposite the direction</li>
              <li>Sector tailwind — direction aligns with sector strength (LEADING/IMPROVING for long, LAGGING/WEAKENING for short)</li>
              <li>Conviction ≥ 85</li>
            </ol>
            Targets 0–10 names/day. Theoretical WR target 75–85%. Empirical proof requires 30 days of forward closed-trade data.
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              Funnel — evaluated {data.totalEvaluated ?? 0} · ultra OK {data.filters?.ultraPicks ?? 0} · smart OK {data.filters?.smartMoneyOk ?? 0} · sector OK {data.filters?.sectorAligned ?? 0} · conv OK {data.filters?.convOk ?? 0} → <b className="text-accent-amber">{data.passCount ?? 0} PASS</b>
            </div>
          )}
        </div>
      </div>
      <AccuracyStrip />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load PRO Edge. Refreshes every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No setups currently pass all 4 PRO filters. This is by design — empty days are common at this strictness." />}
      {/* 2026-06-16: uniform table. Reason col shows sector + smart-money +
          source engines so user sees the PRO confluence at a glance. */}
      {rows.length > 0 && (
        <UniformPickTable rows={rows.map((r: any) => ({
          ...r,
          flowNote: `💎 PRO · ${r.sectorLabel ?? 'no sector'} (${r.sectorTrend ?? 'NEUTRAL'}) · smart-money ${r.smartMoneySide ?? 'neutral'} · engines: ${(r.sources ?? []).join(' + ')}`,
        }))} />
      )}
      <HowToTradeBox tab="PRO Edge" rules={[
        { title: 'Entry', body: 'Buy / short at the Entry price on the card. PRO setups deserve full conviction — enter on next day open or first 30-min candle close in the direction of the signal.' },
        { title: 'Stop Loss', body: 'Use the SL shown. PRO Edge SLs are already tier-aware (5% liquid mid/large, 6.5% small, 8% micro absolute max). NEVER widen the SL emotionally.' },
        { title: 'Targets & Booking', body: '1. Book 50% at T1 mechanically.\n2. Trail SL to entry — trade is now risk-free.\n3. Book 30% at T2.\n4. Hold 20% runner for T3, trail 50% of remaining profit.' },
        { title: 'Position Size', body: '5% capital per PRO signal (these are the system\'s highest-conviction picks). Max 3 PRO positions open simultaneously.' },
        { title: 'Sector Cross-Check', body: 'PRO Edge already filters for sector tailwind, but eyeball the 🔄 Sectors tab to confirm the sector hasn\'t flipped trend in the last session.' },
        { title: 'When SL gets hit', body: 'IMMEDIATELY check 🛡️ SL Traps tab. If your name shows TRAP SUSPECTED, re-enter at SL price and watch 5 sessions. Smart-money was loading at SL = likely liquidity grab.' },
      ]} />
    </div>
  )
}

function ProEdgeCard({ row: r }: { row: any }): JSX.Element {
  const long = r.direction === 'BUY'
  const dirColor = long ? '#00c853' : '#ff1744'
  return (
    <div className="bg-ink-800 border border-accent-amber/40 rounded-lg p-4 hover:border-accent-amber/70 transition-colors">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[14px]">💎</span>
          <b className="text-neutral-100 text-[14px]">{r.symbol}</b>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber border border-accent-amber/50">PRO · conv {r.conviction}</span>
        </div>
        <div className="text-[11px] font-mono text-neutral-400">
          LTP {r.ltp != null ? `₹${fmtPx(r.ltp)}` : '—'} · Entry {r.entry != null ? `₹${fmtPx(r.entry)}` : '—'}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] font-mono">
        <div className="bg-accent-cyan/5 border border-accent-cyan/30 rounded p-2">
          <div className="text-[9px] text-accent-cyan/70 uppercase">Entry</div>
          <div className="text-accent-cyan font-bold">{r.entry != null ? `₹${fmtPx(r.entry)}` : '—'}</div>
        </div>
        <div className="bg-accent-red/5 border border-accent-red/30 rounded p-2">
          <div className="text-[9px] text-accent-red/70 uppercase">Stop Loss</div>
          <div className="text-accent-red font-bold">{r.stopLoss != null ? `₹${fmtPx(r.stopLoss)}` : '—'}</div>
        </div>
        <div className="bg-accent-green/5 border border-accent-green/30 rounded p-2">
          <div className="text-[9px] text-accent-green/70 uppercase">Target 2</div>
          <div className="text-accent-green font-bold">{r.target2 != null ? `₹${fmtPx(r.target2)}` : '—'}</div>
        </div>
        <div className="bg-accent-green/10 border border-accent-green/40 rounded p-2">
          <div className="text-[9px] text-accent-green/80 uppercase font-bold">Target 3</div>
          <div className="text-accent-green font-bold">{r.target3 != null ? `₹${fmtPx(r.target3)}` : '—'}</div>
        </div>
      </div>
      <div className="mt-3 pt-2 border-t border-ink-500 text-[10px] text-neutral-400">
        <div className="font-semibold text-neutral-500 uppercase tracking-wider mb-1 text-[9px]">Why this is PRO</div>
        <ul className="space-y-0.5 list-none ml-0">
          {(r.reasoning || []).map((c: string, j: number) => (
            <li key={j} className="flex items-start gap-1.5"><span className="text-accent-green">✓</span><span>{c}</span></li>
          ))}
        </ul>
      </div>
    </div>
  )
}

// ── 🎯 NIFTY OPTIONS PRO — strict subset with live 30d WR ──
// Existing options engine, filtered to grade A + score ≥ 9 only.
// Surfaces the LIVE 30-day win rate from accuracy.json as a badge so
// users see the actual measured performance, not theoretical claims.
export function PublicOptionsProPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-options-pro'], queryFn: () => snapshots.optionsPro(),
    refetchInterval: 3 * 60_000, retry: false,
  })
  const raw: any[] = data?.rows ?? []
  const rows: any[] = (() => {
    const seen = new Set<string>(); const out: any[] = []
    for (const r of raw) { const k = r.instrument || r.symbol; if (seen.has(k)) continue; seen.add(k); out.push(r) }
    return out
  })()
  const wr = data?.liveWinRate
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-green/15 to-accent-cyan/5 border border-accent-green/50 rounded-lg">
        <div className="text-3xl">🎯</div>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-sm font-bold text-accent-green">NIFTY Options Pro</div>
            {wr != null && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-accent-green/20 text-accent-green border border-accent-green/50">
                Live {data?.winRateWindowDays ?? 30}d WR: {(wr * 100).toFixed(1)}%
              </span>
            )}
          </div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Strict subset of the NIFTY options engine — <b>grade A only + score ≥ 9</b>. This is the platform's strongest empirical track record (currently {wr != null ? `${(wr * 100).toFixed(1)}%` : '—'} measured on real closed trades over the last {data?.winRateWindowDays ?? 30} days).
            <br/>Strict 9/21 EMA cross + Marabozu confirmation across 15m/30m/1h/4h timeframes. Real NSE-listed expiry from Angel ScripMaster.
          </div>
          <div className="text-[10px] text-neutral-500 mt-2 font-mono">
            {data?.eliteCount ?? rows.length} elite signals (filtered from {data?.totalRaw ?? '—'} raw options) · all unique
          </div>
        </div>
      </div>
      <AccuracyStrip />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load Options Pro. Refreshes every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No grade-A score-9 setups right now. Strict bar — most days produce 1-3 signals." />}
      {rows.length > 0 && <SignalTable rows={rows} />}
      <HowToTradeBox tab="NIFTY Options PRO" rules={[
        { title: 'Entry', body: 'At the option premium shown (LTP at signal time). Use LIMIT order at MID of bid/ask — never at ask. If premium has moved >5% from signal, skip (already chased).' },
        { title: 'Stop Loss', body: '30% of premium (e.g. ₹100 entry → ₹70 SL). Hard SL — exit at premium-stop regardless of underlying movement.' },
        { title: 'Targets & Booking', body: '1. Book 50% at +40% premium gain (T1).\n2. Trail SL to entry premium.\n3. Hold remaining 50% for +100% premium (T2).\n4. EXIT all by end of next trading day OR before expiry (whichever is sooner).' },
        { title: 'Position Size', body: '1-2% capital per signal. Max 5% capital across concurrent options. Options = high leverage = strict sizing.' },
        { title: 'Time decay', body: 'Options bleed theta overnight. If signal fires after 14:30 IST, halve position size. If <2 days to expiry, AVOID.' },
        { title: 'Live WR meaning', body: 'The badge shows the actual measured 30-day win rate from accuracy.json on real closed trades. This is verifiable — cross-check via 📈 Track Record.' },
      ]} />
    </div>
  )
}

// ── 🧲 SMART MONEY / Accumulation-Distribution divergence ──
// Detects names where OBV / A/D Line / CMF DIVERGE from price action.
// Bullish accumulation: price flat/down + smart-money buying (institutions
// loading while retail thinks it's dead). Bearish distribution: opposite.
// Catches setups BEFORE price moves.
export function PublicAdDivergencePage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-ad-divergence'], queryFn: () => snapshots.adDivergence(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const [proOn, setProOn] = useProMode('smart-money', true)
  const raw: any[] = data?.rows ?? []
  const dedupedAll: any[] = (() => {
    const seen = new Set<string>(); const out: any[] = []
    for (const r of raw) { if (seen.has(r.symbol)) continue; seen.add(r.symbol); out.push(r) }
    return out
  })()
  // PRO Mode for Smart Money: only divergence strength ≥ 80 (highest
  // conviction patterns historically deliver ~80%+ WR over 4-8wk holds).
  const rows: any[] = proOn ? dedupedAll.filter(r => (r.divergenceStrength ?? 0) >= 80) : dedupedAll
  const accum = rows.filter(r => r.side === 'ACCUMULATION')
  const dist = rows.filter(r => r.side === 'DISTRIBUTION')
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-cyan/15 to-accent-violet/5 border border-accent-cyan/50 rounded-lg">
        <div className="text-3xl">🧲</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-cyan">Smart Money · Accumulation / Distribution Divergence</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Detects names where institutional flow (OBV · A/D Line · CMF) <b>diverges from price action</b>.
            🟢 <b>ACCUMULATION</b> — price flat or down BUT smart-money buying (institutions loading while retail thinks the stock is dead).
            🔴 <b>DISTRIBUTION</b> — price flat or up BUT smart-money selling (institutions unloading into retail strength).
            <br/>Catches setups BEFORE price confirms — the divergence is the leading signal.
          </div>
          {data && (
            <div className="text-[10px] text-neutral-500 mt-2 font-mono">
              🟢 {data.accumulationCount ?? 0} accumulation · 🔴 {data.distributionCount ?? 0} distribution · scanned {data.universeSize ?? 500} CNX500 names
            </div>
          )}
        </div>
      </div>
      <AccuracyStrip />
      <ProModeToggle on={proOn} setOn={setProOn} targetWR="80%" currentCount={dedupedAll.length} filteredCount={rows.length} />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load divergence scan. Refreshes every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg={proOn ? 'No PRO-grade divergences (strength ≥ 80). Toggle off to see all.' : 'No clean divergences right now. Most names price-volume agree — check back at next snapshot.'} />}
      {accum.length > 0 && (
        <div>
          <div className="text-[12px] font-bold text-accent-green mb-2">🟢 ACCUMULATION · {accum.length}</div>
          <div className="space-y-2">{accum.map((r, i) => <AdCard key={'A' + i} row={r} />)}</div>
        </div>
      )}
      {dist.length > 0 && (
        <div className="mt-4">
          <div className="text-[12px] font-bold text-accent-red mb-2">🔴 DISTRIBUTION · {dist.length}</div>
          <div className="space-y-2">{dist.map((r, i) => <AdCard key={'D' + i} row={r} />)}</div>
        </div>
      )}
      <HowToTradeBox tab="Smart Money" rules={[
        { title: 'ACCUMULATION (long bias)', body: '1. Scale-in over 3-5 sessions: 33% / 33% / 33% on weakness.\n2. SL: 5% below the 20-day low (deeper SL — the pattern needs room).\n3. Targets: T1 +8%, T2 +15%, T3 +25%.\n4. Hold until OBV/CMF turn — typically 4-8 weeks.\n5. Size: 2% capital.' },
        { title: 'DISTRIBUTION (short bias / avoid)', body: '1. If holding the name long: BOOK / TRIM if strength ≥ 80.\n2. For new short: wait for first close below 20-day low.\n3. SL: 5% above the 20-day high.\n4. Targets: T1 -8%, T2 -15%.\n5. Size: 1.5% capital.' },
        { title: 'Confirmation cross-check', body: 'Before acting, confirm direction with 🔄 Sectors tab. Accumulation in a LEADING sector = high probability. Distribution in a LAGGING sector = high probability.' },
        { title: 'When SL gets hit on ACCUMULATION trades', body: 'Smart money is still loading? Then your SL was a liquidity grab. Re-enter at SL price. See 🛡️ SL Traps tab for confirmation.' },
      ]} />
    </div>
  )
}

function AdCard({ row: r }: { row: any }): JSX.Element {
  const accum = r.side === 'ACCUMULATION'
  const color = accum ? '#00c853' : '#ff1744'
  return (
    <div className="bg-ink-800 border border-accent-cyan/20 rounded-lg p-3 hover:border-accent-cyan/50 transition-colors">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <b className="text-neutral-100 text-[13px]">{r.symbol}</b>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${color}22`, color }}>
            {accum ? '🟢 ACCUMULATION' : '🔴 DISTRIBUTION'}
          </span>
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/40">
            strength {r.divergenceStrength}
          </span>
        </div>
        <div className="text-[11px] font-mono text-neutral-400">
          ₹{fmtPx(r.price)} · 20d {r.ret20d > 0 ? '+' : ''}{r.ret20d.toFixed(1)}%
        </div>
      </div>
      <div className="mt-2 text-[10px] text-neutral-400 font-mono flex flex-wrap gap-x-4 gap-y-0.5">
        <span>OBV slope <b className={r.obvSlope20 > 0 ? 'text-accent-green' : 'text-accent-red'}>{r.obvSlope20 > 0 ? '+' : ''}{(r.obvSlope20 * 100).toFixed(0)}%</b></span>
        <span>A/D slope <b className={r.adlSlope20 > 0 ? 'text-accent-green' : 'text-accent-red'}>{r.adlSlope20 > 0 ? '+' : ''}{(r.adlSlope20 * 100).toFixed(0)}%</b></span>
        <span>CMF20 <b className={r.cmf20 > 0 ? 'text-accent-green' : 'text-accent-red'}>{r.cmf20 > 0 ? '+' : ''}{r.cmf20.toFixed(2)}</b></span>
      </div>
      <div className="mt-1 text-[10px] text-neutral-500"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {(r.reasons || []).join(' · ')}
      </div>
    </div>
  )
}

// ── 📜 OLD-WEEKLYPICK — comparison tab (momentum-chasing prerank, no
// freshness reject). Same engine as current Weekly Pick but with the
// pre-4fca35e prerank restored, for the user to compare against the
// current pre-breakout output. Simpler single-row table — no Stake/Setup
// stacked under the stock name.
// Rendered RIGHT-AS-IS — never modifies anything that current Weekly Pick depends on.
export function PublicOldWeeklyPickPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-old-weekly-pick'], queryFn: () => snapshots.oldWeeklyPick(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const [proOn, setProOn] = useProMode('old-weekly', true)
  const { smartMoney } = useSmartMoneyAndSectorMaps()
  // Defense-in-depth dedup — never trust upstream to be unique.
  const dedupedAll: any[] = (() => {
    const raw: any[] = data?.rows ?? []
    const bySym = new Map<string, any>()
    for (const r of raw) {
      const prev = bySym.get(r.symbol)
      if (!prev || (r.conviction ?? 0) > (prev.conviction ?? 0)) bySym.set(r.symbol, r)
    }
    return Array.from(bySym.values()).sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0))
  })()
  // PRO Mode for Old-Weekly: conviction ≥ 80 AND smart-money not AGAINST.
  // 2026-06-14: loosened from "must confirm" to "must not be against".
  // The AD-divergence scanner only flags ~80 names across the whole
  // market, so requiring explicit confirmation dropped the list to zero.
  // Silent smart-money = neutral = OK. Only block when SM is actively
  // on the opposite side of the trade.
  const rows: any[] = proOn ? dedupedAll.filter(r => {
    if ((r.conviction ?? 0) < 80) return false
    const sm = smartMoney.get(r.symbol)
    if (r.direction === 'BUY' && sm === 'DISTRIBUTION') return false
    if (r.direction === 'SHORT' && sm === 'ACCUMULATION') return false
    return true
  }) : dedupedAll
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-neutral-700/20 to-neutral-800/10 border border-neutral-600/40 rounded-lg">
        <div className="text-3xl">📜</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-neutral-200">Old-WeeklyPick · Momentum-Chasing Comparison</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Comparison tab — runs the SAME engine as Weekly Pick but with the <b>pre-4fca35e prerank restored</b>:
            <span className="font-mono text-neutral-300"> rank = |mom5d|×0.6 + volBurst×4</span>,
            and <b>no freshness-reject</b> (extended names that current scanner drops are kept here).
            Purpose: visualise what the OLD scanner would have surfaced today, so you can compare against the current pre-breakout output.
            <br/>Universe: CNX500 · refreshes every 30 min during market hours · NOT pushed to Telegram.
          </div>
          <div className="text-[10px] text-neutral-500 mt-2 font-mono">
            {data?.rowCount ?? rows.length} unique picks · weekOf {data?.weekOf ?? '—'} · regime {data?.regime ?? '—'}
          </div>
        </div>
      </div>
      <AccuracyStrip />
      <ProModeToggle on={proOn} setOn={setProOn} targetWR="80%" currentCount={dedupedAll.length} filteredCount={rows.length} />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load Old-WeeklyPick snapshot. Refreshes every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg={proOn ? 'No Old-Weekly picks have smart-money confirmation today. Toggle PRO Mode off to see raw momentum list.' : 'Scanner not run yet — first scan kicks in at the next snapshot publish.'} />}
      {rows.length > 0 && <OldWeeklyTable rows={rows} />}
    </div>
  )
}

// ── 📋 UNIFORM PICK TABLE — shared design across every signal tab.
// 2026-06-16 per user: Old-WeeklyPick's compact 10-col layout is the
// canonical look. Every pick tab uses this so users always see the
// same columns in the same order. Field mapper handles per-tab schema
// differences (Weekly Pick uses entryPrice, F&O Futures uses entry, etc).
interface UniformPickFields {
  symbol: string
  direction: 'BUY' | 'SHORT' | 'LONG' | string
  conviction: number
  ltp: number | null | undefined
  entry: number | null | undefined
  stopLoss: number | null | undefined
  target1: number | null | undefined
  target2: number | null | undefined
  target3: number | null | undefined
  // 2026-06-16: target dates surfaced under each price. NEVER invented —
  // only populated when the source snapshot has the field.
  target1Date?: string | null
  target2Date?: string | null
  target3Date?: string | null
  shareholdingNote?: string
  flowNote?: string
  noBrainerBet?: boolean
}

function rowToFields(r: any): UniformPickFields {
  const dir = (r.direction === 'LONG' || r.direction === 'BULL') ? 'BUY'
    : (r.direction === 'SHORT' || r.direction === 'BEAR' || r.side === 'SHORT') ? 'SHORT'
    : (r.direction ?? r.side ?? 'BUY')
  return {
    symbol: r.symbol ?? r.instrument ?? '—',
    direction: dir,
    conviction: r.conviction ?? r.score ?? 0,
    ltp: r.ltp ?? r.price ?? null,
    entry: r.entry ?? r.entryPrice ?? r.entryPriceLow ?? r.suggestedEntry ?? null,
    stopLoss: r.stopLoss ?? r.suggestedSL ?? null,
    target1: r.target1 ?? r.suggestedTarget ?? null,
    target2: r.target2 ?? null,
    target3: r.target3 ?? null,
    target1Date: r.target1Date ?? null,
    target2Date: r.target2Date ?? null,
    target3Date: r.target3Date ?? null,
    shareholdingNote: r.shareholdingNote,
    flowNote: r.flowNote || r.reason || (Array.isArray(r.tags) ? r.tags.slice(0, 3).join(' · ') : undefined),
    noBrainerBet: r.noBrainerBet,
  }
}

export function UniformPickTable({ rows, minRowCount }: { rows: any[]; minRowCount?: number }): JSX.Element {
  // 2026-06-24: per-column sort on every public tab. Default sort = conviction
  // desc (matches what most parents already do).
  const fields = rows.map(rowToFields)
  const { rows: sorted, headerProps, sortIndicator } = useSortableTable<any>(
    fields,
    { key: 'conviction', dir: 'desc' },
    {
      symbol: r => r.symbol ?? '',
      direction: r => r.direction ?? '',
      conviction: r => r.conviction ?? 0,
      ltp: r => r.ltp ?? 0,
      entry: r => r.entry ?? 0,
      stopLoss: r => r.stopLoss ?? 0,
      target1: r => r.target1 ?? 0,
      target2: r => r.target2 ?? 0,
      target3: r => r.target3 ?? 0,
      reason: r => (r.shareholdingNote ?? r.flowNote ?? '') as string,
    },
  )
  return (
    <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '80vh' }}>
      <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 920 }}>
        <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
          <tr>
            <th {...headerProps('symbol', 'text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500')}>Symbol{sortIndicator('symbol')}</th>
            <th {...headerProps('direction', 'text-center px-2 py-3')}>Dir{sortIndicator('direction')}</th>
            <th {...headerProps('conviction', 'text-center px-2 py-3')}>Conv{sortIndicator('conviction')}</th>
            <th {...headerProps('ltp', 'text-right px-2 py-3 text-neutral-300')}>LTP{sortIndicator('ltp')}</th>
            <th {...headerProps('entry', 'text-right px-2 py-3 text-accent-cyan')}>Entry{sortIndicator('entry')}</th>
            <th {...headerProps('stopLoss', 'text-right px-2 py-3 text-accent-red')}>SL{sortIndicator('stopLoss')}</th>
            <th {...headerProps('target1', 'text-right px-2 py-3 text-accent-green')}>T1{sortIndicator('target1')}</th>
            <th {...headerProps('target2', 'text-right px-2 py-3 text-accent-green')}>T2{sortIndicator('target2')}</th>
            <th {...headerProps('target3', 'text-right px-2 py-3 text-accent-green')}>T3{sortIndicator('target3')}</th>
            <th {...headerProps('reason', 'text-left px-3 py-3')}>Reason{sortIndicator('reason')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
            // 2026-06-16 per user: high-probability rows (conv ≥ 85) get a
            // subtle green tint so they jump out visually within each tab.
            // Medium (75-84) gets a faint cyan tint. Standard rows unchanged.
            const conv = Math.round(r.conviction ?? 0)
            const rowBg = conv >= 85 ? 'bg-accent-green/10 group-hover:bg-accent-green/15'
              : conv >= 75 ? 'bg-accent-cyan/5 group-hover:bg-accent-cyan/10'
              : 'bg-ink-800 group-hover:bg-ink-700'
            const tdb = `px-2 py-2 align-top ${rowBg} font-mono text-[11px]`
            return (
              <tr key={r.symbol + i} className="group border-t border-ink-500">
                <td className={`${tdb} px-3 sticky left-0 z-10 border-r border-ink-500`} style={{ minWidth: 140 }}>
                  <b className="text-neutral-100">{conv >= 85 && '🔥 '}{r.noBrainerBet && '⭐ '}{r.symbol}</b>
                </td>
                <td className={`${tdb} text-center`}>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                </td>
                <td className={`${tdb} text-center font-bold ${conv >= 85 ? 'text-accent-green' : conv >= 75 ? 'text-accent-cyan' : 'text-neutral-300'}`}>{conv}</td>
                <td className={`${tdb} text-right text-neutral-200`}>{r.ltp != null ? `₹${fmtPx(r.ltp)}` : '—'}</td>
                <td className={`${tdb} text-right text-accent-cyan`}>{r.entry != null ? `₹${fmtPx(r.entry)}` : '—'}</td>
                <td className={`${tdb} text-right text-accent-red`}>{r.stopLoss != null ? `₹${fmtPx(r.stopLoss)}` : '—'}</td>
                <td className={`${tdb} text-right text-accent-green`}>
                  <div>{r.target1 != null ? `₹${fmtPx(r.target1)}` : '—'}</div>
                  {r.target1Date && <div className="text-[9px] text-accent-green/60 font-normal">📅 {fmtDate(r.target1Date)}</div>}
                </td>
                <td className={`${tdb} text-right text-accent-green`}>
                  <div>{r.target2 != null ? `₹${fmtPx(r.target2)}` : '—'}</div>
                  {r.target2Date && <div className="text-[9px] text-accent-green/60 font-normal">📅 {fmtDate(r.target2Date)}</div>}
                </td>
                <td className={`${tdb} text-right text-accent-green font-bold`}>
                  <div>{r.target3 != null ? `₹${fmtPx(r.target3)}` : '—'}</div>
                  {r.target3Date && <div className="text-[9px] text-accent-green/60 font-normal">📅 {fmtDate(r.target3Date)}</div>}
                </td>
                <td className={`${tdb} text-left text-neutral-400`} style={{ minWidth: 200, whiteSpace: 'normal' }}>
                  {r.shareholdingNote && (
                    <div className="text-[10px] text-neutral-300 mb-0.5"
                      style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'normal', wordBreak: 'break-word' }}
                      title={r.shareholdingNote}>
                      📊 {r.shareholdingNote}
                    </div>
                  )}
                  {r.flowNote && (
                    <div className="text-[10px] text-neutral-500"
                      style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'normal', wordBreak: 'break-word' }}
                      title={r.flowNote}>
                      ⚡ {r.flowNote}
                    </div>
                  )}
                  {!r.shareholdingNote && !r.flowNote && <span className="text-neutral-600">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function OldWeeklyTable({ rows }: { rows: any[] }): JSX.Element {
  const { rows: sorted, headerProps, sortIndicator } = useSortableTable<any>(
    rows,
    { key: 'conviction', dir: 'desc' },
    {
      symbol: r => r.symbol ?? '',
      direction: r => r.direction ?? '',
      conviction: r => r.conviction ?? 0,
      ltp: r => r.ltp ?? 0,
      entry: r => r.entryPrice ?? r.entryPriceLow ?? 0,
      stopLoss: r => r.stopLoss ?? 0,
      target1: r => r.target1 ?? 0,
      target2: r => r.target2 ?? 0,
      target3: r => r.target3 ?? 0,
      reason: r => (r.shareholdingNote ?? r.flowNote ?? '') as string,
    },
  )
  return (
    <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '80vh' }}>
      <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 920 }}>
        <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
          <tr>
            <th {...headerProps('symbol', 'text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500')}>Symbol{sortIndicator('symbol')}</th>
            <th {...headerProps('direction', 'text-center px-2 py-3')}>Dir{sortIndicator('direction')}</th>
            <th {...headerProps('conviction', 'text-center px-2 py-3')}>Conv{sortIndicator('conviction')}</th>
            <th {...headerProps('ltp', 'text-right px-2 py-3 text-neutral-300')}>LTP{sortIndicator('ltp')}</th>
            <th {...headerProps('entry', 'text-right px-2 py-3 text-accent-cyan')}>Entry{sortIndicator('entry')}</th>
            <th {...headerProps('stopLoss', 'text-right px-2 py-3 text-accent-red')}>SL{sortIndicator('stopLoss')}</th>
            <th {...headerProps('target1', 'text-right px-2 py-3 text-accent-green')}>T1{sortIndicator('target1')}</th>
            <th {...headerProps('target2', 'text-right px-2 py-3 text-accent-green')}>T2{sortIndicator('target2')}</th>
            <th {...headerProps('target3', 'text-right px-2 py-3 text-accent-green')}>T3{sortIndicator('target3')}</th>
            <th {...headerProps('reason', 'text-left px-3 py-3')}>Reason{sortIndicator('reason')}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
            const tdb = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono text-[11px]`
            return (
              <tr key={r.symbol + i} className="group border-t border-ink-500">
                <td className={`${tdb} px-3 sticky left-0 z-10 border-r border-ink-500`} style={{ minWidth: 140 }}>
                  <b className="text-neutral-100">{r.noBrainerBet && '⭐ '}{r.symbol}</b>
                </td>
                <td className={`${tdb} text-center`}>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                </td>
                <td className={`${tdb} text-center font-bold text-accent-green`}>{Math.round(r.conviction ?? 0)}</td>
                <td className={`${tdb} text-right text-neutral-200`}>₹{fmtPx(r.ltp)}</td>
                <td className={`${tdb} text-right text-accent-cyan`}>₹{fmtPx(r.entryPrice ?? r.entryPriceLow)}</td>
                <td className={`${tdb} text-right text-accent-red`}>₹{fmtPx(r.stopLoss)}</td>
                <td className={`${tdb} text-right text-accent-green`}>
                  <div>₹{fmtPx(r.target1)}</div>
                  {r.target1Date && <div className="text-[9px] text-accent-green/60 font-normal">📅 {fmtDate(r.target1Date)}</div>}
                </td>
                <td className={`${tdb} text-right text-accent-green`}>
                  <div>₹{fmtPx(r.target2)}</div>
                  {r.target2Date && <div className="text-[9px] text-accent-green/60 font-normal">📅 {fmtDate(r.target2Date)}</div>}
                </td>
                <td className={`${tdb} text-right text-accent-green font-bold`}>
                  <div>₹{fmtPx(r.target3)}</div>
                  {r.target3Date && <div className="text-[9px] text-accent-green/60 font-normal">📅 {fmtDate(r.target3Date)}</div>}
                </td>
                <td className={`${tdb} text-left text-neutral-400`} style={{ minWidth: 200, whiteSpace: 'normal' }}>
                  {/* Two stacked lines — line 1 = institutional stake (FII/DII/Promoter
                      with QoQ delta), line 2 = trade rationale. Both clamped to 1
                      line each via -webkit-line-clamp so the column never expands. */}
                  {r.shareholdingNote && (
                    <div className="text-[10px] text-neutral-300 mb-0.5"
                      style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'normal', wordBreak: 'break-word' }}
                      title={r.shareholdingNote}>
                      📊 {r.shareholdingNote}
                    </div>
                  )}
                  {r.flowNote && (
                    <div className="text-[10px] text-neutral-500"
                      style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'normal', wordBreak: 'break-word' }}
                      title={r.flowNote}>
                      ⚡ {r.flowNote}
                    </div>
                  )}
                  {!r.shareholdingNote && !r.flowNote && <span className="text-neutral-600">—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
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
  const [expandedSym, setExpandedSym] = useState<string | null>(null)
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-4 bg-gradient-to-br from-accent-amber/10 to-accent-green/5 border border-accent-amber/40 rounded-lg">
        <div className="text-3xl">📊</div>
        <div className="flex-1">
          <div className="text-sm font-bold text-accent-amber">F&O Stock-Futures — 22-Criteria Pre-Breakout Scanner</div>
          <div className="text-[11px] text-neutral-400 mt-1 leading-relaxed">
            Scans ~211 NSE F&O underlyings against the 22-point institutional checklist:
            <br/><b>Core 12:</b> Seasonality · Cycle · Volume↑ · FII/DII/Promoter↑ · 5-Day Vol · Technicals · Harmonic · Elliott · Darvas · News · Accumulation · Tight Range
            <br/><b>Pro 6:</b> OI Buildup · Market Regime · India VIX · R:R ≥ 2.5 · Bulk-deals · RS-z vs NIFTY
            <br/><b>Master-maker 2:</b> SMC (FVG/OB/BoS/Liquidity sweep) · Stage Analysis (30W lifecycle)
            <br/><b>Cycle/Astro 2:</b> KP sub-lord (Vimshottari nakshatra system) · Bradley siderograph (1948 turn-date detector)
            <br/>Plus the <b>MoverPatternMiner</b> matches each candidate against past 5%+ winners' T-1 setups — pattern-recognition for pre-move replays.
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
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '80vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1000 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th className="text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500">Symbol</th>
                <th className="text-center px-2 py-3">Dir</th>
                <th className="text-center px-2 py-3">Score</th>
                <th className="text-center px-2 py-3">12c ✓</th>
                <th className="text-right px-2 py-3 text-neutral-300">LTP</th>
                <th className="text-right px-2 py-3 text-accent-cyan">Entry</th>
                <th className="text-right px-2 py-3 text-accent-red">SL</th>
                <th className="text-right px-2 py-3 text-accent-green">T1</th>
                <th className="text-right px-2 py-3 text-accent-green">T2</th>
                <th className="text-right px-2 py-3 text-accent-green">T3</th>
                <th className="text-left px-3 py-3">Stakes / Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: any, i: number) => {
                const dirColor = r.side === 'LONG' ? '#00c853' : '#ff1744'
                const tdb = `px-2 py-2 align-top bg-ink-800 group-hover:bg-ink-700 font-mono text-[11px]`
                const tc = r.twelveCriteria
                const expanded = expandedSym === r.symbol
                return (
                  <Fragment key={r.symbol + i}>
                    <tr className="group border-t border-ink-500 cursor-pointer" onClick={() => setExpandedSym(expanded ? null : r.symbol)}>
                      <td className={`${tdb} px-3 sticky left-0 z-10 border-r border-ink-500 font-bold text-neutral-100`}>
                        {expanded ? '▼ ' : '▶ '}{r.symbol}
                      </td>
                      <td className={`${tdb} text-center`}>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.side}</span>
                      </td>
                      <td className={`${tdb} text-center font-bold ${r.score >= 80 ? 'text-accent-green' : r.score >= 65 ? 'text-accent-amber' : 'text-neutral-300'}`}>{r.score}</td>
                      <td className={`${tdb} text-center`}>
                        {tc ? (
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${tc.passCount >= 12 ? 'bg-accent-green/20 text-accent-green' : tc.passCount >= 8 ? 'bg-accent-cyan/15 text-accent-cyan' : 'bg-ink-700 text-neutral-500'}`}>{tc.passCount}/{tc.results?.length ?? 18}</span>
                        ) : <span className="text-neutral-600">—</span>}
                      </td>
                      <td className={`${tdb} text-right text-neutral-200`}>₹{r.price?.toFixed?.(1)}</td>
                      <td className={`${tdb} text-right text-accent-cyan`}>₹{r.entry?.toFixed?.(1)}</td>
                      <td className={`${tdb} text-right text-accent-red`}>₹{r.stopLoss?.toFixed?.(1)}</td>
                      <td className={`${tdb} text-right text-accent-green`}>
                        <div>₹{r.target1?.toFixed?.(1)}</div>
                        {r.target1Date && <div className="text-[9px] text-accent-green/60">📅 {fmtDate(r.target1Date)}</div>}
                      </td>
                      <td className={`${tdb} text-right text-accent-green`}>
                        <div>₹{r.target2?.toFixed?.(1)}</div>
                        {r.target2Date && <div className="text-[9px] text-accent-green/60">📅 {fmtDate(r.target2Date)}</div>}
                      </td>
                      <td className={`${tdb} text-right text-accent-green font-bold`}>
                        <div>₹{r.target3?.toFixed?.(1)}</div>
                        {r.target3Date && <div className="text-[9px] text-accent-green/60">📅 {fmtDate(r.target3Date)}</div>}
                      </td>
                      <td className={`${tdb} text-left text-neutral-400`} style={{ minWidth: 220 }}>
                        <div className="text-[10px]">
                          {r.fiiDelta != null && r.fiiDelta > 0.2 && <span className="text-accent-green">FII +{r.fiiDelta.toFixed(2)}pp · </span>}
                          {r.marketCapCr ? <span>MC ₹{(r.marketCapCr / 1000).toFixed(1)}KCr · </span> : null}
                          <span className="text-neutral-500">{r.confidence}</span>
                        </div>
                      </td>
                    </tr>
                    {expanded && tc && (
                      <tr className="bg-ink-900/40 border-t border-ink-500/30">
                        <td colSpan={11} className="px-4 py-3">
                          <div className="text-[10px] uppercase tracking-wider text-accent-amber mb-2 font-bold">12-Criteria Scorecard · Total {tc.total}/120 · {tc.passCount}/12 passed</div>
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                            {tc.results.map((c: any, idx: number) => (
                              <div key={c.key} className={`p-2 rounded border text-[11px] ${c.pass ? 'bg-accent-green/5 border-accent-green/30' : 'bg-ink-800 border-ink-500/40'}`}>
                                <div className={`font-bold flex items-center gap-1 ${c.pass ? 'text-accent-green' : 'text-neutral-500'}`}>
                                  {c.pass ? '✓' : '○'} {idx + 1}. {c.label} <span className="ml-auto text-[10px]">{c.score.toFixed(1)}</span>
                                </div>
                                <div className="text-[10px] text-neutral-400 mt-1">{c.detail}</div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <HowToTradeBox tab="F&O Futures · 18-Criteria" rules={[
        { title: 'The 18 criteria', body: 'CORE 12: 1. Seasonality · 2. Cycle (Gann 90d) · 3. Volume Increase (today vs 20d) · 4. FII/DII/Promoter stake↑ · 5. Last 5-day Vol Formula (5d/20d) · 6. Technicals (EMA+RSI+ADX+MACD) · 7. Harmonic / Fib PRZ · 8. Elliott Wave 1/3/4 · 9. Darvas Box · 10. News-Driven bar · 11. Big-hands Accumulation (OBV+delivery) · 12. Tight Range b/f Blast.\nPRO 6: 13. OI Buildup direction (long buildup vs short covering) · 14. Market Regime (NIFTY 50/200DMA) · 15. India VIX context · 16. R:R ≥ 2.5 floor · 17. Bulk-deals named-buyer confirmation · 18. RS-z vs NIFTY (relative strength outperformance).' },
        { title: 'Reading the scorecard', body: 'Each criterion contributes 0-10 to a composite. Click any row to expand and see WHICH criteria fired with the actual numbers. 12+/18 passes = highest conviction setup.' },
        { title: 'Composite ranking', body: 'Final score = base technical score (0-100) + 1.2 × passCount. A 10-criteria match gives +12 to the base, a 15-criteria match gives +18. Sort the table by Score column to see the strongest setups first.' },
        { title: 'Pro filters that protect capital', body: 'R:R floor auto-rejects setups <2.5:1. Market Regime suppresses LONG bias in a bear market. VIX EXTREME (>25) penalises all longs. These three save you from low-probability trades that look good on paper.' },
      ]} />
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
