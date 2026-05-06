import type { Signal } from '../types'
import { SignalCard } from './SignalCard'
import { bySignalQuality } from './convictionTier'

export function SignalList({ signals, emptyText = 'No active signals' }: { signals: Signal[]; emptyText?: string }) {
  const sorted = [...signals].sort(bySignalQuality)
  return (
    <div>
      <div className="text-[13px] text-neutral-500 mb-3.5 flex justify-between">
        <span>{signals.length} signal{signals.length !== 1 ? 's' : ''} — click to expand</span>
        <span>Sort: ⭐⭐⭐⭐⭐ first · score ↓</span>
      </div>
      {sorted.length === 0 ? (
        <div className="bg-ink-700 border border-ink-500 rounded-lg p-10 text-center text-neutral-600">
          {emptyText}
        </div>
      ) : (
        sorted.map(s => <SignalCard key={s.id} signal={s} />)
      )}
    </div>
  )
}
