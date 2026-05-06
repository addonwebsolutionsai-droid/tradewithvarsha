/**
 * Vercel public-mode pages — TABLE format matching localhost. Reads static
 * JSON snapshots from raw.githubusercontent.com (no backend dependency).
 *
 * Above each table: a "Recent target hits" strip with green/red highlighted
 * cards so users can see realised outcomes and gauge accuracy.
 */
import { useQuery } from '@tanstack/react-query'
import { snapshots } from '../api'
import { useState } from 'react'

const fmtDate = (iso?: string) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : `${d.getDate()}/${d.getMonth() + 1}`
}
const fmtTs = (iso?: string) => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—'

// ── HIT-LOG STRIP ───────────────────────────────────────────────
function HitLog(): JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['hit-log'], queryFn: () => snapshots.hitLog(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const entries = (data?.entries ?? []).slice(0, 12)
  if (!entries.length) return null
  return (
    <section className="mb-4">
      <div className="text-[11px] font-semibold text-neutral-400 mb-2">
        🏁 Recent target hits — accuracy log
      </div>
      <div className="flex flex-wrap gap-2">
        {entries.map((e: any, i: number) => {
          const isWin = e.outcome === 'T1' || e.outcome === 'T2' || e.outcome === 'T3'
          const isLoss = e.outcome === 'SL'
          const bg = isWin ? 'bg-accent-green/20 border-accent-green/40 text-accent-green'
            : isLoss ? 'bg-accent-red/20 border-accent-red/40 text-accent-red'
            : 'bg-ink-700 border-ink-500 text-neutral-400'
          const icon = isWin ? '✅' : isLoss ? '❌' : '⏳'
          return (
            <div key={i} className={`px-2 py-1 rounded border ${bg} text-[10px] font-mono flex items-center gap-1.5`}>
              <span>{icon}</span>
              <b>{e.symbol}</b>
              <span>{e.outcome}</span>
              <span className="opacity-70">{e.realisedPct >= 0 ? '+' : ''}{e.realisedPct?.toFixed?.(1) ?? '—'}%</span>
              <span className="opacity-50 text-[9px]">{fmtDate(e.takenAt)}</span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ── WEEKLY PICK ─────────────────────────────────────────────────
export function PublicWeeklyPickPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-weekly'], queryFn: () => snapshots.weeklyPick(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []

  return (
    <div className="space-y-4">
      <Banner emoji="📋" title="Weekly Picks" subtitle={data ? `${rows.length} setups · week of ${data.weekOf} · regime ${data.regime}` : 'loading…'} ts={data?.generatedAt} />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && (
        <div className="overflow-x-auto rounded-lg border border-ink-500">
          <table className="w-full text-[11px] bg-ink-800">
            <thead className="bg-ink-700 text-neutral-400">
              <tr>
                <th className="text-left px-3 py-2">Stock</th>
                <th className="text-right px-3 py-2">LTP</th>
                <th className="text-center px-3 py-2">Dir</th>
                <th className="text-center px-3 py-2">Conv</th>
                <th className="text-right px-3 py-2 text-accent-cyan">Entry</th>
                <th className="text-center px-3 py-2 text-accent-cyan">By</th>
                <th className="text-right px-3 py-2 text-accent-red">SL</th>
                <th className="text-right px-3 py-2 text-accent-green">T1</th>
                <th className="text-center px-3 py-2 text-accent-green">By</th>
                <th className="text-right px-3 py-2 text-accent-green">T2</th>
                <th className="text-center px-3 py-2 text-accent-green">By</th>
                <th className="text-right px-3 py-2 text-accent-green">T3</th>
                <th className="text-center px-3 py-2 text-accent-green">By</th>
                <th className="text-left px-3 py-2 text-neutral-500">Stake</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => <WeeklyRow key={i} r={r} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function WeeklyRow({ r }: { r: any }): JSX.Element {
  const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
  const convCls = r.conviction >= 80 ? 'text-accent-green' : r.conviction >= 60 ? 'text-accent-cyan' : 'text-accent-amber'
  return (
    <tr className={`border-t border-ink-500 hover:bg-ink-700 font-mono ${r.noBrainerBet ? 'bg-accent-amber/5' : ''}`}>
      <td className="px-3 py-2"><b className="text-neutral-200">{r.noBrainerBet && '⭐ '}{r.symbol}</b></td>
      <td className="px-3 py-2 text-right">₹{r.ltp?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
      <td className="px-3 py-2 text-center">
        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
      </td>
      <td className={`px-3 py-2 text-center font-bold ${convCls}`}>{r.conviction}</td>
      <td className="px-3 py-2 text-right text-accent-cyan">₹{r.entryPriceLow}–{r.entryPriceHigh}</td>
      <td className="px-3 py-2 text-center text-accent-cyan text-[10px]">{fmtDate(r.entryDate)}</td>
      <td className="px-3 py-2 text-right text-accent-red">₹{r.stopLoss}</td>
      <td className="px-3 py-2 text-right text-accent-green">₹{r.target1}</td>
      <td className="px-3 py-2 text-center text-accent-green text-[10px]">{fmtDate(r.target1Date)}</td>
      <td className="px-3 py-2 text-right text-accent-green">₹{r.target2}</td>
      <td className="px-3 py-2 text-center text-accent-green text-[10px]">{fmtDate(r.target2Date)}</td>
      <td className="px-3 py-2 text-right text-accent-green font-bold">₹{r.target3}</td>
      <td className="px-3 py-2 text-center text-accent-green text-[10px] font-semibold">{fmtDate(r.target3Date)}</td>
      <td className="px-3 py-2 text-left text-neutral-500 text-[10px]">{r.shareholdingNote ? r.shareholdingNote : '—'}</td>
    </tr>
  )
}

// ── DAILY PICK ──────────────────────────────────────────────────
export function PublicDailyPickPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-daily'], queryFn: () => snapshots.dailyPick(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []
  return (
    <div className="space-y-4">
      <Banner emoji="🎯" title="Daily Picks" subtitle={`${rows.length} 5–15 day setups · regime ${data?.regime ?? '—'}`} ts={data?.generatedAt} />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No daily picks right now. Refreshes 11:00 / 13:30 / 16:15 IST." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-ink-500">
          <table className="w-full text-[11px] bg-ink-800">
            <thead className="bg-ink-700 text-neutral-400">
              <tr>
                <th className="text-left px-3 py-2">Stock</th>
                <th className="text-right px-3 py-2">LTP</th>
                <th className="text-center px-3 py-2">Dir</th>
                <th className="text-center px-3 py-2">Conv</th>
                <th className="text-center px-3 py-2">Pattern</th>
                <th className="text-right px-3 py-2 text-accent-cyan">Entry</th>
                <th className="text-right px-3 py-2 text-accent-red">SL</th>
                <th className="text-right px-3 py-2 text-accent-green">T1</th>
                <th className="text-right px-3 py-2 text-accent-green">T2</th>
                <th className="text-right px-3 py-2 text-accent-green">T3</th>
                <th className="text-center px-3 py-2">RR</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
                const convCls = r.conviction >= 80 ? 'text-accent-green' : r.conviction >= 60 ? 'text-accent-cyan' : 'text-accent-amber'
                return (
                  <tr key={i} className="border-t border-ink-500 hover:bg-ink-700 font-mono">
                    <td className="px-3 py-2"><b>{r.symbol}</b></td>
                    <td className="px-3 py-2 text-right">₹{r.ltp}</td>
                    <td className="px-3 py-2 text-center">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                    </td>
                    <td className={`px-3 py-2 text-center font-bold ${convCls}`}>{r.conviction}</td>
                    <td className="px-3 py-2 text-center text-[10px] text-neutral-400">{r.pattern}</td>
                    <td className="px-3 py-2 text-right text-accent-cyan">₹{r.entryPrice}</td>
                    <td className="px-3 py-2 text-right text-accent-red">₹{r.stopLoss}</td>
                    <td className="px-3 py-2 text-right text-accent-green">₹{r.target1}</td>
                    <td className="px-3 py-2 text-right text-accent-green">₹{r.target2}</td>
                    <td className="px-3 py-2 text-right text-accent-green font-bold">₹{r.target3}</td>
                    <td className="px-3 py-2 text-center">{r.riskReward ?? '—'}:1</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── PRE-MOVE ────────────────────────────────────────────────────
export function PublicPreMovePage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-premove'], queryFn: () => snapshots.preMove(),
    refetchInterval: 5 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []
  return (
    <div className="space-y-4">
      <Banner emoji="⚡" title="Pre-Move Alerts" subtitle="Setups likely to resolve into 5–15% moves within 1–10 sessions" ts={data?.generatedAt} />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No pre-move setups right now. Pre-close scan: 15:20 IST." />}
      {!isLoading && !error && rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-ink-500">
          <table className="w-full text-[11px] bg-ink-800">
            <thead className="bg-ink-700 text-neutral-400">
              <tr>
                <th className="text-left px-3 py-2">Stock</th>
                <th className="text-right px-3 py-2">Price</th>
                <th className="text-center px-3 py-2">Dir</th>
                <th className="text-center px-3 py-2">Tier</th>
                <th className="text-center px-3 py-2">Score</th>
                <th className="text-right px-3 py-2 text-accent-cyan">Entry</th>
                <th className="text-right px-3 py-2 text-accent-red">SL</th>
                <th className="text-right px-3 py-2 text-accent-green">Target</th>
                <th className="text-center px-3 py-2">Exp%</th>
                <th className="text-left px-3 py-2 text-neutral-500">Setup</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dirColor = r.direction === 'BULL' ? '#00c853' : r.direction === 'BEAR' ? '#ff1744' : '#9aa0a6'
                return (
                  <tr key={i} className="border-t border-ink-500 hover:bg-ink-700 font-mono">
                    <td className="px-3 py-2"><b>{r.symbol}</b></td>
                    <td className="px-3 py-2 text-right">₹{r.price}</td>
                    <td className="px-3 py-2 text-center">
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                    </td>
                    <td className="px-3 py-2 text-center text-[10px]">{r.tier}</td>
                    <td className="px-3 py-2 text-center font-bold">{r.score?.toFixed?.(1)}</td>
                    <td className="px-3 py-2 text-right text-accent-cyan">₹{r.suggestedEntry ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-accent-red">₹{r.suggestedSL ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-accent-green">₹{r.suggestedTarget ?? '—'}</td>
                    <td className="px-3 py-2 text-center text-accent-green text-[10px]">{r.expectedMovePct?.toFixed?.(1)}%</td>
                    <td className="px-3 py-2 text-left text-neutral-500 text-[10px]">{(r.tags ?? []).slice(0, 3).join(' · ')}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── OPTIONS ─────────────────────────────────────────────────────
export function PublicOptionsPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-options'], queryFn: () => snapshots.options(),
    refetchInterval: 3 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []
  return (
    <div className="space-y-4">
      <Banner emoji="🎯" title="Options Signals" subtitle={`${rows.length} elite signals (score ≥ 9, conviction ≥ 90)`} ts={data?.generatedAt} />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No elite options signals right now. Active 9:15–15:30 IST." />}
      {!isLoading && !error && rows.length > 0 && <SignalTable rows={rows} />}
    </div>
  )
}

// ── INTRADAY ────────────────────────────────────────────────────
export function PublicIntradayPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-intraday'], queryFn: () => snapshots.intraday(),
    refetchInterval: 3 * 60_000, retry: false,
  })
  const rows: any[] = data?.rows ?? []
  return (
    <div className="space-y-4">
      <Banner emoji="⚡" title="Intraday Signals" subtitle={`${rows.length} signals from today's session`} ts={data?.generatedAt} />
      <HitLog />
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load. Snapshots refresh every 30 min." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No intraday signals right now. Active 9:15–15:30 IST." />}
      {!isLoading && !error && rows.length > 0 && <SignalTable rows={rows} />}
    </div>
  )
}

function SignalTable({ rows }: { rows: any[] }): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-500">
      <table className="w-full text-[11px] bg-ink-800">
        <thead className="bg-ink-700 text-neutral-400">
          <tr>
            <th className="text-center px-3 py-2">Time</th>
            <th className="text-left px-3 py-2">Instrument</th>
            <th className="text-center px-3 py-2">Dir</th>
            <th className="text-center px-3 py-2">Grade</th>
            <th className="text-center px-3 py-2">Score</th>
            <th className="text-right px-3 py-2 text-accent-cyan">Entry</th>
            <th className="text-right px-3 py-2 text-accent-red">SL</th>
            <th className="text-right px-3 py-2 text-accent-green">T1</th>
            <th className="text-right px-3 py-2 text-accent-green">T2</th>
            <th className="text-center px-3 py-2">RR</th>
            <th className="text-left px-3 py-2 text-neutral-500">Reasoning</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const dirColor = r.direction === 'BUY' ? '#00c853' : '#ff1744'
            const ts = new Date(r.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
            return (
              <tr key={i} className="border-t border-ink-500 hover:bg-ink-700 font-mono">
                <td className="px-3 py-2 text-center text-[10px] text-neutral-500">{ts}</td>
                <td className="px-3 py-2"><b>{r.instrument}</b></td>
                <td className="px-3 py-2 text-center">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: `${dirColor}22`, color: dirColor }}>{r.direction}</span>
                </td>
                <td className="px-3 py-2 text-center text-accent-amber">{r.grade}</td>
                <td className="px-3 py-2 text-center font-bold">{r.score?.toFixed?.(1)}</td>
                <td className="px-3 py-2 text-right text-accent-cyan">₹{r.entry}</td>
                <td className="px-3 py-2 text-right text-accent-red">₹{r.stopLoss}</td>
                <td className="px-3 py-2 text-right text-accent-green">₹{r.target1}</td>
                <td className="px-3 py-2 text-right text-accent-green">₹{r.target2 ?? '—'}</td>
                <td className="px-3 py-2 text-center">{r.riskReward ?? '—'}</td>
                <td className="px-3 py-2 text-left text-neutral-500 text-[10px]">{(r.reasons ?? []).slice(0, 2).join(' · ')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ── shared bits ─────────────────────────────────────────────────
function Banner({ emoji, title, subtitle, ts }: { emoji: string; title: string; subtitle: string; ts?: string }): JSX.Element {
  return (
    <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
      <div className="text-2xl">{emoji}</div>
      <div className="flex-1">
        <div className="text-sm font-semibold text-neutral-200">{title}</div>
        <div className="text-xs text-neutral-500 mt-1">{subtitle}</div>
      </div>
      <div className="text-[10px] text-neutral-600">Updated {fmtTs(ts)} IST</div>
    </div>
  )
}
function Loading(): JSX.Element { return <div className="text-neutral-500 p-10 text-center">Loading…</div> }
function Empty({ msg }: { msg: string }): JSX.Element { return <div className="text-neutral-500 p-10 text-center border border-dashed border-ink-500 rounded-lg">{msg}</div> }
