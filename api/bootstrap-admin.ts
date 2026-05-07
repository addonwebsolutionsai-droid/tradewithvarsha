/**
 * One-time admin bootstrap. Allows creating the first admin user when env
 * vars (ADMIN_EMAIL / ADMIN_PASSWORD_BOOTSTRAP) weren't set at first deploy.
 *
 * Security model: this endpoint is open BUT only works while NO admin
 * exists in the users table. The first request creates the admin; every
 * subsequent request returns 403. After admin login, this is effectively
 * dead code (and you can safely remove the file).
 *
 *   POST /api/bootstrap-admin
 *   Body: { email, password }
 */
import { applyCors, ensureSchema, getDb, hashPassword, newSalt, signToken } from './_lib/db'

export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  try {
    await ensureSchema()
    const db = getDb()
    // Refuse if any admin already exists.
    const existing = await db.execute('SELECT email FROM users WHERE is_admin = 1 LIMIT 1')
    if (existing.rows.length > 0) {
      res.status(403).json({ error: 'admin already exists — bootstrap closed' }); return
    }
    const { email, password } = req.body ?? {}
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: 'invalid email' }); return
    }
    if (!password || password.length < 8) {
      res.status(400).json({ error: 'password must be ≥ 8 chars' }); return
    }
    const lower = String(email).toLowerCase().trim()
    // If the user already exists as a normal user, promote to admin instead.
    const existsAsUser = await db.execute({ sql: 'SELECT email FROM users WHERE email = ?', args: [lower] })
    if (existsAsUser.rows.length > 0) {
      const salt = newSalt()
      const hash = hashPassword(password, salt)
      await db.execute({
        sql: 'UPDATE users SET password_hash = ?, password_salt = ?, is_admin = 1, is_active = 1, expiry_at = NULL WHERE email = ?',
        args: [hash, salt, lower],
      })
    } else {
      const salt = newSalt()
      const hash = hashPassword(password, salt)
      await db.execute({
        sql: `INSERT INTO users (email, password_hash, password_salt, is_admin, is_active, expiry_at, allowed_tabs, signup_at)
              VALUES (?, ?, ?, 1, 1, NULL, 'weekly,daily,premove,options,intraday', ?)`,
        args: [lower, hash, salt, new Date().toISOString()],
      })
    }
    res.status(200).json({
      ok: true,
      bootstrapped: lower,
      token: signToken(lower, true),
      note: 'Bootstrap endpoint will refuse all subsequent requests.',
    })
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) })
  }
}
