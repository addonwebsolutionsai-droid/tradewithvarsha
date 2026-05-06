import { useStore } from '../store'
import type { Signal } from '../types'

export function SummaryCards({ signals }: { signals: Signal[] }) {
  const { pcr } = useStore()
  const gradeA = signals.filter(s => s.grade === 'A').length
  const avgScore = signals.length ? (signals.reduce((s, x) => s + x.score, 0) / signals.length).toFixed(1) : '0.0'
  const cards = [
    { label: 'Grade A Signals', value: gradeA, color: 'text-accent-green', note: `of ${signals.length} total` },
    { label: 'Avg Score', value: `${avgScore}/10`, color: 'text-accent-cyan' },
    { label: 'Nifty PCR', value: pcr > 0 ? pcr.toFixed(2) : '—', color: 'text-accent-magenta',
      note: pcr < 0.7 ? 'Contrarian BULL' : pcr > 1.3 ? 'Contrarian BEAR' : 'Neutral' },
    { label: 'System', value: '✓ Online', color: 'text-accent-green' },
  ]
  return (
    <div className="grid grid-cols-4 gap-3 mb-5">
      {cards.map(c => (
        <div key={c.label} className="bg-ink-700 border border-ink-500 rounded-lg p-[14px_16px]">
          <div className="text-[11px] text-neutral-600 mb-1.5">{c.label}</div>
          <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
          {c.note && <div className="text-[11px] text-neutral-600 mt-0.5">{c.note}</div>}
        </div>
      ))}
    </div>
  )
}
