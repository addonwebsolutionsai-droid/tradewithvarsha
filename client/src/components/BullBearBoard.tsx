import type { Signal } from '../types'
import { SignalCard } from './SignalCard'
import { bySignalQuality } from './convictionTier'

/**
 * War-room style two-column board: bullish setups on the left, bearish on
 * the right. Sorted ⭐⭐⭐⭐⭐ first (A + score≥8), then 3★, then 2★
 * within each side; score desc is the tiebreaker.
 */
export function BullBearBoard({ signals }: { signals: Signal[] }) {
  const bull = signals.filter(s => s.direction === 'BUY').sort(bySignalQuality)
  const bear = signals.filter(s => s.direction === 'SELL').sort(bySignalQuality)

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div>
        <div className="flex items-center justify-between px-3.5 py-2.5 rounded-t-lg border border-b-0 border-accent-green/30 bg-accent-green/5">
          <div className="text-accent-green font-bold text-sm tracking-wide flex items-center gap-2">
            <span>▲</span>
            <span>BULLISH SIGNALS</span>
          </div>
          <div className="text-accent-green text-xs font-semibold bg-accent-green/15 border border-accent-green/30 px-2 py-0.5 rounded">
            {bull.length}
          </div>
        </div>
        <div className="border border-accent-green/30 rounded-b-lg p-3 min-h-[200px]">
          {bull.length === 0
            ? <div className="py-12 text-center text-xs text-neutral-600">No bullish setups</div>
            : bull.map(s => <SignalCard key={s.id} signal={s} />)}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between px-3.5 py-2.5 rounded-t-lg border border-b-0 border-accent-red/30 bg-accent-red/5">
          <div className="text-accent-red font-bold text-sm tracking-wide flex items-center gap-2">
            <span>▼</span>
            <span>BEARISH SIGNALS</span>
          </div>
          <div className="text-accent-red text-xs font-semibold bg-accent-red/15 border border-accent-red/30 px-2 py-0.5 rounded">
            {bear.length}
          </div>
        </div>
        <div className="border border-accent-red/30 rounded-b-lg p-3 min-h-[200px]">
          {bear.length === 0
            ? <div className="py-12 text-center text-xs text-neutral-600">No bearish setups</div>
            : bear.map(s => <SignalCard key={s.id} signal={s} />)}
        </div>
      </div>
    </div>
  )
}
