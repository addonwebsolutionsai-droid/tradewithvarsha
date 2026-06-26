# Algorithmic Pattern Library

Every detector encoded in the system, what it looks for, and the public
attribution credit for the framework. All implementations below are our
own code — we encode the mathematical/algorithmic pattern (not copyrightable)
and link to the originating author/work only as standard attribution.

If you want to verify or extend a detector, see the linked source file.

---

## Chart pattern detectors

| Pattern | Detects | Source attribution | Implemented in |
|---|---|---|---|
| **Darvas Box** | Tight horizontal consolidation + breakout above box top on volume | Nicolas Darvas, *How I Made $2,000,000 in the Stock Market* (1960) | `server/src/screeners/preMoveAdvanced.ts` (`darvasBoxPending`) |
| **VCP (Volatility Contraction Pattern)** | 2-3 successive contractions of decreasing depth + dry-up volume | Mark Minervini, public technical writings | `server/src/screeners/preMoveAdvanced.ts` (`vcpSetup`) |
| **Cup & Handle** | Rounded base + downward-drifting handle on lower volume | William J. O'Neil's CAN SLIM method | (via `darvasBox` / `wave2Continuation` overlap) |
| **Range Expansion Breakout** | NR4/NR7 (narrowest range in N bars) followed by 2× ATR expansion | Toby Crabel | `server/src/screeners/preMoveAdvanced.ts` (`rangeExpansionBreakout`) |
| **Wyckoff Re-Accumulation** | Spring (false-break below support) + sign-of-strength rally | Richard Wyckoff (1930s, public domain) | `server/src/screeners/preMoveAdvanced.ts` (`wyckoffAccumulation`) |
| **Volume Dry-up** | 5-day vol < 0.6× 20-day vol = no-supply Wyckoff signature | Wyckoff Method | `server/src/screeners/preMoveAdvanced.ts` (`volumeDryUp`) |
| **Inside Day Cluster** | 3+ inside days in a row = volatility compression | David Ryan / IBD | `server/src/screeners/preMoveAdvanced.ts` (`insideDayCluster`) |
| **52-Week Breakout** | Close above prior 252-bar high on volume confirmation | Jesse Livermore / CANSLIM | `server/src/screeners/preMoveAdvanced.ts` (`fiftyTwoWeekBreakout`) |
| **Stage 1 Recovery** | Price reclaiming the 30-week MA after Stage 4 decline | Stan Weinstein's stage framework | `server/src/screeners/preMoveAdvanced.ts` (`stage1Recovery`) |
| **Wave-2 Continuation** | Pullback to 38-61% Fib of impulse + reclaim | Elliott Wave Theory (R.N. Elliott) | `server/src/screeners/preMoveAdvanced.ts` (`wave2Continuation`) |

## Harmonic patterns

Detected by `server/src/engine/harmonicScanner.ts` using Fibonacci ratio
matching on swing-pivot legs. Public-domain mathematical ratios; pattern
naming is conventional in the technical-analysis community.

- **Gartley (1935)** — H.M. Gartley's original 5-point ratio set
- **Bat** — Scott Carney's variant
- **Butterfly** — Bryce Gilmore / Larry Pesavento
- **Crab / Deep Crab** — Scott Carney
- **Cypher** — Darren Oglesbee
- **Three-Drives** — public-domain harmonic structure

Light-weight Fib PRZ proximity (38.2 / 50 / 61.8 retracement) is also
exposed as criterion 7 (`server/src/engine/fnoFutures12Criteria.ts`).

## Smart Money Concept (SMC) primitives — criterion 19

`server/src/engine/smcPatterns.ts`. SMC terminology is widely used in the
trading community; the math below is our own.

- **Fair Value Gap (FVG)** — 3-bar imbalance where price left an unfilled
  zone (high[i-2] < low[i] for bullish FVG)
- **Order Block (OB)** — last opposing candle before a strong impulse that
  breaks the prior swing — institutional accumulation zone
- **Break of Structure (BoS)** — close beyond the highest swing high
  (bullish) or lowest swing low (bearish) of the lookback window
- **Liquidity Sweep** — wick pierces a prior swing then reclaims (textbook
  stop-hunt before reversal)

## Stage Analysis — criterion 20

`server/src/engine/stageAnalysis.ts`. Algorithmic implementation of the
4-stage lifecycle framework commonly associated with Stan Weinstein's
published work.

- **Stage 1** Base — price below 30W MA, MA flat
- **Stage 2** Advance — price above 30W MA, MA rising (textbook long zone)
- **Stage 3** Top — price above 30W MA, MA flat (distribution)
- **Stage 4** Decline — price below 30W MA, MA falling (textbook short)

30-week MA approximated as 150-day SMA.

## Indicators

| Indicator | Use | Author / origin |
|---|---|---|
| **EMA (9/21/50/200)** | Trend stack detection | Standard exponential moving average |
| **RSI 14** | Momentum / extension | J. Welles Wilder, *New Concepts in Technical Trading Systems* (1978) |
| **ADX 14** | Trend strength | J. Welles Wilder, same (1978) |
| **ATR 14** | Volatility / SL sizing | J. Welles Wilder, same (1978) |
| **MACD** | Trend confirmation | Gerald Appel (1970s) |
| **Bollinger Bands** | Volatility regime / squeeze | John Bollinger (1980s) |
| **OBV** | Accumulation/distribution flow | Joseph Granville (1963) |
| **A/D Line + CMF** | Smart-money flow | Marc Chaikin |
| **VWAP / Anchored VWAP** | Institutional reference price | Modern institutional standard |

## Time / cycle frameworks

| Framework | Use | Author |
|---|---|---|
| **Gann Time Cycles** | 90/180/360-day inflection windows | W.D. Gann (early 1900s, public domain) |
| **Vedic Hora + Astro overlays** | Diurnal volatility windows | Indian astrological tradition (public-domain) |
| **Seasonality** | Monthly historical bias | Generic — month-of-year edge documented since the 1980s |

## Smart-money footprint

| Source | What it gives us | Implementation |
|---|---|---|
| **NSE Bulk Deals** | Named buyer/seller when >0.5% of equity traded | `server/src/data/nseBulkDeals.ts` |
| **NSE Bhavcopy delivery %** | Daily delivery ratio per stock | `server/src/data/externalGainers.ts` |
| **SEBI shareholding (quarterly)** | FII/DII/Promoter stake | `server/src/data/shareholding.ts` |
| **OI Buildup analysis** | Long buildup vs short covering classification | `server/src/engine/oiFlowAnalyzer.ts` |
| **Multi-strike OI surge** | Aggressive call buying at OTM strikes | `server/src/engine/multiStrikeOi.ts` |

## Self-learning loops

| Loop | What it does | Source file |
|---|---|---|
| **Pattern Memory** | Captures candle fingerprint at every T1/T2/T3 hit; matches future candidates against winners | `server/src/engine/patternMemory.ts` |
| **MoverPatternMiner** | Captures T-1 fingerprint of every bhavcopy 5%+ mover daily; clusters into archetypes | `server/src/engine/moverPatternMiner.ts` |
| **Auto-tune** | Per-strategy WR targets adjust `minConfluence` floors | `server/src/engine/selfImprove.ts` |
| **Miss Analyzer** | Daily cross-ref of gainers vs our scans; logs blind-spot features | `server/src/engine/missAnalyzer.ts` |
| **Gainer Postmortem** | "Would have caught" analysis on missed movers | `server/src/engine/gainerPostmortem.ts` |

---

## Recommended reading list (not redistributed)

For users who want the original source material, the following authors'
works are the standard references for the frameworks above. Acquire them
from your bookseller of choice — we don't redistribute copyrighted text.

- Stan Weinstein, *Secrets For Profiting in Bull and Bear Markets*
- Nicolas Darvas, *How I Made $2,000,000 in the Stock Market*
- William J. O'Neil, *How to Make Money in Stocks* (CANSLIM)
- Mark Minervini, *Trade Like a Stock Market Wizard*
- Toby Crabel, *Day Trading with Short Term Price Patterns and Opening Range Breakout*
- Wyckoff Method materials (Stock Market Institute / SMI Mentoring)
- Scott Carney, *Harmonic Trading* (Vol 1 + 2)
- John J. Murphy, *Technical Analysis of the Financial Markets*
- J. Welles Wilder, *New Concepts in Technical Trading Systems*

## Adding a new pattern

1. Write the detector in `server/src/engine/<pattern>.ts` or
   `server/src/screeners/preMoveAdvanced.ts`
2. Return a `CriterionResult` if it slots into the 20-criteria scorecard,
   or a `Screener` result if it joins the pre-move screener bank
3. Cite the source author/framework at the top of the file (attribution)
4. Add a row to this doc with the link
