# 🐢 ICT Turtle Soup — Pure Liquidity-Sweep Reversal Strategy

> Self-contained playbook for the ICT Turtle Soup pattern. **No other indicators
> are mixed into the engine for this strategy** — pure price-action only,
> exactly as ICT teaches it.

---

## 1 · Concept

Turtle Soup hunts **fake breakouts** at established swing highs/lows. Retail
traders place stops just beyond those levels — long below the range low,
short above the range high. Smart money runs price into those stops to
collect the liquidity, then reverses sharply back into the range.

The original "Turtles" (Richard Dennis, 1980s) bought genuine breakouts;
Turtle Soup eats those breakouts when they fail — hence the name.

Two reasons price moves (per ICT):

1. To **balance an imbalance** (FVG / inefficiency).
2. To **hunt liquidity** (resting stop orders).

After hunting one side's liquidity, price often pivots and runs to hunt the
opposite side. That round-trip is the Turtle Soup trade.

---

## 2 · Required components (and ONLY these)

| Component | Definition |
|-----------|------------|
| **Range** | Most recent prominent swing high (RH) and swing low (RL) inside the lookback window. |
| **External liquidity** | RH and RL themselves — the obvious stop pools every retail trader uses. |
| **Internal liquidity** | Minor swing highs/lows formed *inside* the range — also hunted, but usually first, before the major sweep. |
| **HTF order flow** | Higher-timeframe bias inferred from the last 2–3 swing pivots: HH+HL = BULLISH, LH+LL = BEARISH, mixed = RANGING. |
| **Sweep candle** | A bar that wicks **beyond** RH or RL but **closes back inside** the range. |
| **Reclaim / confirmation** | A subsequent bar that closes against the sweep direction, proving the breakout failed. |

> Anything else (RSI, EMAs, MACD, MA stacks, indicators, oscillators, SMC
> labels, OI flow, Gann, astro, fundamentals) is **explicitly excluded** from
> the Turtle Soup engine. Mixing them dilutes the pattern and changes its
> empirical hit rate. This strategy lives in its own dedicated tab.

---

## 3 · Variants (timing tier)

| Tier | Timeframes | Use case |
|------|------------|----------|
| **TSS — Short / Scalp** | 5m, 15m, 30m | Intraday entries, multiple per session, small SL. |
| **TSI — Intraday-swing** | 45m, 1h, 2h, 3h, 4h | Session-long swings, ride to opposite range extreme. |
| **TSL — Positional** | 1D, 1W, 1M | Multi-day to multi-month reversals at major HTF range edges. |

---

## 4 · Detection algorithm

```
INPUT:  candles[], rangeLookback=50, pivotStrength=3, maxBarsSinceSweep=5
OUTPUT: TurtleSoupSignal | null

1. window  = candles[-rangeLookback - pivotStrength*2 : ]
2. RH      = max(high) over window[0 : -maxBarsSinceSweep-1]
   RL      = min(low)  over window[0 : -maxBarsSinceSweep-1]
   RM      = (RH + RL) / 2
   RSize   = RH - RL                         (must be > 0)

3. htfFlow = orderFlow(window, pivotStrength)
   • last 2 swing highs higher AND last 2 swing lows higher  → BULLISH
   • last 2 swing highs lower  AND last 2 swing lows lower   → BEARISH
   • otherwise                                                → RANGING

4. Scan last (maxBarsSinceSweep + 1) candles for sweep + reclaim:

   BULLISH SETUP (Turtle Soup BUY):
   For each candidate sweep-bar S inside the window:
     IF S.low < RL  AND  S.close > RL:
       look for confirmBar after S where confirmBar.close > S.high
       IF htfFlow ∈ {BULLISH, RANGING}:
         entry  = confirmBar.close
         SL     = S.low - 5% of RSize        (just beyond the wick)
         T1     = RM                         (mid-range = first liquidity pool)
         T2     = RH                         (opposite external liquidity)
         T3     = RH + 50% of RSize          (range expansion target)
         RR     = (T1 - entry) / (entry - SL)
         emit BUY signal

   BEARISH SETUP (Turtle Soup SELL):
   For each candidate sweep-bar S inside the window:
     IF S.high > RH  AND  S.close < RH:
       look for confirmBar after S where confirmBar.close < S.low
       IF htfFlow ∈ {BEARISH, RANGING}:
         entry  = confirmBar.close
         SL     = S.high + 5% of RSize
         T1     = RM
         T2     = RL
         T3     = RL - 50% of RSize
         RR     = (entry - T1) / (SL - entry)
         emit SELL signal
```

### Why the rules look this way

- **Pivot strength 3** — a swing high is only a swing high if 3 bars on
  each side are lower. Tighter (1–2) overfits to noise; looser (5+) misses
  the rapid TSS variant.
- **maxBarsSinceSweep = 5** — fresh setups only. A sweep that happened 20
  bars ago has already been mitigated; chasing it gives you the second-leg
  fakeout, not the original setup.
- **5 % SL buffer of range size** — protects against the secondary stop-hunt
  wick that often follows the main sweep. Tighter SL gets shaken out by the
  secondary probe.
- **HTF filter** — Turtle Soup against the dominant order flow has a markedly
  lower hit rate. We accept BUYs only when HTF is BULLISH or RANGING, and
  SELLs only when HTF is BEARISH or RANGING.

---

## 5 · Trade management

| Stage | Action |
|-------|--------|
| **Entry** | Market or limit at the confirm-bar close. Some traders prefer the next bar's open — both fine, our cards print the close. |
| **Initial SL** | Tick beyond the swept wick (with the 5 %-of-range buffer). NEVER move SL further away once the trade is live. |
| **T1** | Mid-range. Book 50 % of position. Move SL to entry. |
| **T2** | Opposite range extreme (the *other* liquidity pool). Book 30 %. Trail remainder behind the most recent swing pivot of the *winning* direction. |
| **T3** | One full range projection beyond opposite extreme (range-expansion target). Trail-and-let-it-run. |

### Invalidation

- If the **next 1–2 bars** after entry close *back through the swept level*
  in the original sweep direction → fake setup. Cut the trade immediately.
- If price stalls at T1 with overlapping inside bars for 3+ bars → book full
  and walk away. Better setups are coming.

---

## 6 · Common mistakes (lifted from the source PDFs + our backtest)

| Mistake | Why it kills you | Fix |
|---------|------------------|-----|
| Entering at the sweep bar itself | No confirmation — the sweep can extend further | Wait for the *next* close inside the range / against the sweep |
| Ignoring HTF order flow | Counter-HTF Turtle Soup is ~40 % hit rate vs ~70 % aligned | Skip the trade when HTF is opposite |
| SL inside the swept wick | Almost guaranteed to be hit by the secondary probe | SL = wick + buffer (5 % of range) |
| Treating internal-liquidity sweeps as the main signal | Internal sweeps happen constantly; only EXTERNAL sweeps are the high-conviction setup | Detector only fires on swept RH or RL, not minor pivots |
| Forcing the trade in trending markets | Pattern is designed for ranges + reversals at HTF edges | We surface it in trending markets too, but mark `htfOrderFlow` so the user can size accordingly |

---

## 7 · Multi-timeframe coverage in this engine

For NIFTY 50 and XAUUSD (GOLD) we run the detector on **eleven timeframes**:

`5m · 15m · 30m · 45m · 1h · 2h · 3h · 4h · 1D · 1W · 1M`

Native fetches: 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M.
Resampled (via `mtfAggregator.resample`):

- **45m** = 3 × 15m bars
- **2h**  = 2 × 1h bars
- **3h**  = 3 × 1h bars

Each (symbol × timeframe) pair runs the same detector and emits ≤ 1 signal.
Fresh signals (not in the previous run's dedup set) get pushed to Telegram
immediately. The dashboard tab refreshes every 60 s and shows the full grid.

---

## 8 · File map

| File | Purpose |
|------|---------|
| `server/src/strategies/ictTurtleSoup.ts` | Pure detector. No other engine imports. |
| `server/src/engine/turtleSoupEngine.ts` | Multi-TF runner, dedup, Telegram formatter. |
| `client/src/pages/TurtleSoupPage.tsx` | Dashboard tab — grid of signals + export buttons. |
| `server/src/index.ts` | API endpoints + cron + Telegram dispatcher + boot prefetch. |
| `server/src/engine/exporter.ts` | `turtle-soup` dataset for CSV/PDF export. |

---

## 9 · Telegram alert template

```
🐢 ICT TURTLE SOUP — NIFTY · 15m
🟢 BUY · Range 23950 – 24180
Sweep: below 23950 → wick 23922 → reclaimed close 23974
Confirmation: next close > 23996
HTF order flow: BULLISH
Entry  ₹23974
SL     ₹23910   (-0.27%)
T1     ₹24065   (mid-range)
T2     ₹24180   (range high)
T3     ₹24295   (1× range extension)
R:R 1:2.4
#tradewithvarsha
```

---

## 10 · Acknowledgements

Algorithm distilled from:
- *ICT Turtle Soup Pattern – A Run on Stops Model* (TheForexSecrets / TradingView)
- *Turtle Soup Strategy: Liquidity Hunt and Market Manipulation in the ICT Style* (TradingFinder)

Pattern originally taught by Linda Bradford Raschke (1996) and adapted by
ICT (Inner Circle Trader, Michael J. Huddleston) for FX / index futures.
