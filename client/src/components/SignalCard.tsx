import { useState } from 'react'
import clsx from 'clsx'
import type { Signal } from '../types'
import { SignalChart } from './SignalChart'
import { starsForSignal } from './convictionTier'
import { Stars } from './Stars'

const GRADE_COLOR: Record<Signal['grade'], string> = {
  A: '#00c853', B: '#00bcd4', C: '#ff9800', D: '#ff1744',
}

export function SignalCard({ signal }: { signal: Signal }) {
  const [open, setOpen] = useState(false)
  const gradeColor = GRADE_COLOR[signal.grade]
  const dirColor = signal.direction === 'BUY' ? '#00c853' : '#ff1744'
  const confluenceOn = Object.entries(signal.confluence).filter(([, v]) => v).map(([k]) => k)
  const confluenceKeys = Object.keys(signal.confluence)
  const stars = starsForSignal(signal)

  return (
    <div
      onClick={() => setOpen(!open)}
      className="mb-2.5 cursor-pointer rounded-lg p-[14px_16px] transition-all hover:bg-ink-600"
      style={{
        background: '#111118',
        border: `1px solid ${gradeColor}33`,
        borderLeft: `3px solid ${gradeColor}`,
      }}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <span
              className="px-2.5 py-0.5 rounded text-xs font-bold"
              style={{ background: `${dirColor}22`, color: dirColor }}
            >{signal.direction}</span>
            <span className="text-[15px] font-semibold text-neutral-200">{signal.instrument}</span>
            <Stars count={stars} />
            <span className="px-2 py-0.5 rounded text-[11px] bg-ink-500 text-neutral-500">{signal.type}</span>
            <span className="px-2 py-0.5 rounded text-[11px] bg-ink-500 text-neutral-500">{signal.source}</span>
            {signal.tier === 'WATCH' && (
              <span
                className="px-2 py-0.5 rounded text-[10px] font-semibold bg-accent-amber/15 text-accent-amber border border-accent-amber/40"
                title={signal.asOf ? `From last close (${new Date(signal.asOf).toLocaleString('en-IN')}) — relaxed confluence; do not auto-trade` : 'Last-close snapshot'}
              >WATCH</span>
            )}
          </div>
          <div className="flex gap-4 text-xs flex-wrap">
            <span className="text-neutral-500">Entry: <b className="text-neutral-200">₹{format(signal.entry)}</b></span>
            <span className="text-neutral-500">SL: <b className="text-accent-red">₹{format(signal.stopLoss)}</b></span>
            <span className="text-neutral-500">T1: <b className="text-accent-green">₹{format(signal.target1)}</b></span>
            <span className="text-neutral-500">T2: <b className="text-[#00e676]">₹{format(signal.target2)}</b></span>
          </div>
        </div>
        <div className="ml-4 text-right">
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center text-lg font-bold mb-1"
            style={{ background: `${gradeColor}22`, border: `2px solid ${gradeColor}`, color: gradeColor }}
          >{signal.grade}</div>
          <div className="text-[11px] text-neutral-600">{signal.confluenceCount}/{confluenceKeys.length} aligned</div>
          <div className="text-[11px] text-neutral-500">RR 1:{signal.riskReward}</div>
        </div>
      </div>

      {/* EMA stack ribbon — always visible, war-room style */}
      {signal.meta && (signal.meta.ema9 != null || signal.meta.ema21 != null || signal.meta.ema50 != null) && (
        <div className="mt-2 text-[10px] font-mono text-neutral-500 flex flex-wrap gap-x-3">
          {signal.meta.ema9  != null && <span>EMA9:  <b className="text-neutral-300">{fmt(signal.meta.ema9)}</b></span>}
          {signal.meta.ema21 != null && <span>EMA21: <b className="text-neutral-300">{fmt(signal.meta.ema21)}</b></span>}
          {signal.meta.ema50 != null && <span>EMA50: <b className="text-neutral-300">{fmt(signal.meta.ema50)}</b></span>}
          {signal.meta.rsi   != null && <span>RSI: <b className="text-neutral-300">{signal.meta.rsi.toFixed(1)}</b></span>}
          {signal.meta.adx   != null && <span>ADX: <b className="text-neutral-300">{signal.meta.adx.toFixed(1)}</b></span>}
          {signal.meta.atr   != null && <span>ATR: <b className="text-neutral-300">{fmt(signal.meta.atr)}</b></span>}
          {signal.meta.timeframe && <span className="text-accent-cyan">{signal.meta.timeframe}</span>}
        </div>
      )}

      {/* Trade-plan strip — precise per-signal entry window (hora + pre-move
          volume profile from the chart). Falls back to the generic label
          only when bestEntryTimeIST wasn't computed (e.g. snapshot WATCH). */}
      {signal.tradePlan && (
        <div className="mt-2 text-[10px] flex flex-wrap gap-x-3 gap-y-1">
          <span className="text-neutral-500">Entry:{' '}
            <b className="text-accent-green">
              {signal.tradePlan.bestEntryTimeIST
                ? `${signal.tradePlan.bestEntryTimeIST} IST`
                : signal.tradePlan.entryWindow}
            </b>
            {signal.tradePlan.horaNote && (
              <span className="ml-1 text-neutral-500">· {signal.tradePlan.horaNote}</span>
            )}
          </span>
          <span className="text-neutral-500">Exit: <b className="text-accent-amber">{signal.tradePlan.exitWindow}</b></span>
          <span className="text-neutral-500">Hold: <b className="text-neutral-300">{signal.tradePlan.holdHorizon}</b></span>
        </div>
      )}

      {/* Option leg banner — when this is an OPTIONS signal with a tradeable leg */}
      {signal.tradePlan?.optionLeg && (
        <div className="mt-2 text-[11px] bg-ink-700 border border-accent-cyan/30 rounded p-2 font-mono flex flex-wrap gap-x-3 gap-y-1">
          <span className="text-accent-cyan font-semibold">
            {signal.tradePlan.optionLeg.underlying} {signal.tradePlan.optionLeg.strike} {signal.tradePlan.optionLeg.side}
          </span>
          <span className="text-neutral-500">@ <b className="text-neutral-200">₹{fmt(signal.tradePlan.optionLeg.premium)}</b></span>
          <span className="text-neutral-500">SL <b className="text-accent-red">₹{fmt(signal.tradePlan.optionLeg.slPremium)}</b></span>
          <span className="text-neutral-500">T1 <b className="text-accent-green">₹{fmt(signal.tradePlan.optionLeg.t1Premium)}</b></span>
          <span className="text-neutral-500">T2 <b className="text-accent-green">₹{fmt(signal.tradePlan.optionLeg.t2Premium)}</b></span>
          <span className="text-neutral-500">{signal.tradePlan.optionLeg.lots} lot(s)</span>
          <span className="text-neutral-500">exp <b className="text-neutral-300">{signal.tradePlan.optionLeg.expiry}</b></span>
        </div>
      )}

      <div className="flex gap-1.5 mt-2.5 flex-wrap">
        {confluenceKeys.map(key => {
          const on = confluenceOn.includes(key)
          return (
            <span
              key={key}
              className={clsx(
                'text-[10px] px-2 py-0.5 rounded-full border',
                on ? 'bg-accent-green/10 text-accent-green border-accent-green/30' : 'bg-ink-500 text-neutral-600 border-ink-400',
              )}
            >
              {key.toUpperCase()}
            </span>
          )
        })}
      </div>

      {open && (
        <div className="mt-3.5 pt-3.5 border-t border-ink-500" onClick={e => e.stopPropagation()}>
          {/* Interactive war-room chart — candles + EMA + entry/SL/T1/T2 lines + ▲/▼ marker */}
          <SignalChart signal={signal} />

          <div className="mt-3 mb-2.5">
            <div className="text-[11px] text-neutral-600 mb-1.5 uppercase tracking-wider">Reasons &amp; Confluence</div>
            {signal.reasons.map((r, i) => (
              <div key={i} className="text-xs text-neutral-400 mb-1 pl-3 border-l-2 border-ink-400">{r}</div>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2.5 mt-2.5">
            <div className="bg-ink-700 p-[8px_10px] rounded">
              <div className="text-[10px] text-neutral-600 mb-0.5">🔮 GANN</div>
              <div className="text-[11px] text-accent-violet">{signal.gannNote}</div>
            </div>
            <div className="bg-ink-700 p-[8px_10px] rounded">
              <div className="text-[10px] text-neutral-600 mb-0.5">🪐 ASTRO</div>
              <div className="text-[11px] text-[#ffcc80]">{signal.astroNote}</div>
            </div>
            <div className="bg-ink-700 p-[8px_10px] rounded">
              <div className="text-[10px] text-neutral-600 mb-0.5">📊 OI / PATTERN</div>
              <div className="text-[11px] text-[#80cbc4]">{signal.pattern || signal.oiNote}</div>
            </div>
          </div>
          <div className="flex justify-between mt-2.5 text-[11px] text-neutral-600">
            <span>Valid until: <b className="text-neutral-400">{formatExpiry(signal.expiresAt)}</b></span>
            <span>Risk: −{signal.riskPct.toFixed(1)}% · Reward: +{signal.rewardPct.toFixed(1)}%</span>
          </div>
        </div>
      )}
    </div>
  )
}

function format(n: number): string {
  return n?.toLocaleString('en-IN', { maximumFractionDigits: 2 }) ?? '—'
}
function fmt(n: number): string { return format(n) }
function formatExpiry(iso: string): string {
  if (!iso) return '—'
  if (iso.length <= 10) return iso
  return iso.replace('T', ' ').slice(0, 16)
}
