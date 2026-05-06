import type { OptionChain, OptionChainRow } from '../types'

/** Max Pain: strike where total option writers' pain (loss on expiry) is minimum. */
export function maxPain(oc: OptionChain): number {
  if (!oc.rows.length) return oc.spot
  const strikes = oc.rows.map(r => r.strike).sort((a, b) => a - b)
  let best = strikes[0]
  let bestPain = Infinity
  for (const strike of strikes) {
    let pain = 0
    for (const r of oc.rows) {
      // Long calls profit if strike < spot-at-expiry → writers lose (r.strike below strike means CE writers paid)
      if (strike > r.strike) pain += (strike - r.strike) * r.callOI
      if (strike < r.strike) pain += (r.strike - strike) * r.putOI
    }
    if (pain < bestPain) {
      bestPain = pain
      best = strike
    }
  }
  return best
}

export interface OIInterpretation {
  pcr: number
  pcrRegime: 'EXTREME_BEAR' | 'BEARISH' | 'NEUTRAL' | 'BULLISH' | 'EXTREME_BULL'
  maxPain: number
  maxCallOIStrike: number       // highest Call OI → major resistance
  maxPutOIStrike: number        // highest Put OI → major support
  putWriting: OptionChainRow[]  // PE OI increase → bullish (supports being built)
  callWriting: OptionChainRow[] // CE OI increase → bearish (resistances being built)
  putUnwinding: OptionChainRow[] // PE OI drop → bullish (supports dissolving = already moved up)
  callUnwinding: OptionChainRow[] // CE OI drop → bearish for that strike as resistance (or bullish for breakout)
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  note: string
}

export function interpretOI(oc: OptionChain): OIInterpretation {
  const rows = oc.rows
  const pcr = oc.pcr
  let pcrRegime: OIInterpretation['pcrRegime']
  if (pcr < 0.6) pcrRegime = 'EXTREME_BEAR'       // contrarian bullish
  else if (pcr < 0.9) pcrRegime = 'BEARISH'
  else if (pcr < 1.1) pcrRegime = 'NEUTRAL'
  else if (pcr < 1.4) pcrRegime = 'BULLISH'
  else pcrRegime = 'EXTREME_BULL'                  // contrarian bearish

  const mp = maxPain(oc)

  // Key strikes — highest absolute OI
  const maxCall = rows.reduce((a, b) => (b.callOI > a.callOI ? b : a), rows[0] ?? { strike: 0, callOI: 0 } as OptionChainRow)
  const maxPut = rows.reduce((a, b) => (b.putOI > a.putOI ? b : a), rows[0] ?? { strike: 0, putOI: 0 } as OptionChainRow)

  // OI delta analysis (near-ATM strikes only)
  const nearATM = rows.filter(r => Math.abs(r.strike - oc.spot) / oc.spot < 0.03)
  const putWriting = nearATM.filter(r => r.putOIChange > 0).sort((a, b) => b.putOIChange - a.putOIChange)
  const callWriting = nearATM.filter(r => r.callOIChange > 0).sort((a, b) => b.callOIChange - a.callOIChange)
  const putUnwinding = nearATM.filter(r => r.putOIChange < -1000).sort((a, b) => a.putOIChange - b.putOIChange)
  const callUnwinding = nearATM.filter(r => r.callOIChange < -1000).sort((a, b) => a.callOIChange - b.callOIChange)

  // Directional bias
  const totalPutDelta = rows.reduce((s, r) => s + r.putOIChange, 0)
  const totalCallDelta = rows.reduce((s, r) => s + r.callOIChange, 0)

  let bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL'
  // Bullish: put writing > call writing (puts being written = floor)
  if (totalPutDelta > totalCallDelta * 1.3 && pcr < 0.9) bias = 'BULLISH'
  else if (totalCallDelta > totalPutDelta * 1.3) bias = 'BEARISH'
  else if (pcrRegime === 'EXTREME_BEAR') bias = 'BULLISH'      // contrarian
  else if (pcrRegime === 'EXTREME_BULL') bias = 'BEARISH'      // contrarian

  const notes: string[] = [`PCR ${pcr.toFixed(2)} (${pcrRegime.replace('_', ' ')})`]
  notes.push(`Max Pain ${mp}`)
  if (putWriting[0]) notes.push(`Put writing at ${putWriting[0].strike}`)
  if (callWriting[0]) notes.push(`Call writing at ${callWriting[0].strike}`)
  if (putUnwinding[0]) notes.push(`Put unwinding at ${putUnwinding[0].strike}`)

  return {
    pcr,
    pcrRegime,
    maxPain: mp,
    maxCallOIStrike: maxCall?.strike ?? 0,
    maxPutOIStrike: maxPut?.strike ?? 0,
    putWriting: putWriting.slice(0, 3),
    callWriting: callWriting.slice(0, 3),
    putUnwinding: putUnwinding.slice(0, 3),
    callUnwinding: callUnwinding.slice(0, 3),
    bias,
    note: notes.join(' · '),
  }
}

/** Suggest ATM-ish option strike + side based on a directional bias on the underlying. */
export function suggestOptionLeg(oc: OptionChain, direction: 'BUY' | 'SELL'): { strike: number; side: 'CE' | 'PE'; ltp: number } | null {
  // For BUY → long Call (CE) slightly OTM; for SELL → long Put (PE) slightly OTM
  const step = detectStrikeStep(oc)
  const otmOffset = step * 1 // one strike OTM
  const target = direction === 'BUY' ? oc.spot + otmOffset : oc.spot - otmOffset
  const row = oc.rows.reduce<OptionChainRow | null>((best, r) => {
    if (!best) return r
    return Math.abs(r.strike - target) < Math.abs(best.strike - target) ? r : best
  }, null)
  if (!row) return null
  const ltp = direction === 'BUY' ? row.callLTP : row.putLTP
  return {
    strike: row.strike,
    side: direction === 'BUY' ? 'CE' : 'PE',
    ltp,
  }
}

function detectStrikeStep(oc: OptionChain): number {
  const strikes = oc.rows.map(r => r.strike).sort((a, b) => a - b)
  if (strikes.length < 2) return 50
  const diffs = strikes.slice(1).map((s, i) => s - strikes[i]).filter(d => d > 0)
  return Math.min(...diffs)
}
