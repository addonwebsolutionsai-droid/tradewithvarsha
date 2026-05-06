# GANN.md
> W.D. Gann analysis engine — time cycles, angles, Square of 9.
> Claude agent updates this when new cycle data is available.

---

## Gann Principles Used

```typescript
export const GANN_PRINCIPLES = {
  // 1. Time and Price Square
  squareOfNine: 'Price and time vibrate from same mathematical root',
  
  // 2. Key Angles (price per time unit)
  angles: {
    '1x8': 82.5,   // degrees — fastest
    '1x4': 75,
    '1x3': 71.25,
    '1x2': 63.75,
    '1x1': 45,     // Most important — balance of time and price
    '2x1': 26.25,
    '3x1': 18.75,
    '4x1': 15,
    '8x1': 7.5,    // Slowest
  },
  
  // 3. Key time cycles
  timeCycles: {
    shortTerm: [7, 14, 21, 28],        // Weekly cycles (calendar days)
    mediumTerm: [30, 60, 90, 120, 144], // Quarterly cycles
    longTerm: [180, 270, 360, 720],    // Annual and multi-year
    master: [1440, 2880],              // 4-year and 8-year
  },
  
  // 4. Price levels (Square of 9 from ATH/ATL)
  keyLevels: 'Generated from Square of 9 calculator',
};
```

---

## Square of 9 Calculator

```typescript
// Calculate Gann Square of 9 support/resistance levels
export function gannSquareOf9(price: number): GannLevels {
  const sqrt = Math.sqrt(price);
  const levels: number[] = [];
  
  // Generate 8 cardinal/diagonal points
  const angles = [0, 45, 90, 135, 180, 225, 270, 315, 360];
  
  for (const angle of angles) {
    const radians = (angle * Math.PI) / 180;
    
    // Up levels
    for (let i = 1; i <= 4; i++) {
      const upLevel = Math.pow(sqrt + i * Math.cos(radians) * 0.5, 2);
      levels.push(Math.round(upLevel));
    }
    
    // Down levels
    for (let i = 1; i <= 4; i++) {
      const downLevel = Math.pow(sqrt - i * Math.cos(radians) * 0.5, 2);
      if (downLevel > 0) levels.push(Math.round(downLevel));
    }
  }
  
  return {
    price,
    levels: [...new Set(levels)].sort((a, b) => a - b),
    nearest: findNearestLevels(price, levels, 3),
    nextResistance: levels.filter(l => l > price)[0],
    nextSupport: levels.filter(l => l < price).slice(-1)[0],
  };
}
```

---

## Gann Time Cycle Engine

```typescript
export function calculateGannTimeCycles(
  lastMajorHigh: Date,
  lastMajorLow: Date,
  currentDate: Date = new Date()
): GannTimeCycleResult {
  
  const cyclesFromHigh = GANN_PRINCIPLES.timeCycles;
  const keyDates: KeyDate[] = [];
  
  // Calculate cycle dates from last major high
  for (const [period, days] of Object.entries({
    '7d': 7, '14d': 14, '21d': 21, '28d': 28,
    '30d': 30, '60d': 60, '90d': 90, '120d': 120,
    '144d': 144, '180d': 180, '270d': 270, '360d': 360,
  })) {
    const dateFromHigh = addDays(lastMajorHigh, days);
    const dateFromLow = addDays(lastMajorLow, days);
    
    const daysToHigh = differenceInDays(dateFromHigh, currentDate);
    const daysToLow = differenceInDays(dateFromLow, currentDate);
    
    if (Math.abs(daysToHigh) <= 5) {
      keyDates.push({
        date: dateFromHigh,
        source: 'FROM_HIGH',
        cycle: period,
        daysAway: daysToHigh,
        type: 'POTENTIAL_REVERSAL',
        importance: days >= 90 ? 'HIGH' : 'MEDIUM',
      });
    }
    
    if (Math.abs(daysToLow) <= 5) {
      keyDates.push({
        date: dateFromLow,
        source: 'FROM_LOW',
        cycle: period,
        daysAway: daysToLow,
        type: 'POTENTIAL_REVERSAL',
        importance: days >= 90 ? 'HIGH' : 'MEDIUM',
      });
    }
  }
  
  return {
    keyDates: keyDates.sort((a, b) => Math.abs(a.daysAway) - Math.abs(b.daysAway)),
    nextMajorDate: keyDates.find(d => d.importance === 'HIGH' && d.daysAway >= 0),
    currentCyclePhase: determineCyclePhase(currentDate, lastMajorHigh, lastMajorLow),
  };
}
```

---

## Nifty 50 Key Gann Levels (Updated Manually / By Agent)

```yaml
# As of April 2026
nifty_major_high: 24000  # Update with actual
nifty_major_low: 19000   # Update with actual
nifty_atl: 5118          # All time low (2009)
nifty_ath: 26277         # All time high (update)

# Gann Square of 9 key levels (auto-calculated)
# Agent updates these weekly
gann_levels_nifty:
  resistance: [22100, 22850, 23600, 24500, 25400]
  support:    [21200, 20500, 19800, 19000, 18100]

# Key Gann dates this quarter (agent updates)
gann_key_dates_q2_2026:
  - date: "2026-04-15"
    type: "90-day cycle from Jan low"
    importance: HIGH
  - date: "2026-04-21"  
    type: "180-day cycle from Oct high"
    importance: HIGH
  - date: "2026-05-06"
    type: "30-day from last swing"
    importance: MEDIUM
```

---

## Gann Angles for Nifty (1x1 = 1 point per trading day)

```typescript
// Gann angle lines from last swing low
export function calculateGannAngles(
  swingLow: number,
  swingLowDate: Date,
  targetDate: Date
): GannAngleLevels {
  const tradingDays = getNetTradingDays(swingLowDate, targetDate);
  
  return {
    angle_1x8: swingLow + tradingDays * 8,   // Very steep
    angle_1x4: swingLow + tradingDays * 4,
    angle_1x2: swingLow + tradingDays * 2,
    angle_1x1: swingLow + tradingDays * 1,   // 45 degrees = key support
    angle_2x1: swingLow + tradingDays * 0.5,
    angle_4x1: swingLow + tradingDays * 0.25,
    angle_8x1: swingLow + tradingDays * 0.125,
  };
}
```

---

## Trading Rules Based on Gann

```typescript
export const GANN_TRADING_RULES = {
  // Rule 1: Buy near 1x1 angle (strongest support)
  rule1: 'Price testing 1x1 from major low = strong buy',
  
  // Rule 2: Cycle date confluence
  rule2: 'If Gann date + price at key level = highest probability trade',
  
  // Rule 3: Time counts
  rule3: 'Count 7, 14, 21, 30 days from every significant high/low',
  
  // Rule 4: Breaking angle = trend change
  rule4: 'If price breaks 1x1 from major top, next support = 2x1',
  
  // Rule 5: 90-day, 180-day most important
  rule5: 'Major reversals happen at 90 and 180 day counts most often',
};
```

> Claude agent: update `gann_key_dates_q2_2026` every month with new calculations.
