/**
 * Parashari Hora — Vedic planetary-hour system.
 *
 * Each day is divided into 24 horas (12 day + 12 night), each ruled by a
 * planet in a fixed cyclical order. Classical trading bias per hora lord
 * comes from Parashar + Jataka Parijata:
 *
 *   Sun     — leadership, breakouts, government stocks · BULLISH (daytime)
 *   Moon    — liquid moves, reversals, FMCG · VOLATILE
 *   Mars    — sharp momentum, metals, defence · BULLISH (with volume)
 *   Mercury — trading, IT, telecom, volatile intraday · NEUTRAL (scalps OK)
 *   Jupiter — long-bias, banks, finance · STRONGEST BULLISH
 *   Venus   — luxury, autos, consumption · BULLISH (mild)
 *   Saturn  — slow, weighty, downturn bias · BEARISH (contrarian BEAR trades)
 *
 * Day lords (sunrise-anchored cycle — Chaldean order):
 *   Sun→Moon→Mars→Mercury→Jupiter→Venus→Saturn→Sun...
 *
 * IST market session (09:15-15:30) spans roughly horas 2-7 of the day.
 * We compute the exact hora boundaries from sunrise/sunset for Mumbai
 * (18.975°N, 72.826°E). For simplicity we approximate sunrise at 06:15 IST
 * and sunset at 18:15 IST (±30 min seasonal variance) — close enough for
 * intraday trade-bias purposes.
 */

export type HoraLord = 'Sun' | 'Moon' | 'Mars' | 'Mercury' | 'Jupiter' | 'Venus' | 'Saturn'

// Day ruler per weekday (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat)
const DAY_RULER: HoraLord[] = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn']

// Chaldean hora sequence (the 24-hora cycle starts from day ruler)
const CHALDEAN_ORDER: HoraLord[] = ['Sun', 'Venus', 'Mercury', 'Moon', 'Saturn', 'Jupiter', 'Mars']

export interface HoraReading {
  lord: HoraLord
  position: number         // 1-24
  isDayHora: boolean
  startIST: string         // HH:MM
  endIST: string
  bias: 'BULLISH' | 'BEARISH' | 'VOLATILE' | 'NEUTRAL'
  biasStrength: number     // 0-100
  note: string
}

/**
 * Compute hora sequence for a date starting from sunrise.
 * Returns 24 consecutive horas (12 day + 12 night).
 */
export function computeHoraSequence(d: Date = new Date()): HoraReading[] {
  const weekday = d.getUTCDay()
  const istSunriseMin = 6 * 60 + 15         // 06:15 IST
  const istSunsetMin  = 18 * 60 + 15        // 18:15 IST
  const dayMinutes = istSunsetMin - istSunriseMin   // 720 (12h)
  const nightMinutes = (24 * 60) - dayMinutes        // 720

  const dayHoraLen = dayMinutes / 12
  const nightHoraLen = nightMinutes / 12

  // Hora sequence starts from day ruler and cycles Chaldean
  const dayLord = DAY_RULER[weekday]
  const startIdx = CHALDEAN_ORDER.indexOf(dayLord)

  const out: HoraReading[] = []
  for (let i = 0; i < 24; i++) {
    const isDay = i < 12
    const lord = CHALDEAN_ORDER[(startIdx + i) % 7]
    let startMin: number, endMin: number
    if (isDay) {
      startMin = istSunriseMin + i * dayHoraLen
      endMin   = startMin + dayHoraLen
    } else {
      startMin = istSunsetMin + (i - 12) * nightHoraLen
      endMin   = startMin + nightHoraLen
    }
    const info = biasFor(lord, isDay)
    out.push({
      lord, position: i + 1, isDayHora: isDay,
      startIST: fmtHM(startMin), endIST: fmtHM(endMin),
      ...info,
    })
  }
  return out
}

/** Hora active for a given IST wall-clock time. */
export function horaAt(istTime: Date = new Date()): HoraReading {
  const seq = computeHoraSequence(istTime)
  const hours = (istTime.getUTCHours() + 5.5) % 24   // approximate IST conversion
  const mins = istTime.getUTCMinutes()
  const tIST = Math.floor(hours) * 60 + mins
  // Find matching hora
  for (const h of seq) {
    const [sh, sm] = h.startIST.split(':').map(Number)
    const [eh, em] = h.endIST.split(':').map(Number)
    const s = sh * 60 + sm, e = eh * 60 + em
    // Handle wrap — night horas cross midnight
    if (e >= s) {
      if (tIST >= s && tIST < e) return h
    } else {
      if (tIST >= s || tIST < e) return h
    }
  }
  return seq[0]
}

/** Horas active during the NSE cash session (09:15-15:30 IST). */
export function sessionHoras(d: Date = new Date()): HoraReading[] {
  return computeHoraSequence(d).filter(h => {
    const [sh, sm] = h.startIST.split(':').map(Number)
    const [eh, em] = h.endIST.split(':').map(Number)
    const s = sh * 60 + sm, e = eh * 60 + em
    return s < 15 * 60 + 30 && e > 9 * 60 + 15
  })
}

function biasFor(lord: HoraLord, isDay: boolean): {
  bias: HoraReading['bias']; biasStrength: number; note: string
} {
  switch (lord) {
    case 'Jupiter': return {
      bias: 'BULLISH', biasStrength: 85,
      note: 'Jupiter hora — strongest bull signal. Favour CE, banks/finance sector.',
    }
    case 'Sun': return {
      bias: 'BULLISH', biasStrength: isDay ? 75 : 55,
      note: isDay ? 'Sun day-hora — leadership/breakouts. PSU + govt stocks shine.' : 'Sun night-hora — mild bull, low priority.',
    }
    case 'Mars': return {
      bias: 'BULLISH', biasStrength: 65,
      note: 'Mars hora — sharp momentum. Metals, defence. High vol required.',
    }
    case 'Venus': return {
      bias: 'BULLISH', biasStrength: 60,
      note: 'Venus hora — luxury/consumption. Mild bullish bias.',
    }
    case 'Moon': return {
      bias: 'VOLATILE', biasStrength: 60,
      note: 'Moon hora — reversals + liquid moves. Expect whipsaws.',
    }
    case 'Mercury': return {
      bias: 'NEUTRAL', biasStrength: 50,
      note: 'Mercury hora — trading/IT. Best for scalps, not positional.',
    }
    case 'Saturn': return {
      bias: 'BEARISH', biasStrength: 75,
      note: 'Saturn hora — bearish bias. Favour PE. Contrarian CE very risky.',
    }
  }
}

function fmtHM(mins: number): string {
  const h = Math.floor(mins / 60) % 24
  const m = Math.round(mins % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// ─── Trading-bias helper ─────────────────────────────────────

/** Combined hora bias for a direction check. Returns ±strength. */
export function horaBiasFor(direction: 'BULL' | 'BEAR', at: Date = new Date()): {
  aligned: boolean; lord: HoraLord; strength: number; note: string
} {
  const h = horaAt(at)
  const wantsBull = direction === 'BULL'
  const lordBull = h.bias === 'BULLISH'
  const lordBear = h.bias === 'BEARISH'
  let aligned: boolean
  let strength = h.biasStrength
  if (h.bias === 'VOLATILE' || h.bias === 'NEUTRAL') {
    aligned = false            // no commitment either way
    strength = 0
  } else {
    aligned = wantsBull ? lordBull : lordBear
  }
  return { aligned, lord: h.lord, strength, note: h.note }
}
