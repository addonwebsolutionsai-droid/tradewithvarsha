import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { starsForScore, byScoreQuality } from '../components/convictionTier'
import { Stars } from '../components/Stars'
import { ExportButtons } from '../components/ExportButtons'
import { useSortableTable } from '../components/useSortableTable'

interface PickRow {
  symbol: string
  ltp: number
  ltpSource?: 'live' | 'eod'
  ltpAsOf?: string
  conviction: number
  direction: 'BUY' | 'SHORT'
  entryPrice: number
  entryPriceLow?: number
  entryPriceHigh?: number
  entryDate: string
  entryNote: string
  bestEntryTimeIST?: string
  horaLord?: string
  horaNote?: string
  target1: number; target1Date: string
  target2: number; target2Date: string
  target3: number; target3Date: string
  expectedReturnPct: number
  stopLoss: number
  riskRewardRatio: number
  smcNote: string
  trendNote: string
  gannNote: string
  astroNote: string
  flowNote: string
  shareholdingNote?: string         // 2026-05-24: FII/DII/Promoter/Pledge/MC summary
  noBrainerBet?: boolean
  // 2026-05-26: server-enriched at /api/weekly-pick
  vol5dRatio?: number
  smartMoneyUp?: boolean
  fiiDelta?: number
  promoterDelta?: number
  diiDelta?: number
  source: 'WATCHLIST' | 'CURATED'
}

interface WeeklyPick {
  weekOf: string
  generatedAt: string
  regime: string
  watchlistInput: string[]
  rows: PickRow[]
  notes: string[]
}

export function WeeklyPickPage() {
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')

  const pick = useQuery({
    queryKey: ['weekly-pick'],
    queryFn: async () => {
      const r = await fetch('/api/weekly-pick')
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<WeeklyPick>
    },
    staleTime: 60 * 60_000,
  })

  const watchlist = useQuery({
    queryKey: ['weekly-watchlist'],
    queryFn: async () => {
      const r = await fetch('/api/weekly-pick/watchlist')
      if (!r.ok) throw new Error(`${r.status}`)
      const d = await r.json() as { symbols: string[] }
      return d.symbols
    },
    staleTime: 60 * 60_000,
  })

  const runPick = async () => {
    setRunning(true)
    try {
      const r = await fetch('/api/weekly-pick/run', { method: 'POST' })
      if (r.ok) qc.setQueryData(['weekly-pick'], await r.json())
    } finally { setRunning(false) }
  }

  const saveWatchlist = async () => {
    const symbols = draft.split(/[,\s\n]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
    const r = await fetch('/api/weekly-pick/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols }),
    })
    if (r.ok) {
      const d = await r.json() as { symbols: string[] }
      qc.setQueryData(['weekly-watchlist'], d.symbols)
      setEditing(false)
    }
  }

  const p = pick.data
  const wl = watchlist.data ?? []
  const watchRows = (p?.rows ?? []).filter(r => r.source === 'WATCHLIST')
  const curatedRows = (p?.rows ?? []).filter(r => r.source === 'CURATED')

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">👔</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-neutral-200">
            Pro Fund Manager — Weekly Pick {p?.weekOf && <span className="ml-2 text-accent-cyan">· week of {p.weekOf}</span>}
          </div>
          <div className="text-xs text-neutral-500 mt-1">
            6-week swing horizon (target ≥20% by end-month) · synthesises <b>SMC</b> + <b>Trend stack</b> + <b>Gann time cycle</b> + <b>Vedic/Mundane astro</b> + <b>order-flow proxy</b>.
            Watchlist (your 17 names) is always evaluated; curated picks are the top 15 conviction names from NIFTY 100.
            Auto-runs every <b>Sunday 18:00 IST</b>.
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <button onClick={runPick} disabled={running}
            className="text-xs px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50 whitespace-nowrap">
            {running ? 'Generating…' : 'Generate now'}
          </button>
          <ExportButtons dataset="weekly-pick" slug="weekly-pick" />
        </div>
      </div>

      {/* Watchlist editor */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold text-neutral-200">📋 Your Watchlist ({wl.length} symbols)</div>
          <button onClick={() => { setEditing(e => !e); setDraft(wl.join(', ')) }}
            className="text-[11px] px-2 py-1 rounded bg-ink-500 text-neutral-400 hover:text-neutral-200">
            {editing ? 'Cancel' : 'Edit'}
          </button>
        </div>
        {editing ? (
          <div className="space-y-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              rows={3}
              placeholder="Comma or space separated NSE symbols, e.g. RELIANCE, TCS, IRB"
              className="w-full bg-ink-700 border border-ink-500 rounded p-2 text-xs font-mono text-neutral-200 focus:outline-none focus:border-accent-cyan"
            />
            <div className="flex gap-2">
              <button onClick={saveWatchlist}
                className="text-xs px-3 py-1.5 rounded bg-accent-green/15 text-accent-green hover:bg-accent-green/25">
                Save watchlist
              </button>
              <span className="text-[11px] text-neutral-600 self-center">
                Saving will replace the current watchlist · Click "Generate now" after saving to re-score.
              </span>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {wl.map(s => <span key={s} className="text-[11px] px-2 py-0.5 rounded bg-ink-700 border border-ink-500 font-mono text-neutral-300">{s}</span>)}
          </div>
        )}
      </section>

      {/* Header notes / regime */}
      {p && p.notes.length > 0 && (
        <div className="bg-ink-700 border border-ink-500 rounded-lg p-3 space-y-1 text-[11px] text-neutral-400">
          {p.notes.map((n, i) => <div key={i}>• {n}</div>)}
        </div>
      )}

      {!p && !pick.isLoading && (
        <div className="bg-ink-700 border border-ink-500 rounded-lg p-8 text-center text-sm text-neutral-500">
          No weekly pick generated yet. Click <b className="text-accent-cyan">Generate now</b> above — takes ~60-90 seconds for 17 watchlist + 100 curated names.
        </div>
      )}

      {/* Watchlist picks table */}
      {watchRows.length > 0 && <PickTable title="📋 Your Watchlist — scored" rows={watchRows} />}

      {/* Curated picks table */}
      {curatedRows.length > 0 && <PickTable title="🎯 Curated picks (top conviction · NIFTY 100)" rows={curatedRows} />}
    </div>
  )
}

function PickTable({ title, rows }: { title: string; rows: PickRow[] }) {
  // 2026-05-26: replace fixed star-sort with click-to-sort headers. Default
  // still ranks elite first (conviction desc).
  const initialSorted = rows.slice().sort(byScoreQuality)
  const { rows: sorted, headerProps, sortIndicator } = useSortableTable<PickRow>(
    initialSorted,
    { key: 'conv', dir: 'desc' },
    {
      symbol: r => r.symbol, ltp: r => r.ltp,
      dir: r => r.direction, conv: r => r.conviction,
      vol5d: r => r.vol5dRatio ?? 0, smart: r => (r.smartMoneyUp ? 1 : 0),
      fii: r => r.fiiDelta ?? 0,
      entry: r => r.entryPrice, sl: r => r.stopLoss,
      t1: r => r.target1, t2: r => r.target2, t3: r => r.target3,
      rr: r => r.riskRewardRatio,
    },
  )
  // 2026-05-24: mirrored the Vercel public-page UX upgrade onto localhost.
  //   • Mobile (< md=768px) → vertical cards, no horizontal scroll.
  //   • Desktop (≥ md) → table inside max-h-75vh scroll container with
  //     sticky <thead> + sticky first column (Stock pinned left while
  //     horizontal scrolling).
  //   • NEW Stake column showing FII/DII/Promoter/Pledge/MC (was missing
  //     from localhost — restored per user request).
  return (
    <section>
      <div className="text-sm font-semibold text-neutral-200 mb-2">
        {title} <span className="text-neutral-500 text-xs">· {rows.length} stocks · sort: ⭐ first</span>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden space-y-3">
        {sorted.map(r => <PickCardView key={r.symbol} row={r} />)}
      </div>

      {/* Desktop table */}
      <div
        className="hidden md:block overflow-auto rounded-lg border border-ink-500 bg-ink-800"
        style={{ maxHeight: '75vh' }}
      >
        <table className="w-full text-[11px] border-separate" style={{ borderSpacing: 0, minWidth: 1600 }}>
          <thead className="bg-ink-700 text-neutral-400 sticky top-0 z-20">
            <tr>
              <th {...headerProps('symbol')} className={`text-left px-3 py-2 bg-ink-700 sticky left-0 z-30 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)] ${headerProps('symbol').className}`}>Stock {sortIndicator('symbol')}</th>
              <th {...headerProps('ltp')} className={`text-right px-3 py-2 ${headerProps('ltp').className}`}>LTP {sortIndicator('ltp')}</th>
              <th {...headerProps('dir')} className={`text-center px-3 py-2 ${headerProps('dir').className}`}>Dir {sortIndicator('dir')}</th>
              <th {...headerProps('conv')} className={`text-center px-3 py-2 ${headerProps('conv').className}`}>Conv {sortIndicator('conv')}</th>
              <th {...headerProps('vol5d')} className={`text-center px-3 py-2 ${headerProps('vol5d').className}`} title="Last 5 days avg / 20-day avg. >1.0 = recent volume acceleration.">5dVol× {sortIndicator('vol5d')}</th>
              <th {...headerProps('smart')} className={`text-center px-3 py-2 ${headerProps('smart').className}`} title="🔥 = FII increasing (>+0.3% QoQ) AND Promoter not selling significantly.">Smart $ {sortIndicator('smart')}</th>
              <th {...headerProps('fii')} className={`text-right px-3 py-2 ${headerProps('fii').className}`} title="FII delta QoQ in pp.">FIIΔ {sortIndicator('fii')}</th>
              <th {...headerProps('entry')} className={`text-right px-3 py-2 text-accent-cyan ${headerProps('entry').className}`}>Entry {sortIndicator('entry')}</th>
              <th className="text-center px-3 py-2 text-accent-cyan">Entry by</th>
              <th className="text-center px-3 py-2 text-accent-cyan">Entry time</th>
              <th {...headerProps('sl')} className={`text-right px-3 py-2 text-accent-red ${headerProps('sl').className}`}>SL {sortIndicator('sl')}</th>
              <th {...headerProps('t1')} className={`text-right px-3 py-2 text-accent-green ${headerProps('t1').className}`}>T1 (8%) {sortIndicator('t1')}</th>
              <th className="text-center px-3 py-2 text-accent-green">T1 by</th>
              <th {...headerProps('t2')} className={`text-right px-3 py-2 text-accent-green ${headerProps('t2').className}`}>T2 (14%) {sortIndicator('t2')}</th>
              <th className="text-center px-3 py-2 text-accent-green">T2 by</th>
              <th {...headerProps('t3')} className={`text-right px-3 py-2 text-accent-green font-semibold ${headerProps('t3').className}`}>T3 (≥20%) {sortIndicator('t3')}</th>
              <th className="text-center px-3 py-2 text-accent-green">T3 by</th>
              <th {...headerProps('rr')} className={`text-center px-3 py-2 ${headerProps('rr').className}`}>RR {sortIndicator('rr')}</th>
              <th className="text-left px-3 py-2 text-neutral-400">Stake (FII/DII/Promoter/Pledge/MC)</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => <PickRowView key={r.symbol} row={r} />)}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Mobile card layout — all 16 fields stacked vertically, no horizontal scroll. */
function PickCardView({ row }: { row: PickRow }) {
  const [open, setOpen] = useState(false)
  const dirColor = row.direction === 'BUY' ? '#00c853' : '#ff1744'
  const convColor = row.conviction >= 80 ? 'text-accent-green' : row.conviction >= 60 ? 'text-accent-cyan' : row.conviction >= 50 ? 'text-accent-amber' : 'text-neutral-500'
  const stars = starsForScore(row.conviction)
  return (
    <div className={`rounded-lg border p-3 font-mono text-[12px] ${row.noBrainerBet ? 'bg-accent-amber/5 border-accent-amber/40' : 'bg-ink-800 border-ink-500'}`}
         onClick={() => setOpen(o => !o)}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <b className="text-neutral-100 text-[13px]">{row.noBrainerBet && '⭐ '}{row.symbol}</b>
          <Stars count={stars} className="text-[10px]" />
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{row.direction}</span>
        </div>
        <span className={clsx('text-[12px] font-bold', convColor)}>{row.conviction}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <div className="text-neutral-500">LTP</div>
        <div className="text-right">
          ₹{row.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          {row.ltpSource === 'eod' && <span className="ml-1 text-[8px] text-accent-amber">EOD</span>}
          {row.ltpSource === 'live' && <span className="ml-1 text-[8px] text-accent-green">●</span>}
        </div>
        <div className="text-accent-cyan">Entry</div>
        <div className="text-right text-accent-cyan">
          {row.entryPriceLow != null && row.entryPriceHigh != null
            ? <>₹{row.entryPriceLow}–{row.entryPriceHigh}</>
            : <>₹{row.entryPrice}</>}
          <span className="text-neutral-500 text-[10px]"> · {shortDate(row.entryDate)}</span>
        </div>
        {row.bestEntryTimeIST && (<>
          <div className="text-neutral-500">Entry time</div>
          <div className="text-right text-[10px]">{row.bestEntryTimeIST} {row.horaLord && <span className="text-neutral-600">· {row.horaLord}</span>}</div>
        </>)}
        <div className="text-accent-red">Stop Loss</div><div className="text-right text-accent-red">₹{row.stopLoss}</div>
        <div className="text-accent-green">T1 (8%)</div><div className="text-right text-accent-green">₹{row.target1} <span className="text-neutral-500 text-[10px]">· {shortDate(row.target1Date)}</span></div>
        <div className="text-accent-green">T2 (14%)</div><div className="text-right text-accent-green">₹{row.target2} <span className="text-neutral-500 text-[10px]">· {shortDate(row.target2Date)}</span></div>
        <div className="text-accent-green">T3 (≥20%)</div><div className="text-right text-accent-green font-bold">₹{row.target3} <span className="text-neutral-500 text-[10px]">· {shortDate(row.target3Date)}</span></div>
        <div className="text-neutral-500">R:R</div><div className="text-right">{row.riskRewardRatio}:1</div>
      </div>
      {row.shareholdingNote && (
        <div className="mt-2 pt-2 border-t border-ink-500 text-[10px] text-neutral-400 leading-relaxed">
          <span className="text-neutral-500 font-semibold">Stake: </span>{row.shareholdingNote}
        </div>
      )}
      {open && (
        <div className="mt-2 pt-2 border-t border-ink-500 grid grid-cols-1 gap-2 text-[10px]">
          <Reason label="🧠 SMC" text={row.smcNote} />
          <Reason label="📈 Trend" text={row.trendNote} />
          <Reason label="🔮 Gann" text={row.gannNote} />
          <Reason label="🪐 Astro" text={row.astroNote} />
          <Reason label="💧 Flow" text={row.flowNote} />
          <div className="text-neutral-500 text-[10px]">
            <b>{row.entryNote}</b> · expected {row.expectedReturnPct >= 0 ? '+' : ''}{row.expectedReturnPct}% by {row.target3Date}
          </div>
        </div>
      )}
    </div>
  )
}

function PickRowView({ row }: { row: PickRow }) {
  const [open, setOpen] = useState(false)
  const dirColor = row.direction === 'BUY' ? '#00c853' : '#ff1744'
  const convColor = row.conviction >= 80 ? 'text-accent-green' : row.conviction >= 60 ? 'text-accent-cyan' : row.conviction >= 50 ? 'text-accent-amber' : 'text-neutral-500'
  const stars = starsForScore(row.conviction)
  // Row tint moved to each cell so the sticky-left Stock cell matches the
  // hover/no-brainer background of the rest of the row.
  const rowBg = row.noBrainerBet ? 'bg-accent-amber/5' : 'bg-ink-800'
  const td = `px-3 py-2 border-t border-ink-500 ${rowBg} group-hover:bg-ink-700 cursor-pointer`
  return (
    <>
      <tr className="group" onClick={() => setOpen(o => !o)}>
        <td className={`${td} sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]`}>
          <div className="flex items-center gap-1.5">
            <b className="text-neutral-200">{row.noBrainerBet && '⭐ '}{row.symbol}</b>
            <Stars count={stars} className="text-[10px]" />
          </div>
        </td>
        <td className={`${td} text-right`}>
          ₹{row.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          {row.ltpSource === 'eod' && (
            <span title={`Stale — last close ${row.ltpAsOf?.slice(0, 16) ?? ''}`}
              className="ml-1 text-[8px] text-accent-amber">EOD</span>
          )}
          {row.ltpSource === 'live' && (
            <span title={`Live · ${row.ltpAsOf?.slice(11, 19) ?? ''} IST`}
              className="ml-1 text-[8px] text-accent-green">●</span>
          )}
        </td>
        <td className={`${td} text-center`}>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>
            {row.direction}
          </span>
        </td>
        <td className={clsx(td, 'text-center font-bold', convColor)}>{row.conviction}</td>
        <td className={`${td} text-center ${row.vol5dRatio != null && row.vol5dRatio >= 1.3 ? 'text-accent-green font-bold' : row.vol5dRatio != null && row.vol5dRatio >= 1.0 ? 'text-accent-cyan' : 'text-neutral-500'}`}>
          {row.vol5dRatio ? `${row.vol5dRatio}×` : '—'}
        </td>
        <td className={`${td} text-center`} title={row.smartMoneyUp ? `FII +${row.fiiDelta} · P ${(row.promoterDelta ?? 0) > 0 ? '+' : ''}${row.promoterDelta}` : 'FII not buying or Promoter selling'}>
          {row.smartMoneyUp ? <span className="text-accent-green font-bold">🔥</span> : <span className="text-neutral-600">—</span>}
        </td>
        <td className={`${td} text-right text-[10px]`}>
          {row.fiiDelta != null ? <span className={row.fiiDelta > 0 ? 'text-accent-green' : row.fiiDelta < 0 ? 'text-accent-red' : 'text-neutral-500'}>{row.fiiDelta > 0 ? '+' : ''}{row.fiiDelta}</span> : <span className="text-neutral-600">—</span>}
        </td>
        <td className={`${td} text-right text-accent-cyan`}>
          {row.entryPriceLow != null && row.entryPriceHigh != null
            ? <>₹{row.entryPriceLow}–{row.entryPriceHigh}</>
            : <>₹{row.entryPrice}</>}
        </td>
        <td className={`${td} text-center text-accent-cyan text-[10px]`}>{shortDate(row.entryDate)}</td>
        <td className={`${td} text-center text-accent-cyan text-[10px]`}>
          {row.bestEntryTimeIST ? (
            <>
              <div className="font-mono">{row.bestEntryTimeIST}</div>
              {row.horaLord && <div className="text-neutral-600 text-[9px]">{row.horaLord}</div>}
            </>
          ) : '—'}
        </td>
        <td className={`${td} text-right text-accent-red`}>₹{row.stopLoss}</td>
        <td className={`${td} text-right text-accent-green`}>₹{row.target1}</td>
        <td className={`${td} text-center text-accent-green text-[10px]`}>{shortDate(row.target1Date)}</td>
        <td className={`${td} text-right text-accent-green`}>₹{row.target2}</td>
        <td className={`${td} text-center text-accent-green text-[10px]`}>{shortDate(row.target2Date)}</td>
        <td className={`${td} text-right text-accent-green font-bold`}>₹{row.target3}</td>
        <td className={`${td} text-center text-accent-green text-[10px] font-semibold`}>{shortDate(row.target3Date)}</td>
        <td className={`${td} text-center`}>{row.riskRewardRatio}:1</td>
        <td className={`${td} text-left text-neutral-300 text-[10px] leading-relaxed`} style={{ minWidth: 220, maxWidth: 360, whiteSpace: 'normal' }}>
          {row.shareholdingNote || <span className="text-neutral-600">shareholding unavailable</span>}
        </td>
      </tr>
      {open && (
        <tr className="bg-ink-700 border-t border-ink-500">
          <td colSpan={19} className="px-4 py-3">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3 text-[11px]">
              <Reason label="🧠 SMC" text={row.smcNote} />
              <Reason label="📈 Trend" text={row.trendNote} />
              <Reason label="🔮 Gann" text={row.gannNote} />
              <Reason label="🪐 Astro" text={row.astroNote} />
              <Reason label="💧 Flow" text={row.flowNote} />
            </div>
            <div className="mt-2 text-[10px] text-neutral-500">
              <b>{row.entryNote}</b> · Risk-reward {row.riskRewardRatio}:1 to T1 · expected {row.expectedReturnPct >= 0 ? '+' : ''}{row.expectedReturnPct}% by {row.target3Date}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function Reason({ label, text }: { label: string; text: string }) {
  return (
    <div className="bg-ink-800 border border-ink-500 rounded p-2">
      <div className="text-[10px] text-neutral-500 uppercase tracking-wider mb-0.5">{label}</div>
      <div className="text-neutral-300">{text}</div>
    </div>
  )
}

function shortDate(iso: string): string {
  if (!iso) return '—'
  // YYYY-MM-DD → "DD MMM"
  const [y, m, d] = iso.split('-').map(Number)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${d} ${months[m - 1] ?? '?'}`
}
