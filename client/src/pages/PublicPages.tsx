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
                <th className="text-left px-4 py-3 whitespace-nowrap text-neutral-400">Stake (FII/DII/Promoter/Pledge/MC)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
                const convCls = r.conviction >= 90 ? 'text-accent-green' : r.conviction >= 85 ? 'text-accent-cyan' : 'text-accent-amber'
                const sourceColor = r.source === 'WEEKLY' ? '#5dade2' : r.source === 'DAILY' ? '#f5c518' : '#aaa'
                return (
                  <tr key={i} className={`border-t border-ink-500 hover:bg-ink-700 font-mono ${r.noBrainer ? 'bg-accent-amber/5' : ''}`}>
                    <td className="px-4 py-3 whitespace-nowrap"><b className="text-neutral-200">{r.noBrainer && '⭐ '}{r.symbol}</b></td>
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
                    <td className="px-4 py-3 text-left text-neutral-300 text-[11px] whitespace-nowrap">{r.shareholdingNote || '—'}</td>
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
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && (
        <div className="overflow-x-auto rounded-lg border border-ink-500">
          <table className="w-full text-[12px] bg-ink-800" style={{ minWidth: 1700 }}>
            <thead className="bg-ink-700 text-neutral-400">
              <tr>
                <th className="text-left px-4 py-3 whitespace-nowrap">Stock</th>
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
                <th className="text-left px-4 py-3 whitespace-nowrap text-neutral-400">Stake (FII/DII/Promoter/Pledge/MC)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => <WeeklyRow key={i} r={r} />)}
            </tbody>
          </table>
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
  const rowCls = `border-t border-ink-500 hover:bg-ink-700 font-mono ${
    r.noBrainerBet && status === 'ACTIVE' ? 'bg-accent-amber/5' :
    isHit ? 'bg-accent-green/10' :
    isLoss ? 'bg-ink-900 opacity-60' : ''
  }`
  const strike = isLoss ? 'line-through' : 'none'
  const tdStyle = { textDecoration: strike } as React.CSSProperties
  return (
    <tr className={rowCls}>
      <td className="px-4 py-3 whitespace-nowrap" style={tdStyle}>
        <b className="text-neutral-200">{r.noBrainerBet && '⭐ '}{r.symbol}</b>
        <StatusChip r={r} status={status} />
      </td>
      <td className="px-2 py-3 text-right whitespace-nowrap" style={tdStyle}>₹{fmtPx(r.ltp)}</td>
      <td className="px-4 py-3 text-center">
        <span className="px-2 py-0.5 rounded text-[11px] font-bold" style={{ background: `${dirColor}22`, color: dirColor, textDecoration: strike }}>{r.direction}</span>
      </td>
      <td className={`px-4 py-3 text-center font-bold ${convCls}`} style={tdStyle}>{r.conviction}</td>
      <td className="px-2 py-3 text-right text-accent-cyan whitespace-nowrap" style={tdStyle}>₹{fmtPx(r.entryPriceLow)}–{fmtPx(r.entryPriceHigh)}</td>
      <td className="px-2 py-3 text-center text-accent-cyan text-[11px] whitespace-nowrap" style={tdStyle}>{fmtDate(r.entryDate)}</td>
      <td className="px-2 py-3 text-right text-accent-red whitespace-nowrap" style={tdStyle}>₹{fmtPx(r.stopLoss)}</td>
      <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap" style={tdStyle}>₹{fmtPx(r.target1)}</td>
      <td className="px-2 py-3 text-center text-accent-green text-[11px] whitespace-nowrap" style={tdStyle}>{fmtDate(r.target1Date)}</td>
      <td className="px-2 py-3 text-right text-accent-green whitespace-nowrap" style={tdStyle}>₹{fmtPx(r.target2)}</td>
      <td className="px-2 py-3 text-center text-accent-green text-[11px] whitespace-nowrap" style={tdStyle}>{fmtDate(r.target2Date)}</td>
      <td className="px-2 py-3 text-right text-accent-green font-bold whitespace-nowrap" style={tdStyle}>₹{fmtPx(r.target3)}</td>
      <td className="px-4 py-3 text-center text-accent-green text-[11px] font-semibold whitespace-nowrap" style={tdStyle}>{fmtDate(r.target3Date)}</td>
      <td className="px-4 py-3 text-left text-neutral-300 text-[11px] whitespace-nowrap" style={tdStyle}>{r.shareholdingNote || 'shareholding data unavailable'}</td>
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
                <th className="text-left px-4 py-3 whitespace-nowrap text-neutral-400">Stake (FII/DII/Promoter/Pledge/MC)</th>
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
                    <td className="px-4 py-3 text-left text-neutral-300 text-[11px] whitespace-nowrap">{r.shareholdingNote || 'shareholding data unavailable'}</td>
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
                <th className="text-left px-4 py-3 whitespace-nowrap text-neutral-400">Setup Tags</th>
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
                    <td className="px-4 py-3 text-left text-neutral-300 text-[11px] whitespace-nowrap">{(r.tags ?? []).slice(0, 3).join(' · ')}</td>
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
            <th className="text-left px-4 py-3 whitespace-nowrap text-neutral-400">Reasoning</th>
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
                <td className="px-4 py-3 text-left text-neutral-300 text-[11px] whitespace-nowrap">{(r.reasons ?? []).slice(0, 2).join(' · ')}</td>
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
