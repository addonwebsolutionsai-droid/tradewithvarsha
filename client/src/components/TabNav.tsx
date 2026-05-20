import clsx from 'clsx'
import { useState, useRef, useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, BarChart3, Bot, Brain, Briefcase, Clock, FlaskConical, LayoutDashboard,
  Layers, ListChecks, MessageSquare, MoreVertical, Rocket, Settings, Star, Target,
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsRef = useRef<HTMLDivElement>(null)

  // Close settings dropdown on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [])

  const investmentSubs: SubItem[] = [
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
  const tops = PUBLIC_MODE ? [
    { to: '/top-trades',  label: 'Top Trades',  icon: <Target size={14} /> },
    { to: '/weekly-pick', label: 'Weekly Pick', icon: <Briefcase size={14} /> },
    { to: '/daily-pick',  label: 'Daily Pick',  icon: <Bot size={14} /> },
    { to: '/pre-move',    label: 'Pre-Move',    icon: <Wind size={14} /> },
    { to: '/options',     label: 'Options',     icon: <Layers size={14} />, count: (counts.options ?? 0) + (counts.futures ?? 0) },
    { to: '/intraday',    label: 'Intraday',    icon: <Activity size={14} />, count: counts.intraday },
    { to: '/track-record', label: 'Track Record', icon: <ListChecks size={14} /> },
  ] : [
    { to: '/',          label: 'Dashboard',   icon: <LayoutDashboard size={14} /> },
    { to: '/signals',   label: 'All Signals', icon: <Zap size={14} />, count: counts.all },
    { to: '/intraday',  label: 'Intraday',    icon: <Activity size={14} />, count: counts.intraday },
    { to: '/options',   label: 'Options',     icon: <Layers size={14} />, count: (counts.options ?? 0) + (counts.futures ?? 0) },
    { to: '/investment', label: 'Investment', icon: <Target size={14} />, isParent: true },
    { to: '/gann',      label: 'Gann Cycle',  icon: <Star size={14} /> },
    { to: '/timecycle', label: 'Time Cycle',  icon: <Clock size={14} /> },
    { to: '/harmonic',  label: 'Harmonic',    icon: <Triangle size={14} /> },
    { to: '/turtle-soup', label: 'Turtle Soup', icon: <Wind size={14} /> },
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

        {/* Settings dropdown — pinned right, outside the scroll area.
            Hidden in PUBLIC_MODE (those routes redirect on Vercel). */}
        {!PUBLIC_MODE && (
          <div className="relative flex-shrink-0 border-l border-ink-500" ref={settingsRef}>
            <button
              onClick={() => setSettingsOpen(o => !o)}
              className="h-full px-3 text-[13px] flex items-center gap-1 text-neutral-500 hover:text-neutral-300"
              title="More tabs (Bot · Learning · Backtest · Commodity)"
            >
              <MoreVertical size={14} />
            </button>
            {settingsOpen && (
              <div className="absolute right-0 top-full mt-1 w-52 bg-ink-700 border border-ink-500 rounded-lg shadow-xl z-50 overflow-hidden">
                <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-neutral-600 border-b border-ink-500">More</div>
                <SettingsItem to="/commodity" icon={<TrendingUp size={12} />} label="Gold/Crude" onClick={() => setSettingsOpen(false)} />
                <SettingsItem to="/backtest" icon={<BarChart3 size={12} />} label="Backtest" onClick={() => setSettingsOpen(false)} />
                <SettingsItem to="/learning" icon={<FlaskConical size={12} />} label="Learning" onClick={() => setSettingsOpen(false)} />
                <SettingsItem to="/bot"      icon={<MessageSquare size={12} />} label="Bot Status" onClick={() => setSettingsOpen(false)} />
                <SettingsItem to="/preview"  icon={<Settings size={12} />} label="Preview Theme" onClick={() => setSettingsOpen(false)} />
              </div>
            )}
          </div>
        )}
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

function SettingsItem({ to, icon, label, onClick }: { to: string; icon: React.ReactNode; label: string; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-300 hover:bg-ink-600"
    >
      <span className="text-neutral-500">{icon}</span>
      {label}
    </NavLink>
  )
}
