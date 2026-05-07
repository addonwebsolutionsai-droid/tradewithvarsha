import { applyCors, authedUser, getDb, hashPassword, newSalt } from '../_lib/db'

export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  const u = await authedUser(req, res)
  if (!u) return
  const { oldPassword, newPassword } = req.body ?? {}
  if (!oldPassword || !newPassword || String(newPassword).length < 8) {
    res.status(400).json({ error: 'oldPassword + newPassword (min 8 chars) required' }); return
  }
  // Verify old password
  const db = getDb()
  const r = await db.execute({
    sql: 'SELECT password_hash, password_salt FROM users WHERE email = ?',
    args: [u.email],
  })
  if (!r.rows.length) { res.status(404).json({ error: 'user not found' }); return }
  const row: any = r.rows[0]
  if (hashPassword(oldPassword, String(row.password_salt)) !== String(row.password_hash)) {
    res.status(401).json({ error: 'old password incorrect' }); return
  }
  const salt = newSalt()
  const hash = hashPassword(newPassword, salt)
  await db.execute({
    sql: 'UPDATE users SET password_hash = ?, password_salt = ? WHERE email = ?',
    args: [hash, salt, u.email],
  })
  res.status(200).json({ ok: true })
}
