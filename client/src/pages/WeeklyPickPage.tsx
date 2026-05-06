import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { starsForScore, byScoreQuality } from '../components/convictionTier'
import { Stars } from '../components/Stars'
import { ExportButtons } from '../components/ExportButtons'

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
  const sorted = rows.slice().sort(byScoreQuality)
  return (
    <section>
      <div className="text-sm font-semibold text-neutral-200 mb-2">
        {title} <span className="text-neutral-500 text-xs">· {rows.length} stocks · sort: ⭐ first</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-ink-500">
        <table className="w-full text-[11px] bg-ink-800">
          <thead className="bg-ink-700 text-neutral-400">
            <tr>
              <th className="text-left px-3 py-2">Stock</th>
              <th className="text-right px-3 py-2">LTP</th>
              <th className="text-center px-3 py-2">Dir</th>
              <th className="text-center px-3 py-2">Conv</th>
              <th className="text-right px-3 py-2 text-accent-cyan">Entry</th>
              <th className="text-center px-3 py-2 text-accent-cyan">Entry by</th>
              <th className="text-center px-3 py-2 text-accent-cyan">Entry time</th>
              <th className="text-right px-3 py-2 text-accent-red">SL</th>
              <th className="text-right px-3 py-2 text-accent-green">T1 (8%)</th>
              <th className="text-center px-3 py-2 text-accent-green">T1 by</th>
              <th className="text-right px-3 py-2 text-accent-green">T2 (14%)</th>
              <th className="text-center px-3 py-2 text-accent-green">T2 by</th>
              <th className="text-right px-3 py-2 text-accent-green font-semibold">T3 (≥20%)</th>
              <th className="text-center px-3 py-2 text-accent-green">T3 by</th>
              <th className="text-center px-3 py-2">RR</th>
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

function PickRowView({ row }: { row: PickRow }) {
  const [open, setOpen] = useState(false)
  const dirColor = row.direction === 'BUY' ? '#00c853' : '#ff1744'
  const convColor = row.conviction >= 80 ? 'text-accent-green' : row.conviction >= 60 ? 'text-accent-cyan' : row.conviction >= 50 ? 'text-accent-amber' : 'text-neutral-500'
  const stars = starsForScore(row.conviction)
  return (
    <>
      <tr
        onClick={() => setOpen(o => !o)}
        className="border-t border-ink-500 hover:bg-ink-700 cursor-pointer font-mono"
      >
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <b className="text-neutral-200">{row.symbol}</b>
            <Stars count={stars} className="text-[10px]" />
          </div>
        </td>
        <td className="px-3 py-2 text-right">
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
        <td className="px-3 py-2 text-center">
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>
            {row.direction}
          </span>
        </td>
        <td className={clsx('px-3 py-2 text-center font-bold', convColor)}>{row.conviction}</td>
        <td className="px-3 py-2 text-right text-accent-cyan">
          {row.entryPriceLow != null && row.entryPriceHigh != null
            ? <>₹{row.entryPriceLow}–{row.entryPriceHigh}</>
            : <>₹{row.entryPrice}</>}
        </td>
        <td className="px-3 py-2 text-center text-accent-cyan text-[10px]">{shortDate(row.entryDate)}</td>
        <td className="px-3 py-2 text-center text-accent-cyan text-[10px]">
          {row.bestEntryTimeIST ? (
            <>
              <div className="font-mono">{row.bestEntryTimeIST}</div>
              {row.horaLord && <div className="text-neutral-600 text-[9px]">{row.horaLord}</div>}
            </>
          ) : '—'}
        </td>
        <td className="px-3 py-2 text-right text-accent-red">₹{row.stopLoss}</td>
        <td className="px-3 py-2 text-right text-accent-green">₹{row.target1}</td>
        <td className="px-3 py-2 text-center text-accent-green text-[10px]">{shortDate(row.target1Date)}</td>
        <td className="px-3 py-2 text-right text-accent-green">₹{row.target2}</td>
        <td className="px-3 py-2 text-center text-accent-green text-[10px]">{shortDate(row.target2Date)}</td>
        <td className="px-3 py-2 text-right text-accent-green font-bold">₹{row.target3}</td>
        <td className="px-3 py-2 text-center text-accent-green text-[10px] font-semibold">{shortDate(row.target3Date)}</td>
        <td className="px-3 py-2 text-center">{row.riskRewardRatio}:1</td>
      </tr>
      {open && (
        <tr className="bg-ink-700 border-t border-ink-500">
          <td colSpan={15} className="px-4 py-3">
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
