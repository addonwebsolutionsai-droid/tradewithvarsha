/**
 * Lightweight auth — no external deps. PBKDF2-SHA256 password hashing +
 * HMAC-signed session tokens (`<base64url payload>.<hmac>`). User store is
 * a JSON file on disk; sessions live in memory only and clear on restart.
 *
 * 2026-05-06: Built for the dashboard's Login/Signup pages so users can be
 * gated before access (preparing for Vercel deploy). Admin-flagged users can
 * activate/deactivate other users via /api/admin/users/:email/toggle.
 */
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'

const DATA_DIR = path.resolve(__dirname, '../../data')
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const SECRET = process.env.AUTH_SECRET || 'hedge-fund-dev-secret-change-in-prod'
const TOKEN_TTL_MS = 7 * 24 * 3600_000      // 7-day sessions

export interface User {
  email: string
  passwordHash: string             // pbkdf2 hex
  passwordSalt: string             // hex
  isAdmin: boolean
  isActive: boolean
  createdAt: string
  lastLoginAt?: string
}

interface UsersFile { users: User[] }

let cache: UsersFile | null = null

async function ensureFile(): Promise<UsersFile> {
  if (cache) return cache
  await fs.mkdir(DATA_DIR, { recursive: true })
  try {
    const raw = await fs.readFile(USERS_FILE, 'utf8')
    cache = JSON.parse(raw)
    return cache!
  } catch {
    cache = { users: [] }
    return cache
  }
}

async function persist(): Promise<void> {
  if (!cache) return
  await fs.writeFile(USERS_FILE, JSON.stringify(cache, null, 2))
}

function hashPassword(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256').toString('hex')
}

function newSalt(): string {
  return crypto.randomBytes(16).toString('hex')
}

function signToken(email: string, isAdmin: boolean): string {
  const payload = { email, isAdmin, exp: Date.now() + TOKEN_TTL_MS }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${sig}`
}

export interface VerifiedToken { email: string; isAdmin: boolean }

export function verifyToken(token: string | undefined): VerifiedToken | null {
  if (!token) return null
  const [body, sig] = token.split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url')
  if (sig !== expected) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null
    return { email: payload.email, isAdmin: !!payload.isAdmin }
  } catch { return null }
}

export async function signup(email: string, password: string): Promise<{ ok: boolean; error?: string; token?: string }> {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'invalid email' }
  if (!password || password.length < 8) return { ok: false, error: 'password must be at least 8 chars' }
  const f = await ensureFile()
  const lower = email.toLowerCase()
  if (f.users.find(u => u.email === lower)) return { ok: false, error: 'email already registered' }
  const salt = newSalt()
  const passwordHash = hashPassword(password, salt)
  const isFirst = f.users.length === 0           // first user becomes admin
  const user: User = {
    email: lower,
    passwordHash,
    passwordSalt: salt,
    isAdmin: isFirst,
    isActive: true,                              // active by default; admin can toggle
    createdAt: new Date().toISOString(),
  }
  f.users.push(user)
  await persist()
  return { ok: true, token: signToken(user.email, user.isAdmin) }
}

export async function login(email: string, password: string): Promise<{ ok: boolean; error?: string; token?: string; user?: { email: string; isAdmin: boolean } }> {
  const f = await ensureFile()
  const lower = (email || '').toLowerCase()
  const u = f.users.find(x => x.email === lower)
  if (!u) return { ok: false, error: 'invalid email or password' }
  if (!u.isActive) return { ok: false, error: 'account deactivated — contact admin' }
  if (hashPassword(password, u.passwordSalt) !== u.passwordHash) {
    return { ok: false, error: 'invalid email or password' }
  }
  u.lastLoginAt = new Date().toISOString()
  await persist()
  return { ok: true, token: signToken(u.email, u.isAdmin), user: { email: u.email, isAdmin: u.isAdmin } }
}

export async function listUsers(): Promise<Array<Omit<User, 'passwordHash' | 'passwordSalt'>>> {
  const f = await ensureFile()
  return f.users.map(({ passwordHash: _ph, passwordSalt: _ps, ...rest }) => rest)
}

export async function toggleUserActive(email: string): Promise<{ ok: boolean; user?: any; error?: string }> {
  const f = await ensureFile()
  const u = f.users.find(x => x.email === email.toLowerCase())
  if (!u) return { ok: false, error: 'user not found' }
  u.isActive = !u.isActive
  await persist()
  return { ok: true, user: { email: u.email, isActive: u.isActive } }
}

export async function getUser(email: string): Promise<User | null> {
  const f = await ensureFile()
  return f.users.find(x => x.email === email.toLowerCase()) ?? null
}
