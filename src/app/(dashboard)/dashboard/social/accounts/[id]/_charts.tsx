'use client'

// Lazily loaded (recharts ~95KB) from account-dashboard-client.tsx.

import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'

const TOOLTIP_STYLE = {
  contentStyle: { background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 11 },
  labelStyle: { color: '#9ca3af' },
  trigger: 'click' as const,
  wrapperStyle: { zIndex: 50 },
}

const compact = (n: number) => Intl.NumberFormat('en', { notation: 'compact' }).format(n)
const shortDate = (d: any) => {
  try { return new Date(String(d)).toLocaleDateString('en', { day: 'numeric', month: 'short' }) } catch { return String(d ?? '') }
}

export function ReachViewsArea({
  data,
}: {
  data: { date: string; reach: number; views: number }[]
}) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gReach" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gViews" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.3} />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
        <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis tickFormatter={compact} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={38} />
        <Tooltip {...TOOLTIP_STYLE} labelFormatter={shortDate} formatter={(v: any, n: any) => [compact(Number(v)), n]} />
        <Area type="monotone" dataKey="reach" name="Reach" stroke="#7c3aed" strokeWidth={2} fill="url(#gReach)" />
        <Area type="monotone" dataKey="views" name="Views" stroke="#22d3ee" strokeWidth={2} fill="url(#gViews)" />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function FollowerLine({
  data,
}: {
  data: { date: string; followers: number | null }[]
}) {
  const clean = data.filter((d) => d.followers != null)
  return (
    <ResponsiveContainer width="100%" height={180}>
      <LineChart data={clean} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
        <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} minTickGap={24} />
        <YAxis tickFormatter={compact} tick={{ fontSize: 10, fill: '#6b7280' }} axisLine={false} tickLine={false} width={38} domain={['auto', 'auto']} />
        <Tooltip {...TOOLTIP_STYLE} labelFormatter={shortDate} formatter={(v: any) => [compact(Number(v)), 'Followers']} />
        <Line type="monotone" dataKey="followers" name="Followers" stroke="#34d399" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}
