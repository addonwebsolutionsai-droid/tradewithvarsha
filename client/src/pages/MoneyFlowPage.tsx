import { ScreenerGrid } from '../components/ScreenerGrid'

export function MoneyFlowPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">💰</div>
        <div>
          <div className="text-sm font-semibold text-neutral-200">Money Flow</div>
          <div className="text-xs text-neutral-500 mt-1">
            Institutional bullish (inflow) + bearish (outflow) stocks · mid-range swing setups (₹50-300, 10-15% in 3-4 weeks) ·
            options OI buildup on indices. Scans every day at post-close; refresh manually for live.
          </div>
        </div>
      </div>
      <ScreenerGrid
        title="Money Flow setups"
        subtitle="Bullish inflow + bearish outflow + mid-range swings — click Why to see confluence reasons"
        endpoint="/api/scan/moneyflow"
        bullLabel="Inflow (Buy)"
        bearLabel="Outflow (Sell)"
      />
      <div className="text-[11px] text-neutral-600 p-3 bg-ink-800 rounded">
        Screeners: 52w high + 2× vol · pullback to 20-EMA · silent accumulation (OBV ↑ · price flat) ·
        52w low + 2× vol · 20-day range breakdown · mid-range swing (₹50-300, 10-15% target)
      </div>
    </div>
  )
}
