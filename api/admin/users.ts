import { applyCors, authedUser, getDb } from '../_lib/db'

export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  const admin = await authedUser(req, res, { adminOnly: true })
  if (!admin) return
  if (req.method === 'GET') {
    const r = await getDb().execute(`
      SELECT email, is_admin, is_active, expiry_at, allowed_tabs, signup_at, last_login_at
      FROM users ORDER BY signup_at DESC
    `)
    const users = r.rows.map((row: any) => ({
      email: row.email,
      isAdmin: !!row.is_admin,
      isActive: !!row.is_active,
      expiryAt: row.expiry_at,
      allowedTabs: String(row.allowed_tabs).split(',').map((s: string) => s.trim()).filter(Boolean),
      signupAt: row.signup_at,
      lastLoginAt: row.last_login_at,
    }))
    res.status(200).json({ users })
    return
  }
  res.status(405).json({ error: 'GET only — use /api/admin/user for updates' })
}
