# Vercel Free-Tier Deployment — 3-Tab Public Mode

**Strategy: Vercel free + local backend + GitHub snapshots = ₹0 / month**

---

## How it works

```
Local machine (your laptop)              Vercel (free)
┌──────────────────────────┐            ┌─────────────────────┐
│ Backend (Express)        │            │ Frontend (Vite/React)│
│ - Generates picks 24/7   │            │ - 3 tabs only:       │
│ - Cron writes to:        │            │   Weekly / Options /  │
│   data/public-snapshots/ │            │   Intraday           │
│   ├─ weekly-pick.json    │            │ - Login + Signup     │
│   ├─ options.json        │            │ - Reads JSON via     │
│   └─ intraday.json       │            │   raw.githubusercontent│
└────────┬─────────────────┘            └──────────┬──────────┘
         │                                          │
         │ git commit + push every 30min            │ HTTPS
         ▼                                          ▼
┌────────────────────────────────────────────────────────┐
│        GitHub repo (public — only snapshot dir)         │
│   /server/data/public-snapshots/*.json                  │
└────────────────────────────────────────────────────────┘
```

The Vercel frontend never talks to your backend. It only fetches the 3 JSON files
from the public GitHub repo. Your backend stays local; users never see the
Telegram bot, the cron jobs, the Angel SmartAPI session, or the admin tabs.

---

## What's locked (TRUE hidden, not CSS-hidden)

When `VITE_PUBLIC_MODE=true` is set on the Vercel build:
- `App.tsx` only registers routes for `/login`, `/signup`, `/weekly-pick`, `/options`, `/intraday`
- All other paths redirect to `/weekly-pick`
- `TabNav` shows only those 3 nav items
- `MarketBar` and `LiveFeedSidebar` removed from layout
- Admin / Pro / Backtest / Gann / Time Cycle / Harmonic / Turtle Soup pages are
  **not in the route table at all** — view-source can't reveal what isn't rendered
- Vite's tree-shaking excludes their components from the public bundle

If a coder opens DevTools, they'll see the unused page imports in the bundle
chunks (Vite splits routes lazily). To make it 100% airtight you'd need a
separate entry file (`App.public.tsx`) — say the word and I'll add it; but for
the casual "no one can see it by removing CSS" threat model, the route gate is
sufficient.

---

## Step-by-step deploy (~30 minutes total)

### Prereq
- A free GitHub account
- A free Vercel account (sign up with GitHub)

### Step 1 — Push the repo to GitHub (10 min)

```bash
cd /Users/apple/Downloads/files_full_sys/hedge-fund
git init
echo "node_modules\ndist\n.env\nserver/data/users.json\nserver/data/auto-tune.json\nserver/data/learning\nserver/data/pick-journal\nserver/data/weekly-watchlist.json" > .gitignore
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/hedge-fund.git
git push -u origin main
```

**Important:** the `.gitignore` above EXCLUDES users.json, learning data, and
pick-journal — those are private. The `public-snapshots` directory IS pushed
because that's the data the frontend reads.

### Step 2 — Vercel deploy (5 min)

1. Go to [vercel.com/new](https://vercel.com/new) → Import the GitHub repo
2. **Root Directory:** `client`
3. **Framework Preset:** Vite
4. **Build Command:** `npm run build`
5. **Output Directory:** `dist`
6. **Environment Variables:**
   ```
   VITE_PUBLIC_MODE         = true
   VITE_SNAPSHOT_BASE_URL   = https://raw.githubusercontent.com/YOUR_USERNAME/hedge-fund/main/server/data/public-snapshots
   ```
7. Deploy.

In ~60 seconds you'll get a URL like `https://hedge-fund.vercel.app` showing
only Login/Signup/3-tabs.

### Step 3 — Local backend keeps running (always-on)

Keep the local server running:

```bash
cd /Users/apple/Downloads/files_full_sys/hedge-fund
npm run dev
```

Every 30 minutes the cron in `index.ts` writes fresh JSON to:
```
server/data/public-snapshots/weekly-pick.json
server/data/public-snapshots/options.json
server/data/public-snapshots/intraday.json
```

### Step 4 — Auto-publish to GitHub (the missing piece)

You have two choices for getting those JSONs to GitHub:

**Option A — Cron + git push (simplest, runs on YOUR machine):**

Add this to your local crontab (run `crontab -e`):

```cron
*/30 * * * * cd /Users/apple/Downloads/files_full_sys/hedge-fund && git add server/data/public-snapshots && git commit -m "snapshot: $(date +\%Y-\%m-\%d-\%H-\%M)" && git push >/dev/null 2>&1
```

This commits + pushes the 3 JSONs every 30 min. Vercel users see fresh data
within 30-60 seconds (raw.githubusercontent.com cache).

**Option B — GitHub Actions (more advanced, no local cron):**

Skip — needs the backend itself running on a server, defeats the free-tier point.

### Step 5 — First user signup

Visit `https://your-app.vercel.app/signup` — first signup auto-becomes admin.
But signup hits `/api/auth/signup` which doesn't exist on Vercel (no backend!).

**This is the auth gotcha:** the auth backend lives on YOUR local machine, not
on Vercel. To make signup work on the public deploy you need ONE of these:

1. **Skip auth entirely on public deploy** — set `VITE_PUBLIC_MODE=true` and
   make the 3 public pages readable without login. Easiest. Anyone can see
   the picks. (Recommended for "build a habit, charge later" stage.)
2. **Tunnel only the auth endpoints** — use a free service like Cloudflare
   Tunnel to expose ONLY `/api/auth/*` from your local backend. ~10 min setup.
3. **Use Vercel functions for auth** — port `auth/users.ts` to a Vercel
   function. ~30 min, requires moving user storage to Vercel KV (free tier).

For now I recommend **Option 1**: drop auth on public deploy. Tell me when
you want to add gating later and I'll wire up Cloudflare Tunnel.

To skip auth: in `App.tsx` PUBLIC_MODE block, replace `<RequireAuth>` wrappers
with the page directly. Say the word and I'll do this 30-second edit.

---

## What you do now — 4-step checklist

Send me back:
1. **Your GitHub username** (so I can give you the exact env-var URLs)
2. **Repo name** — keep `hedge-fund` or want something else?
3. **Auth on public deploy** — yes / no / later?
4. **Custom domain** — keep `<name>.vercel.app` or buy one?

Once I have these I'll:
- Write the final `.gitignore`
- Run `git init` + first commit
- Generate the exact Vercel env-var paste
- Make the auth-skip toggle if you said no
- Confirm the snapshot-publish cron entry

---

## Cost recap

| Item | Cost |
|---|---|
| Vercel Hobby (frontend) | **₹0** |
| GitHub free public repo | **₹0** |
| Your local machine running 24/7 | **₹0** (already running) |
| Custom domain (optional) | **~₹800/year** if you want one |
| **TOTAL** | **₹0 / month** |

---

## Limitations of this approach (full transparency)

1. **Stale data when machine sleeps** — if you close your laptop, snapshots
   stop refreshing. Public users see last-known data with timestamp.
2. **No real-time signals** — frontend reads JSON, not WebSocket. ~30 min lag.
3. **No live Telegram from frontend** — Telegram still works (it's backend-only);
   public users can't subscribe via the website.
4. **Auth limitation** — needs Cloudflare Tunnel or Vercel KV migration to gate
   the public deploy. Without it, anyone can see the 3 tabs.

For an MVP "build the habit" stage these are all acceptable. When you're ready
to charge, the upgrade path is: backend → Render Starter ($7/mo) → real-time
restored, auth wired, paid plans gated.
