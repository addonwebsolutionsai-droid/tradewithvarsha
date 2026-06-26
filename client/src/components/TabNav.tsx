import { useState } from 'react'
import clsx from 'clsx'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Activity, BarChart3, Bot, Brain, Briefcase, Clock, LayoutDashboard,
  Layers, ListChecks, Rocket, Star, Target,
  TrendingUp, Wind, Zap, ChevronDown, ClipboardList, Triangle,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { snapshots } from '../api'

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
  // 2026-05-29: 4-tab nav with PER-TAB ACCURACY badge.
  // Pulls bySource win-rates from the public accuracy snapshot once and
  // surfaces a small "72%" pill next to each label, colour-coded so users
  // can compare quality across sections at a glance.
  const { data: accSnap } = PUBLIC_MODE ? useQuery({
    queryKey: ['nav-accuracy'], queryFn: () => snapshots.accuracy(),
    staleTime: 5 * 60_000, refetchInterval: 5 * 60_000, retry: false,
  }) : { data: undefined }
  const bySrc: Record<string, { winRate?: number; total?: number }> =
    (accSnap?.bySource as any) || {}
  const wr = (key: string): number | null => {
    const v = bySrc[key]?.winRate
    return typeof v === 'number' ? v : null
  }
  // Tab → composite accuracy mapping.
  const picksAcc = (() => {
    const w = bySrc.WEEKLY, d = bySrc.DAILY
    const tot = (w?.total ?? 0) + (d?.total ?? 0)
    const wins = ((w?.winRate ?? 0) * (w?.total ?? 0) + (d?.winRate ?? 0) * (d?.total ?? 0))
    return tot > 0 ? wins / tot : null
  })()
  const trackAcc = (accSnap as any)?.winRate ?? null
  // 2026-06-25: NAV CONSOLIDATION per user audit — 17 tabs → 8 primary +
  // "More ▾" dropdown. Removed Elite (redundant with PRO Edge). Demoted
  // SL Traps, Smart Money (OBV), Old-WeeklyPick, OI Build-up, F&O Futures,
  // Ultra Picks, Pre-Move into the More dropdown. Routes still work for
  // bookmarks — only the nav presentation changes.
  const tops = PUBLIC_MODE ? [
    // 🚀 Early Move — primary moneymaker tab. ₹50-500 stocks BEFORE the
    // 10-20% weekly move. Sits first as the user's actual entry point.
    { to: '/early-momentum', label: '🚀 Early Move', icon: <Activity size={14} />,
      acc: null, highProb: true,
      title: 'Early Momentum Radar — ₹50-500 stocks BEFORE the 10-20% weekly move. NO conv floor, NO pre-breakout reject. Pure institutional-footprint signature (volume + delivery + range expansion + tight base).' },
    // 2026-06-26: Footprint moved to More dropdown — NSE rate-limits the
    // bulk-deals endpoint so the standalone tab is often empty. The data
    // still feeds Early Momentum (criterion 17 + pro-criteria layer) so
    // the value is captured upstream. Route preserved for bookmarks.
    { to: '/superstar',    label: '🌟 Superstar',  icon: <Star size={14} />,
      acc: null, highProb: true,
      title: "India's top 10 investors (Jhunjhunwala / Damani / Kacholia / Kedia / Dolly Khanna / Goel / Singhania / Kela / Porinju / Mukul Agrawal) — their holdings × our signal scoring." },
    { to: '/pro-edge',     label: '💎 PRO Edge',  icon: <Star size={14} />,
      acc: null, highProb: true,
      title: 'PRO Edge — strictest signal feed. Highest-probability picks in the platform.' },
    { to: '/picks',        label: 'Cash / Equity', icon: <Target size={14} />,
      acc: picksAcc,
      title: 'Cash / Equity picks — swing (Weekly · 1-4 weeks) + short-term (Daily · 1-15 days) + early-stage (5-20% Move) + Top Trades curated stream.' },
    { to: '/pre-move',     label: 'Pre-Move',     icon: <Wind size={14} />,
      acc: wr('PREMOVE'),
      title: 'Cash / Equity early-stage signals — pre-breakout setups (VCP / Wyckoff / volume dry-up).' },
    { to: '/options',      label: 'F&O',          icon: <Layers size={14} />,
      count: (counts.options ?? 0) + (counts.futures ?? 0),
      acc: wr('OPTIONS'),
      title: 'Options + Futures (NIFTY / Stock derivatives) — single source for all F&O trades.' },
    { to: '/fno-futures',  label: 'F&O Futures',  icon: <BarChart3 size={14} />,
      acc: null,
      title: 'F&O Stock-Futures — 12-criteria pre-breakout scan across all ~211 NSE F&O underlyings.' },
    { to: '/confluence',   label: 'Ultra Picks',  icon: <Star size={14} />,
      acc: null, highProb: true,
      title: 'Ultra Picks — names confirmed by multiple independent scanners. Structurally higher conviction.' },
    { to: '/sectors',      label: 'Sectors',      icon: <BarChart3 size={14} />,
      acc: null,
      title: 'Sector Rotation — 12 NIFTY sectoral indices ranked LEADING → LAGGING.' },
    // 2026-06-26: Old-Weekly restored to main nav — user feedback: "this
    // was working well earlier, keep using those logics." Tab runs the
    // pre-4fca35e momentum-chasing prerank with no freshness reject.
    { to: '/old-weekly',   label: '📜 Old-Weekly',  icon: <ListChecks size={14} />,
      acc: null,
      title: 'Old-WeeklyPick — pre-4fca35e momentum-chasing prerank, no freshness reject. Earlier logic that produced the original 35%-in-3-months winners (MOSCHIP/MARKSANS/FINPIPE/HIKAL etc.).' },
    { to: '/track-record', label: 'Track Record', icon: <ListChecks size={14} />,
      acc: trackAcc,
      title: 'History + win-rate of every signal across cash + F&O — fully transparent accuracy log.' },
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
  // /picks hub also "owns" the legacy pick deep-links so the Picks tab
  // stays highlighted when a user lands on a bookmarked sub-route.
  const PICKS_HUB_PATHS = ['/picks', '/top-trades', '/5-20-move', '/weekly-pick', '/daily-pick']
  const onPicksHub = PICKS_HUB_PATHS.some(p => location.pathname === p || location.pathname.startsWith(p + '/'))

  // 2026-06-25: "More ▾" dropdown — secondary / diagnostic tabs the user
  // doesn't need to see daily, but bookmarks still work.
  // 2026-06-25: Pre-Move, F&O Futures, Ultra Picks promoted back to main
  // nav per user request. More dropdown now only carries diagnostic /
  // secondary tabs.
  const moreItems: Array<{ to: string; label: string; title: string }> = PUBLIC_MODE ? [
    { to: '/bulk-deals',  label: '📡 Footprint (NSE bulk deals)', title: 'NSE Bulk Deals — institutional + superstar named-buyer feed. Often empty (NSE rate-limits) but the data feeds Early Momentum upstream.' },
    { to: '/smart-money', label: '🧮 Smart Money (OBV)', title: 'OBV / A-D Line / CMF divergence — institutional flow vs price action.' },
    { to: '/sl-traps',    label: '🛡️ SL Traps',          title: 'Liquidity grabs — SL hit then target hit anyway. Effective WR with traps as wins.' },
    { to: '/oi-buildup',  label: '🔁 OI Build-up',       title: 'Live F&O OI positioning. Long buildup · short covering · put-writing.' },
  ] : []
  const onMore = moreItems.some(m => location.pathname === m.to || location.pathname.startsWith(m.to + '/'))
  const [moreOpen, setMoreOpen] = useState(false)

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
              : t.to === '/picks'
                ? onPicksHub
                : (t as any).isParent
                  ? onInvestment
                  : location.pathname === t.to || location.pathname.startsWith(t.to + '/')
            return (
              <button
                key={t.to}
                title={(t as any).title}
                onClick={() => {
                  if ((t as any).isParent) navigate('/investment/symbols')
                  else navigate(t.to)
                }}
                className={clsx(
                  'px-3 py-2.5 text-[12px] flex items-center gap-1 whitespace-nowrap border-b-2 transition-colors flex-shrink-0 relative',
                  active
                    ? 'text-accent-cyan border-accent-cyan'
                    : 'text-neutral-500 border-transparent hover:text-neutral-300',
                  // 2026-06-16 — high-probability tabs visually stand out.
                  // Strong amber tint + glowing background ring so the user
                  // never misses where the best signals live.
                  (t as any).highProb && !active && 'bg-gradient-to-b from-accent-amber/25 to-accent-amber/10 text-accent-amber hover:from-accent-amber/35 hover:to-accent-amber/15',
                  (t as any).highProb && active && 'bg-gradient-to-b from-accent-amber/30 to-accent-amber/15',
                )}
              >
                {t.icon}
                {t.label}
                {(t as any).isParent && <ChevronDown size={11} />}
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
                {/* 2026-05-29: per-tab accuracy pill — green ≥70%, cyan ≥50%, amber <50%. */}
                {typeof (t as any).acc === 'number' && (
                  <span
                    title={`${t.label} historical win-rate (30-day rolling)`}
                    className={clsx(
                      'text-[9px] font-bold px-1.5 py-0.5 rounded-full leading-none',
                      (t as any).acc >= 70 ? 'bg-accent-green/15 text-accent-green' :
                      (t as any).acc >= 50 ? 'bg-accent-cyan/15 text-accent-cyan' :
                      'bg-accent-amber/15 text-accent-amber',
                    )}>
                    {Math.round((t as any).acc)}%
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        {/* 2026-06-25: "More ▾" dropdown — rendered OUTSIDE the scrollable
            <nav> so the dropdown isn't clipped by overflow-x-auto. The
            menu uses position:fixed with viewport coordinates so it
            renders on top of everything else, dark theme preserved. */}
        {moreItems.length > 0 && (
          <div className="relative flex-shrink-0 border-l border-ink-500/30">
            <button
              onClick={() => setMoreOpen(v => !v)}
              onBlur={() => setTimeout(() => setMoreOpen(false), 200)}
              className={clsx(
                'h-full px-3 py-2.5 text-[12px] flex items-center gap-1 whitespace-nowrap border-b-2 transition-colors',
                onMore || moreOpen
                  ? 'text-accent-cyan border-accent-cyan'
                  : 'text-neutral-500 border-transparent hover:text-neutral-300',
              )}>
              More
              <ChevronDown size={11} className={clsx('transition-transform', moreOpen && 'rotate-180')} />
            </button>
            {moreOpen && (
              <div
                className="absolute top-full right-0 mt-1 min-w-[220px] bg-ink-800 border border-ink-500 rounded-lg shadow-2xl py-1"
                style={{ zIndex: 9999 }}>
                {moreItems.map(m => {
                  const active = location.pathname === m.to || location.pathname.startsWith(m.to + '/')
                  return (
                    <button
                      key={m.to}
                      title={m.title}
                      onMouseDown={(e) => { e.preventDefault(); navigate(m.to); setMoreOpen(false) }}
                      className={clsx(
                        'w-full text-left px-3 py-2 text-[12px] transition-colors bg-ink-800',
                        active ? 'text-accent-cyan bg-accent-cyan/10' : 'text-neutral-300 hover:text-neutral-100 hover:bg-ink-700',
                      )}>
                      {m.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

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
