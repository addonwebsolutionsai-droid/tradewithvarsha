/**
 * Admin: PATCH /api/admin/user — update a user.
 * Body: { email, isActive?, expiryAt? (ISO date or null), allowedTabs? (string[]) }
 *
 * Admin-only. Cannot demote yourself or modify another admin via this route.
 */
import { applyCors, authedUser, getDb } from '../_lib/db'

const VALID_TABS = ['weekly', 'daily', 'premove', 'options', 'intraday']

export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  const admin = await authedUser(req, res, { adminOnly: true })
  if (!admin) return
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    res.status(405).json({ error: 'PATCH or POST only' }); return
  }
  const { email, isActive, expiryAt, allowedTabs } = req.body ?? {}
  if (!email) { res.status(400).json({ error: 'email required' }); return }
  const target = String(email).toLowerCase().trim()
  if (target === admin.email) {
    res.status(400).json({ error: 'cannot edit your own admin account here — use /profile' }); return
  }
  // Disallow editing another admin's row to prevent privilege fights
  const db = getDb()
  const cur = await db.execute({ sql: 'SELECT is_admin FROM users WHERE email = ?', args: [target] })
  if (!cur.rows.length) { res.status(404).json({ error: 'user not found' }); return }
  if (cur.rows[0].is_admin) { res.status(403).json({ error: 'cannot edit another admin' }); return }

  const sets: string[] = []
  const args: any[] = []
  if (typeof isActive === 'boolean') { sets.push('is_active = ?'); args.push(isActive ? 1 : 0) }
  if (expiryAt === null || typeof expiryAt === 'string') {
    sets.push('expiry_at = ?'); args.push(expiryAt)
  }
  if (Array.isArray(allowedTabs)) {
    const cleaned = allowedTabs
      .map((s: any) => String(s).toLowerCase().trim())
      .filter((s: string) => VALID_TABS.includes(s))
    sets.push('allowed_tabs = ?'); args.push(cleaned.join(','))
  }
  if (!sets.length) { res.status(400).json({ error: 'no valid fields to update' }); return }
  args.push(target)
  await db.execute({ sql: `UPDATE users SET ${sets.join(', ')} WHERE email = ?`, args })
  res.status(200).json({ ok: true })
}
