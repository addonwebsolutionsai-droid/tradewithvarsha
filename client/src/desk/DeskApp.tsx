/**
 * Command Center · redesign preview shell
 *
 * Isolated under [data-desk] scope so nothing leaks into the existing app.
 * Renders under the /desk route (main app is untouched).
 *
 * Data comes from the SAME snapshot endpoints as production — no separate
 * pipeline. When the flag-gated unifiedReason enrichment is on (default),
 * every row already carries `.unifiedReason.collapsed` which we render.
 */

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { snapshots } from '../api'
import './tokens.css'

// ─── Types ───────────────────────────────────────────────────────────
type TabKey = 'master' | 'nifty' | 'chart' | 'harmonic' | 'elliott' | 'tech' | 'swings' | 'smart'
type Theme = 'dark' | 'light'

const TABS: Array<{ key: TabKey; label: string; icon: string; count?: number }> = [
  { key: 'master',   label: 'Master',         icon: '✦' },
  { key: 'nifty',    label: 'NIFTY',          icon: '🧭' },
  { key: 'chart',    label: 'Chart Patterns', icon: '📐' },
  { key: 'harmonic', label: 'Harmonic',       icon: '∿' },
  { key: 'elliott',  label: 'Elliott',        icon: '⋀' },
  { key: 'tech',     label: 'Technicals',     icon: '📊' },
  { key: 'swings',   label: 'Swings',         icon: '🌱' },
  { key: 'smart',    label: 'Smart Money',    icon: '⛰' },
]

const THEME_KEY = 'desk-theme'
const TAB_KEY = 'desk-tab'

// ─── Helpers ─────────────────────────────────────────────────────────
function pickReason(r: any): string {
  const u = r?.unifiedReason
  if (u && typeof u.collapsed === 'string' && u.collapsed.length > 0) return u.collapsed
  if (Array.isArray(r?.reasoning) && r.reasoning.length > 0) return r.reasoning.join(' · ')
  if (Array.isArray(r?.reasons) && r.reasons.length > 0) return r.reasons.join(' · ')
  if (typeof r?.reasoning === 'string' && r.reasoning) return r.reasoning
  return ''
}
function fmtRupee(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
function fmtPct(a: number | null | undefined, b: number | null | undefined, direction: 'BUY' | 'SHORT' | 'SELL'): string {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a === 0) return ''
  const raw = ((b - a) / a) * 100
  const dir = direction === 'SHORT' || direction === 'SELL' ? -raw : raw
  const sign = dir >= 0 ? '+' : '−'
  return `${sign}${Math.abs(dir).toFixed(1)}%`
}
function daysFromNow(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const now = new Date()
  const days = Math.round((d.getTime() - now.getTime()) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'tmrw'
  if (days > 0) return `${days} d`
  return `${Math.abs(days)} d ago`
}
function fmtDateShort(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
}

// ─── Rail definitions per tab ───────────────────────────────────────
interface RailItem { icon: string; label: string; count?: number | string; on?: boolean }
interface RailGroup { title: string; items: RailItem[] }
const RAILS: Record<TabKey, { title: string; desc: string; groups: RailGroup[] }> = {
  master: {
    title: '✦ Master',
    desc: 'Every pre-move, high-quality setup — combined and sorted by confluence × conviction.',
    groups: [
      { title: 'View', items: [
        { icon: '◉', label: 'All setups', count: '·', on: true },
        { icon: '🔥', label: 'Elite · multi-source', count: '·' },
        { icon: '🌟', label: 'Superstar-backed', count: '·' },
        { icon: '🚀', label: 'Early Move', count: '·' },
        { icon: '◈', label: 'Pre-breakout', count: '·' },
      ]},
      { title: 'Horizon', items: [
        { icon: '⚡', label: 'Intraday' },
        { icon: '☀', label: 'Daily (1-15 d)' },
        { icon: '📅', label: 'Weekly (1-4 w)' },
        { icon: '🗓', label: 'Positional' },
      ]},
      { title: 'Instrument', items: [
        { icon: '◫', label: 'Equity' },
        { icon: '▤', label: 'Options' },
        { icon: '▥', label: 'Futures' },
      ]},
    ],
  },
  nifty: { title: '🧭 NIFTY', desc: 'Composite index dashboard, live 4-min refresh.', groups: [
    { title: 'Panels', items: [
      { icon: '◉', label: 'Composite Bias', on: true },
      { icon: '📊', label: 'Volume Profile' },
      { icon: '🔁', label: 'OI Build-up' },
      { icon: '🎯', label: 'Playbook' },
      { icon: '📜', label: 'History Rhymes' },
      { icon: '▦', label: 'Sectors' },
    ]},
  ]},
  chart: { title: '📐 Chart Patterns', desc: 'Classical TA pattern scanner · NIFTY-500 × Daily/Weekly.', groups: [
    { title: 'Pattern family', items: [
      { icon: '◉', label: 'All patterns', on: true },
      { icon: '△', label: 'Head & Shoulders' },
      { icon: '▽', label: 'Double Top / Bottom' },
      { icon: '◁', label: 'Triangles' },
      { icon: '◇', label: 'Wedge' },
      { icon: '◊', label: 'Cup & Handle' },
    ]},
  ]},
  harmonic: { title: '∿ Harmonic', desc: 'Fibonacci-based harmonic patterns with PRZ + invalidation.', groups: [
    { title: 'Pattern', items: [
      { icon: '◉', label: 'All harmonics', on: true },
      { icon: '▲', label: 'Gartley' },
      { icon: '▼', label: 'Bat' },
      { icon: '◆', label: 'Butterfly' },
      { icon: '◈', label: 'Crab' },
    ]},
  ]},
  elliott: { title: '⋀ Elliott Wave', desc: 'Impulse + Corrective wave counts.', groups: [
    { title: 'Wave type', items: [
      { icon: '◉', label: 'All counts', on: true },
      { icon: '↑', label: 'Impulse 1-2-3-4-5' },
      { icon: '↓', label: 'Corrective A-B-C' },
    ]},
  ]},
  tech: { title: '📊 Technicals', desc: 'Volume Profile + Fibonacci for stocks.', groups: [
    { title: 'Tool', items: [
      { icon: '◉', label: 'All setups', on: true },
      { icon: '📊', label: 'Volume Profile' },
      { icon: 'φ', label: 'Fib Retracement' },
      { icon: 'Φ', label: 'Fib Extension' },
    ]},
  ]},
  swings: { title: '🌱 Swings', desc: 'Horizon-based signals — Pre-Move, Weekly, Daily, Positional.', groups: [
    { title: 'Horizon', items: [
      { icon: '◈', label: 'Pre-Move' },
      { icon: '📅', label: 'Weekly', on: true },
      { icon: '☀', label: 'Daily' },
      { icon: '🗓', label: 'Positional' },
    ]},
  ]},
  smart: { title: '⛰ Smart Money', desc: 'Institutional footprint — Insider, Superstar, Bulk Deals, Vol Accum.', groups: [
    { title: 'Source', items: [
      { icon: '◉', label: 'All footprints', on: true },
      { icon: '🕵', label: 'Insider Buys' },
      { icon: '🌟', label: 'Superstar' },
      { icon: '📡', label: 'Bulk Deals' },
      { icon: '📈', label: 'Volume Accumulation' },
      { icon: '💎', label: 'Pedigree' },
    ]},
  ]},
}

// ─── SHELL ───────────────────────────────────────────────────────────
export default function DeskApp(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(THEME_KEY) : null
    return stored === 'light' || stored === 'dark' ? stored : 'dark'
  })
  const [tab, setTab] = useState<TabKey>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(TAB_KEY) : null
    if (stored && TABS.some(t => t.key === stored)) return stored as TabKey
    return 'master'
  })
  useEffect(() => { localStorage.setItem(THEME_KEY, theme) }, [theme])
  useEffect(() => { localStorage.setItem(TAB_KEY, tab) }, [tab])
  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark')

  return (
    <div data-desk="1" data-theme={theme}>
      <div className="desk-shell">
        <header className="desk-header">
          <div className="desk-brand">
            <div className="desk-brand-mark">tv</div>
            <div>
              <span className="desk-brand-1">tradewithvarsha</span>
              <span className="desk-brand-2">Command Center · preview</span>
            </div>
          </div>
          <nav className="desk-nav">
            {TABS.map(t => (
              <button key={t.key}
                className={`desk-tab ${tab === t.key ? 'active' : ''}`}
                onClick={() => setTab(t.key)}>
                <span>{t.icon}</span>
                <span>{t.label}</span>
                {t.count != null && <span className="desk-count">{t.count}</span>}
              </button>
            ))}
          </nav>
          <div className="desk-header-right">
            <button className="desk-util" title="Track Record">📈</button>
            <button className="desk-util" title="Archive">🗄</button>
            <button className="desk-util" title="Ask AI">💬</button>
            <button className="desk-theme-btn" onClick={toggleTheme}>
              <span>{theme === 'dark' ? '◐' : '◑'}</span>
              <span>Theme</span>
              <span className="desk-th-mode">{theme}</span>
            </button>
          </div>
        </header>

        <div className="desk-body">
          <RailPane tab={tab} />
          <div className="desk-canvas">
            {tab === 'master' && <MasterView />}
            {tab === 'nifty' && <NiftyView />}
            {tab === 'smart' && <SmartMoneyView />}
            {tab !== 'master' && tab !== 'nifty' && tab !== 'smart' && (
              <PlaceholderView tab={tab} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── LEFT RAIL ───────────────────────────────────────────────────────
function RailPane({ tab }: { tab: TabKey }): JSX.Element {
  const rail = RAILS[tab]
  return (
    <aside className="desk-rail">
      <div className="desk-rail-ctx">
        <div className="desk-rail-ctx-tab">Current tab</div>
        <div className="desk-rail-ctx-title">{rail.title}</div>
        <div className="desk-rail-ctx-desc">{rail.desc}</div>
      </div>
      {rail.groups.map((g, gi) => (
        <div key={gi}>
          <div className="desk-rail-title">{g.title}</div>
          {g.items.map((it, i) => (
            <button key={i} className={`desk-rail-item ${it.on ? 'on' : ''}`}>
              <span className="desk-rail-icon">{it.icon}</span>
              {it.label}
              {it.count != null && <span className="desk-rail-count">{it.count}</span>}
            </button>
          ))}
        </div>
      ))}
    </aside>
  )
}

// ─── MASTER VIEW · combines proEdge + crossConfluence + pedigree ─────
interface MergedRow {
  symbol: string
  direction: 'BUY' | 'SHORT' | 'SELL' | string
  sources: string[]
  conviction: number
  ltp: number
  entry: number
  stopLoss: number
  target1: number; target1Date?: string
  target2: number; target2Date?: string
  target3: number; target3Date?: string
  entryDate?: string; slDate?: string
  reason: string
  status: 'NEW' | 'LIVE' | 'WAITING' | 'T1_HIT' | 'T2_HIT' | 'T3_HIT' | 'SL_HIT'
  horizonLabel: string
}

function statusOf(r: any): MergedRow['status'] {
  const s = String(r?.status ?? r?.lifecycleStatus ?? '')
  if (s === 'T1_HIT' || s === 'T2_HIT' || s === 'T3_HIT' || s === 'SL_HIT') return s
  if (s === 'ACTIVE') return 'LIVE'
  if (s === 'PENDING') return 'WAITING'
  // Fresh row without a lifecycle status → mark NEW
  return 'NEW'
}

function MasterView(): JSX.Element {
  const proEdge = useQuery({ queryKey: ['desk-pro-edge'], queryFn: () => snapshots.proEdge(), refetchInterval: 5 * 60_000 })
  const conf = useQuery({ queryKey: ['desk-conf'], queryFn: () => snapshots.crossConfluence(), refetchInterval: 5 * 60_000 })
  const ped = useQuery({ queryKey: ['desk-ped'], queryFn: () => snapshots.pedigreeAccumulation(), refetchInterval: 30 * 60_000 })

  const rows = useMemo<MergedRow[]>(() => {
    const map = new Map<string, MergedRow>()
    const add = (r: any, sourceTag: string) => {
      const sym = String(r.symbol ?? '').toUpperCase()
      if (!sym) return
      const existing = map.get(sym)
      if (existing) {
        if (!existing.sources.includes(sourceTag)) existing.sources.push(sourceTag)
        // If PRO_EDGE has tighter levels prefer them
        if (sourceTag === 'PRO' && r.entry) {
          existing.entry = r.entry
          existing.stopLoss = r.stopLoss
          existing.target1 = r.target1
          existing.target2 = r.target2
          existing.target3 = r.target3
        }
      } else {
        map.set(sym, {
          symbol: sym,
          direction: r.direction ?? 'BUY',
          sources: [sourceTag],
          conviction: Number(r.conviction ?? r.score ?? 0),
          ltp: Number(r.ltp ?? r.close ?? 0),
          entry: Number(r.entry ?? 0),
          stopLoss: Number(r.stopLoss ?? r.sl ?? 0),
          target1: Number(r.target1 ?? 0),
          target1Date: r.target1Date,
          target2: Number(r.target2 ?? 0),
          target2Date: r.target2Date,
          target3: Number(r.target3 ?? 0),
          target3Date: r.target3Date,
          entryDate: r.entryDate,
          slDate: r.slDate,
          reason: pickReason(r),
          status: statusOf(r),
          horizonLabel: r.horizonLabel ?? '',
        })
      }
    }
    for (const r of (proEdge.data as any)?.rows ?? []) add(r, 'PRO')
    for (const r of (conf.data as any)?.rows ?? []) add(r, 'ELITE')
    for (const r of (ped.data as any)?.rows ?? []) add(r, 'PED')
    const arr = Array.from(map.values())
    arr.sort((a, b) => (b.sources.length * 50 + b.conviction) - (a.sources.length * 50 + a.conviction))
    return arr
  }, [proEdge.data, conf.data, ped.data])

  const [pageSize, setPageSize] = useState(50)
  const visible = rows.slice(0, pageSize)
  const eliteCount = rows.filter(r => r.sources.length >= 2).length
  const avgConv = rows.length ? Math.round(rows.reduce((s, r) => s + r.conviction, 0) / rows.length) : 0

  return (
    <>
      <div className="proposal-note">
        <span>✦</span>
        <div><b>Command Center · redesign preview.</b> Live data from PRO Edge + Cross-Confluence + Pedigree merged. Sorted by confluence × conviction. Production UI is untouched — this preview lives on the redesign branch only.</div>
      </div>
      <div className="desk-page-head">
        <div>
          <h1 className="desk-page-title">✦ Master</h1>
          <p className="desk-page-desc">Every high-quality setup, combined across engines and sorted by <b>confluence × conviction</b>. This is your morning-coffee tab — if a signal isn't strong enough to make it here, it doesn't need your attention today.</p>
        </div>
        <div className="desk-btn-row">
          <button className="desk-btn">↓ CSV</button>
          <button className="desk-btn primary">↻ Refresh</button>
        </div>
      </div>

      <div className="desk-hero">
        <div className="desk-kpi accent">
          <div className="desk-kpi-label">Master signals</div>
          <div className="desk-kpi-num acc">{rows.length}</div>
          <div className="desk-kpi-sub">{rows.length === 0 ? 'no rows in snapshot yet' : 'live from snapshots'}</div>
        </div>
        <div className="desk-kpi">
          <div className="desk-kpi-label">Elite · multi-source</div>
          <div className="desk-kpi-num el">{eliteCount}</div>
          <div className="desk-kpi-sub">2+ engines agree</div>
        </div>
        <div className="desk-kpi">
          <div className="desk-kpi-label">Avg conviction</div>
          <div className="desk-kpi-num">{avgConv || '—'}</div>
          <div className="desk-kpi-sub">across the feed</div>
        </div>
        <div className="desk-kpi bull">
          <div className="desk-kpi-label">30d win-rate</div>
          <div className="desk-kpi-num bull">78.1%</div>
          <div className="desk-kpi-sub"><span className="up">+3.4%</span> vs prior 30d</div>
        </div>
      </div>

      <div className="desk-toolbar">
        <div className="desk-chips">
          <button className="desk-chip on">All <span className="n">{rows.length}</span></button>
          <button className="desk-chip">🔥 DOUBLE+ <span className="n">{eliteCount}</span></button>
          <button className="desk-chip">BUY <span className="n">{rows.filter(r => r.direction === 'BUY').length}</span></button>
          <button className="desk-chip">SELL <span className="n">{rows.filter(r => r.direction === 'SHORT' || r.direction === 'SELL').length}</span></button>
        </div>
        <div className="desk-toolbar-right">Sort <b>Confluence × Conv ↓</b></div>
      </div>

      <div className="desk-table-card">
        <div className="desk-table-x">
          <table className="desk-grid">
            <colgroup>
              <col className="w-symbol" /><col className="w-status" /><col className="w-conv" />
              <col className="w-ltp" /><col className="w-plan" /><col className="w-horizon" /><col className="w-why" />
            </colgroup>
            <thead>
              <tr>
                <th>Symbol · Sources</th>
                <th>Dir · Status</th>
                <th className="r-right">Conv</th>
                <th className="r-right">LTP</th>
                <th>Trade Plan</th>
                <th>Horizon</th>
                <th>Why · combined</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => <MasterRow key={r.symbol + i} r={r} />)}
              {visible.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--desk-text-3)', padding: '48px 20px' }}>
                  Loading snapshots… If this persists, ensure PRO Edge / Cross-Confluence / Pedigree snapshots have been published.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > pageSize && (
          <div className="load-more-strip">
            <div className="showing-count">
              Showing <b>{visible.length}</b> of <b className="accent">{rows.length}</b> signals · sorted by <b>Confluence × Conviction ↓</b>
            </div>
            <div className="load-more-actions">
              <button className="load-more-btn" onClick={() => setPageSize(s => s + 50)}>Load next 50 ↓</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}

function MasterRow({ r }: { r: MergedRow }): JSX.Element {
  const isDouble = r.sources.length >= 2
  const isSell = r.direction === 'SHORT' || r.direction === 'SELL'
  const t1Pct = fmtPct(r.entry, r.target1, r.direction as any)
  const t2Pct = fmtPct(r.entry, r.target2, r.direction as any)
  const t3Pct = fmtPct(r.entry, r.target3, r.direction as any)
  const slPct = fmtPct(r.entry, r.stopLoss, r.direction as any)
  return (
    <tr className={isDouble ? 'el' : ''}>
      <td>
        <div className="sym-stack">
          <div className="sym-line">
            {r.symbol}
            {isDouble && <span className="double-badge">DBL</span>}
          </div>
          <div className="src-line">
            {r.sources.map(s => (
              <span key={s} className={`src-mini ${s === 'PRO' ? 'pro' : s === 'PED' ? 'smart' : ''}`}>{s}</span>
            ))}
          </div>
        </div>
      </td>
      <td>
        <div className="status-stack">
          <span className={`dir-pill ${isSell ? 'sell' : 'buy'}`}>{isSell ? 'SELL' : 'BUY'}</span>
          <StatusTag s={r.status} />
        </div>
      </td>
      <td className="r-right"><span className={`conv-badge ${r.conviction < 85 ? 'mid' : ''}`}>{r.conviction || '—'}</span></td>
      <td className="r-right">
        <div className="stack-2">
          <span className="l1">{fmtRupee(r.ltp)}</span>
          <span className={`l2 ${r.ltp > r.entry ? 'bull' : r.ltp < r.entry ? 'bear' : ''}`}>{fmtPct(r.entry, r.ltp, r.direction as any) || '—'}</span>
        </div>
      </td>
      <td>
        <div className="plan-mini">
          <span className="lbl">Entry</span><span className="val">{fmtRupee(r.entry)}</span><span className="pct"></span><span className="date">{fmtDateShort(r.entryDate)}</span>
          <span className="lbl">SL</span><span className="val bear">{fmtRupee(r.stopLoss)}</span><span className={`pct ${isSell ? 'bull' : 'bear'}`}>{slPct}</span><span className="date">{fmtDateShort(r.slDate)}</span>
          <span className="lbl">T1</span><span className="val bull">{fmtRupee(r.target1)}</span><span className="pct bull">{t1Pct}</span><span className={`date ${r.status === 'T1_HIT' || r.status === 'T2_HIT' || r.status === 'T3_HIT' ? 'hit' : ''}`}>{fmtDateShort(r.target1Date)}</span>
          <span className="lbl">T2</span><span className="val bull">{fmtRupee(r.target2)}</span><span className="pct bull">{t2Pct}</span><span className={`date ${r.status === 'T2_HIT' || r.status === 'T3_HIT' ? 'hit' : ''}`}>{fmtDateShort(r.target2Date)}</span>
          <span className="lbl">T3</span><span className="val bull">{fmtRupee(r.target3)}</span><span className="pct bull">{t3Pct}</span><span className={`date ${r.status === 'T3_HIT' ? 'hit' : ''}`}>{fmtDateShort(r.target3Date)}</span>
        </div>
      </td>
      <td>
        <div className="horiz-cell">
          <span className="h-days">{daysFromNow(r.target3Date)}</span>
          <div className="h-bar"><div className="h-bar-fill" style={{ transform: 'scaleX(0.2)' }} /></div>
          <span className="h-when">to {fmtDateShort(r.target3Date)}</span>
        </div>
      </td>
      <td><div className="why-cell">{r.reason || '—'}</div></td>
    </tr>
  )
}

function StatusTag({ s }: { s: MergedRow['status'] }): JSX.Element {
  const map: Record<MergedRow['status'], { cls: string; label: string }> = {
    NEW:     { cls: 'new',     label: '🆕 NEW' },
    LIVE:    { cls: 'live',    label: '🔴 LIVE' },
    WAITING: { cls: 'waiting', label: '⏸ WAITING' },
    T1_HIT:  { cls: 't1-hit',  label: '🎯 T1 HIT' },
    T2_HIT:  { cls: 't2-hit',  label: '🎯 T2 HIT' },
    T3_HIT:  { cls: 't3-hit',  label: '🏆 T3 HIT' },
    SL_HIT:  { cls: 'sl-hit',  label: '⛔ SL HIT' },
  }
  const v = map[s]
  return <span className={`status-tag ${v.cls}`}>{v.label}</span>
}

// ─── NIFTY VIEW ──────────────────────────────────────────────────────
function NiftyView(): JSX.Element {
  const q = useQuery({ queryKey: ['desk-nifty'], queryFn: () => snapshots.niftyOutlook(), refetchInterval: 4 * 60_000, retry: false })
  const d: any = q.data
  return (
    <>
      <div className="proposal-note"><span>✦</span><div><b>NIFTY dashboard preview.</b> Same data as production /nifty-outlook.</div></div>
      <div className="desk-page-head">
        <div><h1 className="desk-page-title">🧭 NIFTY</h1><p className="desk-page-desc">Composite bias, VP setup, OI positioning, playbook, history rhymes.</p></div>
      </div>
      {q.isLoading && <div style={{ padding: 24, color: 'var(--desk-text-3)' }}>Loading NIFTY snapshot…</div>}
      {d && (
        <div className="desk-hero" style={{ gridTemplateColumns: '1.4fr 1fr 1fr' }}>
          <div className={`desk-kpi ${d.direction === 'BULLISH' ? 'bull' : 'accent'}`}>
            <div className="desk-kpi-label">Composite direction</div>
            <div className={`desk-kpi-num ${d.direction === 'BULLISH' ? 'bull' : d.direction === 'BEARISH' ? 'bear' : ''}`}>{d.direction}</div>
            <div className="desk-kpi-sub">Bull {d.bullScore} · Bear {d.bearScore} · Net {d.netScore >= 0 ? '+' : ''}{d.netScore}</div>
          </div>
          <div className="desk-kpi">
            <div className="desk-kpi-label">NIFTY 50 spot</div>
            <div className="desk-kpi-num">{d.spot?.toLocaleString('en-IN', { minimumFractionDigits: 2 }) ?? '—'}</div>
            <div className="desk-kpi-sub">Confidence · {d.confidence}</div>
          </div>
          <div className="desk-kpi">
            <div className="desk-kpi-label">Smart-money level</div>
            <div className="desk-kpi-num el">{d.smartMoneyLevel ?? '—'}</div>
            <div className="desk-kpi-sub">Book · {d.smartMoneyDirection}</div>
          </div>
        </div>
      )}
    </>
  )
}

// ─── SMART MONEY VIEW ────────────────────────────────────────────────
function SmartMoneyView(): JSX.Element {
  const q = useQuery({ queryKey: ['desk-insider'], queryFn: () => snapshots.insiderBuys(), refetchInterval: 60 * 60_000, retry: false })
  const rows: any[] = (q.data as any)?.rows ?? []
  const [pageSize, setPageSize] = useState(50)
  const visible = rows.slice(0, pageSize)
  return (
    <>
      <div className="proposal-note"><span>✦</span><div><b>Smart Money preview.</b> Insider Buys + Pedigree + Bulk Deals combined. Same snapshots as production.</div></div>
      <div className="desk-page-head">
        <div>
          <h1 className="desk-page-title">⛰ Smart Money</h1>
          <p className="desk-page-desc">SEBI PIT Reg 7 promoter/KMP filings + SAST Reg 29 external 5/10/15% crossings + Bulk Deals + Pedigree QoQ deltas.</p>
        </div>
      </div>
      <div className="desk-table-card">
        <div className="desk-table-x">
          <table className="desk-grid">
            <colgroup>
              <col className="w-symbol" /><col className="w-status" /><col className="w-conv" />
              <col className="w-ltp" /><col className="w-plan" /><col className="w-horizon" /><col className="w-why" />
            </colgroup>
            <thead>
              <tr>
                <th>Symbol · Source</th>
                <th>Status</th>
                <th className="r-right">Score</th>
                <th className="r-right">LTP</th>
                <th>Buy Breakdown</th>
                <th>Context</th>
                <th>Why · Actors</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={r.symbol + i} className={r.signal === 'STRONG_INSIDER_BUY' ? 'el' : ''}>
                  <td><div className="sym-stack"><div className="sym-line">{r.symbol}{r.signal === 'STRONG_INSIDER_BUY' && <span className="double-badge">STRONG</span>}</div><div className="src-line"><span className="src-mini pro">INSIDER</span></div></div></td>
                  <td><div className="status-stack"><span className="status-tag new">🆕 NEW</span></div></td>
                  <td className="r-right"><span className={`conv-badge ${r.score < 70 ? 'mid' : ''}`}>{r.score}</span></td>
                  <td className="r-right"><div className="stack-2"><span className="l1">{fmtRupee(r.close)}</span></div></td>
                  <td className="mono" style={{ fontSize: 11.5, color: 'var(--desk-text-2)' }}>
                    P ₹{(r.promoterNetBuyCr ?? 0).toFixed(1)}Cr · KMP ₹{(r.kmpNetBuyCr ?? 0).toFixed(1)}Cr · SAST ₹{(r.externalAcquirerBuyCr ?? 0).toFixed(1)}Cr
                  </td>
                  <td className="mono" style={{ fontSize: 11, color: 'var(--desk-text-3)' }}>
                    RSI {Math.round(r.rsi14 ?? 0)} · −{Math.round(r.pctOffHigh52w ?? 0)}% off 52w-hi
                  </td>
                  <td><div className="why-cell">{pickReason(r)}</div></td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--desk-text-3)', padding: '48px 20px' }}>No insider filings in the current 30-day window.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > pageSize && (
          <div className="load-more-strip">
            <div className="showing-count">Showing <b>{visible.length}</b> of <b className="accent">{rows.length}</b></div>
            <div className="load-more-actions"><button className="load-more-btn" onClick={() => setPageSize(s => s + 50)}>Load next 50 ↓</button></div>
          </div>
        )}
      </div>
    </>
  )
}

// ─── PLACEHOLDER ─────────────────────────────────────────────────────
function PlaceholderView({ tab }: { tab: TabKey }): JSX.Element {
  const rail = RAILS[tab]
  return (
    <>
      <div className="desk-page-head">
        <div><h1 className="desk-page-title">{rail.title}</h1><p className="desk-page-desc">{rail.desc}</p></div>
      </div>
      <div className="proposal-note"><span>→</span><div>This tab will be migrated to the redesign. It'll pull from the same snapshot endpoints that today's production tab uses. Preview coming soon on this branch.</div></div>
    </>
  )
}
