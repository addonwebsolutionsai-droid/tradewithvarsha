/**
 * Volume Profile — the framework used by institutions, hedge funds, and
 * market-makers to read where the "auction" has accepted or rejected price.
 *
 * PUBLIC METHODOLOGY, ORIGINAL CODE.
 * Concepts (POC, VAH, VAL, HVN, LVN, Value Area, Initial Balance) are
 * standard trading vocabulary from decades of published literature
 * (J. P. Steidlmayer's Market Profile, J. Dalton "Mind Over Markets",
 * "Markets in Profile"). This implementation is written from scratch.
 *
 * Definitions used here:
 *   POC (Point of Control) — the price bin with the HIGHEST traded volume
 *                            in the sample. Where the auction spent the
 *                            most time / where institutions are anchored.
 *   VA  (Value Area)       — the CONTIGUOUS price range around POC that
 *                            contains 70% of the total volume. Institutions
 *                            treat this as "fair value" for the session.
 *   VAH (Value Area High)  — the top of VA. Above VAH = "high-value area"
 *                            rejection candidate.
 *   VAL (Value Area Low)   — the bottom of VA. Below VAL = "low-value area"
 *                            rejection candidate.
 *   HVN (High-Volume Node) — local peak in the profile ≠ POC. Acts as
 *                            magnet — price tends to return to it.
 *   LVN (Low-Volume Node)  — local valley in the profile. Acts as a
 *                            "vacuum" — price accelerates through it.
 *   IB  (Initial Balance)  — the range formed in the first 60 min of the
 *                            session. Break of IB high/low on volume = a
 *                            directional-day signature.
 *
 * Trading rules encoded (see niftyVolumeProfileEngine.ts for the router):
 *   1. VA-BREAKOUT — close outside VA on volume expansion → continuation
 *   2. VA-ROTATION — reject at VAH/VAL and return toward POC → mean-revert
 *   3. HVN-REJECT  — multiple tests of an HVN without breaking → coil
 *   4. LVN-SLICE   — fast candles through an LVN → extension likely
 *   5. IB-BREAK    — break of IB high/low with confirming volume → trend day
 *   6. FAILED-AUCT — quick spike outside VA then rejection back inside → reversal
 *   7. NAKED-POC   — prior day/week/month POC untested → future magnet
 *
 * This is timeframe-agnostic: profile can be built on 5m/15m/30m/45m/1h/2h/
 * 4h/1D/1W/1M candles by simply feeding the corresponding candle series.
 */

import type { Candle } from '../types'

// ─── Types ─────────────────────────────────────────────────────────────

export interface ProfileBin {
  price: number         // mid-price of the bin
  low: number           // low edge
  high: number          // high edge
  volume: number        // total traded volume in this bin
  trades: number        // count of contributing candles
}

export interface VolumeProfile {
  timeframe: string
  from: number          // first candle time (ms)
  to: number            // last candle time (ms)
  bins: ProfileBin[]    // sorted low→high
  binSize: number
  poc: number           // price of point of control
  vah: number           // value-area high
  val: number           // value-area low
  vaVolumePct: number   // fraction of total volume inside [VAL, VAH]
  totalVolume: number
  hvn: number[]         // prices of high-volume nodes (excluding POC)
  lvn: number[]         // prices of low-volume nodes
  initialBalanceHigh: number   // first 60 min high (0 if session-less)
  initialBalanceLow: number
}

// ─── Core builder ──────────────────────────────────────────────────────

/**
 * Build a volume profile from an array of candles.
 * @param candles   OHLCV candles (any timeframe)
 * @param binCount  number of price bins between session low and high.
 *                  Defaults to 50; classical Market Profile uses 30 for a
 *                  full day but higher bin counts give finer HVN/LVN detection.
 * @param volumePerCandle   distribute the candle's volume uniformly across
 *                          [low, high] of the candle (TPO-like fill).
 */
export function buildVolumeProfile(
  candles: Candle[],
  binCount = 50,
  timeframe = '?',
): VolumeProfile | null {
  if (candles.length < 5) return null
  let sessLow = Infinity
  let sessHigh = -Infinity
  for (const c of candles) {
    if (c.low < sessLow) sessLow = c.low
    if (c.high > sessHigh) sessHigh = c.high
  }
  if (!Number.isFinite(sessLow) || !Number.isFinite(sessHigh) || sessHigh <= sessLow) return null

  const binSize = (sessHigh - sessLow) / binCount
  const bins: ProfileBin[] = Array.from({ length: binCount }, (_, i) => ({
    price: sessLow + (i + 0.5) * binSize,
    low: sessLow + i * binSize,
    high: sessLow + (i + 1) * binSize,
    volume: 0,
    trades: 0,
  }))

  // Distribute each candle's volume uniformly across the bins its [low, high]
  // range touches. This is a reasonable proxy for the true tick-by-tick
  // volume-at-price when we only have OHLCV bar data.
  let total = 0
  for (const c of candles) {
    if (c.high <= c.low || c.volume <= 0) continue
    const firstBin = Math.max(0, Math.floor((c.low - sessLow) / binSize))
    const lastBin = Math.min(binCount - 1, Math.floor((c.high - sessLow) / binSize))
    const n = lastBin - firstBin + 1
    if (n <= 0) continue
    const share = c.volume / n
    for (let b = firstBin; b <= lastBin; b++) {
      bins[b].volume += share
      bins[b].trades += 1
    }
    total += c.volume
  }

  if (total <= 0) return null

  // ── POC = highest-volume bin
  let pocIdx = 0
  let pocVol = 0
  for (let i = 0; i < bins.length; i++) {
    if (bins[i].volume > pocVol) {
      pocVol = bins[i].volume
      pocIdx = i
    }
  }
  const poc = bins[pocIdx].price

  // ── Value Area = expand around POC until we cover 70% of total volume.
  // Standard algorithm: at each step, compare the sum of the next 2 bins ABOVE
  // vs the next 2 bins BELOW; expand toward whichever side has more volume.
  let hi = pocIdx
  let lo = pocIdx
  let vaVolume = bins[pocIdx].volume
  const targetVolume = total * 0.70
  while (vaVolume < targetVolume && (lo > 0 || hi < bins.length - 1)) {
    const above1 = hi + 1 < bins.length ? bins[hi + 1].volume : 0
    const above2 = hi + 2 < bins.length ? bins[hi + 2].volume : 0
    const below1 = lo - 1 >= 0 ? bins[lo - 1].volume : 0
    const below2 = lo - 2 >= 0 ? bins[lo - 2].volume : 0
    const aboveSum = above1 + above2
    const belowSum = below1 + below2
    if (aboveSum > belowSum && hi < bins.length - 1) {
      const take = Math.min(2, bins.length - 1 - hi)
      for (let k = 1; k <= take; k++) vaVolume += bins[hi + k].volume
      hi += take
    } else if (lo > 0) {
      const take = Math.min(2, lo)
      for (let k = 1; k <= take; k++) vaVolume += bins[lo - k].volume
      lo -= take
    } else if (hi < bins.length - 1) {
      const take = Math.min(2, bins.length - 1 - hi)
      for (let k = 1; k <= take; k++) vaVolume += bins[hi + k].volume
      hi += take
    } else break
  }
  const val = bins[lo].low
  const vah = bins[hi].high

  // ── HVN + LVN via local-maxima / local-minima in the volume series.
  // Cutoffs: HVN = local peak > mean × 1.4; LVN = local trough < mean × 0.4.
  const meanVol = total / binCount
  const hvn: number[] = []
  const lvn: number[] = []
  for (let i = 1; i < bins.length - 1; i++) {
    const v = bins[i].volume
    const l = bins[i - 1].volume
    const r = bins[i + 1].volume
    if (v > l && v > r && v > meanVol * 1.4 && bins[i].price !== poc) {
      hvn.push(bins[i].price)
    }
    if (v < l && v < r && v < meanVol * 0.4) {
      lvn.push(bins[i].price)
    }
  }

  // ── Initial Balance: first 60 minutes of candles (if we have timestamps).
  // Assumes candles are within a session; if candles span multiple sessions,
  // IB is meaningless. We compute it anyway; the engine layer decides whether
  // to use it based on the timeframe (only meaningful for intraday profiles).
  let initialBalanceHigh = 0
  let initialBalanceLow = 0
  if (candles.length > 0) {
    const t0 = candles[0].time
    const cutoffMs = t0 + 60 * 60_000
    let ibHigh = -Infinity
    let ibLow = Infinity
    for (const c of candles) {
      if (c.time > cutoffMs) break
      if (c.high > ibHigh) ibHigh = c.high
      if (c.low < ibLow) ibLow = c.low
    }
    if (Number.isFinite(ibHigh) && Number.isFinite(ibLow)) {
      initialBalanceHigh = ibHigh
      initialBalanceLow = ibLow
    }
  }

  return {
    timeframe,
    from: candles[0].time,
    to: candles[candles.length - 1].time,
    bins,
    binSize,
    poc,
    vah,
    val,
    vaVolumePct: vaVolume / total,
    totalVolume: total,
    hvn,
    lvn,
    initialBalanceHigh,
    initialBalanceLow,
  }
}

// ─── Setup detectors ───────────────────────────────────────────────────

export type VpSetup =
  | 'VA_BREAKOUT_UP' | 'VA_BREAKOUT_DOWN'
  | 'VA_ROTATION_FROM_VAH' | 'VA_ROTATION_FROM_VAL'
  | 'HVN_REJECT_UP' | 'HVN_REJECT_DOWN'
  | 'LVN_SLICE_UP' | 'LVN_SLICE_DOWN'
  | 'IB_BREAK_UP' | 'IB_BREAK_DOWN'
  | 'FAILED_AUCTION_HIGH' | 'FAILED_AUCTION_LOW'
  | 'NAKED_POC_ABOVE' | 'NAKED_POC_BELOW'

export interface VpSignal {
  setup: VpSetup
  side: 'BULLISH' | 'BEARISH'
  strength: number      // 0-100
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  reason: string
  keyLevel: number      // the VP level that anchored the setup
}

/**
 * Detect setups given a profile + the most-recent candles.
 * `recent` should be the last 5-10 candles in the same timeframe as the
 * profile was built on, so we can inspect the CURRENT interaction with
 * VP levels (rejection wick, breakout close, IB break, etc).
 */
export function detectSetups(
  profile: VolumeProfile,
  recent: Candle[],
  atr: number,
): VpSignal[] {
  if (recent.length < 3) return []
  const signals: VpSignal[] = []
  const last = recent[recent.length - 1]
  const prev = recent[recent.length - 2]
  const spot = last.close
  const { poc, vah, val, hvn, lvn, initialBalanceHigh: ibH, initialBalanceLow: ibL } = profile
  const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol
  const tolVA = atr * 0.35    // "near VAH/VAL" tolerance

  // ── 1. VA-BREAKOUT (continuation)
  if (prev.close <= vah && last.close > vah && last.volume > (prev.volume || 1)) {
    signals.push({
      setup: 'VA_BREAKOUT_UP', side: 'BULLISH', strength: 70,
      entry: spot, stopLoss: vah - atr * 0.5,
      target1: spot + atr * 1, target2: spot + atr * 2, target3: spot + atr * 3.5,
      keyLevel: vah,
      reason: `Close ${spot.toFixed(2)} above VAH ${vah.toFixed(2)} on volume expansion — auction accepting higher value`,
    })
  }
  if (prev.close >= val && last.close < val && last.volume > (prev.volume || 1)) {
    signals.push({
      setup: 'VA_BREAKOUT_DOWN', side: 'BEARISH', strength: 70,
      entry: spot, stopLoss: val + atr * 0.5,
      target1: spot - atr * 1, target2: spot - atr * 2, target3: spot - atr * 3.5,
      keyLevel: val,
      reason: `Close ${spot.toFixed(2)} below VAL ${val.toFixed(2)} on volume expansion — auction accepting lower value`,
    })
  }

  // ── 2. VA-ROTATION (mean-revert to POC after rejection at VAH/VAL)
  //    This is what caught the user's 15-Jul 24200 PE trade: NIFTY spiked
  //    to ~24,220 (near VAH), rejected, and rotated back toward POC ~24,080.
  if (last.high >= vah && last.close < vah && last.close < prev.close && near(last.high, vah, tolVA)) {
    signals.push({
      setup: 'VA_ROTATION_FROM_VAH', side: 'BEARISH', strength: 75,
      entry: spot, stopLoss: last.high + atr * 0.3,
      target1: poc, target2: val, target3: val - atr * 0.5,
      keyLevel: vah,
      reason: `Rejection wick at VAH ${vah.toFixed(2)} → rotation back to POC ${poc.toFixed(2)} / VAL ${val.toFixed(2)}. Institutional short entry.`,
    })
  }
  if (last.low <= val && last.close > val && last.close > prev.close && near(last.low, val, tolVA)) {
    signals.push({
      setup: 'VA_ROTATION_FROM_VAL', side: 'BULLISH', strength: 75,
      entry: spot, stopLoss: last.low - atr * 0.3,
      target1: poc, target2: vah, target3: vah + atr * 0.5,
      keyLevel: val,
      reason: `Rejection wick at VAL ${val.toFixed(2)} → rotation back to POC ${poc.toFixed(2)} / VAH ${vah.toFixed(2)}. Institutional long entry.`,
    })
  }

  // ── 3. HVN-REJECT (rejection off a high-volume node = magnet)
  for (const h of hvn) {
    if (near(last.high, h, atr * 0.25) && last.close < h - atr * 0.15) {
      signals.push({
        setup: 'HVN_REJECT_DOWN', side: 'BEARISH', strength: 60,
        entry: spot, stopLoss: h + atr * 0.35,
        target1: poc, target2: val, target3: val - atr * 0.5,
        keyLevel: h,
        reason: `Rejection at HVN ${h.toFixed(2)} — institutions defending upper node`,
      })
      break
    }
    if (near(last.low, h, atr * 0.25) && last.close > h + atr * 0.15) {
      signals.push({
        setup: 'HVN_REJECT_UP', side: 'BULLISH', strength: 60,
        entry: spot, stopLoss: h - atr * 0.35,
        target1: poc, target2: vah, target3: vah + atr * 0.5,
        keyLevel: h,
        reason: `Rejection at HVN ${h.toFixed(2)} — institutions defending lower node`,
      })
      break
    }
  }

  // ── 4. LVN-SLICE (fast move through low-volume node)
  for (const l of lvn) {
    if (prev.close < l && last.close > l + atr * 0.4) {
      signals.push({
        setup: 'LVN_SLICE_UP', side: 'BULLISH', strength: 65,
        entry: spot, stopLoss: l - atr * 0.35,
        target1: spot + atr * 1.2, target2: spot + atr * 2.5, target3: spot + atr * 4,
        keyLevel: l,
        reason: `Fast candle sliced through LVN ${l.toFixed(2)} — vacuum breakout to the next HVN`,
      })
      break
    }
    if (prev.close > l && last.close < l - atr * 0.4) {
      signals.push({
        setup: 'LVN_SLICE_DOWN', side: 'BEARISH', strength: 65,
        entry: spot, stopLoss: l + atr * 0.35,
        target1: spot - atr * 1.2, target2: spot - atr * 2.5, target3: spot - atr * 4,
        keyLevel: l,
        reason: `Fast candle sliced through LVN ${l.toFixed(2)} — vacuum breakdown to the next HVN`,
      })
      break
    }
  }

  // ── 5. IB-BREAK (initial-balance breakout — trend-day signature)
  if (ibH > 0 && last.close > ibH + atr * 0.15) {
    signals.push({
      setup: 'IB_BREAK_UP', side: 'BULLISH', strength: 55,
      entry: spot, stopLoss: ibH - atr * 0.4,
      target1: spot + atr * 1.5, target2: spot + atr * 3, target3: spot + atr * 5,
      keyLevel: ibH,
      reason: `IB high ${ibH.toFixed(2)} broken decisively — trend-day signature`,
    })
  }
  if (ibL > 0 && last.close < ibL - atr * 0.15) {
    signals.push({
      setup: 'IB_BREAK_DOWN', side: 'BEARISH', strength: 55,
      entry: spot, stopLoss: ibL + atr * 0.4,
      target1: spot - atr * 1.5, target2: spot - atr * 3, target3: spot - atr * 5,
      keyLevel: ibL,
      reason: `IB low ${ibL.toFixed(2)} broken decisively — trend-day signature`,
    })
  }

  // ── 6. FAILED-AUCTION (quick spike outside VA then close back inside)
  if (last.high > vah + atr * 0.25 && last.close < vah) {
    signals.push({
      setup: 'FAILED_AUCTION_HIGH', side: 'BEARISH', strength: 68,
      entry: spot, stopLoss: last.high + atr * 0.2,
      target1: poc, target2: val, target3: val - atr * 0.4,
      keyLevel: vah,
      reason: `Failed auction above VAH ${vah.toFixed(2)} — buyers exhausted, sellers step in`,
    })
  }
  if (last.low < val - atr * 0.25 && last.close > val) {
    signals.push({
      setup: 'FAILED_AUCTION_LOW', side: 'BULLISH', strength: 68,
      entry: spot, stopLoss: last.low - atr * 0.2,
      target1: poc, target2: vah, target3: vah + atr * 0.4,
      keyLevel: val,
      reason: `Failed auction below VAL ${val.toFixed(2)} — sellers exhausted, buyers step in`,
    })
  }

  return signals
}
