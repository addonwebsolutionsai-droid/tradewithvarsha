# CONFIG.md
> All configuration. Never commit real API keys. Use .env file.
> Claude agent: update this when new APIs are added.

---

## .env.example (copy to .env and fill values)

```env
# ============================================
# TRADING DATA APIs
# ============================================

# Alpha Vantage — https://www.alphavantage.co/support/#api-key
ALPHA_VANTAGE_KEY=your_key_here

# Twelve Data — https://twelvedata.com/
TWELVE_DATA_KEY=your_key_here

# Taapi.io (indicators) — https://taapi.io/
TAAPI_KEY=your_key_here

# Financial Modeling Prep
FMP_KEY=your_key_here

# Dhan API (NSE live data + F&O)
DHAN_CLIENT_ID=your_client_id
DHAN_ACCESS_TOKEN=your_token

# Groww Trade API
GROWW_API_KEY=your_key

# Upstox API (alternative NSE source)
UPSTOX_API_KEY=your_key
UPSTOX_API_SECRET=your_secret

# ============================================
# ASTROLOGY APIs
# ============================================

# AstrologyAPI.com — https://astrologyapi.com/
ASTRO_API_USER_ID=your_user_id
ASTRO_API_KEY=your_key

# ============================================
# BOT TOKENS
# ============================================

# Telegram Bot — create at t.me/BotFather
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ALLOWED_CHAT_IDS=your_chat_id,another_id

# WhatsApp via Twilio
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
WHATSAPP_TO=whatsapp:+91XXXXXXXXXX

# ============================================
# SYSTEM CONFIG
# ============================================

# Server
PORT=4000
CLIENT_PORT=3000
NODE_ENV=development

# Cache TTL (seconds)
PRICE_CACHE_TTL=5
OI_CACHE_TTL=30
SIGNAL_CACHE_TTL=60

# Backtest config
BACKTEST_START_DATE=2022-01-01
BACKTEST_END_DATE=2025-12-31
INITIAL_CAPITAL=1000000   # 10 lakh base for backtesting

# Notifications
ALERT_ON_NEW_SIGNAL=true
ALERT_ON_GRADE_A_ONLY=false  # set true to reduce noise

# Risk Management
MAX_CAPITAL_PER_TRADE_PCT=5   # Max 5% of capital per trade
MAX_OPEN_TRADES=10
MAX_DAILY_LOSS_PCT=2          # Circuit breaker: stop trading if -2% day
```

---

## NSE Data Endpoints (No auth needed — use with proper headers)

```typescript
export const NSE_ENDPOINTS = {
  // Always send these headers to avoid blocking
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nseindia.com/',
  },
  
  // Data URLs
  indices: 'https://www.nseindia.com/api/allIndices',
  niftyOptionChain: 'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY',
  bankniftyOptionChain: 'https://www.nseindia.com/api/option-chain-indices?symbol=BANKNIFTY',
  stockOptionChain: (symbol: string) => 
    `https://www.nseindia.com/api/option-chain-equities?symbol=${symbol}`,
  stockQuote: (symbol: string) => 
    `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`,
  fiiDiiData: 'https://www.nseindia.com/api/fiidiiTradeReact',
  derivatives: 'https://www.nseindia.com/api/live-analysis-derivatives',
  
  // Session cookie required — fetch home page first
  cookie_required: true,
  getSession: 'https://www.nseindia.com',
};
```

---

## API Rate Limiting Config

```typescript
export const RATE_LIMITS = {
  alphaVantage: { rpm: 5, daily: 100 },     // Free tier
  twelveData:   { rpm: 8, daily: 800 },     // Free tier
  taapi:        { rpm: 1, daily: 100 },     // Free tier (slow)
  nse:          { rpm: 10, delay_ms: 500 }, // Be gentle
  dhan:         { rpm: 30 },               // Per docs
};
```

---

## WebSocket Config

```typescript
export const WS_CONFIG = {
  // Server sends price updates via WebSocket to React client
  server: {
    port: 4001,
    pingInterval: 30000,
    channels: ['prices', 'signals', 'alerts', 'oi-data'],
  },
  
  // Update intervals
  intervals: {
    priceUpdate: 5000,       // Every 5 seconds
    signalUpdate: 30000,     // Every 30 seconds
    oiUpdate: 60000,         // Every 60 seconds (NSE updates every min)
    gannCheck: 300000,       // Every 5 minutes
    astroCheck: 3600000,     // Every hour
  }
};
```

---

## Chart Config

```typescript
export const CHART_CONFIG = {
  // TradingView Lightweight Charts
  theme: 'dark',
  
  // Default indicators on chart
  defaultIndicators: ['EMA9', 'EMA21', 'EMA50', 'VWAP', 'SuperTrend'],
  
  // Timeframes available
  timeframes: ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1D', '1W', '1M'],
  
  // Colors
  colors: {
    bullCandle: '#26a69a',
    bearCandle: '#ef5350',
    ema9: '#00bcd4',
    ema21: '#ff9800',
    ema50: '#7c4dff',
    vwap: '#ffeb3b',
    supertrend_bull: '#4caf50',
    supertrend_bear: '#f44336',
    signalArrow_buy: '#00e676',
    signalArrow_sell: '#ff1744',
  }
};
```

> Claude agent: never log actual API keys. Always use process.env.KEY_NAME in code.
