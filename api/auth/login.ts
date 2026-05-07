import { applyCors, ensureSchema, getDb, hashPassword, signToken } from '../_lib/db'

export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  try {
    await ensureSchema()
    const { email, password } = req.body ?? {}
    if (!email || !password) { res.status(400).json({ error: 'email + password required' }); return }
    const lower = String(email).toLowerCase().trim()
    const r = await getDb().execute({
      sql: `SELECT email, password_hash, password_salt, is_admin, is_active, expiry_at, allowed_tabs
            FROM users WHERE email = ?`,
      args: [lower],
    })
    if (!r.rows.length) { res.status(401).json({ error: 'invalid email or password' }); return }
    const row: any = r.rows[0]
    if (hashPassword(password, String(row.password_salt)) !== String(row.password_hash)) {
      res.status(401).json({ error: 'invalid email or password' }); return
    }
    if (!row.is_active) { res.status(403).json({ error: 'account deactivated — contact admin' }); return }
    if (row.expiry_at && new Date(String(row.expiry_at)).getTime() < Date.now()) {
      res.status(403).json({ error: 'subscription expired', expiryAt: row.expiry_at }); return
    }
    await getDb().execute({
      sql: 'UPDATE users SET last_login_at = ? WHERE email = ?',
      args: [new Date().toISOString(), lower],
    })
    res.status(200).json({
      ok: true,
      token: signToken(lower, !!row.is_admin),
      user: {
        email: lower,
        isAdmin: !!row.is_admin,
        expiryAt: row.expiry_at,
        allowedTabs: String(row.allowed_tabs).split(',').map((s: string) => s.trim()).filter(Boolean),
      },
    })
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) })
  }
}
