import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useStore } from '../store'
import {
  ArrowUpRight, ArrowDownRight, TrendingUp, Activity, Briefcase, Zap,
  Bot, Clock, DollarSign, Target, Wind, BarChart3, ArrowRight, Search,
  Bell, Menu, LayoutDashboard, Settings, User, ChevronRight,
} from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * /preview — clean light-theme dashboard mockup.
 *
 * Completely isolated from the production dashboard (/). Only this page
 * uses these styles; if the user wants to roll back, we just remove the
 * route. No changes to shared components/theme system.
 *
 * Inspired by the Specie admin template — airy whitespace, flat cards,
 * soft shadows, muted slate palette, Inter-like type. Uses Tailwind
 * arbitrary values + explicit hex so it doesn't pick up the global
 * dark-ink tokens.
 */

const PAGE_BG = '#F4F7FA'
const CARD_BG = '#FFFFFF'
const BORDER   = '#E2E8F0'
const TEXT     = '#0F172A'
const MUTED    = '#64748B'
const MUTED_2  = '#94A3B8'
const ACCENT   = '#2563EB'        // blue-600
const GREEN    = '#16A34A'
const RED      = '#DC2626'
const AMBER    = '#F59E0B'
const VIOLET   = '#7C3AED'
const CYAN     = '#0891B2'

export function PreviewDashboard() {
  // Force light theme while on this page; restore on unmount so the rest of
  // the app stays on whatever the user had.
  useEffect(() => {
    const prev = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = 'light'
    return () => { if (prev) document.documentElement.dataset.theme = prev }
  }, [])

  const signals = useStore(s => s.signals)

  const dailyPick = useQuery<any>({
    queryKey: ['daily-pick'],
    queryFn: async () => {
      const r = await fetch('/api/daily-pick')
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json()
    },
    staleTime: 60_000, refetchInterval: 60_000,
  })

  const regime = useQuery<any>({
    queryKey: ['regime'],
    queryFn: async () => (await fetch('/api/regime')).json(),
    staleTime: 5 * 60_000,
  })

  const perf = useQuery<any>({
    queryKey: ['perf-stats'],
    queryFn: async () => (await fetch('/api/log/stats')).json(),
    staleTime: 60_000,
  })

  const movers = useQuery<any>({
    queryKey: ['screener', '/api/scan/movers'],
    queryFn: async () => (await fetch('/api/scan/movers')).json(),
    staleTime: 5 * 60_000,
  })

  const gradeACount = signals.filter(s => s.grade === 'A').length
  const liveCount   = signals.filter(s => (s.tier ?? 'LIVE') === 'LIVE').length
  const topBuys     = signals.filter(s => s.direction === 'BUY' && s.grade === 'A' && (s.tier ?? 'LIVE') === 'LIVE').slice(0, 5)
  const topShorts   = signals.filter(s => s.direction === 'SELL' && s.grade === 'A' && (s.tier ?? 'LIVE') === 'LIVE').slice(0, 5)
  const dpRows      = (dailyPick.data?.rows ?? []).slice(0, 6)
  const moverRows   = (movers.data?.results ?? []).slice(0, 6)

  return (
    <div
      className="-m-5 xl:-mr-[320px] min-h-screen"
      style={{ background: PAGE_BG, color: TEXT, fontFamily: 'Inter, system-ui, -apple-system, sans-serif' }}
    >
      <div className="flex">
        {/* ── Sidebar ─────────────────────────────────── */}
        <aside
          className="hidden lg:block w-[240px] flex-shrink-0 py-6 px-4"
          style={{ background: CARD_BG, borderRight: `1px solid ${BORDER}`, minHeight: '100vh' }}
        >
          <div className="px-3 mb-8 flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold" style={{ background: ACCENT }}>
              HF
            </div>
            <div>
              <div className="font-bold text-sm" style={{ color: TEXT }}>Tradewithvarsha</div>
              <div className="text-[10px]" style={{ color: MUTED }}>Preview · Light</div>
            </div>
          </div>
          <SideSection title="Trading">
            <SideItem icon={<LayoutDashboard size={14} />} label="Dashboard" to="/preview" active />
            <SideItem icon={<Zap size={14} />} label="All Signals" to="/signals" count={signals.length} />
            <SideItem icon={<Activity size={14} />} label="Intraday" to="/intraday" />
            <SideItem icon={<BarChart3 size={14} />} label="F&O" to="/options" />
            <SideItem icon={<TrendingUp size={14} />} label="Swing" to="/swing" />
          </SideSection>
          <SideSection title="Picks">
            <SideItem icon={<Bot size={14} />} label="Daily Pick" to="/daily" />
            <SideItem icon={<Briefcase size={14} />} label="Weekly Pick" to="/weekly" />
            <SideItem icon={<Target size={14} />} label="Pro Screener" to="/pro" />
          </SideSection>
          <SideSection title="Discover">
            <SideItem icon={<TrendingUp size={14} />} label="Movers" to="/movers" />
            <SideItem icon={<Wind size={14} />} label="Pre-Move" to="/premove" />
            <SideItem icon={<DollarSign size={14} />} label="Money Flow" to="/moneyflow" />
          </SideSection>
          <SideSection title="System">
            <SideItem icon={<BarChart3 size={14} />} label="Backtest" to="/backtest" />
            <SideItem icon={<Settings size={14} />} label="Learning" to="/learning" />
          </SideSection>
          <div className="mt-6 mx-3 p-3 rounded-lg" style={{ background: '#EFF6FF', border: `1px solid #DBEAFE` }}>
            <div className="text-[11px] font-semibold" style={{ color: ACCENT }}>💡 Preview mode</div>
            <div className="text-[10px] mt-0.5" style={{ color: MUTED }}>
              New clean design. <Link to="/" className="underline font-medium">Back to production →</Link>
            </div>
          </div>
        </aside>

        {/* ── Main ────────────────────────────────────── */}
        <main className="flex-1 min-w-0">
          {/* Topbar */}
          <div
            className="flex items-center justify-between px-6 py-4 sticky top-0 z-10"
            style={{ background: CARD_BG, borderBottom: `1px solid ${BORDER}` }}
          >
            <div className="flex items-center gap-3">
              <Menu size={18} className="lg:hidden" style={{ color: MUTED }} />
              <div>
                <div className="text-lg font-semibold" style={{ color: TEXT }}>Dashboard</div>
                <div className="text-[11px]" style={{ color: MUTED_2 }}>
                  Welcome back · {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: PAGE_BG, border: `1px solid ${BORDER}`, minWidth: 240 }}>
                <Search size={14} style={{ color: MUTED }} />
                <span className="text-xs" style={{ color: MUTED }}>Search any stock…</span>
                <kbd className="ml-auto text-[9px] px-1.5 py-0.5 rounded" style={{ background: CARD_BG, border: `1px solid ${BORDER}`, color: MUTED_2 }}>⌘K</kbd>
              </div>
              <Bell size={16} style={{ color: MUTED }} />
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-white font-medium text-xs" style={{ background: VIOLET }}>
                <User size={14} />
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="p-6 space-y-6">
            {/* KPI row */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KPI
                label="Market regime"
                value={regime.data?.regime ?? '—'}
                accent={regime.data?.regime === 'BULL' ? GREEN : regime.data?.regime === 'BEAR' ? RED : AMBER}
                sub={`${regime.data?.greenCount ?? 0}/${regime.data?.checklist?.length ?? 5} checks green`}
                icon={<TrendingUp size={16} />}
              />
              <KPI
                label="Live signals"
                value={String(liveCount)}
                accent={ACCENT}
                sub={`${gradeACount} grade A · ${signals.length} loaded`}
                icon={<Zap size={16} />}
              />
              <KPI
                label="VIX"
                value={regime.data?.vix != null ? regime.data.vix.toFixed(2) : '—'}
                accent={regime.data?.vix > 20 ? RED : regime.data?.vix > 16 ? AMBER : GREEN}
                sub="Volatility index"
                icon={<Activity size={16} />}
              />
              <KPI
                label="Realised P&L"
                value={perf.data && perf.data.closedSignals > 0 ? `${perf.data.winRatePct}%` : '—'}
                accent={perf.data?.winRatePct >= 80 ? GREEN : perf.data?.winRatePct >= 60 ? AMBER : MUTED}
                sub={`${perf.data?.wins ?? 0}W / ${perf.data?.losses ?? 0}L (100 qty)`}
                icon={<DollarSign size={16} />}
              />
            </div>

            {/* Top picks + Daily pick row */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <Card
                title="🚀 Top BUY signals"
                sub={`${topBuys.length} Grade A setups`}
                accent={GREEN}
                action={{ label: 'View all', to: '/signals' }}
                className="xl:col-span-1"
              >
                {topBuys.length === 0
                  ? <EmptyState label="No Grade A BUY setups right now" />
                  : topBuys.map(s => <SignalRowLight key={s.id} signal={s} />)}
              </Card>

              <Card
                title="📉 Top SELL signals"
                sub={`${topShorts.length} Grade A setups`}
                accent={RED}
                action={{ label: 'View all', to: '/signals' }}
                className="xl:col-span-1"
              >
                {topShorts.length === 0
                  ? <EmptyState label="No Grade A SELL setups right now" />
                  : topShorts.map(s => <SignalRowLight key={s.id} signal={s} />)}
              </Card>

              <Card
                title="🤖 Daily Pick"
                sub={dailyPick.data ? `${dailyPick.data.rows.length} picks · ${dailyPick.data.newSinceLastRun?.length ?? 0} new` : 'Loading…'}
                accent={CYAN}
                action={{ label: 'Full pick →', to: '/daily' }}
              >
                {dpRows.length === 0
                  ? <EmptyState label="Awaiting first scan…" />
                  : dpRows.map((r: any) => (
                    <div key={r.symbol} className="flex items-center justify-between py-2" style={{ borderBottom: `1px solid ${BORDER}` }}>
                      <div className="flex items-center gap-2">
                        <span
                          className="px-1.5 py-0.5 rounded text-[9px] font-bold w-12 text-center"
                          style={{
                            background: r.direction === 'BUY' ? '#DCFCE7' : '#FEE2E2',
                            color: r.direction === 'BUY' ? GREEN : RED,
                          }}
                        >
                          {r.direction}
                        </span>
                        <span className="text-sm font-semibold" style={{ color: TEXT }}>{r.symbol}</span>
                        <span className="text-[10px]" style={{ color: MUTED_2 }}>{r.pattern.toLowerCase()}</span>
                      </div>
                      <div className="text-right">
                        <div className="text-xs font-mono font-medium" style={{ color: TEXT }}>₹{r.ltp.toFixed(2)}</div>
                        <div className="text-[10px]" style={{ color: ACCENT }}>{r.conviction}/100</div>
                      </div>
                    </div>
                  ))}
              </Card>
            </div>

            {/* Movers + Regime bottom row */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <Card
                title="📈 Weekly Movers"
                sub={`${movers.data?.results?.length ?? 0} setups ≥ 5% (5-day change)`}
                accent={VIOLET}
                action={{ label: 'All movers →', to: '/movers' }}
              >
                {moverRows.length === 0
                  ? <EmptyState label="Scan in progress…" />
                  : moverRows.map((r: any) => (
                    <div key={r.symbol + r.setupKind} className="flex items-center justify-between py-2" style={{ borderBottom: `1px solid ${BORDER}` }}>
                      <div className="flex items-center gap-2">
                        {r.direction === 'BULL'
                          ? <ArrowUpRight size={14} style={{ color: GREEN }} />
                          : <ArrowDownRight size={14} style={{ color: RED }} />}
                        <span className="text-sm font-semibold" style={{ color: TEXT }}>{r.symbol}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: PAGE_BG, color: MUTED }}>
                          tier {r.tier}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-xs font-mono" style={{ color: TEXT }}>₹{r.price.toFixed(2)}</div>
                        <div
                          className="text-[11px] font-semibold font-mono"
                          style={{ color: r.changePct >= 0 ? GREEN : RED }}
                        >
                          {r.changePct >= 0 ? '+' : ''}{r.changePct?.toFixed(1)}%
                        </div>
                      </div>
                    </div>
                  ))}
              </Card>

              <Card
                title="🎯 Market Regime Checklist"
                sub={regime.data?.recommendation ?? 'Computing…'}
                accent={regime.data?.regime === 'BULL' ? GREEN : regime.data?.regime === 'BEAR' ? RED : AMBER}
              >
                {(regime.data?.checklist ?? []).map((c: any) => (
                  <div key={c.name} className="flex items-center justify-between py-2" style={{ borderBottom: `1px solid ${BORDER}` }}>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-5 h-5 rounded-full flex items-center justify-center"
                        style={{ background: c.ok ? '#DCFCE7' : '#FEE2E2', color: c.ok ? GREEN : RED }}
                      >
                        {c.ok ? '✓' : '✗'}
                      </div>
                      <span className="text-sm" style={{ color: TEXT }}>{c.name}</span>
                    </div>
                    <div className="text-xs font-mono" style={{ color: MUTED }}>{c.note}</div>
                  </div>
                ))}
              </Card>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-4 pb-10">
              <div className="text-[11px]" style={{ color: MUTED_2 }}>
                Preview dashboard · built for review. Production is at <Link to="/" className="font-medium" style={{ color: ACCENT }}>/</Link>.
              </div>
              <div className="flex items-center gap-4 text-[11px]" style={{ color: MUTED_2 }}>
                <Clock size={12} className="inline mr-1" />
                {new Date().toLocaleTimeString('en-IN')}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────

function SideSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="px-3 text-[10px] font-semibold tracking-wider uppercase" style={{ color: MUTED_2 }}>{title}</div>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function SideItem({ icon, label, to, count, active }: { icon: ReactNode; label: string; to: string; count?: number; active?: boolean }) {
  return (
    <Link to={to}
      className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
      style={{
        background: active ? '#EFF6FF' : 'transparent',
        color: active ? ACCENT : TEXT,
        fontWeight: active ? 600 : 500,
      }}
    >
      <span style={{ color: active ? ACCENT : MUTED }}>{icon}</span>
      <span>{label}</span>
      {count != null && count > 0 && (
        <span
          className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium"
          style={{
            background: active ? ACCENT : PAGE_BG,
            color: active ? CARD_BG : MUTED,
          }}
        >{count}</span>
      )}
    </Link>
  )
}

function KPI({ label, value, accent, sub, icon }: { label: string; value: string; accent: string; sub: string; icon: ReactNode }) {
  return (
    <div
      className="p-5 rounded-xl"
      style={{ background: CARD_BG, border: `1px solid ${BORDER}`, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}
    >
      <div className="flex items-start justify-between">
        <div className="text-[11px] font-medium uppercase tracking-wider" style={{ color: MUTED }}>{label}</div>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${accent}14`, color: accent }}>
          {icon}
        </div>
      </div>
      <div className="text-2xl font-bold mt-3 font-mono" style={{ color: accent }}>{value}</div>
      <div className="text-[11px] mt-1" style={{ color: MUTED }}>{sub}</div>
    </div>
  )
}

function Card({
  title, sub, accent, action, children, className,
}: {
  title: string; sub: string; accent: string
  action?: { label: string; to: string }
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={className ?? ''}
      style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}
    >
      <div
        className="px-5 py-3 flex items-center justify-between"
        style={{ borderBottom: `1px solid ${BORDER}` }}
      >
        <div>
          <div className="text-sm font-semibold" style={{ color: TEXT }}>{title}</div>
          <div className="text-[11px]" style={{ color: MUTED }}>{sub}</div>
        </div>
        {action && (
          <Link to={action.to} className="flex items-center gap-1 text-[11px] font-medium" style={{ color: accent }}>
            {action.label} <ChevronRight size={12} />
          </Link>
        )}
      </div>
      <div className="px-5 py-2">{children}</div>
    </div>
  )
}

function SignalRowLight({ signal }: { signal: any }) {
  const isBuy = signal.direction === 'BUY'
  return (
    <div className="flex items-center justify-between py-2" style={{ borderBottom: `1px solid ${BORDER}` }}>
      <div className="flex items-center gap-2 min-w-0">
        <span
          className="px-1.5 py-0.5 rounded text-[9px] font-bold w-12 text-center flex-shrink-0"
          style={{
            background: isBuy ? '#DCFCE7' : '#FEE2E2',
            color: isBuy ? GREEN : RED,
          }}
        >
          {signal.direction}
        </span>
        <div className="min-w-0">
          <div className="text-sm font-semibold truncate" style={{ color: TEXT }}>{signal.instrument}</div>
          <div className="text-[10px]" style={{ color: MUTED_2 }}>{signal.type} · {signal.source}</div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-xs font-mono font-medium" style={{ color: TEXT }}>₹{signal.entry}</div>
        <div className="text-[10px]" style={{ color: ACCENT }}>{signal.grade} · {signal.score}/10</div>
      </div>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="py-8 text-center text-xs" style={{ color: MUTED_2 }}>{label}</div>
  )
}
