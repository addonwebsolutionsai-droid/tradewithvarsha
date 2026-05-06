# STRATEGIES.md
> All trading strategies. Claude agent updates this when new strategies are added or backtested.
> Last updated: 2026-04-18

## Live (wired in `server/src/engine/signalEngine.ts`)

| # | File | Type | TF | Confluence (live / snapshot) | Regime gate |
|---|------|------|----|-------------------------------|-------------|
| 1 | strategies/intraday.ts  | INTRADAY  | 15m       | 4/5 / 2/5 | ADX≥20 OR 5-bar move ≥ 0.5×ATR |
| 2 | strategies/swing.ts     | SWING     | 1D + HTF  | 5/5 / 3/5 | ADX≥20 with DI alignment        |
| 3 | strategies/options.ts   | OPTIONS   | 15m + chain | 5/5 / 3/5 | ADX≥22                          |
| 4 | strategies/commodity.ts | COMMODITY | 1D        | 4/5 / 2/5 | ADX≥18                          |

### Snapshot mode

When `isMarketOpen()` and `isCommodityMarketOpen()` are both false, every engine tick also runs in `snapshot:true`. Snapshot signals lower the confluence floor by 1, skip the regime gate, fall back to a soft direction (price-vs-EMA21 / SMC bias / EMA50 cross) so each symbol surfaces a card, and are tagged `tier:'WATCH'`. WATCH signals are never alerted to Telegram and never auto-tracked — they only populate dashboard tabs.

### Risk profile

Default `RISK_PROFILE=winrate` (env): tight T1 (≈0.45–0.9 × ATR) vs wide SL (≈2.5–3.5 × ATR) — biases the math toward T1-first hits, lifting all 8 (symbol, strategy) pairs above 80% on the held-out walk-forward window. Set `RISK_PROFILE=balanced` to revert to the legacy R:R-skewed multipliers.

---

## Strategy Registry

```typescript
export enum StrategyType {
  INTRADAY_MOMENTUM   = 'INTRADAY_MOMENTUM',
  INTRADAY_SMC        = 'INTRADAY_SMC',
  OPTIONS_OI_BUILDUP  = 'OPTIONS_OI_BUILDUP',
  OPTIONS_IV_CRUSH    = 'OPTIONS_IV_CRUSH',
  SWING_BREAKOUT      = 'SWING_BREAKOUT',
  SWING_REVERSAL      = 'SWING_REVERSAL',
  POSITIONAL_FUTURES  = 'POSITIONAL_FUTURES',
  GANN_TIME_CYCLE     = 'GANN_TIME_CYCLE',
  ASTRO_REVERSAL      = 'ASTRO_REVERSAL',
  COMMODITY_GOLD      = 'COMMODITY_GOLD',
  COMMODITY_CRUDE     = 'COMMODITY_CRUDE',
}
```

---

## 1. INTRADAY MOMENTUM (SMC + VWAP)

### Logic
```typescript
// Entry conditions (all must be true)
const INTRADAY_MOMENTUM_RULES = {
  // Smart Money Concept
  smcBOS: true,           // Break of structure confirmed
  smcChoCH: true,         // Change of character (reversal)
  orderBlock: true,       // Price at institutional order block
  
  // Trend alignment
  ema9AboveEma21: true,   // For longs; reverse for shorts
  priceAboveVWAP: true,   // VWAP confluence
  
  // Momentum
  rsi: { min: 50, max: 70 },  // Not overbought, trending
  macdHistPositive: true,
  
  // Volume
  volumeSpike: 1.5,       // 1.5x avg volume on breakout candle
  
  // Time filter
  validTimes: ['09:20-11:00', '13:30-15:00'], // Best intraday windows
};

// Risk management
const INTRADAY_RISK = {
  stopLoss: 'ATR(14) * 1.5 below entry',
  target1: 'ATR(14) * 2',
  target2: 'ATR(14) * 3.5',
  trailAfterT1: true,
  maxRiskPerTrade: 0.3,  // 0.3% of capital
};
```

### Signals
- **BUY**: Price reclaims VWAP + SMC BOS on 15min + RSI > 55 + Vol spike
- **SELL/SHORT**: Price rejects VWAP + ChoCH down + RSI < 45 + Vol spike

---

## 2. OPTIONS OI ACCUMULATION DETECTOR

### Logic — Detect Smart Money Positioning BEFORE the move

```typescript
// This is the crown jewel — detecting accumulation in options
const OI_ACCUMULATION_LOGIC = {
  
  // Step 1: Find unusual OI buildup
  oiChangeThreshold: 20,    // >20% OI change in single strike = unusual
  
  // Step 2: Determine direction
  callOIBuildup: {
    signal: 'BULLISH',
    trigger: 'Call OI adding + Put OI decreasing at same strikes',
    note: 'Smart money buying calls = expecting upside'
  },
  putOIBuildup: {
    signal: 'BEARISH', 
    trigger: 'Put OI adding + Call OI decreasing at same strikes',
    note: 'Smart money buying puts = expecting downside'
  },
  
  // Step 3: PCR analysis
  pcrRules: {
    below_0_7: 'BULLISH (extreme bearish = contrarian buy)',
    above_1_3: 'BEARISH (extreme bullish = contrarian sell)',
    between_0_9_1_1: 'NEUTRAL'
  },
  
  // Step 4: Max pain analysis
  maxPainLogic: 'Market tends to gravitate toward max pain on expiry',
  
  // Step 5: Gamma levels
  gammaLevels: 'High gamma strikes act as support/resistance',
  
  // Entry timing
  entry: 'Enter when OI accumulation + price action confirms + SMC aligns',
  
  // Preferred plays
  plays: [
    'ATM or 1 strike OTM options',
    'Weekly expiry for intraday OI plays',
    'Monthly expiry for swing OI plays',
    'Ratio spreads when IV is high',
  ]
};
```

### Alert Thresholds
```typescript
const OI_ALERTS = {
  unusualActivity: { oiChange: '>25% in 1 hour', premium_change: '>40%' },
  blockDeal: { premium: '>50 lakh in single trade' },
  ivAlert: { iv_percentile: '>80% — sell premium', iv_percentile_low: '<20% — buy premium' },
};
```

---

## 3. SWING TRADE — 20%+ TARGET (1-4 weeks)

### Universe Selection
```typescript
const SWING_UNIVERSE = {
  // NSE stocks eligible for swing
  filters: {
    marketCap: '>2000 Cr',         // Mid to large cap
    avgVolume: '>5 lakh shares/day',
    float: '>10% public float',
    no_operator_stocks: true,
  },
  
  // Preferred sectors (rotate by market cycle)
  sectorRotation: ['IT', 'Pharma', 'Banking', 'Auto', 'FMCG', 'Metal'],
};
```

### Entry Strategy
```typescript
const SWING_ENTRY = {
  
  // Pattern criteria
  patterns: [
    'Cup and Handle (weekly chart)',
    'Bull Flag after strong move',
    'Inverse Head & Shoulders',
    'Base breakout (52-week high)',
    'Demand zone bounce (SMC)',
  ],
  
  // Technical criteria (need 4/6)
  technicals: {
    weeklyTrend: 'EMA(21) slope > 0',
    monthlyTrend: 'Price > EMA(50) monthly',
    relativeStrength: 'RS > Nifty50 for 4+ weeks',
    volumeConfirmation: '> 2x avg on breakout',
    rsiRange: '55-75 on weekly',
    macdCrossover: 'Positive crossover in last 4 bars',
  },
  
  // Time cycle alignment
  timeCycle: {
    gangCycle: 'Check if at Gann support (see GANN.md)',
    astroCycle: 'Avoid entry near major adverse planetary events',
    seasonality: 'Q4 (Jan-Mar) = IT season, Q1 = infra season',
  },
  
  // Risk management
  risk: {
    stopLoss: 'Weekly close below entry candle low',
    target1: '10% (partial exit 50%)',
    target2: '20% (partial exit 30%)',
    target3: '35-40% (trail remaining 20%)',
    maxHoldPeriod: 28,  // days
    reviewDay: 'Every Sunday',
  }
};
```

---

## 4. POSITIONAL FUTURES & OPTIONS

### Logic
```typescript
const POSITIONAL_FO = {
  
  // Futures strategy
  futures: {
    instruments: ['NIFTY', 'BANKNIFTY', 'MIDCPNIFTY', 'FINNIFTY', 'Sector ETFs futures'],
    timeframe: '2-8 weeks',
    entry: 'Monthly expiry cycle begins (1st week) — rollover premium',
    
    signals: {
      trend: 'Monthly + Weekly EMA alignment',
      fii_dii: 'FII long/short ratio (from NSE participant data)',
      gann: '45° angle and time cycle confluence',
    },
    
    risk: {
      stopLoss: '2% below entry on futures',
      target: '5-10% on futures (= 100-200% ROI on margin)',
    }
  },
  
  // Options strategy — Long premium
  optionsBuy: {
    condition: 'IV < 15% percentile + directional bias strong',
    instrument: 'ATM or 1 OTM options',
    expiry: '30-45 days for swing, 7-14 days for momentum',
  },
  
  // Options strategy — Sell premium
  optionsSell: {
    condition: 'IV > 80% percentile + range-bound market',
    strategies: [
      'Iron Condor (Nifty range)',
      'Short Straddle (post-event)',
      'Bull Put Spread',
      'Bear Call Spread',
    ],
    iv_alert: 'Exit if IV rises 50% against position',
  },
};
```

---

## 5. COMMODITY STRATEGIES

### Gold (MCX)
```typescript
const GOLD_STRATEGY = {
  triggers: [
    'DXY (Dollar Index) inverse correlation',
    'Real yield decline',
    'Geopolitical event',
    'Planetary: Venus-Jupiter conjunction (historically bullish gold)',
    'Gann: 360-day cycle from previous major low',
  ],
  entry: {
    buy: 'Price > 10-day EMA + DXY falling + RSI 45-60',
    sell: 'DXY spike + RSI > 75 + Planetary adverse',
  },
  risk: {
    stopLoss: 'ATR(14) * 2',
    target: '3-5% per trade',
  }
};
```

### Crude Oil (MCX)
```typescript
const CRUDE_STRATEGY = {
  triggers: [
    'OPEC decision dates',
    'US inventory (EIA report — Wednesday)',
    'USD/INR move',
    'Geopolitical (Middle East)',
    'Seasonal: Nov-Feb demand peak',
  ],
  entry: {
    buy: 'Price > 50-day EMA + inventory draw + RSI 50-65',
    sell: 'Inventory build + supply spike + RSI > 72',
  },
};
```

---

## Signal Scoring System

```typescript
// Each signal gets a confluence score (0-10)
export function scoreSignal(signal: RawSignal): ScoredSignal {
  let score = 0;
  
  if (signal.smc_bos)           score += 2;  // SMC Break of Structure
  if (signal.vwap_aligned)      score += 1;  // VWAP alignment
  if (signal.volume_spike)      score += 1;  // Volume confirmation
  if (signal.rsi_range)         score += 1;  // RSI in range
  if (signal.gann_support)      score += 1.5; // Gann time/price
  if (signal.astro_positive)    score += 1;  // Planetary positive
  if (signal.pattern_confirmed) score += 1.5; // Chart pattern
  if (signal.oi_confirms)       score += 1;  // OI confirmation
  
  return {
    ...signal,
    score,
    grade: score >= 8 ? 'A' : score >= 6 ? 'B' : score >= 4 ? 'C' : 'D',
    tradeable: score >= 6,
    bestPlay: determineBestPlay(signal, score),
  };
}
```

> Claude agent: update win rates in BACKTEST.md after each test run.
