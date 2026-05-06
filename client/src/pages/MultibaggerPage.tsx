import { ScreenerGrid } from '../components/ScreenerGrid'

export function MultibaggerPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">🚀</div>
        <div>
          <div className="text-sm font-semibold text-neutral-200">Multibagger Hunters</div>
          <div className="text-xs text-neutral-500 mt-1">
            Stage-2 base breakouts with smart-money accumulation footprint. Horizon: 6-24 months, target
            40-70%+. Keep position sizing small per stock — these are conviction plays.
          </div>
        </div>
      </div>
      <ScreenerGrid
        title="Multibagger candidates"
        subtitle="Stage-2 breakout + OBV newH + volume expansion + 200-day perf &gt; +20%"
        endpoint="/api/scan/multibagger"
        bullLabel="Strong Buy (Multibagger)"
        bearLabel="Avoid / Distribution"
      />
      <div className="text-[11px] text-neutral-600 p-3 bg-ink-800 rounded leading-relaxed">
        <div className="font-semibold text-neutral-400 mb-1">Multibagger checklist (need ≥4 to list):</div>
        1. 200-EMA rising + price above (Stage 2) · 2. 2-year base breakout ·
        3. 200-day perf &gt; +20% (relative strength proxy) · 4. OBV at 6-month high (accumulation) ·
        5. Volume expansion &gt; 50% vs base · 6. RSI &gt; 55 (strength)
      </div>
    </div>
  )
}
