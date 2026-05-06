import { create } from 'zustand'
import type { MarketIndex, Signal } from './types'

export type Theme = 'dark' | 'light'

/** Live event stream surfaced in the right-side LiveFeedSidebar. */
export type FeedEvent =
  | { id: string; kind: 'NEW_SIGNAL'; signal: Signal; ts: number }
  | { id: string; kind: 'DAILY_PICK_NEW'; symbols: string[]; pickGeneratedAt: string; ts: number }
  | { id: string; kind: 'TRADE_HIT'; symbol: string; eventKind: 'T1_HIT'|'T2_HIT'|'SL_HIT'|'EXPIRED'|'INVALIDATED'; pnlPct: number; ts: number }

const FEED_MAX = 60

interface AppState {
  signals: Signal[]
  indices: MarketIndex[]
  connected: boolean
  marketOpen: boolean
  lastUpdate: number
  pcr: number
  maxPain: number
  spot: number
  ticks: Record<string, { ltp: number; ts: number }>
  theme: Theme
  feed: FeedEvent[]

  setSignals: (signals: Signal[]) => void
  pushFeed: (e: FeedEvent) => void
  clearFeed: () => void
  setIndices: (indices: MarketIndex[]) => void
  setConnected: (c: boolean) => void
  setMarketOpen: (m: boolean) => void
  setOIUpdate: (data: { pcr: number; maxPain: number; spot: number }) => void
  setTick: (token: string, ltp: number, ts: number) => void
  touchUpdate: () => void
  setTheme: (t: Theme) => void
}

const initialTheme: Theme = (() => {
  try {
    const stored = localStorage.getItem('theme')
    if (stored === 'light' || stored === 'dark') return stored
  } catch { /* ignore */ }
  return 'dark'
})()

if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = initialTheme
}

export const useStore = create<AppState>((set) => ({
  signals: [],
  indices: [],
  connected: false,
  marketOpen: false,
  lastUpdate: Date.now(),
  pcr: 0,
  maxPain: 0,
  spot: 0,
  ticks: {},
  theme: initialTheme,
  feed: [],
  setSignals: (signals) => set({ signals, lastUpdate: Date.now() }),
  pushFeed: (e) => set(state => ({ feed: [e, ...state.feed].slice(0, FEED_MAX) })),
  clearFeed: () => set({ feed: [] }),
  setIndices: (indices) => set({ indices }),
  setConnected: (connected) => set({ connected }),
  setMarketOpen: (marketOpen) => set({ marketOpen }),
  setOIUpdate: (d) => set({ pcr: d.pcr, maxPain: d.maxPain, spot: d.spot }),
  setTick: (token, ltp, ts) =>
    set(state => ({ ticks: { ...state.ticks, [token]: { ltp, ts } } })),
  touchUpdate: () => set({ lastUpdate: Date.now() }),
  setTheme: (theme) => {
    try { localStorage.setItem('theme', theme) } catch { /* ignore */ }
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme
    set({ theme })
  },
}))
