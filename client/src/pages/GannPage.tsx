import { useState } from 'react'
import { GannPanel } from '../components/GannPanel'
import { AstroPanel } from '../components/AstroPanel'

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'GOLD', 'CRUDE']

export function GannPage() {
  const [symbol, setSymbol] = useState('NIFTY')
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-neutral-500">Symbol:</span>
        {SYMBOLS.map(s => (
          <button key={s} onClick={() => setSymbol(s)}
            className={`text-xs px-2 py-1 rounded ${symbol === s ? 'bg-accent-cyan/20 text-accent-cyan' : 'bg-ink-500 text-neutral-500'}`}>
            {s}
          </button>
        ))}
      </div>
      <GannPanel symbol={symbol} />
      <AstroPanel />
    </div>
  )
}
