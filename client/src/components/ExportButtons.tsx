import React, { useCallback, useMemo } from 'react'

/**
 * Universal export buttons for any tab.
 *
 * Two paths:
 *   1. SERVER mode — pass `dataset` (e.g. "master-setup", "weekly-pick") and
 *      we hit /api/export/<dataset> with the right format. Best when the
 *      server has the canonical dataset cached (master-setup, daily-pick, etc).
 *
 *   2. CLIENT mode — pass `rows` + `columns` and we build the CSV / printable
 *      HTML in the browser. Best for tabs where the data is page-state only
 *      (filtered grids, custom queries, ad-hoc views).
 *
 * Either mode produces a clean CSV download AND a print-styled HTML window
 * the user's browser can save as PDF natively (no PDF library needed —
 * matches the user's "free-tier only / minimum cost" preference).
 */

export type ExportColumn<T = any> = {
  key: string
  header: string
  accessor?: (row: T) => string | number | null | undefined
}

interface CommonProps {
  /** Filename slug (no extension). Defaults to "export-<date>". */
  slug?: string
  /** Title shown in the printable HTML. */
  title?: string
  /** Subtitle / context line. */
  subtitle?: string
  /** Tailwind class on the wrapper. */
  className?: string
  /** Show button labels (else just icons). Default true. */
  showLabels?: boolean
}

interface ServerProps extends CommonProps {
  dataset: 'master-setup' | 'sector-rotation' | 'weekly-pick' | 'daily-pick' | 'signals' | 'turtle-soup' | 'harmonic-scan'
  rows?: undefined
  columns?: undefined
}

interface ClientProps<T> extends CommonProps {
  dataset?: undefined
  rows: T[]
  columns: ExportColumn<T>[]
}

export type ExportButtonsProps<T = any> = ServerProps | ClientProps<T>

export function ExportButtons<T = any>(props: ExportButtonsProps<T>) {
  const slug = useMemo(() => {
    const d = new Date().toISOString().slice(0, 10)
    return `${props.slug ?? 'export'}-${d}`
  }, [props.slug])

  const onExportCsv = useCallback(() => {
    if ('dataset' in props && props.dataset) {
      // Server-side CSV
      const url = `/api/export/${props.dataset}?format=csv`
      window.location.assign(url)
      return
    }
    // Client-side CSV
    if (!props.rows || !props.columns) return
    const csv = buildCsv(props.title ?? props.slug ?? 'Export', props.subtitle, props.columns, props.rows)
    triggerDownload(`${slug}.csv`, csv, 'text/csv;charset=utf-8')
  }, [props, slug])

  const onExportPdf = useCallback(() => {
    if ('dataset' in props && props.dataset) {
      // Server-rendered printable HTML — opens in a new tab; user hits "Save as PDF"
      const url = `/api/export/${props.dataset}?format=html`
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
    // Client-side printable HTML — opened in a new tab via a Blob URL
    if (!props.rows || !props.columns) return
    const html = buildPrintableHtml(
      props.title ?? props.slug ?? 'Export',
      props.subtitle,
      props.columns,
      props.rows,
    )
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const win = window.open(url, '_blank', 'noopener,noreferrer')
    // Trigger native print after the new tab loads (browser saves as PDF)
    if (win) {
      win.addEventListener('load', () => setTimeout(() => win.print(), 250), { once: true })
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }, [props, slug])

  const showLabels = props.showLabels !== false
  return (
    <div className={`flex items-center gap-2 ${props.className ?? ''}`}>
      <button
        type="button"
        onClick={onExportCsv}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md
                   border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700
                   focus:outline-none focus:ring-1 focus:ring-zinc-500 transition"
        title="Download CSV"
      >
        <span aria-hidden>📊</span>
        {showLabels && <span>CSV</span>}
      </button>
      <button
        type="button"
        onClick={onExportPdf}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md
                   border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700
                   focus:outline-none focus:ring-1 focus:ring-zinc-500 transition"
        title="Open print view (Save as PDF)"
      >
        <span aria-hidden>📄</span>
        {showLabels && <span>PDF</span>}
      </button>
    </div>
  )
}

// ─── helpers ──────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function buildCsv<T>(
  title: string,
  subtitle: string | undefined,
  columns: ExportColumn<T>[],
  rows: T[],
): string {
  const lines: string[] = []
  lines.push(`# ${title}`)
  if (subtitle) lines.push(`# ${subtitle}`)
  lines.push(columns.map(c => c.header).join(','))
  for (const r of rows) {
    lines.push(columns.map(c => csvCell(c.accessor ? c.accessor(r) : (r as any)[c.key])).join(','))
  }
  return lines.join('\n')
}

function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildPrintableHtml<T>(
  title: string,
  subtitle: string | undefined,
  columns: ExportColumn<T>[],
  rows: T[],
): string {
  const headerRow = columns.map(c => `<th>${escapeHtml(c.header)}</th>`).join('')
  const dataRows = rows.map(r =>
    `<tr>${columns.map(c => `<td>${escapeHtml(c.accessor ? c.accessor(r) : (r as any)[c.key])}</td>`).join('')}</tr>`,
  ).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font: 11px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #555; margin: 0 0 10px; font-size: 11px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; font-weight: 600; }
  tr:nth-child(even) td { background: #fafafa; }
  .footer { margin-top: 14px; font-size: 10px; color: #888; }
  @media print { .no-print { display: none; } }
  .actions { margin: 8px 0 16px; }
  .actions button {
    background: #111; color: #fff; border: 0; padding: 6px 12px;
    border-radius: 4px; font-size: 12px; cursor: pointer; margin-right: 6px;
  }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${escapeHtml(subtitle ?? '')}</p>
  <div class="actions no-print">
    <button onclick="window.print()">🖨️ Save as PDF / Print</button>
    <button onclick="window.close()">Close</button>
  </div>
  <table>
    <thead><tr>${headerRow}</tr></thead>
    <tbody>${dataRows}</tbody>
  </table>
  <p class="footer">Generated by HedgeFund OS · #tradewithvarsha</p>
</body>
</html>`
}

function triggerDownload(filename: string, body: string, mime: string): void {
  const blob = new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export default ExportButtons
