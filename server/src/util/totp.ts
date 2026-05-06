import crypto from 'crypto'

/**
 * RFC 6238 TOTP generator. Default SHA-1, 30-second step, 6 digits —
 * matches Google Authenticator / Angel One SmartAPI exactly.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32ToBuffer(base32: string): Buffer {
  const clean = base32.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '')
  let bits = ''
  for (const ch of clean) {
    const v = BASE32_ALPHABET.indexOf(ch)
    if (v < 0) throw new Error(`Invalid base32 character: ${ch}`)
    bits += v.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

export function totp(secret: string, opts: { step?: number; digits?: number; now?: number } = {}): string {
  const step = opts.step ?? 30
  const digits = opts.digits ?? 6
  const now = opts.now ?? Date.now()

  const counter = Math.floor(now / 1000 / step)
  const counterBuf = Buffer.alloc(8)
  counterBuf.writeBigInt64BE(BigInt(counter))

  const key = base32ToBuffer(secret)
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)

  return (code % 10 ** digits).toString().padStart(digits, '0')
}

/** Milliseconds remaining until the current TOTP code rotates. */
export function msUntilNextTotp(step = 30, now: number = Date.now()): number {
  return step * 1000 - (now % (step * 1000))
}
