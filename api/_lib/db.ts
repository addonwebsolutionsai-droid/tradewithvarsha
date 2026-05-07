/**
 * Auth + DB layer for Vercel functions, backed by Turso (libSQL/SQLite).
 *
 * Single file: client + schema bootstrap + password hashing + JWT helpers
 * + per-request auth guard. Imported by every endpoint under api/.
 */
import { createClient, type Client } from '@libsql/client'
import crypto from 'crypto'

// ── Turso client ────────────────────────────────────────────────
let _client: Client | null = null
export function getDb(): Client {
  if (_client) return _client
  const url = process.env.tradewithvarshadb_TURSO_DATABASE_URL
    || process.env.TURSO_DATABASE_URL
  const authToken = process.env.tradewithvarshadb_TURSO_AUTH_TOKEN
    || process.env.TURSO_AUTH_TOKEN
  if (!url) throw new Error('TURSO_DATABASE_URL not set')
  _client = createClient({ url, authToken })
  return _client
}

// ── Schema bootstrap (idempotent) ───────────────────────────────
let _schemaReady = false
export async function ensureSchema(): Promise<void> {
  if (_schemaReady) return
  const db = getDb()
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      expiry_at TEXT,                -- ISO date or NULL = lifetime
      allowed_tabs TEXT NOT NULL DEFAULT 'weekly,daily,premove,options,intraday',
      signup_at TEXT NOT NULL,
      last_login_at TEXT
    )
  `)
  // Bootstrap admin if it doesn't exist yet
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim()
  const adminPwd = process.env.ADMIN_PASSWORD_BOOTSTRAP || ''
  if (adminEmail && adminPwd) {
    const r = await db.execute({
      sql: 'SELECT email FROM users WHERE email = ?',
      args: [adminEmail],
    })
    if (r.rows.length === 0) {
      const salt = crypto.randomBytes(16).toString('hex')
      const hash = hashPassword(adminPwd, salt)
      await db.execute({
        sql: `INSERT INTO users (email, password_hash, password_salt, is_admin, is_active, allowed_tabs, signup_at)
              VALUES (?, ?, ?, 1, 1, 'weekly,daily,premove,options,intraday', ?)`,
        args: [adminEmail, hash, salt, new Date().toISOString()],
      })
    }
  }
  _schemaReady = true
}

// ── Password hashing (PBKDF2-SHA256) ────────────────────────────
export function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256').toString('hex')
}
export function newSalt(): string {
  return crypto.randomBytes(16).toString('hex')
}

// ── JWT (HMAC-SHA256, 7-day TTL) ────────────────────────────────
const TOKEN_TTL_MS = 7 * 24 * 3600_000
function jwtSecret(): string {
  return process.env.JWT_SECRET || 'dev-secret-change-in-prod-please'
}
export interface TokenPayload {
  email: string
  isAdmin: boolean
  exp: number
}
export function signToken(email: string, isAdmin: boolean): string {
  const payload: TokenPayload = {
    email, isAdmin, exp: Date.now() + TOKEN_TTL_MS,
  }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', jwtSecret()).update(body).digest('base64url')
  return `${body}.${sig}`
}
export function verifyToken(token: string | undefined | null): TokenPayload | null {
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, sig] = parts
  const expected = crypto.createHmac('sha256', jwtSecret()).update(body).digest('base64url')
  if (sig !== expected) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null
    return payload
  } catch { return null }
}

// ── Request helpers ─────────────────────────────────────────────
export function readToken(req: any): string | undefined {
  const h = (req.headers?.authorization as string) || ''
  if (h.startsWith('Bearer ')) return h.slice(7)
  return req.headers?.['x-auth-token'] as string | undefined
}
export async function getUser(email: string): Promise<any | null> {
  const db = getDb()
  const r = await db.execute({
    sql: `SELECT email, is_admin, is_active, expiry_at, allowed_tabs, signup_at, last_login_at
          FROM users WHERE email = ?`,
    args: [email.toLowerCase()],
  })
  if (!r.rows.length) return null
  const row: any = r.rows[0]
  return {
    email: row.email,
    isAdmin: !!row.is_admin,
    isActive: !!row.is_active,
    expiryAt: row.expiry_at,
    allowedTabs: String(row.allowed_tabs).split(',').map((s: string) => s.trim()).filter(Boolean),
    signupAt: row.signup_at,
    lastLoginAt: row.last_login_at,
  }
}

/** Validate the request: returns user record (with active + expiry checks)
 *  or sends a 401/403 and returns null. */
export async function authedUser(req: any, res: any, opts: { adminOnly?: boolean } = {}): Promise<any | null> {
  await ensureSchema()
  const t = verifyToken(readToken(req))
  if (!t) { res.status(401).json({ error: 'auth required' }); return null }
  const u = await getUser(t.email)
  if (!u) { res.status(401).json({ error: 'user not found' }); return null }
  if (!u.isActive) { res.status(403).json({ error: 'account deactivated' }); return null }
  if (u.expiryAt && new Date(u.expiryAt).getTime() < Date.now()) {
    res.status(403).json({ error: 'subscription expired', expiryAt: u.expiryAt }); return null
  }
  if (opts.adminOnly && !u.isAdmin) {
    res.status(403).json({ error: 'admin only' }); return null
  }
  return u
}

// ── CORS helper ─────────────────────────────────────────────────
export function applyCors(req: any, res: any): boolean {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-auth-token')
  if (req.method === 'OPTIONS') { res.status(200).end(); return true }
  return false
}
