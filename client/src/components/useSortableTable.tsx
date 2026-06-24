import React, { useState, useMemo } from 'react'

/**
 * Shared column-sorting helper used across every public + localhost picks
 * table (Weekly Pick / Daily Pick / 5-20% Move / Top Trades / Track Record).
 *
 * Usage:
 *   const { rows, sortKey, sortDir, toggleSort, headerProps } = useSortableTable(
 *     allRows,
 *     { key: 'score', dir: 'desc' },     // initial sort
 *     { score: r => r.totalScore, vol5d: r => r.vol5dRatio ?? 0, … },
 *   )
 *   <th {...headerProps('score')}>Score</th>
 *
 * Click on a <th> toggles asc → desc → off (back to initial). Visual arrow
 * appears in the header. Strings sort lexicographically; numbers numerically;
 * null/undefined always sort last regardless of direction.
 */
export type SortDir = 'asc' | 'desc' | null
export interface SortState { key: string; dir: SortDir }

export function useSortableTable<T>(
  rows: T[],
  initial: SortState,
  accessors: Record<string, (r: T) => string | number | null | undefined>,
): {
  rows: T[]
  sortKey: string
  sortDir: SortDir
  toggleSort: (key: string) => void
  headerProps: (key: string, extraClass?: string) => {
    onClick: () => void
    className: string
    'aria-sort': 'ascending' | 'descending' | 'none'
    style: React.CSSProperties
  }
  sortIndicator: (key: string) => React.ReactNode
} {
  const [state, setState] = useState<SortState>(initial)

  const sorted = useMemo(() => {
    if (!state.dir || !accessors[state.key]) return rows
    const accessor = accessors[state.key]
    const dir = state.dir
    return rows.slice().sort((a, b) => {
      const va = accessor(a)
      const vb = accessor(b)
      // null/undefined always to end
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      let cmp: number
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
      else cmp = String(va).localeCompare(String(vb))
      return dir === 'asc' ? cmp : -cmp
    })
  }, [rows, state, accessors])

  const toggleSort = (key: string): void => {
    setState(s => {
      if (s.key !== key) return { key, dir: 'desc' }
      if (s.dir === 'desc') return { key, dir: 'asc' }
      if (s.dir === 'asc') return initial             // 3rd click → reset
      return { key, dir: 'desc' }
    })
  }

  const sortIndicator = (key: string): React.ReactNode => {
    if (state.key !== key || !state.dir) return <span className="text-neutral-700 ml-0.5">↕</span>
    return <span className="text-accent-cyan ml-0.5">{state.dir === 'asc' ? '▲' : '▼'}</span>
  }

  const headerProps = (key: string, extraClass?: string): { onClick: () => void; className: string; 'aria-sort': 'ascending' | 'descending' | 'none'; style: React.CSSProperties } => ({
    onClick: () => toggleSort(key),
    className: ['cursor-pointer select-none hover:text-accent-cyan transition-colors', extraClass].filter(Boolean).join(' '),
    'aria-sort': state.key === key && state.dir === 'asc' ? 'ascending' : state.key === key && state.dir === 'desc' ? 'descending' : 'none',
    style: { userSelect: 'none' },
  })

  return { rows: sorted, sortKey: state.key, sortDir: state.dir, toggleSort, headerProps, sortIndicator }
}
