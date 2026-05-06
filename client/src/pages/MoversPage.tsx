import { ScreenerGrid } from '../components/ScreenerGrid'

export function MoversPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 p-4 bg-ink-700 border border-ink-500 rounded-lg">
        <div className="text-2xl">🔥</div>
        <div>
          <div className="text-sm font-semibold text-neutral-200">Weekly Movers — entire NSE</div>
          <div className="text-xs text-neutral-500 mt-1">
            Stocks that moved <b>≥ 5 %</b> over the last 5 sessions, scanned across <b>~1,900 NSE-EQ scrips</b> via
            Angel ScripMaster — surfaces small/microcap names (Jinkushal, Sharp India, Lakshya Powertech…) that
            are invisible to the curated CNX 500 list. Refreshes post-close (16:10 IST).
          </div>
        </div>
      </div>
      <ScreenerGrid
        title="Weekly Movers"
        subtitle="≥5% (5-session) change · ranked by magnitude · liquidity-gated to median 20d vol ≥ 5k"
        endpoint="/api/scan/movers"
        bullLabel="Inflow (Gainers ▲)"
        bearLabel="Outflow (Losers ▼)"
        refreshLabel="Re-scan ~1,900 stocks"
      />
      <div className="text-[11px] text-neutral-600 p-3 bg-ink-800 rounded leading-relaxed">
        Tier A = ≥15 % move · Tier B = 8–15 % · Tier C = 5–8 %. SL = 1.5 × ATR · Target = 2.5 × ATR.
        Re-scan triggers a full sweep — takes ~2-3 min for ~800 names at concurrency 3 to stay inside the
        Angel 60 k req/day quota.
      </div>
    </div>
  )
}
