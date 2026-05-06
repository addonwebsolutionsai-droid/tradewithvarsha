import { useStore } from '../store'
import { BullBearBoard } from '../components/BullBearBoard'
import { SummaryCards } from '../components/SummaryCards'
import { ExportButtons } from '../components/ExportButtons'

export function SignalsPage() {
  const { signals } = useStore()
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-neutral-200">📊 Active Signals ({signals.length})</div>
        <ExportButtons dataset="signals" slug="signals" />
      </div>
      <SummaryCards signals={signals} />
      {signals.some(s => s.grade === 'A') && (
        <div className="mb-4 p-2.5 rounded border border-accent-green/30 bg-accent-green/5 text-xs flex items-center gap-2">
          <span className="text-accent-green font-semibold">🔥 {signals.filter(s => s.grade === 'A').length} Grade A Signal(s) Active</span>
          <span className="text-neutral-500">— High confidence. Review immediately.</span>
        </div>
      )}
      <BullBearBoard signals={signals} />
    </div>
  )
}
