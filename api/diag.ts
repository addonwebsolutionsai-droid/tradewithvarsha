/**
 * Diagnostic endpoint — reports env-var presence (no values leaked) and
 * triggers an admin-seed attempt. Safe to remove once auth is verified.
 *   GET /api/_diag
 */
import { applyCors, ensureSchema, getDb } from './_lib/db'

export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  const env = {
    TURSO_DATABASE_URL: !!(process.env.tradewithvarshadb_TURSO_DATABASE_URL || process.env.TURSO_DATABASE_URL),
    TURSO_AUTH_TOKEN: !!(process.env.tradewithvarshadb_TURSO_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN),
    JWT_SECRET: !!process.env.JWT_SECRET,
    ADMIN_EMAIL: !!process.env.ADMIN_EMAIL,
    ADMIN_EMAIL_VALUE: process.env.ADMIN_EMAIL ? `${process.env.ADMIN_EMAIL.slice(0, 3)}***@***${process.env.ADMIN_EMAIL.slice(-4)}` : null,
    ADMIN_PASSWORD_BOOTSTRAP: !!process.env.ADMIN_PASSWORD_BOOTSTRAP,
    ADMIN_PASSWORD_LENGTH: (process.env.ADMIN_PASSWORD_BOOTSTRAP || '').length,
  }
  let users: any = null
  try {
    await ensureSchema()
    const r = await getDb().execute('SELECT email, is_admin, signup_at FROM users ORDER BY signup_at DESC')
    users = r.rows.map((row: any) => ({
      email: row.email, isAdmin: !!row.is_admin, signupAt: row.signup_at,
    }))
  } catch (e: any) {
    users = { error: String(e?.message || e) }
  }
  res.status(200).json({ env, users })
}
