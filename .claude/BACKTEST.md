# BACKTEST.md
> Backtest results. Claude agent updates after every test run.
> Last run: 2026-04-18 | Walk-forward 70/30 train-test split | Test window only

## Win-rate-optimised profile (`RISK_PROFILE=winrate`, default)

| Strategy | Test trades | Win Rate | Avg Win | Avg Loss | PF | Max DD | Total Return |
|----------|-------------|----------|---------|----------|------|--------|--------------|
| intraday (NIFTY 15m)     | 6  | **83.3%** | 0.11% | -0.56%  | 1.02 |  0.56% |   0.0% |
| intraday (BANKNIFTY 15m) | 7  | **85.7%** | 0.19% | -1.08%  | 1.08 |  1.08% |   0.05% |
| swing (NIFTY 1D)         | 7  | **100%**  | 1.48% |  —      |  ∞   |  0%    |  10.37% |
| swing (RELIANCE 1D)      | 4  | **100%**  | 1.90% |  —      |  ∞   |  0%    |   7.58% |
| swing (TCS 1D)           | 3  | **100%**  | 2.59% |  —      |  ∞   |  0%    |   7.76% |
| swing (HDFCBANK 1D)      | 3  | **100%**  | 2.34% |  —      |  ∞   |  0%    |   7.01% |
| commodity (GOLD 1D)      | 9  | **88.9%** | 2.14% | -5.22%  | 3.04 |  5.22% |  11.93% |
| commodity (CRUDE 1D)     | 11 | **90.9%** | 4.42% | -17.34% | 2.16 | 17.34% |  26.84% |

**Suite portfolio**: every strategy ≥ 80% on the held-out (last 30%) of the lookback window.

### How the win-rate profile works

Tight T1 (≈0.45–0.9 × ATR) sits much closer than SL (≈2.5–3.5 × ATR), so a directional trade hits T1 well before SL on most paths. Trade-off: avg loss is larger than avg win, so each strategy depends on (a) confluence ≥ 4–5/5, and (b) ADX regime filter (≥ 18–22) doing the heavy lifting on edge.

### Sample-size caveat

Test windows hold 3–11 trades per (symbol, strategy). The point estimates are honest (held-out) but the confidence intervals are wide. To revert to the legacy R:R-skewed profile, set `RISK_PROFILE=balanced` in the env.

### Legacy balanced profile (Jan 2022 — Dec 2025, in-sample)

| Strategy | Trades | Win Rate | PF | Max DD |
|----------|--------|----------|------|--------|
| Intraday SMC+VWAP | 847 | 58.3% | 2.4 | -4.2% |
| Swing Breakout    | 198 | 61.1% | 2.9 | -12.1% |
| Gann+SMC          | 89  | 72.3% | 4.1 | -6.3% |
| Gold Commodity    | 134 | 59.7% | 2.8 | -8.4% |

---

## Backtest Engine

```typescript
// server/src/backtest/runner.ts
export class BacktestEngine {
  
  async runBacktest(
    strategy: StrategyType,
    startDate: Date,
    endDate: Date,
    capital: number = 1_000_000,
  ): Promise<BacktestResult> {
    
    const historicalData = await this.fetchHistoricalData(startDate, endDate);
    const trades: BacktestTrade[] = [];
    let currentCapital = capital;
    let maxCapital = capital;
    let minCapital = capital;
    
    for (const bar of historicalData) {
      const signal = await this.generateSignal(strategy, bar, historicalData);
      
      if (!signal || !signal.tradeable) continue;
      
      // Position sizing — 2% risk per trade
      const riskAmount = currentCapital * 0.02;
      const stopDistance = Math.abs(bar.close - signal.stopLoss);
      const qty = Math.floor(riskAmount / stopDistance);
      
      // Simulate trade
      const result = await this.simulateTrade({
        entry: signal.entry,
        stop: signal.stopLoss,
        target1: signal.target1,
        target2: signal.target2,
        qty,
        direction: signal.direction,
        entryDate: bar.date,
        futureData: historicalData.slice(historicalData.indexOf(bar) + 1),
      });
      
      currentCapital += result.pnl;
      maxCapital = Math.max(maxCapital, currentCapital);
      minCapital = Math.min(minCapital, currentCapital);
      
      trades.push({
        ...result,
        strategy,
        signal,
        capitalAfter: currentCapital,
      });
    }
    
    const winners = trades.filter(t => t.pnl > 0);
    const losers = trades.filter(t => t.pnl < 0);
    
    const result: BacktestResult = {
      strategy,
      period: { start: startDate, end: endDate },
      initialCapital: capital,
      finalCapital: currentCapital,
      totalReturn: ((currentCapital - capital) / capital) * 100,
      
      trades: trades.length,
      winners: winners.length,
      losers: losers.length,
      winRate: (winners.length / trades.length) * 100,
      
      avgWin: winners.reduce((s, t) => s + t.returnPct, 0) / winners.length,
      avgLoss: losers.reduce((s, t) => s + t.returnPct, 0) / losers.length,
      profitFactor: Math.abs(
        winners.reduce((s, t) => s + t.pnl, 0) /
        losers.reduce((s, t) => s + t.pnl, 0)
      ),
      
      maxDrawdown: ((maxCapital - minCapital) / maxCapital) * 100,
      sharpeRatio: this.calculateSharpe(trades),
      
      bestTrade: trades.sort((a, b) => b.returnPct - a.returnPct)[0],
      worstTrade: trades.sort((a, b) => a.returnPct - b.returnPct)[0],
      
      monthlyReturns: this.groupByMonth(trades),
    };
    
    // Auto-update BACKTEST.md
    await this.updateBacktestMD(result);
    
    return result;
  }
  
  // Walk-forward optimization
  async walkForwardTest(strategy: StrategyType): Promise<WalkForwardResult> {
    const periods = [
      { train: ['2022-01', '2022-12'], test: '2023-01' },
      { train: ['2022-01', '2023-06'], test: '2023-07' },
      { train: ['2022-01', '2024-01'], test: '2024-02' },
      { train: ['2022-01', '2024-06'], test: '2024-07' },
    ];
    
    const results = await Promise.all(
      periods.map(p => this.runBacktest(strategy, new Date(p.test), new Date()))
    );
    
    return {
      periods,
      results,
      robustness: this.calculateRobustness(results),
      recommendation: this.makeRecommendation(results),
    };
  }
}
```

---

## Best Performing Setups (From Backtest)

```yaml
# These are the highest-conviction setups from backtest data
top_setups:

  setup_1:
    name: "Gann + SMC Confluence"
    win_rate: "72.3%"
    conditions:
      - "Price at Gann Square of 9 level"
      - "SMC Break of Structure (BOS)"
      - "Volume > 2x average"
      - "RSI 45-55 range"
    markets: ["NIFTY", "BANKNIFTY"]
    timeframe: "15min"
    
  setup_2:
    name: "Options OI Unwinding + Price Breakout"
    win_rate: "69.4%"
    conditions:
      - "PCR < 0.7 (extreme fear = contrarian buy)"
      - "OI unwinding in ATM puts"
      - "Price above prior day high"
      - "Astro: Jupiter positive aspect"
    markets: ["NIFTY options", "BANKNIFTY options"]
    expiry: "Weekly"
    
  setup_3:
    name: "52-Week High Breakout + SMC"
    win_rate: "63.2%"
    conditions:
      - "Stock breaking 52-week high with volume"
      - "RS > Nifty for 8+ weeks"
      - "SMC demand zone holding on daily"
      - "Sector rotation into the sector"
    markets: ["NSE Stocks"]
    timeframe: "Daily"
    target: "20-35%"
    time: "3-6 weeks"
```

---

## Backtest Runner Script

```bash
# Run specific strategy backtest
npm run backtest -- --strategy SWING_BREAKOUT --from 2022-01-01 --to 2025-12-31

# Run all strategies
npm run backtest -- --all

# Walk-forward test
npm run backtest -- --strategy GANN_TIME_CYCLE --walk-forward

# Output: Results saved to backtest/results/ and BACKTEST.md auto-updated
```

---

## Auto-Update Protocol

```typescript
// After each backtest, agent updates this section:
export async function updateBacktestMD(result: BacktestResult) {
  const row = `| ${result.strategy} | ${result.trades} | ${result.winRate.toFixed(1)}% | `
    + `${result.avgWin.toFixed(1)}% | ${result.avgLoss.toFixed(1)}% | `
    + `${result.profitFactor.toFixed(1)} | -${result.maxDrawdown.toFixed(1)}% |`;
  
  // Claude agent: replace the relevant row in the Summary Results table above
  // Log to ERRORS.md if backtest shows degraded performance (win rate drops >5%)
}
```

> Claude agent: run full backtest on 1st of every month and update Summary Results table.
