import { loadScripMaster } from '../data/angel'
import { log } from '../util/logger'

/**
 * Scan universes. Organized by index membership so the user can target
 * specific slices of the market.
 */

/** NIFTY 50 — mega-cap blue chips. */
export const NIFTY50 = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'HINDUNILVR', 'ITC',
  'KOTAKBANK', 'LT', 'AXISBANK', 'BHARTIARTL', 'ASIANPAINT', 'MARUTI', 'HCLTECH', 'TITAN',
  'SUNPHARMA', 'ULTRACEMCO', 'BAJFINANCE', 'NESTLEIND', 'M&M', 'NTPC', 'ADANIENT', 'POWERGRID',
  'TATAMOTORS', 'TATASTEEL', 'ONGC', 'JSWSTEEL', 'GRASIM', 'INDUSINDBK', 'COALINDIA',
  'HINDALCO', 'BAJAJFINSV', 'TECHM', 'WIPRO', 'HDFCLIFE', 'SBILIFE', 'CIPLA', 'DIVISLAB',
  'EICHERMOT', 'BPCL', 'DRREDDY', 'BRITANNIA', 'UPL', 'ADANIPORTS', 'BAJAJ-AUTO',
  'TATACONSUM', 'APOLLOHOSP', 'HEROMOTOCO', 'LTIM',
]

/** NIFTY NEXT 50 + midcaps commonly traded F&O */
export const NIFTY_NEXT50 = [
  'ADANIGREEN', 'ADANIPOWER', 'VEDL', 'IRCTC', 'ZYDUSLIFE', 'PIDILITIND', 'DLF', 'DMART',
  'GODREJCP', 'SHREECEM', 'SIEMENS', 'AMBUJACEM', 'HAVELLS', 'COLPAL', 'PIIND', 'DABUR',
  'SBICARD', 'CHOLAFIN', 'ICICIPRULI', 'ICICIGI', 'MUTHOOTFIN', 'BAJAJHLDNG', 'PFC', 'RECLTD',
  'IOC', 'GAIL', 'HINDPETRO', 'PNB', 'CANBK', 'BANKBARODA', 'FEDERALBNK', 'IDFCFIRSTB',
  'NAUKRI', 'INDIGO', 'TRENT', 'BERGEPAINT', 'MARICO', 'PAGEIND', 'TORNTPHARM', 'LUPIN',
  'AUROPHARMA', 'JINDALSTEL', 'HINDZINC', 'NMDC', 'SAIL', 'NHPC', 'HAL', 'BEL', 'BHEL', 'IRFC',
]

/** NIFTY MIDCAP 150 (selection — top by market cap) */
export const NIFTY_MIDCAP_150 = [
  'PERSISTENT', 'MPHASIS', 'COFORGE', 'CUMMINSIND', 'ABB', 'TVSMOTOR', 'ESCORTS', 'MOTHERSON',
  'EXIDEIND', 'BALKRISIND', 'MRF', 'APOLLOTYRE', 'BHARATFORG', 'ASHOKLEY', 'VOLTAS', 'BLUESTARCO',
  'HAVELLS', 'CROMPTON', 'POLYCAB', 'KEI', 'FINOLEXIND', 'ASTRAL', 'APLAPOLLO', 'SUPREMEIND',
  'RAMCOCEM', 'JKCEMENT', 'DALBHARAT', 'ACC', 'NAVINFLUOR', 'COROMANDEL', 'SRF', 'DEEPAKNTR',
  'TATACHEM', 'BASF', 'ATUL', 'SOLARINDS', 'BAYERCROP', 'UBL', 'VBL', 'UNITDSPR',
  'MCDOWELL-N', 'COLPAL', 'GODREJIND', 'EMAMILTD', 'GILLETTE', 'HONASA', 'AARTIIND',
  'OBEROIRLTY', 'PRESTIGE', 'GODREJPROP', 'LODHA', 'PHOENIXLTD', 'BRIGADE',
  'CONCOR', 'INDHOTEL', 'RVNL', 'IRCON', 'GMRINFRA', 'BEML', 'HINDCOPPER', 'NBCC',
  'HUDCO', 'POWERINDIA', 'SCHAEFFLER', 'BOSCHLTD', 'SUNDRMFAST', 'ENDURANCE', 'MAHINDCIE',
  'SUNTV', 'ZEEL', 'PVRINOX', 'TATAELXSI', 'LTTS', 'CYIENT', 'KPITTECH', 'INTELLECT',
  'NAUKRI', 'JUSTDIAL', 'INDIAMART', 'PAYTM', 'POLICYBZR', 'ZOMATO', 'NYKAA',
  'ASTRAZEN', 'ABBOTINDIA', 'GLAND', 'ALKEM', 'IPCALAB', 'GLENMARK', 'BIOCON', 'PEL',
  'SANOFI', 'TORNTPOWER', 'CESC', 'JPPOWER', 'RTNPOWER', 'SUZLON', 'INOXWIND',
  'MAZDOCK', 'BDL', 'GRSE', 'BHARATDYN', 'MIDHANI', 'DATAPATTNS', 'MAPMYINDIA',
  'CDSL', 'BSE', 'MCX', 'IEX', 'NAVNETEDUL', 'NIACL', 'GICRE', 'STARHEALTH',
  'NUVAMA', 'CAMS', 'CRISIL', 'MOTILALOFS', 'IIFL', 'EDELWEISS', 'PNBHOUSING',
]

/** NIFTY SMALLCAP 250 (selection — active traders, many in ₹50-500 band) */
export const NIFTY_SMALLCAP_250 = [
  'SUZLON', 'YESBANK', 'IDEA', 'IOB', 'CENTRALBK', 'UCOBANK', 'UJJIVANSFB', 'EQUITASBNK',
  'RBLBANK', 'CSBBANK', 'DCBBANK', 'KARURVYSYA', 'TMB', 'J&KBANK', 'SOUTHBANK',
  'COCHINSHIP', 'GRSE', 'SJVN', 'NLCINDIA', 'KTKBANK', 'GESHIP', 'SCI',
  'JINDALSAW', 'WELCORP', 'RATNAMANI', 'JAMNAAUTO', 'JKTYRE', 'CEATLTD',
  'SUNDRMBRAK', 'LUMAXTECH', 'ZFCVINDIA', 'TIINDIA', 'AIAENG', 'GRINDWELL',
  'GRAPHITE', 'HEG', 'CARBORUNIV', 'NATIONALUM', 'MOIL', 'GMDCLTD',
  'HINDCOPPER', 'GESHIP', 'SHIPPINGCOR', 'SWELECTES',
  'NATCOPHARM', 'ZYDUSWELL', 'GRANULES', 'PFIZER', 'JBCHEPHARM', 'ERIS', 'SEQUENT',
  'CAPLINPOINT', 'MANKIND', 'LAURUSLABS', 'DIVGIITCS', 'SUVENPHAR',
  'KEI', 'RRKABEL', 'ORIENTELEC', 'SYMPHONY', 'TTKPRESTIG', 'AMBER', 'DIXON',
  'BLUESTARCO', 'BAJAJELEC', 'CROMPTON', 'ORIENTELEC', 'WHIRLPOOL', 'IFBIND',
  'CENTURYPLY', 'GREENPLY', 'GREENPANEL', 'SOMANYCERA', 'CERA', 'KAJARIACER',
  'BIRLACORPN', 'ORIENTCEM', 'SAGCEM', 'HEIDELBERG', 'PRSMJOHNSN', 'INDIACEM',
  'GHCL', 'DCMSHRIRAM', 'BALRAMCHIN', 'DHAMPURSUG', 'TRIVENI', 'RENUKA', 'EIDPARRY',
  'GODREJAGRO', 'JUBLFOOD', 'WESTLIFE', 'DEVYANI', 'RADICO', 'GLOBUSSPR',
  'HCLTECH', 'TATATECH', 'HAPPSTMNDS', 'ROUTE', 'TANLA', 'SUBEX',
  'BATAINDIA', 'RELAXO', 'KHADIM', 'METROBRAND', 'CAMPUS',
  'TATAPOWER', 'TATACHEM', 'TATACOMM', 'TATAINVEST',
  'SURYAROSNI', 'APLAPOLLO', 'BEML', 'KIRLOSIND', 'MAHSCOOTER', 'ACE',
  'WABCOINDIA', 'MINDAIND', 'UNOMINDA', 'PRECAM', 'LUMINA',
  'ASTERDM', 'RAINBOW', 'FORTIS', 'MAXHEALTH', 'NH', 'GLOBALHE',
  'ROSSARI', 'NOCIL', 'NEOGEN', 'CHAMBLFERT', 'GNFC', 'FACT', 'RCF',
  'KSCL', 'NATH', 'BAYERCROP', 'RALLIS', 'KAVERISEED', 'HERITGFOOD',
  'PRINCEPIPE', 'ASTRAL', 'FINOLEXIND', 'SUPREMEIND', 'JAINTUBES',
  'UJJIVAN', 'SPANDANA', 'CREDITACC', 'MASFIN', 'POONAWALLA', 'PEL',
  'LICI', 'ABCAPITAL', 'LICHSGFIN', 'CANFINHOME', 'HUDCO', 'PNBHOUSING',
  'INDIASHLTR', 'APTUS', 'HOMEFIRST',
  'ELECTHERM', 'KALPATPOWR', 'KEC', 'ABB', 'SIEMENS', 'GET&D', 'THERMAX',
  'KIRLOSIND', 'MCNALLY', 'APOLLOTRI', 'FINPIPE', 'DEEPAKFERT', 'ZUARIIND',
  'NESCO', 'MAHLIFE', 'BEL', 'HAL', 'BHARATDYN', 'DATAPATTNS', 'MIDHANI', 'MAZDOCK', 'GRSE',
  'RVNL', 'IRCON', 'IRFC', 'RAILTEL', 'CONCOR', 'TEXRAIL', 'IRCTC', 'RITES', 'RAIL',
  'MGL', 'IGL', 'GUJGASLTD', 'PETRONET', 'GAIL', 'OIL', 'OVNL',
  'SJVN', 'NHPC', 'NTPC', 'POWERGRID', 'TATAPOWER', 'JPPOWER', 'RTNPOWER', 'CESC', 'TORNTPOWER',
  'ADANIPOWER', 'ADANIENERGY',
]

/** A conservative hand-curated intersection — 500 liquid names we trust for scanning. */
export const NIFTY_500_CORE: string[] = [...new Set([
  ...NIFTY50, ...NIFTY_NEXT50, ...NIFTY_MIDCAP_150, ...NIFTY_SMALLCAP_250,
])]

/** ---- Dynamic universe ---- */
let dynamicAllNSE: string[] | null = null

/**
 * Pull ALL NSE equity symbols from Angel ScripMaster — across every segment
 * (EQ, BE Trade-to-Trade, BL Block, BT, BZ surveillance, SM SME-Emerge, IL
 * illiquid, ST). Cached for the session.
 *
 * 2026-05-03: was filtering only `-EQ` which silently excluded ~3,500
 * Trade-to-Trade + SME + surveillance names. Names like Adisoft Tech, BCC
 * Fuba India, Mukta Agriculture, Pentokey Organy, Yunik Managing trade in
 * BE/SM segments — they were invisible to the weekly-pick scanner.
 */
const NSE_EQUITY_SUFFIXES = ['-EQ', '-BE', '-BL', '-BT', '-BZ', '-SM', '-IL', '-ST']
export async function getAllNSEEquities(): Promise<string[]> {
  if (dynamicAllNSE) return dynamicAllNSE
  const all = await loadScripMaster().catch(() => [])
  if (!all.length) return []
  const out: string[] = []
  const seen = new Set<string>()
  const segCounts: Record<string, number> = {}
  for (const s of all) {
    if (s.exch_seg !== 'NSE') continue
    const matchedSuffix = NSE_EQUITY_SUFFIXES.find(sx => s.symbol.endsWith(sx))
    if (!matchedSuffix) continue
    // Skip futures/options (those have expiry strings before the suffix)
    if (/\d{2}[A-Z]{3}\d{2}/.test(s.symbol)) continue
    const base = s.symbol.slice(0, -matchedSuffix.length)
    if (!seen.has(base)) {
      seen.add(base); out.push(base)
      segCounts[matchedSuffix] = (segCounts[matchedSuffix] ?? 0) + 1
    }
  }
  dynamicAllNSE = out
  log.ok('UNIVERSE', `Dynamic NSE universe: ${out.length} equities (${Object.entries(segCounts).map(([k, v]) => `${k}=${v}`).join(', ')})`)
  return out
}

let dynamicAllBSE: string[] | null = null
export async function getAllBSEEquities(): Promise<string[]> {
  if (dynamicAllBSE) return dynamicAllBSE
  const all = await loadScripMaster().catch(() => [])
  if (!all.length) return []
  // 2026-05-03: return ALPHA-NAME tokens, not 6-digit numeric codes. Numeric
  // codes ("532884") were unreadable downstream and the data router couldn't
  // route them. Now we derive a single firstWord-of-name token per BSE scrip
  // (e.g. "CEMINDIA" from "CEMINDIA PROJECTS LIMITED"). The data router's
  // findEquityScrip resolves these back to numeric tokens for Angel calls.
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of all) {
    if (s.exch_seg !== 'BSE') continue
    if (/\d{2}[A-Z]{3}\d{2}/.test(s.symbol)) continue
    if (!s.name) continue
    const cleaned = s.name
      .replace(/\b(LTD|LIMITED|PVT|PRIVATE|CO|COMPANY|GROUP|TECHNOLOG(?:IES|Y)|INDUSTR(?:IES|Y)|HOLDINGS?|INC)\b/gi, '')
      .replace(/[^A-Z0-9 ]/gi, ' ')
      .replace(/\s+/g, ' ')
      .toUpperCase().trim()
    if (!cleaned) continue
    const firstWord = cleaned.split(/\s+/)[0]
    if (firstWord.length < 3) continue
    if (!seen.has(firstWord)) { seen.add(firstWord); out.push(firstWord) }
  }
  dynamicAllBSE = out
  log.ok('UNIVERSE', `Dynamic BSE universe: ${out.length} equities (name-aliases)`)
  return out
}

export interface UniverseConfig {
  name: string
  symbols: string[]
}

export const UNIVERSES: Record<string, UniverseConfig> = {
  NIFTY50: { name: 'NIFTY 50', symbols: NIFTY50 },
  NEXT50: { name: 'NIFTY Next 50', symbols: NIFTY_NEXT50 },
  MIDCAP: { name: 'MIDCAP 150', symbols: NIFTY_MIDCAP_150 },
  SMALLCAP: { name: 'SMALLCAP 250', symbols: NIFTY_SMALLCAP_250 },
  CNX500: { name: 'CNX 500 (core)', symbols: NIFTY_500_CORE },
  ALL_STATIC: { name: 'All curated (500+)', symbols: NIFTY_500_CORE },
}

/**
 * Resolve a universe key to an actual symbol list — some keys (NSE_ALL, BSE_ALL,
 * MARKET_ALL) are resolved dynamically from ScripMaster at call time.
 */
export async function resolveUniverse(key: string): Promise<string[]> {
  if (key === 'NSE_ALL') return getAllNSEEquities()
  if (key === 'BSE_ALL') return getAllBSEEquities()
  if (key === 'MARKET_ALL') {
    const [nse, bse] = await Promise.all([getAllNSEEquities(), getAllBSEEquities()])
    return [...new Set([...nse, ...bse])]
  }
  return UNIVERSES[key]?.symbols ?? NIFTY_500_CORE
}

// Back-compat aliases for older code that imports MIDCAP_UNIVERSE / SMALL_MICRO_CAPS
export const MIDCAP_UNIVERSE = NIFTY_MIDCAP_150
export const SMALL_MICRO_CAPS = NIFTY_SMALLCAP_250
