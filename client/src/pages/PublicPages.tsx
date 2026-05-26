/**
 * Vercel public-mode pages — TABLE format matching localhost. Reads static
 * JSON snapshots from raw.githubusercontent.com (no backend dependency).
 *
 * Above each table: a "Recent target hits" strip with green/red highlighted
 * cards so users can see realised outcomes and gauge accuracy.
 */
import { useQuery } from '@tanstack/react-query'
import { snapshots } from '../api'
import { useState } from 'react'

const fmtDate = (iso?: string) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : `${d.getDate()}/${d.getMonth() + 1}`
}
const fmtTs = (iso?: string) => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'
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
  // 2026-05-25: catch-rate row shows the user's #1 KPI — % of NSE top-100
  // gainers our pre-move screeners caught on T-1 (day before the move).
  // Auto-replayed every weekday 17:30 IST against the actual day's gainers
  // and persisted to data/learning/daily-catch-*.json. Goal: 85%.
  const cr = (data as any).catchRate
  const crLatest = cr?.latest
  const crRolling = cr?.rolling
  return (
    <details className="bg-ink-700 border border-ink-500 rounded-lg p-3 mb-3" open>
      <summary className="text-[11px] font-semibold text-neutral-300 cursor-pointer select-none">
        📊 System accuracy ({data.daysBack}d) — {data.total} signals · Triggered {data.triggeredRate}% · Win rate <span className="text-accent-green">{data.winRate}%</span> · SL rate <span className="text-accent-red">{data.slRate}%</span> · Avg R-multiple <b>{data.avgRMultiple > 0 ? '+' : ''}{data.avgRMultiple}</b>
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
  const [filter, setFilter] = useState<string>('ALL')
  const [src, setSrc] = useState<string>('ALL')
  const [sort, setSort] = useState<'newest' | 'return-desc' | 'return-asc' | 'conviction-desc'>('newest')
  const all: any[] = data?.signals ?? []
  // 2026-05-20: granular filters per user request — separate T1/T2/T3/SL
  // outcome buckets so users can see exact accuracy per target tier.
  const rows = all.filter(r => {
    if (src !== 'ALL' && r.source !== src) return false
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
  const wins = counts.t1 + counts.t2 + counts.t3
  const overallHit = counts.completed > 0 ? +(wins / counts.completed * 100).toFixed(1) : 0
  const sources = Array.from(new Set(all.map(r => r.source))).sort()
  return (
    <div className="space-y-4">
      <Banner emoji="📈" title="Track Record"
        subtitle={`${all.length} signals tracked · ${counts.completed} completed · hit rate ${overallHit}% · fully transparent`}
        ts={data?.generatedAt} />
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
        <div className="overflow-x-auto rounded-lg border border-ink-500">
          <table className="w-full text-[12px] bg-ink-800" style={{ minWidth: 1600 }}>
            <thead className="bg-ink-700 text-neutral-400">
              <tr>
                <th className="text-center px-3 py-3 whitespace-nowrap">Generated</th>
                <th className="text-left px-3 py-3 whitespace-nowrap">Symbol</th>
                <th className="text-center px-3 py-3 whitespace-nowrap">Source</th>
                <th className="text-center px-3 py-3 whitespace-nowrap">Direction</th>
                <th className="text-center px-3 py-3 whitespace-nowrap">Conviction</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-cyan">Entry</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-red">SL</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">T1</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">T2</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">T3</th>
                <th className="text-center px-3 py-3 whitespace-nowrap">Status</th>
                <th className="text-right px-2 py-3 whitespace-nowrap">% Return</th>
                <th className="text-left px-3 py-3">Reason for trade</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 200).map((r, i) => {
                const isWin = ['T1_HIT', 'T2_HIT', 'T3_HIT'].includes(r.status)
                const isLoss = r.status === 'SL_HIT'
                const bg = isWin ? 'bg-accent-green/10' : isLoss ? 'bg-accent-red/10' : ''
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
                const statusBadge = isWin ? '✅' : isLoss ? '❌' : r.status === 'ACTIVE' ? '🎯' : r.status === 'PENDING' ? '⏳' : '⏰'
                return (
                  <tr key={i} className={`border-t border-ink-500 hover:bg-ink-700 font-mono ${bg}`}>
                    <td className="px-3 py-3 text-center text-[10px] text-neutral-500 whitespace-nowrap">{fmtDate(r.generatedAt)}</td>
                    <td className="px-3 py-3 whitespace-nowrap"><b>{r.symbol}</b></td>
                    <td className="px-3 py-3 text-center text-[10px] text-neutral-400">{r.source}</td>
                    <td className="px-3 py-3 text-center">
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                    </td>
                    <td className="px-3 py-3 text-center font-bold">
                      <span className={r.conviction >= 80 ? 'text-accent-green' : r.conviction >= 60 ? 'text-accent-cyan' : r.conviction >= 40 ? 'text-accent-amber' : 'text-neutral-500'}>
                        {r.conviction ?? '—'}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-right text-accent-cyan whitespace-nowrap">₹{fmtPx(r.entry)}</td>
                    <td className="px-2 py-3 text-right text-accent-red whitespace-nowrap">₹{fmtPx(r.stopLoss)}</td>
                    <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.target1)}</td>
                    <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.target2)}</td>
                    <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.target3)}</td>
                    <td className="px-3 py-3 text-center whitespace-nowrap">
                      <span className="text-[11px]">{statusBadge} {r.status}</span>
                    </td>
                    <td className="px-2 py-3 text-right whitespace-nowrap" style={{ color: r.realisedPct == null ? '#666' : (r.realisedPct >= 0 ? '#00c853' : '#ff1744') }}>
                      {r.realisedPct == null ? '—' : `${r.realisedPct >= 0 ? '+' : ''}${r.realisedPct}%`}
                    </td>
                    <td className="px-3 py-3 text-left text-neutral-300 text-[11px] leading-relaxed break-words" style={{ minWidth: 240, maxWidth: 360, whiteSpace: 'normal' }}>{r.reason || '—'}</td>
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
  const rows: any[] = data?.rows ?? []
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
        <div className="overflow-x-auto rounded-lg border border-ink-500">
          <table className="w-full text-[12px] bg-ink-800" style={{ minWidth: 1700 }}>
            <thead className="bg-ink-700 text-neutral-400">
              <tr>
                <th className="text-left px-4 py-3 whitespace-nowrap">Stock</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Source</th>
                <th className="text-right px-4 py-3 whitespace-nowrap">LTP</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Direction</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Conviction</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-cyan">Entry</th>
                <th className="text-center px-2 py-3 whitespace-nowrap text-accent-cyan">Entry by</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-red">Stop Loss</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 1</th>
                <th className="text-center px-2 py-3 whitespace-nowrap text-accent-green">T1 by</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 2</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 3</th>
                <th className="text-left px-4 py-3 text-neutral-400">Stake (FII/DII/Promoter/Pledge/MC)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
                const convCls = r.conviction >= 90 ? 'text-accent-green' : r.conviction >= 85 ? 'text-accent-cyan' : 'text-accent-amber'
                const sourceColor = r.source === 'WEEKLY' ? '#5dade2' : r.source === 'DAILY' ? '#f5c518' : '#aaa'
                const isWave2 = r.lifecycleStatus !== 'SUPERSEDED' && (r.bucket === 'WAVE_2' || (r.reasoning || '').includes('WAVE-2'))
                return (
                  <tr key={i} className={`border-t border-ink-500 hover:bg-ink-700 font-mono ${r.noBrainer ? 'bg-accent-amber/5' : ''}`}>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <b className="text-neutral-200">{r.noBrainer && '⭐ '}{r.symbol}</b>
                      {isWave2 && <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-accent-violet/20 text-accent-violet border border-accent-violet/40" title="Wave-2: stock ran 10–30%, retraced 38–61%, now consolidating tight. Catching leg-2.">🔄 WAVE-2</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold" style={{ background: `${sourceColor}22`, color: sourceColor, border: `1px solid ${sourceColor}66` }}>{r.source}</span>
                    </td>
                    <td className="px-2 py-3 text-right whitespace-nowrap">₹{fmtPx(r.ltp)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                    </td>
                    <td className={`px-4 py-3 text-center font-bold ${convCls}`}>{r.conviction}</td>
                    <td className="px-2 py-3 text-right text-accent-cyan whitespace-nowrap">₹{fmtPx(r.entryPriceLow)}–{fmtPx(r.entryPriceHigh)}</td>
                    <td className="px-2 py-3 text-center text-accent-cyan text-[11px] whitespace-nowrap">{fmtDate(r.entryDate)}</td>
                    <td className="px-2 py-3 text-right text-accent-red whitespace-nowrap">₹{fmtPx(r.stopLoss)}</td>
                    <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.target1)}</td>
                    <td className="px-2 py-3 text-center text-accent-green text-[11px] whitespace-nowrap">{fmtDate(r.target1Date)}</td>
                    <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.target2)}</td>
                    <td className="px-2 py-3 text-right text-accent-green font-bold whitespace-nowrap">₹{fmtPx(r.target3)}</td>
                    <td className="px-4 py-3 text-left text-neutral-300 text-[11px] leading-relaxed break-words" style={{ minWidth: 220, maxWidth: 340, whiteSpace: 'normal' }}>{r.shareholdingNote || '—'}</td>
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
  const rows: any[] = data?.rows ?? []

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
            <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1500 }}>
              <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
                <tr>
                  <th className="text-left px-4 py-3 whitespace-nowrap bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]">Stock</th>
                  <th className="text-right px-4 py-3 whitespace-nowrap">LTP</th>
                  <th className="text-center px-4 py-3 whitespace-nowrap">Direction</th>
                  <th className="text-center px-4 py-3 whitespace-nowrap">Conviction</th>
                  <th className="text-right px-2 py-3 whitespace-nowrap text-accent-cyan">Entry Range</th>
                  <th className="text-center px-2 py-3 whitespace-nowrap text-accent-cyan">Entry by</th>
                  <th className="text-right px-2 py-3 whitespace-nowrap text-accent-red">Stop Loss</th>
                  <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 1</th>
                  <th className="text-center px-2 py-3 whitespace-nowrap text-accent-green">T1 by</th>
                  <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 2</th>
                  <th className="text-center px-2 py-3 whitespace-nowrap text-accent-green">T2 by</th>
                  <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 3</th>
                  <th className="text-center px-2 py-3 whitespace-nowrap text-accent-green">T3 by</th>
                  <th className="text-left px-4 py-3 text-neutral-400">Stake (FII/DII/Promoter/Pledge/MC)</th>
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
  return (
    <tr className="group">
      <td className={`${td} px-4 text-left sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`} style={tdStyle}>
        <b className="text-neutral-200">{r.noBrainerBet && '⭐ '}{r.symbol}</b>
        {r.bucket === 'WAVE_2' && status === 'ACTIVE' && (
          <span className="ml-2 px-1.5 py-0.5 rounded text-[9px] font-bold bg-accent-violet/20 text-accent-violet border border-accent-violet/40"
            title="Wave-2: stock ran 10–30%, retraced 38–61%, now consolidating tight. Catching leg-2.">🔄 WAVE-2</span>
        )}
        <StatusChip r={r} status={status} />
      </td>
      <td className={`${td} px-2 text-right`} style={tdStyle}>₹{fmtPx(r.ltp)}</td>
      <td className={`${td} px-4 text-center`}>
        <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{ background: `${dirColor}22`, color: dirColor, textDecoration: strike }}>{r.direction}</span>
      </td>
      <td className={`${td} px-4 text-center font-bold ${convCls}`} style={tdStyle}>{r.conviction}</td>
      <td className={`${td} text-right text-accent-cyan`} style={tdStyle}>₹{fmtPx(r.entryPriceLow)}–{fmtPx(r.entryPriceHigh)}</td>
      <td className={`${td} text-center text-accent-cyan text-[11px]`} style={tdStyle}>{fmtDate(r.entryDate)}</td>
      <td className={`${td} text-right text-accent-red`} style={tdStyle}>₹{fmtPx(r.stopLoss)}</td>
      <td className={`${td} text-right text-accent-green`} style={tdStyle}>₹{fmtPx(r.target1)}</td>
      <td className={`${td} text-center text-accent-green text-[11px]`} style={tdStyle}>{fmtDate(r.target1Date)}</td>
      <td className={`${td} text-right text-accent-green`} style={tdStyle}>₹{fmtPx(r.target2)}</td>
      <td className={`${td} text-center text-accent-green text-[11px]`} style={tdStyle}>{fmtDate(r.target2Date)}</td>
      <td className={`${td} text-right text-accent-green font-bold`} style={tdStyle}>₹{fmtPx(r.target3)}</td>
      <td className={`${td} px-4 text-center text-accent-green text-[11px] font-semibold`} style={tdStyle}>{fmtDate(r.target3Date)}</td>
      <td className={`${td} px-4 text-left text-neutral-300 text-[11px] leading-relaxed break-words`} style={{ ...tdStyle, minWidth: 220, maxWidth: 340, whiteSpace: 'normal' }}>{r.shareholdingNote || 'shareholding data unavailable'}</td>
    </tr>
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
  const rows: any[] = data?.rows ?? []
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
        <div className="overflow-x-auto rounded-lg border border-ink-500">
          <table className="w-full text-[12px] bg-ink-800" style={{ minWidth: 1700 }}>
            <thead className="bg-ink-700 text-neutral-400">
              <tr>
                <th className="text-left px-4 py-3 whitespace-nowrap">Stock</th>
                <th className="text-right px-4 py-3 whitespace-nowrap">LTP</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Direction</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Conviction</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Pattern</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-cyan">Entry Price</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-red">Stop Loss</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 1</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 2</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 3</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Risk:Reward</th>
                <th className="text-left px-4 py-3 text-neutral-400">Stake (FII/DII/Promoter/Pledge/MC)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
                const convCls = r.conviction >= 80 ? 'text-accent-green' : r.conviction >= 60 ? 'text-accent-cyan' : 'text-accent-amber'
                return (
                  <tr key={i} className="border-t border-ink-500 hover:bg-ink-700 font-mono">
                    <td className="px-4 py-3 whitespace-nowrap"><b>{r.symbol}</b></td>
                    <td className="px-2 py-3 text-right whitespace-nowrap">₹{fmtPx(r.ltp)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                    </td>
                    <td className={`px-4 py-3 text-center font-bold ${convCls}`}>{r.conviction}</td>
                    <td className="px-4 py-3 text-center text-[11px] text-neutral-300 whitespace-nowrap">{r.pattern}</td>
                    <td className="px-2 py-3 text-right text-accent-cyan whitespace-nowrap">₹{fmtPx(r.entryPrice)}</td>
                    <td className="px-2 py-3 text-right text-accent-red whitespace-nowrap">₹{fmtPx(r.stopLoss)}</td>
                    <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.target1)}</td>
                    <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.target2)}</td>
                    <td className="px-2 py-3 text-right text-accent-green font-bold whitespace-nowrap">₹{fmtPx(r.target3)}</td>
                    <td className="px-4 py-3 text-center whitespace-nowrap">{r.riskReward ?? '—'}:1</td>
                    <td className="px-4 py-3 text-left text-neutral-300 text-[11px] leading-relaxed break-words" style={{ minWidth: 220, maxWidth: 340, whiteSpace: 'normal' }}>{r.shareholdingNote || 'shareholding data unavailable'}</td>
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
        <div className="overflow-x-auto rounded-lg border border-ink-500">
          <table className="w-full text-[12px] bg-ink-800" style={{ minWidth: 1500 }}>
            <thead className="bg-ink-700 text-neutral-400">
              <tr>
                <th className="text-left px-4 py-3 whitespace-nowrap">Stock</th>
                <th className="text-right px-4 py-3 whitespace-nowrap">Price</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Direction</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Tier</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Score</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-cyan">Entry Price</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-red">Stop Loss</th>
                <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target</th>
                <th className="text-center px-4 py-3 whitespace-nowrap">Expected %</th>
                <th className="text-left px-4 py-3 text-neutral-400">Setup Tags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dirColor = r.direction === 'BULL' ? '#00c853' : r.direction === 'BEAR' ? '#ff1744' : '#9aa0a6'
                return (
                  <tr key={i} className="border-t border-ink-500 hover:bg-ink-700 font-mono">
                    <td className="px-4 py-3 whitespace-nowrap"><b>{r.symbol}</b></td>
                    <td className="px-2 py-3 text-right whitespace-nowrap">₹{fmtPx(r.price)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                    </td>
                    <td className="px-4 py-3 text-center text-[11px]">{r.tier}</td>
                    <td className="px-4 py-3 text-center font-bold">{r.score?.toFixed?.(1)}</td>
                    <td className="px-2 py-3 text-right text-accent-cyan whitespace-nowrap">₹{fmtPx(r.suggestedEntry)}</td>
                    <td className="px-2 py-3 text-right text-accent-red whitespace-nowrap">₹{fmtPx(r.suggestedSL)}</td>
                    <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.suggestedTarget)}</td>
                    <td className="px-4 py-3 text-center text-accent-green text-[11px] whitespace-nowrap">{r.expectedMovePct?.toFixed?.(1)}%</td>
                    <td className="px-4 py-3 text-left text-neutral-300 text-[11px] leading-relaxed break-words" style={{ minWidth: 200, maxWidth: 320, whiteSpace: 'normal' }}>{(r.tags ?? []).slice(0, 3).join(' · ')}</td>
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
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-500">
      <table className="w-full text-[12px] bg-ink-800" style={{ minWidth: 1500 }}>
        <thead className="bg-ink-700 text-neutral-400">
          <tr>
            <th className="text-center px-4 py-3 whitespace-nowrap">Time (IST)</th>
            <th className="text-left px-4 py-3 whitespace-nowrap">Instrument</th>
            <th className="text-center px-4 py-3 whitespace-nowrap">Direction</th>
            <th className="text-center px-4 py-3 whitespace-nowrap">Grade</th>
            <th className="text-center px-4 py-3 whitespace-nowrap">Score</th>
            <th className="text-right px-2 py-3 whitespace-nowrap text-accent-cyan">Entry Price</th>
            <th className="text-right px-2 py-3 whitespace-nowrap text-accent-red">Stop Loss</th>
            <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 1</th>
            <th className="text-right px-2 py-3 whitespace-nowrap text-accent-green">Target 2</th>
            <th className="text-center px-4 py-3 whitespace-nowrap">Risk:Reward</th>
            <th className="text-left px-4 py-3 text-neutral-400">Reasoning</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
            const ts = new Date(r.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
            return (
              <tr key={i} className="border-t border-ink-500 hover:bg-ink-700 font-mono">
                <td className="px-4 py-3 text-center text-[11px] text-neutral-400 whitespace-nowrap">{ts}</td>
                <td className="px-4 py-3 whitespace-nowrap"><b>{r.instrument}</b></td>
                <td className="px-4 py-3 text-center">
                  <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                </td>
                <td className="px-4 py-3 text-center text-accent-amber font-bold">{r.grade}</td>
                <td className="px-4 py-3 text-center font-bold">{r.score?.toFixed?.(1)}</td>
                <td className="px-2 py-3 text-right text-accent-cyan whitespace-nowrap">₹{fmtPx(r.entry)}</td>
                <td className="px-2 py-3 text-right text-accent-red whitespace-nowrap">₹{fmtPx(r.stopLoss)}</td>
                <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.target1)}</td>
                <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap">₹{fmtPx(r.target2)}</td>
                <td className="px-4 py-3 text-center whitespace-nowrap">{r.riskReward ?? '—'}</td>
                <td className="px-4 py-3 text-left text-neutral-300 text-[11px] leading-relaxed break-words" style={{ minWidth: 220, maxWidth: 340, whiteSpace: 'normal' }}>{(r.reasons ?? []).slice(0, 2).join(' · ')}</td>
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
  const cs: any[] = data?.candidates ?? []
  return (
    <div className="space-y-4">
      <Banner emoji="🎯" title="5–20% Move — Pre-Move Identifier" subtitle={data ? `${data.tier1Count} Tier-1 · ${data.tier2Count} Tier-2 · ${data.tier3Count} Tier-3 · ${data.qualityPassed} passed quality filter from ${data.universeSize}` : '8-signal composite scorer · quality-filtered · pump-and-dump rejected'} ts={data?.generatedAt} />
      <AccuracyStrip />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && cs.length === 0 && <Empty msg="No candidates yet. Engine runs 16:00 IST weekdays." />}
      {!isLoading && !error && cs.length > 0 && (
        <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight: '75vh' }}>
          <table className="w-full text-[12px] border-separate" style={{ borderSpacing: 0, minWidth: 1500 }}>
            <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
              <tr>
                <th className="text-left px-3 py-3 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]">Stock</th>
                <th className="text-right px-2 py-3">LTP</th>
                <th className="text-center px-2 py-3">Score</th>
                <th className="text-center px-2 py-3">Tier</th>
                <th className="text-right px-2 py-3 text-accent-cyan">Entry</th>
                <th className="text-right px-2 py-3 text-accent-red">SL</th>
                <th className="text-right px-2 py-3 text-accent-green">T1</th>
                <th className="text-right px-2 py-3 text-accent-green">T2</th>
                <th className="text-right px-2 py-3 text-accent-green">T3</th>
                <th className="text-center px-2 py-3">R:R</th>
                <th className="text-center px-2 py-3">Exp%</th>
                <th className="text-left px-3 py-3">Signal mix</th>
                <th className="text-left px-3 py-3 text-neutral-400">Stake</th>
              </tr>
            </thead>
            <tbody>
              {cs.map((c, i) => {
                const tcls = c.tier === 1 ? 'text-accent-green' : c.tier === 2 ? 'text-accent-cyan' : 'text-accent-amber'
                const rowBg = c.tier === 1 ? 'bg-accent-green/5' : 'bg-ink-800'
                const td = `px-2 py-3 border-t border-ink-500 ${rowBg} group-hover:bg-ink-700 font-mono`
                return (
                  <tr key={i} className="group">
                    <td className={`${td} px-3 sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`}>
                      <b className="text-neutral-200">{c.symbol}</b>
                    </td>
                    <td className={`${td} text-right`}>₹{fmtPx(c.ltp)}</td>
                    <td className={`${td} text-center font-bold ${tcls}`}>{c.totalScore}/24</td>
                    <td className={`${td} text-center text-[10px] font-bold ${tcls}`}>{c.tierLabel}</td>
                    <td className={`${td} text-right text-accent-cyan`}>₹{fmtPx(c.entry)}</td>
                    <td className={`${td} text-right text-accent-red`}>₹{fmtPx(c.stopLoss)}</td>
                    <td className={`${td} text-right text-accent-green`}>₹{fmtPx(c.target1)}</td>
                    <td className={`${td} text-right text-accent-green`}>₹{fmtPx(c.target2)}</td>
                    <td className={`${td} text-right text-accent-green font-bold`}>₹{fmtPx(c.target3)}</td>
                    <td className={`${td} text-center`}>1:{c.riskReward}</td>
                    <td className={`${td} text-center text-accent-green`}>+{c.expectedMovePct}%</td>
                    <td className={`${td} px-3 text-left text-[11px] text-neutral-300 leading-relaxed break-words`} style={{ maxWidth: 280, whiteSpace: 'normal' }}>{c.primarySignal}</td>
                    <td className={`${td} px-3 text-left text-[11px] text-neutral-300 leading-relaxed break-words`} style={{ minWidth: 220, maxWidth: 340, whiteSpace: 'normal' }}>{c.shareholdingNote || '—'}</td>
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
