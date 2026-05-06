import { ScreenerGrid } from '../components/ScreenerGrid'

export function PreMovePage() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">⚡</div>
        <div>
          <div className="text-sm font-semibold text-neutral-200">Pre-Move Alerts</div>
          <div className="text-xs text-neutral-500 mt-1">
            Setups that typically resolve into moves within 1-3 days. Auto-pushed to your Telegram at 15:20 IST
            (pre-close) and 09:00 IST (pre-open). No subscription needed — alerts land in your chat.
          </div>
        </div>
      </div>
      <ScreenerGrid
        title="Tomorrow's likely movers"
        subtitle="BB squeeze · coiled range · resistance kiss · OBV-price divergence"
        endpoint="/api/scan/premove"
        refreshLabel="Re-scan now"
        bullLabel="Bull Pre-Move (Buy)"
        bearLabel="Bear Pre-Move (Short)"
      />
    </div>
  )
}
