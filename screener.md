# SCREENER.MD — Enhanced Pre-Move Stock Picker
> **Instructions for Claude Code:** Use this file as the master reference to curate, filter, and rank stocks for 10–20% pre-move opportunities. Run the applicable screener queries on Screener.in data (or parse NSE/BSE CSV exports), apply the signal scoring system, and output a ranked watchlist with trade plans.

---

## HOW TO USE THIS FILE

1. **Input:** NSE/BSE stock data CSV, or Screener.in export, or live API data
2. **Process:** Apply queries for the relevant timeframe → score each stock → filter by conviction tier
3. **Output:** Ranked watchlist with entry zone, stop loss, target, and signal breakdown
4. **Frequency:** Run intraday queries at 9:20 AM and 11 AM IST. Run swing queries daily at 8 PM after market close.

---

## PART 1 — INTRADAY SCREENER (Same-Day 5–12% Moves)

### Query A — Volume Surge + Price Breakout
**Target:** Stocks likely to move 5–10% intraday  
**Run at:** 9:20 AM and 11:00 AM IST

```
Filters:
- Market Cap > 500 Cr
- Today's Volume > 3x Average Volume (20d)
- Current Price > Previous Day High
- RSI (14) between 55 and 75
- (Current Price / 52W Low) > 1.3
- Delivery % > 45%
- Price > 20 Day EMA
- Price > 50 Day EMA
```

**Signal logic:** Volume surge above 3x average confirms institutional/HNI participation. Delivery >45% filters out speculative pump activity. RSI 55–75 is the momentum sweet spot — not overbought, but clearly trending.

---

### Query B — Opening Range Breakout (ORB) Setup
**Target:** Stocks breaking above first 15-min range with conviction  
**Run at:** 9:35 AM (after first candle closes)

```
Filters:
- Current Price > Yesterday's High (resistance cleared)
- Today's Volume > Yesterday's Total Volume (by 10 AM)
- Previous 3-day High-Low Range < 2% (tight consolidation)
- MACD Line > Signal Line (bullish crossover within 3 days)
- Stock's 5d % change > Nifty 5d % change (relative strength)
- Float Turnover today > 0.5%
- Sector Index up on the day
```

**Signal logic:** Tight 3-day range = coiled spring. ORB on volume confirms the release. Relative strength vs Nifty ensures you're in the strongest name in the move, not a laggard catching up.

---

### Query C — News/Catalyst Momentum
**Target:** Post-announcement stocks with continuation potential  
**Run at:** Any time, triggered by news event

```
Filters:
- Price Change % (Today) > 4%
- Volume > 5x Average Volume (10d)
- Price > 20 Day EMA
- Price > 50 Day EMA
- RSI (14) < 80 (not yet overbought)
- Market Cap between 1000 Cr and 50000 Cr (mid-cap focus)
- Delivery % > 40%
- Not already up > 15% on the day (avoid chasing exhaustion)
```

**Signal logic:** Mid-cap sweet spot — small enough to move fast, large enough for institutional participation. RSI cap at 80 prevents buying into blowoff tops. The 15% ceiling filters stocks already in distribution.

---

## PART 2 — SHORT SWING SCREENER (1–3 Days, 8–15% Moves)

### Query D — Consolidation Breakout (Bull Flag / Tight Base)
**Target:** Stocks breaking out of multi-day tight consolidation  
**Run at:** Daily, post-market (after 3:30 PM IST)

```
Filters:
- Current Price > 52W High × 0.95 (within 5% of 52W high)
- Last 5-Day Price Range < 5% (tight squeeze / flag)
- Today's Volume > 2x Average Volume (20d)
- RSI (14) between 50 and 70
- Price > 200 Day EMA (structural uptrend)
- Promoter Holding > 50%
- Market Cap > 2000 Cr
- Promoter Pledge % < 10%
- No major news in last 5 days (organic base)
```

**Signal logic:** Stocks near 52W highs have no overhead supply — every buyer is in profit, so there's no trapped seller pressure. The tight 5-day range with shrinking volume = institutions quietly accumulating before the next push.

---

### Query E — Earnings Beat Momentum Play
**Target:** Stocks that beat earnings and are continuing higher  
**Run at:** Within 3 days of quarterly result announcement

```
Filters:
- Quarterly EPS Growth (YoY) > 25%
- Quarterly Revenue Growth (YoY) > 15%
- EPS Beat vs Analyst Estimate > 5%
- Price Change % (5 Days) > 5% (momentum post-result)
- 5-day Avg Volume > 1.5x 20-day Avg Volume
- FII / Institutional Holding Change (QoQ) > 0%
- Price > 50 Day EMA
- PE Ratio < Sector Average PE (still reasonable valuation)
- Price not already up > 20% from pre-result level
```

**Signal logic:** The best earnings plays aren't on result day — they're the 2–5 days after, when the research notes come out and institutional buying accelerates. The PE < Sector Average filter ensures you're not chasing a priced-in story.

---

### Query F — Sectoral Rotation Leader
**Target:** Strongest stock in a sector that just started moving  
**Run at:** Daily, when sector rotation is detected in market

```
Filters:
- Sector Index 5-day Change > 3% (sector is moving)
- Stock's 5-day Return > Sector 5-day Return by > 1.2x (stock is leading sector)
- Price > Previous Week High (breaking out, not catching up)
- Average Volume (5d) / Average Volume (3m) > 1.5
- RSI (14) crossing above 50 (momentum turn)
- Price > 20 EMA > 50 EMA > 200 EMA (full EMA stack bullish)
- Market Cap > 3000 Cr (institutional-grade liquidity)
```

**Signal logic:** Rotation plays are the cleanest trades — an entire sector is being re-rated. The relative strength filter ensures you buy the leader, not the laggard playing catch-up. Full EMA alignment = trend in all timeframes confirmed.

---

## PART 3 — SWING SCREENER (5–10 Days, 12–20% Moves)

### Query G — VCP / Cup & Handle Setup
**Target:** High-quality growth stocks in late-stage base  
**Run at:** Daily, post-market

```
Filters:
- Price within 3% of 52W High
- Maximum drawdown from 52W High < 30% (shallow cup)
- Average Volume (3m) > 100,000 shares/day (liquid)
- Current Volume < Average Volume (volume contraction in handle = VCP)
- RSI (14) between 45 and 65 (cooling off, not broken)
- ROE > 15%
- Debt to Equity < 1.0
- Promoter Pledge % < 10%
- EPS Growth (Last 3 Quarters, YoY) > 15% each quarter
- Market Cap > 3000 Cr
```

**Signal logic:** VCP (Volatility Contraction Pattern) = the most reliable breakout pattern. Each contraction in the base is smaller than the previous, showing sellers are being absorbed. Volume contraction in the handle confirms no distribution. The breakout candle must be on 2x+ volume — that's the entry trigger.

**Entry trigger:** Price breaks above handle high on volume > 2x average. Do NOT buy during the contraction — wait for the breakout.

---

### Query H — Institutional Accumulation Zone
**Target:** Stocks in silent accumulation phase before a move  
**Run at:** Weekly (Sunday evening), using quarterly holding data

```
Filters:
- FII Holding Change (QoQ) > 1% (FIIs adding)
- DII / Mutual Fund Holding Change (QoQ) > 0.5% (domestic adding)
- Price Change % (1 Month) between -5% and +8% (stock going sideways = accumulation)
- Average Volume (3m) > Average Volume (6m) (rising volume trend over time)
- ROCE > 15%
- Price to Book Value < 4
- Market Cap between 3000 Cr and 200000 Cr
- Price > 200 Day EMA
- Promoter Holding stable or increasing (no selling)
```

**Signal logic:** When both FIIs and DIIs are adding simultaneously while the stock is flat, someone is systematically absorbing supply. The rising volume trend over 6 months confirms this is intentional, not random. These stocks tend to launch when the market turns.

---

### Query I — Multi-Month Base Breakout
**Target:** Stocks breaking out of 3–6 month consolidation on high volume  
**Run at:** Daily, post-market

```
Filters:
- Price > 3-Month High (breaking out)
- Price > 6-Month High (major resistance cleared)
- Today's Volume > 3x Average Volume (60d)
- (Current Price / 52W Low) > 1.4 (already recovered, not a downtrend reversal)
- Delivery % > 55% (genuine buying)
- Quarterly Sales Growth (3-Year CAGR) > 15%
- EPS Growth (TTM) > 20%
- No major index constituent (smaller names move faster)
```

**Signal logic:** The 3-month AND 6-month high filter ensures you're buying a genuine breakout, not a dead-cat bounce. 3x volume on a multi-month breakout = the trade is now well-known, which drives further momentum. Delivery >55% on breakout day separates institutional breakouts from operator-driven pumps.

---

## PART 4 — POSITIONAL SCREENER (1 Month, 15–30% Moves)

### Query J — Fundamental Turnaround + Price Recovery
**Target:** Stocks where fundamentals turned and price is just beginning to reflect it  
**Run at:** Monthly, after quarterly results season

```
Filters:
- EPS Growth (YoY, Latest Quarter) > 50% (clear turnaround)
- Revenue Growth (YoY) > 20%
- (Current Price / 52W High) < 0.75 (still 25%+ off highs)
- Debt Reduction (YoY) > 10% (balance sheet improving)
- Promoter Holding > 40%
- Promoter Holding stable or increasing
- RSI (Monthly Chart) between 40 and 60 (early stage)
- Price crossing above 200 Day EMA (structural trend change)
- Market Cap > 1000 Cr (liquid enough)
- Promoter Pledge % < 15%
```

**Signal logic:** The best risk/reward is when fundamentals turn before the market prices it in. The price still being 25%+ off highs means the re-rating hasn't happened yet. The 200 EMA cross is the confirmation that smart money is positioning — it's the green light to enter.

---

### Query K — CANSLIM Composite
**Target:** Institutional-grade growth stocks at the start of a new upleg  
**Run at:** Weekly (Sunday), long-term watchlist building

```
Filters:
[C] Current Quarterly EPS Growth (YoY) > 25%
[C] EPS Beat vs previous quarter > 0% (sequential improvement)
[A] EPS Growth: All of last 3 quarters positive YoY
[A] Annual EPS Growth (5Y CAGR) > 20%
[N] Price within 15% of 52W High (new high or near-high)
[N] New product/expansion news in last 6 months (manual check)
[S] Average Volume (3m) > 200,000 shares/day
[L] Relative Strength Rank vs Nifty 500 (52W) in top 20%
[I] FII + MF Holding > 10% and increasing
[I] Number of MF schemes holding > 5 (broad institutional ownership)
[M] Nifty above 200 EMA (only run in bull market conditions)
```

**Signal logic:** CANSLIM selects for the exact profile that large institutions buy — accelerating earnings, industry leadership, strong price action, and rising institutional ownership. These stocks tend to run 50–200% in a cycle, with the 15–30% move being just the first leg.

---

### Query L — Sectoral Cycle Leadership
**Target:** The best stock in a sector that is in early cycle phase  
**Run at:** Monthly, when macro sector rotation is identified

```
Filters:
- Sector: [Cyclicals — PSU, Metals, Infra, Auto, BFSI, Real Estate]
- Sector's 3-month Price Change > 15% (sector is in cycle)
- Stock's 3-month Return ranks in top 20% of sector
- 52W High Breakout within last 30 days
- Volume Trend: 3-month average > 6-month average (expanding participation)
- PE Ratio < 1.2x Sector Average (not yet fully priced in)
- FII Net Buying in stock over last 1 month > 0
- Market Cap > 5000 Cr (institutional-grade)
- Dividend Yield or strong cash flow (downside support)
```

**Signal logic:** Cyclical stocks offer the biggest moves in the shortest time when a sector re-rates. The top 20% RS rank ensures you're in the sector leader — the one institutions will buy more of, not the laggard. PE discount to sector average means there's still valuation expansion left.

---

## PART 5 — SIGNAL SCORING SYSTEM

### How Claude Code Should Score Each Stock

For every stock that passes a query, compute a conviction score out of 100:

```
SIGNAL SCORING TABLE
--------------------

Volume Signals (max 30 pts):
  Volume > 5x average:          30 pts
  Volume > 3x average:          20 pts
  Volume > 2x average:          10 pts
  Volume > 1.5x average:         5 pts
  Delivery % > 60%:             +5 pts bonus
  Delivery % > 45%:             +2 pts bonus

Price Structure (max 25 pts):
  Price > 52W High (new high):  25 pts
  Price within 5% of 52W High: 18 pts
  Price > 6-month High:        15 pts
  Price > 3-month High:        10 pts
  Price > Previous Week High:   5 pts
  Full EMA Stack (20>50>200):  +5 pts bonus

RSI Signal (max 15 pts):
  RSI 55–70 (momentum zone):   15 pts
  RSI 50–55 (early momentum):  10 pts
  RSI 70–80 (strong but watch): 5 pts
  RSI < 50 or > 80:             0 pts

Institutional Signal (max 20 pts):
  FII + DII both increasing:   20 pts
  FII increasing only:         12 pts
  DII increasing only:          8 pts
  Institutional holding > 20%:  +3 pts bonus
  No institutional change:      0 pts

Fundamental Quality (max 10 pts):
  EPS Growth > 50% (YoY):      10 pts
  EPS Growth 25–50%:            7 pts
  EPS Growth 15–25%:            4 pts
  ROE > 20%:                   +2 pts bonus
  Debt/Equity < 0.5:           +1 pt bonus
  Pledge % < 5%:               +1 pt bonus

RED FLAGS (deduct points):
  Promoter Pledge > 15%:       -20 pts
  Price < 200 EMA:             -15 pts
  Falling volume trend (3m):   -10 pts
  RSI > 85 (blow-off risk):    -10 pts
  Operator-flagged stock:      -25 pts
```

### Conviction Tier Classification

```
SCORE 80–100:  TIER 1 — High Conviction. Allocate full position. 
SCORE 65–79:   TIER 2 — Good Setup. Allocate 60–70% of normal position size.
SCORE 50–64:   TIER 3 — Watchlist Only. Wait for confirming signal before entry.
SCORE < 50:    DISCARD. Do not trade regardless of narrative.
```

---

## PART 6 — TRADE PLAN TEMPLATE

### For each stock that scores ≥ 65, Claude Code should output:

```
STOCK: [NAME] | [NSE/BSE Symbol]
Score: [X/100] | Tier: [1/2/3]
Timeframe: [Intraday / 1–3d / 5–10d / 1 Month]
Query matched: [Query A/B/C/.../L]

SETUP SUMMARY:
- Pattern: [ORB / Bull Flag / VCP / Breakout / etc.]
- Catalyst: [Volume surge / Earnings beat / Sector rotation / etc.]
- Key level breached: [Price level]

ENTRY:
- Zone: [Price range for entry]
- Ideal entry: [Specific price or % above breakout level]
- Entry condition: [e.g., "Buy on close above X on volume > 2x avg"]
- Avoid buying if: [e.g., "Gap up > 3% at open = skip, wait for pullback"]

RISK MANAGEMENT:
- Stop Loss: [Price] ([X]% below entry)
- Stop type: [Hard stop / EOD close stop / Trailing]
- Stop rationale: [e.g., "Below breakout candle low / below 20 EMA"]

TARGETS:
- Target 1 (book 50%): [Price] — [X]% gain
- Target 2 (book 30%): [Price] — [X]% gain  
- Target 3 (trail remaining 20%): [Price] — [X]% gain
- Trailing stop after T1: Move stop to breakeven

POSITION SIZING:
- Risk per trade: 0.5–1% of total capital
- Position size formula: (Capital × Risk %) / (Entry − Stop Loss)
- Example: ₹10L capital, 0.75% risk, Entry 100, SL 96 → Size = 7500/4 = 1,875 shares × ₹100 = ₹1.875L position

INVALIDATION:
- Setup fails if: [e.g., "Price closes below stop on volume > avg"]
- Re-entry allowed if: [e.g., "Stock recovers and closes above entry on next day with volume"]

SIGNAL BREAKDOWN:
  Volume Signal:        [X] pts — [detail]
  Price Structure:      [X] pts — [detail]
  RSI Signal:           [X] pts — [detail]
  Institutional Signal: [X] pts — [detail]
  Fundamental Quality:  [X] pts — [detail]
  Red Flag Deductions:  [X] pts — [detail]
  TOTAL SCORE:          [X]/100
```

---

## PART 7 — MARKET REGIME FILTER

### Run this FIRST before any screener query. If market fails regime check, do not initiate new positions.

```
MARKET GO / NO-GO CHECKLIST
-----------------------------
Nifty 50 above 200 Day EMA?          YES = Go / NO = Caution
Nifty 50 above 50 Day EMA?           YES = Go / NO = Caution
India VIX < 16?                       YES = Go / NO = Caution (high fear = whipsaw)
India VIX < 20?                       YES = Proceed carefully
India VIX > 20?                       NO-GO for new swing positions
FII Net Flows (last 5 sessions)?      Net Positive = Go / Net Negative = Cautious
Advance/Decline Ratio today > 1.5?   YES = Broad market participation, Go
SGX Nifty (pre-market) > 0%?         YES = Positive open bias

REGIME CLASSIFICATION:
- 6–7 Green: BULL REGIME — Run all queries, full position sizes
- 4–5 Green: MIXED REGIME — Run only Tier 1 queries, reduce size 30%
- < 4 Green: BEAR/CAUTION — Run no new entries, manage existing positions only
```

---

## PART 8 — SECTOR ROTATION TRACKER

### Claude Code should track and rank sectors before stock screening:

```
SECTOR MOMENTUM RANKING (Update daily)
----------------------------------------
Rank sectors by:
1. Sector Index 5-day return
2. Sector Index 20-day return  
3. % of stocks in sector above 50 EMA
4. Sector FII flow (if available)

ONLY screen stocks from Rank 1–3 sectors.
Never fight the sector trend — even great stocks lag in weak sectors.

SECTOR CYCLE AWARENESS:
- Early cycle (post-recession/correction): Banks, Auto, Real Estate
- Mid cycle (growth phase): IT, Consumer Discretionary, Industrials
- Late cycle (inflation/peak): Metals, Energy, Commodities
- Defensive (bear market): FMCG, Pharma, IT Services

Current macro phase: [Claude Code fills this based on recent data]
Leading sectors now: [Claude Code fills this based on screener run]
```

---

## PART 9 — EXECUTION RULES (NON-NEGOTIABLE)

These rules must be applied to every trade regardless of conviction score:

```
POSITION MANAGEMENT RULES
--------------------------
1. NEVER add to a losing position. Average up only, never down.
2. NEVER hold an intraday position overnight unless it's a Tier 1 setup with a clear gap-up thesis.
3. ALWAYS set the stop loss before entering. No entry without defined stop.
4. MAXIMUM 5 concurrent positions in same timeframe.
5. MAXIMUM 3 stocks from the same sector simultaneously.
6. If 3 consecutive trades hit stop loss → STOP trading for 2 days. Review setup.
7. Do NOT trade on result day of a holding — exit before or hold through with reduced size.
8. AVOID stocks with Operator/SEBI surveillance tag.
9. BOOK PARTIAL profits at Target 1. Never let a winning trade become a losing trade.
10. Trailing stop after T1: Set stop to breakeven (entry price).

TIMING RULES (NSE/BSE)
-----------------------
- NEVER buy in first 5 minutes (9:15–9:20 AM) — spreads are wide, price discovery unstable
- BEST entry window for intraday: 9:20–10:00 AM or 11:00–11:30 AM
- AVOID new entries after 2:30 PM (last hour — erratic, stop hunts common)
- SWING entry: Last 30 min of session (2:45–3:15 PM) for positional builds — cleaner prices
- EXIT intraday before 3:20 PM unless holding overnight with conviction
```

---

## PART 10 — OUTPUT FORMAT FOR CLAUDE CODE

### When running the screener, output results in this exact format:

```
=== SCREENER RUN ===
Date: [DD-MM-YYYY]
Time: [HH:MM IST]
Market Regime: [BULL / MIXED / BEAR]
Queries run: [List of queries]
Total stocks scanned: [N]
Passed initial filters: [N]
Final shortlist (Score ≥ 65): [N]

=== TOP PICKS TODAY ===

RANK 1 | SCORE: [X]/100 | TIER 1
[Full trade plan from Part 6 template]

RANK 2 | SCORE: [X]/100 | TIER 1
[Full trade plan from Part 6 template]

RANK 3 | SCORE: [X]/100 | TIER 2
[Full trade plan from Part 6 template]

=== WATCHLIST (Score 50–64) ===
[Stock] | Score: [X] | Waiting for: [trigger event]
[Stock] | Score: [X] | Waiting for: [trigger event]

=== AVOIDED (Red flags triggered) ===
[Stock] | Reason: [Red flag detail]

=== MARKET NOTES ===
- Leading sectors today: [sectors]
- FII flow: [net buy/sell figure]
- Key risk today: [any macro event, F&O expiry, RBI policy, etc.]
- Recommended position size today: [full / 70% / 50% based on regime]
```

---

## APPENDIX — KEY FORMULAS FOR CLAUDE CODE

```python
# Position Sizing
def position_size(capital, risk_pct, entry, stop_loss):
    risk_amount = capital * (risk_pct / 100)
    risk_per_share = entry - stop_loss
    shares = risk_amount / risk_per_share
    position_value = shares * entry
    return {"shares": round(shares), "position_value": round(position_value, 2)}

# Conviction Score
def conviction_score(volume_ratio, delivery_pct, rsi, price_vs_52wh, 
                     fii_change, dii_change, eps_growth, pledge_pct, above_200ema):
    score = 0
    
    # Volume (max 30)
    if volume_ratio >= 5: score += 30
    elif volume_ratio >= 3: score += 20
    elif volume_ratio >= 2: score += 10
    elif volume_ratio >= 1.5: score += 5
    if delivery_pct > 60: score += 5
    elif delivery_pct > 45: score += 2
    
    # Price Structure (max 25)
    if price_vs_52wh >= 1.0: score += 25
    elif price_vs_52wh >= 0.95: score += 18
    elif price_vs_52wh >= 0.85: score += 10
    else: score += 5
    
    # RSI (max 15)
    if 55 <= rsi <= 70: score += 15
    elif 50 <= rsi < 55: score += 10
    elif 70 < rsi <= 80: score += 5
    
    # Institutional (max 20)
    if fii_change > 0 and dii_change > 0: score += 20
    elif fii_change > 0: score += 12
    elif dii_change > 0: score += 8
    
    # Fundamentals (max 10)
    if eps_growth > 50: score += 10
    elif eps_growth > 25: score += 7
    elif eps_growth > 15: score += 4
    
    # Red Flags
    if pledge_pct > 15: score -= 20
    if not above_200ema: score -= 15
    if rsi > 85: score -= 10
    
    return max(0, min(100, score))

# Risk/Reward Check (minimum 2:1 required)
def check_rr(entry, stop, target1, target2):
    risk = entry - stop
    reward1 = target1 - entry
    reward2 = target2 - entry
    rr1 = reward1 / risk
    rr2 = reward2 / risk
    return rr1 >= 2.0  # Only take trades with min 2:1 R/R

# Target Calculation (ATR-based)
def calculate_targets(entry, atr_14, stop_loss):
    risk = entry - stop_loss
    target1 = entry + (risk * 2)    # 2:1 R/R
    target2 = entry + (risk * 3.5)  # 3.5:1 R/R
    target3 = entry + (atr_14 * 5)  # Momentum target
    return target1, target2, target3
```

---

## VERSION & MAINTENANCE

```
File: screener.md
Version: 1.0
Market: NSE / BSE (India)
Currency: INR
Index benchmark: Nifty 50
Data sources: Screener.in, NSE bulk deals, NSE FII data, BSE delivery data

Update this file when:
- Market regime changes significantly (new bull/bear cycle)
- Backtesting shows a query underperforming (< 40% hit rate over 20 trades)
- New reliable signal discovered through live trading
- Regulatory changes affect data availability
```
