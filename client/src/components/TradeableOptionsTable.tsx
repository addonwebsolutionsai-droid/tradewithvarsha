import type { Signal } from '../types'
import { starsForSignal, bySignalQuality } from './convictionTier'
import { Stars } from './Stars'

/**
 * Explicit "which options can be traded right now" table — matches the
 * war-room playbook style: strike, side, expiry, entry premium, SL/T1/T2
 * premiums, suggested lots, entry/exit window, trigger reason.
 *
 * Pulls from any signal that has `tradePlan.optionLeg` populated.
 */
export function TradeableOptionsTable({ signals }: { signals: Signal[] }) {
  const rows = signals.filter(s => s.tradePlan?.optionLeg).slice().sort(bySignalQuality)
  if (rows.length === 0) {
    return (
      <div className="bg-ink-700 border border-ink-500 rounded-lg p-6 text-center text-xs text-neutral-600">
        No tradeable option setups right now. Live OI signals appear here when underlying SMC + OI bias align (≥ 5/5 confluence live · 3/5 snapshot).
      </div>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border border-ink-500 rounded-lg overflow-hidden">
        <thead className="bg-ink-800 text-neutral-400">
          <tr>
            <th className="text-left px-3 py-2 font-semibold">Leg</th>
            <th className="text-right px-3 py-2 font-semibold">Premium</th>
            <th className="text-right px-3 py-2 font-semibold text-accent-red">SL</th>
            <th className="text-right px-3 py-2 font-semibold text-accent-green">T1</th>
            <th className="text-right px-3 py-2 font-semibold text-accent-green">T2</th>
            <th className="text-right px-3 py-2 font-semibold">Lots</th>
            <th className="text-left px-3 py-2 font-semibold">Entry</th>
            <th className="text-left px-3 py-2 font-semibold">Exit</th>
            <th className="text-left px-3 py-2 font-semibold">Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(s => {
            const leg = s.tradePlan!.optionLeg!
            const dirColor = s.direction === 'BUY' ? 'text-accent-green' : 'text-accent-red'
            return (
              <tr key={s.id} className="border-t border-ink-500 hover:bg-ink-700/50">
                <td className="px-3 py-2">
                  <div className={`font-mono font-semibold ${dirColor} flex items-center gap-1.5`}>
                    {leg.underlying} {leg.strike} {leg.side}
                    <Stars count={starsForSignal(s)} className="text-[10px]" />
                  </div>
                  <div className="text-[10px] text-neutral-600">exp {leg.expiry} · grade {s.grade}</div>
                </td>
                <td className="px-3 py-2 text-right font-mono text-neutral-200">₹{fmt(leg.premium)}</td>
                <td className="px-3 py-2 text-right font-mono text-accent-red">₹{fmt(leg.slPremium)}</td>
                <td className="px-3 py-2 text-right font-mono text-accent-green">₹{fmt(leg.t1Premium)}</td>
                <td className="px-3 py-2 text-right font-mono text-accent-green">₹{fmt(leg.t2Premium)}</td>
                <td className="px-3 py-2 text-right font-mono text-neutral-300">{leg.lots}</td>
                <td className="px-3 py-2 text-[11px] text-neutral-300">
                  {s.tradePlan!.bestEntryTimeIST ? (
                    <>
                      <div className="font-mono text-accent-green">{s.tradePlan!.bestEntryTimeIST} IST</div>
                      {s.tradePlan!.horaNote && (
                        <div className="text-[10px] text-neutral-500">{s.tradePlan!.horaNote}</div>
                      )}
                    </>
                  ) : (
                    <span className="text-neutral-400">{s.tradePlan!.entryWindow}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-[11px] text-neutral-400">{s.tradePlan!.exitWindow}</td>
                <td className="px-3 py-2 text-[11px] text-neutral-400 max-w-[260px]">
                  {s.reasons.slice(0, 2).join(' · ')}
                  {s.tier === 'WATCH' && (
                    <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-accent-amber/15 text-accent-amber border border-accent-amber/30">WATCH</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function fmt(n: number): string {
  return n?.toLocaleString('en-IN', { maximumFractionDigits: 2 }) ?? '—'
}
