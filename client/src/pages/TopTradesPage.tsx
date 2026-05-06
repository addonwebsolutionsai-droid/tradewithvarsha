import { useQuery } from '@tanstack/react-query'
import { api } from '../api'

/**
 * Top Trades — single curated stream of highest-conviction picks across every
 * engine (weekly / daily / master). Replaces the noisy multi-tab view; user
 * sees ONE feed with full plan: entry date / level / SL / target dates+prices.
 */
export function TopTradesPage(): JSX.Element {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['top-trades'],
    queryFn: () => api.topTrades(85, 20),
    refetchInterval: 60_000,
  })
  const rows: any[] = data?.rows ?? []

  return (
    <div style={{ padding: 20, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🎯 Top Trades</h1>
        <span style={{ color: '#888', fontSize: 13 }}>
          {data ? `${rows.length} of ${data.totalAvailable} setups · conviction ≥ ${data.filterMinConv}` : ''}
        </span>
        <button onClick={() => refetch()} style={btn}>Refresh</button>
      </div>
      {isLoading && <div style={{ color: '#888' }}>Loading…</div>}
      {!isLoading && rows.length === 0 && (
        <div style={{ color: '#888', padding: 40, textAlign: 'center', border: '1px dashed #444', borderRadius: 8 }}>
          No setups currently meet the conviction threshold. Re-run a pick or lower the bar.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 12 }}>
        {rows.map((r, i) => <Card key={i} r={r} />)}
      </div>
    </div>
  )
}

function Card({ r }: { r: any }): JSX.Element {
  const dirColor = r.direction === 'BUY' ? '#0a8042' : '#b81e1e'
  const dirBg = r.direction === 'BUY' ? '#0a804220' : '#b81e1e20'
  return (
    <div style={{ background: '#1a1d23', border: '1px solid #2d3038', borderRadius: 8, padding: 12, position: 'relative' }}>
      {r.noBrainer && <div style={{ position: 'absolute', top: -8, right: 12, background: '#f5c518', color: '#000', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>⭐ NO-BRAINER</div>}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>{r.symbol}</span>
        <span style={{ color: dirColor, background: dirBg, padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>{r.direction}</span>
        <span style={{ background: '#2d3038', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>{r.conviction}/100</span>
        <span style={{ color: '#888', fontSize: 11 }}>{r.source}</span>
      </div>
      {r.shareholdingNote && (
        <div style={{ background: '#0d0f13', padding: '4px 8px', borderRadius: 4, fontSize: 11, fontFamily: 'ui-monospace, Menlo', color: '#bbb', marginBottom: 8 }}>
          📊 {r.shareholdingNote}
        </div>
      )}
      <Row label="LTP" val={`₹${r.ltp}`} />
      <Row label="Entry" val={`₹${r.entryPriceLow}–${r.entryPriceHigh}`} sub={r.entryDate} />
      <Row label="SL" val={`₹${r.stopLoss}`} color="#b81e1e" />
      <Row label="T1" val={`₹${r.target1}`} sub={r.target1Date} color="#0a8042" />
      <Row label="T2" val={`₹${r.target2}`} sub={r.target2Date} color="#0a8042" />
      <Row label="T3" val={`₹${r.target3}`} sub={r.target3Date} color="#0a8042" />
      {r.reasoning && <div style={{ marginTop: 8, fontSize: 11, color: '#888', borderTop: '1px solid #2d3038', paddingTop: 6 }}>{r.reasoning}</div>}
    </div>
  )
}

function Row({ label, val, sub, color }: { label: string; val: string; sub?: string; color?: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 13, padding: '2px 0' }}>
      <span style={{ color: '#888', minWidth: 40 }}>{label}</span>
      <span style={{ fontFamily: 'ui-monospace, Menlo', color: color || '#fff', fontWeight: 600 }}>{val}</span>
      {sub && <span style={{ color: '#888', fontSize: 11 }}>{sub}</span>}
    </div>
  )
}

const btn: React.CSSProperties = { padding: '4px 12px', background: '#2d3038', color: '#fff', border: '1px solid #444', borderRadius: 4, cursor: 'pointer', fontSize: 12 }
