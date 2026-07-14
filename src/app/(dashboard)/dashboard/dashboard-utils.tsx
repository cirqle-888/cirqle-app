'use client'

// ─────────────────────────────────────────────────────────────────────────────
// Shared dashboard primitives
//
// Lives in its own module so both the instant **shell** (`dashboard-client.tsx`)
// and the Suspense-streamed **analytics** child (`dashboard-analytics.tsx`) can
// import these helpers/constants/components without duplicating them or creating
// a circular import (client → analytics → utils; client → utils).
//
// Behaviour is byte-for-byte identical to the originals that previously lived
// inline in `dashboard-client.tsx` — this file only relocates them.
// ─────────────────────────────────────────────────────────────────────────────

import dynamic from 'next/dynamic'
import { useState, useEffect, useCallback } from 'react'
import { TrendingUp, TrendingDown } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────
export type Granularity = 'daily' | 'monthly' | 'quarterly' | 'yearly'
export type PulseTab = 'trends' | 'invoices' | 'performance' | 'insights'
export type DrawerType = 'today' | 'missing' | 'overdue' | 'due' | 'toBeInvoiced' | 'active' | null

// ─── Constants ─────────────────────────────────────────────────────────────────
export const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
  in_progress: 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  done: 'bg-green-500/15 text-green-400 border-green-500/20',
  invoiced: 'bg-purple-500/15 text-purple-400 border-purple-500/20',
}

// ─── Recharts is lazy-loaded — only fetched when a chart is rendered. ──────────
// Saves ~95 KB on initial bundle & TTI for the (employee) dashboard, where
// charts may never even appear above the fold.
const ChartSkeleton = ({ h = 200 }: { h?: number }) => (
  <div className="w-full bg-secondary/30 rounded animate-pulse" style={{ height: h }} />
)
export const IncomeOutflowBar = dynamic(
  () => import('./_charts').then(m => m.IncomeOutflowBar),
  { ssr: false, loading: () => <ChartSkeleton h={200} /> },
)
export const JobsDoneBar = dynamic(
  () => import('./_charts').then(m => m.JobsDoneBar),
  { ssr: false, loading: () => <ChartSkeleton h={180} /> },
)
export const ContributionActivityBar = dynamic(
  () => import('./_charts').then(m => m.ContributionActivityBar),
  { ssr: false, loading: () => <ChartSkeleton h={240} /> },
)
export const DashboardTrendGraph = dynamic(
  () => import('./_trend-graph').then(m => m.DashboardTrendGraph),
  { ssr: false, loading: () => <ChartSkeleton h={460} /> },
)

// ─── Amount display mode (short = 1.5L / full = 1,50,000) ────────────────────
const AMOUNT_DISPLAY_KEY = 'cirqle-amount-display'
export type AmountDisplay = 'short' | 'full'

export function useAmountDisplay() {
  const [mode, setModeState] = useState<AmountDisplay>('short')
  useEffect(() => {
    try {
      const stored = localStorage.getItem(AMOUNT_DISPLAY_KEY)
      if (stored === 'full') setModeState('full')
    } catch { /* localStorage unavailable */ }
  }, [])
  const setMode = useCallback((m: AmountDisplay) => {
    setModeState(m)
    try { localStorage.setItem(AMOUNT_DISPLAY_KEY, m) } catch { /* ignore */ }
  }, [])
  return [mode, setMode] as const
}

// ─── Formatters ────────────────────────────────────────────────────────────────
export function fmt(n: number) {
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`
  if (n >= 1000)   return `₹${(n / 1000).toFixed(1)}K`
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
export function fmtFull(n: number) {
  return `₹${Math.round(n).toLocaleString('en-IN')}`
}
export function fmtDate(d: string) {
  if (!d) return ''
  return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
export function daysLate(due: string): number {
  const d = new Date(due + 'T12:00:00')
  const now = new Date(); now.setHours(12, 0, 0, 0)
  return Math.floor((now.getTime() - d.getTime()) / 86400000)
}
export function daysToGo(due: string): number {
  const d = new Date(due + 'T12:00:00')
  const now = new Date(); now.setHours(12, 0, 0, 0)
  return Math.ceil((d.getTime() - now.getTime()) / 86400000)
}

// ─── Period-key helpers (shared by admin analytics + employee dashboard) ──────
export function getPeriodKey(dateStr: string, g: Granularity): string {
  if (!dateStr) return ''
  const d = new Date(dateStr + 'T12:00:00')
  if (g === 'daily')     return dateStr
  if (g === 'monthly')   return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  if (g === 'quarterly') { const q = Math.ceil((d.getMonth() + 1) / 3); return `${d.getFullYear()}-Q${q}` }
  return `${d.getFullYear()}`
}
export function getPeriodLabel(key: string, g: Granularity): string {
  if (g === 'daily')   return key ? fmtDate(key) : key
  if (g === 'monthly') { const [y, m] = key.split('-'); return `${MONTH_NAMES[parseInt(m) - 1]} ${y?.slice(2)}` }
  return key
}

// ─── StatusBadge (used by the shell Drawer + analytics Active Tasks) ──────────
export function StatusBadge({ status }: { status: string }) {
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full border ${STATUS_COLOR[status] || STATUS_COLOR.pending}`}>{status?.replace('_', ' ')}</span>
}

// Re-exported so consumers that build trend UI don't each import lucide directly.
export { TrendingUp, TrendingDown }
