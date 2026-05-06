/**
 * W.D. Gann's Square of 9 — price-level calculator.
 *
 * Each full rotation around the square (360°) is √price increments of 2.
 * Key angles: 45°, 90°, 180°, 270°, 360° from a pivot.
 *
 * For a seed (major swing low/high), levels at angle θ are:
 *     level(θ) = (√seed + θ/180)²       for buys (above seed)
 *     level(θ) = (√seed − θ/180)²       for sells (below seed)
 */

export interface GannLevel {
  price: number
  angle: number
  direction: 'ABOVE' | 'BELOW'
  label: string
}

export function squareOf9Levels(seed: number, maxRotations = 2): GannLevel[] {
  const sq = Math.sqrt(seed)
  const angles = [45, 90, 135, 180, 225, 270, 315, 360, 540, 720]
  const out: GannLevel[] = []
  for (const a of angles) {
    if (a > 360 * maxRotations) break
    const inc = a / 180
    out.push({
      price: Math.pow(sq + inc, 2),
      angle: a,
      direction: 'ABOVE',
      label: `+${a}°`,
    })
    const down = Math.pow(Math.max(0, sq - inc), 2)
    if (down > 0) out.push({
      price: down,
      angle: a,
      direction: 'BELOW',
      label: `-${a}°`,
    })
  }
  return out.sort((a, b) => a.price - b.price)
}

export function nearestGannLevels(price: number, seed: number): { support: GannLevel[]; resistance: GannLevel[] } {
  const all = squareOf9Levels(seed, 3)
  const resistance = all.filter(l => l.price > price).slice(0, 3)
  const support = all.filter(l => l.price < price).slice(-3).reverse()
  return { support, resistance }
}

/** Is the current price within `tolerance` percent of any Gann level? */
export function priceAtGannLevel(price: number, seed: number, tolerancePct = 0.3): GannLevel | null {
  const levels = squareOf9Levels(seed, 2)
  for (const l of levels) {
    const diff = Math.abs(price - l.price) / price * 100
    if (diff <= tolerancePct) return l
  }
  return null
}
