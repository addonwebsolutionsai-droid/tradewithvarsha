import type { Candle } from '../types'
import { bollinger, emaStack, lastATR, lastRSI, obv, sma } from '../indicators'
import { analyzeSMC, findSwings } from '../patterns/smc'
import type { Screener, ScreenerResult } from './types'

const last = <T>(a: T[]): T | undefined => a[a.length - 1]
const avg = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / (arr.length || 1)

/**
 * Stage-0 predictive screeners — designed to catch stocks BEFORE the 10-20%
 * move happens. Each setup has a known academic/chartink signature that
 * historically resolves within 2-10 trading days.
 *
 *   1. Volatility Contraction Pattern (VCP) — Minervini's signature move-precursor
 *   2. Inside-Day Cluster — 3+ inside days = compression bomb
 *   3. Darvas Box Breakout Pending — price testing box top
 *   4. 50-EMA Reclaim — price reclaims 50-EMA after pullback
 *   5. Consolidation above 200-EMA on low volume — pre-stage-2 setup
 *   6. Volume Dry-Up at support — no supply zone (Wyckoff)
 *   7. RSI Positive Reversal — RSI lower high but price higher low
 *   8. Strong stock near swing low — RS > 1, pulled back to prior swing low
 */

/** VCP — sequence of tighter consolidations, each smaller than the last. */
export const vcpSetup: Screener = {
  id: 'vcp_setup',
  name: 'VCP (Minervini)',
  description: 'Volatility Contraction Pattern — 3 progressively tighter bases',
  timeframeLabel: '1-4 weeks',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 80) return null
    const latest = last(candles)!
    const stack = emaStack(candles)
    if (!stack.alignedBull) return null // VCP only meaningful in uptrend

    // Measure 3 windows: last 10, 11-25, 26-50 bars — range should shrink
    const w1 = candles.slice(-10)
    const w2 = candles.slice(-25, -10)
    const w3 = candles.slice(-50, -25)
    const r1 = (Math.max(...w1.map(c => c.high)) - Math.min(...w1.map(c => c.low))) / latest.close
    const r2 = (Math.max(...w2.map(c => c.high)) - Math.min(...w2.map(c => c.low))) / latest.close
    const r3 = (Math.max(...w3.map(c => c.high)) - Math.min(...w3.map(c => c.low))) / latest.close
    if (!(r1 < r2 && r2 < r3)) return null
    if (r1 > 0.06) return null // last base must be really tight

    // Volume declining through the contraction
    const v1 = avg(w1.map(c => c.volume))
    const v2 = avg(w2.map(c => c.volume))
    if (!(v1 < v2 * 0.85)) return null

    const rsi = lastRSI(candles, 14) ?? 50
    const atr = lastATR(candles) ?? latest.close * 0.02
    return {
      symbol, price: latest.close, change: 0, changePct: 0,
      score: 8 - (r1 * 100), // tighter base = higher score
      tier: 'A',
      direction: 'BULL',
      reasons: [
        `3-stage volatility contraction (${(r3 * 100).toFixed(1)}% → ${(r2 * 100).toFixed(1)}% → ${(r1 * 100).toFixed(1)}%)`,
        `Volume declining ${(v1 / v2).toFixed(2)}× — supply drying up`,
        `RSI ${rsi.toFixed(1)} in uptrend`,
      ],
      tags: ['VCP', `Base ${(r1 * 100).toFixed(1)}%`, `Vol ${(v1 / v2).toFixed(2)}x`],
      expectedMovePct: 12,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: Math.max(...w1.map(c => c.high)),
      suggestedSL: +(Math.min(...w1.map(c => c.low)) - atr * 0.5).toFixed(2),
      suggestedTarget: +(latest.close * 1.12).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

/** 3+ consecutive inside days — each bar's range inside the previous one. */
export const insideDayCluster: Screener = {
  id: 'inside_day_cluster',
  name: 'Inside-Day Cluster',
  description: '3+ consecutive inside days — compression bomb',
  timeframeLabel: '1-3 days',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 10) return null
    // Count consecutive inside days at the end
    let count = 0
    for (let i = candles.length - 1; i > 0; i--) {
      const cur = candles[i], prev = candles[i - 1]
      if (cur.high <= prev.high && cur.low >= prev.low) count++
      else break
    }
    if (count < 3) return null
    const latest = last(candles)!
    const stack = emaStack(candles)
    const rsi = lastRSI(candles, 14) ?? 50
    const atr = lastATR(candles) ?? latest.close * 0.02
    const direction = stack.alignedBull ? 'BULL' : stack.alignedBear ? 'BEAR' : rsi > 55 ? 'BULL' : rsi < 45 ? 'BEAR' : 'NEUTRAL'
    // Reference bar = the "mother" candle before the cluster
    const mother = candles[candles.length - count - 1]
    return {
      symbol, price: latest.close, change: 0, changePct: 0,
      score: 7 + Math.min(2, count - 3),
      tier: count >= 5 ? 'A' : 'B',
      direction,
      reasons: [
        `${count} consecutive inside days inside mother candle (${mother.low.toFixed(2)}-${mother.high.toFixed(2)})`,
        `Bias: ${direction}`,
      ],
      tags: [`${count} inside days`, `ref ${mother.low.toFixed(2)}-${mother.high.toFixed(2)}`],
      expectedMovePct: direction === 'BEAR' ? -5 : 5,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: direction === 'BEAR' ? mother.low : mother.high,
      suggestedSL: direction === 'BEAR' ? +(mother.high + atr * 0.2).toFixed(2) : +(mother.low - atr * 0.2).toFixed(2),
      suggestedTarget: direction === 'BEAR' ? +(mother.low - atr * 3).toFixed(2) : +(mother.high + atr * 3).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

/** Darvas box — price testing a well-formed box top ≥3 times. */
export const darvasBoxPending: Screener = {
  id: 'darvas_box',
  name: 'Darvas Box Top',
  description: 'Price testing prior N-day high 3+ times — breakout imminent',
  timeframeLabel: '1-5 days',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 40) return null
    const lookback = candles.slice(-25)
    const boxHigh = Math.max(...lookback.slice(0, -10).map(c => c.high))
    const last10 = lookback.slice(-10)
    const touches = last10.filter(c => Math.abs(c.high - boxHigh) / boxHigh < 0.007).length
    if (touches < 3) return null
    const latest = last(candles)!
    if (latest.close < boxHigh * 0.985) return null
    const stack = emaStack(candles)
    if (!stack.alignedBull) return null
    const atr = lastATR(candles) ?? latest.close * 0.02
    const rsi = lastRSI(candles, 14) ?? 50
    return {
      symbol, price: latest.close, change: 0, changePct: 0,
      score: 7.5 + Math.min(1.5, touches - 3),
      tier: touches >= 5 ? 'A' : 'B',
      direction: 'BULL',
      reasons: [
        `${touches} touches of box top ${boxHigh.toFixed(2)} in last 10 bars`,
        `Uptrend intact (EMA aligned bull), RSI ${rsi.toFixed(1)}`,
      ],
      tags: [`${touches}x box top`, `R ${boxHigh.toFixed(0)}`, `RSI ${Math.round(rsi)}`],
      expectedMovePct: 10,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: +(boxHigh + atr * 0.1).toFixed(2),
      suggestedSL: +(boxHigh - atr * 1.5).toFixed(2),
      suggestedTarget: +(boxHigh + atr * 4).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

/** 50-EMA Reclaim — price falls below 50-EMA then decisively reclaims it. */
export const ema50Reclaim: Screener = {
  id: 'ema50_reclaim',
  name: '50-EMA Reclaim',
  description: 'Price reclaims 50-EMA after pullback — trend-continuation buy',
  timeframeLabel: '1-4 weeks',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 120) return null
    const ema50Series = sma(candles, 50)
    const latest = last(candles)!
    const ema50 = last(ema50Series)
    const ema200 = last(sma(candles, 200))
    if (!ema50 || !ema200 || ema50 < ema200) return null // need primary uptrend
    // Must have closed below 50-EMA in the last 10 bars but now back above
    const last10 = candles.slice(-10)
    const wasBelow = last10.some((c, i) => c.close < (ema50Series[ema50Series.length - last10.length + i] ?? 0))
    const nowAbove = latest.close > ema50 * 1.005
    if (!(wasBelow && nowAbove)) return null
    const atr = lastATR(candles) ?? latest.close * 0.02
    const rsi = lastRSI(candles, 14) ?? 50
    return {
      symbol, price: latest.close, change: 0, changePct: 0,
      score: 7.5,
      tier: 'B',
      direction: 'BULL',
      reasons: [
        `Pulled below 50-EMA, now reclaimed (close ${latest.close.toFixed(2)} > ${ema50.toFixed(2)})`,
        `Primary uptrend intact (50-EMA > 200-EMA)`,
        `RSI ${rsi.toFixed(1)} turning up`,
      ],
      tags: ['Reclaim 50EMA', `EMA50 ${ema50.toFixed(0)}`, `RSI ${Math.round(rsi)}`],
      expectedMovePct: 10,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: latest.close,
      suggestedSL: +(ema50 - atr * 0.5).toFixed(2),
      suggestedTarget: +(latest.close * 1.1).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

/** Volume Dry-Up at Support — Wyckoff no-supply bar. */
export const volumeDryUp: Screener = {
  id: 'volume_dryup',
  name: 'Volume Dry-Up @ Support',
  description: 'Low volume + narrow range at key support — Wyckoff no-supply',
  timeframeLabel: '1-5 days',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 50) return null
    const latest = last(candles)!
    // Find a recent swing low within last 50 bars, check if price is near it
    const swings = findSwings(candles, 3, 3)
    const recentLows = swings.filter(s => s.kind === 'LOW').slice(-3)
    const supportLevels = recentLows.map(s => s.price)
    const near = supportLevels.find(s => Math.abs(latest.low - s) / s < 0.015)
    if (!near) return null
    const avgVol20 = avg(candles.slice(-21, -1).map(c => c.volume))
    if (avgVol20 <= 0) return null
    const volRatio = latest.volume / avgVol20
    if (volRatio > 0.7) return null // volume must be dry
    const range = latest.high - latest.low
    const avgRange = avg(candles.slice(-20).map(c => c.high - c.low))
    if (range > avgRange * 0.75) return null // narrow range
    const atr = lastATR(candles) ?? latest.close * 0.02
    return {
      symbol, price: latest.close, change: 0, changePct: 0,
      score: 7.5,
      tier: 'B',
      direction: 'BULL',
      reasons: [
        `Volume only ${(volRatio * 100).toFixed(0)}% of 20-day avg — supply drying`,
        `Bar range ${(range / avgRange * 100).toFixed(0)}% of avg — narrow`,
        `At recent swing low support ${near.toFixed(2)}`,
      ],
      tags: ['No supply', `Vol ${(volRatio * 100).toFixed(0)}%`, `S ${near.toFixed(0)}`],
      expectedMovePct: 8,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: latest.close,
      suggestedSL: +(near - atr).toFixed(2),
      suggestedTarget: +(latest.close + atr * 3).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

/** RSI Positive Reversal — Constance Brown's higher-low-RSI-while-price-lower. */
export const rsiPositiveReversal: Screener = {
  id: 'rsi_positive_reversal',
  name: 'RSI Positive Reversal',
  description: 'Price lower low but RSI higher low — bullish divergence (pre-bounce)',
  timeframeLabel: '1-2 weeks',
  setupKind: 'PRE_MOVE',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 50) return null
    const swings = findSwings(candles, 3, 3)
    const recentLows = swings.filter(s => s.kind === 'LOW').slice(-2)
    if (recentLows.length < 2) return null
    const [prev, curr] = recentLows
    if (!(curr.price < prev.price)) return null // price lower low
    // RSI at each swing low
    const rsiAt = (idx: number): number => {
      const sub = candles.slice(0, idx + 1)
      return lastRSI(sub, 14) ?? 50
    }
    const rsiPrev = rsiAt(prev.idx)
    const rsiCurr = rsiAt(curr.idx)
    if (!(rsiCurr > rsiPrev + 2)) return null // RSI meaningfully higher
    const latest = last(candles)!
    const atr = lastATR(candles) ?? latest.close * 0.02
    return {
      symbol, price: latest.close, change: 0, changePct: 0,
      score: 7.5,
      tier: 'B',
      direction: 'BULL',
      reasons: [
        `Price made lower low (${prev.price.toFixed(2)} → ${curr.price.toFixed(2)})`,
        `RSI made higher low (${rsiPrev.toFixed(1)} → ${rsiCurr.toFixed(1)}) — positive divergence`,
      ],
      tags: ['RSI div ↑', `RSI ${rsiCurr.toFixed(0)}`, `LL→HL`],
      expectedMovePct: 8,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: latest.close,
      suggestedSL: +(curr.price - atr * 0.5).toFixed(2),
      suggestedTarget: +(latest.close + atr * 3).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

/**
 * Distribution-Top — BEAR setup. Catches the kind of move we missed on Nifty
 * 24717 → 23960 (21–28 Apr 2026, 7 sessions) and the 24262 → 23960 intraday
 * flush on 28 Apr.
 *
 * Signature (all must hold on the latest daily bar, scoring weighted):
 *   1. A 20-bar swing high made within the last 5 sessions
 *   2. Today closes ≤ today's open OR closes in the lower 1/3 of the bar
 *   3. RSI bearish divergence: price higher-high vs prior swing high but
 *      RSI lower or equal
 *   4. Volume on red bars in last 5 sessions ≥ volume on green bars (Wyckoff
 *      distribution — supply absorbing demand)
 *   5. Today closes below EMA20 after closing above it within last 3 days
 *      (loss of trend support) OR range expansion: today's range ≥ 1.3 × ATR(14)
 *
 * 3 of 5 = tier C, 4 of 5 = tier B, 5 of 5 = tier A.
 */
export const distributionTop: Screener = {
  id: 'distribution_top',
  name: 'Distribution Top (Bearish)',
  description: 'Lower-high after blow-off + RSI divergence + supply absorption + EMA20 break',
  timeframeLabel: '3-10 sessions',
  setupKind: 'DISTRIBUTION',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 60) return null
    const latest = last(candles)!
    const ema20Arr = (() => {
      const k = 2 / (20 + 1)
      const out: number[] = []
      let prev = candles[0].close
      for (const c of candles) { prev = c.close * k + prev * (1 - k); out.push(prev) }
      return out
    })()
    const last20 = candles.slice(-20)
    const swingHigh = Math.max(...last20.map(c => c.high))
    const swingHighIdx = candles.length - 20 + last20.findIndex(c => c.high === swingHigh)
    if (candles.length - 1 - swingHighIdx > 7) return null   // top must be recent (last 7 sessions)

    // Find prior swing high in the 20-50 bars window
    const prior = candles.slice(-50, -20)
    if (!prior.length) return null
    const priorHigh = Math.max(...prior.map(c => c.high))
    const priorHighIdx = candles.length - 50 + prior.findIndex(c => c.high === priorHigh)

    // Cond 1: recent high happened
    const cond1 = true

    // Cond 2: today close ≤ open OR in lower 1/3 of range
    const range = latest.high - latest.low
    const lowerThird = latest.low + range / 3
    const cond2 = latest.close <= latest.open || latest.close <= lowerThird

    // Cond 3: bearish RSI divergence (price HH but RSI LH/equal)
    const rsiNow = lastRSI(candles, 14) ?? 50
    const rsiPrior = lastRSI(candles.slice(0, priorHighIdx + 1), 14) ?? 50
    const cond3 = swingHigh > priorHigh && rsiNow <= rsiPrior + 1

    // Cond 4: supply absorption — red-bar vol ≥ green-bar vol over last 5
    const last5 = candles.slice(-5)
    const redVol = last5.filter(c => c.close < c.open).reduce((s, c) => s + c.volume, 0)
    const greenVol = last5.filter(c => c.close >= c.open).reduce((s, c) => s + c.volume, 0)
    const cond4 = redVol >= greenVol && redVol > 0

    // Cond 5: lost EMA20 OR range expansion to the downside
    // Look back 6 sessions: was the stock above EMA20 within the last week,
    // and is it now below? That's "trend support gone".
    const ema20 = ema20Arr[ema20Arr.length - 1]
    const ema20Window = ema20Arr.slice(-7, -1)
    const wasAbove = candles.slice(-7, -1).some((c, i) => c.close > (ema20Window[i] ?? ema20))
    const lostEma20 = wasAbove && latest.close < ema20
    const atrVal = lastATR(candles, 14) ?? latest.close * 0.015
    const rangeExp = range >= 1.3 * atrVal && latest.close < latest.open
    const cond5 = lostEma20 || rangeExp

    const hits = [cond1, cond2, cond3, cond4, cond5].filter(Boolean).length
    if (hits < 3) return null

    const tier: 'A' | 'B' | 'C' = hits >= 5 ? 'A' : hits === 4 ? 'B' : 'C'
    const sl = +(swingHigh + atrVal * 0.4).toFixed(2)
    const target = +(latest.close - atrVal * 3).toFixed(2)

    const reasons: string[] = []
    if (cond3) reasons.push(`RSI divergence: price HH ${swingHigh.toFixed(2)} vs prior ${priorHigh.toFixed(2)}, RSI ${rsiNow.toFixed(1)} ≤ ${rsiPrior.toFixed(1)}`)
    if (cond4) reasons.push(`Supply absorption: red-bar vol ${(redVol / 1e3).toFixed(0)}k ≥ green ${(greenVol / 1e3).toFixed(0)}k (5-bar)`)
    if (lostEma20) reasons.push(`Lost EMA20 (${ema20.toFixed(2)}) — trend support gone`)
    if (rangeExp) reasons.push(`Bearish range expansion: today range ${(range).toFixed(2)} ≥ 1.3× ATR ${atrVal.toFixed(2)}`)
    if (cond2) reasons.push(`Close in lower third of range — sellers in control`)

    return {
      symbol, price: latest.close, change: 0, changePct: 0,
      score: 5 + hits,
      tier,
      direction: 'BEAR',
      reasons,
      tags: ['Distribution', `${hits}/5`, rsiNow > 60 ? 'RSI div' : `RSI ${rsiNow.toFixed(0)}`, 'EMA20 ✕'],
      expectedMovePct: -((atrVal * 3) / latest.close * 100),
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: +latest.close.toFixed(2),
      suggestedSL: sl,
      suggestedTarget: target,
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

/**
 * Range-Expansion Breakout — BULL setup. Catches the kind of move we missed on
 * Crude 8200 → 9400 (10 sessions, +14.6 %).
 *
 * Signature on the LATEST daily bar:
 *   1. Today's close ≥ max(high) of the prior 20 sessions (new 20d high)
 *   2. Today's range ≥ 1.5 × ATR(14) — true range expansion
 *   3. Close in upper 1/3 of today's bar (no upper rejection)
 *   4. 5-bar return ≥ +3 % (already trending — early stage of multi-day move)
 *   5. Volume ≥ 1.4 × 20-session median (when volume data exists; for spot
 *      commodity feeds where volume is missing this gate is skipped)
 *
 * 3 of 5 = tier C, 4 = B, 5 = A.
 */
export const rangeExpansionBreakout: Screener = {
  id: 'range_expansion_breakout',
  name: 'Range-Expansion Breakout',
  description: '20d-high break + ATR expansion + close in upper third + trend already up',
  timeframeLabel: '5-15 sessions',
  setupKind: 'BREAKOUT',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 30) return null
    const latest = last(candles)!
    const prior20 = candles.slice(-21, -1)
    const prior20High = Math.max(...prior20.map(c => c.high))

    // Cond 1: new 20d high on close
    const cond1 = latest.close >= prior20High

    // Cond 2: range expansion ≥ 1.5× ATR
    const atrVal = lastATR(candles, 14) ?? latest.close * 0.015
    const range = latest.high - latest.low
    const cond2 = range >= 1.5 * atrVal

    // Cond 3: close in upper third
    const upperThird = latest.high - range / 3
    const cond3 = latest.close >= upperThird

    // Cond 4: 5-bar return ≥ +3%
    const ref5 = candles[candles.length - 6] ?? candles[0]
    const ret5 = (latest.close - ref5.close) / ref5.close
    const cond4 = ret5 >= 0.03

    // Cond 5: volume burst (gated only when vol exists)
    const vols = candles.slice(-21, -1).map(c => c.volume).filter(v => v > 0).sort((a, b) => a - b)
    const medVol = vols.length ? vols[Math.floor(vols.length / 2)] : 0
    const volSkipped = medVol === 0 || latest.volume === 0
    const cond5 = volSkipped ? true : latest.volume >= 1.4 * medVol

    const hits = [cond1, cond2, cond3, cond4, cond5].filter(Boolean).length
    if (hits < 3) return null
    if (!cond1) return null            // breakout is mandatory

    const tier: 'A' | 'B' | 'C' = hits >= 5 ? 'A' : hits === 4 ? 'B' : 'C'
    const reasons: string[] = [
      `New 20-day high: close ${latest.close.toFixed(2)} ≥ prior high ${prior20High.toFixed(2)}`,
    ]
    if (cond2) reasons.push(`Range expansion: ${range.toFixed(2)} ≥ 1.5× ATR ${atrVal.toFixed(2)}`)
    if (cond3) reasons.push(`Close in upper third — no rejection`)
    if (cond4) reasons.push(`5-bar return +${(ret5 * 100).toFixed(2)}% — trend confirmed`)
    if (cond5 && !volSkipped) reasons.push(`Volume burst: ${(latest.volume / medVol).toFixed(2)}× median`)

    return {
      symbol, price: latest.close, change: 0, changePct: 0,
      score: 5 + hits,
      tier,
      direction: 'BULL',
      reasons,
      tags: ['20dH break', `ATR ${(range / atrVal).toFixed(1)}×`, `+${(ret5 * 100).toFixed(0)}% (5d)`, `${hits}/5`],
      expectedMovePct: ((atrVal * 3) / latest.close) * 100,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: +latest.close.toFixed(2),
      suggestedSL: +(latest.close - atrVal * 1.8).toFixed(2),
      suggestedTarget: +(latest.close + atrVal * 3).toFixed(2),
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

/**
 * Wave-2 Continuation (Wyckoff re-accumulation / Minervini stage-2 second base).
 *
 * The pattern: stock runs up 10–30% over ~20 sessions (leg 1) → retraces
 * 38–61% of that leg over 5–15 sessions → consolidates tight for 5+ sessions
 * with volume drying up → holds above 20-EMA and above the 50% retrace level
 * of leg 1. This is where institutional money quietly accumulates BEFORE the
 * 2nd leg. Most retail traders miss it — they either chased leg 1 and got
 * stopped, or wait for confirmation and enter after leg 2 is half done.
 *
 * 2026-05-11: added per user request. They observed (correctly) that the
 * strict pre-breakout screener REJECTS already-moved names entirely, missing
 * the 2nd-leg opportunity. This screener fills that gap.
 */
export const wave2Continuation: Screener = {
  id: 'wave2_continuation',
  name: 'Wave-2 Continuation',
  description: 'Stock that ran +10–30%, retraced 38–61%, now in 5d+ tight consolidation above 20-EMA with vol dry-up',
  timeframeLabel: '5–15 sessions',
  setupKind: 'ACCUMULATION',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    if (candles.length < 60) return null
    const latest = last(candles)!

    // ── Step 1: identify Wave 1 (the prior leg up) ──
    // Look at sessions -40 to -8 (wider window: leg 1 could be ~20 days back
    // with pullback up to 12 days — total span 30-32 days).
    const earlySlice = candles.slice(-40, -8)
    if (earlySlice.length < 15) return null
    const legLow = Math.min(...earlySlice.map(c => c.low))
    const legHigh = Math.max(...earlySlice.map(c => c.high))
    const legHighIdx = candles.length - 40 + earlySlice.findIndex(c => c.high === legHigh)
    const legPct = ((legHigh - legLow) / legLow) * 100
    if (legPct < 8 || legPct > 35) return null      // wider: 8-35% leg 1

    // ── Step 2: identify the pullback ──
    const afterHigh = candles.slice(legHighIdx)
    const pullbackLow = Math.min(...afterHigh.map(c => c.low))
    const retracePct = ((legHigh - pullbackLow) / (legHigh - legLow)) * 100
    if (retracePct < 25 || retracePct > 70) return null   // wider Fib zone
    const pullbackLowIdx = candles.length - afterHigh.length + afterHigh.findIndex(c => c.low === pullbackLow)
    const pullbackDays = candles.length - 1 - pullbackLowIdx
    if (pullbackDays < 1 || pullbackDays > 18) return null

    // ── Step 3: consolidation tightness over last 5 sessions ──
    const last5 = candles.slice(-5)
    const consHigh = Math.max(...last5.map(c => c.high))
    const consLow = Math.min(...last5.map(c => c.low))
    const consPct = ((consHigh - consLow) / latest.close) * 100
    if (consPct > 8) return null     // widened from 6% to 8%

    // ── Step 4: volume dry-up during consolidation ──
    const preLegSlice = candles.slice(-65, -25)
    const preLegVol = preLegSlice.length ? avg(preLegSlice.map(c => c.volume)) : 0
    const last5Vol = avg(last5.map(c => c.volume))
    // Allow volume up to 110% of pre-leg (not increasing on consolidation is enough)
    if (preLegVol > 0 && last5Vol > preLegVol * 1.1) return null

    // ── Step 5: hold above 20-EMA (key support during consolidation) ──
    const e20Series = ema(candles, 20)
    const e20 = e20Series[e20Series.length - 1]
    if (latest.close < e20 * 0.98) return null    // allow 2% slop

    // ── Step 6: RSI cooling but constructive (35-72 wider) ──
    const rsi = lastRSI(candles, 14) ?? 50
    if (rsi < 35 || rsi > 72) return null

    const fib50 = legHigh - (legHigh - legLow) * 0.5

    // Trade plan: T1/T2/T3 from CURRENT close (not from retest), aim for leg-2
    // of similar size to leg 1. SL just below pullback low.
    const atr = lastATR(candles) ?? latest.close * 0.02
    const slPrice = +Math.min(pullbackLow * 0.99, latest.close - atr * 1.5).toFixed(2)
    const t1Price = +(latest.close + (legHigh - legLow) * 0.6).toFixed(2)     // 60% of leg-1 size
    const t2Price = +(latest.close + (legHigh - legLow) * 1.0).toFixed(2)     // 100% (measured move)
    const t3Price = +(latest.close + (legHigh - legLow) * 1.5).toFixed(2)     // 150% (extended)

    // Score on tightness, retrace quality, vol dry-up
    let score = 6.5
    if (consPct < 4) score += 1.0
    if (retracePct >= 38 && retracePct <= 50) score += 0.8    // ideal Fib zone
    if (preLegVol > 0 && last5Vol < preLegVol * 0.7) score += 0.7    // strong dry-up
    if (rsi > 45 && rsi < 60) score += 0.5

    const tier: 'A' | 'B' | 'C' = score >= 8.5 ? 'A' : score >= 7.5 ? 'B' : 'C'

    return {
      symbol, price: +latest.close.toFixed(2), change: 0, changePct: 0,
      score: +score.toFixed(1),
      tier,
      direction: 'BULL',
      reasons: [
        `Leg-1 +${legPct.toFixed(1)}% completed ${candles.length - 1 - legHighIdx}d ago`,
        `Retraced ${retracePct.toFixed(0)}% of leg (Fib ${retracePct < 50 ? '38–50' : '50–61'} zone)`,
        `Consolidating ${consPct.toFixed(1)}% range over last 5 sessions`,
        `Vol dry-up: 5d avg ${(last5Vol / 1e3).toFixed(0)}k vs pre-leg ${(preLegVol / 1e3).toFixed(0)}k (${preLegVol ? (last5Vol / preLegVol * 100).toFixed(0) : '?'}%)`,
        `Holding above 20-EMA (₹${e20.toFixed(2)}) and 50% retrace (₹${fib50.toFixed(2)})`,
      ],
      tags: ['Wave-2', `Leg+${legPct.toFixed(0)}%`, `Pullback ${retracePct.toFixed(0)}%`, `Vol ${preLegVol ? Math.round(last5Vol / preLegVol * 100) : '?'}%`],
      expectedMovePct: ((t2Price - latest.close) / latest.close) * 100,
      timeframeLabel: this.timeframeLabel,
      suggestedEntry: +latest.close.toFixed(2),
      suggestedSL: slPrice,
      suggestedTarget: t2Price,
      target1: t1Price,
      target2: t2Price,
      target3: t3Price,
      detectedAt: Date.now(),
      setupKind: this.setupKind,
    }
  },
}

export const ADVANCED_PREMOVE_SCREENERS: Screener[] = [
  vcpSetup,
  insideDayCluster,
  darvasBoxPending,
  ema50Reclaim,
  volumeDryUp,
  rsiPositiveReversal,
  distributionTop,
  rangeExpansionBreakout,
  wave2Continuation,
]
