import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X, RefreshCw, ArrowUpRight, ArrowDownRight } from 'lucide-react'
import clsx from 'clsx'

/**
 * Symbols — personal watchlist with live snapshot per stock.
 *
 * Persisted in localStorage. For each symbol we fetch:
 *   - latest price + day change (from /api/price/:symbol)
 *   - any active signal (from /api/signal/:symbol — runs strategies on demand)
 *
 * Designed as the landing tab of the Investment section so users can keep
 * their personal-interest list separate from system-curated picks.
 */

const STORAGE_KEY = 'symbolWatchlist'
const DEFAULT_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'HDFCBANK', 'INFY', 'TCS', 'ITC', 'ICICIBANK']

export function SymbolsPage() {
  const qc = useQueryClient()
  const [symbols, setSymbols] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) return JSON.parse(raw)
    } catch { /* ignore */ }
    return DEFAULT_SYMBOLS
  })
  const [adding, setAdding] = useState('')

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols))
  }, [symbols])

  const add = () => {
    const s = adding.trim().toUpperCase()
    if (!s || symbols.includes(s)) return
    setSymbols([...symbols, s])
    setAdding('')
  }

  const remove = (sym: string) => setSymbols(symbols.filter(s => s !== sym))

  const refresh = () => qc.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'sym' })

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="flex items-start gap-3">
          <div className="text-2xl">📋</div>
          <div>
            <div className="text-sm font-semibold text-neutral-200">Symbols · Your watchlist</div>
            <div className="text-xs text-neutral-500 mt-1">
              Persistent local list (browser storage). Fresh price + on-demand strategy run per symbol.
              Add anything from NSE — small-caps fall back to Yahoo if Angel doesn't cover them.
            </div>
          </div>
        </div>
        <button onClick={refresh} className="text-xs px-2 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 inline-flex items-center gap-1">
          <RefreshCw size={12} /> Refresh prices
        </button>
      </div>

      {/* Add box */}
      <div className="flex gap-2">
        <input
          value={adding}
          onChange={e => setAdding(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          placeholder="Add NSE symbol — e.g. JINKUSHAL, ABB, SAIL"
          className="flex-1 bg-ink-700 border border-ink-500 rounded px-3 py-2 text-xs font-mono text-neutral-200 focus:outline-none focus:border-accent-cyan"
        />
        <button onClick={add} className="text-xs px-3 py-2 rounded bg-accent-green/15 text-accent-green hover:bg-accent-green/25 inline-flex items-center gap-1">
          <Plus size={12} /> Add
        </button>
      </div>

      {/* Watchlist table */}
      <div className="overflow-x-auto bg-ink-700 border border-ink-500 rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-ink-800 text-neutral-400">
            <tr>
              <th className="text-left px-3 py-2">Symbol</th>
              <th className="text-right px-3 py-2">LTP</th>
              <th className="text-right px-3 py-2">Day change</th>
              <th className="text-center px-3 py-2">Signal</th>
              <th className="text-right px-3 py-2">Entry</th>
              <th className="text-right px-3 py-2 text-accent-red">SL</th>
              <th className="text-right px-3 py-2 text-accent-green">T1</th>
              <th className="text-center px-3 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {symbols.map(s => <SymbolRow key={s} symbol={s} onRemove={() => remove(s)} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SymbolRow({ symbol, onRemove }: { symbol: string; onRemove: () => void }) {
  const price = useQuery<any>({
    queryKey: ['sym', 'price', symbol],
    queryFn: async () => {
      const r = await fetch(`/api/price/${symbol}`)
      if (!r.ok) return null
      return r.json()
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  const sig = useQuery<any>({
    queryKey: ['sym', 'signal', symbol],
    queryFn: async () => {
      const r = await fetch(`/api/signal/${symbol}`)
      if (!r.ok) return { signals: [] }
      return r.json()
    },
    staleTime: 5 * 60_000,
  })

  const p = price.data
  const top = sig.data?.signals?.[0]
  const change = p?.change ?? 0
  const changePct = p?.changePct ?? 0

  return (
    <tr className="border-t border-ink-500 hover:bg-ink-700 font-mono">
      <td className="px-3 py-2 font-bold text-neutral-200">{symbol}</td>
      <td className="px-3 py-2 text-right">
        {p ? `₹${p.price?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
      </td>
      <td className={clsx('px-3 py-2 text-right text-[11px]', change >= 0 ? 'text-accent-green' : 'text-accent-red')}>
        {p ? <>{change >= 0 ? <ArrowUpRight size={11} className="inline" /> : <ArrowDownRight size={11} className="inline" />} {change >= 0 ? '+' : ''}{change.toFixed(2)} ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)</> : '—'}
      </td>
      <td className="px-3 py-2 text-center">
        {top ? (
          <span className={clsx('text-[10px] px-1.5 py-0.5 rounded font-bold',
            top.direction === 'BUY' ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red')}>
            {top.direction} {top.grade}
          </span>
        ) : (
          <span className="text-[10px] text-neutral-600">— no signal</span>
        )}
      </td>
      <td className="px-3 py-2 text-right text-[11px]">{top ? `₹${top.entry}` : '—'}</td>
      <td className="px-3 py-2 text-right text-[11px] text-accent-red">{top ? `₹${top.stopLoss}` : '—'}</td>
      <td className="px-3 py-2 text-right text-[11px] text-accent-green">{top ? `₹${top.target1}` : '—'}</td>
      <td className="px-3 py-2 text-center">
        <button onClick={onRemove} className="text-neutral-500 hover:text-accent-red"><X size={12} /></button>
      </td>
    </tr>
  )
}
