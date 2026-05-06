# Deployment Guide — Always-On Operation

Pick one of three paths. Option A is cheapest-always-on, Option B is free, Option C is no-cost-no-cloud.

---

## Option A — Render.com (recommended, $7/mo always-on)

**One-click deploy:**

1. Push this repo to GitHub:
   ```bash
   cd /Users/apple/Downloads/files_full_sys/hedge-fund
   git init && git add . && git commit -m "initial"
   gh repo create hedge-fund-os --private --source=. --push
   ```

2. Log in to [render.com](https://render.com) → "New +" → "**Blueprint**" → select your repo.

3. Render reads `render.yaml` and provisions a Docker service. It will prompt for environment variables — paste these (values from your local `.env`):

   | Key | Value |
   |---|---|
   | `ALPHA_VANTAGE_KEY` | `XJDM8AVXYWWM8RI1` |
   | `TWELVE_DATA_KEY` | `00628580ab054859965722a68954da8d` |
   | `ANGEL_API_KEY` | `Rvq1ee7O` |
   | `ANGEL_SECRET_KEY` | `4767432d-54b0-447b-80ae-71d8dfb7722e` |
   | `ANGEL_TOTP_SECRET` | `OL66HAG6QU6D6OMDZP2OL6NHEU` |
   | `ANGEL_CLIENT_CODE` | `MACU1049` |
   | `ANGEL_MPIN` | `9119` |
   | `TELEGRAM_BOT_TOKEN` | `8546144947:...` |
   | `TELEGRAM_ALLOWED_CHAT_IDS` | `1344494235` |

4. Click **"Apply"**. Render builds the Docker image (~3 min) and deploys. You'll get a URL like `https://hedge-fund-os.onrender.com`.

**After deploy:**
- Laptop can be off; the server runs 24/7 on Render.
- Your Telegram bot is always online.
- All cron jobs fire in Asia/Kolkata time (signal engine, pre-move alerts, daily backtest).
- The dashboard is accessible at your Render URL (though the `/ws` WebSocket uses the same URL).
- Disk is persistent, so custom rules (`data/rules.json`) and cached data survive restarts.

**Plans:**
- `starter` ($7/mo) — always-on, recommended for the bot.
- `free` (750 hours/month) — spins down after 15 min idle. Bot will miss messages during spin-down. **Not recommended** for bots.

---

## Option B — Fly.io (free tier, 3 small VMs)

```bash
brew install flyctl
flyctl auth signup
flyctl launch --copy-config --dockerfile Dockerfile --name hedge-fund-os --region sin
flyctl secrets set \
  ALPHA_VANTAGE_KEY='XJDM8AVXYWWM8RI1' \
  TWELVE_DATA_KEY='00628580ab054859965722a68954da8d' \
  ANGEL_API_KEY='Rvq1ee7O' \
  ANGEL_SECRET_KEY='4767432d-54b0-447b-80ae-71d8dfb7722e' \
  ANGEL_TOTP_SECRET='OL66HAG6QU6D6OMDZP2OL6NHEU' \
  ANGEL_CLIENT_CODE='MACU1049' \
  ANGEL_MPIN='9119' \
  TELEGRAM_BOT_TOKEN='<your token>' \
  TELEGRAM_ALLOWED_CHAT_IDS='1344494235'
flyctl deploy
```

Fly gives you 3 free `shared-cpu-1x` VMs (256MB each) with 160GB transfer/month. Singapore region keeps latency to NSE minimal.

---

## Option C — Keep your Mac plugged in (no cost, no cloud)

1. Build once:
   ```bash
   cd /Users/apple/Downloads/files_full_sys/hedge-fund
   cd server && npm run build && cd ..
   ```

2. Install PM2 globally (one-time):
   ```bash
   npm install -g pm2
   ```

3. Start the server under PM2:
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 save
   pm2 startup     # follow the printed command to enable on boot
   ```

4. Prevent your Mac from sleeping (keep it plugged in):
   ```bash
   caffeinate -dims &
   ```
   Or System Settings → Energy → "Prevent automatic sleeping when display is off".

5. To view logs: `pm2 logs hedge-fund-os`
   To restart: `pm2 restart hedge-fund-os`
   To stop: `pm2 stop hedge-fund-os`

**Caveats for Option C:**
- Your laptop must stay on and have internet. If you close the lid or lose power, the bot goes offline.
- Use this while testing; migrate to Option A/B once stable.

---

## Option D — Hetzner / DigitalOcean VPS (€4/mo)

1. Provision a 1vCPU / 2GB RAM VPS in Europe or Asia. Pick Debian 12.
2. SSH in and install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
3. Clone the repo + build:
   ```bash
   git clone <your-repo-url>
   cd hedge-fund
   docker build -t hedge-fund-os .
   docker run -d --restart=unless-stopped --name hedge \
     -p 4000:4000 \
     -v $(pwd)/data:/app/server/data \
     -e ANGEL_API_KEY=... \
     -e ANGEL_CLIENT_CODE=MACU1049 \
     ... all env vars ...
     hedge-fund-os
   ```

---

## Post-deploy sanity checks

Whichever option you choose, verify:

```bash
# Health
curl https://<your-url>/api/health

# Angel session
curl https://<your-url>/api/angel/status

# Telegram bot running
curl https://<your-url>/api/bot/status

# Full diagnose
curl https://<your-url>/api/diagnose
```

Then message your bot on Telegram. If it replies, you're live.

---

## Security notes

- **Never commit `.env`** — it contains Angel + Telegram secrets. `.gitignore` already excludes it.
- **Rotate Angel TOTP** if you ever suspect leakage — regenerate on the SmartAPI dashboard.
- Render/Fly/DO encrypt env vars at rest. Only you can see them in the dashboard.
- Telegram bot token is whitelist-protected (`TELEGRAM_ALLOWED_CHAT_IDS`) — even if the token leaks, only your chat ID is served.
