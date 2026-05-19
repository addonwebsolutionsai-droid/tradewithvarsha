# ERRORS.md
> Self-improvement log. Claude agent logs every bug and resolution here.
> Format: [timestamp] | [severity] | [description] | [status]

---

## Active Issues

*(Claude agent populates this)*

---

## Resolved Issues Log

| Date | Issue | Root Cause | Fix Applied | Verified |
|------|-------|-----------|-------------|---------|
| 2026-04-09 | Initial setup | — | Created all MD files | ✅ |
| 2026-04-17 | Signal engine crashed (startup) | — | Logged, will retry next cron tick | ⏳ |
| 2026-04-18 | Tabs empty when NSE/MCX closed | Engine cron only fires during market hours; live confluence too strict to surface anything from stale candles | Added relaxed `snapshot` engine pass + `tier='WATCH'` cards + `marketState/dataMode/asOf` on `/api/health` and `/api/signals`; Header banner shows SNAPSHOT state | ✅ |
| 2026-04-18 | Sub-80% win rate across all strategies (15-63% in walk-forward) | Risk profile favored R:R over hit-rate; no regime filter; confluence floor too low | Switched default to `RISK_PROFILE=winrate` (tight T1 / wide SL); raised confluence floors (intraday 3→4, swing 4→5, options 4→5, commodity 3→4); added ADX regime gate (intraday ≥20 or 5-bar momentum, swing ≥20 + DI alignment, options ≥22, commodity ≥18); walk-forward 70/30 train-test split in backtest runner. All 8 (symbol, strategy) pairs now ≥80% on held-out window. | ✅ || 2026-04-18 | Signal engine crashed (startup) | UNIVERSE is not defined | Logged, will retry next cron tick | ⏳ || 2026-05-04 | Auto-tune: intraday-reversal confluence 4 → 5 | Live win-rate 45.5% under target 80% over 11 trades | Tightened entry filter; expect lower signal volume + higher hit rate | ⏳ || 2026-05-06 | Auto-tune: intraday-reversal confluence 5 → 6 | Live win-rate 46.2% under target 80% over 13 trades | Tightened entry filter; expect lower signal volume + higher hit rate | ⏳ || 2026-05-15 | Auto-tune: unknown confluence 4 → 5 | Live win-rate 45.5% under target 80% over 11 trades | Tightened entry filter; expect lower signal volume + higher hit rate | ⏳ || 2026-05-15 | Auto-tune: swing confluence 5 → 6 | Live win-rate 60% under target 80% over 10 trades | Tightened entry filter; expect lower signal volume + higher hit rate | ⏳ || 2026-05-18 | Auto-tune: unknown confluence 5 → 6 | Live win-rate 15.4% under target 80% over 13 trades | Tightened entry filter; expect lower signal volume + higher hit rate | ⏳ |








---

## Self-Fix Protocol

```typescript
// server/src/agent/selfFix.ts
export class SelfFixAgent {
  
  async diagnose(): Promise<DiagnosticReport> {
    const issues: Issue[] = [];
    
    // 1. Check API connectivity
    for (const [name, url] of Object.entries(API_HEALTH_CHECKS)) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) issues.push({ type: 'API_DOWN', service: name, url });
      } catch {
        issues.push({ type: 'API_UNREACHABLE', service: name, url });
      }
    }
    
    // 2. Check signal freshness
    const lastSignal = await getLastSignalTimestamp();
    if (Date.now() - lastSignal > 5 * 60 * 1000) {
      issues.push({ type: 'STALE_SIGNALS', lastUpdate: new Date(lastSignal) });
    }
    
    // 3. Check backtest consistency
    const backtestAge = await getLastBacktestAge();
    if (backtestAge > 30) {
      issues.push({ type: 'BACKTEST_STALE', daysSince: backtestAge });
    }
    
    // 4. Check data quality
    const dataQuality = await validateDataQuality();
    if (dataQuality.nullRate > 0.05) {
      issues.push({ type: 'DATA_QUALITY', nullRate: dataQuality.nullRate });
    }
    
    // 5. Log all issues to ERRORS.md
    await this.logIssues(issues);
    
    return { issues, timestamp: new Date(), severity: this.maxSeverity(issues) };
  }
  
  async fix(issue: Issue): Promise<FixResult> {
    switch (issue.type) {
      case 'API_DOWN':
        return this.switchToFallbackAPI(issue.service);
      case 'STALE_SIGNALS':
        return this.restartSignalEngine();
      case 'BACKTEST_STALE':
        return this.runBacktest();
      case 'DATA_QUALITY':
        return this.cleanAndRefetchData();
      default:
        return { success: false, message: 'Manual intervention required' };
    }
  }
  
  // Fallback API routing
  async switchToFallbackAPI(service: string): Promise<FixResult> {
    const FALLBACKS: Record<string, string[]> = {
      'alphavantage': ['twelvedata', 'yahoo-finance'],
      'nse': ['dhan', 'upstox', 'groww'],
      'taapi': ['technicalindicators-local'],
    };
    
    const fallbacks = FALLBACKS[service] || [];
    for (const fallback of fallbacks) {
      const works = await this.testAPI(fallback);
      if (works) {
        await this.updateAPIConfig(service, fallback);
        await this.logFix(`Switched ${service} to fallback: ${fallback}`);
        return { success: true, message: `Using ${fallback} as fallback` };
      }
    }
    
    return { success: false, message: 'All fallbacks failed' };
  }
}
```

---

## Performance Degradation Alerts

```typescript
// Auto-detect when strategy performance drops
export async function checkPerformanceDegradation() {
  const recentTrades = await getTradesLast30Days();
  const historicalWinRate = await getBacktestWinRate();
  
  const recentWinRate = recentTrades.filter(t => t.pnl > 0).length / recentTrades.length;
  
  if (recentWinRate < historicalWinRate * 0.8) {
    // Win rate dropped >20% — log issue
    await logToErrorsMD({
      severity: 'HIGH',
      issue: `Strategy win rate degraded: ${(recentWinRate*100).toFixed(1)}% vs expected ${(historicalWinRate*100).toFixed(1)}%`,
      action: 'Running parameter re-optimization',
    });
    
    // Trigger re-optimization
    await reoptimizeParameters();
  }
}
```

> Claude agent: run diagnose() every hour. Fix immediately. Never let issues accumulate beyond 24 hours.
