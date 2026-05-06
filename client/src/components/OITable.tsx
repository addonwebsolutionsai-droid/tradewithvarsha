import type { OIAnalysis, OptionChain } from '../types'

interface Props {
  chain: OptionChain
  analysis: OIAnalysis
}

export function OITable({ chain, analysis }: Props) {
  const rows = chain.rows.slice().sort((a, b) => a.strike - b.strike)
  const maxOI = Math.max(...rows.map(r => Math.max(r.callOI, r.putOI)), 1)
  const atm = rows.reduce((best, r) =>
    Math.abs(r.strike - chain.spot) < Math.abs(best.strike - chain.spot) ? r : best, rows[0])

  return (
    <div>
      <div className="text-xs text-neutral-500 mb-3 flex gap-5 flex-wrap">
        <span>Spot: <b className="text-neutral-200">{chain.spot.toFixed(2)}</b></span>
        <span>PCR: <b className="text-accent-green">{chain.pcr.toFixed(2)}</b> ({analysis.pcrRegime})</span>
        <span>Max Pain: <b className="text-accent-amber">{chain.maxPain}</b></span>
        <span>Bias: <b className={analysis.bias === 'BULLISH' ? 'text-accent-green' : analysis.bias === 'BEARISH' ? 'text-accent-red' : 'text-neutral-300'}>{analysis.bias}</b></span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-ink-500">
              <th className="text-right text-accent-green p-[6px_10px]">Call OI Δ</th>
              <th className="text-right text-accent-green p-[6px_10px]">Call OI</th>
              <th className="text-right text-accent-green p-[6px_10px]">Call ₹</th>
              <th className="text-center text-white p-[6px_10px] font-bold">STRIKE</th>
              <th className="text-left text-accent-red p-[6px_10px]">Put ₹</th>
              <th className="text-left text-accent-red p-[6px_10px]">Put OI</th>
              <th className="text-left text-accent-red p-[6px_10px]">Put OI Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const callW = (r.callOI / maxOI) * 100
              const putW = (r.putOI / maxOI) * 100
              const isATM = r.strike === atm.strike
              return (
                <tr key={r.strike} className={isATM ? 'bg-ink-600' : ''}>
                  <td className={`text-right p-[5px_10px] ${r.callOIChange > 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                    {r.callOIChange > 0 ? '+' : ''}{(r.callOIChange / 1000).toFixed(0)}K
                  </td>
                  <td className="text-right p-[5px_10px]">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="text-neutral-500">{(r.callOI / 1000).toFixed(0)}K</span>
                      <div className="w-14 h-1 bg-ink-500 rounded">
                        <div className="h-full bg-accent-green rounded" style={{ width: `${callW}%` }} />
                      </div>
                    </div>
                  </td>
                  <td className="text-right p-[5px_10px] text-accent-green">₹{r.callLTP.toFixed(1)}</td>
                  <td className={`text-center p-[5px_10px] ${isATM ? 'font-bold text-white' : 'text-neutral-400'}`}>
                    {r.strike}
                    {isATM && <span className="ml-1 text-[10px] text-accent-amber">ATM</span>}
                  </td>
                  <td className="text-left p-[5px_10px] text-accent-red">₹{r.putLTP.toFixed(1)}</td>
                  <td className="text-left p-[5px_10px]">
                    <div className="flex items-center gap-1.5">
                      <div className="w-14 h-1 bg-ink-500 rounded">
                        <div className="h-full bg-accent-red rounded" style={{ width: `${putW}%` }} />
                      </div>
                      <span className="text-neutral-500">{(r.putOI / 1000).toFixed(0)}K</span>
                    </div>
                  </td>
                  <td className={`text-left p-[5px_10px] ${r.putOIChange > 0 ? 'text-accent-red' : 'text-accent-green'}`}>
                    {r.putOIChange > 0 ? '+' : ''}{(r.putOIChange / 1000).toFixed(0)}K
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-3 text-[11px] text-neutral-600">{analysis.note}</div>
    </div>
  )
}
