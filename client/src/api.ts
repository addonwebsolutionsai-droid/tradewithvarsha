import type { AstroBias, BacktestResult, GannBias, Health, MarketIndex, OIAnalysis, OptionChain, Signal } from './types'

// In dev, vite proxy handles /api → localhost:4000. In production (Vercel)
// the build can set VITE_API_URL to a backend URL OR leave it blank — when
// VITE_PUBLIC_MODE=true and no live backend, the 3 public tabs read from
// static JSON snapshots hosted at VITE_SNAPSHOT_BASE_URL (e.g. raw GitHub).
const API = (import.meta as any).env?.VITE_API_URL || ''
// 2026-05-22: SNAPSHOT_BASE falls back to the GitHub raw URL so localhost dev
// (where no .env.development exists) can still load Track Record + other
// public snapshot pages. Previously this was empty in dev → "Couldn't load"
// error on /track-record. Now the same data Vercel reads is also available
// locally without any env setup.
const SNAPSHOT_BASE = (import.meta as any).env?.VITE_SNAPSHOT_BASE_URL
  || 'https://raw.githubusercontent.com/addonwebsolutionsai-droid/tradewithvarsha/main/server/data/public-snapshots'
const PUBLIC_MODE = (import.meta as any).env?.VITE_PUBLIC_MODE === 'true'

// Auth token in localStorage — attached as Bearer header automatically.
const TOKEN_KEY = 'hf-auth-token'
export const auth = {
  getToken: () => localStorage.getItem(TOKEN_KEY) || '',
  setToken: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
}

/** Snapshot fetcher — returns raw JSON from VITE_SNAPSHOT_BASE_URL/<file>. */
async function snapshot<T>(file: string): Promise<T> {
  if (!SNAPSHOT_BASE) throw new Error('VITE_SNAPSHOT_BASE_URL not configured')
  const res = await fetch(`${SNAPSHOT_BASE}/${file}?t=${Date.now()}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`snapshot ${file} → ${res.status}`)
  return res.json() as Promise<T>
}

export const isPublicMode = (): boolean => PUBLIC_MODE
export const snapshots = {
  weeklyPick: () => snapshot<{ generatedAt: string; weekOf: string; regime: string; rows: any[] }>('weekly-pick.json'),
  dailyPick: () => snapshot<{ generatedAt: string; regime: string; rows: any[] }>('daily-pick.json'),
  preMove: () => snapshot<{ generatedAt: string; rows: any[] }>('pre-move.json'),
  options: () => snapshot<{ generatedAt: string; rows: any[] }>('options.json'),
  intraday: () => snapshot<{ generatedAt: string; rows: any[] }>('intraday.json'),
  hitLog: () => snapshot<{ generatedAt: string; entries: any[] }>('hit-log.json'),
  topTrades: () => snapshot<{ generatedAt: string; filterMinConv: number; totalAvailable: number; rows: any[] }>('top-trades.json'),
  accuracy: () => snapshot<{ generatedAt: string; daysBack: number; total: number; byStatus: Record<string, number>; triggeredRate: number; winRate: number; slRate: number; avgRMultiple: number; bySource: any; byConvictionTier: any }>('accuracy.json'),
  signalsHistory: () => snapshot<{ generatedAt: string; total: number; signals: any[] }>('signals-history.json'),
  preMoveIdentifier: () => snapshot<{ generatedAt: string; universeSize: number; evaluated: number; qualityPassed: number; candidates: any[]; tier1Count: number; tier2Count: number; tier3Count: number; notes: string[] }>('pre-move-identifier.json'),
  oiBuildup: () => snapshot<{ generatedAt: string; symbols: string[]; summary: any[]; rows: any[] }>('oi-buildup.json'),
  fnoFutures: () => snapshot<{ generatedAt: string; universeSize: number; total: number; highConvCount: number; medConvCount: number; rows: any[] }>('fno-futures.json'),
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers || {})
  const t = auth.getToken()
  if (t) headers.set('Authorization', `Bearer ${t}`)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await fetch(`${API}${path}`, { ...init, headers })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  health: () => j<Health>('/api/health'),
  diagnose: () => j<{ healthy: boolean; checks: { service: string; ok: boolean; note?: string }[] }>('/api/diagnose'),
  signals: (params?: { type?: string; grade?: string; minScore?: number }) => {
    const q = new URLSearchParams()
    if (params?.type) q.set('type', params.type)
    if (params?.grade) q.set('grade', params.grade)
    if (params?.minScore != null) q.set('minScore', String(params.minScore))
    return j<{ signals: Signal[]; count: number }>(`/api/signals${q.toString() ? '?' + q : ''}`)
  },
  refreshSignals: () => j<{ signals: Signal[]; count: number }>('/api/signals/refresh', { method: 'POST' }),
  refreshAll: () => j<{ accepted: boolean; runId: string; startedAt: string; clicksRemaining: number }>('/api/refresh-all', { method: 'POST' }),
  refreshAllStatus: () => j<{ allowed: boolean; reason?: string; remaining: number; resetInSec?: number }>('/api/refresh-all/status'),
  signalForSymbol: (symbol: string) => j<{ signals: Signal[]; count: number }>(`/api/signal/${symbol}`),
  indices: () => j<{ indices: MarketIndex[] }>('/api/market/indices'),
  optionChain: (symbol: 'NIFTY' | 'BANKNIFTY') =>
    j<{ chain: OptionChain; analysis: OIAnalysis }>(`/api/options/${symbol}`),
  gann: (symbol: string, price?: number) => {
    const q = new URLSearchParams({ symbol })
    if (price) q.set('price', String(price))
    return j<{ symbol: string; bias: GannBias }>(`/api/gann?${q}`)
  },
  astro: (date?: string) => {
    const q = date ? `?date=${date}` : ''
    return j<{ date: string; bias: AstroBias }>(`/api/astro${q}`)
  },
  backtestSuite: () => j<{ results: BacktestResult[] }>('/api/backtest/suite'),
  backtest: (symbol: string, strategy: string, tf = '1D') =>
    j<BacktestResult>(`/api/backtest?symbol=${symbol}&strategy=${strategy}&tf=${tf}`),
  candles: (symbol: string, tf = '15m', count = 80) =>
    j<{ symbol: string; timeframe: string; candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[]; count: number }>(
      `/api/candles/${symbol}?tf=${tf}&count=${count}`,
    ),
  botStatus: () => j<{ running: boolean; configured: boolean; chatIds: number; startedAt: string | null }>('/api/bot/status'),

  // Top trades — single curated stream, ≥85 conviction, deduped by symbol.
  topTrades: (minConv = 85, limit = 20) =>
    j<{ generatedAt: string; filterMinConv: number; totalAvailable: number; rows: any[] }>(
      `/api/top-trades?minConv=${minConv}&limit=${limit}`,
    ),

  // Auth
  signup: (email: string, password: string) =>
    j<{ ok: boolean; error?: string; token?: string; user?: any }>('/api/auth/signup', {
      method: 'POST', body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    j<{ ok: boolean; error?: string; token?: string; user?: { email: string; isAdmin: boolean; expiryAt?: string; allowedTabs?: string[] } }>('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    }),
  me: () =>
    j<{ email: string; isAdmin: boolean; isActive: boolean; expiryAt?: string; allowedTabs: string[]; signupAt: string; lastLoginAt?: string }>('/api/auth/me'),
  logout: () => { auth.clear(); return j<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }) },
  changePassword: (oldPassword: string, newPassword: string) =>
    j<{ ok: boolean; error?: string }>('/api/auth/change-password', {
      method: 'POST', body: JSON.stringify({ oldPassword, newPassword }),
    }),
  adminUsers: () =>
    j<{ users: Array<{ email: string; isAdmin: boolean; isActive: boolean; expiryAt?: string; allowedTabs: string[]; signupAt: string; lastLoginAt?: string }> }>('/api/admin/users'),
  adminUpdateUser: (email: string, patch: { isActive?: boolean; expiryAt?: string | null; allowedTabs?: string[] }) =>
    j<{ ok: boolean; error?: string }>('/api/admin/user', {
      method: 'POST', body: JSON.stringify({ email, ...patch }),
    }),
}
