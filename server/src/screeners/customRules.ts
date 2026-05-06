import fs from 'fs/promises'
import path from 'path'
import type { Candle } from '../types'
import {
  adx, emaStack, lastATR, lastRSI, lastSuperTrend, macd, obv, sma, volumeSpike,
} from '../indicators'
import { analyzeSMC } from '../patterns/smc'
import type { Screener, ScreenerResult } from './types'
import { log } from '../util/logger'

/**
 * User-defined rules — added via Telegram /addcriteria. Stored in JSON, loaded
 * into memory on startup, evaluated at scan time.
 *
 * DSL (safe key=value, no eval):
 *   name=<short id>
 *   direction=bull|bear
 *   rsi_min=N, rsi_max=N         (RSI 14)
 *   ema_aligned=bull|bear|any
 *   above_ema=20|50|200
 *   below_ema=20|50|200
 *   volume_ratio=N               (last bar / 20-day avg)
 *   macd=bull|bear|any           (histogram sign)
 *   adx_min=N                    (trend strength)
 *   price_min=N, price_max=N
 *   change_min=N, change_max=N   (last-bar % change)
 *   smc=bull|bear|any
 *   supertrend=up|down|any
 *   obv_trend_30d=up|down|any    (OBV slope)
 *   breakout_days=N              (close > prior N-day high)
 *   breakdown_days=N             (close < prior N-day low)
 *   timeframe=1-3_days|2-4_weeks|6-24_months (display only)
 *   target_pct=N                 (suggested target in percent)
 *   sl_atr=N                     (SL distance in ATRs, default 1.5)
 *
 * All listed keys must match (AND logic) for the rule to fire.
 */

export interface CustomRule {
  name: string
  direction: 'bull' | 'bear' | 'neutral'
  criteria: Record<string, string | number>
  createdAt: number
  createdBy?: string
  enabled: boolean
}

const DATA_DIR = path.resolve(__dirname, '../../data')
const RULES_PATH = path.join(DATA_DIR, 'rules.json')

let rules: CustomRule[] = []

export async function loadRules(): Promise<CustomRule[]> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const raw = await fs.readFile(RULES_PATH, 'utf8').catch(() => '[]')
    rules = JSON.parse(raw) as CustomRule[]
    log.ok('RULES', `Loaded ${rules.length} custom rules`)
  } catch (e) {
    log.warn('RULES', `Failed to load rules: ${(e as Error).message}`)
    rules = []
  }
  return rules
}

export async function saveRules(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(RULES_PATH, JSON.stringify(rules, null, 2), 'utf8')
}

export function listRules(): CustomRule[] { return rules }

export async function addRule(input: string, createdBy?: string): Promise<CustomRule> {
  const criteria: Record<string, string | number> = {}
  let name = ''
  let direction: 'bull' | 'bear' | 'neutral' = 'bull'

  // Parse key=value tokens separated by whitespace or commas
  const tokens = input.trim().split(/[,\s]+/).filter(Boolean)
  for (const tok of tokens) {
    const [k, v] = tok.split('=').map(s => s.trim())
    if (!k || v == null) continue
    const key = k.toLowerCase()
    if (key === 'name') { name = v; continue }
    if (key === 'direction') {
      direction = (v.toLowerCase() as any) === 'bear' ? 'bear' : (v.toLowerCase() as any) === 'neutral' ? 'neutral' : 'bull'
      continue
    }
    // Accept numeric when possible, else string
    const num = Number(v)
    criteria[key] = Number.isFinite(num) && v !== '' ? num : v
  }
  if (!name) name = `rule_${rules.length + 1}_${Date.now().toString(36).slice(-4)}`

  const rule: CustomRule = {
    name,
    direction,
    criteria,
    createdAt: Date.now(),
    createdBy,
    enabled: true,
  }
  // Upsert by name
  rules = rules.filter(r => r.name !== name)
  rules.push(rule)
  await saveRules()
  return rule
}

export async function removeRule(name: string): Promise<boolean> {
  const before = rules.length
  rules = rules.filter(r => r.name !== name)
  if (rules.length !== before) {
    await saveRules()
    return true
  }
  return false
}

export async function toggleRule(name: string): Promise<boolean> {
  const r = rules.find(x => x.name === name)
  if (!r) return false
  r.enabled = !r.enabled
  await saveRules()
  return r.enabled
}

/** Run all enabled custom rules against candles and return any that match. */
export function evaluateRules(candles: Candle[], symbol: string): ScreenerResult[] {
  if (!rules.length || candles.length < 60) return []
  const results: ScreenerResult[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    try {
      const r = evaluate(rule, candles, symbol)
      if (r) results.push(r)
    } catch (e) {
      log.warn('RULES', `eval ${rule.name} on ${symbol} failed: ${(e as Error).message}`)
    }
  }
  return results
}

function evaluate(rule: CustomRule, candles: Candle[], symbol: string): ScreenerResult | null {
  const latest = candles[candles.length - 1]
  const prior = candles[candles.length - 2]
  const rsi = lastRSI(candles, 14) ?? 50
  const stack = emaStack(candles)
  const atr = lastATR(candles, 14) ?? latest.close * 0.02
  const m = macd(candles)
  const a = adx(candles, 14)
  const st = lastSuperTrend(candles, 10, 3)
  const smc = analyzeSMC(candles)
  const obvSeries = obv(candles).slice(-30)
  const obvSlope = obvSeries.length > 1 ? (obvSeries[obvSeries.length - 1] - obvSeries[0]) : 0
  const volAvg20 = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20
  const volRatio = volAvg20 > 0 ? latest.volume / volAvg20 : 0
  const changePct = prior ? ((latest.close - prior.close) / prior.close) * 100 : 0

  const c = rule.criteria
  const passes: string[] = []
  const fails: string[] = []

  const check = (cond: boolean, label: string): boolean => {
    (cond ? passes : fails).push(label)
    return cond
  }

  // RSI
  if (c.rsi_min != null && !check(rsi >= Number(c.rsi_min), `RSI≥${c.rsi_min}`)) return null
  if (c.rsi_max != null && !check(rsi <= Number(c.rsi_max), `RSI≤${c.rsi_max}`)) return null

  // EMA alignment
  if (c.ema_aligned === 'bull' && !check(stack.alignedBull, 'EMA stack bull')) return null
  if (c.ema_aligned === 'bear' && !check(stack.alignedBear, 'EMA stack bear')) return null
  if (c.above_ema) {
    const emaVal = Number(c.above_ema) === 20 ? stack.ema21 : Number(c.above_ema) === 50 ? stack.ema50 : stack.ema200
    if (!check(!!emaVal && latest.close > emaVal, `price > EMA${c.above_ema}`)) return null
  }
  if (c.below_ema) {
    const emaVal = Number(c.below_ema) === 20 ? stack.ema21 : Number(c.below_ema) === 50 ? stack.ema50 : stack.ema200
    if (!check(!!emaVal && latest.close < emaVal, `price < EMA${c.below_ema}`)) return null
  }

  // Volume
  if (c.volume_ratio != null && !check(volRatio >= Number(c.volume_ratio), `volume ≥ ${c.volume_ratio}× avg`)) return null

  // MACD
  if (c.macd === 'bull' && !check(!!m && m.histogram > 0, 'MACD hist > 0')) return null
  if (c.macd === 'bear' && !check(!!m && m.histogram < 0, 'MACD hist < 0')) return null

  // ADX
  if (c.adx_min != null && !check(!!a && a.adx >= Number(c.adx_min), `ADX ≥ ${c.adx_min}`)) return null

  // Price band
  if (c.price_min != null && !check(latest.close >= Number(c.price_min), `price ≥ ${c.price_min}`)) return null
  if (c.price_max != null && !check(latest.close <= Number(c.price_max), `price ≤ ${c.price_max}`)) return null

  // Change
  if (c.change_min != null && !check(changePct >= Number(c.change_min), `Δ% ≥ ${c.change_min}`)) return null
  if (c.change_max != null && !check(changePct <= Number(c.change_max), `Δ% ≤ ${c.change_max}`)) return null

  // SMC
  if (c.smc === 'bull' && !check(smc.bias === 'BULLISH' || smc.bosBull || smc.chochBull, 'SMC bullish')) return null
  if (c.smc === 'bear' && !check(smc.bias === 'BEARISH' || smc.bosBear || smc.chochBear, 'SMC bearish')) return null

  // SuperTrend
  if (c.supertrend === 'up' && !check(!!st && st.trend === 'UP', 'SuperTrend UP')) return null
  if (c.supertrend === 'down' && !check(!!st && st.trend === 'DOWN', 'SuperTrend DOWN')) return null

  // OBV trend
  if (c.obv_trend_30d === 'up' && !check(obvSlope > 0, 'OBV rising 30d')) return null
  if (c.obv_trend_30d === 'down' && !check(obvSlope < 0, 'OBV falling 30d')) return null

  // Breakout / breakdown
  if (c.breakout_days != null) {
    const N = Number(c.breakout_days)
    const priorHigh = Math.max(...candles.slice(-N - 1, -1).map(x => x.high))
    if (!check(latest.close > priorHigh, `close > ${N}-day high`)) return null
  }
  if (c.breakdown_days != null) {
    const N = Number(c.breakdown_days)
    const priorLow = Math.min(...candles.slice(-N - 1, -1).map(x => x.low))
    if (!check(latest.close < priorLow, `close < ${N}-day low`)) return null
  }

  // Everything matched — build result
  const targetPct = Number(c.target_pct ?? (rule.direction === 'bear' ? -8 : 8))
  const slAtr = Number(c.sl_atr ?? 1.5)
  const dirStr: ScreenerResult['direction'] = rule.direction === 'bear' ? 'BEAR' : rule.direction === 'neutral' ? 'NEUTRAL' : 'BULL'
  const score = Math.min(10, 5 + passes.length * 0.8)

  return {
    symbol,
    price: latest.close,
    change: +(latest.close - (prior?.close ?? latest.close)).toFixed(2),
    changePct: +changePct.toFixed(2),
    score: +score.toFixed(2),
    tier: score >= 8 ? 'A' : score >= 6 ? 'B' : 'C',
    direction: dirStr,
    reasons: [`Custom rule: ${rule.name}`, ...passes.map(p => `✓ ${p}`)],
    tags: passes.slice(0, 5),
    expectedMovePct: targetPct,
    timeframeLabel: (c.timeframe as string) ?? '1-3 weeks',
    suggestedEntry: latest.close,
    suggestedSL: +(dirStr === 'BULL' ? latest.close - atr * slAtr : latest.close + atr * slAtr).toFixed(2),
    suggestedTarget: +(latest.close * (1 + targetPct / 100)).toFixed(2),
    detectedAt: Date.now(),
    setupKind: 'MOMENTUM',
  }
}

/**
 * Wrap the custom evaluator as a pseudo-Screener so it can plug into the
 * existing runner pipeline alongside built-in screeners.
 */
export const customRulesScreener: Screener = {
  id: 'custom_rules',
  name: 'Custom rules (user-defined)',
  description: 'User-defined criteria via /addcriteria',
  timeframeLabel: 'varies',
  setupKind: 'MOMENTUM',
  scan(candles: Candle[], symbol: string): ScreenerResult | null {
    const results = evaluateRules(candles, symbol)
    // Runner handles one result per scan call — return highest-score match
    if (!results.length) return null
    return results.sort((a, b) => b.score - a.score)[0]
  },
}
