import { applyCors } from '../_lib/db'
// Stateless tokens — logout is purely client-side (clear localStorage).
// Endpoint exists for symmetry + future server-side blacklist support.
export default async function handler(req: any, res: any): Promise<void> {
  if (applyCors(req, res)) return
  res.status(200).json({ ok: true })
}
