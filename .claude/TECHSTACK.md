# TECHSTACK.md
> Auto-updated by Claude agent on dependency changes.
> Last updated: 2026-04-09

---

## Frontend Stack

```json
{
  "framework": "React 18 + Vite 5",
  "language": "TypeScript 5.4",
  "styling": "Tailwind CSS 3.4 + shadcn/ui",
  "charting": [
    "lightweight-charts@4.1 (TradingView)",
    "recharts@2.12",
    "d3@7.9"
  ],
  "state": "Zustand 4.5",
  "realtime": "WebSocket (native) + Socket.io-client",
  "routing": "React Router v6",
  "data-fetching": "TanStack Query v5",
  "notifications": "react-hot-toast",
  "tables": "TanStack Table v8",
  "forms": "React Hook Form + Zod",
  "date": "date-fns + dayjs",
  "icons": "lucide-react"
}
```

---

## Backend Stack

```json
{
  "runtime": "Node.js 20 LTS",
  "framework": "Express 4 + TypeScript",
  "websocket": "ws (WebSocket server)",
  "scheduler": "node-cron",
  "bot": {
    "telegram": "grammy@2.x",
    "whatsapp": "whatsapp-web.js OR Twilio API"
  },
  "cache": "node-cache (in-memory) + Redis (optional)",
  "queue": "bull (job queue for backtests)"
}
```

---

## Data Sources & APIs

### Primary — Free Tier

| Source | Data | Endpoint | Rate Limit |
|--------|------|----------|------------|
| NSE India (unofficial) | Live prices, OI, F&O data | `https://www.nseindia.com/api/` | Scrape with headers |
| Alpha Vantage | EOD, intraday OHLCV | `https://www.alphavantage.co/query` | 5/min free |
| Yahoo Finance | Global prices | `yfinance` or `yahoo-finance2` npm | Generous |
| TradingView | Charts embed | Widget API (free) | — |
| Groww Trade API | Live NSE data | `https://groww.in/trade-api/` | Per docs |
| Dhan API | F&O, live data | `https://api.dhan.co` | Free tier |

### Astrology APIs

| Source | Data | URL |
|--------|------|-----|
| AstroDB / Astrology API | Planet positions | `https://json.astrologyapi.com/v1/` |
| Swiss Ephemeris (local) | Precise ephemeris | npm `swisseph` |
| Astro-Seek | Free planet positions | Web scrape |

### Chart Pattern APIs

| Source | URL |
|--------|-----|
| Taapi.io | `https://api.taapi.io` (free tier) |
| FinancialModelingPrep | `https://financialmodelingprep.com/api/v3` |
| Twelve Data | `https://api.twelvedata.com` |

---

## Technical Indicator Libraries

```bash
npm install technicalindicators   # RSI, MACD, BB, EMA etc.
npm install tulind                # 100+ indicators (C bindings)
npm install ta-lib-wrapper        # TA-Lib Node wrapper
```

### Key Indicators Used (Hedge Fund Grade)

```typescript
// Trend
EMA(9), EMA(21), EMA(50), EMA(200)
VWAP (daily, weekly)
Ichimoku Cloud (9,26,52)
SuperTrend(10,3)

// Momentum  
RSI(14) — overbought/oversold
Stochastic RSI
MACD(12,26,9)
Williams %R
MFI (Money Flow Index)

// Volatility
ATR(14) — stop loss calculation
Bollinger Bands(20,2)
Keltner Channel(20,1.5)
Historical Volatility(HV20)

// Volume / Smart Money
OBV (On Balance Volume)
VWAP + Std Dev bands
Volume Profile (POC, VAH, VAL)
Delta (buy vol - sell vol)

// Options Specific
Put/Call Ratio (PCR)
OI Change (call/put strike-wise)
Max Pain calculation
IV (Implied Volatility) percentile
Gamma levels
```

---

## Environment Setup

```bash
# Node version
node >= 20.0.0
npm >= 10.0.0

# Clone and install
git clone <your-repo>
cd hedge-fund
npm install        # root (if monorepo)
cd client && npm install
cd ../server && npm install
```

---

## Package.json Scripts

```json
{
  "scripts": {
    "dev": "concurrently \"npm run server:dev\" \"npm run client:dev\"",
    "client:dev": "cd client && vite --port 3000",
    "server:dev": "cd server && ts-node-dev src/index.ts",
    "bot:telegram": "cd server && ts-node src/bots/telegram.ts",
    "bot:whatsapp": "cd server && ts-node src/bots/whatsapp.ts",
    "backtest": "cd server && ts-node src/backtest/runner.ts",
    "build": "cd client && vite build",
    "agent:fix": "claude --print 'Read ERRORS.md and fix all listed issues'",
    "test": "vitest"
  }
}
```

---

## Version Lock (do not upgrade without testing)

```
lightweight-charts: 4.1.x  ← Breaking changes in 4.2
technicalindicators: 3.1.x
grammy: 2.x
```

> Claude agent: update this file whenever `npm install <package>` is run.
