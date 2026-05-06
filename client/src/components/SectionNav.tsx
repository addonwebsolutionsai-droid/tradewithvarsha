import clsx from 'clsx'
import { NavLink } from 'react-router-dom'
import {
  Activity, BarChart3, Bot, Brain, Briefcase, Compass, DollarSign,
  FlaskConical, MessageSquare, Rocket, Settings, Star, Target, TrendingUp,
  Wind, Zap,
} from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * Two-level tab system.
 *
 * Top-level (5 sections) groups by user intent — never more than 5 visible
 * at once so the eye can scan in a single sweep. Sub-level appears only when
 * inside that section, anchored under the top row.
 */

interface SubTab {
  to: string
  label: string
  icon: ReactNode
  count?: number
}

interface Section {
  to: string                    // base route, e.g. /picks
  label: string
  icon: ReactNode
  badge?: ReactNode             // optional small badge (e.g. live count of new picks)
  subs: SubTab[]
}

export const SECTIONS: Section[] = [
  {
    to: '/picks', label: 'Picks', icon: <Target size={15} />,
    subs: [
      { to: '/picks/daily',   label: 'Daily Pick',   icon: <Bot size={13} /> },
      { to: '/picks/weekly',  label: 'Weekly Pick',  icon: <Briefcase size={13} /> },
      { to: '/picks/pro',     label: 'Pro Screener', icon: <Brain size={13} /> },
    ],
  },
  {
    to: '/signals', label: 'Signals', icon: <Zap size={15} />,
    subs: [
      { to: '/signals/all',       label: 'All',        icon: <Zap size={13} /> },
      { to: '/signals/intraday',  label: 'Intraday',   icon: <Activity size={13} /> },
      { to: '/signals/options',   label: 'Options OI', icon: <BarChart3 size={13} /> },
      { to: '/signals/swing',     label: 'Swing',      icon: <TrendingUp size={13} /> },
      { to: '/signals/commodity', label: 'Gold/Crude', icon: <TrendingUp size={13} /> },
    ],
  },
  {
    to: '/discover', label: 'Discover', icon: <Compass size={15} />,
    subs: [
      { to: '/discover/moneyflow',   label: 'Money Flow',  icon: <DollarSign size={13} /> },
      { to: '/discover/swingscan',   label: 'Swing Scans', icon: <TrendingUp size={13} /> },
      { to: '/discover/multibagger', label: 'Multibagger', icon: <Rocket size={13} /> },
      { to: '/discover/premove',     label: 'Pre-Move',    icon: <Wind size={13} /> },
      { to: '/discover/movers',      label: 'Movers',      icon: <TrendingUp size={13} /> },
    ],
  },
  {
    to: '/insights', label: 'Insights', icon: <Brain size={15} />,
    subs: [
      { to: '/insights/gann',     label: 'Gann/Astro', icon: <Star size={13} /> },
      { to: '/insights/backtest', label: 'Backtest',   icon: <BarChart3 size={13} /> },
      { to: '/insights/learning', label: 'Learning',   icon: <FlaskConical size={13} /> },
    ],
  },
  {
    to: '/system', label: 'System', icon: <Settings size={15} />,
    subs: [
      { to: '/system/bot', label: 'Bot', icon: <MessageSquare size={13} /> },
    ],
  },
]

/** Counts injected from store (signal counts per type) onto sub-tabs */
export function withCounts(sections: Section[], counts: Record<string, number>): Section[] {
  const map: Record<string, number> = {
    '/signals/all': counts.all,
    '/signals/intraday': counts.intraday,
    '/signals/options': counts.options,
    '/signals/swing': counts.swing,
    '/signals/commodity': counts.commodity,
  }
  return sections.map(s => ({
    ...s,
    subs: s.subs.map(t => map[t.to] != null ? { ...t, count: map[t.to] } : t),
  }))
}

export function SectionNav({ sections }: { sections: Section[] }) {
  return (
    <nav className="flex gap-1 overflow-x-auto bg-ink-800 border-b border-ink-500 px-5">
      {sections.map(s => (
        <NavLink key={s.to} to={s.to}>
          {({ isActive }) => (
            <button className={clsx(
              'px-4 py-3 text-[13px] flex items-center gap-1.5 whitespace-nowrap border-b-2 transition-colors',
              isActive ? 'text-accent-cyan border-accent-cyan' : 'text-neutral-500 border-transparent hover:text-neutral-300',
            )}>
              {s.icon}
              <span className="font-medium">{s.label}</span>
            </button>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

export function SubNav({ subs }: { subs: SubTab[] }) {
  if (subs.length <= 1) return null
  return (
    <nav className="flex gap-1 overflow-x-auto bg-ink-700 border-b border-ink-500 px-5">
      {subs.map(t => (
        <NavLink key={t.to} to={t.to}>
          {({ isActive }) => (
            <button className={clsx(
              'px-3 py-2 text-[11px] flex items-center gap-1 whitespace-nowrap border-b-2 transition-colors',
              isActive ? 'text-accent-cyan border-accent-cyan/60' : 'text-neutral-500 border-transparent hover:text-neutral-300',
            )}>
              {t.icon}
              {t.label}
              {t.count != null && t.count > 0 && (
                <span className={clsx(
                  'text-[9px] px-1.5 py-0.5 rounded-full',
                  isActive ? 'bg-accent-cyan/15 text-accent-cyan' : 'bg-ink-500 text-neutral-500',
                )}>{t.count}</span>
              )}
            </button>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

/** Resolve which section the current path belongs to (for SubNav rendering). */
export function activeSectionFor(pathname: string): Section | null {
  return SECTIONS.find(s => pathname === s.to || pathname.startsWith(s.to + '/')) ?? null
}
