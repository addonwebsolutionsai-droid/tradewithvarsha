import { applyCors, ensureSchema, getDb, getUser, hashPassword, newSalt, signToken } from '../_lib/db'

const TRIAL_DAYS = 30                  // free 30-day trial; admin can extend
const DEFAULT_TABS = 'weekly,daily,premove,options,intraday'

export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  try {
    await ensureSchema()
    const { email, password } = req.body ?? {}
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'invalid email' }); return
    }
    if (!password || password.length < 8) {
      res.status(400).json({ error: 'password must be at least 8 characters' }); return
    }
    const lower = String(email).toLowerCase().trim()
    const existing = await getUser(lower)
    if (existing) { res.status(400).json({ error: 'email already registered' }); return }
    const salt = newSalt()
    const hash = hashPassword(password, salt)
    const expiry = new Date(Date.now() + TRIAL_DAYS * 86_400_000).toISOString()
    await getDb().execute({
      sql: `INSERT INTO users (email, password_hash, password_salt, is_admin, is_active, expiry_at, allowed_tabs, signup_at)
            VALUES (?, ?, ?, 0, 1, ?, ?, ?)`,
      args: [lower, hash, salt, expiry, DEFAULT_TABS, new Date().toISOString()],
    })
    res.status(200).json({
      ok: true,
      token: signToken(lower, false),
      user: { email: lower, isAdmin: false, expiryAt: expiry },
    })
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) })
  }
}
