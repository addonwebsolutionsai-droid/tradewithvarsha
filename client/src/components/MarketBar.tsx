import type { MarketIndex } from '../types'

export function MarketBar({ indices }: { indices: MarketIndex[] }) {
  if (!indices.length) {
    return (
      <div className="border-b border-ink-500 bg-ink-800 h-[52px] flex items-center px-5 text-xs text-neutral-500">
        Fetching market data...
      </div>
    )
  }
  return (
    <div className="flex overflow-x-auto bg-ink-800 border-b border-ink-500">
      {indices.map(idx => (
        <div key={idx.symbol} className="px-5 py-2 border-r border-ink-500 min-w-[180px] shrink-0">
          <div className="text-[11px] text-neutral-600 mb-0.5">{idx.name}</div>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-neutral-200">
              {idx.price?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </span>
            <span className={`text-xs font-medium ${idx.change >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
              {idx.change >= 0 ? '+' : ''}{idx.change?.toFixed(2)} ({idx.changePct >= 0 ? '+' : ''}{idx.changePct?.toFixed(2)}%)
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}
