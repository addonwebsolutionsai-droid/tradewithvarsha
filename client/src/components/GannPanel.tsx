import { useEffect, useState } from 'react'
import { api } from '../api'
import type { GannBias } from '../types'

export function GannPanel({ symbol = 'NIFTY' }: { symbol?: string }) {
  const [bias, setBias] = useState<GannBias | null>(null)
  useEffect(() => {
    api.gann(symbol).then(d => setBias(d.bias)).catch(() => {})
  }, [symbol])
  if (!bias) return <div className="text-neutral-600 p-5">Loading Gann analysis...</div>

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="bg-ink-700 border border-ink-500 rounded-lg p-4">
        <div className="text-[11px] text-neutral-600 mb-2 uppercase tracking-wider">Gann Time Cycles — {symbol}</div>
        {bias.nextCycles.slice(0, 6).map(c => (
          <div key={c.name + c.date} className="flex justify-between mb-2 pb-1.5 border-b border-ink-500/60 last:border-none">
            <div>
              <div className="text-xs text-neutral-400">{c.name}</div>
              <div className="text-[11px] text-neutral-600">{c.date}</div>
            </div>
            <div className="text-right">
              <div className={`text-[11px] px-2 py-0.5 rounded ${
                c.importance === 'HIGH' ? 'bg-accent-amber/10 text-accent-amber' :
                c.importance === 'MED' ? 'bg-accent-cyan/10 text-accent-cyan' :
                'bg-ink-500 text-neutral-600'
              }`}>{c.importance}</div>
              <div className="text-[11px] text-neutral-600 mt-1">{c.daysAway}d</div>
            </div>
          </div>
        ))}
      </div>
      <div className="bg-ink-700 border border-ink-500 rounded-lg p-4">
        <div className="text-[11px] text-neutral-600 mb-2 uppercase tracking-wider">Square of 9 Levels</div>
        <div className="mb-3">
          <div className="text-[11px] text-accent-red mb-1">RESISTANCE</div>
          {bias.resistances.map(r => (
            <div key={`r-${r}`} className="flex justify-between mb-1 text-xs">
              <span className="text-neutral-400">{r.toFixed(0)}</span>
            </div>
          ))}
        </div>
        <div>
          <div className="text-[11px] text-accent-green mb-1">SUPPORT</div>
          {bias.supports.map(s => (
            <div key={`s-${s}`} className="flex justify-between mb-1 text-xs">
              <span className="text-neutral-400">{s.toFixed(0)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 pt-3 border-t border-ink-500 text-[11px] text-neutral-500">
          {bias.note}
        </div>
      </div>
    </div>
  )
}
