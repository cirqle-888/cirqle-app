'use client'

// Recharts is ~95 KB min+gz — loaded lazily via next/dynamic from the client so
// it only ships when the Executive tab renders. Mirrors reports/_charts.tsx.

import {
  BarChart, Bar, LineChart, Line, ComposedChart, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend, CartesianGrid, Cell,
} from 'recharts'
import type { RetainerTrendPoint } from '@/lib/agreements/analytics'

const AXIS = { fontSize: 10, fill: '#6b7280' }
const GRID = 'rgba(148,163,184,0.15)'
const TOOLTIP = {
  contentStyle: { background: '#1a1f2e', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#9ca3af' },
  wrapperStyle: { zIndex: 50 },
}
const inrK = (v: number) => `₹${(v / 1000).toFixed(0)}K`
const inrFull = (v: number) => `₹${Number(v).toLocaleString('en-IN')}`

// 1. Monthly revenue trend (retainer revenue in INR).
export function RevenueTrendChart({ data }: { data: RetainerTrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} />
        <YAxis tick={AXIS} tickFormatter={inrK} width={44} />
        <Tooltip {...TOOLTIP} formatter={(v: any, n: any) => [inrFull(v), n === 'revenue' ? 'Retainer revenue' : 'Creative allocation']} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="revenue" name="Retainer revenue" stroke="#7c3aed" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 5 }} />
        <Line type="monotone" dataKey="creativeAllocation" name="Creative allocation" stroke="#38bdf8" strokeWidth={2} strokeDasharray="4 3" dot={false} />
      </LineChart>
    </ResponsiveContainer>
  )
}

// 2. Gross margin trend (revenue vs cost bars + margin% line).
export function MarginTrendChart({ data }: { data: RetainerTrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} />
        <YAxis yAxisId="l" tick={AXIS} tickFormatter={inrK} width={44} />
        <YAxis yAxisId="r" orientation="right" tick={AXIS} tickFormatter={v => `${v}%`} width={36} />
        <Tooltip {...TOOLTIP} formatter={(v: any, n: any) => n === 'marginPct' ? [`${v}%`, 'Margin %'] : [inrFull(v), n === 'grossMargin' ? 'Gross margin' : 'Internal cost']} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar yAxisId="l" dataKey="grossMargin" name="Gross margin" fill="#10b981" fillOpacity={0.8} radius={[4, 4, 0, 0]} barSize={16} />
        <Bar yAxisId="l" dataKey="internalCost" name="Internal cost" fill="#f59e0b" fillOpacity={0.7} radius={[4, 4, 0, 0]} barSize={16} />
        <Line yAxisId="r" type="monotone" dataKey="marginPct" name="Margin %" stroke="#7c3aed" strokeWidth={2} dot={{ r: 2 }} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// 3. Revenue vs internal cost vs creative allocation.
export function RevenueVsCostChart({ data }: { data: RetainerTrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }} barSize={12}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} />
        <YAxis tick={AXIS} tickFormatter={inrK} width={44} />
        <Tooltip {...TOOLTIP} formatter={(v: any, n: any) => [inrFull(v), n === 'revenue' ? 'Revenue' : n === 'creativeAllocation' ? 'Creative allocation' : 'Internal cost']} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="revenue" name="Revenue" fill="#7c3aed" fillOpacity={0.85} radius={[3, 3, 0, 0]} />
        <Bar dataKey="creativeAllocation" name="Creative allocation" fill="#38bdf8" fillOpacity={0.85} radius={[3, 3, 0, 0]} />
        <Bar dataKey="internalCost" name="Internal cost" fill="#f59e0b" fillOpacity={0.85} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

// 4. Utilisation trend (delivered vs included bars + utilisation% line).
export function UtilisationTrendChart({ data }: { data: RetainerTrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS} />
        <YAxis yAxisId="l" tick={AXIS} width={30} />
        <YAxis yAxisId="r" orientation="right" tick={AXIS} tickFormatter={v => `${v}%`} width={36} />
        <Tooltip {...TOOLTIP} formatter={(v: any, n: any) => n === 'avgUtilisation' ? [`${v}%`, 'Avg utilisation'] : [String(v), n === 'delivered' ? 'Delivered' : 'Included']} />
        <Legend wrapperStyle={{ fontSize: 11 }} />
        <Bar yAxisId="l" dataKey="included" name="Included" fill="#475569" fillOpacity={0.55} radius={[4, 4, 0, 0]} barSize={16} />
        <Bar yAxisId="l" dataKey="delivered" name="Delivered" fill="#10b981" fillOpacity={0.85} radius={[4, 4, 0, 0]} barSize={16} />
        <Line yAxisId="r" type="monotone" dataKey="avgUtilisation" name="Avg utilisation" stroke="#7c3aed" strokeWidth={2} dot={{ r: 2 }} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// 5. Horizontal-ish top clients bar (revenue). Reused for margin too.
export function TopClientsChart({ data, colorFor }: {
  data: { name: string; value: number }[]
  colorFor?: (i: number) => string
}) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 34)}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 12 }} barSize={16}>
        <XAxis type="number" tick={AXIS} tickFormatter={inrK} />
        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#9ca3af' }} width={110} />
        <Tooltip {...TOOLTIP} formatter={(v: any) => [inrFull(v), 'Revenue']} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
          {data.map((_, i) => <Cell key={i} fill={colorFor ? colorFor(i) : '#7c3aed'} fillOpacity={0.85} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
