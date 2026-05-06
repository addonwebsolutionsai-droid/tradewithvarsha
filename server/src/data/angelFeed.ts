import WebSocket from 'ws'
import { config } from '../config'
import { log } from '../util/logger'
import { getFeedToken, login } from './angel'

/**
 * Angel SmartAPI WebSocket V2 feed.
 *
 * URL: wss://smartapisocket.angelone.in/smart-stream
 * Auth: via query / headers — clientcode, feedtoken, apikey
 *
 * Subscription message format (JSON):
 *   {
 *     correlationID: "hedge-fund",
 *     action: 1,                      // 1 = subscribe, 0 = unsubscribe
 *     params: {
 *       mode: 1 | 2 | 3,              // 1 LTP, 2 QUOTE, 3 SNAPQUOTE (full)
 *       tokenList: [
 *         { exchangeType: 1, tokens: ["99926000", "99926009"] }  // NSE indices
 *       ]
 *     }
 *   }
 *
 * Exchange types: 1=NSE_CM, 2=NSE_FO, 3=BSE_CM, 4=BSE_FO, 5=MCX_FO, 7=NCX_FO, 13=CDE_FO
 *
 * Incoming messages are BINARY — we parse per Angel's binary spec.
 * We currently expose only LTP-mode (mode 1) which is 51 bytes per tick.
 */

const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream'

export type ExchangeType = 1 | 2 | 3 | 4 | 5 | 7 | 13

export interface Tick {
  token: string
  exchangeType: ExchangeType
  ltp: number
  receivedAt: number
}

type TickListener = (tick: Tick) => void

class AngelFeed {
  private ws: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private listeners: Set<TickListener> = new Set()
  private subscribed: Map<ExchangeType, Set<string>> = new Map()
  private isConnecting = false

  on(listener: TickListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return
    if (this.isConnecting) return
    this.isConnecting = true

    let feedToken = getFeedToken()
    if (!feedToken) {
      const tok = await login()
      feedToken = tok?.feed ?? null
    }
    if (!feedToken || !config.apis.angelClientCode || !config.apis.angelApiKey) {
      log.warn('ANGEL-WS', 'Missing credentials — feed disabled')
      this.isConnecting = false
      return
    }

    this.ws = new WebSocket(WS_URL, {
      headers: {
        Authorization: feedToken,
        'x-api-key': config.apis.angelApiKey,
        'x-client-code': config.apis.angelClientCode,
        'x-feed-token': feedToken,
      },
    })

    this.ws.on('open', () => {
      log.ok('ANGEL-WS', 'Connected')
      this.isConnecting = false
      // Re-subscribe anything we had before
      for (const [exType, tokens] of this.subscribed) {
        if (tokens.size) this.sendSubscribe(exType, [...tokens])
      }
      // Heartbeat every 25s
      this.pingTimer = setInterval(() => {
        try { this.ws?.send('ping') } catch {}
      }, 25_000)
    })

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        if (typeof data === 'string' || data instanceof Buffer && data[0] === 0x70) {
          // "pong" reply — ignore
          return
        }
        const buf = data as Buffer
        if (buf.length < 11) return
        const tick = parseTick(buf)
        if (tick) {
          for (const l of this.listeners) l(tick)
        }
      } catch (e) {
        log.warn('ANGEL-WS', `parse error: ${(e as Error).message}`)
      }
    })

    this.ws.on('close', (code) => {
      log.warn('ANGEL-WS', `Closed (${code}) — reconnecting in 5s`)
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
      this.ws = null
      this.isConnecting = false
      this.scheduleReconnect()
    })

    this.ws.on('error', (err) => {
      log.err('ANGEL-WS', `error: ${err.message}`)
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(e => log.err('ANGEL-WS', `reconnect: ${(e as Error).message}`))
    }, 5000)
  }

  subscribe(exchangeType: ExchangeType, tokens: string[]): void {
    const set = this.subscribed.get(exchangeType) ?? new Set()
    for (const t of tokens) set.add(t)
    this.subscribed.set(exchangeType, set)
    if (this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe(exchangeType, tokens)
  }

  private sendSubscribe(exchangeType: ExchangeType, tokens: string[]) {
    if (!tokens.length) return
    const msg = {
      correlationID: 'hedge-fund',
      action: 1,
      params: {
        mode: 1, // LTP mode
        tokenList: [{ exchangeType, tokens }],
      },
    }
    try { this.ws!.send(JSON.stringify(msg)) } catch (e) {
      log.warn('ANGEL-WS', `sendSubscribe: ${(e as Error).message}`)
    }
  }

  disconnect(): void {
    this.listeners.clear()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.ws?.close()
    this.ws = null
  }

  status(): { connected: boolean; subscriptions: Record<number, string[]> } {
    const subs: Record<number, string[]> = {}
    for (const [k, v] of this.subscribed) subs[k] = [...v]
    return { connected: this.ws?.readyState === WebSocket.OPEN, subscriptions: subs }
  }
}

/**
 * Binary-packet parser for Mode 1 (LTP) and Mode 3 (SNAP-QUOTE).
 * Byte layout (little-endian):
 *   [0]      subscription mode (1/2/3)
 *   [1]      exchangeType (1 byte)
 *   [2..26]  tokenID (25 bytes, ASCII, null-padded)
 *   [27..34] sequenceNumber (int64)
 *   [35..42] exchangeTimestamp (int64)
 *   [43..50] ltp (int64) — needs / 100
 *   ... (more fields in QUOTE / SNAP modes)
 */
function parseTick(buf: Buffer): Tick | null {
  if (buf.length < 51) return null
  const mode = buf.readUInt8(0)
  const exchangeType = buf.readUInt8(1) as ExchangeType
  // Token: 25 bytes starting at offset 2, ASCII, trailing NULs
  let token = ''
  for (let i = 2; i < 27; i++) {
    const c = buf[i]
    if (c === 0) break
    token += String.fromCharCode(c)
  }
  const ltpRaw = Number(buf.readBigInt64LE(43))
  const ltp = ltpRaw / 100
  return { token, exchangeType, ltp, receivedAt: Date.now() }
}

export const feed = new AngelFeed()
