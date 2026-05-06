# 🚀 SETUP GUIDE — HedgeFund OS

Complete setup in ~15 minutes. Dashboard runs on http://localhost:3000

---

## Prerequisites

```bash
# Required
node --version   # Need v20+  →  https://nodejs.org/
git --version    # Need any version

# Install Node 20 if needed (using nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20
nvm use 20
```

---

## Step 1 — Clone / Open in VS Code

```bash
# The hedge-fund folder is your project root
cd hedge-fund

# Open in VS Code
code .
```

---

## Step 2 — Install Dependencies

```bash
# From project root
npm install                      # Root deps (concurrently)
cd client && npm install && cd ..
cd server && npm install && cd ..
```

---

## Step 3 — Configure API Keys

```bash
# Copy env template
cp .env.example .env

# Edit .env — add your keys
# Minimum required to start: TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHAT_IDS
# Dashboard works without any keys (mock data mode)
nano .env      # or open in VS Code
```

### Free API Keys to Get (Priority Order)

| Priority | Service | Time | Link |
|----------|---------|------|------|
| 1 (Required for bot) | Telegram Bot | 2 min | @BotFather on Telegram |
| 2 | Alpha Vantage | 1 min | https://alphavantage.co |
| 3 | Dhan API | 10 min | https://api.dhan.co |
| 4 | Twelve Data | 1 min | https://twelvedata.com |
| 5 | Taapi.io | 1 min | https://taapi.io |

---

## Step 4 — Start the Dashboard

```bash
# From project root — starts BOTH client and server
npm run dev

# OR start separately:
npm run dev:client    # React on http://localhost:3000
npm run dev:server    # API on http://localhost:4000
```

Open http://localhost:3000 in your browser.

---

## Step 5 — Set Up Telegram Bot

```bash
# Start the Telegram bot
npm run bot:telegram

# Then message your bot on Telegram:
/signals    # Should return mock signals
/status     # System health check
```

---

## Step 6 — VS Code Extensions (Recommended)

Install these for best experience:
- **Claude** (official Anthropic extension)
- ESLint
- Prettier
- TypeScript Hero
- Tailwind CSS IntelliSense

---

## Step 7 — Using Claude Agent in VS Code

Open any `.md` file in `.claude/` folder and Claude can:
- Understand your full system context
- Modify strategies when you ask
- Add new indicators
- Fix bugs automatically
- Update BACKTEST.md after testing

### Example Claude Prompts to Use in VS Code

```
"Add a new swing strategy for IT sector stocks using relative strength"
"Why is my signal score low? Check STRATEGIES.md and BACKTEST.md"
"Add Crude Oil OI analysis to the signal engine"
"My Telegram bot isn't responding — check AGENTS.md and fix the issue"
"Run a backtest on the Gann+SMC strategy and update BACKTEST.md"
"Add Bank Nifty specific indicators — it behaves differently than Nifty"
```

---

## Dashboard Tabs Overview

| Tab | What You See |
|-----|-------------|
| All Signals | Every signal, sorted by grade/score |
| Intraday | 9:20am-3:30pm signals with VWAP/SMC |
| Options OI | Live OI chain, PCR, Max Pain, buildup |
| Swing | 1-4 week trades with 20%+ targets |
| Futures | Positional F&O with FII/DII data |
| Gold/Crude | MCX commodity signals |
| Gann/Astro | Time cycles + planetary analysis |
| Backtest | Strategy performance metrics |

---

## Telegram Bot Commands

From anywhere — car, travel, anywhere:

```
/signals          Show top 5 signals right now
/intraday         Today's intraday calls
/swing            Active swing trades  
/options          OI buildup analysis
/gann today       Gann analysis for today
/astro            Planetary positions
/status           System health
/fix              Run self-diagnosis + fix

"What trade should I take now?"   ← Natural language works too
"Is Nifty bullish today?"
"Best options trade this week?"
"Gold or crude — which is better now?"
```

---

## Connecting Live Data (After Getting API Keys)

### 1. Connect NSE Live Data
```typescript
// server/src/services/nseService.ts
// NSE doesn't require API key — just proper headers
// The code handles this automatically
```

### 2. Connect Alpha Vantage
```bash
# In .env:
ALPHA_VANTAGE_KEY=your_key
# The server automatically uses this for OHLCV data
```

### 3. Connect Dhan API (Best for NSE F&O)
```bash
DHAN_CLIENT_ID=your_id
DHAN_ACCESS_TOKEN=your_token
# Provides: Live options chain, futures data, order placement
```

---

## File Watching — Claude Agent Auto-Updates

The `.claude/*.md` files are designed to be:
1. Read by Claude before every code modification
2. Updated automatically when strategies change
3. Your single source of truth for all system rules

### When Claude updates these files:
- `ERRORS.md` — after every bug fix (logged automatically)
- `BACKTEST.md` — after every backtest run
- `STRATEGIES.md` — when you add/modify a strategy
- `CONFIG.md` — when new APIs are connected
- `GANN.md` — monthly Gann date updates
- `ASTRO.md` — monthly planetary event updates

---

## Production Deployment (Optional)

```bash
# Build for production
npm run build

# Deploy dashboard to Vercel (free)
cd client && npx vercel

# Deploy server to Railway (free tier)
cd server && npx railway up

# Or run locally 24/7 with PM2
npm install -g pm2
pm2 start "npm run dev:server" --name hedge-server
pm2 start "npm run dev:client" --name hedge-client
pm2 save && pm2 startup
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Port 3000 in use | Kill: `lsof -ti:3000 \| xargs kill` |
| NSE data not loading | NSE blocks IPs — add headers from CONFIG.md |
| Bot not responding | Check TELEGRAM_BOT_TOKEN in .env |
| No signals generated | Check server logs: `npm run dev:server` |
| Alpha Vantage rate limit | Free tier: 5/min — reduce refresh interval |

---

## Architecture Summary

```
Your Phone (Telegram/WhatsApp)
        ↓ ↑
    Bot Server (port 4000)
        ↓ ↑
   Signal Engine ←→ NSE / AlphaVantage / Dhan
        ↓ ↑
   WebSocket Server
        ↓ ↑
React Dashboard (port 3000)
        ↓
  localhost:3000  ← Open in browser
```

> Read CLAUDE.md for agent instructions and full system context.
