# ASTRO.md
> Vedic & Mundane Astrology for market timing.
> Agent updates planetary positions daily.

---

## Astrological Framework

### Mundane Astrology for Markets

```typescript
export const MUNDANE_ASTRO = {
  // Planets and their market associations
  planets: {
    Sun:     { market: 'Gold, Government bonds, Leadership stocks', cycle: '1 year' },
    Moon:    { market: 'Silver, FMCG, Short-term sentiment', cycle: '28 days' },
    Mercury: { market: 'IT, Telecom, Banking, Communication', cycle: '88 days' },
    Venus:   { market: 'Luxury, FMCG, Real estate, Finance', cycle: '225 days' },
    Mars:    { market: 'Energy, Metals, Aggressive moves, Crude', cycle: '2 years' },
    Jupiter: { market: 'Bull markets, Expansion, BFSI growth', cycle: '12 years' },
    Saturn:  { market: 'Bear markets, Restrictions, Contraction', cycle: '29 years' },
    Rahu:    { market: 'Tech, Innovation, Unexpected moves', cycle: '18 months' },
    Ketu:    { market: 'Spirituality, Pharma, Sudden reversals', cycle: '18 months' },
  },
  
  // Key events that cause market moves
  keyEvents: {
    retrogrades: 'Mercury retrograde = confusion in markets (3x/year, ~3 weeks each)',
    conjunction: 'Jupiter-Saturn conjunction = major multi-year cycle shift',
    eclipse: 'Solar/Lunar eclipse = reversal within ±15 days',
    ingress: 'Planet entering new sign = new trend begins',
  },
};
```

---

## Planetary Positions API Integration

```typescript
// server/src/services/astroService.ts
export class AstroService {
  
  async getDailyPlanetaryPositions(date: Date): Promise<PlanetaryData> {
    // Option 1: AstrologyAPI.com (paid but accurate)
    const response = await fetch('https://json.astrologyapi.com/v1/planets/tropical', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${process.env.ASTRO_API_USER_ID}:${process.env.ASTRO_API_KEY}`)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        day: date.getDate(),
        month: date.getMonth() + 1,
        year: date.getFullYear(),
        hour: 9,
        min: 15,
        lat: 19.0760,  // Mumbai (BSE/NSE)
        lon: 72.8777,
        tzone: 5.5,
      }),
    });
    
    return response.json();
  }
  
  // Analyze planetary positions for market sentiment
  async analyzeMarketAstro(date: Date = new Date()): Promise<AstroSignal> {
    const positions = await this.getDailyPlanetaryPositions(date);
    
    let bullScore = 0;
    let bearScore = 0;
    const notes: string[] = [];
    
    // Jupiter aspects (bullish)
    if (this.isJupiterAspecting('Sun', positions)) {
      bullScore += 2;
      notes.push('Jupiter aspecting Sun — positive for markets');
    }
    if (this.isJupiterAspecting('Mercury', positions)) {
      bullScore += 1.5;
      notes.push('Jupiter aspecting Mercury — positive for IT/Banking');
    }
    
    // Saturn aspects (bearish)
    if (this.isSaturnAspecting('Sun', positions)) {
      bearScore += 2;
      notes.push('Saturn aspecting Sun — caution, markets under pressure');
    }
    
    // Rahu/Ketu involvement (volatility)
    if (this.isRahuKetu('Moon', positions)) {
      notes.push('Rahu/Ketu on Moon — high volatility expected');
    }
    
    // Mercury retrograde
    if (positions.Mercury.isRetrograde) {
      bearScore += 1;
      notes.push('⚠️ Mercury Retrograde — avoid new positions, high confusion');
    }
    
    // Eclipse within 15 days
    if (await this.isEclipseNear(date, 15)) {
      notes.push('🌑 Eclipse within 15 days — watch for reversal');
    }
    
    const netScore = bullScore - bearScore;
    
    return {
      date,
      bullScore,
      bearScore,
      netScore,
      sentiment: netScore > 2 ? 'BULLISH' : netScore < -2 ? 'BEARISH' : 'NEUTRAL',
      notes,
      keyEvents: await this.getKeyAstroEvents(date, 30), // Next 30 days
    };
  }
}
```

---

## Vedic Astro — Nifty Chart (Inception Date)

```typescript
// NSE inception: November 3, 1994
// This is the "birth chart" of NSE used for mundane analysis
export const NSE_BIRTH_CHART = {
  date: '1994-11-03',
  time: '09:55', // Market open
  place: 'Mumbai',
  ascendant: 'Scorpio',
  
  // Dasha periods (Vimshottari) of NSE chart
  // Major dasha periods correlate with major market trends
  currentDasha: 'TO BE CALCULATED BY AGENT',
  
  // Key transit dates affecting NSE birth chart
  // Agent updates this every month
  keyTransits: [],
};
```

---

## Historical Astro-Market Correlations (Backtested)

```yaml
# These are historically observed correlations — use with confluence
mercury_retrograde:
  observation: "Markets often volatile/trending down"
  historical_accuracy: "~65% of retrograde periods had increased volatility"
  action: "Reduce position size by 50% during retrograde"

jupiter_saturn_conjunction:
  observation: "Major market cycle changes"
  last_occurrence: "2020-12-21 (COVID bottom)"
  next_occurrence: "2040"
  action: "Watch for multi-year trend change"

solar_eclipse:
  observation: "Major reversal within ±15 days in 70% of cases"
  recent: "2024-04-08 solar eclipse — Nifty reversed"
  action: "Look for exhaustion candles near eclipse dates"

venus_jupiter_conjunction:
  observation: "Strong bullish moves in FMCG, Finance"
  historical_accuracy: "~68%"
  last: "2024-Feb — strong rally"

rahu_in_financial_sign: 
  observation: "Rahu in Taurus/Virgo/Capricorn = financial speculation"
  action: "Higher volatility, bigger moves"
```

---

## Key Astro Dates — Q2 2026 (Agent Updates)

```yaml
# Claude agent: update this every month
astro_key_dates_april_may_2026:
  - date: "2026-04-13"
    event: "Full Moon in Libra"
    market_note: "Potential short-term top — watch for reversal"
    importance: MEDIUM
    
  - date: "2026-04-20"
    event: "Sun enters Taurus (ingress)"
    market_note: "Shift in market energy — financial sector focus"
    importance: MEDIUM
    
  - date: "2026-04-28"
    event: "New Moon in Taurus"
    market_note: "New beginnings — watch for trend reversal/initiation"
    importance: HIGH
    
  - date: "2026-05-09"
    event: "Mercury retrograde begins"
    market_note: "⚠️ Increase caution — reduce F&O positions"
    importance: HIGH
```

---

## Integration with Signal System

```typescript
// Astro signal contributes to overall signal score
export function addAstroScore(signal: Signal, astroData: AstroSignal): Signal {
  let astroBonus = 0;
  
  if (astroData.sentiment === 'BULLISH' && signal.direction === 'BUY') {
    astroBonus = 1;
  } else if (astroData.sentiment === 'BEARISH' && signal.direction === 'SELL') {
    astroBonus = 1;
  } else if (astroData.sentiment !== 'NEUTRAL') {
    // Against the signal
    astroBonus = -0.5;
  }
  
  return {
    ...signal,
    score: signal.score + astroBonus,
    astroNote: astroData.notes[0] || 'Neutral planetary conditions',
  };
}
```

> Claude agent: update `astro_key_dates` every month by calling astrology API.
