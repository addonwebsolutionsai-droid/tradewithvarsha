import type { Candle } from '../types'

export interface ScreenerResult {
  symbol: string
  price: number
  change: number
  changePct: number
  score: number                  // 0-10, higher = stronger setup
  tier: 'A' | 'B' | 'C'
  direction: 'BULL' | 'BEAR' | 'NEUTRAL'
  reasons: string[]
  tags: string[]                 // short chips: "52wH", "Vol 3x", "RSI 72"
  expectedMovePct?: number       // expected move over timeframe
  timeframeLabel?: string        // "3-4 weeks", "2-8 weeks", etc.
  suggestedEntry?: number
  suggestedSL?: number
  suggestedTarget?: number
  // Extended trade plan — Pro Screener fills these so every row renders the
  // same "best entry time / price / T1-T2-T3 with dates" shape the user
  // validated on Weekly Pick (Marksans / Moschip / Moldtek).
  entryPriceLow?: number
  entryPriceHigh?: number
  entryDate?: string             // YYYY-MM-DD
  entryNote?: string
  bestEntryTimeIST?: string      // HH:MM-HH:MM
  horaLord?: string
  horaNote?: string
  target1?: number; target1Date?: string
  target2?: number; target2Date?: string
  target3?: number; target3Date?: string
  detectedAt: number             // unix ms
  setupKind: 'MOMENTUM' | 'REVERSAL' | 'BREAKOUT' | 'PULLBACK' | 'ACCUMULATION' | 'DISTRIBUTION' | 'PRE_MOVE'
  /** Pro Screener timeframe bucket (set by proScreener via runner attach). */
  category?: 'INTRADAY' | 'SHORT_SWING' | 'SWING' | 'POSITIONAL'
  /** Which query letter from screener.md fired (e.g. "A" / "G" / "M"). */
  queryId?: string
  /** Full 100-pt conviction (proScreener only). */
  convictionScore?: number
}

export interface Screener {
  id: string
  name: string
  description: string
  timeframeLabel: string
  setupKind: ScreenerResult['setupKind']
  /** Return null when the setup isn't present. */
  scan(candles: Candle[], symbol: string, higherTfCandles?: Candle[]): ScreenerResult | null
}

export interface ScanRun {
  startedAt: number
  finishedAt: number
  universe: string
  totalScanned: number
  screenersRun: number
  results: ScreenerResult[]
}
