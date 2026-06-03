import type { OptionChain, OptionChainRow } from '../types'

/**
 * Professional-grade option-chain flow analyzer.
 *
 * A pro trader reading the chain doesn't just look at PCR — they scan each
 * strike and ask: "what kind of position is being built here?" There are
 * FOUR possible states per side (call/put):
 *
 *   Long buy       : OI ↑ + LTP ↑   (fresh buyers entering)
 *   Short writing  : OI ↑ + LTP ↓   (writers collecting premium at key level)
 *   Short covering : OI ↓ + LTP ↑   (writers exiting losing trades = squeeze)
 *   Long unwinding : OI ↓ + LTP ↓   (holders booking profits / cutting losses)
 *
 * The trade implication is different for each:
 *   - Aggressive long-CALL buying = BUY CE (momentum trade, ride the move)
 *   - CALL writing at resistance = BUY PE (pros selling tops → level holds)
 *   - CALL covering (short squeeze) = BUY CE (writers being blown out → breakout)
 *   - PUT writing at support = BUY CE (pros selling bottoms → level holds)
 *   - Aggressive long-PUT buying = BUY PE (fear building, ride the drop)
 *   - PUT covering (short squeeze) = BUY PE (supports giving way)
 *
 * This analyzer scans every strike within ±5 % of spot, classifies each,
 * and returns the dominant setup with a confidence score.
 */

export type FlowKind =
  | 'AGGR_CE_BUY'    // Calls being bought aggressively → bullish
  | 'AGGR_PE_BUY'    // Puts being bought aggressively → bearish
  | 'CE_WRITING'     // Call writers at resistance → bearish (level holds)
  | 'PE_WRITING'     // Put writers at support → bullish (level holds)
  | 'CE_COVERING'    // Call writers covering (squeeze) → bullish
  | 'PE_COVERING'    // Put writers covering → bearish (support gives)
  | 'CE_UNWIND'      // Long calls exiting → bearish
  | 'PE_UNWIND'      // Long puts exiting → bullish

export type FlowBias = 'BULLISH' | 'BEARISH'

export interface StrikeFlow {
  strike: number
  spotDistance: number           // strike - spot
  spotDistancePct: number
  side: 'CE' | 'PE'
  kind: FlowKind
  oiChange: number               // raw OI delta
  ltpChange: number              // raw LTP delta
  ltpChangePct: number           // %
  currentOI: number
  currentLTP: number
  currentIV: number
  currentVol: number
  bias: FlowBias
  strength: number               // 0-100 — how aggressive this flow is
  note: string                   // human-readable
}

export interface OiFlowAnalysis {
  spot: number
  pcr: number
  maxPain: number
  dominantBias: FlowBias | 'NEUTRAL'
  strikeFlows: StrikeFlow[]       // only meaningful ones (OI Δ ≥ threshold)
  top3Bullish: StrikeFlow[]       // top-3 bullish setups by strength
  top3Bearish: StrikeFlow[]
  biasBreakdown: { bullish: number; bearish: number; net: number }
  summary: string                 // top-line narrative
  // 2026-06-02: ATM option-leg pricing so consumers can render a
  // bias-aligned trade plan (BULLISH → BUY ATM CE, BEARISH → BUY ATM PE).
  // Optional — only present when the analyzer has a chain to read from.
  atmStrike?: number
  atmCeLtp?: number
  atmPeLtp?: number
  // Expiry context for the chain being analysed — surfaced so the UI can
  // show "Expiry: 8-Jun (5d)" and refuse to display expired data.
  expiry?: string
  daysToExpiry?: number
}

interface ChainRowPrev {
  strike: number
  callOI: number; putOI: number
  callLTP: number; putLTP: number
}

/**
 * Compare current chain vs prior snapshot. `prevRows` is the snapshot's rows
 * keyed by strike; if a strike wasn't present before, we treat its prev
 * OI/LTP as 0 / current (so it doesn't spuriously classify).
 */
export function analyzeOiFlow(
  chain: OptionChain,
  prev: { rows: OptionChainRow[]; pcr: number; maxPain: number } | null,
): OiFlowAnalysis {
  const spot = chain.spot
  const prevByStrike: Record<number, ChainRowPrev> = {}
  for (const r of (prev?.rows ?? [])) {
    prevByStrike[r.strike] = {
      strike: r.strike,
      callOI: r.callOI, putOI: r.putOI,
      callLTP: r.callLTP, putLTP: r.putLTP,
    }
  }

  // Consider strikes within ±5% of spot (where the real action is)
  const bandPct = 5
  const candidates = chain.rows.filter(r => Math.abs(r.strike - spot) / spot * 100 <= bandPct)

  const strikeFlows: StrikeFlow[] = []
  for (const r of candidates) {
    const p = prevByStrike[r.strike]
    // Need a prior snapshot to compute delta; otherwise skip
    if (!p) continue

    // CALL side
    const ceOiDelta = r.callOI - p.callOI
    const ceLtpDelta = r.callLTP - p.callLTP
    const ceLtpPct = p.callLTP > 0 ? (ceLtpDelta / p.callLTP) * 100 : 0
    // PUT side
    const peOiDelta = r.putOI - p.putOI
    const peLtpDelta = r.putLTP - p.putLTP
    const pePctDelta = p.putLTP > 0 ? (peLtpDelta / p.putLTP) * 100 : 0

    // Only classify if OI change is meaningful — threshold scales with
    // the strike's absolute OI (use a min floor so small strikes still fire)
    const ceOiThreshold = Math.max(10_000, p.callOI * 0.03)
    const peOiThreshold = Math.max(10_000, p.putOI * 0.03)

    // CALL classification
    if (Math.abs(ceOiDelta) >= ceOiThreshold) {
      strikeFlows.push(classify('CE', r, ceOiDelta, ceLtpDelta, ceLtpPct, spot))
    }
    // PUT classification
    if (Math.abs(peOiDelta) >= peOiThreshold) {
      strikeFlows.push(classify('PE', r, peOiDelta, peLtpDelta, pePctDelta, spot))
    }
  }

  // Aggregate bias
  let bullishStrength = 0
  let bearishStrength = 0
  for (const f of strikeFlows) {
    if (f.bias === 'BULLISH') bullishStrength += f.strength
    else bearishStrength += f.strength
  }
  const net = bullishStrength - bearishStrength
  const dominantBias: FlowBias | 'NEUTRAL' =
    Math.abs(net) < 50 ? 'NEUTRAL' : net > 0 ? 'BULLISH' : 'BEARISH'

  // Top setups by strength
  const sortedBull = strikeFlows.filter(f => f.bias === 'BULLISH').sort((a, b) => b.strength - a.strength).slice(0, 3)
  const sortedBear = strikeFlows.filter(f => f.bias === 'BEARISH').sort((a, b) => b.strength - a.strength).slice(0, 3)

  // Summary narrative
  const summary = buildSummary(spot, chain.pcr, chain.maxPain, dominantBias, sortedBull, sortedBear)

  // ATM option leg — closest strike (round to nearest 50 for NIFTY).
  // Used by consumers to render a bias-aligned trade plan.
  const atmStrike = Math.round(spot / 50) * 50
  const atmRow = chain.rows.find(r => r.strike === atmStrike)
  const atmCeLtp = atmRow?.callLTP || undefined
  const atmPeLtp = atmRow?.putLTP || undefined

  // 2026-06-03: propagate expiry context so consumers can verify the chain
  // is from a CURRENT expiry, not an expired one. expiry is whatever the
  // upstream chain provider tagged (NSE: "03-Jun-2026" or "03JUN2026";
  // Angel: ISO yyyy-mm-dd-ish from ScripMaster).
  const expiry = chain.expiry || undefined
  let daysToExpiry: number | undefined
  if (expiry) {
    const t = Date.parse(expiry)
    if (!Number.isNaN(t)) {
      const istNow = new Date(Date.now() + 5.5 * 3600_000)
      const todayUtc = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate())
      daysToExpiry = Math.max(0, Math.round((t - todayUtc) / 86_400_000))
    }
  }

  return {
    spot,
    pcr: chain.pcr,
    maxPain: chain.maxPain,
    dominantBias,
    strikeFlows,
    top3Bullish: sortedBull,
    top3Bearish: sortedBear,
    biasBreakdown: {
      bullish: Math.round(bullishStrength),
      bearish: Math.round(bearishStrength),
      net: Math.round(net),
    },
    summary,
    atmStrike, atmCeLtp, atmPeLtp,
    expiry, daysToExpiry,
  }
}

function classify(
  side: 'CE' | 'PE',
  row: OptionChainRow,
  oiDelta: number,
  ltpDelta: number,
  ltpPct: number,
  spot: number,
): StrikeFlow {
  const currentOI = side === 'CE' ? row.callOI : row.putOI
  const currentLTP = side === 'CE' ? row.callLTP : row.putLTP
  const currentIV = side === 'CE' ? row.callIV : row.putIV
  const currentVol = side === 'CE' ? row.callVolume : row.putVolume

  const oiUp = oiDelta > 0
  const ltpUp = ltpDelta > 0

  // Four-state classification
  let kind: FlowKind
  let bias: FlowBias
  let note: string

  if (side === 'CE') {
    if (oiUp && ltpUp) {
      kind = 'AGGR_CE_BUY'; bias = 'BULLISH'
      note = `Aggressive CALL buying at ${row.strike} — OI +${oiDelta.toLocaleString('en-IN')}, LTP ${ltpPct >= 0 ? '+' : ''}${ltpPct.toFixed(1)}%`
    } else if (oiUp && !ltpUp) {
      kind = 'CE_WRITING'; bias = 'BEARISH'
      note = `Call writers defending ${row.strike} — OI +${oiDelta.toLocaleString('en-IN')}, LTP ${ltpPct.toFixed(1)}% (resistance build)`
    } else if (!oiUp && ltpUp) {
      kind = 'CE_COVERING'; bias = 'BULLISH'
      note = `Call writers covering (squeeze) ${row.strike} — OI ${oiDelta.toLocaleString('en-IN')}, LTP +${ltpPct.toFixed(1)}%`
    } else {
      kind = 'CE_UNWIND'; bias = 'BEARISH'
      note = `Long calls unwinding ${row.strike} — OI ${oiDelta.toLocaleString('en-IN')}, LTP ${ltpPct.toFixed(1)}%`
    }
  } else {
    if (oiUp && ltpUp) {
      kind = 'AGGR_PE_BUY'; bias = 'BEARISH'
      note = `Aggressive PUT buying at ${row.strike} — OI +${oiDelta.toLocaleString('en-IN')}, LTP ${ltpPct >= 0 ? '+' : ''}${ltpPct.toFixed(1)}%`
    } else if (oiUp && !ltpUp) {
      kind = 'PE_WRITING'; bias = 'BULLISH'
      note = `Put writers defending ${row.strike} — OI +${oiDelta.toLocaleString('en-IN')}, LTP ${ltpPct.toFixed(1)}% (support build)`
    } else if (!oiUp && ltpUp) {
      kind = 'PE_COVERING'; bias = 'BEARISH'
      note = `Put writers covering (support giving) ${row.strike} — OI ${oiDelta.toLocaleString('en-IN')}, LTP +${ltpPct.toFixed(1)}%`
    } else {
      kind = 'PE_UNWIND'; bias = 'BULLISH'
      note = `Long puts unwinding ${row.strike} — OI ${oiDelta.toLocaleString('en-IN')}, LTP ${ltpPct.toFixed(1)}%`
    }
  }

  // Strength: normalised OI change × (1 + premium-move factor). Higher strength
  // = more meaningful flow. OI-shifts with matching premium moves get the most weight.
  const oiMag = Math.abs(oiDelta)
  const normalisedOi = Math.min(100, oiMag / 10_000)         // 1M OI = 100 score
  const premiumBoost = Math.min(1, Math.abs(ltpPct) / 30)    // 30% premium move = full boost
  const strength = Math.round(normalisedOi * (0.6 + premiumBoost * 0.4))

  return {
    strike: row.strike,
    spotDistance: +(row.strike - spot).toFixed(2),
    spotDistancePct: +(((row.strike - spot) / spot) * 100).toFixed(2),
    side,
    kind,
    oiChange: oiDelta,
    ltpChange: +ltpDelta.toFixed(2),
    ltpChangePct: +ltpPct.toFixed(1),
    currentOI, currentLTP, currentIV, currentVol,
    bias,
    strength,
    note,
  }
}

function buildSummary(
  spot: number, pcr: number, maxPain: number,
  bias: FlowBias | 'NEUTRAL',
  bull: StrikeFlow[], bear: StrikeFlow[],
): string {
  const parts: string[] = []
  const biasEmoji = bias === 'BULLISH' ? '🟢' : bias === 'BEARISH' ? '🔴' : '⚪'
  parts.push(`${biasEmoji} ${bias} chain · spot ₹${spot.toFixed(2)} · PCR ${pcr.toFixed(2)} · max-pain ${maxPain}`)
  if (bull.length) parts.push(`Top bull: ${bull[0].kind.replace('_', ' ')} at ${bull[0].strike} (${bull[0].strength} str)`)
  if (bear.length) parts.push(`Top bear: ${bear[0].kind.replace('_', ' ')} at ${bear[0].strike} (${bear[0].strength} str)`)
  return parts.join(' · ')
}
