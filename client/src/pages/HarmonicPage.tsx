import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ExportButtons } from '../components/ExportButtons'

/**
 * Harmonic Patterns dashboard tab.
 *
 * Shows every Bat / Gartley / Butterfly / Crab / Cypher / Shark pattern
 * the multi-TF scanner has detected, sorted by confidence × freshness.
 * Built after the user shared Trading Strategy Guides' "Ultimate Harmonic
 * Pattern" PDF — every row carries entry/SL/T1/T2/T3 prices, projected
 * dates, hora-aligned best entry time, the exact Fibonacci ratios that
 * fired, and a one-line "why this pattern" reason.
 */

interface HarmonicHit {
  symbol: string
  timeframe: string
  tier?: 'INTRADAY' | 'HOURLY' | 'POSITIONAL'
  patternName: 'BAT' | 'GARTLEY' | 'BUTTERFLY' | 'CRAB' | 'CYPHER' | 'SHARK' | 'ABCD'
  direction: 'BULLISH' | 'BEARISH'
  trade?: 'BUY' | 'SELL'
  confidence: number
  ltp?: number
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  detectedAt: string
  entryDate: string
  entryTimeIST?: string
  bestEntryTimeIST: string
  horaLord: string
  target1Date: string
  target2Date: string
  target3Date: string
  przLow: number
  przHigh: number
  invalidationPrice?: number
  invalidationRule?: string
  riskReward?: number
  reasons: string[]
  ratios: { B_over_XA: number; C_over_AB: number; D_over_XA: number; BCProjection: number }
  ageBars: number
  sigKey?: string
}

interface ScanRun {
  generatedAt: string | null
  symbolsScanned?: number
  timeframesScanned?: number
  totalPatterns: number
  tier?: 'INTRADAY' | 'HOURLY' | 'POSITIONAL' | 'ALL'
  hits: HarmonicHit[]
}

const PATTERN_COLORS: Record<HarmonicHit['patternName'], string> = {
  BAT:        'bg-accent-violet/15 text-accent-violet border-accent-violet/40',
  GARTLEY:    'bg-accent-cyan/15 text-accent-cyan border-accent-cyan/40',
  BUTTERFLY:  'bg-accent-amber/15 text-accent-amber border-accent-amber/40',
  CRAB:       'bg-accent-red/15 text-accent-red border-accent-red/40',
  CYPHER:     'bg-accent-green/15 text-accent-green border-accent-green/40',
  SHARK:      'bg-blue-500/15 text-blue-400 border-blue-500/40',
  ABCD:       'bg-neutral-500/15 text-neutral-400 border-neutral-500/40',
}

const TF_BUCKETS: Record<string, string[]> = {
  Intraday:    ['5m', '15m', '30m', '45m'],
  Hourly:      ['1h', '2h', '3h', '4h'],
  Positional:  ['1D', '1W', '1M'],
}

export function HarmonicPage() {
  const qc = useQueryClient()
  const [running, setRunning] = useState<'INTRADAY' | 'HOURLY' | 'POSITIONAL' | 'ALL' | null>(null)
  const [tierFilter, setTierFilter] = useState<'ALL' | 'INTRADAY' | 'HOURLY' | 'POSITIONAL'>('ALL')
  const [tfFilter, setTfFilter] = useState<string>('ALL')
  const [dirFilter, setDirFilter] = useState<'ALL' | 'BULLISH' | 'BEARISH'>('ALL')
  const [patternFilter, setPatternFilter] = useState<string>('ALL')
  const [minConf, setMinConf] = useState(60)
  const [open, setOpen] = useState<string | null>(null)

  const scan = useQuery({
    queryKey: ['harmonic-scan'],
    queryFn: async () => {
      const r = await fetch('/api/harmonic-scan')
      if (!r.ok) throw new Error(`${r.status}`)
      return r.json() as Promise<ScanRun>
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  const triggerScan = async (tier?: 'INTRADAY' | 'HOURLY' | 'POSITIONAL') => {
    setRunning(tier ?? 'ALL')
    try {
      const url = tier ? `/api/harmonic-scan/run?tier=${tier}` : '/api/harmonic-scan/run'
      await fetch(url, { method: 'POST' })
      // Always re-fetch the merged ALL view, not the tier-only response
      const r = await fetch('/api/harmonic-scan')
      if (r.ok) qc.setQueryData(['harmonic-scan'], await r.json())
    } finally { setRunning(null) }
  }

  const hits = scan.data?.hits ?? []
  const allTfs = useMemo(() => [...new Set(hits.map(h => h.timeframe))], [hits])
  const allPatterns = useMemo(() => [...new Set(hits.map(h => h.patternName))].sort(), [hits])

  const filtered = useMemo(() => hits.filter(h => {
    if (tierFilter !== 'ALL' && h.tier !== tierFilter) return false
    if (tfFilter !== 'ALL' && h.timeframe !== tfFilter) return false
    if (dirFilter !== 'ALL' && h.direction !== dirFilter) return false
    if (patternFilter !== 'ALL' && h.patternName !== patternFilter) return false
    if (h.confidence < minConf) return false
    return true
  }), [hits, tierFilter, tfFilter, dirFilter, patternFilter, minConf])

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">🔻</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-neutral-200">Harmonic Patterns — Multi-TF · Multi-Universe Scan</div>
          <div className="text-xs text-neutral-500 mt-1">
            Bat · Gartley · Butterfly · Crab · Cypher · Shark — Carney's Fibonacci XABCD reversal patterns
            across <b>11 timeframes</b> (5m · 15m · 30m · 45m · 1h · 2h · 3h · 4h · 1D · 1W · 1M).
            Tiered universe coverage to stay inside the data quota:
            <span className="text-accent-amber"> POSITIONAL</span> (1D/1W/1M) covers the <b>entire NSE_ALL</b> (~1900 names) once a day post-close;
            <span className="text-accent-cyan"> HOURLY</span> covers <b>CNX 500</b> every hour;
            <span className="text-accent-green"> INTRADAY</span> covers the <b>top-200 liquid</b> every 30 min.
            Each card shows PRZ, entry date+time, SL, T1/T2/T3 with dates, R:R, and the explicit invalidation level.
            Fresh ≥70% confidence hits push to Telegram automatically.
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-1">
            <button onClick={() => triggerScan('INTRADAY')} disabled={!!running}
              className="text-[10px] px-2 py-1 rounded bg-accent-green/10 text-accent-green hover:bg-accent-green/20 disabled:opacity-50 whitespace-nowrap">
              {running === 'INTRADAY' ? '…' : 'Intraday'}
            </button>
            <button onClick={() => triggerScan('HOURLY')} disabled={!!running}
              className="text-[10px] px-2 py-1 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50 whitespace-nowrap">
              {running === 'HOURLY' ? '…' : 'Hourly'}
            </button>
            <button onClick={() => triggerScan('POSITIONAL')} disabled={!!running}
              className="text-[10px] px-2 py-1 rounded bg-accent-amber/10 text-accent-amber hover:bg-accent-amber/20 disabled:opacity-50 whitespace-nowrap">
              {running === 'POSITIONAL' ? '…' : 'Positional (NSE_ALL)'}
            </button>
          </div>
          <ExportButtons dataset="harmonic-scan" slug="harmonic-scan" />
        </div>
      </div>

      {/* Status strip */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-neutral-500">
        {scan.data?.generatedAt && <span>Last scan: <b className="text-neutral-300">{new Date(scan.data.generatedAt).toLocaleString('en-IN')}</b></span>}
        {scan.data && <>
          <span>·</span>
          <span>Patterns found: <b className="text-accent-cyan">{scan.data.totalPatterns}</b></span>
          {scan.data.symbolsScanned != null && <>
            <span>·</span>
            <span>Universe: {scan.data.symbolsScanned} symbols × {scan.data.timeframesScanned} TFs</span>
          </>}
        </>}
        {scan.isLoading && <span className="text-accent-amber">Loading…</span>}
      </div>

      {/* Filters */}
      <div className="bg-ink-800 border border-ink-500 rounded-lg p-3 flex flex-wrap gap-3 items-end">
        <div>
          <div className="text-[10px] text-neutral-500 uppercase mb-1">Tier</div>
          <div className="flex gap-1">
            {(['ALL', 'INTRADAY', 'HOURLY', 'POSITIONAL'] as const).map(t => (
              <button key={t} onClick={() => setTierFilter(t)}
                className={clsx('text-[11px] px-2 py-1 rounded border',
                  tierFilter === t
                    ? t === 'INTRADAY' ? 'bg-accent-green/20 text-accent-green border-accent-green/40'
                    : t === 'HOURLY' ? 'bg-accent-cyan/20 text-accent-cyan border-accent-cyan/40'
                    : t === 'POSITIONAL' ? 'bg-accent-amber/20 text-accent-amber border-accent-amber/40'
                    : 'bg-neutral-500/20 text-neutral-200 border-neutral-500/40'
                    : 'bg-ink-700 text-neutral-400 border-ink-500 hover:text-neutral-200')}>
                {t === 'ALL' ? 'All' : t}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-neutral-500 uppercase mb-1">Timeframe</div>
          <select value={tfFilter} onChange={e => setTfFilter(e.target.value)}
            className="bg-ink-700 border border-ink-500 rounded px-2 py-1 text-xs text-neutral-200">
            <option value="ALL">All ({hits.length})</option>
            {Object.entries(TF_BUCKETS).map(([bucket, tfs]) => (
              <optgroup key={bucket} label={bucket}>
                {tfs.filter(t => allTfs.includes(t)).map(t => (
                  <option key={t} value={t}>{t} ({hits.filter(h => h.timeframe === t).length})</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <div className="text-[10px] text-neutral-500 uppercase mb-1">Direction</div>
          <div className="flex gap-1">
            {(['ALL', 'BULLISH', 'BEARISH'] as const).map(d => (
              <button key={d} onClick={() => setDirFilter(d)}
                className={clsx('text-[11px] px-2 py-1 rounded border',
                  dirFilter === d
                    ? d === 'BULLISH' ? 'bg-accent-green/20 text-accent-green border-accent-green/40'
                    : d === 'BEARISH' ? 'bg-accent-red/20 text-accent-red border-accent-red/40'
                    : 'bg-accent-cyan/20 text-accent-cyan border-accent-cyan/40'
                    : 'bg-ink-700 text-neutral-400 border-ink-500 hover:text-neutral-200')}>
                {d === 'BULLISH' ? '🟢 BULL' : d === 'BEARISH' ? '🔴 BEAR' : 'All'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-neutral-500 uppercase mb-1">Pattern</div>
          <select value={patternFilter} onChange={e => setPatternFilter(e.target.value)}
            className="bg-ink-700 border border-ink-500 rounded px-2 py-1 text-xs text-neutral-200">
            <option value="ALL">All</option>
            {allPatterns.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div>
          <div className="text-[10px] text-neutral-500 uppercase mb-1">Min confidence</div>
          <input type="range" min="50" max="95" step="5" value={minConf} onChange={e => setMinConf(Number(e.target.value))}
            className="w-32 accent-accent-cyan" />
          <span className="ml-2 text-[11px] font-mono text-neutral-300">{minConf}%</span>
        </div>
        <div className="flex-1 text-right text-[11px] text-neutral-500">
          Showing <b className="text-neutral-200">{filtered.length}</b> of {hits.length} patterns
        </div>
      </div>

      {/* Table */}
      {!scan.isLoading && filtered.length === 0 && (
        <div className="bg-ink-700 border border-ink-500 rounded-lg p-8 text-center text-sm text-neutral-500">
          No harmonic patterns match the current filters.
          {hits.length === 0 && <> Click <b className="text-accent-cyan">Re-scan now</b> above to trigger a fresh sweep.</>}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-ink-500">
          <table className="w-full text-[11px] bg-ink-800">
            <thead className="bg-ink-700 text-neutral-400 sticky top-0">
              <tr>
                <th className="text-left px-3 py-2">Symbol</th>
                <th className="text-center px-3 py-2">TF</th>
                <th className="text-center px-3 py-2">Tier</th>
                <th className="text-center px-3 py-2">Pattern</th>
                <th className="text-center px-3 py-2">Dir</th>
                <th className="text-right px-3 py-2">Conf</th>
                <th className="text-right px-3 py-2 text-neutral-300">LTP</th>
                <th className="text-center px-3 py-2 text-accent-violet">PRZ</th>
                <th className="text-right px-3 py-2 text-accent-cyan">Entry</th>
                <th className="text-center px-3 py-2 text-accent-cyan">Date</th>
                <th className="text-center px-3 py-2 text-accent-cyan">Time</th>
                <th className="text-right px-3 py-2 text-accent-red">SL / Inv</th>
                <th className="text-right px-3 py-2 text-accent-green">T1</th>
                <th className="text-center px-3 py-2 text-accent-green">T1 by</th>
                <th className="text-right px-3 py-2 text-accent-green">T2</th>
                <th className="text-center px-3 py-2 text-accent-green">T2 by</th>
                <th className="text-right px-3 py-2 text-accent-green">T3</th>
                <th className="text-center px-3 py-2 text-accent-green">T3 by</th>
                <th className="text-right px-3 py-2 text-neutral-400">R:R</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 300).map(h => (
                <Row key={`${h.symbol}-${h.timeframe}-${h.patternName}-${h.detectedAt}`}
                  h={h} expanded={open === rowKey(h)} onToggle={() => setOpen(open === rowKey(h) ? null : rowKey(h))} />
              ))}
            </tbody>
          </table>
          {filtered.length > 300 && (
            <div className="p-2 text-[11px] text-neutral-500 text-center bg-ink-700">
              Showing first 300 of {filtered.length} — narrow filters to see more.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function rowKey(h: HarmonicHit): string {
  return `${h.symbol}-${h.timeframe}-${h.patternName}-${h.detectedAt}`
}

function Row({ h, expanded, onToggle }: { h: HarmonicHit; expanded: boolean; onToggle: () => void }) {
  const dirColor = h.direction === 'BULLISH' ? 'text-accent-green' : 'text-accent-red'
  const tierColor = h.tier === 'INTRADAY' ? 'text-accent-green'
    : h.tier === 'HOURLY' ? 'text-accent-cyan'
    : h.tier === 'POSITIONAL' ? 'text-accent-amber'
    : 'text-neutral-500'
  return (
    <>
      <tr onClick={onToggle}
        className="border-t border-ink-500 hover:bg-ink-700 font-mono cursor-pointer">
        <td className="px-3 py-2"><b className="text-neutral-200">{h.symbol}</b></td>
        <td className="px-3 py-2 text-center text-neutral-400">{h.timeframe}</td>
        <td className={clsx('px-3 py-2 text-center text-[10px] font-semibold', tierColor)}>{h.tier ?? '—'}</td>
        <td className="px-3 py-2 text-center">
          <span className={clsx('px-1.5 py-0.5 rounded text-[10px] font-bold border', PATTERN_COLORS[h.patternName])}>
            {h.patternName}
          </span>
        </td>
        <td className={clsx('px-3 py-2 text-center font-bold', dirColor)}>{h.trade ?? (h.direction === 'BULLISH' ? 'BUY' : 'SELL')}</td>
        <td className="px-3 py-2 text-right text-accent-cyan">{h.confidence}%</td>
        <td className="px-3 py-2 text-right text-neutral-300">{h.ltp ?? '—'}</td>
        <td className="px-3 py-2 text-center text-accent-violet text-[10px]">
          {h.przLow.toFixed(2)} – {h.przHigh.toFixed(2)}
        </td>
        <td className="px-3 py-2 text-right text-neutral-200">{h.entry}</td>
        <td className="px-3 py-2 text-center text-accent-cyan text-[10px]">{shortDate(h.entryDate)}</td>
        <td className="px-3 py-2 text-center text-accent-cyan text-[10px]">
          <div>{h.entryTimeIST ?? h.bestEntryTimeIST}</div>
          <div className="text-[9px] text-neutral-500">{h.horaLord}</div>
        </td>
        <td className="px-3 py-2 text-right text-accent-red">
          <div>{h.stopLoss}</div>
          {h.invalidationPrice != null && h.invalidationPrice !== h.stopLoss && (
            <div className="text-[9px] text-neutral-500">inv {h.invalidationPrice}</div>
          )}
        </td>
        <td className="px-3 py-2 text-right text-accent-green">{h.target1}</td>
        <td className="px-3 py-2 text-center text-accent-green text-[10px]">{shortDate(h.target1Date)}</td>
        <td className="px-3 py-2 text-right text-accent-green">{h.target2}</td>
        <td className="px-3 py-2 text-center text-accent-green text-[10px]">{shortDate(h.target2Date)}</td>
        <td className="px-3 py-2 text-right text-accent-green font-bold">{h.target3}</td>
        <td className="px-3 py-2 text-center text-accent-green text-[10px] font-semibold">{shortDate(h.target3Date)}</td>
        <td className="px-3 py-2 text-right text-neutral-300 text-[10px]">{h.riskReward != null ? `1:${h.riskReward}` : '—'}</td>
      </tr>
      {expanded && (
        <tr className="bg-ink-700 border-t border-ink-500">
          <td colSpan={19} className="px-4 py-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
              <div className="bg-ink-800 border border-ink-500 rounded p-2">
                <div className="text-[10px] text-neutral-500 uppercase mb-1">📐 Fibonacci ratios</div>
                <div className="font-mono space-y-0.5 text-neutral-300">
                  <div>B / XA: <b>{h.ratios.B_over_XA.toFixed(3)}</b></div>
                  <div>C / AB: <b>{h.ratios.C_over_AB.toFixed(3)}</b></div>
                  <div>D / XA: <b>{h.ratios.D_over_XA.toFixed(3)}</b></div>
                  <div>BC ext: <b>{h.ratios.BCProjection.toFixed(3)}</b></div>
                </div>
              </div>
              <div className="bg-ink-800 border border-ink-500 rounded p-2">
                <div className="text-[10px] text-neutral-500 uppercase mb-1">🎯 Potential reversal zone</div>
                <div className="font-mono text-neutral-300">
                  ₹{h.przLow.toFixed(2)} – ₹{h.przHigh.toFixed(2)}
                </div>
                <div className="text-[10px] text-neutral-500 mt-2">Pattern fired {h.ageBars} bar{h.ageBars !== 1 ? 's' : ''} ago</div>
              </div>
            </div>
            {h.invalidationRule && (
              <div className="mt-3 bg-accent-red/5 border border-accent-red/30 rounded p-2">
                <div className="text-[10px] text-accent-red uppercase mb-1">🛑 Invalidation Rule</div>
                <div className="text-[11px] text-neutral-200">{h.invalidationRule}</div>
              </div>
            )}
            <div className="mt-2">
              <div className="text-[10px] text-neutral-500 uppercase mb-1">Reasoning</div>
              {h.reasons.map((r, i) => (
                <div key={i} className="text-[11px] text-neutral-400 pl-2 border-l-2 border-ink-400">{r}</div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function shortDate(iso: string): string {
  if (!iso) return '—'
  const [, m, d] = iso.split('-').map(Number)
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${d} ${months[m - 1] ?? '?'}`
}
