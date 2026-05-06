# INDICATORS.md
> Indicator library used by the signal engine. Claude agent updates when new indicators are added.
> Last updated: 2026-04-09

---

## Indicator Implementation (server/src/services/indicatorService.ts)

```typescript
import {
  EMA, RSI, MACD, BollingerBands, ATR, Stochastic,
  OBV, MFI, WilliamsR, IchimokuCloud,
} from 'technicalindicators'

export class IndicatorService {

  // ── TREND ────────────────────────────────────────────────

  calcEMA(values: number[], period: number): number[] {
    return EMA.calculate({ period, values })
  }

  calcVWAP(candles: OHLCV[]): number {
    let cumTPV = 0, cumVol = 0
    for (const c of candles) {
      const tp = (c.high + c.low + c.close) / 3
      cumTPV += tp * c.volume
      cumVol += c.volume
    }
    return cumTPV / cumVol
  }

  calcSuperTrend(candles: OHLCV[], period = 10, multiplier = 3): SuperTrendResult[] {
    const atrs = ATR.calculate({ period, high: candles.map(c => c.high), low: candles.map(c => c.low), close: candles.map(c => c.close) })
    const results: SuperTrendResult[] = []

    let direction = 1  // 1 = bullish, -1 = bearish
    let upperBand = 0, lowerBand = 0

    for (let i = period; i < candles.length; i++) {
      const atr = atrs[i - period]
      const hl2 = (candles[i].high + candles[i].low) / 2
      const basicUpper = hl2 + multiplier * atr
      const basicLower = hl2 - multiplier * atr

      upperBand = basicUpper < upperBand || candles[i-1].close > upperBand ? basicUpper : upperBand
      lowerBand = basicLower > lowerBand || candles[i-1].close < lowerBand ? basicLower : lowerBand

      if (candles[i].close > upperBand) direction = 1
      if (candles[i].close < lowerBand) direction = -1

      results.push({
        date: candles[i].date,
        superTrend: direction === 1 ? lowerBand : upperBand,
        direction,
        isBullish: direction === 1,
      })
    }
    return results
  }

  calcIchimoku(candles: OHLCV[]) {
    return IchimokuCloud.calculate({
      high: candles.map(c => c.high),
      low: candles.map(c => c.low),
      conversionPeriod: 9,
      basePeriod: 26,
      spanPeriod: 52,
      displacement: 26,
    })
  }

  // ── MOMENTUM ──────────────────────────────────────────────

  calcRSI(closes: number[], period = 14): number[] {
    return RSI.calculate({ period, values: closes })
  }

  calcMACD(closes: number[]): MACDResult[] {
    return MACD.calculate({
      values: closes,
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
    })
  }

  calcStochasticRSI(closes: number[]): number[] {
    const rsi = this.calcRSI(closes)
    const period = 14
    return rsi.map((val, i) => {
      if (i < period - 1) return 50
      const slice = rsi.slice(i - period + 1, i + 1)
      const min = Math.min(...slice)
      const max = Math.max(...slice)
      return max === min ? 50 : ((val - min) / (max - min)) * 100
    })
  }

  calcWilliamsR(candles: OHLCV[], period = 14): number[] {
    return WilliamsR.calculate({
      high: candles.map(c => c.high),
      low: candles.map(c => c.low),
      close: candles.map(c => c.close),
      period,
    })
  }

  calcMFI(candles: OHLCV[], period = 14): number[] {
    return MFI.calculate({
      high: candles.map(c => c.high),
      low: candles.map(c => c.low),
      close: candles.map(c => c.close),
      volume: candles.map(c => c.volume),
      period,
    })
  }

  // ── VOLATILITY ────────────────────────────────────────────

  calcATR(candles: OHLCV[], period = 14): number[] {
    return ATR.calculate({
      high: candles.map(c => c.high),
      low: candles.map(c => c.low),
      close: candles.map(c => c.close),
      period,
    })
  }

  calcBollingerBands(closes: number[], period = 20, stdDev = 2) {
    return BollingerBands.calculate({ period, values: closes, stdDev })
  }

  calcHistoricalVolatility(closes: number[], period = 20): number {
    const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]))
    const slice = returns.slice(-period)
    const mean = slice.reduce((s, r) => s + r, 0) / period
    const variance = slice.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (period - 1)
    return Math.sqrt(variance * 252) * 100  // Annualized %
  }

  // ── VOLUME / SMART MONEY ──────────────────────────────────

  calcOBV(closes: number[], volumes: number[]): number[] {
    return OBV.calculate({ close: closes, volume: volumes })
  }

  calcVolumeProfile(candles: OHLCV[], bins = 20): VolumeProfileResult {
    const prices = candles.map(c => c.close)
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    const binSize = (max - min) / bins

    const profile: { price: number; volume: number }[] = []
    for (let i = 0; i < bins; i++) {
      const binLow = min + i * binSize
      const binHigh = binLow + binSize
      const vol = candles
        .filter(c => c.close >= binLow && c.close < binHigh)
        .reduce((s, c) => s + c.volume, 0)
      profile.push({ price: (binLow + binHigh) / 2, volume: vol })
    }

    const poc = profile.reduce((max, p) => p.volume > max.volume ? p : max)

    return { profile, poc, vah: poc.price * 1.01, val: poc.price * 0.99 }
  }

  // ── OPTIONS SPECIFIC ──────────────────────────────────────

  calcPCR(optionChain: OptionChainData): number {
    const totalCallOI = optionChain.records.data
      .reduce((s: number, r: any) => s + (r.CE?.openInterest || 0), 0)
    const totalPutOI = optionChain.records.data
      .reduce((s: number, r: any) => s + (r.PE?.openInterest || 0), 0)
    return totalPutOI / totalCallOI
  }

  calcMaxPain(optionChain: OptionChainData): number {
    const strikes = [...new Set(optionChain.records.data.map((r: any) => r.strikePrice))]
    let minPain = Infinity
    let maxPainStrike = 0

    for (const targetStrike of strikes) {
      let totalPain = 0
      for (const row of optionChain.records.data) {
        const strike = row.strikePrice
        const callOI = row.CE?.openInterest || 0
        const putOI = row.PE?.openInterest || 0
        totalPain += Math.max(0, targetStrike - strike) * callOI
        totalPain += Math.max(0, strike - targetStrike) * putOI
      }
      if (totalPain < minPain) { minPain = totalPain; maxPainStrike = targetStrike }
    }
    return maxPainStrike
  }

  calcIVPercentile(currentIV: number, historicalIVs: number[]): number {
    const below = historicalIVs.filter(iv => iv < currentIV).length
    return (below / historicalIVs.length) * 100
  }

  detectOIBuildup(optionChain: OptionChainData): OIBuildupSignal {
    const callOIChanges = optionChain.records.data
      .map((r: any) => ({ strike: r.strikePrice, change: r.CE?.changeinOpenInterest || 0 }))
      .sort((a: any, b: any) => b.change - a.change)

    const putOIChanges = optionChain.records.data
      .map((r: any) => ({ strike: r.strikePrice, change: r.PE?.changeinOpenInterest || 0 }))
      .sort((a: any, b: any) => b.change - a.change)

    const maxCallBuild = callOIChanges[0]
    const maxPutBuild = putOIChanges[0]

    return {
      callBuildup: maxCallBuild,    // Resistance forming here
      putBuildup: maxPutBuild,      // Support forming here
      bias: maxPutBuild.change > maxCallBuild.change ? 'BULLISH' : 'BEARISH',
      note: maxPutBuild.change > maxCallBuild.change
        ? `Smart money adding puts at ${maxPutBuild.strike} — floor support`
        : `Smart money adding calls at ${maxCallBuild.strike} — ceiling resistance`,
    }
  }
}
```

---

## SMC (Smart Money Concept) Engine

```typescript
// server/src/services/smcAnalyzer.ts
export class SMCAnalyzer {

  // Break of Structure (BOS) — trend continuation
  detectBOS(candles: OHLCV[], direction: 'BULLISH' | 'BEARISH'): BOSResult | null {
    const n = candles.length
    if (n < 20) return null

    const recentHigh = Math.max(...candles.slice(-20, -1).map(c => c.high))
    const recentLow = Math.min(...candles.slice(-20, -1).map(c => c.low))
    const current = candles[n - 1]

    if (direction === 'BULLISH' && current.close > recentHigh) {
      return { type: 'BOS', direction: 'BULLISH', level: recentHigh, bar: current }
    }
    if (direction === 'BEARISH' && current.close < recentLow) {
      return { type: 'BOS', direction: 'BEARISH', level: recentLow, bar: current }
    }
    return null
  }

  // Change of Character (ChoCH) — trend reversal
  detectChoCH(candles: OHLCV[]): ChoCHResult | null {
    // In uptrend: price fails to make higher high AND breaks structure low
    // In downtrend: price fails to make lower low AND breaks structure high
    const n = candles.length
    if (n < 30) return null

    const highs = candles.slice(-30).map(c => c.high)
    const lows = candles.slice(-30).map(c => c.low)

    const isUptrend = highs[highs.length-1] > highs[0]
    const current = candles[n - 1]

    if (isUptrend) {
      const lastSwingLow = Math.min(...lows.slice(-15))
      if (current.close < lastSwingLow) {
        return { type: 'ChoCH', direction: 'BEARISH', level: lastSwingLow }
      }
    } else {
      const lastSwingHigh = Math.max(...highs.slice(-15))
      if (current.close > lastSwingHigh) {
        return { type: 'ChoCH', direction: 'BULLISH', level: lastSwingHigh }
      }
    }
    return null
  }

  // Order Block detection — institutional entry zones
  detectOrderBlocks(candles: OHLCV[]): OrderBlock[] {
    const blocks: OrderBlock[] = []

    for (let i = 5; i < candles.length - 5; i++) {
      const candle = candles[i]
      const isBullish = candle.close > candle.open
      const bodySize = Math.abs(candle.close - candle.open)
      const avgBody = candles.slice(i-5, i).reduce((s, c) => s + Math.abs(c.close - c.open), 0) / 5

      // Order block: large candle followed by strong impulse move
      if (bodySize > avgBody * 1.5) {
        const nextCandles = candles.slice(i+1, i+6)
        const impulse = nextCandles.some(c => Math.abs(c.close - candle.close) > bodySize * 2)

        if (impulse) {
          blocks.push({
            type: isBullish ? 'DEMAND' : 'SUPPLY',
            top: Math.max(candle.open, candle.close),
            bottom: Math.min(candle.open, candle.close),
            date: candle.date,
            mitigated: false,
            strength: bodySize / avgBody,
          })
        }
      }
    }

    // Mark mitigated blocks
    const lastPrice = candles[candles.length - 1].close
    return blocks.map(b => ({
      ...b,
      mitigated: b.type === 'DEMAND' ? lastPrice < b.bottom : lastPrice > b.top,
    }))
  }

  // Fair Value Gap (FVG) — imbalance zones
  detectFVG(candles: OHLCV[]): FVG[] {
    const fvgs: FVG[] = []
    for (let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i - 1]
      const curr = candles[i]
      const next = candles[i + 1]

      // Bullish FVG: gap up — prev high < next low
      if (prev.high < next.low) {
        fvgs.push({ type: 'BULLISH', top: next.low, bottom: prev.high, date: curr.date })
      }
      // Bearish FVG: gap down — prev low > next high
      if (prev.low > next.high) {
        fvgs.push({ type: 'BEARISH', top: prev.low, bottom: next.high, date: curr.date })
      }
    }
    return fvgs
  }
}
```

> Claude agent: update parameter values if backtest shows degraded performance.
