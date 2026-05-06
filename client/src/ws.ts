import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useStore } from './store'
import toast from 'react-hot-toast'
import type { Signal } from './types'

export function useLiveWebSocket() {
  const { setSignals, setConnected, setOIUpdate, setMarketOpen, setTick, pushFeed } = useStore()
  const qc = useQueryClient()

  useEffect(() => {
    let ws: WebSocket | null = null
    let reconnectTimer: number | null = null
    let closed = false

    const connect = () => {
      const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`
      ws = new WebSocket(url)

      ws.onopen = () => {
        console.log('[WS] connected')
        setConnected(true)
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          // Re-emit as a DOM event so any component can subscribe via
          // window.addEventListener('hedgefund:ws', e => e.detail). Cleaner
          // than passing the WS instance everywhere.
          window.dispatchEvent(new CustomEvent('hedgefund:ws', { detail: msg }))
          switch (msg.type) {
            case 'INIT':
            case 'SIGNALS_UPDATE': {
              const incoming = msg.signals as Signal[]
              // Surface NEW signals (not present in previous snapshot) into the live feed
              const prevIds = new Set(useStore.getState().signals.map(s => s.id))
              for (const s of incoming) {
                if (!prevIds.has(s.id) && (s.tier ?? 'LIVE') === 'LIVE') {
                  pushFeed({ id: `sig-${s.id}`, kind: 'NEW_SIGNAL', signal: s, ts: Date.now() })
                }
              }
              setSignals(incoming)
              break
            }
            case 'OI_UPDATE':
              setOIUpdate({ pcr: msg.pcr, maxPain: msg.maxPain, spot: msg.spot })
              break
            case 'HEARTBEAT':
              setMarketOpen(!!msg.marketOpen)
              break
            case 'TICK':
              setTick(msg.token, msg.ltp, msg.ts)
              break
            case 'SCAN_UPDATE':
              qc.setQueryData(['screener', `/api/scan/${msg.bucket}`], msg.run)
              break
            case 'DAILY_PICK_UPDATE': {
              qc.setQueryData(['daily-pick'], msg.pick)
              const fresh = (msg.pick?.newSinceLastRun as string[] | undefined) ?? []
              if (fresh.length) {
                pushFeed({
                  id: `dp-${msg.pick.generatedAt}`,
                  kind: 'DAILY_PICK_NEW',
                  symbols: fresh,
                  pickGeneratedAt: msg.pick.generatedAt,
                  ts: Date.now(),
                })
              }
              break
            }
            case 'TRADE_EVENT': {
              const e = msg.event
              const icon = { T1_HIT: '🎯', T2_HIT: '🚀', SL_HIT: '❌', EXPIRED: '⏰', INVALIDATED: '🚫' }[e.kind as 'T1_HIT'] ?? '📣'
              toast(`${icon} ${e.trade.symbol}: ${e.kind.replace('_', ' ')} (${e.pnlPct >= 0 ? '+' : ''}${e.pnlPct.toFixed(2)}%)`, { duration: 6000 })
              if (['T1_HIT','T2_HIT','SL_HIT','EXPIRED','INVALIDATED'].includes(e.kind)) {
                pushFeed({
                  id: `te-${e.trade.canonicalId ?? e.trade.symbol}-${e.kind}-${Date.now()}`,
                  kind: 'TRADE_HIT',
                  symbol: e.trade.symbol,
                  eventKind: e.kind,
                  pnlPct: e.pnlPct,
                  ts: Date.now(),
                })
              }
              break
            }
            case 'SIGNAL_INVALIDATED': {
              const e = msg.event
              toast(`🚫 ${e.trade.symbol} ${e.trade.direction} signal CANCELLED — view flipped`, {
                duration: 8000,
                style: { background: '#2a1810', color: '#ffa726', border: '1px solid #ff9800' },
              })
              pushFeed({
                id: `inv-${e.trade.canonicalId ?? e.trade.symbol}-${Date.now()}`,
                kind: 'TRADE_HIT',
                symbol: e.trade.symbol,
                eventKind: 'INVALIDATED',
                pnlPct: e.pnlPct ?? 0,
                ts: Date.now(),
              })
              break
            }
          }
        } catch (e) {
          console.warn('[WS] bad message', e)
        }
      }

      ws.onclose = () => {
        setConnected(false)
        if (!closed) reconnectTimer = window.setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        ws?.close()
      }
    }

    connect()

    return () => {
      closed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      ws?.close()
    }
  }, [setSignals, setConnected, setOIUpdate, setMarketOpen, setTick, pushFeed, qc])
}
