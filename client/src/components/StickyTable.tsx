import React from 'react'

/**
 * Shared sticky-scroll table primitives — applies the UX upgrade the user
 * approved on Weekly Pick to any other listing page in one line.
 *
 * Three pieces working together:
 *   1. <StickyScrollBox> — wraps the table. Max-height = 75vh so the
 *      horizontal scrollbar is always inside the viewport, never buried
 *      at the bottom of a 50-row tall table.
 *   2. <thead className="sticky top-0 z-20"> — column labels stay visible
 *      while scrolling rows vertically.
 *   3. STICKY_FIRST_COL constant — apply to the first <th> and first <td>
 *      of each row to pin the leftmost column in place while scrolling
 *      horizontally. Use STICKY_FIRST_COL_HEADER on <th> (extra z-index so
 *      the corner cell stays above the body).
 *
 * NOTE: the parent <table> MUST use `border-separate` with `borderSpacing: 0`.
 * `border-collapse: collapse` (the browser default) silently disables sticky
 * positioning on table cells. We pass the right styles via the StickyTable
 * helper to avoid forgetting this.
 */

export function StickyScrollBox({ children, maxHeight = '75vh' }: { children: React.ReactNode; maxHeight?: string }): JSX.Element {
  return (
    <div className="overflow-auto rounded-lg border border-ink-500 bg-ink-800" style={{ maxHeight }}>
      {children}
    </div>
  )
}

export function StickyTable({ children, minWidth = 1200, className = '' }: { children: React.ReactNode; minWidth?: number; className?: string }): JSX.Element {
  return (
    <table className={`w-full border-separate ${className}`} style={{ borderSpacing: 0, minWidth }}>
      {children}
    </table>
  )
}

// Apply to the <thead> of a StickyTable so column labels stick to the top
// of the scroll viewport. Use as: <thead className={STICKY_THEAD}>.
export const STICKY_THEAD = 'bg-ink-700 text-neutral-400 sticky top-0 z-20'

// First column (header cell) — sticks to the left edge while horizontal
// scrolling. z-30 so it stays above the body when scrolled.
export const STICKY_FIRST_COL_HEADER = 'sticky left-0 z-30 bg-ink-700 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]'

// First column (body cell) — same sticky behaviour. Pass the row's tint
// className in addition so the sticky cell matches the row colour.
export const STICKY_FIRST_COL_BODY = 'sticky left-0 z-10 border-r border-ink-500 shadow-[2px_0_4px_rgba(0,0,0,0.4)]'
