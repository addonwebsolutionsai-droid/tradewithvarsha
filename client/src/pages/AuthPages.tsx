import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, auth } from '../api'

const card: React.CSSProperties = {
  maxWidth: 400, margin: '60px auto', padding: 32,
  background: '#1a1d23', border: '1px solid #2d3038', borderRadius: 8,
}
const input: React.CSSProperties = {
  width: '100%', padding: '10px 12px', marginBottom: 12,
  background: '#0d0f13', border: '1px solid #2d3038', borderRadius: 4,
  color: '#fff', fontSize: 14,
}
const btnPrimary: React.CSSProperties = {
  width: '100%', padding: '10px', background: '#0a8042', color: '#fff',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 14, fontWeight: 600,
}
const btnSec: React.CSSProperties = {
  padding: '6px 14px', background: '#2d3038', color: '#fff',
  border: '1px solid #444', borderRadius: 4, cursor: 'pointer', fontSize: 12,
}
const errStyle: React.CSSProperties = { color: '#ff6b6b', fontSize: 13, marginBottom: 12 }
const okStyle: React.CSSProperties = { color: '#0a8042', fontSize: 13, marginBottom: 12 }

export function LoginPage(): JSX.Element {
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setErr(''); setBusy(true)
    try {
      const r = await api.login(email, password)
      if (!r.ok || !r.token) { setErr(r.error || 'login failed'); return }
      auth.setToken(r.token)
      nav('/top-trades')
    } catch (e: any) { setErr(String(e.message || e)) }
    finally { setBusy(false) }
  }

  return (
    <div style={card}>
      <h1 style={{ marginTop: 0, marginBottom: 20, fontSize: 22 }}>🔒 Sign in</h1>
      <form onSubmit={submit}>
        <input style={input} type="email" placeholder="email" value={email}
               onChange={e => setEmail(e.target.value)} required autoFocus />
        <input style={input} type="password" placeholder="password (min 8 chars)" value={password}
               onChange={e => setPassword(e.target.value)} required />
        {err && <div style={errStyle}>{err}</div>}
        <button style={btnPrimary} type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div style={{ marginTop: 16, fontSize: 13, color: '#888' }}>
        New here? <Link to="/signup" style={{ color: '#5dade2' }}>Create an account</Link>
      </div>
    </div>
  )
}

export function SignupPage(): JSX.Element {
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setErr(''); setBusy(true)
    if (password !== confirm) { setErr('passwords do not match'); setBusy(false); return }
    try {
      const r = await api.signup(email, password)
      if (!r.ok || !r.token) { setErr(r.error || 'signup failed'); return }
      auth.setToken(r.token)
      nav('/top-trades')
    } catch (e: any) { setErr(String(e.message || e)) }
    finally { setBusy(false) }
  }

  return (
    <div style={card}>
      <h1 style={{ marginTop: 0, marginBottom: 20, fontSize: 22 }}>✨ Create account</h1>
      <form onSubmit={submit}>
        <input style={input} type="email" placeholder="email" value={email}
               onChange={e => setEmail(e.target.value)} required autoFocus />
        <input style={input} type="password" placeholder="password (min 8 chars)" value={password}
               onChange={e => setPassword(e.target.value)} required minLength={8} />
        <input style={input} type="password" placeholder="confirm password" value={confirm}
               onChange={e => setConfirm(e.target.value)} required minLength={8} />
        {err && <div style={errStyle}>{err}</div>}
        <button style={btnPrimary} type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <div style={{ marginTop: 12, color: '#888', fontSize: 12 }}>
        First user becomes admin automatically.
      </div>
      <div style={{ marginTop: 16, fontSize: 13, color: '#888' }}>
        Already registered? <Link to="/login" style={{ color: '#5dade2' }}>Sign in</Link>
      </div>
    </div>
  )
}

export function AdminUsersPage(): JSX.Element {
  const { data, refetch, isLoading } = useQuery({
    queryKey: ['admin-users'], queryFn: () => api.adminUsers(),
  })
  const [busy, setBusy] = useState<string>('')

  async function toggle(email: string): Promise<void> {
    setBusy(email)
    try { await api.toggleUser(email); await refetch() }
    finally { setBusy('') }
  }

  return (
    <div style={{ padding: 20, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ marginTop: 0 }}>👥 Users</h1>
      {isLoading && <div style={{ color: '#888' }}>Loading…</div>}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr style={{ background: '#1a1d23' }}>
            <th style={th}>Email</th>
            <th style={th}>Role</th>
            <th style={th}>Status</th>
            <th style={th}>Created</th>
            <th style={th}>Last login</th>
            <th style={th}>Action</th>
          </tr>
        </thead>
        <tbody>
          {(data?.users || []).map(u => (
            <tr key={u.email} style={{ borderBottom: '1px solid #2d3038' }}>
              <td style={td}>{u.email}</td>
              <td style={td}>{u.isAdmin ? 'admin' : 'user'}</td>
              <td style={{ ...td, color: u.isActive ? '#0a8042' : '#b81e1e' }}>
                {u.isActive ? 'active' : 'deactivated'}
              </td>
              <td style={td}>{new Date(u.createdAt).toLocaleDateString()}</td>
              <td style={td}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
              <td style={td}>
                {!u.isAdmin && (
                  <button style={btnSec} onClick={() => toggle(u.email)} disabled={busy === u.email}>
                    {u.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const th: React.CSSProperties = { textAlign: 'left', padding: 10, color: '#888', fontWeight: 500, fontSize: 12, borderBottom: '1px solid #2d3038' }
const td: React.CSSProperties = { padding: 10, fontSize: 13 }

/** RequireAuth wrapper — redirects to /login if no valid token. */
export function RequireAuth({ children, adminOnly = false }: { children: JSX.Element; adminOnly?: boolean }): JSX.Element {
  const nav = useNavigate()
  const { data, isError, isLoading } = useQuery({
    queryKey: ['me'], queryFn: () => api.me(), retry: false,
  })
  useEffect(() => {
    if (isError) { auth.clear(); nav('/login') }
    if (data && adminOnly && !data.isAdmin) nav('/top-trades')
  }, [isError, data, adminOnly, nav])
  if (isLoading) return <div style={{ padding: 40, color: '#888' }}>Authenticating…</div>
  if (!data) return <></>
  return children
}
