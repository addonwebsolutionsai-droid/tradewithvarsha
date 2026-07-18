/**
 * /desk shared hooks — sortable tables + global search.
 */
import { useMemo, useState } from 'react'

export type SortDir = 'asc' | 'desc'
export interface SortState { key: string; dir: SortDir }

/** A column definition consumed by useSortable + <SortableTh>. */
export interface SortableColumn<T> {
  key: string
  accessor: (row: T) => number | string | undefined | null
}

export function useSortable<T>(
  rows: T[],
  initial: SortState,
  columns: SortableColumn<T>[],
) {
  const [sort, setSort] = useState<SortState>(initial)
  const map = useMemo(() => {
    const m = new Map<string, SortableColumn<T>>()
    for (const c of columns) m.set(c.key, c)
    return m
  }, [columns])
  const sorted = useMemo(() => {
    const col = map.get(sort.key)
    if (!col) return rows
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = col.accessor(a)
      const bv = col.accessor(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  }, [rows, sort, map])
  const onSort = (key: string) => setSort(prev => (prev.key === key
    ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'desc' }))
  const indicator = (key: string) => sort.key === key
    ? (sort.dir === 'desc' ? ' ↓' : ' ↑')
    : ''
  return { sortedRows: sorted, sort, onSort, indicator }
}

/** Match a symbol/name against a search query. Case-insensitive prefix + contains. */
export function matchesQuery(row: { symbol?: string; instrument?: string; name?: string }, q: string): boolean {
  if (!q) return true
  const needle = q.trim().toUpperCase()
  if (needle.length === 0) return true
  const parts = needle.split(/[\s,]+/).filter(Boolean)
  const hay = `${row.symbol ?? ''} ${row.instrument ?? ''} ${row.name ?? ''}`.toUpperCase()
  return parts.some(p => hay.includes(p))
}
