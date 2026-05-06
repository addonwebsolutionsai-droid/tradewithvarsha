import type { GannBias } from '../types'
import { nearestGannLevels, priceAtGannLevel, squareOf9Levels } from './squareOf9'
import { projectCycles, seedsFor } from './timeCycles'

export { squareOf9Levels, nearestGannLevels, priceAtGannLevel } from './squareOf9'
export { projectCycles, seedsFor, GANN_CYCLES_DAYS, NIFTY_SEEDS, BANKNIFTY_SEEDS, GOLD_SEEDS, CRUDE_SEEDS } from './timeCycles'

/** Produce a single GannBias for the signal engine. */
export function gannBiasFor(symbol: string, price: number, today: Date = new Date()): GannBias {
  const seeds = seedsFor(symbol)
  // Seed the Square of 9 from the most recent HIGH-importance low
  const seedSwing = seeds
    .filter(s => s.importance === 'HIGH')
    .sort((a, b) => b.date.getTime() - a.date.getTime())[0]
  const sqSeed = seedSwing ? estimateSeedPrice(symbol, seedSwing.kind) : price
  const levelHit = priceAtGannLevel(price, sqSeed, 0.4)
  const near = nearestGannLevels(price, sqSeed)
  const cycles = projectCycles(seeds, today, 60).slice(0, 6)
  const nextHigh = cycles.filter(c => c.importance === 'HIGH' && c.daysAway <= 14)
  const timeCycleHit = nextHigh.length > 0

  const notes: string[] = []
  if (levelHit) notes.push(`At Square-of-9 ${levelHit.label} (${levelHit.price.toFixed(0)})`)
  if (timeCycleHit) notes.push(`${nextHigh[0].name} in ${nextHigh[0].daysAway}d`)

  return {
    timeCycleHit,
    priceAtGannLevel: !!levelHit,
    nextCycles: cycles,
    supports: near.support.map(l => l.price),
    resistances: near.resistance.map(l => l.price),
    note: notes.join(' · ') || `Gann neutral — next key cycle ${cycles[0]?.name ?? 'n/a'}`,
  }
}

/** Rough seed price to feed Square-of-9. Real systems would wire these to DB. */
function estimateSeedPrice(symbol: string, kind: 'HIGH' | 'LOW'): number {
  const s = symbol.toUpperCase()
  if (s.includes('BANK') && s.includes('NIFTY')) return kind === 'LOW' ? 45900 : 52800
  if (s.includes('NIFTY')) return kind === 'LOW' ? 21280 : 26280
  if (s.includes('SENSEX')) return kind === 'LOW' ? 71200 : 86000
  if (s.includes('GOLD')) return kind === 'LOW' ? 60800 : 78500
  if (s.includes('CRUDE')) return kind === 'LOW' ? 5800 : 8200
  return 100
}
