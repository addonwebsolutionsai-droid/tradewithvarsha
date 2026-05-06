import { ScreenerGrid } from '../components/ScreenerGrid'

export function SwingScanPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">📈</div>
        <div>
          <div className="text-sm font-semibold text-neutral-200">Pro Swing Trades</div>
          <div className="text-xs text-neutral-500 mt-1">
            Hedge-fund-style 8-point checklist — only the strongest confluences get listed. Horizon: 2-6 weeks,
            typical target 15-24%.
          </div>
        </div>
      </div>
      <ScreenerGrid
        title="Swing setups"
        subtitle="Trend + momentum + volume + ADX + SMC + pattern confluence"
        endpoint="/api/scan/swing"
        bullLabel="Bullish Swing (Buy)"
        bearLabel="Bearish Swing (Short)"
      />
      <div className="text-[11px] text-neutral-600 p-3 bg-ink-800 rounded leading-relaxed">
        <div className="font-semibold text-neutral-400 mb-1">8-point checklist (need ≥5 to list):</div>
        1. 50-EMA above 200-EMA, both rising · 2. Price above 20-EMA · 3. RSI 50-72 ·
        4. MACD histogram rising · 5. ADX &gt; 22 (trending) · 6. SMC bullish structure (HH/HL or BOS) ·
        7. Bull chart pattern present · 8. Up-day volume &gt; down-day volume
      </div>
    </div>
  )
}
