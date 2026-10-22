/**
 * Plain helpers shared by server pages and client components. NOT a client
 * module: a server component may call these directly, which it cannot do with
 * anything exported from a 'use client' file.
 */

export const inr = (v: number | null | undefined) =>
  v == null ? '—'
    : `${Number(v) < 0 ? '−' : ''}₹${Math.abs(Number(v)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const pct = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${(v * 100).toLocaleString('en-IN', { maximumFractionDigits: digits })}%`

export const monthLabel = (d: string) =>
  new Date(`${d.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })

export const periodLabel = (start: string, end: string) =>
  start.slice(0, 7) === end.slice(0, 7) ? monthLabel(start) : `${monthLabel(start)} – ${monthLabel(end)}`

export const STATUS_TONE: Record<string, 'muted' | 'good' | 'warn' | 'bad' | 'info'> = {
  draft: 'muted', calculated: 'info', reviewed: 'warn', confirmed: 'good', void: 'bad',
  pending_approval: 'warn', approved: 'good', rejected: 'bad', ended: 'muted',
  settled: 'good', reinvested: 'good', waived: 'muted',
}

export const inputCls =
  'w-full rounded-lg border border-border bg-secondary px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50'

export const td = 'px-2 py-2 align-top'

export const tdNum = 'px-2 py-2 text-right align-top tabular-nums'
