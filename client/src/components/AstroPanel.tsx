import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AstroBias } from '../types'

const INFLUENCE_COLOR: Record<string, string> = {
  Bullish: 'text-accent-green',
  Bearish: 'text-accent-red',
  Cautious: 'text-accent-amber',
  Volatile: 'text-[#ff5722]',
  Neutral: 'text-neutral-400',
  Mixed: 'text-neutral-400',
}

export function AstroPanel() {
  const [bias, setBias] = useState<AstroBias | null>(null)
  useEffect(() => {
    api.astro().then(d => setBias(d.bias)).catch(() => {})
  }, [])
  if (!bias) return <div className="text-neutral-600 p-5">Loading planetary data...</div>

  return (
    <div className="bg-ink-700 border border-ink-500 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] text-neutral-600 uppercase tracking-wider">🪐 Planetary Positions (Sidereal / Vedic)</div>
        <div className={`text-xs px-2 py-0.5 rounded ${
          bias.bullish ? 'bg-accent-green/10 text-accent-green' :
          bias.bearish ? 'bg-accent-red/10 text-accent-red' :
          bias.volatile ? 'bg-accent-amber/10 text-accent-amber' :
          'bg-ink-500 text-neutral-400'
        }`}>
          {bias.bullish ? 'BULLISH' : bias.bearish ? 'BEARISH' : bias.volatile ? 'VOLATILE' : 'NEUTRAL'} · {bias.strength.toFixed(2)}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 mb-4">
        {bias.planets.map(p => (
          <div key={p.planet} className="bg-ink-900 border border-ink-600 rounded p-[8px_10px]">
            <div className="text-xs font-semibold text-accent-violet flex items-center gap-1">
              {p.planet}{p.retrograde && <span className="text-accent-red text-[10px]">R</span>}
            </div>
            <div className="text-[11px] text-neutral-500">{p.sign} {p.degree.toFixed(1)}°</div>
            <div className={`text-[10px] mt-1 ${INFLUENCE_COLOR[p.influence] ?? 'text-neutral-400'}`}>{p.influence}</div>
          </div>
        ))}
      </div>

      <div>
        <div className="text-[11px] text-neutral-600 mb-1.5 uppercase tracking-wider">Active Aspects</div>
        {bias.aspects.length ? bias.aspects.map((a, i) => (
          <div key={i} className="text-xs text-neutral-400 mb-1 pl-3 border-l-2 border-ink-400">{a}</div>
        )) : <div className="text-xs text-neutral-600">No tight aspects right now</div>}
      </div>

      <div className="mt-3 pt-3 border-t border-ink-500 text-xs text-neutral-400">
        {bias.note}
      </div>
    </div>
  )
}
