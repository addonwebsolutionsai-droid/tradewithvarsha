import { useState, useEffect } from 'react'
import { Circle, MessageSquare, Moon, RefreshCw, Settings, Sun, Zap, User as UserIcon, LogOut, Shield } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { api, auth } from '../api'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import type { Health } from '../types'
import { GlobalSearch } from './GlobalSearch'

// 2026-05-07: PUBLIC_MODE strips out every backend-touching button + indicator
// because the deployed frontend has no API to call. Status badges are
// replaced with a static "Snapshot mode" pill.
const PUBLIC_MODE = (import.meta as any).env?.VITE_PUBLIC_MODE === 'true'

export function Header({ botRunning, health }: { botRunning: boolean; health?: Health }) {
  const { connected, marketOpen, lastUpdate, theme, setTheme } = useStore()
  const qc = useQueryClient()
  const dataMode = health?.dataMode ?? (marketOpen ? 'LIVE' : 'SNAPSHOT')
  const asOf = health?.asOf
  const watch = health?.watch ?? 0
  const live = health?.live ?? 0
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [remainingClicks, setRemainingClicks] = useState<number | null>(null)

  // Poll status so the button shows accurate remaining-click count
  useEffect(() => {
    if (PUBLIC_MODE) return                 // skip — no backend on public deploy
    let cancelled = false
    const tick = async () => {
      try {
        const s = await api.refreshAllStatus()
        if (!cancelled) setRemainingClicks(s.remaining)
      } catch { /* ignore */ }
    }
    tick()
    const iv = setInterval(tick, 30_000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [])

  const refresh = async () => {
    try {
      toast.loading('Refreshing signals...', { id: 'refresh' })
      const r = await api.refreshSignals()
      toast.success(`Refreshed — ${r.count} signals`, { id: 'refresh' })
    } catch (e) {
      toast.error(`Refresh failed: ${(e as Error).message}`, { id: 'refresh' })
    }
  }

  const refreshAll = async () => {
    if (refreshingAll) return
    setRefreshingAll(true)
    toast.loading('Full sweep started — running 9 tasks in parallel…', { id: 'refresh-all', duration: 300_000 })
    try {
      const r = await api.refreshAll()
      setRemainingClicks(r.clicksRemaining)
      // Listen for the broadcast completion event from WebSocket — fires when
      // background sweep finishes (up to ~3 min on cold ScripMaster).
      const onComplete = (msg: any) => {
        if (msg.type === 'REFRESH_ALL_COMPLETE' && msg.runId === r.runId) {
          const total = (msg.results as any[]).reduce((s, x) => s + (x?.count ?? 0), 0)
          toast.success(`Refresh complete — ${total} items in ${(msg.tookMs / 1000).toFixed(1)}s · ${msg.clicksRemaining} clicks left today`, {
            id: 'refresh-all', duration: 5000,
          })
          setRefreshingAll(false)
          setRemainingClicks(msg.clicksRemaining)
          qc.invalidateQueries()
          window.removeEventListener('hedgefund:ws', handler as any)
        } else if (msg.type === 'REFRESH_ALL_PROGRESS' && msg.runId === r.runId) {
          // Toast text update — show last completed task
          const t = msg.task
          toast.loading(`Sweep progress · ${t.name}${t.count != null ? ` (${t.count})` : t.error ? ' ❌' : ''}`, { id: 'refresh-all', duration: 300_000 })
        }
      }
      const handler = (e: Event) => onComplete((e as CustomEvent).detail)
      window.addEventListener('hedgefund:ws', handler as any)
    } catch (e) {
      const msg = (e as Error).message
      toast.error(`Refresh-all: ${msg}`, { id: 'refresh-all', duration: 6000 })
      api.refreshAllStatus().then(s => setRemainingClicks(s.remaining)).catch(() => {})
      setRefreshingAll(false)
    }
  }

  return (
    <header className="h-[52px] border-b border-ink-500 bg-ink-800 px-5 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full ${marketOpen ? 'bg-accent-green pulse-dot' : 'bg-accent-amber'}`} />
        <span className="font-bold text-white">📈 Tradewithvarsha</span>
        {!PUBLIC_MODE && <span className="text-[11px] px-2 py-0.5 rounded border border-accent-magenta/50 bg-accent-magenta/10 text-accent-magenta">PRO</span>}
        {!PUBLIC_MODE && dataMode === 'SNAPSHOT' && (
          <span
            className="text-[11px] px-2 py-0.5 rounded border border-accent-amber/50 bg-accent-amber/10 text-accent-amber"
            title={asOf ? `Last close snapshot, asOf ${new Date(asOf).toLocaleString('en-IN')}` : 'Last close snapshot'}
          >
            SNAPSHOT · last close{asOf ? ` ${new Date(asOf).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        )}
      </div>
      {/* Global stock search — ⌘K — hidden in PUBLIC_MODE (no backend) */}
      {!PUBLIC_MODE && (
        <div className="flex-1 flex justify-center px-4 max-w-md">
          <GlobalSearch />
        </div>
      )}
      {PUBLIC_MODE && <div className="flex-1" />}
      <div className="flex items-center gap-4 text-xs text-neutral-500">
        {PUBLIC_MODE ? (
          <>
            <span
              className="text-[11px] px-2 py-0.5 rounded border border-accent-green/40 bg-accent-green/10 text-accent-green"
              title="Free public mode — picks refreshed every 30 minutes from the live trading engine"
            >
              ● Snapshot mode · auto-refresh 30m
            </span>
            <PublicUserMenu />
          </>
        ) : (
          <>
            <span className="flex items-center gap-1">
              <Circle size={8} className={connected ? 'fill-accent-green text-accent-green' : 'fill-accent-red text-accent-red'} />
              {connected ? (marketOpen ? 'Market Open' : 'Connected (closed)') : 'Disconnected'}
            </span>
            {(live > 0 || watch > 0) && (
              <span title="LIVE = current-session setups · WATCH = last-close bias for tabs while market is shut">
                <span className="text-accent-green">{live} LIVE</span>
                <span className="text-neutral-600"> · </span>
                <span className="text-accent-amber">{watch} WATCH</span>
              </span>
            )}
            <span className="flex items-center gap-1">
              <MessageSquare size={12} className={botRunning ? 'text-accent-cyan' : 'text-neutral-600'} />
              Bot: {botRunning ? 'online' : 'offline'}
            </span>
            <span>Updated {new Date(lastUpdate).toLocaleTimeString('en-IN')}</span>
            <button onClick={refresh} className="p-1 hover:text-accent-cyan transition-colors" title="Re-run signal engine only (fast)">
              <RefreshCw size={14} />
            </button>
            <button
              onClick={refreshAll}
              disabled={refreshingAll || remainingClicks === 0}
              className={
                'flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold transition-colors ' +
                (refreshingAll
                  ? 'bg-accent-amber/15 text-accent-amber cursor-wait'
                  : remainingClicks === 0
                    ? 'bg-ink-500 text-neutral-600 cursor-not-allowed'
                    : 'bg-accent-cyan/15 text-accent-cyan hover:bg-accent-cyan/25')
              }
              title={
                refreshingAll ? 'Full sweep in progress…' :
                remainingClicks === 0 ? 'Daily cap (10) reached — resets on rolling 24h window' :
                `Refresh EVERYTHING — signals · daily pick · screeners · regime. ${remainingClicks ?? '-'}/10 clicks left today.`
              }
            >
              <Zap size={12} className={refreshingAll ? 'animate-pulse' : ''} />
              {refreshingAll ? 'Sweeping…' : 'Refresh All'}
              {remainingClicks != null && !refreshingAll && (
                <span className="text-[9px] text-neutral-500 ml-0.5">{remainingClicks}/10</span>
              )}
            </button>
          </>
        )}
        <button
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          className="p-1 hover:text-accent-cyan transition-colors"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        {!PUBLIC_MODE && (
          <a
            href="/preview"
            className="text-[10px] px-2 py-0.5 rounded border border-accent-violet/40 bg-accent-violet/10 text-accent-violet hover:bg-accent-violet/20"
            title="Preview the new light-theme dashboard (isolated — rollbackable)"
          >
            PREVIEW
          </a>
        )}
        {!PUBLIC_MODE && <Settings size={14} className="text-neutral-600" />}
      </div>
    </header>
  )
}

/** User menu shown only in PUBLIC_MODE — links to profile, admin (if admin),
 *  and logout. If logged out, shows Sign in / Sign up links. */
function PublicUserMenu(): JSX.Element {
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const { data, isError, refetch } = useQuery({
    queryKey: ['me'], queryFn: () => api.me(), retry: false,
    refetchOnWindowFocus: true,
  })
  useEffect(() => {
    function close(e: MouseEvent): void {
      const t = e.target as HTMLElement
      if (!t.closest('.usermenu-root')) setOpen(false)
    }
    if (open) document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  if (isError || !data) {
    return (
      <div className="flex items-center gap-2">
        <Link to="/login" className="text-[11px] px-2 py-1 rounded border border-accent-cyan/40 bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20">Sign in</Link>
        <Link to="/signup" className="text-[11px] px-2 py-1 rounded bg-accent-green text-white font-semibold hover:bg-accent-green/80">Sign up</Link>
      </div>
    )
  }

  return (
    <div className="usermenu-root relative">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded bg-ink-700 border border-ink-500 hover:bg-ink-600 text-neutral-200">
        <UserIcon size={12} />
        <span className="font-mono">{data.email}</span>
        {data.isAdmin && <span className="text-accent-amber text-[9px] font-bold">ADMIN</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] bg-ink-800 border border-ink-500 rounded shadow-lg py-1">
          <Link to="/profile" onClick={() => setOpen(false)} className="block px-3 py-2 text-[12px] text-neutral-200 hover:bg-ink-700"><UserIcon size={11} className="inline mr-1.5" />My Profile</Link>
          {data.isAdmin && (
            <Link to="/admin/users" onClick={() => setOpen(false)} className="block px-3 py-2 text-[12px] text-accent-amber hover:bg-ink-700"><Shield size={11} className="inline mr-1.5" />Manage Members</Link>
          )}
          <button onClick={() => { auth.clear(); setOpen(false); refetch(); nav('/login') }} className="block w-full text-left px-3 py-2 text-[12px] text-accent-red hover:bg-ink-700"><LogOut size={11} className="inline mr-1.5" />Sign out</button>
        </div>
      )}
    </div>
  )
}
