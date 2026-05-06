import type { Candle, Direction, SignalType, TradePlan } from '../types'
import { addTradingDays, todayIST } from '../util/time'
import { sessionHoras, horaAt } from '../astro/parashariHora'

/**
 * Build a war-room-style trade plan for a signal: entry/exit windows,
 * hold horizon, and (for OPTIONS) the explicit leg + premium ladder.
 *
 * Every plan now carries (where the signal supplies enough info):
 *   - T1, T2, T3 prices + projected hit dates
 *   - Narrow "best-entry-time" window aligned to the Parashari hora whose
 *     planetary bias matches the trade direction. This gives intraday /
 *     options callers a precise 30-60 min slot to act on, versus the
 *     old wide "09:30-13:30 IST" label.
 *   - Entry-price zone (entryPriceLow/High) — the acceptable buy/sell
 *     band around the signal entry (ATR-agnostic ±0.4% by default).
 *
 * Premium ladder for options: SL ≈ -20% of entry, T1 ≈ +35%, T2 ≈ +80%
 * (matches the ratios already hardcoded in strategies/options.ts).
 *
 * Lot sizing assumes ~₹5L capital and ≤20% per trade per the 12-rules
 * doc. Caller can override.
 */
export function buildTradePlan(args: {
  type: SignalType
  underlying?: string
  strike?: number
  side?: 'CE' | 'PE'
  expiry?: string
  premium?: number
  capital?: number
  /** Spot / entry price on the underlying — used to derive T3 + entry band. */
  entry?: number
  /** Strategy's T2 level — T3 is derived as a 1.6× extension from it. */
  target2?: number
  /** Direction of the trade — drives hora alignment. */
  direction?: Direction
  /** ISO timestamp of the candle that triggered the signal — anchors the
   *  "best entry time" to when the chart fired, not to market-open. */
  asOf?: string
  /**
   * Recent 15m candles of the underlying. When provided we look at the
   * last 8-12 sessions' volume profile to propose a time-of-day window
   * that historically leads the trade direction. Optional — falls back
   * to pure hora-alignment when missing.
   */
  candles?: Candle[]
}): TradePlan {
  const { type, underlying, strike, side, expiry, premium, entry, target2, direction, asOf, candles } = args
  const capital = args.capital ?? 500_000

  const entryExit = ENTRY_EXIT_BY_TYPE[type]

  let optionLeg: TradePlan['optionLeg'] | undefined
  if (type === 'OPTIONS' && underlying && strike && side && premium && expiry) {
    const lotSize = LOT_SIZE[underlying] ?? 25
    // Position size = min(risk-based, premium-based, hard cap).
    // - risk-based:    20% of capital ÷ (SL distance × lot size)
    // - premium-based: 40% of capital ÷ (premium × lot size)   ← stops the
    //   "149-lot" overflow when premium is small
    // - hard cap:      5 lots per single signal (retail-realistic)
    const riskPerLot = premium * 0.2 * lotSize
    const premiumPerLot = premium * lotSize
    const byRisk = Math.floor((capital * 0.2) / Math.max(riskPerLot, 1))
    const byPremium = Math.floor((capital * 0.4) / Math.max(premiumPerLot, 1))
    const lots = Math.max(1, Math.min(byRisk, byPremium, 5))
    optionLeg = {
      underlying,
      strike,
      side,
      expiry,
      premium: +premium.toFixed(2),
      slPremium: +(premium * 0.8).toFixed(2),
      t1Premium: +(premium * 1.35).toFixed(2),
      t2Premium: +(premium * 1.8).toFixed(2),
      lots,
    }
  }

  // Concrete entry / target dates derived from the type's hold horizon.
  // Intraday-style trades resolve same-day; swing/positional spread to TD+N.
  const td = TARGET_DAYS_BY_TYPE[type]
  const today = todayIST()
  const now = new Date()
  const target1Date = td.t1 === 0 ? today : addTradingDays(now, td.t1)
  const target2Date = td.t2 === 0 ? today : addTradingDays(now, td.t2)
  const target3Date = td.t3 === 0 ? today : addTradingDays(now, td.t3)
  const exitDate   = td.exit === 0 ? today : addTradingDays(now, td.exit)

  // T3 price — 1.6× the entry→T2 distance, direction-aware.
  let target3: number | undefined
  if (entry != null && target2 != null) {
    const ext = (target2 - entry) * 1.6
    target3 = +(entry + ext).toFixed(2)
  }

  // Entry band — ±0.4% around spot, or ±₹1 at absolute floor for low-priced names.
  let entryPriceLow: number | undefined
  let entryPriceHigh: number | undefined
  if (entry != null) {
    const band = Math.max(entry * 0.004, 1)
    if (direction === 'SELL') {
      // Short: sell on rally to entry — band above spot
      entryPriceLow = +(entry).toFixed(2)
      entryPriceHigh = +(entry + band).toFixed(2)
    } else {
      // Long: buy on dip to entry — band below spot
      entryPriceLow = +(entry - band).toFixed(2)
      entryPriceHigh = +(entry).toFixed(2)
    }
  }

  // Precise per-signal entry timing.
  //
  // Two signals inputs feed this:
  //   (a) volume-profile lead time — from the underlying's 15m candles we
  //       compute the mean directional move for every 15-min bucket across
  //       the last 8 sessions. The time-of-day bucket with the strongest
  //       move in our direction is the "move window"; entering 15-30 min
  //       *before* that window is how we "pick before the move happens"
  //       rather than chasing. This gives each signal its own window
  //       instead of the generic 09:30-13:30 constant.
  //   (b) Parashari hora alignment — lord of the session hora matching
  //       the trade direction (Jupiter/Sun/Mars for BULL, Saturn for BEAR).
  //
  // The final `bestEntryTimeIST` is the INTERSECTION (or next alignment
  // after the signal fired, whichever is sooner). `horaNote` explains.
  let bestEntryTimeIST: string | undefined
  let horaLord: string | undefined
  let horaNote: string | undefined
  const isSameSession = type === 'INTRADAY' || type === 'OPTIONS' || type === 'COMMODITY' || type === 'FUTURES'
  if (isSameSession && direction) {
    // Reference time: when the chart actually triggered. Defaults to now if
    // the caller didn't pass asOf (e.g. snapshot mode before market opens).
    const ref = asOf ? new Date(asOf) : now
    const refMin = istMinuteOfDay(ref)

    // (a) chart-based move window from 15m volume profile (if data given)
    const moveWindow = candles?.length ? leadingMoveWindow(candles, direction) : null

    // (b) hora window — first aligned hora whose END is after refMin
    const horas = sessionHoras(now)
    const wantsBull = direction === 'BUY'
    const alignedHoras = horas.filter(h =>
      (wantsBull ? h.bias === 'BULLISH' : h.bias === 'BEARISH')
      && hmToMin(h.endIST) > refMin,
    )
    const fallbackHoras = horas.filter(h => hmToMin(h.endIST) > refMin)

    // Pick: prefer chart-window clipped to nearest aligned hora; else
    // first aligned hora after ref; else first available hora after ref.
    let pick: { start: number; end: number; lord?: string; bias?: string } | null = null
    if (moveWindow) {
      const clipHora = alignedHoras.find(h =>
        hmToMin(h.startIST) <= moveWindow.end && hmToMin(h.endIST) >= moveWindow.start,
      ) ?? alignedHoras[0] ?? fallbackHoras[0]
      if (clipHora) {
        // Intersect the hora and the pre-move window, clamped to a 30-45 min band
        const start = Math.max(moveWindow.start, hmToMin(clipHora.startIST), refMin)
        const end = Math.min(moveWindow.end, hmToMin(clipHora.endIST))
        if (end > start + 5) {
          pick = { start, end, lord: clipHora.lord, bias: clipHora.bias }
        }
      }
    }
    if (!pick) {
      const h = alignedHoras[0] ?? fallbackHoras[0]
      if (h) pick = { start: hmToMin(h.startIST), end: hmToMin(h.endIST), lord: h.lord, bias: h.bias }
    }
    if (pick) {
      bestEntryTimeIST = `${minToHM(pick.start)}-${minToHM(pick.end)}`
      horaLord = pick.lord
      const lead = moveWindow ? ` · pre-move (vol-profile)` : ''
      horaNote = `${pick.lord ?? 'Neutral'} hora · ${pick.bias ?? ''}${lead}`.trim()
    } else {
      // Fallback — no session hora matched (after-hours signal). Still
      // surface the currently-active hora so the card isn't blank.
      const h = horaAt(now)
      bestEntryTimeIST = `${h.startIST}-${h.endIST}`
      horaLord = h.lord
      horaNote = `${h.lord} hora · ${h.bias}`
    }
  }

  return {
    entryWindow: entryExit.entry,
    exitWindow: entryExit.exit,
    holdHorizon: entryExit.hold,
    entryDate: today,
    target1Date,
    target2Date,
    target3,
    target3Date,
    exitDate,
    bestEntryTimeIST,
    horaLord,
    horaNote,
    entryPriceLow,
    entryPriceHigh,
    optionLeg,
  }
}

// Trading-day deltas per signal type — matches the holdHorizon labels above.
// 0 = same session. `exit` is the hard time-stop.
const TARGET_DAYS_BY_TYPE: Record<SignalType, { t1: number; t2: number; t3: number; exit: number }> = {
  INTRADAY:   { t1: 0,  t2: 0,  t3: 0,  exit: 0 },
  OPTIONS:    { t1: 1,  t2: 5,  t3: 10, exit: 10 },
  SWING:      { t1: 7,  t2: 20, t3: 35, exit: 42 },   // ~6-week hard stop
  COMMODITY:  { t1: 3,  t2: 10, t3: 18, exit: 21 },
  FUTURES:    { t1: 5,  t2: 14, t3: 25, exit: 30 },
  POSITIONAL: { t1: 21, t2: 60, t3: 90, exit: 120 },
}

const ENTRY_EXIT_BY_TYPE: Record<SignalType, { entry: string; exit: string; hold: string }> = {
  INTRADAY:   { entry: '09:30–14:00 IST · skip first 15 min', exit: 'Book by 15:15 IST · no overnight', hold: 'intraday (same session)' },
  OPTIONS:    { entry: '09:30–13:30 IST · best premium 10:30–11:30',  exit: 'Book 70 % by 13:30 IST · full exit by 14:30',  hold: '1–5 sessions' },
  SWING:      { entry: 'Any session 09:30–15:00 IST',         exit: 'T1/T2 hit OR 21-day time-stop',   hold: '1–4 weeks (target ≥20 %)' },
  COMMODITY:  { entry: '09:30–22:00 IST (MCX session)',       exit: 'T1/T2 hit OR 10-day time-stop',   hold: '3–10 sessions' },
  FUTURES:    { entry: 'Any session 09:30–15:00 IST',         exit: 'T1/T2 hit OR 14-day time-stop',   hold: '1–3 weeks' },
  POSITIONAL: { entry: 'EOD entry preferred',                  exit: 'T1/T2 hit OR 60-day time-stop',   hold: '1–3 months' },
}

// NSE F&O lot sizes — kept here so strategies don't duplicate.
const LOT_SIZE: Record<string, number> = {
  NIFTY: 25,
  BANKNIFTY: 15,
  FINNIFTY: 25,
}

// ─── Time-of-day helpers (IST minute-of-day) ─────────────────────

function hmToMin(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}

function minToHM(mins: number): string {
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function istMinuteOfDay(d: Date): number {
  // Approximate IST conversion — matches parashariHora.horaAt.
  const istHours = (d.getUTCHours() + 5.5) % 24
  return Math.floor(istHours) * 60 + d.getUTCMinutes()
}

/**
 * Volume-profile lead-window detector.
 *
 * Scans the last ~8 sessions of 15m candles, bucketed by time-of-day.
 * For each bucket it computes the mean directional return over the bar.
 * The bucket with the strongest return in our direction is the "move
 * window". We return the 30-minute slot IMMEDIATELY BEFORE it — this is
 * the "enter before the move" window the user asked for.
 *
 * Returns null when there's too little data (< 40 candles) or no bucket
 * shows a meaningful edge (> 0.1% mean move).
 */
function leadingMoveWindow(candles: Candle[], direction: Direction): { start: number; end: number } | null {
  if (candles.length < 40) return null
  const sign = direction === 'BUY' ? 1 : -1
  const bucketSum: Record<number, number> = {}
  const bucketCnt: Record<number, number> = {}
  // Look at the last 8 sessions' worth (roughly 8 * 25 = 200 bars max)
  const slice = candles.slice(-200)
  for (const c of slice) {
    const d = new Date(c.time)
    const minOfDay = istMinuteOfDay(d)
    // Snap to nearest 15-min bucket
    const bucket = Math.floor(minOfDay / 15) * 15
    if (bucket < 9 * 60 + 15 || bucket > 15 * 60) continue     // NSE session only
    const ret = c.open > 0 ? (c.close - c.open) / c.open : 0
    bucketSum[bucket] = (bucketSum[bucket] ?? 0) + ret
    bucketCnt[bucket] = (bucketCnt[bucket] ?? 0) + 1
  }
  let bestBucket = -1
  let bestEdge = 0
  for (const k of Object.keys(bucketSum)) {
    const b = Number(k)
    const n = bucketCnt[b] ?? 0
    if (n < 4) continue    // need at least 4 occurrences to trust it
    const mean = (bucketSum[b] / n) * sign     // signed toward direction
    if (mean > bestEdge) { bestEdge = mean; bestBucket = b }
  }
  if (bestBucket < 0 || bestEdge < 0.001) return null   // < 0.1% edge → skip
  // Entry window = 30 min BEFORE the strongest directional bucket, clipped
  // to the opening-range floor (we don't want to front-run 9:15).
  const end = bestBucket
  const start = Math.max(end - 30, 9 * 60 + 30)        // skip first 15 min
  return { start, end }
}
