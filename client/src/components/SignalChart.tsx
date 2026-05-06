import { useEffect, useRef, useState } from 'react'
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from 'lightweight-charts'
import { api } from '../api'
import type { Signal } from '../types'

/**
 * War-room style interactive chart for a single signal.
 *
 * Renders:
 *   - last ~80 candles (15m for INTRADAY/OPTIONS, 1D for SWING/COMMODITY)
 *   - EMA 9 / 21 / 50 overlay lines
 *   - horizontal price lines for entry / stop-loss / target1 / target2
 *   - ▲ (BUY) or ▼ (SELL) marker at the entry candle (signal.asOf)
 *   - header strip with symbol + LTP + day-change %
 *
 * Lazy-loaded — fetches candles only when the parent mounts the component.
 */
export function SignalChart({ signal }: { signal: Signal }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState<{ ltp: number; change: number; changePct: number } | null>(null)

  // Use 15m for intraday/options, 1D for swing/commodity
  const tf = signal.type === 'SWING' || signal.type === 'COMMODITY' ? '1D' : '15m'
  // Underlying symbol for the candle fetch — strip any " STRIKE CE/PE" suffix
  const underlying = signal.instrument.split(' ')[0]

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 320,
      layout: {
        background: { type: ColorType.Solid, color: '#111118' },
        textColor: '#94a3b8',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#1e1e2e' },
        horzLines: { color: '#1e1e2e' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1e1e2e' },
      timeScale: { borderColor: '#1e1e2e', timeVisible: true, secondsVisible: false },
    })
    chartRef.current = chart

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#00c853',
      downColor: '#ff1744',
      borderUpColor: '#00c853',
      borderDownColor: '#ff1744',
      wickUpColor: '#00c853',
      wickDownColor: '#ff1744',
    })
    candleSeriesRef.current = candleSeries

    // Fetch candles for the underlying
    let cancelled = false
    api.candles(underlying, tf, 80)
      .then(res => {
        if (cancelled || !res.candles?.length) {
          setError(res.candles?.length ? null : 'no data')
          setLoading(false)
          return
        }

        const data = res.candles.map(c => ({
          time: Math.floor(c.time / 1000) as UTCTimestamp,
          open: c.open, high: c.high, low: c.low, close: c.close,
        }))
        candleSeries.setData(data)

        // Day-change pill
        const last = res.candles[res.candles.length - 1]
        const first = res.candles[0]
        setStats({
          ltp: last.close,
          change: last.close - first.close,
          changePct: ((last.close - first.close) / first.close) * 100,
        })

        // EMA overlays from existing meta (single point) — for a continuous line
        // we compute on-the-fly client-side from the close series.
        const closes = res.candles.map(c => c.close)
        const ema9 = computeEMA(closes, 9)
        const ema21 = computeEMA(closes, 21)
        const ema50 = computeEMA(closes, 50)

        const ema9Series = chart.addLineSeries({ color: '#00bcd4', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        ema9Series.setData(ema9.map((v, i) => ({ time: data[i].time, value: v })).filter(p => Number.isFinite(p.value)))
        const ema21Series = chart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        ema21Series.setData(ema21.map((v, i) => ({ time: data[i].time, value: v })).filter(p => Number.isFinite(p.value)))
        const ema50Series = chart.addLineSeries({ color: '#a78bfa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        ema50Series.setData(ema50.map((v, i) => ({ time: data[i].time, value: v })).filter(p => Number.isFinite(p.value)))

        // Horizontal price lines: entry, SL, T1, T2
        candleSeries.createPriceLine({
          price: signal.entry,
          color: '#3b82f6', lineWidth: 2, lineStyle: LineStyle.Solid,
          axisLabelVisible: true, title: `Entry ${signal.entry}`,
        })
        candleSeries.createPriceLine({
          price: signal.stopLoss,
          color: '#ff1744', lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title: `SL ${signal.stopLoss}`,
        })
        candleSeries.createPriceLine({
          price: signal.target1,
          color: '#00c853', lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title: `T1 ${signal.target1}`,
        })
        candleSeries.createPriceLine({
          price: signal.target2,
          color: '#00e676', lineWidth: 1, lineStyle: LineStyle.Dashed,
          axisLabelVisible: true, title: `T2 ${signal.target2}`,
        })

        // Entry marker at the asOf candle (or last candle if asOf not in range)
        const asOfMs = signal.asOf ? new Date(signal.asOf).getTime() : last.time
        const asOfSec = Math.floor(asOfMs / 1000) as UTCTimestamp
        const markerTime = data.find(d => d.time >= asOfSec)?.time ?? data[data.length - 1].time
        const isBuy = signal.direction === 'BUY'
        candleSeries.setMarkers([{
          time: markerTime,
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: isBuy ? '#00c853' : '#ff1744',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          text: isBuy ? 'InFlow' : 'OutFlow',
        }])

        chart.timeScale().fitContent()
        setLoading(false)
      })
      .catch(e => {
        if (!cancelled) {
          setError((e as Error).message)
          setLoading(false)
        }
      })

    // Resize handler
    const onResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelled = true
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
    }
  }, [signal.id, underlying, tf, signal.entry, signal.stopLoss, signal.target1, signal.target2, signal.direction, signal.asOf])

  return (
    <div className="mt-3 bg-ink-700 border border-ink-500 rounded overflow-hidden">
      {/* Header strip — symbol · LTP · change% · timeframe */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-ink-500 text-[11px]">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-neutral-200">{underlying}</span>
          {stats && (
            <>
              <span className="font-mono text-neutral-200">₹{stats.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
              <span className={`font-mono ${stats.change >= 0 ? 'text-accent-green' : 'text-accent-red'}`}>
                {stats.change >= 0 ? '+' : ''}{stats.change.toFixed(2)} ({stats.change >= 0 ? '+' : ''}{stats.changePct.toFixed(2)}%)
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-neutral-500">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-cyan/15 text-accent-cyan">EMA9</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber">EMA21</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-violet/15 text-accent-violet">EMA50</span>
          <span className="text-neutral-600">·</span>
          <span>{tf}</span>
        </div>
      </div>
      <div ref={containerRef} className="w-full" style={{ minHeight: 320 }} />
      {loading && <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-500">Loading chart…</div>}
      {error && <div className="px-3 py-2 text-[11px] text-accent-amber">Chart unavailable for {underlying}: {error}</div>}
    </div>
  )
}

/** Standard EMA — same alpha smoothing used server-side. */
function computeEMA(values: number[], period: number): number[] {
  if (values.length < period) return values.map(() => NaN)
  const k = 2 / (period + 1)
  const out: number[] = []
  let sum = 0
  for (let i = 0; i < period; i++) {
    sum += values[i]
    out.push(NaN)
  }
  let prev = sum / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out.push(prev)
  }
  return out
}
