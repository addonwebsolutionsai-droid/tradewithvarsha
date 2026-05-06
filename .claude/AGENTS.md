# AGENTS.md
> Bot command system for Telegram and WhatsApp. Claude agent reads this for bot logic.
> Last updated: 2026-04-09

---

## Overview

You can message the bot from anywhere (driving, traveling) and get:
- Real-time signals
- Current market analysis
- Trade recommendations
- Portfolio status
- Gann/Astro analysis

The bot is powered by Claude API (claude-sonnet) with your live signal data as context.

---

## Telegram Bot Setup

```typescript
// server/src/bots/telegram.ts
import { Bot, Context } from 'grammy';
import Anthropic from '@anthropic-ai/sdk';

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
const claude = new Anthropic();

// Security: only allow your chat IDs
const ALLOWED_IDS = process.env.TELEGRAM_ALLOWED_CHAT_IDS!
  .split(',').map(Number);

bot.use(async (ctx, next) => {
  if (!ALLOWED_IDS.includes(ctx.chat?.id ?? 0)) {
    await ctx.reply('🔒 Unauthorized');
    return;
  }
  await next();
});

// ============================================
// COMMAND HANDLERS
// ============================================

bot.command('signals', async (ctx) => {
  const signals = await getTopSignals(5);
  const msg = formatSignalsMessage(signals);
  await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('intraday', async (ctx) => {
  const signals = await getIntradaySignals();
  await ctx.reply(formatIntradayMessage(signals), { parse_mode: 'Markdown' });
});

bot.command('swing', async (ctx) => {
  const trades = await getActiveSwingTrades();
  await ctx.reply(formatSwingMessage(trades), { parse_mode: 'Markdown' });
});

bot.command('options', async (ctx) => {
  const oiData = await getOIBuildupSignals();
  await ctx.reply(formatOIMessage(oiData), { parse_mode: 'Markdown' });
});

bot.command('gann', async (ctx) => {
  const text = ctx.message?.text ?? '';
  const dateStr = text.includes('today') ? new Date().toISOString() : text.split(' ')[1];
  const analysis = await getGannAnalysis(dateStr);
  await ctx.reply(formatGannMessage(analysis), { parse_mode: 'Markdown' });
});

bot.command('astro', async (ctx) => {
  const positions = await getPlanetaryPositions();
  await ctx.reply(formatAstroMessage(positions), { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
  const health = await getSystemHealth();
  await ctx.reply(formatHealthMessage(health), { parse_mode: 'Markdown' });
});

bot.command('fix', async (ctx) => {
  await ctx.reply('🔧 Running self-diagnosis...');
  const errors = await readErrorsLog();
  const fixes = await runSelfFix(errors);
  await ctx.reply(`✅ Fixed ${fixes.length} issues:\n${fixes.map(f => `• ${f}`).join('\n')}`);
});

// ============================================
// FREE TEXT — Claude AI Response
// ============================================

bot.on('message:text', async (ctx) => {
  const userMessage = ctx.message.text;
  
  // Get current market context
  const context = await buildMarketContext();
  
  // Ask Claude with full context
  const response = await claude.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1000,
    system: `You are a professional Indian hedge fund manager and algo trader. 
You have real-time access to the following market data:
${JSON.stringify(context, null, 2)}

Answer the user's trading question concisely and specifically.
Always include: instrument, direction, entry, stop-loss, target, reason.
Keep responses under 300 words for WhatsApp/Telegram readability.`,
    messages: [{ role: 'user', content: userMessage }],
  });
  
  const reply = response.content[0].type === 'text' 
    ? response.content[0].text 
    : 'Error generating response';
    
  await ctx.reply(reply, { parse_mode: 'Markdown' });
});

// Start bot
bot.start();
console.log('🤖 Telegram bot running');
```

---

## WhatsApp Bot (via Twilio)

```typescript
// server/src/bots/whatsapp.ts
import twilio from 'twilio';
import express from 'express';

const app = express();
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Webhook to receive messages
app.post('/webhook/whatsapp', express.urlencoded({ extended: false }), async (req, res) => {
  const { Body, From } = req.body;
  
  // Security check
  const allowedNumbers = process.env.WHATSAPP_ALLOWED.split(',');
  if (!allowedNumbers.includes(From)) {
    res.status(403).send('Unauthorized');
    return;
  }
  
  const reply = await processCommand(Body);
  
  // Send reply
  await client.messages.create({
    body: reply,
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: From,
  });
  
  res.status(200).send('OK');
});
```

---

## Command Reference Card

```
═══════════════════════════════════════
    🏦 HEDGE FUND BOT — COMMANDS
═══════════════════════════════════════

📊 SIGNALS
/signals      — Top 5 signals right now
/intraday     — Today's intraday calls
/swing        — Active swing trades
/options      — OI buildup analysis
/futures      — F&O positional trades
/commodity    — Gold & Crude signals

📅 TIMING ANALYSIS  
/gann today   — Gann analysis for today
/gann [date]  — Analysis for specific date
/astro        — Planet positions today
/dates        — Key dates this month

💰 PORTFOLIO
/pnl          — Today's P&L
/open         — Open positions
/risk         — Risk metrics

🔧 SYSTEM
/status       — System health
/backtest     — Last backtest results
/fix          — Self-diagnose & fix

💬 FREE TEXT
Just type anything! e.g.:
"What should I buy today?"
"Is Nifty going up or down?"
"Best options trade right now"
"Gold or crude — which to trade?"
═══════════════════════════════════════
```

---

## Message Formatters

```typescript
// Format a signal for Telegram
export function formatSignalMessage(signal: Signal): string {
  const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';
  const gradeEmoji = { A: '⭐⭐⭐', B: '⭐⭐', C: '⭐', D: '❌' }[signal.grade];
  
  return `
${emoji} *${signal.instrument}* — ${signal.direction}
Grade: ${gradeEmoji} ${signal.grade} (Score: ${signal.score}/10)

📍 Entry: ₹${signal.entry}
🛑 Stop: ₹${signal.stopLoss} (-${signal.riskPct}%)
🎯 Target 1: ₹${signal.target1} (+${signal.reward1Pct}%)
🎯 Target 2: ₹${signal.target2} (+${signal.reward2Pct}%)
📊 R:R = 1:${signal.riskReward}

📋 *Reason:*
${signal.reasons.map(r => `• ${r}`).join('\n')}

⏰ Valid until: ${signal.expiresAt}
🔮 Gann: ${signal.gannNote}
🪐 Astro: ${signal.astroNote}
  `.trim();
}
```

---

## Auto-Alert System

```typescript
// Automatically send alerts for Grade A signals
export async function runAlertLoop(bot: Bot) {
  setInterval(async () => {
    const newSignals = await checkForNewSignals();
    
    for (const signal of newSignals) {
      if (signal.grade === 'A' || signal.score >= 8) {
        const msg = formatSignalMessage(signal);
        
        // Send to all allowed chat IDs
        for (const chatId of ALLOWED_IDS) {
          await bot.api.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        }
        
        // Mark as alerted
        await markSignalAlerted(signal.id);
      }
    }
  }, 60000); // Check every minute
}
```

> Claude agent: update command list when new features are added.
