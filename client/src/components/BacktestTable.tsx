import { useEffect, useState } from 'react'
import { api } from '../api'
import type { BacktestResult } from '../types'

export function BacktestTable() {
  const [results, setResults] = useState<BacktestResult[] | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setRunning(true); setError(null)
    try {
      const r = await api.backtestSuite()
      setResults(r.results)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }
  useEffect(() => { run() }, [])

  const totals = results
    ? {
        trades: results.reduce((s, r) => s + r.trades, 0),
        avgWR: results.length ? (results.reduce((s, r) => s + r.winRate, 0) / results.length).toFixed(1) : '0',
        avgPF: results.length ? (results.reduce((s, r) => s + r.profitFactor, 0) / results.length).toFixed(2) : '0',
      }
    : null

  return (
    <div className="bg-ink-700 border border-ink-500 rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-semibold text-neutral-200">📊 Backtest Results</div>
        <button
          onClick={run}
          disabled={running}
          className="text-xs px-3 py-1.5 rounded bg-accent-cyan/10 text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-50"
        >{running ? 'Running...' : 'Re-run Suite'}</button>
      </div>
      {error && <div className="text-accent-red text-xs mb-3">{error}</div>}
      {!results && !error && <div className="text-xs text-neutral-600">Running backtest suite...</div>}
      {results && (
        <>
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-ink-500 text-neutral-600">
                <th className="text-left p-2">Strategy</th>
                <th className="text-right p-2">Trades</th>
                <th className="text-right p-2">Win Rate</th>
                <th className="text-right p-2">Avg Win</th>
                <th className="text-right p-2">Avg Loss</th>
                <th className="text-right p-2">PF</th>
                <th className="text-right p-2">Max DD</th>
                <th className="text-right p-2">Return</th>
                <th className="text-right p-2">Sharpe</th>
              </tr>
            </thead>
            <tbody>
              {results.map(r => (
                <tr key={r.strategy} className="border-b border-ink-600/60">
                  <td className="p-2 text-accent-cyan">{r.strategy}</td>
                  <td className="text-right p-2 text-neutral-400">{r.trades}</td>
                  <td className="text-right p-2 text-accent-green">{r.winRate}%</td>
                  <td className="text-right p-2 text-neutral-400">{r.avgWinPct}%</td>
                  <td className="text-right p-2 text-accent-red">{r.avgLossPct}%</td>
                  <td className="text-right p-2 text-accent-amber">{Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞'}</td>
                  <td className="text-right p-2 text-accent-red">-{r.maxDrawdownPct}%</td>
                  <td className={`text-right p-2 ${r.totalReturnPct >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>{r.totalReturnPct}%</td>
                  <td className="text-right p-2 text-neutral-400">{r.sharpe}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {totals && (
            <div className="mt-4 p-3 bg-ink-900 rounded text-xs text-neutral-500">
              Period: last 500 bars · Combined trades: <b className="text-neutral-300">{totals.trades}</b> · Avg Win Rate: <b className="text-accent-green">{totals.avgWR}%</b> · Avg PF: <b className="text-accent-amber">{totals.avgPF}</b>
            </div>
          )}
        </>
      )}
    </div>
  )
}
