'use client'

// Recharts is ~95 KB min+gz. Charts are pulled in lazily via next/dynamic
// from dashboard-client.tsx so they never load until the dashboard renders.

import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts'

const TOOLTIP_STYLE = {
  contentStyle: { background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11 },
  labelStyle: { color: '#9ca3af' },
  trigger: 'click' as const,
  wrapperStyle: { zIndex: 50 },
}

// ── Income vs Outflow (admin trends tab) ───────────────────────────────────
export function IncomeOutflowBar({
  data, fmt,
}: {
  data: { period: string; inflow: number; outflow: number }[]
  fmt: (n: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
        <XAxis dataKey="period" tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} width={50} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(v: any, name: any) => [fmt(Number(v)), name]} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="inflow"  name="Income"  fill="#7c3aed" radius={[3, 3, 0, 0]} maxBarSize={24} />
        <Bar dataKey="outflow" name="Outflow" fill="#f87171" radius={[3, 3, 0, 0]} maxBarSize={24} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Jobs done value + count (admin trends tab) ─────────────────────────────
export function JobsDoneBar({
  data, fmt,
}: {
  data: { period: string; taskValue: number; taskCount: number }[]
  fmt: (n: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} barGap={2}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
        <XAxis dataKey="period" tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} />
        <YAxis yAxisId="val" tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} width={50} />
        <YAxis yAxisId="cnt" orientation="right" tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={30} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(v: any, name: any) => [name === 'Count' ? v : fmt(Number(v)), name]} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar yAxisId="val" dataKey="taskValue" name="Value" fill="#34d399" radius={[3, 3, 0, 0]} maxBarSize={20} />
        <Bar yAxisId="cnt" dataKey="taskCount" name="Count" fill="#60a5fa" radius={[3, 3, 0, 0]} maxBarSize={10} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Employee contribution activity (employee dashboard) ────────────────────
// Overlays tasks (purple bar) and creatives (teal bar) per period — see the
// "Tasks vs. Creatives" distinction: tasks = jobs contributed to, creatives =
// production output credited (qty × score% share).
export function ContributionActivityBar({
  data,
}: {
  data: { period: string; count: number; creatives?: number }[]
}) {
  const hasCreatives = data.some(d => (d.creatives ?? 0) > 0)
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
        <XAxis dataKey="period" tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{ background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: '#9ca3af', marginBottom: 4 }}
          cursor={{ fill: 'rgba(255,255,255,0.05)' }}
          formatter={(val, name) => [val, name === 'count' ? 'Tasks' : 'Creatives']}
        />
        <Bar dataKey="count"     fill="#a855f7" radius={[4, 4, 0, 0]} maxBarSize={28} name="Tasks" />
        {hasCreatives && (
          <Bar dataKey="creatives" fill="#14b8a6" radius={[4, 4, 0, 0]} maxBarSize={28} name="Creatives" />
        )}
      </BarChart>
    </ResponsiveContainer>
  )
}
