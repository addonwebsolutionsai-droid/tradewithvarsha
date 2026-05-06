import NodeCache from 'node-cache'
import { config } from '../config'

export const priceCache = new NodeCache({ stdTTL: config.cache.priceTtl, checkperiod: 30 })
export const oiCache = new NodeCache({ stdTTL: config.cache.oiTtl, checkperiod: 60 })
export const signalCache = new NodeCache({ stdTTL: config.cache.signalTtl, checkperiod: 60 })
export const dailyCache = new NodeCache({ stdTTL: 60 * 60 * 4, checkperiod: 300 }) // 4h for end-of-day data

export async function cached<T>(
  cache: NodeCache,
  key: string,
  fetcher: () => Promise<T>,
): Promise<T> {
  const hit = cache.get<T>(key)
  if (hit !== undefined) return hit
  const val = await fetcher()
  if (val !== undefined && val !== null) cache.set(key, val)
  return val
}
