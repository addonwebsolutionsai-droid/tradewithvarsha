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
import { useSortable, matchesQuery, type SortableColumn } from './hooks'
import './tokens.css'

// ─── Sortable table header helper ────────────────────────────────────
function SortableTh({
  label, sortKey, currentKey, dir, onSort, className,
}: { label: React.ReactNode; sortKey: string; currentKey: string; dir: 'asc' | 'desc'; onSort: (k: string) => void; className?: string }) {
  const active = currentKey === sortKey
  return (
    <th className={className} onClick={() => onSort(sortKey)}
        style={{ cursor: 'pointer', userSelect: 'none' }}>
      {label}
      {active && <span style={{ marginLeft: 4, color: 'var(--desk-accent)' }}>{dir === 'desc' ? '↓' : '↑'}</span>}
    </th>
  )
}

// ─── Types ───────────────────────────────────────────────────────────
type TabKey = 'master' | 'nifty' | 'chart' | 'harmonic' | 'elliott' | 'tech' | 'swings' | 'smart' | 'scan'
type Theme = 'dark' | 'light'

const TABS: Array<{ key: TabKey; label: string; icon: string; count?: number }> = [
  { key: 'master',   label: 'Master',    icon: '✦' },
  { key: 'nifty',    label: 'NIFTY',     icon: '🧭' },
  { key: 'chart',    label: 'Patterns',  icon: '📐' },
  { key: 'harmonic', label: 'Harmonic',  icon: '∿' },
  { key: 'elliott',  label: 'Elliott',   icon: '⋀' },
  { key: 'tech',     label: 'Tech',      icon: '📊' },
  { key: 'swings',   label: 'Swings',    icon: '🌱' },
  { key: 'smart',    label: 'Smart $',   icon: '⛰' },
  { key: 'scan',     label: 'Ask',       icon: '💬' },
]

const THEME_KEY = 'desk-theme'
const TAB_KEY = 'desk-tab'

// Global search context — child views read it and filter their rows.
import { createContext, useContext } from 'react'
const SearchCtx = createContext<string>('')
const useSearchQuery = () => useContext(SearchCtx)

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
  scan: { title: '🔎 Scan', desc: 'On-demand real-time scan · paste 1-25 symbols and see composite bias, feature snapshot, and trade plan.', groups: [
    { title: 'Common baskets', items: [
      { icon: '◉', label: 'Custom (enter above)', on: true },
      { icon: '·', label: 'Nifty 50 heavyweights' },
      { icon: '·', label: 'Bank Nifty basket' },
      { icon: '·', label: 'IT top-5' },
      { icon: '·', label: 'FMCG top-5' },
    ]},
    { title: 'How it works', items: [
      { icon: '⚡', label: 'Uses live quote intraday' },
      { icon: '📊', label: 'Falls back to last close after hours' },
      { icon: '🎯', label: 'Trade plan when composite ≥ 60' },
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
  const [search, setSearch] = useState<string>('')
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
          <div className="desk-header-right" style={{ gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--desk-surface-2)', border: '1px solid var(--desk-border)', borderRadius: 8, padding: '4px 8px', width: 200 }}>
              <span style={{ color: 'var(--desk-text-3)', fontSize: 12 }}>🔎</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && search.trim().length > 0) {
                    setTab('scan')
                  }
                }}
                placeholder="Search · Enter to ask"
                style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--desk-text)', fontSize: 12, fontFamily: 'inherit', flex: 1, minWidth: 0 }}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  style={{ background: 'transparent', border: 'none', color: 'var(--desk-text-3)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
                  title="Clear"
                >×</button>
              )}
            </div>
            <button className="desk-theme-btn" onClick={toggleTheme} style={{ padding: '0 10px' }}>
              <span>{theme === 'dark' ? '◐' : '◑'}</span>
              <span className="desk-th-mode">{theme}</span>
            </button>
          </div>
        </header>

        <SearchCtx.Provider value={search}>
        <div className="desk-body">
          <RailPane tab={tab} />
          <div className="desk-canvas">
            {tab === 'master' && <MasterView />}
            {tab === 'nifty' && <NiftyView />}
            {tab === 'smart' && <SmartMoneyView />}
            {tab === 'chart' && <ChartPatternsView />}
            {tab === 'harmonic' && <HarmonicView />}
            {tab === 'elliott' && <ElliottView />}
            {tab === 'tech' && <TechnicalsView />}
            {tab === 'swings' && <SwingsView />}
            {tab === 'scan' && <ScanView />}
          </div>
        </div>
        </SearchCtx.Provider>
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

/**
 * Resolve a signal's status.
 *
 * Priority order:
 *   1. Explicit lifecycle status from the ledger (T1/T2/T3 HIT, SL HIT,
 *      ACTIVE→LIVE, PENDING→WAITING)
 *   2. If entryDate is today (IST) OR the snapshot was generated today
 *      AND the row lacks lifecycle info → NEW (signal fired today)
 *   3. Otherwise → WAITING (in the ledger but not yet triggered)
 *
 * "Sees NEW tag on brand-new signals" — this fixes the earlier logic
 * that marked every unresolved row as NEW forever.
 */
function todayIst(): string {
  const d = new Date(Date.now() + 5.5 * 3600_000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function statusOf(r: any): MergedRow['status'] {
  const s = String(r?.status ?? r?.lifecycleStatus ?? '')
  if (s === 'T1_HIT' || s === 'T2_HIT' || s === 'T3_HIT' || s === 'SL_HIT') return s as MergedRow['status']
  if (s === 'ACTIVE') return 'LIVE'
  if (s === 'PENDING') return 'WAITING'
  const t = todayIst()
  const entryToday = typeof r?.entryDate === 'string' && r.entryDate.startsWith(t)
  const firstSeenToday = typeof r?.firstSeenAt === 'string' && r.firstSeenAt.slice(0, 10) === t
  if (entryToday || firstSeenToday) return 'NEW'
  return 'WAITING'
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

  const q = useSearchQuery()
  const searched = useMemo(() => rows.filter(r => matchesQuery(r, q)), [rows, q])
  const columns: SortableColumn<MergedRow>[] = [
    { key: 'symbol', accessor: r => r.symbol },
    { key: 'direction', accessor: r => r.direction },
    { key: 'conviction', accessor: r => r.conviction },
    { key: 'ltp', accessor: r => r.ltp },
    { key: 'entry', accessor: r => r.entry },
    { key: 'target1', accessor: r => r.target1 },
    { key: 'target3', accessor: r => r.target3 },
    { key: 'sources', accessor: r => r.sources.length },
  ]
  const { sortedRows, sort, onSort } = useSortable(searched, { key: 'conviction', dir: 'desc' }, columns)
  const [pageSize, setPageSize] = useState(50)
  const visible = sortedRows.slice(0, pageSize)
  const eliteCount = searched.filter(r => r.sources.length >= 2).length
  const avgConv = searched.length ? Math.round(searched.reduce((s, r) => s + r.conviction, 0) / searched.length) : 0

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
                <SortableTh label="Symbol · Sources" sortKey="symbol" currentKey={sort.key} dir={sort.dir} onSort={onSort} />
                <SortableTh label="Dir · Status" sortKey="direction" currentKey={sort.key} dir={sort.dir} onSort={onSort} />
                <SortableTh label="Conv" sortKey="conviction" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
                <SortableTh label="LTP" sortKey="ltp" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
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

// ─── CHART PATTERNS ──────────────────────────────────────────────────
function ChartPatternsView(): JSX.Element {
  const q = useQuery({ queryKey: ['desk-chart'], queryFn: () => snapshots.chartPatterns(), refetchInterval: 60 * 60_000, retry: false })
  const d: any = q.data
  const rows: any[] = d?.rows ?? []
  const [pattern, setPattern] = useState<string>('ALL')
  const [pageSize, setPageSize] = useState(50)
  const searchQ = useSearchQuery()
  const searched = useMemo(() => rows.filter(r => matchesQuery(r, searchQ)), [rows, searchQ])
  const filtered = pattern === 'ALL' ? searched : searched.filter(r => (r.pattern ?? '').toLowerCase().includes(pattern.toLowerCase()))
  const cpColumns: SortableColumn<any>[] = [
    { key: 'symbol', accessor: r => r.symbol ?? '' },
    { key: 'pattern', accessor: r => r.pattern ?? '' },
    { key: 'direction', accessor: r => r.direction ?? '' },
    { key: 'score', accessor: r => r.score ?? 0 },
    { key: 'ltp', accessor: r => r.ltp ?? 0 },
    { key: 'target1', accessor: r => r.target1 ?? 0 },
  ]
  const cpSort = useSortable(filtered, { key: 'score', dir: 'desc' }, cpColumns)
  const visible = cpSort.sortedRows.slice(0, pageSize)
  const patternCounts: Record<string, number> = d?.byPattern ?? {}
  const patterns = Object.keys(patternCounts).sort((a, b) => (patternCounts[b] ?? 0) - (patternCounts[a] ?? 0)).slice(0, 8)
  return (
    <>
      <div className="desk-page-head">
        <div>
          <h1 className="desk-page-title">📐 Chart Patterns</h1>
          <p className="desk-page-desc">Classical TA scanner over NIFTY-500 × Daily/Weekly. Volume + range + trend confirmations. Measured-move targets per pattern.</p>
        </div>
        <div className="desk-btn-row">
          <button className="desk-btn">↓ CSV</button>
          <button className="desk-btn primary">↻ Refresh</button>
        </div>
      </div>

      <div className="desk-hero">
        <div className="desk-kpi accent">
          <div className="desk-kpi-label">Pattern hits</div>
          <div className="desk-kpi-num acc">{rows.length}</div>
          <div className="desk-kpi-sub">across {Object.keys(patternCounts).length} pattern families</div>
        </div>
        <div className="desk-kpi">
          <div className="desk-kpi-label">Most common</div>
          <div className="desk-kpi-num" style={{ fontSize: 18 }}>{patterns[0] ?? '—'}</div>
          <div className="desk-kpi-sub">{patternCounts[patterns[0]] ?? 0} hits</div>
        </div>
        <div className="desk-kpi">
          <div className="desk-kpi-label">Bullish</div>
          <div className="desk-kpi-num bull">{rows.filter(r => r.direction === 'BUY').length}</div>
          <div className="desk-kpi-sub">breakout candidates</div>
        </div>
        <div className="desk-kpi">
          <div className="desk-kpi-label">Bearish</div>
          <div className="desk-kpi-num bear">{rows.filter(r => r.direction !== 'BUY').length}</div>
          <div className="desk-kpi-sub">breakdown candidates</div>
        </div>
      </div>

      <div className="desk-toolbar">
        <div className="desk-chips">
          <button className={`desk-chip ${pattern === 'ALL' ? 'on' : ''}`} onClick={() => setPattern('ALL')}>All <span className="n">{rows.length}</span></button>
          {patterns.map(p => (
            <button key={p} className={`desk-chip ${pattern === p ? 'on' : ''}`} onClick={() => setPattern(p)}>
              {p} <span className="n">{patternCounts[p]}</span>
            </button>
          ))}
        </div>
        <div className="desk-toolbar-right">Sort <b>Score ↓</b></div>
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
                <SortableTh label="Symbol · Pattern" sortKey="symbol" currentKey={cpSort.sort.key} dir={cpSort.sort.dir} onSort={cpSort.onSort} />
                <SortableTh label="Dir · Status" sortKey="direction" currentKey={cpSort.sort.key} dir={cpSort.sort.dir} onSort={cpSort.onSort} />
                <SortableTh label="Score" sortKey="score" currentKey={cpSort.sort.key} dir={cpSort.sort.dir} onSort={cpSort.onSort} className="r-right" />
                <SortableTh label="LTP" sortKey="ltp" currentKey={cpSort.sort.key} dir={cpSort.sort.dir} onSort={cpSort.onSort} className="r-right" />
                <th>Trade Plan</th>
                <th>Horizon</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <PatternRow key={r.symbol + i} r={r} />
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--desk-text-3)', padding: '48px 20px' }}>
                  {q.isLoading ? 'Loading pattern scan…' : 'No pattern hits matching the current filter.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > pageSize && (
          <div className="load-more-strip">
            <div className="showing-count">Showing <b>{visible.length}</b> of <b className="accent">{filtered.length}</b> · sorted by <b>Score ↓</b></div>
            <div className="load-more-actions"><button className="load-more-btn" onClick={() => setPageSize(s => s + 50)}>Load next 50 ↓</button></div>
          </div>
        )}
      </div>
    </>
  )
}

function PatternRow({ r }: { r: any }): JSX.Element {
  const isSell = r.direction === 'SHORT' || r.direction === 'SELL'
  const t1Pct = fmtPct(r.entry, r.target1, r.direction)
  const t2Pct = fmtPct(r.entry, r.target2, r.direction)
  const t3Pct = fmtPct(r.entry, r.target3, r.direction)
  const slPct = fmtPct(r.entry, r.stopLoss, r.direction)
  return (
    <tr>
      <td>
        <div className="sym-stack">
          <div className="sym-line">{r.symbol}</div>
          <div className="src-line"><span className="src-mini">{r.pattern ?? 'Pattern'}</span></div>
        </div>
      </td>
      <td>
        <div className="status-stack">
          <span className={`dir-pill ${isSell ? 'sell' : 'buy'}`}>{isSell ? 'SELL' : 'BUY'}</span>
          <StatusTag s={statusOf(r)} />
        </div>
      </td>
      <td className="r-right"><span className={`conv-badge ${(r.score ?? 0) < 70 ? 'mid' : ''}`}>{r.score ?? '—'}</span></td>
      <td className="r-right"><div className="stack-2"><span className="l1">{fmtRupee(r.ltp)}</span></div></td>
      <td>
        <div className="plan-mini">
          <span className="lbl">Entry</span><span className="val">{fmtRupee(r.entry)}</span><span className="pct"></span><span className="date">{fmtDateShort(r.entryDate)}</span>
          <span className="lbl">SL</span><span className="val bear">{fmtRupee(r.stopLoss)}</span><span className={`pct ${isSell ? 'bull' : 'bear'}`}>{slPct}</span><span className="date">{fmtDateShort(r.slDate)}</span>
          <span className="lbl">T1</span><span className="val bull">{fmtRupee(r.target1)}</span><span className="pct bull">{t1Pct}</span><span className="date">{fmtDateShort(r.target1Date)}</span>
          <span className="lbl">T2</span><span className="val bull">{fmtRupee(r.target2)}</span><span className="pct bull">{t2Pct}</span><span className="date">{fmtDateShort(r.target2Date)}</span>
          <span className="lbl">T3</span><span className="val bull">{fmtRupee(r.target3)}</span><span className="pct bull">{t3Pct}</span><span className="date">{fmtDateShort(r.target3Date)}</span>
        </div>
      </td>
      <td>
        <div className="horiz-cell">
          <span className="h-days">{daysFromNow(r.target3Date)}</span>
          <div className="h-bar"><div className="h-bar-fill" style={{ transform: 'scaleX(0.1)' }} /></div>
          <span className="h-when">to {fmtDateShort(r.target3Date)}</span>
        </div>
      </td>
      <td><div className="why-cell">{pickReason(r)}</div></td>
    </tr>
  )
}

// ─── HARMONIC (reads dedicated snapshot) ────────────────────────────
function HarmonicView(): JSX.Element {
  const q = useQuery({ queryKey: ['desk-harmonic'], queryFn: () => snapshots.harmonic(), refetchInterval: 30 * 60_000, retry: false })
  const d: any = q.data
  const rows: any[] = d?.rows ?? []
  const patternCounts: Record<string, number> = d?.byPattern ?? {}
  const patterns = Object.keys(patternCounts).sort((a, b) => (patternCounts[b] ?? 0) - (patternCounts[a] ?? 0))
  const [pattern, setPattern] = useState('ALL')
  const filtered = pattern === 'ALL' ? rows : rows.filter(r => (r.pattern ?? '').includes(pattern))
  return (
    <>
      <div className="desk-page-head">
        <div>
          <h1 className="desk-page-title">∿ Harmonic</h1>
          <p className="desk-page-desc">Live PRZ scanner across Gartley / Bat / Butterfly / Crab / Shark / Cypher. XABCD Fib ratios verified · invalidation levels per hit · POSITIONAL + HOURLY + INTRADAY tiers.</p>
        </div>
        <div className="desk-btn-row"><button className="desk-btn">↓ CSV</button></div>
      </div>
      <div className="desk-hero">
        <div className="desk-kpi accent"><div className="desk-kpi-label">Active harmonic hits</div><div className="desk-kpi-num acc">{rows.length}</div><div className="desk-kpi-sub">across {Object.keys(patternCounts).length} pattern families</div></div>
        <div className="desk-kpi bull"><div className="desk-kpi-label">Bullish (BUY)</div><div className="desk-kpi-num bull">{rows.filter(r => r.direction === 'BUY').length}</div><div className="desk-kpi-sub">completed PRZ longs</div></div>
        <div className="desk-kpi"><div className="desk-kpi-label">Bearish (SELL)</div><div className="desk-kpi-num bear">{rows.filter(r => r.direction === 'SELL' || r.direction === 'SHORT').length}</div><div className="desk-kpi-sub">completed PRZ shorts</div></div>
        <div className="desk-kpi"><div className="desk-kpi-label">Avg confidence</div><div className="desk-kpi-num">{rows.length ? Math.round(rows.reduce((s, r) => s + (r.conviction ?? r.score ?? 0), 0) / rows.length) : '—'}</div><div className="desk-kpi-sub">from XABCD ratio match</div></div>
      </div>
      <div className="desk-toolbar">
        <div className="desk-chips">
          <button className={`desk-chip ${pattern === 'ALL' ? 'on' : ''}`} onClick={() => setPattern('ALL')}>All <span className="n">{rows.length}</span></button>
          {patterns.slice(0, 6).map(p => (
            <button key={p} className={`desk-chip ${pattern === p ? 'on' : ''}`} onClick={() => setPattern(p)}>{p} <span className="n">{patternCounts[p]}</span></button>
          ))}
        </div>
      </div>
      <SimpleTable rows={filtered} emptyMsg={q.isLoading ? 'Loading harmonic scan…' : 'No harmonic patterns detected right now. Scanner re-runs every 30 min during market hours.'} />
    </>
  )
}

// ─── ELLIOTT WAVE (reads dedicated snapshot) ────────────────────────
function ElliottView(): JSX.Element {
  const q = useQuery({ queryKey: ['desk-elliott'], queryFn: () => snapshots.elliottWave(), refetchInterval: 60 * 60_000, retry: false })
  const d: any = q.data
  const rows: any[] = d?.rows ?? []
  const byType: Record<string, number> = d?.byType ?? {}
  const setups = Object.keys(byType).sort((a, b) => (byType[b] ?? 0) - (byType[a] ?? 0))
  const [setup, setSetup] = useState('ALL')
  const filtered = setup === 'ALL' ? rows : rows.filter(r => r.setup === setup)
  return (
    <>
      <div className="desk-page-head">
        <div>
          <h1 className="desk-page-title">⋀ Elliott Wave</h1>
          <p className="desk-page-desc">Pivot-based wave scanner · <b>Wave-2 Pullback</b> (Fib 50-61.8% retrace) · <b>Wave-3 Underway</b> (breakout + volume expansion) · <b>ABC Completion</b> (equal-leg corrective). Fib-extension targets.</p>
        </div>
        <div className="desk-btn-row"><button className="desk-btn">↓ CSV</button></div>
      </div>
      <div className="desk-hero">
        <div className="desk-kpi accent"><div className="desk-kpi-label">Wave setups</div><div className="desk-kpi-num acc">{rows.length}</div><div className="desk-kpi-sub">across NSE F&O universe</div></div>
        <div className="desk-kpi"><div className="desk-kpi-label">Wave-2 Pullback</div><div className="desk-kpi-num">{byType.WAVE_2_PULLBACK ?? 0}</div><div className="desk-kpi-sub">buy the pullback</div></div>
        <div className="desk-kpi bull"><div className="desk-kpi-label">Wave-3 Underway</div><div className="desk-kpi-num bull">{byType.WAVE_3_UNDERWAY ?? 0}</div><div className="desk-kpi-sub">strongest impulse leg</div></div>
        <div className="desk-kpi"><div className="desk-kpi-label">ABC Completion</div><div className="desk-kpi-num">{byType.ABC_COMPLETION ?? 0}</div><div className="desk-kpi-sub">trend resumption</div></div>
      </div>
      <div className="desk-toolbar">
        <div className="desk-chips">
          <button className={`desk-chip ${setup === 'ALL' ? 'on' : ''}`} onClick={() => setSetup('ALL')}>All <span className="n">{rows.length}</span></button>
          {setups.map(s => (
            <button key={s} className={`desk-chip ${setup === s ? 'on' : ''}`} onClick={() => setSetup(s)}>{s.replace(/_/g, ' ')} <span className="n">{byType[s]}</span></button>
          ))}
        </div>
      </div>
      <SimpleTable rows={filtered} emptyMsg={q.isLoading ? 'Loading wave scan…' : 'No qualifying wave setups. Scanner runs each EOD.'} />
    </>
  )
}

// ─── TECHNICALS (NIFTY VP + Stock F&O VP + Fib future) ──────────────
function TechnicalsView(): JSX.Element {
  const nifQ = useQuery({ queryKey: ['desk-nifty-vp'], queryFn: () => snapshots.niftyVolumeProfile(), refetchInterval: 4 * 60_000, retry: false })
  const stkQ = useQuery({ queryKey: ['desk-stock-vp'], queryFn: () => snapshots.stockFnoVolumeProfile(), refetchInterval: 30 * 60_000, retry: false })
  const stkRows: any[] = (stkQ.data as any)?.rows ?? []
  const nif: any = nifQ.data
  const [side, setSide] = useState<'ALL' | 'BULLISH' | 'BEARISH'>('ALL')
  const [pageSize, setPageSize] = useState(50)
  const filtered = side === 'ALL' ? stkRows : stkRows.filter(r => r.side === side)
  const visible = filtered.slice(0, pageSize)
  return (
    <>
      <div className="desk-page-head">
        <div>
          <h1 className="desk-page-title">📊 Technicals</h1>
          <p className="desk-page-desc">Volume Profile across NIFTY + stock F&amp;O universe. VA/POC/HVN/LVN + 7 setup families (VA-Rotation, VA-Breakout, HVN-Reject, LVN-Slice, IB-Break, Failed-Auction, Naked-POC).</p>
        </div>
        <div className="desk-btn-row"><button className="desk-btn">↓ CSV</button><button className="desk-btn primary">↻ Refresh</button></div>
      </div>

      {nif && (
        <div className="desk-hero" style={{ gridTemplateColumns: '1.4fr 1fr 1fr' }}>
          <div className={`desk-kpi ${nif.compositeBias === 'BULLISH' ? 'bull' : 'accent'}`}>
            <div className="desk-kpi-label">NIFTY composite VP</div>
            <div className={`desk-kpi-num ${nif.compositeBias === 'BULLISH' ? 'bull' : nif.compositeBias === 'BEARISH' ? 'bear' : ''}`}>{nif.compositeBias}</div>
            <div className="desk-kpi-sub">confidence {nif.confidence} · {nif.bullTfCount}↑ / {nif.bearTfCount}↓ TFs</div>
          </div>
          <div className="desk-kpi">
            <div className="desk-kpi-label">NIFTY 50 spot</div>
            <div className="desk-kpi-num">{nif.spot?.toLocaleString('en-IN', { minimumFractionDigits: 2 }) ?? '—'}</div>
            <div className="desk-kpi-sub">agreement {nif.agreementScore}%</div>
          </div>
          <div className="desk-kpi">
            <div className="desk-kpi-label">Stock F&amp;O setups</div>
            <div className="desk-kpi-num acc">{stkRows.length}</div>
            <div className="desk-kpi-sub">{stkRows.filter(r => r.side === 'BULLISH').length} bull · {stkRows.filter(r => r.side === 'BEARISH').length} bear</div>
          </div>
        </div>
      )}

      <div className="desk-toolbar">
        <div className="desk-chips">
          {(['ALL', 'BULLISH', 'BEARISH'] as const).map(s => (
            <button key={s} className={`desk-chip ${side === s ? 'on' : ''}`} onClick={() => setSide(s)}>
              {s} <span className="n">{s === 'ALL' ? stkRows.length : stkRows.filter(r => r.side === s).length}</span>
            </button>
          ))}
        </div>
        <div className="desk-toolbar-right">Sort <b>Strength ↓</b></div>
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
                <th>Symbol · Setup</th>
                <th>Side · TFs</th>
                <th className="r-right">Str</th>
                <th className="r-right">LTP</th>
                <th>Trade Plan</th>
                <th>Horizon</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => <VpRow key={r.symbol + i} r={r} />)}
              {visible.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--desk-text-3)', padding: '48px 20px' }}>
                  {stkQ.isLoading ? 'Loading Volume Profile scan…' : 'No qualifying setups. VP runs at EOD.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > pageSize && (
          <div className="load-more-strip">
            <div className="showing-count">Showing <b>{visible.length}</b> of <b className="accent">{filtered.length}</b></div>
            <div className="load-more-actions"><button className="load-more-btn" onClick={() => setPageSize(s => s + 50)}>Load next 50 ↓</button></div>
          </div>
        )}
      </div>
    </>
  )
}

function VpRow({ r }: { r: any }): JSX.Element {
  const isSell = r.side === 'BEARISH'
  return (
    <tr>
      <td>
        <div className="sym-stack">
          <div className="sym-line">{r.symbol}</div>
          <div className="src-line"><span className="src-mini">{(r.bestSetup ?? '').replace(/_/g, ' ')}</span></div>
        </div>
      </td>
      <td>
        <div className="status-stack">
          <span className={`dir-pill ${isSell ? 'sell' : 'buy'}`}>{isSell ? 'SELL' : 'BUY'}</span>
          <span className="status-tag waiting">{r.bestTf} · {r.agreementScore}/3 TFs</span>
        </div>
      </td>
      <td className="r-right"><span className="conv-badge">{r.compositeStrength ?? '—'}</span></td>
      <td className="r-right"><div className="stack-2"><span className="l1">{fmtRupee(r.ltp)}</span></div></td>
      <td>
        <div className="plan-mini">
          <span className="lbl">Entry</span><span className="val">{fmtRupee(r.entry)}</span><span className="pct"></span><span className="date">{fmtDateShort(r.entryDate)}</span>
          <span className="lbl">SL</span><span className="val bear">{fmtRupee(r.stopLoss)}</span><span className="pct bear">SL</span><span className="date">{fmtDateShort(r.slDate)}</span>
          <span className="lbl">T1</span><span className="val bull">{fmtRupee(r.target1)}</span><span className="pct bull">{fmtPct(r.entry, r.target1, r.side === 'BEARISH' ? 'SHORT' : 'BUY')}</span><span className="date">{fmtDateShort(r.target1Date)}</span>
          <span className="lbl">T2</span><span className="val bull">{fmtRupee(r.target2)}</span><span className="pct bull">{fmtPct(r.entry, r.target2, r.side === 'BEARISH' ? 'SHORT' : 'BUY')}</span><span className="date">{fmtDateShort(r.target2Date)}</span>
          <span className="lbl">T3</span><span className="val bull">{fmtRupee(r.target3)}</span><span className="pct bull">{fmtPct(r.entry, r.target3, r.side === 'BEARISH' ? 'SHORT' : 'BUY')}</span><span className="date">{fmtDateShort(r.target3Date)}</span>
        </div>
      </td>
      <td>
        <div className="horiz-cell">
          <span className="h-days">{daysFromNow(r.target3Date)}</span>
          <div className="h-bar"><div className="h-bar-fill" style={{ transform: 'scaleX(0.1)' }} /></div>
          <span className="h-when">to {fmtDateShort(r.target3Date)}</span>
        </div>
      </td>
      <td><div className="why-cell">{pickReason(r)}</div></td>
    </tr>
  )
}

// ─── SWINGS (Weekly + Daily + Pre-Move) ─────────────────────────────
function SwingsView(): JSX.Element {
  const weekly = useQuery({ queryKey: ['desk-weekly'], queryFn: () => snapshots.weeklyPick(), refetchInterval: 60 * 60_000, retry: false })
  const daily = useQuery({ queryKey: ['desk-daily'], queryFn: () => snapshots.dailyPick(), refetchInterval: 60 * 60_000, retry: false })
  const premove = useQuery({ queryKey: ['desk-pre'], queryFn: () => snapshots.preMove(), refetchInterval: 60 * 60_000, retry: false })
  const [horizon, setHorizon] = useState<'ALL' | 'WEEKLY' | 'DAILY' | 'PRE_MOVE'>('ALL')
  const [pageSize, setPageSize] = useState(50)

  const combined = useMemo(() => {
    const out: any[] = []
    for (const r of ((weekly.data as any)?.rows ?? [])) out.push({ ...r, _src: 'WEEKLY' })
    for (const r of ((daily.data as any)?.rows ?? [])) out.push({ ...r, _src: 'DAILY' })
    for (const r of ((premove.data as any)?.rows ?? [])) out.push({ ...r, _src: 'PRE_MOVE' })
    out.sort((a, b) => (b.conviction ?? b.score ?? 0) - (a.conviction ?? a.score ?? 0))
    return out
  }, [weekly.data, daily.data, premove.data])

  const filtered = horizon === 'ALL' ? combined : combined.filter(r => r._src === horizon)
  const visible = filtered.slice(0, pageSize)

  return (
    <>
      <div className="desk-page-head">
        <div>
          <h1 className="desk-page-title">🌱 Swings</h1>
          <p className="desk-page-desc">All horizon-based signals — Pre-Move (pre-breakout), Weekly (1-4 wks), Daily (1-15 d) — under one roof. Filter by horizon in the rail or top chips.</p>
        </div>
        <div className="desk-btn-row"><button className="desk-btn">↓ CSV</button><button className="desk-btn primary">↻ Refresh</button></div>
      </div>

      <div className="desk-hero">
        <div className="desk-kpi accent"><div className="desk-kpi-label">Total signals</div><div className="desk-kpi-num acc">{combined.length}</div><div className="desk-kpi-sub">across 3 horizons</div></div>
        <div className="desk-kpi"><div className="desk-kpi-label">📅 Weekly</div><div className="desk-kpi-num">{((weekly.data as any)?.rows ?? []).length}</div><div className="desk-kpi-sub">1-4 week horizon</div></div>
        <div className="desk-kpi"><div className="desk-kpi-label">☀ Daily</div><div className="desk-kpi-num">{((daily.data as any)?.rows ?? []).length}</div><div className="desk-kpi-sub">1-15 day horizon</div></div>
        <div className="desk-kpi"><div className="desk-kpi-label">◈ Pre-Move</div><div className="desk-kpi-num">{((premove.data as any)?.rows ?? []).length}</div><div className="desk-kpi-sub">pre-breakout</div></div>
      </div>

      <div className="desk-toolbar">
        <div className="desk-chips">
          {(['ALL', 'WEEKLY', 'DAILY', 'PRE_MOVE'] as const).map(h => (
            <button key={h} className={`desk-chip ${horizon === h ? 'on' : ''}`} onClick={() => setHorizon(h)}>
              {h === 'ALL' ? 'All' : h === 'PRE_MOVE' ? 'Pre-Move' : h.charAt(0) + h.slice(1).toLowerCase()}
              <span className="n">{h === 'ALL' ? combined.length : combined.filter(r => r._src === h).length}</span>
            </button>
          ))}
        </div>
        <div className="desk-toolbar-right">Sort <b>Conviction ↓</b></div>
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
                <th>Dir · Status</th>
                <th className="r-right">Conv</th>
                <th className="r-right">LTP</th>
                <th>Trade Plan</th>
                <th>Horizon</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => (
                <tr key={(r.symbol ?? '') + i}>
                  <td>
                    <div className="sym-stack">
                      <div className="sym-line">{r.symbol}</div>
                      <div className="src-line"><span className={`src-mini ${r._src === 'WEEKLY' ? 'pro' : ''}`}>{r._src}</span></div>
                    </div>
                  </td>
                  <td>
                    <div className="status-stack">
                      <span className={`dir-pill ${r.direction === 'SHORT' ? 'sell' : 'buy'}`}>{r.direction === 'SHORT' ? 'SELL' : 'BUY'}</span>
                      <span className="status-tag waiting">{r._src === 'PRE_MOVE' ? '⏸ WAITING' : '🔴 LIVE'}</span>
                    </div>
                  </td>
                  <td className="r-right"><span className={`conv-badge ${(r.conviction ?? 0) < 85 ? 'mid' : ''}`}>{r.conviction ?? r.score ?? '—'}</span></td>
                  <td className="r-right"><div className="stack-2"><span className="l1">{fmtRupee(r.ltp ?? r.close)}</span></div></td>
                  <td>
                    <div className="plan-mini">
                      <span className="lbl">Entry</span><span className="val">{fmtRupee(r.entry ?? r.entryPrice)}</span><span className="pct"></span><span className="date">{fmtDateShort(r.entryDate)}</span>
                      <span className="lbl">SL</span><span className="val bear">{fmtRupee(r.stopLoss)}</span><span className="pct bear">SL</span><span className="date">{fmtDateShort(r.slDate)}</span>
                      <span className="lbl">T1</span><span className="val bull">{fmtRupee(r.target1)}</span><span className="pct bull">{fmtPct(r.entry ?? r.entryPrice, r.target1, r.direction)}</span><span className="date">{fmtDateShort(r.target1Date)}</span>
                      <span className="lbl">T2</span><span className="val bull">{fmtRupee(r.target2)}</span><span className="pct bull">{fmtPct(r.entry ?? r.entryPrice, r.target2, r.direction)}</span><span className="date">{fmtDateShort(r.target2Date)}</span>
                      <span className="lbl">T3</span><span className="val bull">{fmtRupee(r.target3)}</span><span className="pct bull">{fmtPct(r.entry ?? r.entryPrice, r.target3, r.direction)}</span><span className="date">{fmtDateShort(r.target3Date)}</span>
                    </div>
                  </td>
                  <td>
                    <div className="horiz-cell">
                      <span className="h-days">{daysFromNow(r.target3Date)}</span>
                      <div className="h-bar"><div className="h-bar-fill" style={{ transform: 'scaleX(0.1)' }} /></div>
                      <span className="h-when">to {fmtDateShort(r.target3Date)}</span>
                    </div>
                  </td>
                  <td><div className="why-cell">{pickReason(r)}</div></td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--desk-text-3)', padding: '48px 20px' }}>
                  Loading swing signals across all horizons…
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > pageSize && (
          <div className="load-more-strip">
            <div className="showing-count">Showing <b>{visible.length}</b> of <b className="accent">{filtered.length}</b></div>
            <div className="load-more-actions"><button className="load-more-btn" onClick={() => setPageSize(s => s + 50)}>Load next 50 ↓</button></div>
          </div>
        )}
      </div>
    </>
  )
}

// ─── ASK / SCAN VIEW · natural-language real-time scan ───────────────
//
// User types free-form: "check KHADIM in live market" · "gold" · "how is
// XAUUSD" · "RELIANCE TCS INFY" — we extract symbols and run the on-
// demand scan. Works during and outside market hours.
//
// Alias map lets us handle common instrument nicknames.
const ALIAS_MAP: Record<string, string> = {
  'GOLD':     'GOLD',
  'XAU':      'XAUUSD',
  'XAUUSD':   'XAUUSD',
  'CRUDE':    'CRUDE',
  'OIL':      'CRUDE',
  'DXY':      'DXY',
  'USDINR':   'USDINR',
  'USD':      'USDINR',
  'INR':      'USDINR',
  'NIFTY':    'NIFTY',
  'NIFTY50':  'NIFTY',
  'BANK':     'BANKNIFTY',
  'BANKNIFTY':'BANKNIFTY',
  'SENSEX':   'SENSEX',
  'VIX':      'INDIAVIX',
  'INDIAVIX': 'INDIAVIX',
}
// Words that appear in "check X in live market" style queries — strip these.
const STOP_WORDS = new Set([
  'CHECK', 'SCAN', 'LOOK', 'SHOW', 'ME', 'AT', 'IN', 'ON', 'THE', 'IS',
  'HOW', 'WHAT', 'WHY', 'PLEASE', 'REAL', 'TIME', 'LIVE', 'MARKET',
  'PLATFORM', 'RIGHT', 'NOW', 'TODAY', 'FOR', 'ABOUT', 'WITH', 'ANY',
  'OR', 'AND', 'A', 'AN', 'MY', 'YOU', 'CAN', 'DO', 'DOES', 'WANT',
  'STOCK', 'SHARE', 'SYMBOL',
])
function parseSymbolsFromQuery(q: string): string[] {
  const tokens = q.toUpperCase().replace(/[^A-Z0-9\s&-]/g, ' ').split(/\s+/).filter(Boolean)
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    if (STOP_WORDS.has(t)) continue
    const mapped = ALIAS_MAP[t] ?? t
    if (mapped.length < 2 || mapped.length > 15) continue
    if (!/^[A-Z][A-Z0-9&-]+$/.test(mapped)) continue
    if (seen.has(mapped)) continue
    seen.add(mapped)
    out.push(mapped)
  }
  return out
}

interface AskExchange {
  q: string
  parsed: string[]
  rows: any[]
  ts: string
  busy?: boolean
  error?: string
}

function ScanView(): JSX.Element {
  const globalSearch = useSearchQuery()
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<AskExchange[]>([])
  const [busy, setBusy] = useState(false)

  // If the top-nav search bar contains something, prefill it here.
  useEffect(() => {
    if (globalSearch && !input) setInput(globalSearch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalSearch])

  const runAsk = async (raw?: string) => {
    const q = (raw ?? input).trim()
    if (!q) return
    const parsed = parseSymbolsFromQuery(q)
    if (parsed.length === 0) {
      setHistory(h => [{ q, parsed: [], rows: [], ts: new Date().toISOString(), error: 'No recognisable symbol in that query. Try: "check KHADIM" · "gold" · "RELIANCE TCS INFY" · "XAUUSD".' }, ...h])
      setInput('')
      return
    }
    setBusy(true)
    const exchangeIdx = 0
    setHistory(h => [{ q, parsed, rows: [], ts: new Date().toISOString(), busy: true }, ...h])
    setInput('')
    try {
      const res = await fetch('/api/scan/on-demand', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: parsed }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setHistory(h => h.map((ex, i) => i === exchangeIdx ? { ...ex, rows: data.results ?? [], busy: false } : ex))
    } catch (e) {
      setHistory(h => h.map((ex, i) => i === exchangeIdx ? { ...ex, error: (e as Error).message, busy: false } : ex))
    } finally {
      setBusy(false)
    }
  }

  // Auto-run if we arrived here from the top search Enter key.
  useEffect(() => {
    if (globalSearch && globalSearch.length >= 2 && history.length === 0) {
      runAsk(globalSearch)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalSearch])

  const suggestions = [
    'check KHADIM in live market',
    'gold',
    'XAUUSD',
    'CRUDE',
    'RELIANCE TCS INFY',
    'NIFTY BANK',
  ]

  return (
    <>
      <div className="desk-page-head">
        <div>
          <h1 className="desk-page-title">💬 Ask · Live Research</h1>
          <p className="desk-page-desc">Ask about any stock, commodity, index, or currency — anytime. Types like <b>"check KHADIM"</b> · <b>"gold"</b> · <b>"XAUUSD"</b> · <b>"RELIANCE TCS INFY"</b> · <b>"NIFTY BANK"</b>. Every response runs the same core engine (LTP · EMA stack · RSI · volume ratio · 20-day-high proximity · composite bias + score · trade plan) using live quote when the market's open, last close otherwise.</p>
        </div>
      </div>

      <div style={{ background: 'var(--desk-surface)', border: '1px solid var(--desk-border)', borderRadius: 12, padding: 16, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) runAsk() }}
            placeholder="Ask anything · e.g. check KHADIM · gold · RELIANCE TCS INFY"
            disabled={busy}
            style={{ flex: 1, background: 'var(--desk-bg)', border: '1px solid var(--desk-border)', borderRadius: 8, padding: '10px 14px', color: 'var(--desk-text)', fontFamily: 'inherit', fontSize: 13.5, outline: 'none' }}
          />
          <button className="desk-btn primary" onClick={() => runAsk()} disabled={busy || !input.trim()}>
            {busy ? 'Scanning…' : '⚡ Scan'}
          </button>
        </div>
        {history.length === 0 && (
          <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--desk-text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginRight: 6 }}>Try:</span>
            {suggestions.map(s => (
              <button
                key={s}
                onClick={() => runAsk(s)}
                style={{ padding: '4px 10px', background: 'var(--desk-surface-2)', border: '1px solid var(--desk-border)', borderRadius: 14, color: 'var(--desk-text-2)', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit' }}
              >{s}</button>
            ))}
          </div>
        )}
      </div>

      {history.map((ex, exIdx) => (
        <AskExchangeCard key={exIdx} ex={ex} />
      ))}

      {history.length === 0 && (
        <div className="proposal-note">
          <span>💡</span>
          <div>
            <b>Supported instruments:</b>
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--desk-text-2)' }}>
              Any NSE-listed stock (RELIANCE, KHADIM, TCS, MRPL, …) · index (NIFTY, BANKNIFTY, SENSEX, INDIAVIX) · commodity (GOLD, CRUDE, XAUUSD) · currency (USDINR, DXY).
              <br />
              <b>The engine reads live quote when the cash market is open (09:15-15:30 IST); falls back to last close otherwise.</b>
              <br />
              <b>Every answer is real-time</b> — nothing cached, nothing pre-computed.
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function AskExchangeCard({ ex }: { ex: AskExchange }): JSX.Element {
  const columns: SortableColumn<any>[] = [
    { key: 'symbol', accessor: r => r.symbol },
    { key: 'bias', accessor: r => r.compositeBias ?? '' },
    { key: 'score', accessor: r => r.compositeScore ?? 0 },
    { key: 'ltp', accessor: r => r.ltp ?? 0 },
    { key: 'change', accessor: r => r.changePct ?? 0 },
    { key: 'ret5d', accessor: r => r.ret5dPct ?? 0 },
    { key: 'rsi', accessor: r => r.rsi14 ?? 0 },
    { key: 'vol', accessor: r => r.volRatio5_20 ?? 0 },
    { key: 'distHigh', accessor: r => r.distFromHigh20Pct ?? 0 },
  ]
  const { sortedRows, sort, onSort } = useSortable(ex.rows, { key: 'score', dir: 'desc' }, columns)

  return (
    <div style={{ background: 'var(--desk-surface)', border: '1px solid var(--desk-border)', borderRadius: 12, padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--desk-accent)', fontWeight: 600 }}>You asked</span>
        <span style={{ fontSize: 13, color: 'var(--desk-text)', fontStyle: 'italic' }}>"{ex.q}"</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: 'var(--desk-text-3)' }}>{new Date(ex.ts).toLocaleTimeString('en-IN')}</span>
      </div>
      {ex.parsed.length > 0 && (
        <div style={{ marginBottom: 12, fontSize: 11.5, color: 'var(--desk-text-2)' }}>
          Parsed <b>{ex.parsed.length}</b> symbol{ex.parsed.length !== 1 ? 's' : ''}:
          {ex.parsed.map(s => (
            <span key={s} style={{ marginLeft: 6, padding: '2px 8px', background: 'var(--desk-accent-bg)', color: 'var(--desk-accent)', borderRadius: 3, fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 600 }}>{s}</span>
          ))}
        </div>
      )}
      {ex.busy && <div style={{ color: 'var(--desk-text-3)', fontSize: 12 }}>⚡ Scanning live…</div>}
      {ex.error && <div style={{ color: 'var(--desk-bear)', fontSize: 12 }}>{ex.error}</div>}
      {ex.rows.length > 0 && (
        <div className="desk-table-card" style={{ borderColor: 'var(--desk-border)' }}>
          <div className="desk-table-x">
            <table className="desk-grid">
              <thead>
                <tr>
                  <SortableTh label="Symbol" sortKey="symbol" currentKey={sort.key} dir={sort.dir} onSort={onSort} />
                  <SortableTh label="Bias" sortKey="bias" currentKey={sort.key} dir={sort.dir} onSort={onSort} />
                  <SortableTh label="Score" sortKey="score" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
                  <SortableTh label="LTP" sortKey="ltp" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
                  <SortableTh label="Chg%" sortKey="change" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
                  <SortableTh label="5d %" sortKey="ret5d" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
                  <SortableTh label="RSI" sortKey="rsi" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
                  <SortableTh label="Vol×" sortKey="vol" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
                  <SortableTh label="Off Hi" sortKey="distHigh" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
                  <th>Trade Plan</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r: any, i: number) => (
                  <ScanRow key={r.symbol + i} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function ScanRow({ r }: { r: any }): JSX.Element {
  if (!r.ok) {
    return (
      <tr>
        <td><div className="sym-stack"><div className="sym-line">{r.symbol}</div></div></td>
        <td colSpan={10} style={{ color: 'var(--desk-text-3)', fontSize: 11.5 }}>error: {r.error ?? 'unknown'}</td>
      </tr>
    )
  }
  const biasColor = r.compositeBias === 'BULLISH' ? 'var(--desk-bull)' : r.compositeBias === 'BEARISH' ? 'var(--desk-bear)' : 'var(--desk-text-2)'
  return (
    <tr>
      <td><div className="sym-stack"><div className="sym-line">{r.symbol}</div><div className="src-line"><span className="src-mini">{r.emaStack}</span></div></div></td>
      <td><span style={{ color: biasColor, fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em' }}>{r.compositeBias}</span></td>
      <td className="r-right"><span className={`conv-badge ${r.compositeScore < 60 ? 'mid' : ''}`}>{r.compositeScore}</span></td>
      <td className="r-right mono" style={{ fontSize: 12.5 }}>{r.ltp?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
      <td className="r-right mono" style={{ fontSize: 11.5, color: r.changePct >= 0 ? 'var(--desk-bull)' : 'var(--desk-bear)' }}>{r.changePct >= 0 ? '+' : ''}{r.changePct?.toFixed(2)}%</td>
      <td className="r-right mono" style={{ fontSize: 11.5, color: r.ret5dPct >= 0 ? 'var(--desk-bull)' : 'var(--desk-bear)' }}>{r.ret5dPct >= 0 ? '+' : ''}{r.ret5dPct?.toFixed(1)}%</td>
      <td className="r-right mono" style={{ fontSize: 11.5 }}>{r.rsi14?.toFixed(0)}</td>
      <td className="r-right mono" style={{ fontSize: 11.5 }}>{r.volRatio5_20?.toFixed(1)}×</td>
      <td className="r-right mono" style={{ fontSize: 11.5 }}>−{r.distFromHigh20Pct?.toFixed(1)}%</td>
      <td>
        {r.entry ? (
          <div className="plan-mini" style={{ gridTemplateColumns: 'auto auto auto' }}>
            <span className="lbl">Entry</span><span className="val">{fmtRupee(r.entry)}</span><span className="date">{fmtDateShort(r.entryDate)}</span>
            <span className="lbl">SL</span><span className="val bear">{fmtRupee(r.stopLoss)}</span><span className="date">{fmtDateShort(r.slDate)}</span>
            <span className="lbl">T1</span><span className="val bull">{fmtRupee(r.target1)}</span><span className="date">{fmtDateShort(r.target1Date)}</span>
            <span className="lbl">T2</span><span className="val bull">{fmtRupee(r.target2)}</span><span className="date">{fmtDateShort(r.target2Date)}</span>
            <span className="lbl">T3</span><span className="val bull">{fmtRupee(r.target3)}</span><span className="date">{fmtDateShort(r.target3Date)}</span>
          </div>
        ) : <span style={{ color: 'var(--desk-text-3)', fontSize: 11 }}>—</span>}
      </td>
      <td><div className="why-cell">{r.unifiedReason || (r.reasoning || []).join(' · ')}</div></td>
    </tr>
  )
}

// ─── Shared simple table (Harmonic / Elliott) ───────────────────────
function SimpleTable({ rows: rawRows, emptyMsg }: { rows: any[]; emptyMsg: string }): JSX.Element {
  const q = useSearchQuery()
  const searched = useMemo(() => rawRows.filter(r => matchesQuery(r, q)), [rawRows, q])
  const columns: SortableColumn<any>[] = [
    { key: 'symbol', accessor: r => r.symbol ?? r.instrument ?? '' },
    { key: 'direction', accessor: r => r.direction ?? '' },
    { key: 'score', accessor: r => r.score ?? r.conviction ?? 0 },
    { key: 'ltp', accessor: r => r.ltp ?? r.entry ?? 0 },
    { key: 'target1', accessor: r => r.target1 ?? 0 },
    { key: 'entry', accessor: r => r.entry ?? 0 },
  ]
  const { sortedRows, sort, onSort } = useSortable(searched, { key: 'score', dir: 'desc' }, columns)
  const [pageSize, setPageSize] = useState(50)
  const visible = sortedRows.slice(0, pageSize)
  return (
    <div className="desk-table-card">
      <div className="desk-table-x">
        <table className="desk-grid">
          <colgroup>
            <col className="w-symbol" /><col className="w-status" /><col className="w-conv" />
            <col className="w-ltp" /><col className="w-plan" /><col className="w-horizon" /><col className="w-why" />
          </colgroup>
          <thead>
            <tr>
              <SortableTh label="Symbol · Source" sortKey="symbol" currentKey={sort.key} dir={sort.dir} onSort={onSort} />
              <SortableTh label="Dir · Status" sortKey="direction" currentKey={sort.key} dir={sort.dir} onSort={onSort} />
              <SortableTh label="Score" sortKey="score" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
              <SortableTh label="LTP" sortKey="ltp" currentKey={sort.key} dir={sort.dir} onSort={onSort} className="r-right" />
              <th>Trade Plan</th>
              <th>Horizon</th>
              <th>Why</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={(r.symbol ?? '') + i}>
                <td><div className="sym-stack"><div className="sym-line">{r.symbol ?? r.instrument}</div><div className="src-line"><span className="src-mini">{r.source ?? '—'}</span></div></div></td>
                <td>
                  <div className="status-stack">
                    <span className={`dir-pill ${r.direction === 'SHORT' ? 'sell' : 'buy'}`}>{r.direction === 'SHORT' ? 'SELL' : 'BUY'}</span>
                    <span className={`status-tag ${r.status === 'T1_HIT' || r.status === 'T2_HIT' || r.status === 'T3_HIT' ? 't1-hit' : r.status === 'SL_HIT' ? 'sl-hit' : r.status === 'ACTIVE' ? 'live' : 'waiting'}`}>
                      {r.status ?? '—'}
                    </span>
                  </div>
                </td>
                <td className="r-right"><span className={`conv-badge ${(r.score ?? 0) < 8 ? 'mid' : ''}`}>{r.score ?? '—'}</span></td>
                <td className="r-right"><div className="stack-2"><span className="l1">{fmtRupee(r.ltp ?? r.entry)}</span></div></td>
                <td>
                  <div className="plan-mini">
                    <span className="lbl">Entry</span><span className="val">{fmtRupee(r.entry)}</span><span className="pct"></span><span className="date">{fmtDateShort(r.entryDate)}</span>
                    <span className="lbl">SL</span><span className="val bear">{fmtRupee(r.stopLoss)}</span><span className="pct bear">SL</span><span className="date">{fmtDateShort(r.slDate)}</span>
                    <span className="lbl">T1</span><span className="val bull">{fmtRupee(r.target1)}</span><span className="pct bull">{fmtPct(r.entry, r.target1, r.direction ?? 'BUY')}</span><span className="date">{fmtDateShort(r.target1Date)}</span>
                    <span className="lbl">T2</span><span className="val bull">{fmtRupee(r.target2)}</span><span className="pct bull">{fmtPct(r.entry, r.target2, r.direction ?? 'BUY')}</span><span className="date">{fmtDateShort(r.target2Date)}</span>
                    <span className="lbl">T3</span><span className="val bull">{fmtRupee(r.target3)}</span><span className="pct bull">{fmtPct(r.entry, r.target3, r.direction ?? 'BUY')}</span><span className="date">{fmtDateShort(r.target3Date)}</span>
                  </div>
                </td>
                <td>
                  <div className="horiz-cell">
                    <span className="h-days">{daysFromNow(r.target3Date)}</span>
                    <div className="h-bar"><div className="h-bar-fill" style={{ transform: 'scaleX(0.1)' }} /></div>
                    <span className="h-when">to {fmtDateShort(r.target3Date)}</span>
                  </div>
                </td>
                <td><div className="why-cell">{pickReason(r) || r.notes || '—'}</div></td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--desk-text-3)', padding: '48px 20px' }}>{emptyMsg}</td></tr>
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
  )
}
