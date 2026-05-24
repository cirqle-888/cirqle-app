'use client'

// Recharts is ~95 KB min+gz. This module exists so it's only loaded when the
// Reports page actually renders a chart — pulled in lazily via next/dynamic
// from reports-client.tsx.

import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'

const TOOLTIP_STYLE = {
  contentStyle: { background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#9ca3af' },
  trigger: 'click' as const,
  wrapperStyle: { zIndex: 50 },
}

// ── Monthly earnings (single color, used in Overview tab) ───────────────────
export function MonthlyEarningsBar({
  data, color, height = 176, barSize = 18,
}: {
  data: { month: string; earnings: number; tasks: number }[]
  color: string
  height?: number
  barSize?: number
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} barSize={barSize}>
        <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#6b7280' }} />
        <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}K`} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(v: any) => [`₹${Number(v).toLocaleString('en-IN')}`, 'Earnings']} />
        <Bar dataKey="earnings" radius={[4, 4, 0, 0]} fill={color} fillOpacity={0.85} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Score trend (line) ─────────────────────────────────────────────────────
export function ScoreTrendLine({
  data,
}: {
  data: { i: number; score: number; date: string }[]
}) {
  return (
    <ResponsiveContainer width="100%" height={176}>
      <LineChart data={data}>
        <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#6b7280' }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={v => `${v}%`} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(v: any) => [`${v}%`, 'Score']} />
        <Line type="monotone" dataKey="score" stroke="#7c3aed" strokeWidth={2}
          dot={{ r: 3, fill: '#7c3aed' }}
          activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Team earnings (one Bar with per-row Cell colors) ───────────────────────
export function TeamEarningsBar({
  data,
}: {
  data: { name: string; avgScore: number; totalEarnings: number; tasks: number; color: string }[]
}) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} barSize={32}>
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6b7280' }} />
        <YAxis tick={{ fontSize: 11, fill: '#6b7280' }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}K`} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(v: any, name: any) => [
          name === 'totalEarnings' ? `₹${Number(v).toLocaleString('en-IN')}` : `${v}%`,
          name === 'totalEarnings' ? 'Earnings' : 'Avg Score',
        ]} />
        <Bar dataKey="totalEarnings" radius={[5, 5, 0, 0]}>
          {data.map((row, i) => (
            <Cell key={i} fill={row.color} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Team avg score (color per band) ────────────────────────────────────────
export function TeamScoreBar({
  data, bandColorFor,
}: {
  data: { name: string; avgScore: number }[]
  bandColorFor: (avg: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} barSize={32}>
        <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#6b7280' }} />
        <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#6b7280' }} tickFormatter={v => `${v}%`} />
        <Tooltip {...TOOLTIP_STYLE} formatter={(v: any) => [`${v}%`, 'Avg Score']} />
        <Bar dataKey="avgScore" radius={[5, 5, 0, 0]}>
          {data.map((row, i) => (
            <Cell key={i} fill={bandColorFor(row.avgScore)} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
