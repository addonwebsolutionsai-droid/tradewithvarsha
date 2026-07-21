/**
 * ETF detector — Indian NSE / BSE listings.
 *
 * ETFs are structurally different from cash equities:
 *   - Basket products, no earnings / no catalysts
 *   - Slow-moving (track index, no idiosyncratic vol)
 *   - Different capital-allocation lens (long-term SIP vs tactical trade)
 *
 * Mixing them into a "high-quality trade setups" feed distorts:
 *   - The catch-rate metric (ETFs generate lots of low-signal noise)
 *   - The visible top-of-list (BANKETF crowding out real stock breakouts)
 *   - User expectations ("why is this ETF in my swing-trade list?")
 *
 * This detector uses name-pattern rules that cover every major ETF issuer
 * on NSE/BSE. Where ScripMaster is available, callers should also honour
 * `instrumenttype === 'ETF'` — but the patterns below catch everything on
 * their own even without ScripMaster.
 *
 * If a stock is misclassified, add it to the OVERRIDE_NOT_ETF list.
 */

// Explicit overrides — stocks whose names LOOK like an ETF but aren't.
const OVERRIDE_NOT_ETF = new Set<string>([
  'HDFCBANK',   // HDFC Bank Ltd (stock, not an ETF)
  'ICICIBANK',  // ICICI Bank Ltd
  'AXISBANK',   // Axis Bank Ltd
  'KOTAKBANK',  // Kotak Mahindra Bank Ltd
  'SBIN',       // State Bank of India
  'HDFCLIFE',   // HDFC Life Insurance
  'ICICIPRULI', // ICICI Pru Life
  'SBILIFE',    // SBI Life Insurance
  'SBICARD',    // SBI Cards
  'HDFCAMC',    // HDFC AMC
  'KOTAKMAH',   // Kotak Mahindra Investments
])

// Explicit overrides — force these to be treated as ETFs even if pattern misses.
const OVERRIDE_IS_ETF = new Set<string>([
  'CPSEETF', 'BHARATBOND', 'BHARATIWIN', 'PSUBNKBEES',
])

const ETF_PATTERNS: RegExp[] = [
  /BEES$/,                                                             // Nippon India: NIFTYBEES, GOLDBEES, JUNIORBEES, BANKBEES, LIQUIDBEES, ITBEES, PSUBNKBEES
  /ETF$/,                                                              // BANKETF, NIFTYETF, GOLDETF, LIQUIDETF, MIDCAPETF
  /IETF/,                                                              // ICICI: IETFB, IETFN, IETFP
  /^ICICIB22$/,                                                        // ICICI Bharat 22 ETF
  // Issuer-prefix rules — must clearly identify an ETF/index-fund suffix.
  // Bank of the issuer itself (e.g. HDFCBANK, ICICIBANK) is a REGULAR STOCK
  // and is protected by OVERRIDE_NOT_ETF above.
  /^KOTAK(GOLD|LIQ|LOVOLETF|MNCETF|MOMENTUM|NV20|PSUBK|EMRG|WORLD|EQTY|BANKETF|NIFTY|IT|IND25)/,
  /^ICICI(GOLD|LIQ|SILVER|LOVOL|ALPHA|VALUE|MNCETF|DIVOPP|NIFTY[A-Z0-9]{2,}|BANKETF|BSE|SENSEX|MIDCAPETF)/,
  /^SBI(GOLD|SILVER|LIQ|NIFTYETF|BANKETF|SENSEXETF|ETFCPSE|ETFBANK|ETFCONS|ETFIT|ETFPB|ETFPSU|ETFQLTY|ETFNIF50|ETFNIFTYSDL|ETFNXT50)/,
  /^HDFC(GOLD|SILVER|LIQUID|NIFTYETF|SENSEX|PVTBAN|MFGETF|NEXT50|NIF100|NIF50VAL|IT|VALUE|MOMEN|LOVOL|LOWVOL|MIDCAP|SMLCAP)/,
  /^UTI(GOLD|LIQ|NIFTYETF|SENSEXETF|BANKETF|NEXT50|SILVER)/,
  /^AXIS(GOLD|SILVER|NIFTYETF|BANKETF|MIDCAP|SMALLCAP|TECHETF|BSE|CONSUM|PSUBK|EQTY|MOMENTUM|VALUE)/,
  /^EDELWEISS(NIFTY|BANK|GOLD)/,
  /^MIRAE(NIFTY|BANK|GOLD|SILVER)/,
  /^MOTILALO?(SL|OFS|N100|NASDAQ)/,
  /^ADITYABSL?(SEN|NIFTY|BANK|GOLD)/,
  /^QUANTUM(GOLD|NIFTY|BANK)/,
  /^BHARAT(BOND|22)/,
  /^NIFTY(BEES|IETF|ETF|1D|IWIN|100|500|MID|SMALL|IT|BANK|FMCG|PHARMA|AUTO|METAL|REALTY|MEDIA|ENERGY|PVT|NEXT|ALPHA|LOVOL|MOMENT|VALUE|HIGH|EQUAL|CONSUM|COMMOD)/,
  /^GOLD(BEES|IETF|ETF|1|SHARE|IWIN)/,
  /^SILVER(BEES|ETF|IETF|1|SHARE)/,
  /^LIQUID(BEES|CASE|1|ETF)/,
  /^CPSEETF$/,
  /^SETFNIFBK$|^SETFNN50$|^SETFGOLD$|^SETFSN50$/,                      // SBI ETF short symbols
  /^N100$/,                                                             // Motilal Oswal Nasdaq 100
  /^MASPTOP50$/,
  /^GROW\w{2,}NIF|^GROW\w{2,}GOLD/,                                    // Groww ETFs
  /^EBBETF/,                                                            // Edelweiss Bharat Bond ETF
  /^HDFCNIFETF|^HDFCPVTBAN|^HDFCNEXT50$/,
]

/**
 * Return true if the given NSE/BSE tradingsymbol is an ETF, index fund,
 * or basket product that shouldn't be lumped with individual stock signals.
 *
 * Pass `instrumenttype` from ScripMaster if available — it's the most
 * authoritative signal ("ETF" or "INDEX"). Otherwise the pattern rules
 * below cover every major issuer on NSE/BSE.
 */
export function isEtfSymbol(symbol: string, instrumenttype?: string): boolean {
  if (!symbol) return false
  const up = symbol.toUpperCase().trim()
  if (OVERRIDE_NOT_ETF.has(up)) return false
  if (OVERRIDE_IS_ETF.has(up)) return true
  if (instrumenttype === 'ETF' || instrumenttype === 'INDEX') return true
  for (const rx of ETF_PATTERNS) if (rx.test(up)) return true
  return false
}
