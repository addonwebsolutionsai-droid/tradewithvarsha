import { useEffect, useState } from 'react'
import { api } from '../api'

interface DiagnoseCheck { service: string; ok: boolean; note?: string }

export function BotPanel() {
  const [bot, setBot] = useState<{ running: boolean; configured: boolean; chatIds: number; startedAt: string | null } | null>(null)
  const [checks, setChecks] = useState<DiagnoseCheck[]>([])
  const [healthy, setHealthy] = useState(false)
  useEffect(() => {
    api.botStatus().then(setBot).catch(() => {})
    api.diagnose().then(d => { setChecks(d.checks); setHealthy(d.healthy) }).catch(() => {})
  }, [])

  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="bg-ink-700 border border-ink-500 rounded-lg p-5">
        <div className="text-sm font-semibold mb-3 text-neutral-200">🤖 Telegram Bot</div>
        <div className="space-y-2 text-sm">
          <Row label="Configured" value={bot?.configured ? '✅ yes' : '❌ missing TELEGRAM_BOT_TOKEN'} />
          <Row label="Running" value={bot?.running ? '✅ online' : '⚠️ offline'} />
          <Row label="Allowed chats" value={String(bot?.chatIds ?? 0)} />
          <Row label="Started" value={bot?.startedAt?.slice(0, 19).replace('T', ' ') ?? '—'} />
        </div>
        <div className="mt-4 pt-4 border-t border-ink-500 text-xs text-neutral-500">
          <div className="mb-1.5 font-semibold text-neutral-400">Commands:</div>
          <div className="font-mono space-y-0.5">
            <div>/signals — All signals</div>
            <div>/intraday — Intraday calls</div>
            <div>/swing — Swing trades</div>
            <div>/options — OI analysis</div>
            <div>/gann [SYMBOL] — Gann cycles</div>
            <div>/astro — Planetary positions</div>
            <div>/backtest [strategy] — Run backtest</div>
            <div>/status SYMBOL — Per-symbol signal</div>
            <div>/fix — Re-run engine</div>
            <div>/health — System health</div>
          </div>
        </div>
      </div>

      <div className="bg-ink-700 border border-ink-500 rounded-lg p-5">
        <div className="text-sm font-semibold mb-3 text-neutral-200">🩺 System Diagnose</div>
        <div className={`text-xs mb-3 px-2 py-1 rounded inline-block ${healthy ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'}`}>
          {healthy ? '✓ All systems go' : '⚠ Issues detected'}
        </div>
        <div className="space-y-1.5">
          {checks.map(c => (
            <div key={c.service} className="flex justify-between text-sm">
              <span className="text-neutral-400">{c.service}</span>
              <span className={c.ok ? 'text-accent-green' : 'text-accent-red'}>
                {c.ok ? '✅' : '❌'} {c.note ?? ''}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-neutral-500">{label}</span>
      <span className="text-neutral-300 font-mono text-xs">{value}</span>
    </div>
  )
}
