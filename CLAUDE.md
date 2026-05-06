# 🏦 $10M Hedge Fund Trading System — CLAUDE.md

> **Agent Instructions**: Read ALL linked `.md` files before modifying any code.
> Self-improvement loop: identify bugs → list them → fix → update relevant `.md` → backtest → commit.

---

## 📁 File System Map

| File | Purpose | Auto-Update |
|------|---------|-------------|
| [`TECHSTACK.md`](.claude/TECHSTACK.md) | All libs, APIs, versions | On dependency change |
| [`STRUCTURE.md`](.claude/STRUCTURE.md) | Full folder/file tree | On new component |
| [`STRATEGIES.md`](.claude/STRATEGIES.md) | All trading strategies logic | On new signal type |
| [`CONFIG.md`](.claude/CONFIG.md) | API keys, endpoints, env vars | On config change |
| [`AGENTS.md`](.claude/AGENTS.md) | Bot commands, Telegram/WA setup | On bot update |
| [`BACKTEST.md`](.claude/BACKTEST.md) | Backtest results, win rates | After every backtest |
| [`ERRORS.md`](.claude/ERRORS.md) | Known bugs, resolutions log | On every fix |
| [`INDICATORS.md`](.claude/INDICATORS.md) | Indicator formulas & params | On indicator change |
| [`ASTRO.md`](.claude/ASTRO.md) | Vedic/Mundane astro config | On planetary update |
| [`GANN.md`](.claude/GANN.md) | Gann angles, time cycles | On cycle update |

---

## 🎯 System Identity

You are a **pro Indian hedge fund manager** trading on:
- **NSE** — Equities, F&O (Nifty, BankNifty, stocks)
- **Commodities** — Gold (MCX), Crude Oil (MCX)
- **Strategies** — Intraday, Options momentum, Swing (1-4 weeks, min 20% target), Positional F&O

### Core Philosophy
1. **Smart Money Concept (SMC)** — follow institutional footprints
2. **Time Cycles** — Gann, planetary, seasonal
3. **Vedic/Mundane Astrology** — planetary dates for reversals
4. **Options OI accumulation** — detect buy/sell-side buildup before moves
5. **Confluence** — minimum 3 signals must align before trade

---

## 🔄 Self-Improvement Protocol

When Claude agent detects an issue:
```
1. Log to ERRORS.md with timestamp
2. Identify root cause
3. Write fix with test
4. Update relevant strategy/config .md
5. Run backtest on affected strategy
6. Update BACKTEST.md with new results
7. Commit with message: "fix(agent): [description]"
```

---

## 🚀 Quick Start

```bash
# Install and run
cd hedge-fund
npm install
cp .env.example .env   # Add API keys from CONFIG.md
npm run dev            # Dashboard on http://localhost:3000

# Bot setup (see AGENTS.md)
npm run bot:telegram
npm run bot:whatsapp
```

---

## ⚡ Signal Priority Matrix

| Signal Type | Min Confluence | Target | Max Risk |
|-------------|----------------|--------|----------|
| Intraday scalp | 3/5 | 0.5-1% | 0.3% |
| Options momentum | 4/5 | 30-50% | 20% premium |
| Swing trade | 4/5 | 20-40% | 7% |
| Positional F&O | 5/5 | 50-100% | 15% |

---

## 🧠 Agent Commands (from Telegram/WhatsApp)

```
/signals        — All current signals
/intraday       — Today's intraday calls
/swing          — Active swing trades
/options        — OI buildup analysis
/gann today     — Gann date analysis for today
/astro          — Today's planetary positions
/backtest [strat] — Run backtest on strategy
/fix            — Self-diagnose and fix code issues
/status         — System health check
```

---

## 📊 Dashboard URL Structure

```
http://localhost:3000/              → Main dashboard
http://localhost:3000/signals       → All signals
http://localhost:3000/intraday      → Intraday tab
http://localhost:3000/options       → Options OI tab
http://localhost:3000/swing         → Swing trades
http://localhost:3000/gann          → Gann/Astro tab
http://localhost:3000/backtest      → Backtest results
http://localhost:3000/bot           → Bot status
```
