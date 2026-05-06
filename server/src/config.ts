import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../../.env') })

function num(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback
  return v.toLowerCase() === 'true' || v === '1'
}

export const config = {
  server: {
    port: num(process.env.PORT, 4000),
    clientPort: num(process.env.CLIENT_PORT, 3000),
    nodeEnv: process.env.NODE_ENV ?? 'development',
  },
  apis: {
    alphaVantageKey: process.env.ALPHA_VANTAGE_KEY ?? '',
    twelveDataKey: process.env.TWELVE_DATA_KEY ?? '',
    taapiKey: process.env.TAAPI_KEY ?? '',
    angelApiKey: process.env.ANGEL_API_KEY ?? '',
    angelSecretKey: process.env.ANGEL_SECRET_KEY ?? '',
    angelTotpSecret: process.env.ANGEL_TOTP_SECRET ?? '',
    angelClientCode: process.env.ANGEL_CLIENT_CODE ?? '',
    angelMpin: process.env.ANGEL_MPIN ?? '',
    dhanClientId: process.env.DHAN_CLIENT_ID ?? '',
    dhanAccessToken: process.env.DHAN_ACCESS_TOKEN ?? '',
    upstoxKey: process.env.UPSTOX_API_KEY ?? '',
    upstoxSecret: process.env.UPSTOX_API_SECRET ?? '',
    fmpKey: process.env.FMP_KEY ?? '',
    growwKey: process.env.GROWW_API_KEY ?? '',
  },
  astro: {
    useLocalEphemeris: bool(process.env.USE_LOCAL_EPHEMERIS, true),
    apiUserId: process.env.ASTRO_API_USER_ID ?? '',
    apiKey: process.env.ASTRO_API_KEY ?? '',
  },
  bots: {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
    telegramChatIds: (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    twilioSid: process.env.TWILIO_ACCOUNT_SID ?? '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN ?? '',
    twilioFrom: process.env.TWILIO_WHATSAPP_FROM ?? '',
    whatsappAllowed: process.env.WHATSAPP_ALLOWED ?? '',
  },
  risk: {
    maxCapitalPerTradePct: num(process.env.MAX_CAPITAL_PER_TRADE_PCT, 5),
    maxOpenTrades: num(process.env.MAX_OPEN_TRADES, 10),
    maxDailyLossPct: num(process.env.MAX_DAILY_LOSS_PCT, 2),
  },
  alerts: {
    onNewSignal: bool(process.env.ALERT_ON_NEW_SIGNAL, true),
    minGrade: (process.env.ALERT_MIN_GRADE ?? 'B') as 'A' | 'B' | 'C' | 'D',
    minScore: num(process.env.ALERT_MIN_SCORE, 6),
  },
  backtest: {
    startDate: process.env.BACKTEST_START_DATE ?? '2022-01-01',
    initialCapital: num(process.env.INITIAL_CAPITAL, 1_000_000),
  },
  cache: {
    priceTtl: num(process.env.PRICE_CACHE_TTL, 5),
    oiTtl: num(process.env.OI_CACHE_TTL, 30),
    signalTtl: num(process.env.SIGNAL_CACHE_TTL, 60),
  },
}

export function hasKey(keyName: keyof typeof config.apis): boolean {
  const v = config.apis[keyName]
  return typeof v === 'string' && v.length > 0
}
