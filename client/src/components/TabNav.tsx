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
  const tops = PUBLIC_MODE ? [
    // 2026-06-05: PRO Edge — sellable premium feed. ALL filters stacked.
    // 0-10 names/day. The product we can credibly price at premium tier.
    { to: '/pro-edge',     label: '💎 PRO Edge',  icon: <Star size={14} />,
      acc: null,
      title: 'PRO Edge — strictest signal feed. Cross-engine confluence + smart-money same-side + sector tailwind aligned + conviction ≥ 85. 0-10 names/day. Premium tier.' },
    // 2026-06-05: NIFTY Options Pro — extracts the proven 66.7%-WR engine
    // as a standalone tab with live empirical badge.
    { to: '/options-pro',  label: '🎯 Options PRO', icon: <Layers size={14} />,
      acc: wr('OPTIONS'),
      title: 'NIFTY Options Pro — strict subset of options (grade A + score ≥ 9). Live 30-day measured win rate on banner.' },
    // 2026-05-30: 💎 Elite is the headline tab — best-of-best stream that
    // requires ALL 5 institutional confluences (Volume + FII↑ + DII↑ +
    // Promoter↑ + Fundamentals/Technicals) before a signal qualifies.
    { to: '/elite',        label: 'Elite',         icon: <Star size={14} />,
      acc: null,
      title: 'Elite — best-of-best signals. Requires ALL 5 confluences: Volume rising · FII stake up · DII stake up · Promoter stable+ · Fundamentals+Technicals aligned. Strictest filter in the system.' },
    // 2026-05-29: labels explicit about segment. Cash / Equity tab is the
    // hub for all equity picks (swing 1-4w via Weekly · short-term 1-15d
    // via Daily · early-stage via 5-20% Move + Top Trades). F&O tab is
    // dedicated to derivatives. Maps directly to how traders think: cash
    // segment vs F&O segment.
    { to: '/picks',        label: 'Cash / Equity', icon: <Target size={14} />,
      acc: picksAcc,
      title: 'Cash / Equity picks — swing (Weekly · 1-4 weeks) + short-term (Daily · 1-15 days) + early-stage (5-20% Move) + Top Trades curated stream.' },
    { to: '/pre-move',     label: 'Pre-Move',     icon: <Wind size={14} />,
      acc: wr('PREMOVE'),
      title: 'Cash / Equity early-stage signals — pre-breakout setups (VCP / Wyckoff / volume dry-up).' },
    { to: '/oi-buildup',   label: 'OI Build-up',  icon: <Activity size={14} />,
      acc: null,
      title: 'F&O OI Build-up — live institutional positioning. Long buildup · short covering · put-writing support · call-writing resistance. Refreshes every 2 min during market hours.' },
    // 2026-06-03: F&O Futures pre-breakout scan — runs every snapshot
    // publish across all ~211 NSE F&O underlyings. Multi-lens overlay
    // (EMA stack · tight coil · vol surging · FII↑ · promoter stable) to
    // identify moves BEFORE they start. Per user directive.
    // 2026-06-04: Old-WeeklyPick comparison tab — momentum-chasing prerank
    // (pre-4fca35e) + no freshness-reject. Side-by-side vs current Weekly
    // Pick to surface what the stricter pre-breakout filter is dropping.
    { to: '/old-weekly',   label: 'Old-WeeklyPick', icon: <ListChecks size={14} />,
      acc: null,
      title: 'Old-WeeklyPick — runs the same engine with the pre-4fca35e momentum-chasing prerank restored and no freshness-reject. Compare against current Weekly Pick to see what the stricter filter is dropping. Not pushed to Telegram.' },
    // 2026-06-05: weekend autonomous additions
    { to: '/confluence',   label: 'Ultra Picks',  icon: <Star size={14} />,
      acc: null,
      title: 'Cross-Engine Confluence — names flagged by ≥2 independent engines (Weekly + Pre-Move + F&O Futures + Daily + Old-Weekly). When multiple scanners with different criteria agree, conviction is structurally higher.' },
    { to: '/sectors',      label: 'Sectors',      icon: <BarChart3 size={14} />,
      acc: null,
      title: 'Sector Rotation — 12 NIFTY sectoral indices ranked LEADING → LAGGING by composite (20d ret · 5d ret · RSI). Align stock picks with sector tailwind.' },
    // 2026-06-05: Smart-Money divergence — OBV/CMF/A-D Line vs price.
    { to: '/smart-money',  label: 'Smart Money',  icon: <Activity size={14} />,
      acc: null,
      title: 'Accumulation / Distribution divergence — detects names where institutional flow (OBV · A/D Line · CMF) diverges from price action. Catches setups BEFORE price moves.' },
    { to: '/fno-futures',  label: 'F&O Futures',  icon: <BarChart3 size={14} />,
      acc: null,
      title: 'F&O Stock-Futures — pre-breakout daily scan across all ~211 NSE F&O underlyings. Multi-lens overlay: EMA stack + tight coil + at 20d high/low + volume rising + FII stake up + promoter stable. Identifies setups BEFORE the move happens.' },
    { to: '/options',      label: 'F&O',          icon: <Layers size={14} />,
      count: (counts.options ?? 0) + (counts.futures ?? 0),
      acc: wr('OPTIONS'),
      title: 'Options + Futures (NIFTY / BANKNIFTY / Stock derivatives) — single source for all F&O trades.' },
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
                  'px-3 py-2.5 text-[12px] flex items-center gap-1 whitespace-nowrap border-b-2 transition-colors flex-shrink-0',
                  active
                    ? 'text-accent-cyan border-accent-cyan'
                    : 'text-neutral-500 border-transparent hover:text-neutral-300',
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
