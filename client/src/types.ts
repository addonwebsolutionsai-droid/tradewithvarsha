export type Direction = 'BUY' | 'SELL'
export type Grade = 'A' | 'B' | 'C' | 'D'
export type SignalType = 'INTRADAY' | 'SWING' | 'OPTIONS' | 'FUTURES' | 'COMMODITY' | 'POSITIONAL'

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
  target3?: number
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
  confluence: Record<string, boolean>
  confluenceCount: number
  source: string
  tier?: 'LIVE' | 'WATCH'
  asOf?: string
  meta?: SignalMeta
  tradePlan?: TradePlan
  stabilityNote?: string
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
  timeframe?: string
}

export interface TradePlan {
  entryWindow: string
  exitWindow: string
  holdHorizon: string
  entryDate?: string
  target1Date?: string
  target2Date?: string
  target3?: number
  target3Date?: string
  exitDate?: string
  bestEntryTimeIST?: string
  horaLord?: string
  horaNote?: string
  entryPriceLow?: number
  entryPriceHigh?: number
  optionLeg?: {
    underlying: string
    strike: number
    side: 'CE' | 'PE'
    expiry: string
    premium: number
    slPremium: number
    t1Premium: number
    t2Premium: number
    lots: number
  }
}

export interface MarketIndex {
  symbol: string
  name: string
  price: number
  change: number
  changePct: number
  high: number
  low: number
}

export interface OIRow {
  strike: number
  callOI: number
  putOI: number
  callOIChange: number
  putOIChange: number
  callLTP: number
  putLTP: number
  callIV: number
  putIV: number
}

export interface OIAnalysis {
  pcr: number
  pcrRegime: string
  maxPain: number
  maxCallOIStrike: number
  maxPutOIStrike: number
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  note: string
}

export interface OptionChain {
  symbol: string
  expiry: string
  spot: number
  pcr: number
  maxPain: number
  rows: OIRow[]
  timestamp: number
}

export interface GannCycle {
  name: string
  date: string
  daysAway: number
  importance: 'HIGH' | 'MED' | 'LOW'
  cycleDays: number
  seedDate: string
}

export interface GannBias {
  timeCycleHit: boolean
  priceAtGannLevel: boolean
  nextCycles: GannCycle[]
  supports: number[]
  resistances: number[]
  note: string
}

export interface PlanetPosition {
  planet: string
  sign: string
  degree: number
  retrograde: boolean
  influence: string
}

export interface AstroBias {
  bullish: boolean
  bearish: boolean
  volatile: boolean
  strength: number
  note: string
  aspects: string[]
  planets: PlanetPosition[]
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
}

export interface Health {
  status: string
  uptime: number
  marketOpen: boolean
  commodityOpen: boolean
  marketState: 'OPEN' | 'CLOSED'
  dataMode: 'LIVE' | 'SNAPSHOT'
  asOf: string | null
  signals: number
  live: number
  watch: number
  gradeA: number
  lastEngineRun: string | null
  lastSnapshotRun: string | null
  botRunning: boolean
  timestamp: string
}
