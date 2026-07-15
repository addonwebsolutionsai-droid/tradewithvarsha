import { Bot, GrammyError, HttpError } from 'grammy'
import { config } from '../config'
import { log } from '../util/logger'
import { fmtAnalysis, fmtAstro, fmtBacktest, fmtGann, fmtReversalDates, fmtSignal, fmtSignalsList, fmtTimeCycle } from './formatter'
import { analyzeTimeCycles } from '../gann/timeCycleAnalysis'
import { projectReversals } from '../engine/reversalDates'
import { runSignalEngine, signalForSymbol } from '../engine/signalEngine'
import { astroBiasFor } from '../astro'
import { gannBiasFor } from '../gann'
import { backtestSuite, backtest } from '../backtest/runner'
import { parseQuery } from './parseQuery'
import { analyzeIntent } from './smartAnalyzer'
import { parseSmartIntent, handleSmartIntent } from './smartReply'
import { parseConversationIntent, buildConversationReply } from './conversation'
import { addRule, listRules, removeRule, toggleRule } from '../screeners/customRules'

function monthName(m: number): string {
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] ?? ''
}
import type { Signal } from '../types'

let lastSignals: Signal[] = []

export function setLastSignals(signals: Signal[]): void {
  lastSignals = signals
}

export interface BotState {
  bot: Bot | null
  isRunning: boolean
  startedAt: number
}

export const state: BotState = {
  bot: null,
  isRunning: false,
  startedAt: 0,
}

export function createBot(): Bot | null {
  if (!config.bots.telegramToken) {
    log.warn('TG', 'No TELEGRAM_BOT_TOKEN — bot disabled')
    return null
  }
  const bot = new Bot(config.bots.telegramToken)
  state.bot = bot

  // 2026-05-24: GLOBAL OUTBOUND GATE — monkey-patch bot.api.sendMessage to
  // apply two user-requested rules ONCE for all 26+ call sites:
  //   1. WEEKEND BLOCK — no IST Sat/Sun pushes (markets closed = noise).
  //   2. DEDUP — same content to same chat within 24h is dropped silently.
  //      Hash includes only the message body (the chat side is per-chat),
  //      so a fresh different message still gets through but reposts don't.
  //
  // /commands replies from user-initiated chats (ctx.reply) bypass this
  // gate intentionally — they are direct interactions, not scheduled pushes.
  const _origSendMessage = bot.api.sendMessage.bind(bot.api)
  const dedupLedger = new Map<string, number>()       // hash → epoch ms
  const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000          // 24 h
  function hashContent(chatId: string | number, text: string): string {
    // Cheap stable hash — chat + first 200 chars of text. Lifecycle messages
    // include timestamps; we strip digits to make near-duplicates match.
    const norm = String(text).replace(/\d/g, '#').slice(0, 200)
    return `${chatId}|${norm}`
  }
  function istNow(): { dow: number; hour: number } {
    // Convert UTC → IST (UTC+5:30), then read day-of-week + hour.
    const ist = new Date(Date.now() + 5.5 * 3600_000)
    return { dow: ist.getUTCDay(), hour: ist.getUTCHours() }   // dow 0=Sun, 6=Sat
  }
  bot.api.sendMessage = (async (chatId: any, text: any, opts?: any) => {
    // Rule 1: weekend block. Markets-closed window for Indian equities.
    //   • Sat (dow=6) all day blocked
    //   • Sun (dow=0) all day blocked
    //   • Mon (dow=1) blocked until 06:00 IST — user wants pushes to start
    //     exactly at 6 AM IST Monday, not at midnight (no point during sleep).
    const { dow, hour } = istNow()
    const inWeekendBlock = dow === 6 || dow === 0 || (dow === 1 && hour < 6)
    if (inWeekendBlock) {
      log.info('TG-GATE', `weekend-block: drop "${String(text).slice(0, 60)}..." (IST dow=${dow} hr=${hour})`)
      return undefined as any                          // pretend success
    }
    // Rule 2: dedup within 24h
    const key = hashContent(chatId, String(text))
    const now = Date.now()
    const prev = dedupLedger.get(key)
    if (prev != null && now - prev < DEDUP_WINDOW_MS) {
      log.info('TG-GATE', `dedup-block: "${String(text).slice(0, 60)}..." (sent ${Math.round((now - prev) / 60_000)}m ago)`)
      return undefined as any
    }
    dedupLedger.set(key, now)
    // Prune ledger entries older than the window so memory doesn't grow.
    if (dedupLedger.size > 500) {
      const cutoff = now - DEDUP_WINDOW_MS
      for (const [k, t] of dedupLedger) if (t < cutoff) dedupLedger.delete(k)
    }
    return _origSendMessage(chatId, text, opts)
  }) as typeof bot.api.sendMessage

  // Access control middleware — logs rejections visibly and echoes the chat ID
  // back so the operator can update TELEGRAM_ALLOWED_CHAT_IDS if needed.
  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? '')
    const user = ctx.from?.username ?? ctx.from?.first_name ?? 'unknown'
    log.info('TG', `← message from ${user} (chat ${chatId}): ${ctx.message?.text ?? '<non-text>'}`)
    if (config.bots.telegramChatIds.length && !config.bots.telegramChatIds.includes(chatId)) {
      log.warn('TG', `❌ Rejected chat ${chatId} — not in TELEGRAM_ALLOWED_CHAT_IDS`)
      try {
        await ctx.reply(
          `⚠️ Your chat ID *${chatId}* is not in the allowed list.\n\n` +
          `Add this line to your .env and restart:\n` +
          `\`TELEGRAM_ALLOWED_CHAT_IDS=${chatId}\``,
          { parse_mode: 'Markdown' },
        )
      } catch { /* swallow */ }
      return
    }
    await next()
  })

  bot.command('start', (ctx) =>
    ctx.reply(
      `🏦 *HedgeFund OS Bot*\n\nCommands:\n` +
      `/signals — Active signals\n` +
      `/intraday — Today's intraday calls\n` +
      `/swing — Active swing trades\n` +
      `/options — OI analysis\n` +
      `/gann [SYMBOL] — Gann + time cycles\n` +
      `/astro — Planetary positions\n` +
      `/backtest [strategy] — Run backtest\n` +
      `/status SYMBOL — Signal for one symbol\n` +
      `/fix — System self-diagnose\n` +
      `/health — Health check`,
      { parse_mode: 'Markdown' },
    ),
  )

  bot.command('signals', async (ctx) => {
    if (!lastSignals.length) {
      await ctx.reply('📭 No signals cached. Running engine now...')
      lastSignals = (await runSignalEngine()).signals
    }
    await ctx.reply(fmtSignalsList(lastSignals, 'All Signals'), { parse_mode: 'Markdown' })
    // Send detailed cards for top Grade A
    for (const s of lastSignals.filter(x => x.grade === 'A').slice(0, 3)) {
      await ctx.reply(fmtSignal(s), { parse_mode: 'Markdown' })
    }
  })

  bot.command('intraday', async (ctx) => {
    const intraday = lastSignals.filter(s => s.type === 'INTRADAY')
    await ctx.reply(fmtSignalsList(intraday, 'Intraday Signals'), { parse_mode: 'Markdown' })
  })

  bot.command('swing', async (ctx) => {
    const swing = lastSignals.filter(s => s.type === 'SWING')
    await ctx.reply(fmtSignalsList(swing, 'Swing Trades'), { parse_mode: 'Markdown' })
  })

  bot.command('options', async (ctx) => {
    const options = lastSignals.filter(s => s.type === 'OPTIONS')
    await ctx.reply(fmtSignalsList(options, 'Options (OI-based)'), { parse_mode: 'Markdown' })
    for (const s of options.slice(0, 2)) {
      await ctx.reply(fmtSignal(s), { parse_mode: 'Markdown' })
    }
  })

  bot.command('gann', async (ctx) => {
    const symbol = ctx.match?.trim() || 'NIFTY'
    const bias = gannBiasFor(symbol, 0, new Date())
    await ctx.reply(fmtGann(bias), { parse_mode: 'Markdown' })
  })

  bot.command('astro', async (ctx) => {
    const bias = astroBiasFor(new Date())
    await ctx.reply(fmtAstro(bias), { parse_mode: 'Markdown' })
  })

  bot.command('backtest', async (ctx) => {
    const arg = ctx.match?.trim().toLowerCase()
    await ctx.reply('⏳ Running backtest (may take 30-60s)...')
    try {
      if (arg && ['intraday', 'swing', 'commodity'].includes(arg)) {
        const r = await backtest('NIFTY', arg as any, arg === 'intraday' ? '15m' : '1D', 400)
        await ctx.reply(fmtBacktest([r]), { parse_mode: 'Markdown' })
      } else {
        const results = await backtestSuite()
        await ctx.reply(fmtBacktest(results), { parse_mode: 'Markdown' })
      }
    } catch (e) {
      await ctx.reply(`❌ Backtest failed: ${(e as Error).message}`)
    }
  })

  bot.command('status', async (ctx) => {
    const sym = ctx.match?.trim().toUpperCase()
    if (!sym) {
      await ctx.reply('Usage: `/status NIFTY`', { parse_mode: 'Markdown' })
      return
    }
    await ctx.reply(`⏳ Analyzing ${sym}...`)
    const sigs = await signalForSymbol(sym)
    if (!sigs.length) {
      await ctx.reply(`No actionable signals for ${sym} right now.`)
      return
    }
    for (const s of sigs) await ctx.reply(fmtSignal(s), { parse_mode: 'Markdown' })
  })

  bot.command('health', async (ctx) => {
    const uptime = Math.floor((Date.now() - state.startedAt) / 60_000)
    await ctx.reply(
      `🏦 *System Health*\n\n` +
      `• Uptime: ${uptime} min\n` +
      `• Cached signals: ${lastSignals.length}\n` +
      `• Grade A: ${lastSignals.filter(s => s.grade === 'A').length}\n` +
      `• Last run: ${lastSignals[0]?.timestamp ?? 'never'}\n` +
      `• Alpha Vantage: ${config.apis.alphaVantageKey ? '✅' : '❌'}\n` +
      `• Twelve Data: ${config.apis.twelveDataKey ? '✅' : '❌'}\n` +
      `• Dhan: ${config.apis.dhanAccessToken ? '✅' : '⏳'}\n`,
      { parse_mode: 'Markdown' },
    )
  })

  bot.command('addcriteria', async (ctx) => {
    const text = ctx.match?.trim()
    if (!text) {
      await ctx.reply(
        `*Add custom signal criteria*\n\n` +
        `Format (space-separated key=value):\n` +
        `\`/addcriteria name=<id> direction=bull|bear [criteria...]\`\n\n` +
        `*Available criteria:*\n` +
        `• \`rsi_min\` / \`rsi_max\` — RSI range (0-100)\n` +
        `• \`ema_aligned=bull|bear\` — EMA 9>21>50 alignment\n` +
        `• \`above_ema=20|50|200\` — close above this EMA\n` +
        `• \`below_ema=20|50|200\` — close below this EMA\n` +
        `• \`volume_ratio=N\` — last-bar vol ≥ N× 20-day avg\n` +
        `• \`macd=bull|bear\` — MACD histogram sign\n` +
        `• \`adx_min=N\` — trend strength ≥ N\n` +
        `• \`price_min\` / \`price_max\` — price band\n` +
        `• \`change_min\` / \`change_max\` — last-bar % change band\n` +
        `• \`smc=bull|bear\` — SMC structure bias\n` +
        `• \`supertrend=up|down\` — SuperTrend direction\n` +
        `• \`obv_trend_30d=up|down\` — 30-day OBV slope\n` +
        `• \`breakout_days=N\` — close > prior N-day high\n` +
        `• \`breakdown_days=N\` — close < prior N-day low\n` +
        `• \`target_pct=N\` — target in percent\n` +
        `• \`sl_atr=N\` — SL distance in ATRs\n\n` +
        `*Examples:*\n` +
        `\`/addcriteria name=explosive rsi_min=65 volume_ratio=2.5 breakout_days=20 target_pct=15\`\n\n` +
        `\`/addcriteria name=oversold_reversal direction=bull rsi_max=35 smc=bull volume_ratio=1.5 target_pct=10\`\n\n` +
        `\`/addcriteria name=bear_breakdown direction=bear rsi_max=40 below_ema=50 breakdown_days=10 target_pct=-8\``,
        { parse_mode: 'Markdown' },
      )
      return
    }
    try {
      const rule = await addRule(text, ctx.from?.username ?? String(ctx.from?.id ?? ''))
      await ctx.reply(
        `✅ *Rule added: \`${rule.name}\`*\n\n` +
        `Direction: *${rule.direction.toUpperCase()}*\n` +
        `Criteria:\n` +
        Object.entries(rule.criteria).map(([k, v]) => `  • \`${k}\` = \`${v}\``).join('\n') +
        `\n\n_This rule will be evaluated on every scan (moneyflow, swing, premove)._`,
        { parse_mode: 'Markdown' },
      )
    } catch (e) {
      await ctx.reply(`❌ Failed to add rule: ${(e as Error).message}`)
    }
  })

  bot.command('listcriteria', async (ctx) => {
    const all = listRules()
    if (!all.length) {
      await ctx.reply('📭 No custom criteria yet. Use /addcriteria to create one.')
      return
    }
    const lines = all.map(r =>
      `${r.enabled ? '🟢' : '⚪'} *${r.name}* (${r.direction})\n   ` +
      Object.entries(r.criteria).map(([k, v]) => `${k}=${v}`).join(' · '),
    )
    await ctx.reply(`*${all.length} custom rules:*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' })
  })

  bot.command('removecriteria', async (ctx) => {
    const name = ctx.match?.trim()
    if (!name) {
      await ctx.reply('Usage: `/removecriteria <name>`', { parse_mode: 'Markdown' })
      return
    }
    const ok = await removeRule(name)
    await ctx.reply(ok ? `🗑️ Removed rule \`${name}\`` : `Rule \`${name}\` not found`, { parse_mode: 'Markdown' })
  })

  bot.command('togglecriteria', async (ctx) => {
    const name = ctx.match?.trim()
    if (!name) {
      await ctx.reply('Usage: `/togglecriteria <name>`', { parse_mode: 'Markdown' })
      return
    }
    const state = await toggleRule(name)
    await ctx.reply(state ? `🟢 Rule \`${name}\` enabled` : `⚪ Rule \`${name}\` disabled`, { parse_mode: 'Markdown' })
  })

  bot.command('fix', async (ctx) => {
    await ctx.reply('🔧 Running self-diagnose...')
    try {
      const { signals: fresh } = await runSignalEngine()
      setLastSignals(fresh)
      await ctx.reply(`✅ Re-ran signal engine. ${fresh.length} signals (${fresh.filter(s => s.grade === 'A').length} grade A)`)
    } catch (e) {
      await ctx.reply(`❌ Fix failed: ${(e as Error).message}`)
    }
  })

  // Smart text handler — parses any free-form query via the NLP parser and
  // runs it through the ScripMaster-backed analyzer.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim()
    if (text.startsWith('/')) return // command handlers already ran

    // ─── Conversational layer (new 2026-04-29) ─────────────────────────
    // Catches free-form trade ideas, predictions, and opinion asks like:
    //   "i want to short nifty"
    //   "going long xauusd"
    //   "i see BSE 10% correction in may"
    //   "what do you think of dmart"
    //   "is FMCG good now"
    // Replies with engine-alignment (agree/disagree) + actionable plan.
    // Skipped when the message looks like a pure ticker/option query — those
    // continue down to the legacy parsers below.
    const conv = parseConversationIntent(text)
    if (conv) {
      try {
        const reply = await buildConversationReply(conv)
        if (reply) {
          await ctx.reply(reply, { parse_mode: 'Markdown' })
          return
        }
      } catch (e) {
        log.err('TG', `conv reply failed: ${(e as Error).message}`)
        // fall through — never block on the conversational layer
      }
    }

    // Smart-reply router — handles conversational queries like:
    //   "Give me Nifty 50 outlook of the day"
    //   "XAUUSD trade setup for the day as per liquidity"
    //   "Moschip share trade signals based on smart money"
    //   "Smart money liquidity aiming next for Nifty 50 or XAUUSD"
    // Priority: most specific intent wins; falls through to legacy phrase
    // shortcuts + ScripMaster parser if no match.
    const smart = parseSmartIntent(text)
    if (smart) {
      await ctx.reply(`🔍 Running ${smart.kind.replace(/-/g, ' ')} analysis for *${smart.symbol}*…`, { parse_mode: 'Markdown' })
      try {
        const reply = await handleSmartIntent(smart)
        if (reply) {
          await ctx.reply(reply, { parse_mode: 'Markdown' })
          return
        }
        await ctx.reply(
          `❌ Couldn't pull enough data for *${smart.symbol}*.\n` +
          `• Check the ticker is on NSE / MCX\n` +
          `• Market data may be briefly unavailable — try again in a moment.`,
          { parse_mode: 'Markdown' },
        )
        return
      } catch (e) {
        log.err('TG', `smart-reply failed: ${(e as Error).message}`)
        await ctx.reply(`❌ ${smart.kind} analysis failed: ${(e as Error).message}`)
        return
      }
    }

    // Phrase shortcuts — natural language → existing commands
    const lc = text.toLowerCase()
    if (/\b(reversal|turning\s*point|pivot\s*date|next\s*reversal)\b/.test(lc)) {
      const sym = text.toUpperCase().match(/\b(NIFTY|BANKNIFTY|GOLD|CRUDE|SENSEX)\b/)?.[1] ?? 'NIFTY'
      await ctx.reply(`⏳ Projecting reversal dates for ${sym}...`)
      const report = projectReversals(sym, new Date(), 60)
      await ctx.reply(fmtReversalDates(report), { parse_mode: 'Markdown' })
      return
    }
    if (/\btime\s*cycle\b/.test(lc) || /\b(cycle|squaring)\b/.test(lc)) {
      const sym = text.toUpperCase().match(/\b(NIFTY|BANKNIFTY|GOLD|CRUDE|SENSEX)\b/)?.[1] ?? 'NIFTY'
      const report = analyzeTimeCycles(sym, new Date())
      await ctx.reply(fmtTimeCycle(report), { parse_mode: 'Markdown' })
      return
    }
    if (/\b(gann)\b/.test(lc)) {
      const sym = text.toUpperCase().match(/\b(NIFTY|BANKNIFTY|GOLD|CRUDE|SENSEX)\b/)?.[1] ?? 'NIFTY'
      const bias = gannBiasFor(sym, 0, new Date())
      await ctx.reply(fmtGann(bias), { parse_mode: 'Markdown' })
      return
    }
    if (/\b(astro|planet|planetary|vedic|star|zodiac|nakshatra)\b/.test(lc)) {
      const bias = astroBiasFor(new Date())
      await ctx.reply(fmtAstro(bias), { parse_mode: 'Markdown' })
      return
    }
    if (/\b(signals?|calls?|trades?|setups?)\b/.test(lc) && lc.length < 30) {
      await ctx.reply(fmtSignalsList(lastSignals, 'Active Signals'), { parse_mode: 'Markdown' })
      return
    }
    if (/\b(backtest|strategy perf|performance)\b/.test(lc)) {
      await ctx.reply('⏳ Running backtest suite...')
      const results = await backtestSuite()
      await ctx.reply(fmtBacktest(results), { parse_mode: 'Markdown' })
      return
    }
    if (/\b(oi|open\s*interest|option\s*chain|pcr|max\s*pain)\b/.test(lc)) {
      const sym = /banknifty|bn/i.test(text) ? 'BANKNIFTY' : 'NIFTY'
      await ctx.reply(`⏳ Fetching ${sym} option chain...`)
      const { fetchBankNiftyOptionChain, fetchNiftyOptionChain } = await import('../data/nse')
      const { interpretOI, maxPain } = await import('../options/oiAnalyzer')
      let oc = sym === 'BANKNIFTY' ? await fetchBankNiftyOptionChain() : await fetchNiftyOptionChain()
      if (!oc) {
        // Try Angel as fallback
        const angelMod = await import('../data/angel')
        if (angelMod.hasAngelCreds()) {
          oc = await angelMod.getOptionChain(sym as 'NIFTY' | 'BANKNIFTY')
        }
      }
      if (!oc) { await ctx.reply('Option chain unavailable (market may be closed).'); return }
      oc.maxPain = maxPain(oc)
      const interp = interpretOI(oc)
      await ctx.reply(
        `📊 *${sym} Option Chain*\n━━━━━━━━━━━━━━━━━━\n` +
        `Spot: \`${oc.spot.toFixed(2)}\`\n` +
        `PCR: *${oc.pcr.toFixed(2)}* (${interp.pcrRegime.replace('_', ' ')})\n` +
        `Max Pain: *${oc.maxPain}*\n` +
        `Bias: *${interp.bias}*\n\n` +
        `Max Call OI @ *${interp.maxCallOIStrike}*\n` +
        `Max Put OI @ *${interp.maxPutOIStrike}*\n\n` +
        `_${interp.note}_`,
        { parse_mode: 'Markdown' },
      )
      return
    }

    const intent = parseQuery(text)

    if (intent.kind === 'unknown') {
      await ctx.reply(
        `👋 I couldn't parse "${text}".\n\n` +
        `Try queries like:\n` +
        `• \`GHCL\`, \`SJVN\`, \`RELIANCE\` — any NSE stock\n` +
        `• \`BSE TATASTEEL\` — BSE stocks\n` +
        `• \`24200 put May\` / \`24500 call April monthly\` — Nifty options\n` +
        `• \`banknifty 52000 ce May\` — BankNifty options\n` +
        `• \`reliance 3000 pe may\` — Stock options\n` +
        `• \`nifty fut may\` — Futures\n` +
        `• \`gold\`, \`crude\`, \`xauusd\`, \`silver\` — Commodities\n\n` +
        `Or use /start to see all commands.`,
        { parse_mode: 'Markdown' },
      )
      return
    }

    const label =
      intent.kind === 'option' ? `${intent.underlying} ${intent.strike} ${intent.side} ${monthName(intent.month)}` :
      intent.kind === 'equity' ? `${intent.symbol} (${intent.exchange})` :
      intent.kind === 'future' ? `${intent.underlying} FUT${intent.month ? ' ' + monthName(intent.month) : ''}` :
      intent.kind === 'commodity' ? intent.symbol :
      intent.kind === 'index' ? intent.symbol :
      text

    await ctx.reply(`🔍 Analyzing *${label}*...`, { parse_mode: 'Markdown' })

    try {
      const report = await analyzeIntent(intent)
      if (!report) {
        await ctx.reply(
          `❌ Couldn't find *${label}* in Angel's instrument list.\n\n` +
          `Possible reasons:\n` +
          `• Symbol doesn't exist or was delisted\n` +
          `• Expiry month already passed — try next month\n` +
          `• ScripMaster still loading (wait a few seconds and retry)`,
          { parse_mode: 'Markdown' },
        )
        return
      }
      await ctx.reply(fmtAnalysis(report), { parse_mode: 'Markdown' })
    } catch (e) {
      log.err('TG', `analyze failed: ${(e as Error).message}`)
      await ctx.reply(`❌ Analysis failed: ${(e as Error).message}`)
    }
  })

  bot.catch((err) => {
    const e = err.error
    if (e instanceof GrammyError) log.err('TG', `Grammy error: ${e.description}`)
    else if (e instanceof HttpError) log.err('TG', `HTTP error: ${e.message}`)
    else log.err('TG', String(e))
  })

  return bot
}

/**
 * Dedup ledger — prevents the same (instrument + direction + source-group)
 * from pushing twice within the window.
 * Source-group collapses similar strategies into one key so MTF + strict +
 * reversal don't all fire for the same underlying setup.
 */
// 2026-07-15 EMERGENCY tighten — user got 5000+ Telegram messages on 14-Jul
// after the 14-Jul over-relaxation. Standing rules going forward:
//   1. NO F&O EXCEPT NIFTY 50 — no stock options, no stock futures, no BANKNIFTY
//   2. PRE-MOVE ONLY — pre-breakout sources only, no live intraday triggers
//   3. TOP-NOTCH ONLY — A-grade + score ≥ 9.5 + conviction ≥ 80
//   4. HARD DAILY CAP 40 · HARD HOURLY CAP 8
//   5. 6-hour dedup window (was 2h) — same setup can't re-fire same session

const DEDUPE_WINDOW_MS = 6 * 60 * 60_000    // was 2h → 6h
const alertLedger: Record<string, number> = {}

// Rolling per-hour and per-day counters, keyed by IST hour/date bucket.
const hourlyCount: Record<string, number> = {}
const dailyCount: Record<string, number> = {}
const HOURLY_CAP = 8
const DAILY_CAP = 40

function istBucket(ms: number, granularity: 'hour' | 'day'): string {
  const d = new Date(ms + 5.5 * 3600_000)
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0')
  if (granularity === 'day') return `${y}-${m}-${day}`
  return `${y}-${m}-${day}T${String(d.getUTCHours()).padStart(2, '0')}`
}

function sourceGroup(source: string): string {
  if (source.startsWith('options-mtf') || source.startsWith('nifty-strict')) return 'options-primary'
  if (source === 'oi-flow') return 'oi'
  if (source === 'intraday-reversal') return 'reversal'
  if (source === 'fno-advisor') return 'fno'
  if (source === 'harmonic') return 'harmonic'
  return source
}

/**
 * Pre-move / top-notch sources ONLY. These are the sources whose signals
 * fire BEFORE the move (structural setups, accumulation, insider signals),
 * not live intraday reversals or opening-range scalps.
 */
const PRE_MOVE_SOURCES = new Set([
  'WEEKLY', 'weekly-pick',
  'PREMOVE', 'pre-move-identifier',
  'PEDIGREE', 'pedigree-accumulation',
  'INSIDER_BUYS', 'insider-buys',
  'EARLY_MOMENTUM', 'early-momentum',
  'HARMONIC', 'harmonic',
  'FIB', 'fib-lrc',
  'CHART_PATTERNS', 'chart-patterns',
  'nifty-outlook', 'NIFTY_OUTLOOK', 'NIFTY_FORESIGHT',
  'PRO_EDGE', 'pro-edge',
  'CROSS_CONFLUENCE', 'cross-confluence',
  // 2026-07-15 safety expansion:
  //   OPTIONS — NIFTY-only options are the ONLY ones that pass rule 2
  //             (instrument gate), so allowing this source doesn't leak
  //             stock options.
  //   CURATED — the user's own hand-picked list, always high quality.
  //   NIFTY_VOLUME_PROFILE — Volume Profile setup detector (POC/VAH/VAL/
  //             HVN/LVN rejection + rotation + IB break). Same setup type
  //             as the user's manual 15-Jul 24200 PE trade @165 → 300+.
  'OPTIONS',
  'CURATED',
  'NIFTY_VOLUME_PROFILE', 'nifty-volume-profile', 'volume-profile',
])

/**
 * Telegram-eligibility filter (2026-07-15 restrictive rewrite).
 * Strict order-of-operations — a signal must pass EVERY check:
 */
function shouldBroadcastSignal(s: Signal): boolean {
  // 1. Standing memory: no BANKNIFTY.
  if (/^BANKNIFTY\b/i.test(s.instrument)) return false

  // 2. NO F&O EXCEPT NIFTY 50 — user directive 2026-07-15.
  //    For OPTIONS/FUTURES types the instrument must start with "NIFTY " and
  //    NOT with BANKNIFTY / FINNIFTY / MIDCPNIFTY.
  if (s.type === 'OPTIONS' || s.type === 'FUTURES') {
    if (!/^NIFTY\b/i.test(s.instrument)) return false
    if (/^(?:BANKNIFTY|FINNIFTY|MIDCPNIFTY|NIFTYMID|NIFTYFIN|NIFTYIT|NIFTYPHARMA|NIFTYAUTO|NIFTYNXT)/i.test(s.instrument)) return false
  }

  // 3. Block noisy signal types outright.
  if (s.type === 'INTRADAY' || s.type === 'COMMODITY') return false

  // 4. Pre-move sources only — no live scalps, no oi-flow noise.
  const src = String(s.source ?? '').toLowerCase()
  const srcMatch = Array.from(PRE_MOVE_SOURCES).some(a => src === a.toLowerCase() || src.startsWith(a.toLowerCase()))
  if (!srcMatch) return false

  // 5. Top-notch quality — user directive: "Only Share Top Notch quality"
  if (typeof s.score === 'number' && s.score < 9.5) return false
  const conv = (s as unknown as { conviction?: number }).conviction
  if (typeof conv === 'number' && conv < 80) return false

  return true
}

function withinRateCaps(): { ok: boolean; reason: string } {
  const now = Date.now()
  const hb = istBucket(now, 'hour')
  const db = istBucket(now, 'day')
  const h = hourlyCount[hb] ?? 0
  const d = dailyCount[db] ?? 0
  if (d >= DAILY_CAP) return { ok: false, reason: `daily cap ${DAILY_CAP} hit (today count=${d})` }
  if (h >= HOURLY_CAP) return { ok: false, reason: `hourly cap ${HOURLY_CAP} hit (hour count=${h})` }
  return { ok: true, reason: `h=${h}/${HOURLY_CAP} d=${d}/${DAILY_CAP}` }
}

function incrementRateCaps(): void {
  const now = Date.now()
  const hb = istBucket(now, 'hour')
  const db = istBucket(now, 'day')
  hourlyCount[hb] = (hourlyCount[hb] ?? 0) + 1
  dailyCount[db] = (dailyCount[db] ?? 0) + 1
  // Prune old buckets (keep 48h horizon)
  const cutoffDay = istBucket(now - 3 * 86_400_000, 'day')
  for (const k of Object.keys(dailyCount)) if (k < cutoffDay) delete dailyCount[k]
  for (const k of Object.keys(hourlyCount)) if (k.slice(0, 10) < cutoffDay) delete hourlyCount[k]
}

/** Broadcast a signal alert — deduped by (instrument, direction, source-group). */
export async function broadcastSignal(signal: Signal): Promise<void> {
  if (!state.bot || !config.bots.telegramChatIds.length) return
  if (!shouldBroadcastSignal(signal)) {
    log.info('TG', `Skipped ${signal.type} ${signal.instrument} (off-Telegram type per user filter)`)
    return
  }
  // Also dedup on the SAME (instrument|direction) across ALL sources for
  // 6h — a Weekly + Pedigree + Chart-Patterns hit on the same stock
  // shouldn't triple-fire.
  const crossSourceKey = `${signal.instrument}|${signal.direction}`
  const key = `${signal.instrument}|${signal.direction}|${sourceGroup(signal.source)}`
  const lastCross = alertLedger[crossSourceKey] ?? 0
  if (Date.now() - lastCross < DEDUPE_WINDOW_MS) {
    log.info('TG', `Deduped ${crossSourceKey} cross-source (fired ${Math.round((Date.now() - lastCross) / 60000)}m ago)`)
    return
  }
  const last = alertLedger[key] ?? 0
  if (Date.now() - last < DEDUPE_WINDOW_MS) {
    log.info('TG', `Deduped ${key} (fired ${Math.round((Date.now() - last) / 60000)}m ago)`)
    return
  }
  // Rate caps — hard hourly + daily limits so we can NEVER spam.
  const cap = withinRateCaps()
  if (!cap.ok) {
    log.warn('TG', `Rate-cap: ${signal.instrument} ${signal.direction} dropped — ${cap.reason}`)
    return
  }
  alertLedger[key] = Date.now()
  alertLedger[crossSourceKey] = Date.now()
  // Prune old entries (>24h)
  const cutoff = Date.now() - 24 * 3600_000
  for (const k of Object.keys(alertLedger)) if (alertLedger[k] < cutoff) delete alertLedger[k]

  const msg = fmtSignal(signal)
  for (const chatId of config.bots.telegramChatIds) {
    try {
      await state.bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' })
      incrementRateCaps()
    } catch (e) {
      log.err('TG', `Broadcast to ${chatId} failed: ${(e as Error).message}`)
    }
  }
}

export async function startTelegramBot(): Promise<Bot | null> {
  const bot = createBot()
  if (!bot) return null
  state.startedAt = Date.now()
  state.isRunning = true
  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => log.ok('TG', `Bot @${info.username} started`),
  }).catch(e => {
    log.err('TG', `Failed to start: ${e.message}`)
    state.isRunning = false
  })
  return bot
}

// CLI entry
if (require.main === module) {
  startTelegramBot()
}
