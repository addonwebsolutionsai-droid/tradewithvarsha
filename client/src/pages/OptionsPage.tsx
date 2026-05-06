import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { api } from '../api'
import { OITable } from '../components/OITable'
import { TradeableOptionsTable } from '../components/TradeableOptionsTable'
import { BullBearBoard } from '../components/BullBearBoard'
import { starsForSignal, bySignalQuality } from '../components/convictionTier'
import { Stars } from '../components/Stars'
import type { OIAnalysis, OptionChain } from '../types'

export function OptionsPage() {
  const { signals, setOIUpdate } = useStore()
  const [symbol, setSymbol] = useState<'NIFTY' | 'BANKNIFTY'>('NIFTY')
  const [chain, setChain] = useState<OptionChain | null>(null)
  const [analysis, setAnalysis] = useState<OIAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchOC = () => {
      setError(null)
      api.optionChain(symbol).then(({ chain, analysis }) => {
        if (cancelled) return
        setChain(chain); setAnalysis(analysis)
        setOIUpdate({ pcr: chain.pcr, maxPain: chain.maxPain, spot: chain.spot })
      }).catch(e => {
        if (!cancelled) setError((e as Error).message)
      })
    }
    fetchOC()
    const iv = setInterval(fetchOC, 60_000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [symbol, setOIUpdate])

  // Show BOTH options and futures — the F&O advisor generates paired legs
  // per setup (futures + ATM options). Combined view matches how traders
  // actually think about F&O exposure.
  const optionSignals = signals.filter(s => s.type === 'OPTIONS').slice().sort(bySignalQuality)
  const futuresSignals = signals.filter(s => s.type === 'FUTURES').slice().sort(bySignalQuality)
  const fnoSignals = [...optionSignals, ...futuresSignals]

  return (
    <div>
      <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm font-semibold text-neutral-200">⚡ Tradeable F&amp;O Right Now</div>
        <div className="text-[11px] text-neutral-500 flex items-center gap-3 flex-wrap">
          <span className="text-accent-amber">⭐⭐⭐⭐⭐</span>
          <span>A · score ≥ 8</span>
          <span className="text-neutral-600">·</span>
          <span className="text-accent-cyan">⭐⭐⭐</span>
          <span>A (&lt;8) or B</span>
          <span className="text-neutral-600">·</span>
          <span className="text-neutral-500">⭐⭐</span>
          <span>C or below</span>
          <span className="text-neutral-600">·</span>
          <span>{optionSignals.length} opt · {futuresSignals.length} fut</span>
        </div>
      </div>
      <TradeableOptionsTable signals={optionSignals} />

      {futuresSignals.length > 0 && (
        <div className="mt-4">
          <div className="text-sm font-semibold text-neutral-200 mb-2">🎯 Paired Futures legs</div>
          <div className="overflow-x-auto rounded-lg border border-ink-500">
            <table className="w-full text-[11px] bg-ink-800">
              <thead className="bg-ink-700 text-neutral-400">
                <tr>
                  <th className="text-left px-3 py-2">Instrument</th>
                  <th className="text-center px-3 py-2">Dir</th>
                  <th className="text-center px-3 py-2">Grade</th>
                  <th className="text-right px-3 py-2">Entry</th>
                  <th className="text-right px-3 py-2 text-accent-red">SL</th>
                  <th className="text-right px-3 py-2 text-accent-green">T1</th>
                  <th className="text-right px-3 py-2 text-accent-green">T2</th>
                  <th className="text-center px-3 py-2">RR</th>
                  <th className="text-right px-3 py-2">Expiry</th>
                </tr>
              </thead>
              <tbody>
                {futuresSignals.map(s => (
                  <tr key={s.id} className="border-t border-ink-500 hover:bg-ink-700 font-mono">
                    <td className="px-3 py-2 font-semibold text-neutral-200">
                      <div className="flex items-center gap-1.5">
                        {s.instrument}
                        <Stars count={starsForSignal(s)} className="text-[10px]" />
                      </div>
                    </td>
                    <td className={`px-3 py-2 text-center font-bold ${s.direction === 'BUY' ? 'text-accent-green' : 'text-accent-red'}`}>{s.direction}</td>
                    <td className="px-3 py-2 text-center text-accent-cyan">{s.grade} ({s.score})</td>
                    <td className="px-3 py-2 text-right">₹{s.entry}</td>
                    <td className="px-3 py-2 text-right text-accent-red">₹{s.stopLoss}</td>
                    <td className="px-3 py-2 text-right text-accent-green">₹{s.target1}</td>
                    <td className="px-3 py-2 text-right text-accent-green">₹{s.target2}</td>
                    <td className="px-3 py-2 text-center">{s.riskReward}:1</td>
                    <td className="px-3 py-2 text-right text-[10px] text-neutral-500">{s.expiresAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div>
          <div className="text-[13px] text-neutral-500 mb-3">Bull/Bear board (F&amp;O signals)</div>
          <BullBearBoard signals={fnoSignals} />
        </div>
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="text-[13px] text-neutral-500">Live Option Chain</div>
            <div className="flex gap-1">
              {(['NIFTY', 'BANKNIFTY'] as const).map(s => (
                <button key={s} onClick={() => setSymbol(s)}
                  className={`text-xs px-2 py-1 rounded ${symbol === s ? 'bg-accent-cyan/20 text-accent-cyan' : 'bg-ink-500 text-neutral-500'}`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="bg-ink-700 border border-ink-500 rounded-lg p-4">
            {error && <div className="text-accent-red text-xs">{error}</div>}
            {!chain && !error && <div className="text-xs text-neutral-600">Fetching option chain...</div>}
            {chain && analysis && <OITable chain={chain} analysis={analysis} />}
          </div>
        </div>
      </div>
    </div>
  )
}
