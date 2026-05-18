# Tradewithvarsha — Indian hedge-fund trading signals

Pro Indian hedge-fund manager · NSE equities + F&O · MCX commodities.
Strategies: intraday scalps · options momentum · swing (1–4w, ≥20%) · positional F&O.
Core: SMC + Gann/time cycles + Vedic astro + Options OI + ≥3-lens confluence.

## Quick start

```bash
npm install && npm run dev    # http://localhost:3000
```

API on `:4000`. Detailed docs in `README.md`. Live notes in `.claude/ERRORS.md`.

## Conventions

- TypeScript everywhere. Type-safe interfaces, not `any`.
- Edit existing files; new files only when introducing a new module.
- Read files with `offset+limit` for files > 200 lines.
- Grep first to locate code; avoid whole-file reads.
- Memory rules in `~/.claude/projects/.../memory/MEMORY.md` are the persistent guidance.

## When fixing bugs

1. Reproduce locally → identify root cause.
2. Patch with smallest surgical change.
3. Add/update tests if a test framework is present.
4. Commit with `fix(area): description`; one logical fix per commit.

## Vercel public deploy (frozen UI)

6 tabs only on Vercel: Top Trades · Weekly Pick · Daily Pick · Pre-Move · Options · Intraday.
Snapshots auto-publish every 30 min from local backend → GitHub → Vercel raw.
Don't change public-mode UI without explicit user approval.
