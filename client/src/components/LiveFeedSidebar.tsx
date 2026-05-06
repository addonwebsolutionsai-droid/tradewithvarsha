import { useState } from 'react'
import { ChevronRight, MessageSquare, Trash2, X } from 'lucide-react'
import clsx from 'clsx'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import type { FeedEvent } from '../store'

/**
 * Right-side live trade feed — chat-style stream of new signals, daily-pick
 * additions, and trade lifecycle events (T1/T2/SL/EXPIRED).
 *
 * Collapses to a tab on the right edge when the user wants the canvas back.
 * Subscribed to the FeedEvent stream maintained by ws.ts.
 */
export function LiveFeedSidebar() {
  const [open, setOpen] = useState(true)
  const feed = useStore(s => s.feed)
  const clearFeed = useStore(s => s.clearFeed)

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed right-0 top-1/3 z-30 px-2 py-3 rounded-l-md bg-ink-700 border border-r-0 border-accent-cyan/40 text-accent-cyan hover:bg-ink-600 flex flex-col items-center gap-1 shadow-lg"
        title="Open live feed"
      >
        <MessageSquare size={14} />
        <span className="text-[9px] font-semibold tracking-wider [writing-mode:vertical-rl]">LIVE FEED</span>
        {feed.length > 0 && (
          <span className="text-[9px] px-1 py-0.5 rounded-full bg-accent-cyan text-ink-900 font-bold">{feed.length}</span>
        )}
      </button>
    )
  }

  return (
    <aside className="fixed right-0 top-[120px] bottom-0 w-[300px] bg-ink-800 border-l border-ink-500 flex flex-col z-30 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-ink-500 bg-ink-700">
        <div className="flex items-center gap-2 text-xs font-semibold text-neutral-200">
          <MessageSquare size={13} className="text-accent-cyan" />
          Live Feed
          <span className="text-[10px] text-neutral-500 font-normal">({feed.length})</span>
        </div>
        <div className="flex gap-1">
          {feed.length > 0 && (
            <button onClick={clearFeed} className="text-neutral-500 hover:text-neutral-200 p-1" title="Clear feed">
              <Trash2 size={12} />
            </button>
          )}
          <button onClick={() => setOpen(false)} className="text-neutral-500 hover:text-neutral-200 p-1" title="Hide feed">
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {feed.length === 0 ? (
          <div className="p-4 text-[11px] text-neutral-600 leading-relaxed">
            <div className="font-semibold text-neutral-500 mb-2">Waiting for live events…</div>
            New signals, daily-pick additions, and trade hits (T1/T2/SL) will appear here as they fire.
            Stays in sync with the engine via WebSocket.
          </div>
        ) : (
          <div>{feed.map(e => <FeedItem key={e.id} event={e} />)}</div>
        )}
      </div>
    </aside>
  )
}

function FeedItem({ event }: { event: FeedEvent }) {
  const navigate = useNavigate()
  const time = new Date(event.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })

  if (event.kind === 'NEW_SIGNAL') {
    const s = event.signal
    const dirColor = s.direction === 'BUY' ? '#00c853' : '#ff1744'
    return (
      <div
        onClick={() => navigate(routeForSignal(s))}
        className="px-3 py-2 border-b border-ink-500 hover:bg-ink-700 cursor-pointer"
        style={{ borderLeft: `3px solid ${dirColor}` }}
      >
        <div className="flex items-center gap-2 mb-0.5">
          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>
            NEW {s.direction}
          </span>
          <span className="text-xs font-semibold text-neutral-200">{s.instrument}</span>
          <span className="ml-auto text-[10px] text-neutral-600">{time}</span>
        </div>
        <div className="text-[10px] text-neutral-500 font-mono">
          {s.type} · grade {s.grade} · score {s.score} · entry ₹{s.entry}
        </div>
        <div className="text-[10px] text-neutral-600 mt-0.5 truncate">
          T1 ₹{s.target1} · SL ₹{s.stopLoss}
          <ChevronRight size={9} className="inline ml-1" />
        </div>
      </div>
    )
  }

  if (event.kind === 'DAILY_PICK_NEW') {
    return (
      <div
        onClick={() => navigate('/picks/daily')}
        className="px-3 py-2 border-b border-ink-500 hover:bg-ink-700 cursor-pointer border-l-[3px] border-l-accent-violet"
      >
        <div className="flex items-center gap-2 mb-0.5">
          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-accent-violet/15 text-accent-violet">
            🤖 DAILY PICK · {event.symbols.length} NEW
          </span>
          <span className="ml-auto text-[10px] text-neutral-600">{time}</span>
        </div>
        <div className="text-[11px] text-neutral-300 mt-0.5">
          {event.symbols.slice(0, 4).join(', ')}{event.symbols.length > 4 ? ` +${event.symbols.length - 4}` : ''}
        </div>
        <div className="text-[10px] text-neutral-600 mt-0.5">View Daily Pick <ChevronRight size={9} className="inline" /></div>
      </div>
    )
  }

  // TRADE_HIT
  const k = event.eventKind
  const meta = {
    T1_HIT:      { icon: '🎯', label: 'T1 hit',     color: '#00c853' },
    T2_HIT:      { icon: '🚀', label: 'T2 hit',     color: '#00e676' },
    SL_HIT:      { icon: '❌', label: 'SL hit',     color: '#ff1744' },
    EXPIRED:     { icon: '⏰', label: 'Expired',    color: '#94a3b8' },
    INVALIDATED: { icon: '🚫', label: 'Cancelled',  color: '#ffa726' },
  }[k]
  return (
    <div className="px-3 py-2 border-b border-ink-500 hover:bg-ink-700 cursor-pointer" style={{ borderLeft: `3px solid ${meta.color}` }}>
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded text-[9px] font-bold" style={{ background: `${meta.color}22`, color: meta.color }}>
          {meta.icon} {meta.label}
        </span>
        <span className="text-xs font-semibold text-neutral-200">{event.symbol}</span>
        <span className={clsx('ml-auto text-[11px] font-mono font-bold', event.pnlPct >= 0 ? 'text-accent-green' : 'text-accent-red')}>
          {event.pnlPct >= 0 ? '+' : ''}{event.pnlPct.toFixed(2)}%
        </span>
      </div>
      <div className="text-[10px] text-neutral-600 mt-0.5">{time} · 100 qty P&amp;L tracked in CSV</div>
    </div>
  )
}

function routeForSignal(s: { type: string }): string {
  return s.type === 'INTRADAY' ? '/signals/intraday'
       : s.type === 'OPTIONS'  ? '/signals/options'
       : s.type === 'SWING'    ? '/signals/swing'
       : s.type === 'COMMODITY'? '/signals/commodity'
       : '/signals/all'
}
