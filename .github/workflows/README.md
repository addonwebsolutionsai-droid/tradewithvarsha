# GitHub Actions — 24/5 automation

These workflows run the platform's scans + Telegram alerts + snapshot
publishing on GitHub-hosted runners so it works even when the local
laptop is off.

## What each workflow does

| Workflow | Cron (UTC) | Cron (IST) | Purpose |
|---|---|---|---|
| `intraday-tick.yml` | `*/5 3-10 * * 1-5` | every 5 min · Mon-Fri 08:30-16:25 | Live intraday scans + Telegram alerts. Tick script itself gates to strict 09:15-15:30 IST market window. |
| `pre-open.yml` | `0 3 * * 1-5` | Mon-Fri 08:30 | Fresh snapshots before market open. |
| `eod.yml` | `0 13 * * 1-5` | Mon-Fri 18:30 | Full end-of-day learning + scan cascade. |
| `sunday-prep.yml` | `30 13 * * 0` | Sun 19:00 | Runs the EOD cascade so Monday morning has fresh data. |

All four also expose a `workflow_dispatch` trigger so you can run them
manually from the **Actions** tab for testing.

## ONE-TIME setup — Required GitHub Secrets

Go to **`https://github.com/addonwebsolutionsai-droid/tradewithvarsha/settings/secrets/actions`**
and add each of these (`New repository secret`):

### 🔔 Telegram (REQUIRED — this is what fixes the alert delivery)

| Secret name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The bot token from @BotFather (looks like `123456789:AA...`) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `1344494235` (your chat id, comma-separated if multiple) |

### 📈 NSE / Angel One (REQUIRED for OI + intraday quotes)

| Secret name | Value |
|---|---|
| `ANGEL_API_KEY` | Your Angel One SmartAPI key |
| `ANGEL_SECRET_KEY` | Angel One secret |
| `ANGEL_CLIENT_CODE` | Angel client code |
| `ANGEL_MPIN` | Angel MPIN |
| `ANGEL_TOTP_SECRET` | TOTP seed for 2FA |

### 🌐 Data fallbacks (OPTIONAL — improves resilience)

| Secret name | Value |
|---|---|
| `ALPHA_VANTAGE_KEY` | Free tier at alphavantage.co |
| `TWELVE_DATA_KEY` | Free tier at twelvedata.com |
| `FMP_KEY` | Free tier at financialmodelingprep.com |

## How to verify it's working

1. Push the code (already done).
2. Add the secrets above (Telegram at minimum — everything else is
   graceful-degradation optional).
3. Go to **Actions** tab → pick `Intraday Tick` → click `Run workflow`.
4. Watch the log — you should see `[TICK] Telegram bot initialised.`
   and each engine's row summary.
5. Any HIGH-conviction signal will fire on Telegram within seconds.

## GitHub free-tier usage

- 2,000 minutes/month free for personal repos (3,000 for orgs)
- Intraday tick @ every 5 min × 8 hours/day × 5 days/week × 4.3 weeks/mo
  × ~40s per run = **~1,720 minutes/month**
- Pre-open + EOD + Sunday add ~180 minutes/month
- **Total: ~1,900 min/month** — fits under the 2,000 min free tier
- If you exceed, GitHub bills $0.008/min = **~$0.40 per extra hour**

If usage is tight, edit `intraday-tick.yml` and change `*/5` to `*/10`
(every 10 min instead of every 5). That halves the intraday budget.

## Troubleshooting

### Telegram still silent after workflow ran?
- Confirm `TELEGRAM_BOT_TOKEN` is set at the repository level (not
  environment level — those need explicit approval per run)
- Confirm `TELEGRAM_ALLOWED_CHAT_IDS` matches your Telegram chat id
- Look at the workflow log for `[TICK] Telegram bot NOT initialised —
  token missing.` — that means the secret isn't wired
- Alert gates are strict (`ALERT_MIN_GRADE=A`, `ALERT_MIN_SCORE=9`).
  Slow news days may legitimately produce zero A-grade signals. To
  loosen for testing, edit the workflow yaml and lower those values.

### Workflow silently doesn't run at cron time?
- GitHub Actions cron is best-effort and can be delayed 5-15+ min under
  peak load. The intraday cron fires every 5 min so a single delayed
  run is auto-recovered by the next tick.
- Cron is disabled after 60 days of inactivity in the repo. Just push
  any commit to re-arm it.

### "Push failed — will retry next tick" in the log?
- Two concurrent ticks tried to write snapshots at the same time.
  Harmless — the next tick's rebase resolves it. If you see this on
  every tick, check for a stuck branch protection rule blocking the
  bot's push.
