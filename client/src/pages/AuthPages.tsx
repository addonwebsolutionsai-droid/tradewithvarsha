import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, auth } from '../api'

const TABS = [
  { key: 'weekly',   label: 'Weekly Pick' },
  { key: 'daily',    label: 'Daily Pick' },
  { key: 'premove',  label: 'Pre-Move' },
  { key: 'options',  label: 'Options' },
  { key: 'intraday', label: 'Intraday' },
]

const card: React.CSSProperties = { maxWidth: 440, margin: '60px auto', padding: 32, background: '#1a1d23', border: '1px solid #2d3038', borderRadius: 8 }
const input: React.CSSProperties = { width: '100%', padding: '10px 12px', marginBottom: 12, background: '#0d0f13', border: '1px solid #2d3038', borderRadius: 4, color: '#fff', fontSize: 14, boxSizing: 'border-box' }
const btnPrimary: React.CSSProperties = { width: '100%', padding: '11px', background: '#0a8042', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 14, fontWeight: 600 }
const btnSec: React.CSSProperties = { padding: '6px 14px', background: '#2d3038', color: '#fff', border: '1px solid #444', borderRadius: 4, cursor: 'pointer', fontSize: 12 }
const errStyle: React.CSSProperties = { color: '#ff6b6b', fontSize: 13, marginBottom: 12 }
const okStyle: React.CSSProperties = { color: '#2ecc71', fontSize: 13, marginBottom: 12 }

// ── LOGIN ───────────────────────────────────────────────────────
export function LoginPage(): JSX.Element {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setErr(''); setBusy(true)
    // Clear any stale token first so the login request never carries an
    // expired Bearer header that confuses the server-side auth check.
    auth.clear()
    try {
      const r = await api.login(email.trim(), password)
      if (!r?.ok || !r.token) {
        setErr(r?.error || 'invalid email or password')
        return
      }
      auth.setToken(r.token)
      // Reset whatever the queryClient cached — likely an isError=true from
      // pre-login me() polling. Without this, RequireAuth keeps the stale
      // error and bounces back to /login.
      try {
        qc.removeQueries({ queryKey: ['me'] })
        qc.removeQueries({ queryKey: ['admin-users'] })
      } catch { /* defensive — never block login on cache ops */ }
      // Force-fetch fresh me() so RequireAuth sees data on first render.
      try { await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api.me() }) }
      catch { /* still navigate — RequireAuth will retry */ }
      // Land admins on /admin/users, normal users on /weekly-pick.
      const target = r.user?.isAdmin ? '/admin/users' : '/weekly-pick'
      nav(target, { replace: true })
    } catch (e: any) {
      setErr(extract(e))
    } finally { setBusy(false) }
  }
  return (
    <div style={card}>
      <h1 style={{ marginTop: 0, marginBottom: 20, fontSize: 22 }}>🔒 Sign in</h1>
      <form onSubmit={submit}>
        <input style={input} type="email" placeholder="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
        <input style={input} type="password" placeholder="password" value={password} onChange={e => setPassword(e.target.value)} required />
        {err && <div style={errStyle}>{err}</div>}
        <button style={btnPrimary} type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div style={{ marginTop: 16, fontSize: 13, color: '#888' }}>
        New here? <Link to="/signup" style={{ color: '#5dade2' }}>Create an account</Link>
      </div>
    </div>
  )
}

// ── SIGNUP ──────────────────────────────────────────────────────
export function SignupPage(): JSX.Element {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setErr(''); setBusy(true)
    auth.clear()
    if (password !== confirm) { setErr('passwords do not match'); setBusy(false); return }
    try {
      const r = await api.signup(email.trim(), password)
      if (!r?.ok || !r.token) { setErr(r?.error || 'signup failed'); return }
      auth.setToken(r.token)
      try {
        qc.removeQueries({ queryKey: ['me'] })
        qc.removeQueries({ queryKey: ['admin-users'] })
      } catch { /* defensive */ }
      try { await qc.fetchQuery({ queryKey: ['me'], queryFn: () => api.me() }) }
      catch { /* still navigate */ }
      nav('/weekly-pick', { replace: true })
    } catch (e: any) { setErr(extract(e)) }
    finally { setBusy(false) }
  }
  return (
    <div style={card}>
      <h1 style={{ marginTop: 0, marginBottom: 20, fontSize: 22 }}>✨ Create account</h1>
      <p style={{ color: '#888', fontSize: 13, marginTop: -12, marginBottom: 18 }}>
        Free 30-day access to all 5 tabs. Subscription plans coming soon.
      </p>
      <form onSubmit={submit}>
        <input style={input} type="email" placeholder="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
        <input style={input} type="password" placeholder="password (min 8 chars)" value={password} onChange={e => setPassword(e.target.value)} required minLength={8} />
        <input style={input} type="password" placeholder="confirm password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} />
        {err && <div style={errStyle}>{err}</div>}
        <button style={btnPrimary} type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      </form>
      <div style={{ marginTop: 16, fontSize: 13, color: '#888' }}>
        Already registered? <Link to="/login" style={{ color: '#5dade2' }}>Sign in</Link>
      </div>
    </div>
  )
}

// ── PROFILE (own profile + change password) ─────────────────────
export function ProfilePage(): JSX.Element {
  const nav = useNavigate()
  const { data: me, isLoading, error } = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false })
  const [oldPwd, setOldPwd] = useState('')
  const [newPwd, setNewPwd] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (error) { auth.clear(); nav('/login') } }, [error, nav])

  async function changePwd(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setErr(''); setOk(''); setBusy(true)
    if (newPwd !== confirm) { setErr('new passwords do not match'); setBusy(false); return }
    try {
      const r = await api.changePassword(oldPwd, newPwd)
      if (!r.ok) { setErr(r.error || 'change failed'); return }
      setOk('Password changed.'); setOldPwd(''); setNewPwd(''); setConfirm('')
    } catch (e: any) { setErr(extract(e)) }
    finally { setBusy(false) }
  }

  if (isLoading) return <div style={{ padding: 40, color: '#888' }}>Loading…</div>
  if (!me) return <></>

  const expiryStr = me.expiryAt ? new Date(me.expiryAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'lifetime'
  const daysLeft = me.expiryAt ? Math.max(0, Math.ceil((new Date(me.expiryAt).getTime() - Date.now()) / 86_400_000)) : null

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: 24 }}>
      <h1 style={{ marginTop: 0, fontSize: 22, marginBottom: 20 }}>👤 My Profile</h1>
      <div style={{ background: '#1a1d23', border: '1px solid #2d3038', borderRadius: 8, padding: 20, marginBottom: 20 }}>
        <Field label="Email" val={me.email} />
        <Field label="Role" val={me.isAdmin ? 'Admin' : 'User'} />
        <Field label="Member since" val={new Date(me.signupAt).toLocaleDateString('en-IN')} />
        <Field label="Last login" val={me.lastLoginAt ? new Date(me.lastLoginAt).toLocaleString('en-IN') : '—'} />
        <Field label="Subscription" val={`${expiryStr}${daysLeft != null ? ` · ${daysLeft} days left` : ''}`} />
        <Field label="Tab access" val={me.allowedTabs?.length ? me.allowedTabs.join(', ') : 'none'} />
      </div>
      <div style={{ background: '#1a1d23', border: '1px solid #2d3038', borderRadius: 8, padding: 20 }}>
        <h2 style={{ marginTop: 0, fontSize: 16, marginBottom: 14 }}>🔑 Change password</h2>
        <form onSubmit={changePwd}>
          <input style={input} type="password" placeholder="current password" value={oldPwd} onChange={e => setOldPwd(e.target.value)} required />
          <input style={input} type="password" placeholder="new password (min 8)" value={newPwd} onChange={e => setNewPwd(e.target.value)} required minLength={8} />
          <input style={input} type="password" placeholder="confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={8} />
          {err && <div style={errStyle}>{err}</div>}
          {ok && <div style={okStyle}>{ok}</div>}
          <button style={btnPrimary} type="submit" disabled={busy}>{busy ? 'Saving…' : 'Update password'}</button>
        </form>
      </div>
    </div>
  )
}

function Field({ label, val }: { label: string; val: any }): JSX.Element {
  return (
    <div style={{ display: 'flex', padding: '8px 0', borderBottom: '1px solid #2d3038', fontSize: 14 }}>
      <span style={{ color: '#888', minWidth: 140 }}>{label}</span>
      <span style={{ color: '#fff' }}>{val}</span>
    </div>
  )
}

// ── ADMIN: USERS ────────────────────────────────────────────────
export function AdminUsersPage(): JSX.Element {
  const qc = useQueryClient()
  const { data, refetch, isLoading } = useQuery({ queryKey: ['admin-users'], queryFn: () => api.adminUsers() })
  const [editing, setEditing] = useState<string | null>(null)

  async function toggleActive(email: string, current: boolean): Promise<void> {
    await api.adminUpdateUser(email, { isActive: !current })
    refetch()
  }

  async function saveExpiry(email: string, dateStr: string): Promise<void> {
    const expiryAt = dateStr ? new Date(dateStr).toISOString() : null
    await api.adminUpdateUser(email, { expiryAt })
    setEditing(null); refetch()
  }

  async function toggleTab(email: string, tab: string, current: string[]): Promise<void> {
    const next = current.includes(tab) ? current.filter(t => t !== tab) : [...current, tab]
    await api.adminUpdateUser(email, { allowedTabs: next })
    refetch()
  }

  const users = data?.users ?? []
  return (
    <div style={{ padding: 20, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>👥 Members</h1>
        <span style={{ color: '#888', fontSize: 13 }}>{users.length} total · {users.filter(u => u.isActive).length} active</span>
        <button style={btnSec} onClick={() => refetch()}>Refresh</button>
      </div>
      {isLoading && <div style={{ color: '#888' }}>Loading…</div>}
      <div style={{ overflowX: 'auto', border: '1px solid #2d3038', borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1200 }}>
          <thead style={{ background: '#1a1d23' }}>
            <tr>
              <th style={th}>Email</th>
              <th style={th}>Role</th>
              <th style={th}>Status</th>
              <th style={th}>Member since</th>
              <th style={th}>Last login</th>
              <th style={th}>Expiry</th>
              <th style={th}>Tab access</th>
              <th style={th}>Action</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => {
              const days = u.expiryAt ? Math.ceil((new Date(u.expiryAt).getTime() - Date.now()) / 86_400_000) : null
              const expiringSoon = days != null && days >= 0 && days <= 7
              const expired = days != null && days < 0
              return (
                <tr key={u.email} style={{ borderTop: '1px solid #2d3038' }}>
                  <td style={td}>
                    {u.email}
                    {u.isAdmin && <span style={badge('#f5c518')}>ADMIN</span>}
                  </td>
                  <td style={td}>{u.isAdmin ? 'admin' : 'user'}</td>
                  <td style={{ ...td, color: u.isActive ? '#2ecc71' : '#ff6b6b', fontWeight: 600 }}>
                    {u.isActive ? 'active' : 'deactivated'}
                  </td>
                  <td style={td}>{new Date(u.signupAt).toLocaleDateString('en-IN')}</td>
                  <td style={td}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td style={td}>
                    {editing === u.email ? (
                      <ExpiryEditor initial={u.expiryAt} onSave={d => saveExpiry(u.email, d)} onCancel={() => setEditing(null)} />
                    ) : u.isAdmin ? (
                      <span style={{ color: '#888' }}>lifetime</span>
                    ) : (
                      <span style={{ color: expired ? '#ff6b6b' : expiringSoon ? '#f5c518' : '#bbb', cursor: 'pointer' }} onClick={() => setEditing(u.email)} title="Click to edit">
                        {u.expiryAt ? `${new Date(u.expiryAt).toLocaleDateString('en-IN')} ${days != null && days >= 0 ? `(${days}d left)` : `(expired)`}` : 'lifetime'}
                      </span>
                    )}
                  </td>
                  <td style={td}>
                    {u.isAdmin ? <span style={{ color: '#888' }}>all</span> : (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {TABS.map(t => {
                          const allowed = u.allowedTabs.includes(t.key)
                          return (
                            <span
                              key={t.key}
                              onClick={() => toggleTab(u.email, t.key, u.allowedTabs)}
                              style={{
                                padding: '2px 7px', borderRadius: 3, fontSize: 11, cursor: 'pointer',
                                background: allowed ? '#0a8042' + '33' : '#2d3038',
                                color: allowed ? '#2ecc71' : '#666',
                                border: `1px solid ${allowed ? '#0a8042' : '#444'}`,
                              }}
                            >
                              {allowed ? '✓' : '✕'} {t.label.split(' ')[0]}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </td>
                  <td style={td}>
                    {!u.isAdmin && (
                      <button style={btnSec} onClick={() => toggleActive(u.email, u.isActive)}>
                        {u.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ExpiryEditor({ initial, onSave, onCancel }: { initial?: string; onSave: (d: string) => void; onCancel: () => void }): JSX.Element {
  const [d, setD] = useState(initial ? new Date(initial).toISOString().slice(0, 10) : '')
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      <input type="date" value={d} onChange={e => setD(e.target.value)} style={{ padding: 4, fontSize: 12, background: '#0d0f13', color: '#fff', border: '1px solid #444', borderRadius: 3 }} />
      <button style={{ ...btnSec, padding: '3px 8px' }} onClick={() => onSave(d)}>Save</button>
      <button style={{ ...btnSec, padding: '3px 8px' }} onClick={onCancel}>Cancel</button>
    </div>
  )
}

const th: React.CSSProperties = { textAlign: 'left', padding: '10px 14px', color: '#888', fontWeight: 500, fontSize: 12 }
const td: React.CSSProperties = { padding: '10px 14px', fontSize: 13 }
const badge = (color: string): React.CSSProperties => ({ marginLeft: 8, padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700, background: color + '22', color, border: `1px solid ${color}66` })

function extract(e: any): string {
  const m = String(e?.message || e || '')
  // api.ts throws "/api/auth/login → 401"; if our backend put a JSON body we don't see it here.
  // The api wrapper could be improved; for now show a friendly fallback.
  if (/401/.test(m)) return 'Invalid email or password.'
  if (/403/.test(m)) return 'Account deactivated or expired — contact admin.'
  if (/400/.test(m)) return 'Invalid input.'
  return m
}

// ── Auth guards ─────────────────────────────────────────────────
export function RequireAuth({ children, adminOnly = false, requireTab }: {
  children: JSX.Element
  adminOnly?: boolean
  requireTab?: string                // 'weekly' | 'daily' | ...
}): JSX.Element {
  const nav = useNavigate()
  const { data, isError, isLoading } = useQuery({ queryKey: ['me'], queryFn: () => api.me(), retry: false })
  useEffect(() => {
    if (isError) { auth.clear(); nav('/login') }
    if (data && adminOnly && !data.isAdmin) nav('/weekly-pick')
  }, [isError, data, adminOnly, nav])
  if (isLoading) return <div style={{ padding: 40, color: '#888' }}>Authenticating…</div>
  if (!data) return <></>
  if (requireTab && !data.isAdmin && !data.allowedTabs?.includes(requireTab)) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
        <h2 style={{ color: '#fff', fontSize: 20 }}>🔒 Access required</h2>
        <p>This tab isn't enabled on your account. Please contact the admin to request access.</p>
      </div>
    )
  }
  return children
}
