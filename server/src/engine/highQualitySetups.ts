/**
 * High-Quality Setups snapshot — the "best of the desk" feed consumed by
 * external Vercel projects (addon-products-home /v2/).
 *
 * Pulls every actionable snapshot on disk, keeps only ELITE + STRONG tier
 * signals (score ≥ 60 · confluence ≥ 3 lenses · conviction ≥ 85 where
 * applicable), dedupes by symbol keeping the strongest, then splits by
 * F&O eligibility (Angel ScripMaster NFO list is the source of truth).
 *
 *   Output → server/data/public-snapshots/high-quality-setups.json
 *   Consumed by → addon-products-home/v2 via raw.githubusercontent.com
 *
 * Publish cadence: piggybacks on the intraday-tick cron (every 5 min
 * during 09:15-15:30 IST Mon-Fri) via the existing pushSnapshotsToGitHub
 * cascade. No separate infra, no Vercel functions, no cost.
 */

import fs from 'fs'
import path from 'path'
import * as angel from '../data/angel'
import { isEtfSymbol } from '../util/etfDetect'
import { log } from '../util/logger'

type Segment = 'FNO' | 'CASH' | 'ETF'

export interface UnifiedSetup {
  symbol: string
  segment: Segment           // FNO if the symbol has active NFO listing
  side: 'LONG' | 'SHORT'
  source: string             // which engine produced this signal
  tier: 'ELITE' | 'STRONG'
  stars: 5 | 3
  score: number              // 0-100, engine-normalised
  confluencesHit?: number
  ltp: number
  entry: number
  stopLoss: number
  target1: number
  target2: number
  target3: number
  riskPct: number
  rewardT1Pct?: number
  rrT1?: number
  rrT2?: number
  rrT3?: number
  entryDate: string
  entryTime?: string         // 20 Aug 2026 — HH:MM IST when this signal was first seen
  entrySignal?: string       // short label of the exact setup ("MTF harmonic + Ichimoku green cloud")
  lastUpdatedAt?: string     // ISO timestamp of last snapshot refresh — consumers refresh their view based on this
  target1Date?: string
  target2Date?: string
  target3Date?: string
  slDate?: string
  keyLevels?: Record<string, number | undefined>
  reasoning: string[]
  unifiedReason: string
  confluences?: Record<string, { key: string; hit: boolean; points: number; detail: string; level?: number }>
  fnoPlan?: {                // populated for FNO rows only
    direction: 'BUY_CE' | 'BUY_PE' | 'LONG_FUT' | 'SHORT_FUT'
    note: string             // human-readable option-leg guidance
  }
}

// ─── Snapshot readers ───────────────────────────────────────────────

function readSnapshot(name: string): any | null {
  try {
    const p = path.resolve(process.cwd(), 'data', 'public-snapshots', name)
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch { return null }
}

// ─── F&O eligibility ────────────────────────────────────────────────

/**
 * Pull the F&O underlying list from ScripMaster (Angel's official mapping).
 * Falls back to a hand-curated list if ScripMaster hasn't loaded.
 */
async function getFnoUniverse(): Promise<Set<string>> {
  const known = new Set<string>(FALLBACK_FNO_LEADERS)
  try {
    const sm = await angel.loadScripMaster()
    if (sm) {
      const futs = sm.filter(s => s.exch_seg === 'NFO' && s.instrumenttype === 'FUTSTK')
      for (const s of futs) if (s.name) known.add(s.name.toUpperCase())
      // Indices too
      known.add('NIFTY').add('BANKNIFTY').add('FINNIFTY').add('MIDCPNIFTY').add('SENSEX')
    }
  } catch { /* use fallback */ }
  return known
}

// ─── Signal normalisers ─────────────────────────────────────────────

/**
 * Compose the "real" human-readable reason for a row. Priority:
 *   1. reasoning[]  — bullets from the source engine
 *   2. flowNote     — smart-money one-liner (Weekly Pick / Cross-Confluence)
 *   3. shareholdingNote — FII/DII/promoter deltas
 *   4. sources[]    — engines that fired ("Weekly Pick + F&O Futures")
 *   5. sector/smartMoney bullets
 * Falls back to unifiedReason.collapsed ONLY if everything above is empty
 * (that string is just the tier + engine label — useless as a "reason").
 */
function composeReason(row: any): { reasoning: string[]; unifiedReason: string } {
  const bullets: string[] = []
  if (Array.isArray(row.reasoning) && row.reasoning.length > 0) {
    for (const r of row.reasoning) if (typeof r === 'string' && r.trim()) bullets.push(r.trim())
  }
  if (typeof row.flowNote === 'string' && row.flowNote.trim()) bullets.push(row.flowNote.trim())
  if (typeof row.shareholdingNote === 'string' && row.shareholdingNote.trim()) bullets.push(row.shareholdingNote.trim())
  if (typeof row.sectorLabel === 'string' && row.sectorLabel.trim() && !bullets.some(b => b.includes(row.sectorLabel))) {
    const dir = typeof row.sectorTrend === 'string' ? ` ${row.sectorTrend}` : ''
    bullets.push(`Sector: ${row.sectorLabel}${dir}`)
  }
  if (typeof row.smartMoneySide === 'string' && row.smartMoneySide && row.smartMoneySide !== 'neutral' &&
      !bullets.some(b => b.toLowerCase().includes('smart'))) {
    bullets.push(`Smart-money: ${row.smartMoneySide}`)
  }
  if (row.noBrainerBet && !bullets.some(b => b.includes('NO-BRAINER'))) {
    bullets.push('⭐ NO-BRAINER (FII↑ + promoter stable + pledge<5%)')
  }
  if (typeof row.bucket === 'string' && row.bucket && !bullets.some(b => b.includes(row.bucket))) {
    bullets.push(`Bucket: ${row.bucket}`)
  }
  if (Array.isArray(row.sources) && row.sources.length > 0 && !bullets.some(b => b.toLowerCase().includes('confluence'))) {
    bullets.push(`Engines: ${row.sources.join(' + ')}`)
  }
  // Dedupe similar bullets
  const seen = new Set<string>()
  const clean = bullets.filter(b => {
    const key = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 40)
    if (seen.has(key)) return false
    seen.add(key); return true
  })
  // Last-resort fallback to unifiedReason.collapsed / expanded
  if (clean.length === 0) {
    if (typeof row.unifiedReason === 'string' && row.unifiedReason.trim()) clean.push(row.unifiedReason.trim())
    else if (row.unifiedReason?.expanded) clean.push(String(row.unifiedReason.expanded).replace(/[\n]+/g, ' · ').trim())
    else if (row.unifiedReason?.collapsed) clean.push(String(row.unifiedReason.collapsed).trim())
  }
  return { reasoning: clean, unifiedReason: clean.join(' · ') }
}

function fromVpFib(row: any): UnifiedSetup | null {
  if (!row || !row.symbol || !row.entry) return null
  if (row.tier !== 'ELITE' && row.tier !== 'STRONG') return null
  const { reasoning, unifiedReason } = composeReason(row)
  return {
    symbol: String(row.symbol).toUpperCase(),
    segment: 'CASH',        // reassigned later after F&O eligibility check
    side: row.side === 'SHORT' ? 'SHORT' : 'LONG',
    source: 'VP+FIB',
    tier: row.tier,
    stars: row.tier === 'ELITE' ? 5 : 3,
    score: row.confluenceScore ?? 0,
    confluencesHit: row.confluencesHit,
    ltp: row.ltp, entry: row.entry, stopLoss: row.stopLoss,
    target1: row.target1, target2: row.target2, target3: row.target3,
    riskPct: row.riskPct, rewardT1Pct: row.rewardT1Pct,
    rrT1: row.rrT1, rrT2: row.rrT2, rrT3: row.rrT3,
    entryDate: row.entryDate, target1Date: row.target1Date, target2Date: row.target2Date, target3Date: row.target3Date, slDate: row.slDate,
    keyLevels: row.keyLevels,
    reasoning,
    unifiedReason,
    confluences: row.confluences,
  }
}

function fromProEdge(row: any): UnifiedSetup | null {
  if (!row || !row.symbol || !row.entry) return null
  const conv = row.conviction ?? row.score ?? 0
  if (conv < 80) return null
  const tier: 'ELITE' | 'STRONG' = conv >= 90 ? 'ELITE' : 'STRONG'
  const dir = String(row.direction ?? 'BUY').toUpperCase()
  return {
    symbol: String(row.symbol).toUpperCase(),
    segment: 'CASH',
    side: dir === 'SHORT' || dir === 'SELL' ? 'SHORT' : 'LONG',
    source: 'PRO-EDGE',
    tier, stars: tier === 'ELITE' ? 5 : 3,
    score: conv,
    ltp: row.ltp ?? row.entry, entry: row.entry, stopLoss: row.stopLoss,
    target1: row.target1, target2: row.target2, target3: row.target3,
    riskPct: row.entry > 0 ? Math.round(Math.abs((row.stopLoss - row.entry) / row.entry) * 10000) / 100 : 0,
    entryDate: row.entryDate ?? new Date().toISOString().slice(0, 10),
    target1Date: row.target1Date, target2Date: row.target2Date, target3Date: row.target3Date, slDate: row.slDate,
    reasoning: composeReason(row).reasoning,
    unifiedReason: composeReason(row).unifiedReason,
  }
}

function fromCrossConfluence(row: any): UnifiedSetup | null {
  if (!row || !row.symbol || !row.entry) return null
  const conv = row.compositeScore ?? row.conviction ?? row.score ?? 0
  if (conv < 80) return null
  const tier: 'ELITE' | 'STRONG' = conv >= 90 ? 'ELITE' : 'STRONG'
  const dir = String(row.direction ?? row.side ?? 'BUY').toUpperCase()
  return {
    symbol: String(row.symbol).toUpperCase(),
    segment: 'CASH',
    side: dir === 'SHORT' || dir === 'SELL' ? 'SHORT' : 'LONG',
    source: 'CROSS-CONFLUENCE',
    tier, stars: tier === 'ELITE' ? 5 : 3,
    score: conv,
    ltp: row.ltp ?? row.entry, entry: row.entry, stopLoss: row.stopLoss,
    target1: row.target1, target2: row.target2, target3: row.target3,
    riskPct: row.entry > 0 ? Math.round(Math.abs((row.stopLoss - row.entry) / row.entry) * 10000) / 100 : 0,
    entryDate: row.entryDate ?? new Date().toISOString().slice(0, 10),
    target1Date: row.target1Date, target2Date: row.target2Date, target3Date: row.target3Date, slDate: row.slDate,
    reasoning: composeReason(row).reasoning,
    unifiedReason: composeReason(row).unifiedReason,
  }
}

function fromWeeklyPick(row: any): UnifiedSetup | null {
  // Weekly Pick uses `entryPrice` (not `entry`) and `direction: LONG/SHORT`.
  if (!row || !row.symbol) return null
  const entry = row.entry ?? row.entryPrice ?? row.entryPriceLow
  if (!entry) return null
  const conv = row.conviction ?? row.score ?? 0
  if (conv < 85) return null
  const side: 'LONG' | 'SHORT' = String(row.direction ?? 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG'
  const { reasoning, unifiedReason } = composeReason(row)
  return {
    symbol: String(row.symbol).toUpperCase(),
    segment: 'CASH',
    side,
    source: 'WEEKLY-PICK',
    tier: conv >= 92 ? 'ELITE' : 'STRONG',
    stars: conv >= 92 ? 5 : 3,
    score: conv,
    ltp: row.ltp ?? entry, entry, stopLoss: row.stopLoss,
    target1: row.target1, target2: row.target2, target3: row.target3,
    riskPct: entry > 0 ? Math.round(Math.abs((row.stopLoss - entry) / entry) * 10000) / 100 : 0,
    entryDate: row.entryDate ?? new Date().toISOString().slice(0, 10),
    target1Date: row.target1Date, target2Date: row.target2Date, target3Date: row.target3Date, slDate: row.slDate,
    reasoning,
    unifiedReason,
  }
}

// ─── Dedup: strongest signal per symbol wins ────────────────────────

function dedupeBySymbol(setups: UnifiedSetup[]): UnifiedSetup[] {
  const best = new Map<string, UnifiedSetup>()
  for (const s of setups) {
    const key = s.symbol
    const prev = best.get(key)
    if (!prev || s.score > prev.score) best.set(key, s)
  }
  return Array.from(best.values())
}

// ─── F&O leg suggestion ─────────────────────────────────────────────

function suggestFnoPlan(setup: UnifiedSetup): UnifiedSetup['fnoPlan'] {
  // Simple, safe default: buy the option in the direction of the trade.
  // A proper strike/expiry mapping needs a live option-chain read; we keep
  // the guidance descriptive so retail traders can look up the ATM strike
  // on their broker without us picking an expired one.
  const dir = setup.side === 'LONG' ? 'BUY_CE' : 'BUY_PE'
  const spot = setup.entry.toFixed(0)
  const opt = dir === 'BUY_CE' ? 'CE' : 'PE'
  return {
    direction: dir,
    note: `Buy ATM ${opt} (nearest strike to spot ₹${spot}) of the CURRENT-week expiry. Cap risk at 3% of capital, exit if underlying breaks SL ₹${setup.stopLoss}.`,
  }
}

// ─── Main build ─────────────────────────────────────────────────────

export async function buildHighQualitySetups(): Promise<{
  generatedAt: string
  fno: UnifiedSetup[]
  cash: UnifiedSetup[]
  etf: UnifiedSetup[]
  totals: { fno: number; cash: number; etf: number; elite: number; strong: number }
  sources: Record<string, number>
}> {
  const raw: UnifiedSetup[] = []
  const sources: Record<string, number> = {}
  const track = (arr: UnifiedSetup[], name: string) => {
    sources[name] = arr.length
    raw.push(...arr)
  }

  // 1. VP + FIB Confluence (our newest lens — the "PRO Trader" scanner)
  const vpFib = readSnapshot('vp-fib.json')
  if (vpFib && Array.isArray(vpFib.rows)) {
    track(vpFib.rows.map(fromVpFib).filter(Boolean) as UnifiedSetup[], 'VP+FIB')
  }

  // 2. PRO Edge cascade
  const proEdge = readSnapshot('pro-edge.json')
  if (proEdge && Array.isArray(proEdge.rows)) {
    track(proEdge.rows.map(fromProEdge).filter(Boolean) as UnifiedSetup[], 'PRO-EDGE')
  }

  // 3. Cross-engine confluence
  const cross = readSnapshot('cross-confluence.json')
  if (cross && Array.isArray(cross.rows)) {
    track(cross.rows.map(fromCrossConfluence).filter(Boolean) as UnifiedSetup[], 'CROSS-CONFLUENCE')
  }

  // 4. Weekly Pick — swing/positional biassed
  const weekly = readSnapshot('weekly-pick.json')
  if (weekly && Array.isArray(weekly.rows)) {
    track(weekly.rows.map(fromWeeklyPick).filter(Boolean) as UnifiedSetup[], 'WEEKLY-PICK')
  }

  // Daily Pick (same shape as weekly)
  const daily = readSnapshot('daily-pick.json')
  if (daily && Array.isArray(daily.rows)) {
    track(daily.rows.map(fromWeeklyPick).filter(Boolean) as UnifiedSetup[], 'DAILY-PICK')
  }

  // 5. Ichimoku Cloud (20 Aug 2026) — the SILVERM +68% CE setup pattern
  const ichimoku = readSnapshot('ichimoku-cloud.json')
  if (ichimoku && Array.isArray(ichimoku.rows)) {
    const rows: UnifiedSetup[] = ichimoku.rows
      .filter((r: any) => (r.score ?? 0) >= 80)
      .map((r: any): UnifiedSetup => ({
        symbol: r.symbol,
        segment: 'CASH',        // reassigned later after F&O eligibility check
        side: r.direction === 'BUY' ? 'LONG' : 'SHORT',
        source: 'ICHIMOKU',
        tier: r.score === 100 ? 'ELITE' : 'STRONG',
        stars: r.score === 100 ? 5 : 3,
        score: r.score,
        confluencesHit: (r.signals ?? []).length,
        ltp: r.ltp,
        entry: r.entry,
        stopLoss: r.stopLoss,
        target1: r.target1,
        target2: r.target2,
        target3: r.target3,
        riskPct: Math.abs((r.entry - r.stopLoss) / r.entry) * 100,
        rewardT1Pct: Math.abs((r.target1 - r.entry) / r.entry) * 100,
        rrT1: r.rrT1,
        entryDate: r.entryDate,
        target1Date: r.target1Date,
        target2Date: r.target2Date,
        target3Date: r.target3Date,
        reasoning: r.reasoning ?? [],
        unifiedReason: `Ichimoku ${r.direction} · ${r.signals?.length ?? 0}/5 signals · ${r.timeframe} · ${r.optionsHint ?? ''}`.trim(),
        entrySignal: `Ichimoku ${r.timeframe} ${r.direction} · Kumo ${r.cloudColour} · price ${r.priceVsCloud}`,
      }))
    track(rows, 'ICHIMOKU')
  }

  // Split ETFs into their own bucket BEFORE dedup — ETFs are structurally
  // different (basket products, no earnings, long-term horizon) and
  // shouldn't compete with individual stocks for the "strongest signal"
  // slot. They render as a separate tab in addon-products-home /v2/.
  const etfRaw = raw.filter(s => isEtfSymbol(s.symbol))
  const stockRaw = raw.filter(s => !isEtfSymbol(s.symbol))

  // Most upstream engines drop ETFs from their universe, so etfRaw is
  // usually thin (0-5 rows). Run a dedicated VP+FIB pass on the ETF-only
  // universe to give the ETF tab real coverage. Small universe (~200
  // symbols), ~30-60s runtime, worth the wait for a proper feed.
  try {
    const { scanVpFibConfluence } = await import('./vpFibScanner')
    const etfScan = await scanVpFibConfluence({
      universe: 'MARKET_ALL',
      onlyEtfs: true,
      concurrency: 15,
      maxRuntimeMs: 60_000,
    })
    for (const row of etfScan.rows) {
      const setup = fromVpFib(row)
      if (setup) etfRaw.push(setup)
    }
    sources['VP+FIB-ETF'] = etfScan.rows.length
    log.info('HQS', `ETF-only scan: ${etfScan.rows.length} setups from ${etfScan.attempted} ETFs`)
  } catch (e) {
    log.warn('HQS', `ETF-only scan failed: ${(e as Error).message}`)
  }

  log.info('HQS', `split · ${stockRaw.length} stocks · ${etfRaw.length} ETFs`)

  // Dedupe — same symbol from multiple engines → keep the strongest
  const unique = dedupeBySymbol(stockRaw)
  const uniqueEtfs = dedupeBySymbol(etfRaw)

  // Enrich: even after dedup, look up the same symbol in EVERY source snapshot
  // and merge their reasoning bullets. A PRO-Edge row winning by conviction
  // might have a generic reason ("Confluence: WEEKLY + FNO_FUTURES"), but the
  // Cross-Confluence snapshot for the same symbol has "EMA stack + At 20d high
  // + Tight coil + Vol expansion" — pull those in.
  const enrichPool: Array<{ name: string; snap: any }> = [
    { name: 'cross-confluence', snap: cross },
    { name: 'vp-fib', snap: vpFib },
    { name: 'pro-edge', snap: proEdge },
    { name: 'weekly-pick', snap: weekly },
    { name: 'daily-pick', snap: daily },
  ]
  for (const setup of unique) {
    const extraBullets: string[] = []
    for (const { snap } of enrichPool) {
      const rows = snap && Array.isArray(snap.rows) ? snap.rows : []
      const match = rows.find((r: any) => String(r?.symbol || '').toUpperCase() === setup.symbol)
      if (!match) continue
      const composed = composeReason(match)
      for (const b of composed.reasoning) {
        if (!setup.reasoning.some(existing => existing.toLowerCase().slice(0, 30) === b.toLowerCase().slice(0, 30))) {
          extraBullets.push(b)
        }
      }
    }
    if (extraBullets.length > 0) {
      setup.reasoning = [...setup.reasoning, ...extraBullets].slice(0, 8)   // cap at 8 bullets
      setup.unifiedReason = setup.reasoning.join(' · ')
    }
  }

  // Classify each stock row by F&O eligibility
  const fnoUniverse = await getFnoUniverse()
  for (const s of unique) {
    if (fnoUniverse.has(s.symbol)) {
      s.segment = 'FNO'
      s.fnoPlan = suggestFnoPlan(s)
    } else {
      s.segment = 'CASH'
    }
  }
  for (const s of uniqueEtfs) {
    s.segment = 'ETF'
    // ETFs are long-term instruments — SIP / accumulate at value-area low,
    // not a same-week option leg. Add a plain-language horizon note.
    ;(s as any).horizonNote = 'Long-term horizon · SIP monthly or accumulate on VAL touch. Not for same-week trades.'
  }

  const fno = unique.filter(s => s.segment === 'FNO').sort((a, b) => b.score - a.score)
  const cash = unique.filter(s => s.segment === 'CASH').sort((a, b) => b.score - a.score)
  const etf = uniqueEtfs.sort((a, b) => b.score - a.score)

  // Cap Cash tab at top 100, ETF at top 40 (ETF universe is small anyway).
  const cashCapped = cash.slice(0, 100)
  const etfCapped = etf.slice(0, 40)

  const totals = {
    fno: fno.length,
    cash: cashCapped.length,
    etf: etfCapped.length,
    elite: [...unique, ...uniqueEtfs].filter(s => s.tier === 'ELITE').length,
    strong: [...unique, ...uniqueEtfs].filter(s => s.tier === 'STRONG').length,
  }

  log.info('HQS', `built · FNO ${totals.fno} · CASH ${totals.cash} · ETF ${totals.etf} · elite ${totals.elite} · strong ${totals.strong} · sources ${JSON.stringify(sources)}`)

  return {
    generatedAt: new Date().toISOString(),
    fno,
    cash: cashCapped,
    etf: etfCapped,
    totals,
    sources,
  }
}

export async function writeHighQualitySetups(): Promise<void> {
  const out = await buildHighQualitySetups()
  // ─── Pattern-memory bonus (3 Aug 2026) ────────────────────────────
  // For each candidate, fingerprint-match against winning-patterns +
  // losing-patterns memory. Winner match → +5 conviction + 🧠 tag.
  // Loser match → −10 conviction + ⚠ tag. Symmetric reinforcement so
  // the system learns from both wins and losses.
  try {
    const { matchesKnownWinner, matchesKnownLoser } = await import('./patternMemory')
    const dataMod = await import('../data')
    const enrich = async (rows: any[]) => {
      let hits = 0, misses = 0
      const CONC = 8
      let cursor = 0
      await Promise.all(Array.from({ length: CONC }, async () => {
        while (cursor < rows.length) {
          const r = rows[cursor++]
          try {
            const dir = String(r.direction ?? r.side ?? 'BUY').toUpperCase() === 'SHORT' ? 'SHORT' : 'BUY'
            const cs = await dataMod.getCandles(r.symbol, '1D' as any, 60).catch(() => null)
            if (!cs || cs.length < 30) continue
            const w = await matchesKnownWinner({ candles: cs, direction: dir as 'BUY' | 'SHORT' })
            const l = await matchesKnownLoser({ candles: cs, direction: dir as 'BUY' | 'SHORT' })
            if (w?.match) {
              r.conviction = Math.min(100, (r.conviction ?? r.score ?? 60) + 5)
              r.patternMatchWinner = w.winnerSymbol
              r.patternTag = '🧠 winner-match'
              hits++
            }
            if (l?.match) {
              r.conviction = Math.max(0, (r.conviction ?? r.score ?? 60) - 10)
              r.patternMatchLoser = l.loserSymbol
              r.patternTag = (r.patternTag ?? '') + ' ⚠ loser-match'
              misses++
            }
          } catch { /* skip on error */ }
        }
      }))
      return { hits, misses }
    }
    const fnoStats = await enrich(out.fno)
    const cashStats = await enrich(out.cash)
    log.info('HQS', `pattern-memory: FNO ${fnoStats.hits}🧠 ${fnoStats.misses}⚠ · CASH ${cashStats.hits}🧠 ${cashStats.misses}⚠`)
  } catch (e) {
    log.warn('HQS', `pattern-memory enrich failed: ${(e as Error).message}`)
  }
  // 20 Aug 2026 — stamp entryTime + lastUpdatedAt on EVERY row for the
  // /v2 platform per user directive. Also add top-level updateCadence so
  // consumers know how often to poll.
  const nowIso = new Date().toISOString()
  const istTime = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(11, 16)  // HH:MM IST
  const stampRow = (r: UnifiedSetup) => {
    r.lastUpdatedAt = nowIso
    if (!r.entryTime) r.entryTime = istTime
    if (!r.entrySignal) {
      // Fallback entrySignal label composed from source + tier + top-1 reason
      const topReason = (r.reasoning ?? [])[0] ?? r.unifiedReason ?? ''
      r.entrySignal = `${r.source} ${r.tier} · ${topReason}`.slice(0, 140)
    }
    return r
  }
  out.fno = out.fno.map(stampRow)
  out.cash = out.cash.map(stampRow)
  out.etf = out.etf.map(stampRow)
  const enriched = {
    ...out,
    lastUpdatedAt: nowIso,
    updateCadence: '5min-intraday · 1x-eod',
    fieldsExplained: {
      entryDate: 'ISO YYYY-MM-DD when signal first fired',
      entryTime: 'HH:MM IST when this snapshot regenerated (constant refresh)',
      entrySignal: 'Human-readable label of the exact setup that triggered',
      lastUpdatedAt: 'ISO timestamp of last snapshot refresh — consumers refresh their view based on this',
      target1Date: 'Expected T1 hit-by date',
      unifiedReason: 'Multi-line rationale',
    },
  }
  const p = path.resolve(process.cwd(), 'data', 'public-snapshots', 'high-quality-setups.json')
  fs.writeFileSync(p, JSON.stringify(enriched, null, 2), 'utf-8')
  log.info('HQS', `wrote ${p} · ${enriched.fno.length} FNO · ${enriched.cash.length} CASH · lastUpdatedAt=${nowIso.slice(11,19)}`)
}

// ─── Fallback F&O list (used only if ScripMaster hasn't loaded yet) ─

const FALLBACK_FNO_LEADERS = [
  'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','SBIN','AXISBANK','ITC','LT','BHARTIARTL',
  'BAJFINANCE','KOTAKBANK','MARUTI','ASIANPAINT','TATAMOTORS','TATASTEEL','ONGC','HCLTECH','WIPRO','ULTRACEMCO',
  'NTPC','POWERGRID','ADANIENT','ADANIPORTS','BAJAJFINSV','JSWSTEEL','HINDUNILVR','NESTLEIND','COALINDIA','INDUSINDBK',
  'SUNPHARMA','EICHERMOT','HEROMOTOCO','BRITANNIA','DRREDDY','GRASIM','TITAN','DIVISLAB','BPCL','CIPLA',
  'TECHM','HDFCLIFE','SBILIFE','ADANIGREEN','TATAPOWER','HAL','BEL','CANBK','BANKBARODA','JIOFIN',
  'MOTHERSON','TRENT','APOLLOHOSP','PIDILITIND','GODREJCP','BAJAJ-AUTO','DABUR','MARICO','HAVELLS','SHREECEM',
]
