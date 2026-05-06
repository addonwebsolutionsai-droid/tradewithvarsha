# STRUCTURE.md

> Canonical file tree of the built system. Update whenever a new module / page is added.

```
hedge-fund/
├── .env                         # Live secrets (gitignored) — Alpha Vantage, Twelve Data, Telegram
├── .env.example                 # Template
├── CLAUDE.md                    # System spec & agent instructions
├── SETUP.md
├── package.json                 # Root — concurrently runs client + server
│
├── .claude/
│   ├── AGENTS.md
│   ├── ASTRO.md
│   ├── BACKTEST.md
│   ├── CONFIG.md
│   ├── ERRORS.md                # Self-improvement log (auto-updated)
│   ├── GANN.md
│   ├── INDICATORS.md
│   ├── STRATEGIES.md
│   ├── STRUCTURE.md             # ← this file
│   └── TECHSTACK.md
│
├── server/                      # Node.js + Express + TypeScript
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts             # Main entry — HTTP + WS + cron + startup
│       ├── config.ts            # Env loader, typed config object
│       ├── types.ts             # Shared TypeScript types
│       │
│       ├── util/
│       │   ├── logger.ts        # Colored stdout logger
│       │   ├── time.ts          # IST helpers, market-hours checks
│       │   └── errorsLog.ts     # Appends to .claude/ERRORS.md
│       │
│       ├── data/                # Data-source router + individual providers
│       │   ├── index.ts         # Unified router (getQuote / getCandles)
│       │   ├── cache.ts         # node-cache wrappers with TTLs
│       │   ├── nse.ts           # NSE India (option chain, allIndices, FII/DII)
│       │   ├── alphaVantage.ts  # AV quote + intraday + daily
│       │   ├── twelveData.ts    # TD quote + time_series
│       │   └── yahoo.ts         # Yahoo Finance public (no-key fallback)
│       │
│       ├── indicators/
│       │   └── index.ts         # EMA/SMA/RSI/MACD/ATR/VWAP/Bollinger/ADX/Stoch/OBV/pivots/SuperTrend
│       │
│       ├── patterns/
│       │   ├── smc.ts           # Swings, BOS/CHoCH, liquidity sweeps, order blocks
│       │   ├── candlestick.ts   # Engulfing, hammer, star, doji, …
│       │   └── chart.ts         # Double top/bottom, triangles, channels, breakouts
│       │
│       ├── options/
│       │   └── oiAnalyzer.ts    # PCR, Max Pain, writing/unwinding, leg suggester
│       │
│       ├── gann/
│       │   ├── squareOf9.ts     # Levels from seed (√price + θ/180)²
│       │   ├── timeCycles.ts    # 30/45/60/90/120/144/180/270/360-day projections
│       │   └── index.ts         # gannBiasFor(symbol, price, date)
│       │
│       ├── astro/               # Local ephemeris — NO API KEY NEEDED
│       │   ├── ephemeris.ts     # Geocentric positions + Lahiri ayanamsa (sidereal)
│       │   ├── aspects.ts       # Conjunction/Opposition/Trine/Square/Sextile + financial scoring
│       │   └── index.ts         # astroBiasFor(date)
│       │
│       ├── strategies/          # Each returns a Signal | null
│       │   ├── intraday.ts      # SMC + VWAP + EMA + volume (3/5 min)
│       │   ├── swing.ts         # Daily SMC + MACD + ADX + weekly alignment (4/5)
│       │   ├── options.ts       # Underlying bias + OI confirmation (4/5)
│       │   └── commodity.ts     # Gold/Crude with astro sensitivity
│       │
│       ├── engine/
│       │   ├── scoring.ts       # Weighted confluence → grade A/B/C/D
│       │   ├── risk.ts          # ATR-based SL/T1/T2 per signal type
│       │   └── signalEngine.ts  # Loops universe, calls strategies, dedupes
│       │
│       ├── backtest/
│       │   └── runner.ts        # Walk-forward replay + suite + CLI entry
│       │
│       └── bots/
│           ├── telegram.ts      # grammy-based bot with all commands
│           └── formatter.ts     # Markdown formatters for each message type
│
└── client/                      # React + Vite + Tailwind + TypeScript
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts           # Proxy /api + /ws → server:4000
    ├── tailwind.config.js
    ├── postcss.config.js
    ├── index.html
    └── src/
        ├── main.tsx             # React root
        ├── App.tsx              # Router + layout
        ├── index.css            # Tailwind entry
        ├── types.ts             # Client-side types
        ├── api.ts               # Fetch wrappers for all /api/* endpoints
        ├── ws.ts                # useLiveWebSocket hook (auto-reconnect)
        ├── store.ts             # Zustand global store
        │
        ├── components/
        │   ├── Header.tsx       # Status bar (connection, market, bot)
        │   ├── MarketBar.tsx    # Index ticker
        │   ├── TabNav.tsx       # Main navigation
        │   ├── SummaryCards.tsx # Grade A count, avg score, PCR, system
        │   ├── SignalCard.tsx   # Expandable card per signal
        │   ├── SignalList.tsx   # Sorted signal list
        │   ├── OITable.tsx      # Live option chain with OI bars
        │   ├── GannPanel.tsx    # Time cycles + Square-of-9 levels
        │   ├── AstroPanel.tsx   # Planetary positions + aspects
        │   ├── BacktestTable.tsx# Suite results
        │   └── BotPanel.tsx     # Bot status + diagnose
        │
        └── pages/
            ├── SignalsPage.tsx  # / — all signals
            ├── IntradayPage.tsx # /intraday
            ├── OptionsPage.tsx  # /options (signals + live OI)
            ├── SwingPage.tsx    # /swing
            ├── CommodityPage.tsx# /commodity
            ├── GannPage.tsx     # /gann
            ├── BacktestPage.tsx # /backtest
            └── BotPage.tsx      # /bot
```

## REST API endpoints (see server/src/index.ts)

```
GET  /api/health                # uptime, signal counts, bot status
GET  /api/diagnose              # service-by-service health
GET  /api/signals               # ?type=&grade=&minScore=
POST /api/signals/refresh       # force re-run
GET  /api/signal/:symbol        # on-demand for one symbol
GET  /api/market/indices        # NSE live indices
GET  /api/price/:symbol         # unified quote router
GET  /api/candles/:symbol?tf=   # candles via router
GET  /api/options/:symbol       # option chain + OI analysis (NIFTY/BANKNIFTY)
GET  /api/gann?symbol=&price=   # Gann bias for a symbol
GET  /api/astro?date=           # planetary positions + aspects
GET  /api/fii-dii               # NSE FII/DII flow
GET  /api/backtest?...          # single backtest
GET  /api/backtest/suite        # full suite
GET  /api/bot/status            # Telegram bot status
```

## WebSocket messages (ws://localhost:4000/ws)

```
INIT              — Initial state dump (signals array)
SIGNALS_UPDATE    — New signal batch from engine
OI_UPDATE         — PCR/max-pain tick (every minute during market hours)
HEARTBEAT         — Server alive + marketOpen flag (every 30s)
BACKTEST_UPDATE   — Daily post-close backtest results
```

## Scheduled jobs (Asia/Kolkata timezone)

```
*/5 9-15 * * 1-5    Signal engine (every 5m during NSE hours)
*   9-15 * * 1-5    OI refresh (every minute)
*/15 9-23 * * 1-5   Commodity engine tick (MCX hours)
0   16 * * 1-5      Daily backtest suite
0   * * * *         Stale-signal self-heal
```
