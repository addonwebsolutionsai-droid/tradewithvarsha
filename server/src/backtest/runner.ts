import type { BacktestResult, BacktestTrade, Candle, Signal, StrategyContext } from '../types'
import * as data from '../data'
import { astroBiasFor } from '../astro'
import { gannBiasFor } from '../gann'
import { intradaySignal } from '../strategies/intraday'
import { swingSignal } from '../strategies/swing'
import { commoditySignal } from '../strategies/commodity'
import { log } from '../util/logger'

/**
 * Walk-forward simulation: replay candles bar by bar, call the strategy at each
 * step, and record trade outcomes against SL/T1/T2.
 *
 * Limitation: we only backtest strategies that work off candles (intraday/swing/
 * commodity). Options backtesting needs historical OI data which isn't
 * available via free APIs.
 */

export type StrategyId = 'intraday' | 'swing' | 'commodity'

const STRATEGIES = {
  intraday: intradaySignal,
  swing: swingSignal,
  commodity: commoditySignal,
}

export async function backtest(
  symbol: string,
  strategy: StrategyId,
  timeframe: '15m' | '1h' | '1D' = '1D',
  lookbackBars = 500,
  opts: { walkForward?: boolean; trainPct?: number } = {},
): Promise<BacktestResult> {
  const candles = await data.getCandles(symbol, timeframe, lookbackBars)
  if (candles.length < 80) {
    return emptyResult(strategy, symbol)
  }
  log.info('BT', `${strategy} on ${symbol} (${timeframe}) — ${candles.length} bars`)

  const trades: BacktestTrade[] = []
  let openTrade: { sig: Signal; entryIdx: number } | null = null
  const astro = astroBiasFor(new Date())

  // Walk-forward: only count trades from the held-out test window so the
  // reported win-rate is not in-sample. Default split: 70% train / 30% test.
  // Strategy still runs over the full history (so SMC/EMA state is correct);
  // we simply skip recording trades that opened during the train portion.
  const walkForward = opts.walkForward !== false
  const trainPct = opts.trainPct ?? 0.7
  const testStartIdx = walkForward
    ? Math.floor(candles.length * trainPct)
    : 60

  // Warm-up: first 60 bars used just for indicator init
  for (let i = 60; i < candles.length; i++) {
    const window = candles.slice(0, i + 1)
    const higher = timeframe === '1D' ? window : candles.slice(0, i + 1)
    const gann = gannBiasFor(symbol, window[window.length - 1].close, new Date(window[window.length - 1].time))

    // If a trade is open, check SL/T1/T2 against this bar
    if (openTrade) {
      const { sig, entryIdx } = openTrade
      const bar = candles[i]
      const hit = checkExit(bar, sig)
      // Timeout: close after N bars if nothing hit
      const maxHold = timeframe === '1D' ? 21 : 26
      const held = i - entryIdx
      if (hit || held >= maxHold) {
        const exit = hit?.price ?? bar.close
        const result: 'WIN' | 'LOSS' | 'BE' = hit?.type === 'T1' || hit?.type === 'T2' ? 'WIN'
          : hit?.type === 'SL' ? 'LOSS' : 'BE'
        const pnl = sig.direction === 'BUY' ? exit - sig.entry : sig.entry - exit
        // Only record the trade if it OPENED in the test window — keeps
        // walk-forward stats honest.
        if (entryIdx >= testStartIdx) {
          trades.push({
            entryTime: candles[entryIdx].time,
            exitTime: bar.time,
            symbol,
            direction: sig.direction,
            entry: sig.entry,
            exit,
            sl: sig.stopLoss,
            target: sig.target1,
            pnl,
            pnlPct: +(pnl / sig.entry * 100).toFixed(2),
            result,
            signalId: sig.id,
            strategy,
          })
        }
        openTrade = null
      }
      continue
    }

    // No open trade — look for new signal
    const ctx: StrategyContext = {
      symbol,
      candles: window,
      candlesHigher: higher,
      gannBias: gann,
      astroBias: astro,
      date: new Date(window[window.length - 1].time),
    }
    const sig = STRATEGIES[strategy](ctx)
    if (sig && sig.grade !== 'D') {
      openTrade = { sig, entryIdx: i }
    }
  }

  return summarize(trades, symbol, strategy, candles)
}

function checkExit(bar: Candle, sig: Signal): { type: 'SL' | 'T1' | 'T2'; price: number } | null {
  if (sig.direction === 'BUY') {
    if (bar.low <= sig.stopLoss) return { type: 'SL', price: sig.stopLoss }
    if (bar.high >= sig.target2) return { type: 'T2', price: sig.target2 }
    if (bar.high >= sig.target1) return { type: 'T1', price: sig.target1 }
  } else {
    if (bar.high >= sig.stopLoss) return { type: 'SL', price: sig.stopLoss }
    if (bar.low <= sig.target2) return { type: 'T2', price: sig.target2 }
    if (bar.low <= sig.target1) return { type: 'T1', price: sig.target1 }
  }
  return null
}

function summarize(
  trades: BacktestTrade[],
  symbol: string,
  strategy: StrategyId,
  candles: Candle[],
): BacktestResult {
  const wins = trades.filter(t => t.result === 'WIN')
  const losses = trades.filter(t => t.result === 'LOSS')
  const winRate = trades.length ? wins.length / trades.length : 0
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0)
  const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const profitFactor = totalLoss > 0 ? +(totalWin / totalLoss).toFixed(2) : wins.length ? Infinity : 0

  // Running equity curve for drawdown
  let equity = 0
  let peak = 0
  let maxDD = 0
  for (const t of trades) {
    equity += t.pnlPct
    if (equity > peak) peak = equity
    const dd = peak - equity
    if (dd > maxDD) maxDD = dd
  }
  const totalReturn = trades.reduce((s, t) => s + t.pnlPct, 0)

  // Sharpe approximation (annualized from per-trade returns)
  const mean = trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0
  const variance = trades.length
    ? trades.reduce((s, t) => s + Math.pow(t.pnlPct - mean, 2), 0) / trades.length : 0
  const std = Math.sqrt(variance)
  const sharpe = std > 0 ? +(mean / std * Math.sqrt(52)).toFixed(2) : 0 // ~weekly cadence

  const period = {
    from: new Date(candles[0]?.time ?? 0).toISOString().slice(0, 10),
    to: new Date(candles[candles.length - 1]?.time ?? Date.now()).toISOString().slice(0, 10),
  }

  return {
    strategy: `${strategy} (${symbol})`,
    period,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +(winRate * 100).toFixed(1),
    avgWinPct: +avgWin.toFixed(2),
    avgLossPct: +avgLoss.toFixed(2),
    profitFactor,
    maxDrawdownPct: +maxDD.toFixed(2),
    totalReturnPct: +totalReturn.toFixed(2),
    sharpe,
    tradesList: trades.slice(-50), // keep last 50 for inspection
  }
}

function emptyResult(strategy: StrategyId, symbol: string): BacktestResult {
  return {
    strategy: `${strategy} (${symbol})`,
    period: { from: '—', to: '—' },
    trades: 0, wins: 0, losses: 0, winRate: 0,
    avgWinPct: 0, avgLossPct: 0, profitFactor: 0,
    maxDrawdownPct: 0, totalReturnPct: 0, sharpe: 0, tradesList: [],
  }
}

/** Run backtests across the full default universe and return a dashboard view. */
export async function backtestSuite(): Promise<BacktestResult[]> {
  const pairs: [string, StrategyId, '15m' | '1h' | '1D'][] = [
    ['NIFTY', 'intraday', '15m'],
    ['NIFTY', 'swing', '1D'],
    ['BANKNIFTY', 'intraday', '15m'],
    ['RELIANCE', 'swing', '1D'],
    ['TCS', 'swing', '1D'],
    ['HDFCBANK', 'swing', '1D'],
    ['GOLD', 'commodity', '1D'],
    ['CRUDE', 'commodity', '1D'],
  ]
  const out: BacktestResult[] = []
  for (const [sym, strat, tf] of pairs) {
    const r = await backtest(sym, strat, tf, 500)
    out.push(r)
  }
  return out
}

// CLI entry
if (require.main === module) {
  backtestSuite().then(results => {
    console.log('\n=== BACKTEST SUITE RESULTS ===\n')
    console.table(
      results.map(r => ({
        strategy: r.strategy,
        trades: r.trades,
        winRate: `${r.winRate}%`,
        avgWin: `${r.avgWinPct}%`,
        avgLoss: `${r.avgLossPct}%`,
        pf: r.profitFactor,
        maxDD: `${r.maxDrawdownPct}%`,
        return: `${r.totalReturnPct}%`,
        sharpe: r.sharpe,
      })),
    )
    process.exit(0)
  }).catch(e => {
    console.error(e)
    process.exit(1)
  })
}
