import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowRight, Bot, Briefcase, Brain, DollarSign, TrendingUp, Wind, Zap } from 'lucide-react'
import { useStore } from '../store'
import { bySignalQuality, starsForSignal, starsForScore, type StarRating } from '../components/convictionTier'
import { Stars } from '../components/Stars'
import type { ReactNode } from 'react'

/**
 * Dashboard home — multi-box landing screen.
 *
 * Six side-by-side cards, each showing the top 5 of a section so the trader
 * sees everything important without diving into tabs. Click "View more" or
 * any row to drill in.
 *
 * Boxes:
 *   1. 🔥 LIVE Signals (grade A only — honest filter)
 *   2. 🤖 Daily Pick (top 5 by conviction)
 *   3. 👔 Weekly Pick (top 5 by conviction)
 *   4. 📈 Movers (top 5 weekly gainers)
 *   5. ⚡ Pre-Move (tomorrow's likely movers)
 *   6. 🧠 Pro Screener (Tier 1+2)
 */

export function DashboardHome() {
  const signals = useStore(s => s.signals)
  // Honest filter — dashboard hero box shows ONLY Grade A (score ≥ 8) so
  // every card you see here is a 8/10–10/10 setup. Grade B/C live signals
  // stay accessible in the All Signals tab. We don't inflate scores; we
  // filter to only show high-conviction ones in the high-conviction box.
  const topSignals = signals
    .filter(s => s.grade === 'A' && (s.tier ?? 'LIVE') === 'LIVE')
    .sort(bySignalQuality)
    .slice(0, 5)

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
  const weeklyPick = useQuery<any>({
    queryKey: ['weekly-pick'],
    queryFn: async () => {
      const r = await fetch('/api/weekly-pick')
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json()
    },
    staleTime: 60 * 60_000,
  })
  const movers = useQuery<any>({
    queryKey: ['screener', '/api/scan/movers'],
    queryFn: async () => {
      const r = await fetch('/api/scan/movers')
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json()
    },
    staleTime: 5 * 60_000,
  })
  const premove = useQuery<any>({
    queryKey: ['screener', '/api/scan/premove'],
    queryFn: async () => {
      const r = await fetch('/api/scan/premove')
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json()
    },
    staleTime: 5 * 60_000,
  })
  const proScan = useQuery<any>({
    queryKey: ['screener', '/api/scan/pro'],
    queryFn: async () => {
      const r = await fetch('/api/scan/pro')
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json()
    },
    staleTime: 5 * 60_000,
  })
  const regime = useQuery<any>({
    queryKey: ['regime'],
    queryFn: async () => (await fetch('/api/regime')).json(),
    staleTime: 5 * 60_000,
  })

  const topPro = (proScan.data?.results ?? []).slice(0, 5)
  // Pro Screener fallback: when strict spec returns nothing, surface the top
  // Daily Pick rows in the same box so the user always sees PRE-move ideas.
  const proRows: ProRowLike[] = topPro.length > 0
    ? topPro.map((r: any) => ({
        symbol: r.symbol, price: r.price, direction: r.direction, score: r.convictionScore ?? Math.round(r.score * 10),
        meta: r.timeframeLabel ?? r.queryId ?? '', accent: 'cyan',
      }))
    : (dailyPick.data?.rows ?? []).slice(0, 5).map((r: any) => ({
        symbol: r.symbol, price: r.ltp, direction: r.direction, score: r.conviction,
        meta: `via Daily Pick (${r.pattern})`, accent: 'amber',
      }))

  return (
    <div className="space-y-5">
      {/* Hero strip */}
      <HeroStrip regime={regime.data} signalCount={signals.length} />

      {/* Multi-box grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <Box
          title="🔥 LIVE Signals"
          subtitle={`Grade A+B only · ${topSignals.length} of ${signals.length} loaded`}
          accent="green"
          viewMore="/signals/all"
          empty="No high-grade signals — filters keep noise out"
        >
          {topSignals.map(s => (
            <CompactRow
              key={s.id}
              to={routeForSignal(s.type)}
              symbol={s.instrument}
              direction={s.direction === 'BUY' ? 'BUY' : 'SHORT'}
              price={s.entry}
              right={`${s.score}/10 · ${s.grade}`}
              meta={`${s.type.toLowerCase()} · ${(s.reasons[0] ?? '').slice(0, 36)}…`}
              stars={starsForSignal(s)}
            />
          ))}
        </Box>

        <Box
          title="🤖 Daily Pick"
          subtitle={dailyPick.data ? `${dailyPick.data.rows.length} candidates · ${dailyPick.data.newSinceLastRun?.length ?? 0} new` : 'Loading…'}
          accent="cyan"
          viewMore="/picks/daily"
          icon={<Bot size={14} />}
          empty="Awaiting first scan"
        >
          {(dailyPick.data?.rows ?? [])
            .slice()
            .sort((a: any, b: any) => (b.conviction ?? 0) - (a.conviction ?? 0))
            .slice(0, 5)
            .map((r: any) => (
            <CompactRow
              key={r.symbol}
              to="/picks/daily"
              symbol={r.symbol}
              direction={r.direction}
              price={r.ltp}
              right={`${r.conviction}/100`}
              meta={`${r.pattern.toLowerCase()} · T1 ₹${r.target1} · T2 ₹${r.target2}`}
              stars={starsForScore(r.conviction ?? 0)}
            />
          ))}
        </Box>

        <Box
          title="👔 Weekly Pick"
          subtitle={weeklyPick.data ? `Week of ${weeklyPick.data.weekOf} · ${weeklyPick.data.rows.length} stocks` : 'Loading…'}
          accent="violet"
          viewMore="/picks/weekly"
          icon={<Briefcase size={14} />}
          empty="No weekly pick yet — generate from Weekly Pick tab"
        >
          {(weeklyPick.data?.rows ?? [])
            .slice()
            .sort((a: any, b: any) => (b.conviction ?? 0) - (a.conviction ?? 0))
            .slice(0, 5)
            .map((r: any) => (
            <CompactRow
              key={r.symbol}
              to="/picks/weekly"
              symbol={r.symbol}
              direction={r.direction === 'BUY' ? 'BUY' : 'SHORT'}
              price={r.ltp}
              right={`${r.conviction}/100`}
              meta={`6w · T3 ₹${r.target3} by ${shortDate(r.target3Date)}`}
              stars={starsForScore(r.conviction ?? 0)}
            />
          ))}
        </Box>

        <Box
          title="📈 Today's Movers"
          subtitle={movers.data ? `${movers.data.results?.length ?? 0} 5-day movers (≥5%)` : 'Loading…'}
          accent="green"
          viewMore="/discover/movers"
          icon={<TrendingUp size={14} />}
          empty="No movers found"
        >
          {(movers.data?.results ?? []).slice(0, 5).map((r: any) => (
            <CompactRow
              key={r.symbol + r.setupKind}
              to="/discover/movers"
              symbol={r.symbol}
              direction={r.direction === 'BULL' ? 'BUY' : 'SHORT'}
              price={r.price}
              right={`+${r.changePct?.toFixed(1) ?? 0}%`}
              meta={r.tags?.slice(0, 2).join(' · ')}
            />
          ))}
        </Box>

        <Box
          title="⚡ Pre-Move"
          subtitle={premove.data ? `${premove.data.results?.length ?? 0} setups for next 1-3 sessions` : 'Loading…'}
          accent="amber"
          viewMore="/discover/premove"
          icon={<Wind size={14} />}
          empty="No pre-move setups"
        >
          {(premove.data?.results ?? []).slice(0, 5).map((r: any) => (
            <CompactRow
              key={r.symbol + r.setupKind}
              to="/discover/premove"
              symbol={r.symbol}
              direction={r.direction === 'BULL' ? 'BUY' : 'SHORT'}
              price={r.price}
              right={`tier ${r.tier}`}
              meta={r.tags?.slice(0, 2).join(' · ')}
            />
          ))}
        </Box>

        <Box
          title={topPro.length > 0 ? '🧠 Pro Screener' : '🧠 Pro Screener · fallback'}
          subtitle={topPro.length > 0
            ? `Top conviction (12-query strict)`
            : `Strict queries empty — showing Daily Pick instead`}
          accent={topPro.length > 0 ? 'cyan' : 'amber'}
          viewMore={topPro.length > 0 ? '/picks/pro' : '/picks/daily'}
          icon={<Brain size={14} />}
          empty="No setups"
        >
          {proRows.map((r, i) => (
            <CompactRow
              key={r.symbol + i}
              to={topPro.length > 0 ? '/picks/pro' : '/picks/daily'}
              symbol={r.symbol}
              direction={r.direction}
              price={r.price}
              right={`${r.score}/100`}
              meta={r.meta}
            />
          ))}
        </Box>
      </div>

      <FundamentalsUpload />

      <div className="text-[11px] text-neutral-500 px-1">
        Tip: hit <kbd className="text-[10px] px-1 py-0.5 rounded bg-ink-500 border border-ink-400">⌘K</kbd> to search any NSE symbol from anywhere.
      </div>
    </div>
  )
}

// ─── Fundamentals upload widget ───────────────────────────────

function FundamentalsUpload() {
  const status = useQuery<any>({
    queryKey: ['fundamentals'],
    queryFn: async () => (await fetch('/api/fundamentals')).json(),
    staleTime: 60_000,
  })
  const symbolCount = status.data?.symbolCount ?? 0
  const flow = status.data?.flow

  const handleFile = async (file: File | null) => {
    if (!file) return
    const text = await file.text()
    const r = await fetch('/api/fundamentals/upload?source=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: text,
    })
    if (r.ok) {
      const d = await r.json()
      alert(`Loaded fundamentals for ${d.symbolCount} symbols. Engine will use them on next scan tick.`)
      status.refetch()
    } else {
      const e = await r.json().catch(() => ({}))
      alert(`Upload failed: ${e.error ?? r.status}`)
    }
  }

  return (
    <div className="bg-ink-700 border border-ink-500 rounded-lg p-4 flex flex-col md:flex-row md:items-center gap-3">
      <div className="flex-1">
        <div className="text-sm font-semibold text-neutral-200">📊 Fundamentals + FII/DII Flow</div>
        <div className="text-[11px] text-neutral-500 mt-1">
          Upload a Screener.in CSV export (any custom query with Symbol + EPS Growth + ROE + Pledge columns).
          Once loaded, signals get the <b className="text-accent-cyan">fundamentals</b> + <b className="text-accent-cyan">flow</b> confluence factors,
          which is what unlocks <b>9/10</b> scores on quality stocks.
        </div>
        <div className="text-[11px] text-neutral-400 mt-2">
          Loaded: <b className={symbolCount > 0 ? 'text-accent-green' : 'text-accent-amber'}>{symbolCount} symbols</b>
          {status.data?.uploadedAt && <span className="text-neutral-600"> · {new Date(status.data.uploadedAt).toLocaleString('en-IN')}</span>}
          {flow && <>
            <span className="text-neutral-600"> · </span>
            <span>FII <b className={flow.fiiNet >= 0 ? 'text-accent-green' : 'text-accent-red'}>{flow.fiiNet >= 0 ? '+' : ''}₹{flow.fiiNet}cr</b></span>
            <span className="text-neutral-600"> · </span>
            <span>DII <b className={flow.diiNet >= 0 ? 'text-accent-green' : 'text-accent-red'}>{flow.diiNet >= 0 ? '+' : ''}₹{flow.diiNet}cr</b></span>
          </>}
        </div>
      </div>
      <label className="text-xs px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 cursor-pointer whitespace-nowrap">
        Upload CSV
        <input type="file" accept=".csv,text/csv" className="hidden" onChange={e => handleFile(e.target.files?.[0] ?? null)} />
      </label>
    </div>
  )
}

// ─── Hero ─────────────────────────────────────────────────────

function HeroStrip({ regime, signalCount }: { regime: any; signalCount: number }) {
  const regimeColor = regime?.regime === 'BULL' ? 'text-accent-green'
    : regime?.regime === 'BEAR' ? 'text-accent-red'
    : 'text-accent-amber'
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <HeroBox label="Market regime" value={regime?.regime ?? '—'} valueClass={regimeColor}
        sub={regime?.recommendation ?? ''} />
      <HeroBox label="Loaded signals" value={String(signalCount)} valueClass="text-neutral-200"
        sub={`Live + watch (last engine tick)`} />
      <HeroBox label="VIX" value={regime?.vix != null ? regime.vix.toFixed(2) : '—'}
        valueClass={regime?.vix > 20 ? 'text-accent-red' : regime?.vix > 16 ? 'text-accent-amber' : 'text-accent-green'}
        sub="<16 = calm · 16-20 = caution · >20 = volatile" />
      <HeroBox label="Nifty vs 200-EMA" value={regime?.niftyAbove200ema ? 'ABOVE' : 'BELOW'}
        valueClass={regime?.niftyAbove200ema ? 'text-accent-green' : 'text-accent-red'}
        sub="Long-term trend health" />
    </div>
  )
}

function HeroBox({ label, value, valueClass, sub }: { label: string; value: string; valueClass: string; sub: string }) {
  return (
    <div className="bg-ink-700 border border-ink-500 rounded p-3">
      <div className="text-[10px] text-neutral-500 uppercase tracking-wider">{label}</div>
      <div className={clsx('text-lg font-mono font-bold mt-1', valueClass)}>{value}</div>
      <div className="text-[10px] text-neutral-600 mt-0.5 truncate" title={sub}>{sub}</div>
    </div>
  )
}

// ─── Multi-box card ───────────────────────────────────────────

interface ProRowLike { symbol: string; price: number; direction: 'BUY' | 'SHORT'; score: number; meta: string; accent: 'cyan' | 'amber' }

function Box({
  title, subtitle, accent, viewMore, children, icon, empty,
}: {
  title: string
  subtitle: string
  accent: 'green' | 'cyan' | 'violet' | 'amber'
  viewMore: string
  children: ReactNode
  icon?: ReactNode
  empty: string
}) {
  const headerCls =
    accent === 'green' ? 'border-accent-green/30 bg-accent-green/5 text-accent-green' :
    accent === 'cyan'  ? 'border-accent-cyan/30 bg-accent-cyan/5 text-accent-cyan' :
    accent === 'violet'? 'border-accent-violet/30 bg-accent-violet/5 text-accent-violet' :
                         'border-accent-amber/30 bg-accent-amber/5 text-accent-amber'
  // children might be empty array — coerce to check
  const hasContent = Array.isArray(children) ? children.filter(Boolean).length > 0 : !!children

  return (
    <div className={clsx('rounded-lg border', headerCls.split(' ')[0])}>
      <div className={clsx('flex items-center justify-between px-3 py-2 rounded-t-lg border-b', headerCls)}>
        <div className="flex items-center gap-2 font-bold text-sm">
          {icon}
          <span className="tracking-wide">{title}</span>
        </div>
        <Link to={viewMore} className="text-[10px] hover:underline flex items-center gap-0.5">
          View more <ArrowRight size={10} />
        </Link>
      </div>
      <div className="p-2 space-y-1 bg-ink-800 rounded-b-lg min-h-[260px]">
        {hasContent ? children : (
          <div className="text-[11px] text-neutral-600 text-center py-12">{empty}</div>
        )}
        <div className="text-[10px] text-neutral-600 px-2 pt-1">{subtitle}</div>
      </div>
    </div>
  )
}

function CompactRow({ to, symbol, direction, price, right, meta, stars }: {
  to: string
  symbol: string
  direction: 'BUY' | 'SHORT'
  price: number
  right: string
  meta?: string
  stars?: StarRating
}) {
  const dirColor = direction === 'BUY' ? '#00c853' : '#ff1744'
  return (
    <Link to={to} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-ink-700 transition-colors text-xs">
      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold w-12 text-center" style={{ background: `${dirColor}22`, color: dirColor }}>
        {direction}
      </span>
      <span className="font-semibold text-neutral-200 min-w-[80px] truncate">{symbol}</span>
      {stars && <Stars count={stars} className="text-[10px]" />}
      <span className="font-mono text-neutral-300">₹{price?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
      <span className="ml-auto font-mono text-[10px] text-neutral-400">{right}</span>
      {meta && <span className="hidden md:inline text-[10px] text-neutral-600 truncate max-w-[180px]" title={meta}>· {meta}</span>}
    </Link>
  )
}

function shortDate(iso: string): string {
  if (!iso) return '—'
  const [, m, d] = iso.split('-').map(Number)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${d} ${months[m - 1] ?? '?'}`
}

function routeForSignal(type: string): string {
  return type === 'INTRADAY' ? '/signals/intraday'
       : type === 'OPTIONS'  ? '/signals/options'
       : type === 'SWING'    ? '/signals/swing'
       : type === 'COMMODITY'? '/signals/commodity'
       : '/signals/all'
}
