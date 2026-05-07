import { applyCors, authedUser } from '../_lib/db'

export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return }
  const u = await authedUser(req, res)
  if (!u) return
  res.status(200).json({
    email: u.email,
    isAdmin: u.isAdmin,
    isActive: u.isActive,
    expiryAt: u.expiryAt,
    allowedTabs: u.allowedTabs,
    signupAt: u.signupAt,
    lastLoginAt: u.lastLoginAt,
  })
}
