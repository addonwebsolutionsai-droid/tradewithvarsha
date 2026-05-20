export type Direction = 'BUY' | 'SELL'
export type Grade = 'A' | 'B' | 'C' | 'D'
export type SignalType = 'INTRADAY' | 'SWING' | 'OPTIONS' | 'FUTURES' | 'COMMODITY' | 'POSITIONAL'
export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1D' | '1W' | '1M'

export interface Candle {
  time: number   // unix ms
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface PriceQuote {
  symbol: string
  price: number
  change: number
  changePct: number
  high: number
  low: number
  open: number
  previousClose: number
  volume: number
  timestamp: number
  source: string
}

export interface OptionChainRow {
  strike: number
  callOI: number
  putOI: number
  callOIChange: number
  putOIChange: number
  callVolume: number
  putVolume: number
  callIV: number
  putIV: number
  callLTP: number
  putLTP: number
  callBid?: number
  callAsk?: number
  putBid?: number
  putAsk?: number
}

export interface OptionChain {
  symbol: string
  expiry: string
  spot: number
  pcr: number
  maxPain: number
  totalCallOI: number
  totalPutOI: number
  rows: OptionChainRow[]
  timestamp: number
}

export type ConfluenceKey =
  | 'smc'          // Smart Money Concept — BOS/CHoCH
  | 'vwap'         // VWAP alignment
  | 'volume'       // Volume spike
  | 'rsi'          // RSI in favorable range
  | 'gann'         // Gann time/price confluence
  | 'astro'        // Planetary positive
  | 'pattern'      // Chart pattern present
  | 'oi'           // OI confirms (options)
  | 'trend'        // EMA stack aligned
  | 'supertrend'
  | 'flow'         // FII/DII net flow matches direction (from NSE bulk-deals)
  | 'fundamentals' // EPS growth + low pledge + stable promoter holding (Screener.in)

export type Confluence = Partial<Record<ConfluenceKey, boolean>>

export interface Signal {
  id: string
  instrument: string
  direction: Direction
  grade: Grade
  score: number
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3?: number                 // Extended target — set by buildTradePlan
  riskPct: number
  rewardPct: number
  riskReward: number
  type: SignalType
  reasons: string[]
  gannNote: string
  astroNote: string
  oiNote: string
  pattern: string
  expiresAt: string
  timestamp: string
  confluence: Confluence
  confluenceCount: number
  source: string
  tier?: 'LIVE' | 'WATCH'         // WATCH = snapshot from last close while market shut
  asOf?: string                    // ISO ts of the underlying candle the signal came from
  meta?: SignalMeta
  tradePlan?: TradePlan
  stabilityNote?: string           // Set by directionLedger when this signal conflicts
                                   // with a recent opposite-direction call (see engine/directionLedger.ts)
}

export interface SignalMeta {
  ema9?: number
  ema21?: number
  ema50?: number
  ema200?: number
  atr?: number
  rsi?: number
  adx?: number
  vwap?: number
  pattern?: string
  timeframe?: string             // '15m' | '1D' | etc — what the signal was computed on
  // OPTIONS-specific (set by niftyOptionsStrict + read by signalLogger lifecycle
  // adapter so SL/target track underlying spot, not the option premium).
  spot?: number
  strike?: number
  side?: 'CE' | 'PE'
  underlyingDirection?: 'BUY' | 'SHORT'
}

export interface TradePlan {
  entryWindow: string            // human label e.g. "09:30–14:00 IST · skip first 15m"
  exitWindow: string             // human label e.g. "Book by 14:30 IST · no carry overnight"
  holdHorizon: string            // "intraday" | "1–4 weeks" | "10–21 days"
  // Concrete dates derived from the horizon (IST). Filled by buildTradePlan.
  entryDate?: string             // 'YYYY-MM-DD' — today's IST date for new signals
  target1Date?: string           // expected T1-hit date
  target2Date?: string           // expected T2-hit date
  // Precise entry guidance — aligned with Parashari hora where possible.
  bestEntryTimeIST?: string      // 'HH:MM-HH:MM' — narrow hora-aligned window
  horaLord?: string              // 'Jupiter' | 'Sun' | ... — ruling planet for window
  horaNote?: string              // one-line reason tag (e.g. "Jupiter hora · BULLISH")
  entryPriceLow?: number         // best-entry price zone low
  entryPriceHigh?: number        // best-entry price zone high
  // Third target (≈1.6× T2 distance) and its projected date.
  target3?: number
  target3Date?: string
  exitDate?: string              // hard time-stop — close the trade by this date
  optionLeg?: {
    underlying: string           // 'NIFTY' | 'BANKNIFTY'
    strike: number
    side: 'CE' | 'PE'
    expiry: string
    premium: number              // entry premium (₹/contract)
    slPremium: number            // -20% of premium typical
    t1Premium: number            // +35%
    t2Premium: number            // +80%
    lots: number                 // suggested lots for ₹5L capital
  }
}

export interface StrategyContext {
  symbol: string
  candles: Candle[]      // primary timeframe
  candlesHigher?: Candle[] // higher timeframe (for bias)
  optionChain?: OptionChain
  gannBias?: GannBias
  astroBias?: AstroBias
  date?: Date
  relaxed?: boolean       // snapshot mode — lower confluence floor by 1, tag WATCH
  /** Pre-computed by the engine so strategies stay synchronous. */
  fundamentalsFactorFires?: boolean
  flowDirection?: 'BULL' | 'BEAR' | null
}

export interface GannBias {
  timeCycleHit: boolean       // within 2 days of a key cycle
  priceAtGannLevel: boolean   // close to Square-of-9 level
  nextCycles: { name: string; date: string; daysAway: number; importance: 'HIGH' | 'MED' | 'LOW' }[]
  supports: number[]
  resistances: number[]
  note: string
}

export interface AstroBias {
  bullish: boolean
  bearish: boolean
  volatile: boolean
  strength: number            // -1 to 1
  note: string
  aspects: string[]
  planets: PlanetPosition[]
}

export interface PlanetPosition {
  planet: string
  sign: string
  degree: number
  retrograde: boolean
  influence: 'Bullish' | 'Bearish' | 'Neutral' | 'Volatile' | 'Cautious' | 'Mixed'
}

export interface BacktestTrade {
  entryTime: number
  exitTime: number
  symbol: string
  direction: Direction
  entry: number
  exit: number
  sl: number
  target: number
  pnl: number
  pnlPct: number
  result: 'WIN' | 'LOSS' | 'BE'
  signalId: string
  strategy: string
}

export interface BacktestResult {
  strategy: string
  period: { from: string; to: string }
  trades: number
  wins: number
  losses: number
  winRate: number
  avgWinPct: number
  avgLossPct: number
  profitFactor: number
  maxDrawdownPct: number
  totalReturnPct: number
  sharpe: number
  tradesList: BacktestTrade[]
}
