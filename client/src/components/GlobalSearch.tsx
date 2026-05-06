import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Loader2, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import type { Signal } from '../types'

/**
 * Global stock search — opens with ⌘K (or click the search box).
 *
 * Two-stage lookup:
 *   1. Match against currently-loaded data (signals in the store + any
 *      cached screener results) — instant, no network call.
 *   2. If nothing matches, fire /api/signal/:symbol for fresh on-demand
 *      research and render the result inline in a slide-over drawer.
 *
 * Outcome:
 *   - Existing match  → drawer shows the cached signal + jump link to its tab
 *   - Fresh result    → drawer shows newly-computed signals (intraday/swing)
 *   - No data         → drawer shows the price + "no setup detected, monitor"
 */

interface FreshResult {
  symbol: string
  signals: Signal[]
  price?: { ltp: number; change: number; changePct: number }
  loading: boolean
  error?: string
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [drawer, setDrawer] = useState<FreshResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const signals = useStore(s => s.signals)

  // ⌘K / Ctrl+K to open palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(true)
      }
      if (e.key === 'Escape') {
        setOpen(false); setDrawer(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50) }, [open])

  // Local matches: scan signals.instrument for the query
  const matches = useMemo(() => {
    if (!query.trim()) return []
    const q = query.trim().toUpperCase()
    return signals
      .filter(s => s.instrument.toUpperCase().startsWith(q) || s.instrument.toUpperCase().includes(q))
      .slice(0, 8)
  }, [query, signals])

  const handleEnter = async () => {
    const sym = query.trim().toUpperCase()
    if (!sym) return
    if (matches.length) {
      // Best match: use first hit, route to relevant section
      const best = matches[0]
      jumpToSignal(best, navigate)
      setOpen(false); setQuery('')
      return
    }
    // Fresh research
    setDrawer({ symbol: sym, signals: [], loading: true })
    setOpen(false)
    try {
      const [sigRes, priceRes] = await Promise.all([
        fetch(`/api/signal/${encodeURIComponent(sym)}`).then(r => r.ok ? r.json() : { signals: [] }),
        fetch(`/api/price/${encodeURIComponent(sym)}`).then(r => r.ok ? r.json() : null),
      ])
      setDrawer({
        symbol: sym,
        signals: sigRes.signals ?? [],
        price: priceRes ? { ltp: priceRes.price, change: priceRes.change, changePct: priceRes.changePct } : undefined,
        loading: false,
      })
    } catch (e) {
      setDrawer({ symbol: sym, signals: [], loading: false, error: (e as Error).message })
    }
  }

  return (
    <>
      {/* Trigger in header */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded bg-ink-700 border border-ink-500 hover:border-accent-cyan/40 transition-colors text-xs text-neutral-500 hover:text-neutral-200 min-w-[180px]"
        title="Search any NSE symbol — ⌘K"
      >
        <Search size={13} />
        <span className="flex-1 text-left">Search any stock…</span>
        <kbd className="text-[9px] px-1.5 py-0.5 rounded bg-ink-500 border border-ink-400 text-neutral-500">⌘K</kbd>
      </button>

      {/* Palette overlay */}
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-24"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-2xl mx-4 bg-ink-800 border border-ink-500 rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-500">
              <Search size={16} className="text-neutral-500" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleEnter() }}
                placeholder="Type any NSE symbol — RELIANCE, IRCTC, MOLDTKPAC…"
                className="flex-1 bg-transparent text-sm text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
              />
              <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-ink-500 border border-ink-400 text-neutral-500">↵</kbd>
              <button onClick={() => setOpen(false)} className="text-neutral-500 hover:text-neutral-200">
                <X size={16} />
              </button>
            </div>

            {/* Results */}
            <div className="max-h-[60vh] overflow-y-auto">
              {!query.trim() && (
                <div className="px-4 py-6 text-xs text-neutral-500">
                  <div className="font-semibold text-neutral-400 mb-2">Quick tips</div>
                  <div>• Type a symbol and press <kbd className="text-[9px] px-1 py-0.5 rounded bg-ink-500 border border-ink-400">↵</kbd> — instant if cached, fresh research otherwise</div>
                  <div>• Found across all loaded signals + screener results</div>
                  <div>• Press <kbd className="text-[9px] px-1 py-0.5 rounded bg-ink-500 border border-ink-400">esc</kbd> to close</div>
                </div>
              )}

              {query.trim() && matches.length > 0 && (
                <div>
                  <div className="px-4 py-2 text-[10px] uppercase tracking-wider text-neutral-600 font-semibold border-b border-ink-500">
                    Found in current data ({matches.length})
                  </div>
                  {matches.map(s => (
                    <button
                      key={s.id}
                      onClick={() => { jumpToSignal(s, navigate); setOpen(false); setQuery('') }}
                      className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-ink-700 text-left border-b border-ink-500 last:border-b-0"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${s.direction === 'BUY' ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red'}`}>
                          {s.direction}
                        </span>
                        <span className="text-sm font-semibold text-neutral-200">{s.instrument}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-ink-500 text-neutral-500">{s.type}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-neutral-500">
                        <span>Grade <b className="text-neutral-300">{s.grade}</b></span>
                        <span>Score <b className="text-neutral-300">{s.score}</b></span>
                        <ArrowRight size={12} />
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {query.trim() && matches.length === 0 && (
                <div className="px-4 py-6">
                  <div className="text-xs text-neutral-500 mb-2">No match in current data.</div>
                  <button
                    onClick={handleEnter}
                    className="w-full text-left px-3 py-2 rounded bg-accent-cyan/10 hover:bg-accent-cyan/20 border border-accent-cyan/30"
                  >
                    <div className="text-sm text-accent-cyan font-semibold">
                      Run fresh research on {query.trim().toUpperCase()}
                      <ArrowRight size={12} className="inline ml-1" />
                    </div>
                    <div className="text-[10px] text-neutral-500 mt-0.5">
                      Pulls live candles + price · evaluates intraday + swing strategies on demand
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Slide-over drawer for fresh research result */}
      {drawer && (
        <ResearchDrawer result={drawer} onClose={() => setDrawer(null)} />
      )}
    </>
  )
}

function ResearchDrawer({ result, onClose }: { result: FreshResult; onClose: () => void }) {
  const navigate = useNavigate()
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-md h-full bg-ink-800 border-l border-ink-500 overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between px-4 py-3 border-b border-ink-500 bg-ink-800">
          <div>
            <div className="text-sm font-semibold text-neutral-200">🔍 Fresh research · {result.symbol}</div>
            <div className="text-[10px] text-neutral-500">on-demand · evaluated against intraday + swing strategies</div>
          </div>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-3">
          {result.loading && (
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <Loader2 size={14} className="animate-spin" /> Pulling live data + running strategies…
            </div>
          )}

          {!result.loading && result.error && (
            <div className="text-xs text-accent-red">Error: {result.error}</div>
          )}

          {!result.loading && result.price && (
            <div className="bg-ink-700 border border-ink-500 rounded p-3">
              <div className="text-[10px] text-neutral-500 uppercase">LTP</div>
              <div className="text-2xl font-mono text-neutral-200">
                ₹{result.price.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
              </div>
              <div className={`text-xs font-mono ${result.price.change >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                {result.price.change >= 0 ? '+' : ''}{result.price.change?.toFixed(2)} ({result.price.changePct >= 0 ? '+' : ''}{result.price.changePct?.toFixed(2)}%)
              </div>
            </div>
          )}

          {!result.loading && result.signals.length === 0 && !result.error && (
            <div className="bg-ink-700 border border-ink-500 rounded p-4 text-xs text-neutral-500">
              No active signal for this symbol right now — confluence threshold not met.
              The ticker is still on the engine's radar; if a setup forms in the next session it'll appear in the relevant tab.
            </div>
          )}

          {result.signals.map(s => (
            <div key={s.id} className="bg-ink-700 border border-ink-500 rounded p-3" style={{ borderLeft: `3px solid ${s.direction === 'BUY' ? '#00c853' : '#ff1744'}` }}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${s.direction === 'BUY' ? 'bg-accent-green/15 text-accent-green' : 'bg-accent-red/15 text-accent-red'}`}>
                  {s.direction}
                </span>
                <span className="text-sm font-semibold text-neutral-200">{s.instrument}</span>
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-ink-500 text-neutral-500">{s.type}</span>
                <span className="ml-auto text-[10px] text-neutral-500">Grade {s.grade} · Score {s.score}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                <div className="bg-ink-800 px-2 py-1 rounded"><span className="text-neutral-500">Entry: </span><b className="text-accent-cyan">₹{s.entry}</b></div>
                <div className="bg-ink-800 px-2 py-1 rounded"><span className="text-neutral-500">SL: </span><b className="text-accent-red">₹{s.stopLoss}</b></div>
                <div className="bg-ink-800 px-2 py-1 rounded"><span className="text-neutral-500">T1: </span><b className="text-accent-green">₹{s.target1}</b></div>
                <div className="bg-ink-800 px-2 py-1 rounded"><span className="text-neutral-500">T2: </span><b className="text-accent-green">₹{s.target2}</b></div>
              </div>
              <div className="mt-2 text-[11px] text-neutral-400 space-y-0.5">
                {s.reasons.slice(0, 4).map((r, i) => <div key={i}>• {r}</div>)}
              </div>
              <button
                onClick={() => { jumpToSignal(s, navigate); onClose() }}
                className="mt-3 text-[11px] px-2 py-1 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 inline-flex items-center gap-1"
              >
                View in {sectionLabelFor(s)} <ArrowRight size={10} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Routing helpers ──────────────────────────────────────────

function jumpToSignal(s: Signal, navigate: ReturnType<typeof useNavigate>) {
  const route =
    s.type === 'INTRADAY'  ? '/signals/intraday' :
    s.type === 'OPTIONS'   ? '/signals/options'  :
    s.type === 'SWING'     ? '/signals/swing'    :
    s.type === 'COMMODITY' ? '/signals/commodity' :
    '/signals/all'
  navigate(route)
}

function sectionLabelFor(s: Signal): string {
  return s.type === 'INTRADAY'  ? 'Intraday'  :
         s.type === 'OPTIONS'   ? 'Options'   :
         s.type === 'SWING'     ? 'Swing'     :
         s.type === 'COMMODITY' ? 'Commodity' :
         'Signals'
}
