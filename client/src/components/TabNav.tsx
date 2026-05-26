import clsx from 'clsx'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, BarChart3, Bot, Brain, Briefcase, Clock, LayoutDashboard,
  Layers, ListChecks, Rocket, Star, Target,
  TrendingUp, Wind, Zap, ChevronDown, ClipboardList, Triangle,
} from 'lucide-react'

/**
 * Top-level navigation — 6 sections.
 *
 * 1. Dashboard      → /
 * 2. All Signals    → /signals
 * 3. Intraday       → /intraday
 * 4. Investment ▾   → opens to sub-nav below the top row
 *      Symbols · Swings · F&O · Daily Pick · Weekly Pick ·
 *      Swing Scans · Multibagger · Pre-Move · Movers · Pro Screener
 * 5. Gann Cycle     → /gann
 * 6. Time Cycle     → /timecycle
 *
 * Settings dropdown (right side) holds: Bot · Learning · Backtest · Commodity
 * — these are meta / utility tabs that don't need to live on the top row.
 */

interface SubItem { to: string; label: string; icon: React.ReactNode; count?: number }

export function TabNav({ counts }: { counts: Record<string, number> }) {
  const location = useLocation()
  const navigate = useNavigate()

  const investmentSubs: SubItem[] = [
    { to: '/5-20-move',              label: '5–20% Move',   icon: <Rocket size={12} /> },
    { to: '/investment/symbols',     label: 'Symbols',      icon: <ListChecks size={12} /> },
    { to: '/investment/swings',      label: 'Swings',       icon: <TrendingUp size={12} />, count: counts.swing },
    { to: '/investment/fno',         label: 'F&O',          icon: <BarChart3 size={12} />, count: (counts.options ?? 0) + (counts.futures ?? 0) },
    { to: '/investment/daily-pick',  label: 'Daily Pick',   icon: <Bot size={12} /> },
    { to: '/investment/weekly-pick', label: 'Weekly Pick',  icon: <Briefcase size={12} /> },
    { to: '/investment/swing-scans', label: 'Swing Scans',  icon: <TrendingUp size={12} /> },
    { to: '/investment/multibagger', label: 'Multibagger',  icon: <Rocket size={12} /> },
    { to: '/investment/premove',     label: 'Pre-Move',     icon: <Wind size={12} /> },
    { to: '/investment/movers',      label: 'Movers',       icon: <TrendingUp size={12} /> },
    { to: '/investment/pro',         label: 'Pro Screener', icon: <Brain size={12} /> },
  ]

  // 2026-05-07: PUBLIC_MODE — Vercel deploy shows only 3 tabs: Weekly Pick,
  // Options, Intraday. Other tabs are NOT rendered (no DOM presence at all,
  // not just CSS-hidden). The route gate in App.tsx redirects any direct URL
  // navigation to /weekly-pick.
  const PUBLIC_MODE = (import.meta as any).env?.VITE_PUBLIC_MODE === 'true'
  // 2026-05-21: Track Record promoted to position #2 (right after Top Trades)
  // so it's visible on narrow viewports without horizontal scroll. User
  // couldn't find it on Vercel when it was at position #7. Badge "NEW" for
  // discoverability — public users land on Top Trades and immediately see
  // Track Record next to it for outcome verification.
  // 2026-05-25: Intraday tab REMOVED — live lifecycle WR 28.6% (7 closed,
  // 5 SL). Engine dropped from signalEngine.ts strategy lists. Page still
  // exists in code but no longer in nav → no user confusion.
  const tops = PUBLIC_MODE ? [
    { to: '/top-trades',   label: 'Top Trades',   icon: <Target size={14} /> },
    { to: '/5-20-move',    label: '5–20% Move',   icon: <Rocket size={14} />, badge: 'NEW' },
    { to: '/track-record', label: 'Track Record', icon: <ListChecks size={14} /> },
    { to: '/weekly-pick',  label: 'Weekly Pick',  icon: <Briefcase size={14} /> },
    { to: '/daily-pick',   label: 'Daily Pick',   icon: <Bot size={14} /> },
    { to: '/pre-move',     label: 'Pre-Move',     icon: <Wind size={14} /> },
    { to: '/options',      label: 'Options',      icon: <Layers size={14} />, count: (counts.options ?? 0) + (counts.futures ?? 0) },
  ] : [
    // 2026-05-25: Niche tabs (Gann / TimeCycle / Harmonic / Turtle Soup) moved
    // INTO the More dropdown — last-14-days lifecycle audit showed zero closed
    // signals from these sources. Top bar now focused on the primary workflow.
    { to: '/',          label: 'Dashboard',   icon: <LayoutDashboard size={14} /> },
    { to: '/5-20-move', label: '5–20% Move',  icon: <Rocket size={14} />, badge: 'NEW' },
    { to: '/track-record', label: 'Track Record', icon: <ListChecks size={14} /> },
    { to: '/signals',   label: 'All Signals', icon: <Zap size={14} />, count: counts.all },
    { to: '/options',   label: 'Options',     icon: <Layers size={14} />, count: (counts.options ?? 0) + (counts.futures ?? 0) },
    { to: '/investment', label: 'Investment', icon: <Target size={14} />, isParent: true },
    { to: '/backtest-results', label: 'Backtest Results', icon: <ClipboardList size={14} /> },
  ]

  const onInvestment = location.pathname.startsWith('/investment')

  return (
    <>
      {/* 2026-05-20: Layout fix. Previously the 3-dot Settings dropdown was a
          child of the overflow-x-auto <nav>, with ml-auto. In PUBLIC_MODE that
          consumed the spare row width and pushed the 7th tab (Track Record)
          off-screen. New layout: outer flex pins the settings to the right
          edge OUTSIDE the scroll area, so all tabs always show + the dropdown
          stays visible. Settings dropdown is also hidden entirely in PUBLIC_MODE
          since none of those routes (/commodity /backtest /learning /bot
          /preview) exist on the public Vercel build — they'd just redirect. */}
      <div className="flex items-stretch bg-ink-800 border-b border-ink-500">
        <nav
          className="flex items-center gap-0 overflow-x-auto px-3 flex-1 min-w-0"
          style={{ scrollbarWidth: 'thin' }}
        >
          {tops.map(t => {
            const active = t.to === '/'
              ? location.pathname === '/'
              : t.isParent
                ? onInvestment
                : location.pathname === t.to || location.pathname.startsWith(t.to + '/')
            return (
              <button
                key={t.to}
                onClick={() => {
                  if (t.isParent) navigate('/investment/symbols')
                  else navigate(t.to)
                }}
                className={clsx(
                  'px-3 py-2.5 text-[12px] flex items-center gap-1 whitespace-nowrap border-b-2 transition-colors flex-shrink-0',
                  active
                    ? 'text-accent-cyan border-accent-cyan'
                    : 'text-neutral-500 border-transparent hover:text-neutral-300',
                )}
              >
                {t.icon}
                {t.label}
                {t.isParent && <ChevronDown size={11} />}
                {(t as any).badge && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-accent-green text-ink-900 leading-none">
                    {(t as any).badge}
                  </span>
                )}
                {(t as any).count != null && (t as any).count > 0 && (
                  <span className={clsx(
                    'text-[10px] px-1.5 py-0.5 rounded-full',
                    active ? 'bg-accent-cyan/10 text-accent-cyan' : 'bg-ink-500 text-neutral-500',
                  )}>{(t as any).count}</span>
                )}
              </button>
            )
          })}
        </nav>

        {/* 2026-05-21: 3-dot Settings dropdown REMOVED. User reported it
            still rendering "weirdly" on Vercel (likely stale deploy serving
            old bundle, OR the dropdown items overflowing on narrow screens).
            The items it contained (/commodity /backtest /learning /bot
            /preview) are all admin-only — accessible by direct URL when
            needed but not user-facing. Track Record + the primary trading
            tabs are all now visible in the main nav row above. */}
      </div>

      {/* Sub-nav for Investment */}
      {onInvestment && (
        <nav className="flex gap-1 overflow-x-auto bg-ink-700 border-b border-ink-500 px-5">
          {investmentSubs.map(s => (
            <NavLink key={s.to} to={s.to}>
              {({ isActive }) => (
                <button className={clsx(
                  'px-3 py-2 text-[11px] flex items-center gap-1 whitespace-nowrap border-b-2 transition-colors',
                  isActive ? 'text-accent-cyan border-accent-cyan/60' : 'text-neutral-500 border-transparent hover:text-neutral-300',
                )}>
                  {s.icon}
                  {s.label}
                  {s.count != null && s.count > 0 && (
                    <span className={clsx(
                      'text-[9px] px-1.5 py-0.5 rounded-full',
                      isActive ? 'bg-accent-cyan/15 text-accent-cyan' : 'bg-ink-500 text-neutral-500',
                    )}>{s.count}</span>
                  )}
                </button>
              )}
            </NavLink>
          ))}
        </nav>
      )}
    </>
  )
}

// SettingsItem removed along with 3-dot dropdown (2026-05-21).
