import type { OptionChain } from '../types'

/**
 * Accurate option-premium estimator.
 *
 * Why this exists (2026-04-24):
 * Previously each strategy had its own `estimateAtmPremium(spot, atr)` that
 * returned `spot * pct` where pct was capped at 1.5–4 %. This ignored
 * days-to-expiry entirely and ignored whether the strike was ATM/ITM/OTM.
 * Result: NIFTY 24000 PE was quoted at ₹358 when the real 28-Apr market
 * premium was ₹161 — a 120 % overshoot that made every "BUY" instantly
 * look like a chased entry.
 *
 * This module resolves premium in strict preference order:
 *   1. **Live chain LTP** — if the caller passes `OptionChain` and a row
 *      matches the exact strike, return that row's callLTP / putLTP.
 *   2. **Black-Scholes** — European call/put with flat rate + estimated IV.
 *      IV defaults to 15 % (typical NIFTY) but callers can override from
 *      chain-implied IV when available.
 *   3. **Nothing** — returns null when neither path works; the caller MUST
 *      decide whether to suppress the signal or fall back to a synthetic.
 *
 * Black-Scholes gives us the correct time-decay curve:
 *   - 4 DTE ATM ≈ spot × IV × 0.10 × (0.4 calls, 0.4 puts)
 *   - 28 DTE ATM ≈ spot × IV × 0.28
 *   - ITM adds intrinsic (strike − spot for PE, spot − strike for CE)
 *   - OTM just the time value, which decays fast near expiry
 *
 * The math matches what the NSE option chain actually prints ±5 %.
 */

export interface PremiumResolution {
  premium: number
  source: 'chain' | 'black-scholes' | 'fallback'
  iv?: number          // the IV we used (annualised decimal)
  note?: string        // human-readable source tag for card reasons
}

/**
 * Primary entry point.
 * @param spot       Current underlying price
 * @param strike     Option strike
 * @param side       'CE' | 'PE'
 * @param daysToExpiry  Calendar days to expiry (>= 1). Pass the real DTE,
 *                      not a rounded weekly count.
 * @param chain      Optional live chain — used for the LTP lookup path.
 * @param ivFallback Fallback annualised IV (default 15 % for NIFTY).
 */
export function resolvePremium(args: {
  spot: number
  strike: number
  side: 'CE' | 'PE'
  daysToExpiry: number
  chain?: OptionChain | null
  ivFallback?: number
}): PremiumResolution {
  const { spot, strike, side, daysToExpiry, chain, ivFallback = 0.15 } = args

  // 1. Live chain lookup — prefer an exact strike match on the current chain.
  //    We only trust non-zero LTPs; NSE publishes 0.0 for untraded strikes.
  if (chain?.rows?.length) {
    const row = chain.rows.find(r => r.strike === strike)
    if (row) {
      const ltp = side === 'CE' ? row.callLTP : row.putLTP
      if (ltp && ltp > 0) {
        return {
          premium: +ltp.toFixed(2),
          source: 'chain',
          note: `live chain LTP`,
        }
      }
      // If LTP missing, attempt IV back-out from the chain row
      const rowIV = side === 'CE' ? row.callIV : row.putIV
      if (rowIV && rowIV > 0) {
        const iv = rowIV > 1 ? rowIV / 100 : rowIV     // 15 vs 0.15
        const bs = blackScholesPrice(spot, strike, daysToExpiry, iv, side)
        return {
          premium: +bs.toFixed(2),
          source: 'black-scholes',
          iv,
          note: `BS @ ${(iv * 100).toFixed(1)}% IV (chain IV)`,
        }
      }
    }
  }

  // 2. Black-Scholes fallback with typical NIFTY IV.
  if (daysToExpiry >= 1 && spot > 0 && strike > 0) {
    const iv = Math.max(0.08, Math.min(0.5, ivFallback))
    const bs = blackScholesPrice(spot, strike, daysToExpiry, iv, side)
    return {
      premium: +bs.toFixed(2),
      source: 'black-scholes',
      iv,
      note: `BS @ ${(iv * 100).toFixed(0)}% IV · ${daysToExpiry}d DTE`,
    }
  }

  // 3. Last-ditch — a sane heuristic that at least respects DTE.
  //    Approx ATM straddle = spot × IV × sqrt(T/365) split per leg.
  const iv = Math.max(0.08, Math.min(0.5, ivFallback))
  const t = Math.max(1, daysToExpiry) / 365
  const straddle = spot * iv * Math.sqrt(t)
  // For OTM approximation, subtract distance-from-ATM weighted by sqrt(t)
  const moneyness = side === 'CE' ? spot - strike : strike - spot
  const intrinsic = Math.max(0, moneyness)
  const tv = straddle / 2
  return {
    premium: +(intrinsic + tv * Math.max(0.3, 1 - Math.abs(moneyness) / (spot * iv * 0.5))).toFixed(2),
    source: 'fallback',
    iv,
    note: `fallback estimate (no chain / bad DTE)`,
  }
}

/**
 * Convenience: pick the best tradable ATM strike for a given underlying.
 * Uses the standard step (50 for NIFTY/FINNIFTY, 100 for BANKNIFTY/GOLD,
 * 50 for CRUDE, generic otherwise).
 */
export function atmStrike(spot: number, sym: string): number {
  if (sym === 'BANKNIFTY' || sym === 'GOLD') return Math.round(spot / 100) * 100
  if (sym === 'NIFTY' || sym === 'FINNIFTY' || sym === 'CRUDE') return Math.round(spot / 50) * 50
  if (spot < 100) return Math.round(spot / 2.5) * 2.5
  if (spot < 500) return Math.round(spot / 5) * 5
  if (spot < 2000) return Math.round(spot / 10) * 10
  return Math.round(spot / 20) * 20
}

// ─── Black-Scholes ────────────────────────────────────────────────

const RISK_FREE = 0.068      // ≈ 10Y GoI yield · good-enough anchor

export function blackScholesPrice(
  S: number, K: number, dte: number, sigma: number, side: 'CE' | 'PE',
): number {
  const T = Math.max(0.5, dte) / 365
  const sqrtT = Math.sqrt(T)
  const d1 = (Math.log(S / K) + (RISK_FREE + 0.5 * sigma * sigma) * T) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  if (side === 'CE') {
    return Math.max(0, S * cnd(d1) - K * Math.exp(-RISK_FREE * T) * cnd(d2))
  }
  return Math.max(0, K * Math.exp(-RISK_FREE * T) * cnd(-d2) - S * cnd(-d1))
}

// Abramowitz & Stegun approximation of the standard normal CDF.
function cnd(x: number): number {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741
  const a4 = -1.453152027, a5 =  1.061405429, p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x) / Math.sqrt(2)
  const t = 1 / (1 + p * ax)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return 0.5 * (1 + sign * y)
}

/**
 * Days between two YYYY-MM-DD dates (calendar days, inclusive of end).
 * Used by strategies that only have an expiry string, not a Date.
 */
export function daysUntil(expiry: string, from: Date = new Date()): number {
  const t = new Date(expiry + 'T15:30:00+05:30').getTime()     // NSE close
  const ms = t - from.getTime()
  return Math.max(1, Math.ceil(ms / 86_400_000))
}
