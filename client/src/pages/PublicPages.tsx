/**
 * PublicWeeklyPick / PublicOptions / PublicIntraday
 *
 * Lightweight read-only pages for the Vercel deploy. Each fetches a single
 * static JSON snapshot from raw.githubusercontent.com and renders cards.
 * No backend dependency, no live signals, no admin actions.
 */
import { useQuery } from '@tanstack/react-query'
import { snapshots } from '../api'

const wrapStyle: React.CSSProperties = { padding: '20px', maxWidth: 1200, margin: '0 auto' }
const headStyle: React.CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }
const subStyle: React.CSSProperties = { color: '#888', fontSize: 13 }
const gridStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }
const cardStyle: React.CSSProperties = { background: '#1a1d23', border: '1px solid #2d3038', borderRadius: 8, padding: 12, position: 'relative' }
const stakeStyle: React.CSSProperties = { background: '#0d0f13', padding: '4px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'ui-monospace, Menlo', color: '#bbb', marginBottom: 8 }
const rowStyle: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 13, padding: '2px 0' }
const lblStyle: React.CSSProperties = { color: '#888', minWidth: 40 }
const valStyle: React.CSSProperties = { fontFamily: 'ui-monospace, Menlo', fontWeight: 600 }
const reasonStyle: React.CSSProperties = { marginTop: 8, fontSize: 11, color: '#888', borderTop: '1px solid #2d3038', paddingTop: 6 }

function fmtTs(iso: string | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
}

// ── WEEKLY PICK ─────────────────────────────────────────────────
export function PublicWeeklyPickPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-weekly'],
    queryFn: () => snapshots.weeklyPick(),
    refetchInterval: 5 * 60_000,
  })
  const rows: any[] = data?.rows ?? []

  return (
    <div style={wrapStyle}>
      <div style={headStyle}>
        <h1 style={{ margin: 0, fontSize: 22 }}>📋 Weekly Picks</h1>
        <span style={subStyle}>
          {data ? `${rows.length} setups · week of ${data.weekOf} · regime ${data.regime}` : ''}
        </span>
      </div>
      <div style={subStyle}>Last updated: {fmtTs(data?.generatedAt)} IST</div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load picks. The publisher may be offline." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No setups available right now." />}
      <div style={{ ...gridStyle, marginTop: 16 }}>
        {rows.map((r, i) => <WeeklyCard key={i} r={r} />)}
      </div>
    </div>
  )
}

function WeeklyCard({ r }: { r: any }): JSX.Element {
  const dirColor = r.direction === 'BUY' ? '#0a8042' : '#b81e1e'
  const dirBg = r.direction === 'BUY' ? '#0a804220' : '#b81e1e20'
  return (
    <div style={cardStyle}>
      {r.noBrainerBet && (
        <div style={{ position: 'absolute', top: -8, right: 12, background: '#f5c518', color: '#000', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>⭐ NO-BRAINER</div>
      )}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>{r.symbol}</span>
        <span style={{ color: dirColor, background: dirBg, padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>{r.direction}</span>
        <span style={{ background: '#2d3038', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>{r.conviction}/100</span>
      </div>
      {r.shareholdingNote && <div style={stakeStyle}>📊 {r.shareholdingNote}</div>}
      <PRow label="LTP" val={`₹${r.ltp}`} />
      <PRow label="Entry" val={`₹${r.entryPriceLow}–${r.entryPriceHigh}`} sub={r.entryDate} />
      <PRow label="SL" val={`₹${r.stopLoss}`} color="#b81e1e" />
      <PRow label="T1" val={`₹${r.target1}`} sub={r.target1Date} color="#0a8042" />
      <PRow label="T2" val={`₹${r.target2}`} sub={r.target2Date} color="#0a8042" />
      <PRow label="T3" val={`₹${r.target3}`} sub={r.target3Date} color="#0a8042" />
      {r.flowNote && <div style={reasonStyle}>{r.flowNote}</div>}
    </div>
  )
}

// ── OPTIONS ─────────────────────────────────────────────────────
export function PublicOptionsPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-options'],
    queryFn: () => snapshots.options(),
    refetchInterval: 5 * 60_000,
  })
  const rows: any[] = data?.rows ?? []
  return (
    <div style={wrapStyle}>
      <div style={headStyle}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🎯 Options Signals</h1>
        <span style={subStyle}>{rows.length} elite signals (score ≥ 9, conviction ≥ 90)</span>
      </div>
      <div style={subStyle}>Last updated: {fmtTs(data?.generatedAt)} IST</div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load options. Publisher may be offline." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No options signals right now. Re-check during market hours (9:15–15:30 IST)." />}
      <div style={{ ...gridStyle, marginTop: 16 }}>
        {rows.map((r, i) => <SignalCard key={i} r={r} />)}
      </div>
    </div>
  )
}

// ── INTRADAY ────────────────────────────────────────────────────
export function PublicIntradayPage(): JSX.Element {
  const { data, isLoading, error } = useQuery({
    queryKey: ['public-intraday'],
    queryFn: () => snapshots.intraday(),
    refetchInterval: 5 * 60_000,
  })
  const rows: any[] = data?.rows ?? []
  return (
    <div style={wrapStyle}>
      <div style={headStyle}>
        <h1 style={{ margin: 0, fontSize: 22 }}>⚡ Intraday Signals</h1>
        <span style={subStyle}>{rows.length} signals from today's session</span>
      </div>
      <div style={subStyle}>Last updated: {fmtTs(data?.generatedAt)} IST</div>
      {isLoading && <Loading />}
      {error && <Empty msg="Couldn't load intraday. Publisher may be offline." />}
      {!isLoading && !error && rows.length === 0 && <Empty msg="No intraday signals right now. Active 9:15–15:30 IST." />}
      <div style={{ ...gridStyle, marginTop: 16 }}>
        {rows.map((r, i) => <SignalCard key={i} r={r} />)}
      </div>
    </div>
  )
}

// ── shared signal card (options + intraday) ─────────────────────
function SignalCard({ r }: { r: any }): JSX.Element {
  const isLong = r.direction === 'BUY'
  const dirColor = isLong ? '#0a8042' : '#b81e1e'
  const dirBg = isLong ? '#0a804220' : '#b81e1e20'
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>{r.instrument}</span>
        <span style={{ color: dirColor, background: dirBg, padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>{r.direction}</span>
        <span style={{ background: '#2d3038', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>{r.grade} · {r.score?.toFixed?.(1) ?? r.score}</span>
      </div>
      <PRow label="Entry" val={`₹${r.entry}`} />
      <PRow label="SL" val={`₹${r.stopLoss}`} color="#b81e1e" />
      <PRow label="T1" val={`₹${r.target1}`} color="#0a8042" />
      {r.target2 && <PRow label="T2" val={`₹${r.target2}`} color="#0a8042" />}
      {r.riskReward && <PRow label="R:R" val={`1:${r.riskReward}`} />}
      {r.reasons?.length > 0 && <div style={reasonStyle}>{r.reasons.slice(0, 3).join(' · ')}</div>}
      <div style={{ ...subStyle, marginTop: 6, fontSize: 11 }}>{fmtTs(r.timestamp)} · {r.source}</div>
    </div>
  )
}

function PRow({ label, val, sub, color }: { label: string; val: string; sub?: string; color?: string }): JSX.Element {
  return (
    <div style={rowStyle}>
      <span style={lblStyle}>{label}</span>
      <span style={{ ...valStyle, color: color || '#fff' }}>{val}</span>
      {sub && <span style={{ color: '#888', fontSize: 11 }}>{sub}</span>}
    </div>
  )
}

function Loading(): JSX.Element {
  return <div style={{ color: '#888', padding: 40, textAlign: 'center' }}>Loading…</div>
}

function Empty({ msg }: { msg: string }): JSX.Element {
  return <div style={{ color: '#888', padding: 40, textAlign: 'center', border: '1px dashed #444', borderRadius: 8 }}>{msg}</div>
}
