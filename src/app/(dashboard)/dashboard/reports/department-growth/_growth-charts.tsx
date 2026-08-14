'use client'

// Recharts is ~95 KB min+gz. Isolated in its own client module so it loads only
// when this report renders — pulled in via next/dynamic from the server page.

import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

const TOOLTIP_STYLE = {
  contentStyle: {
    background: '#1a1f2e',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 8,
    fontSize: 12,
  },
  labelStyle: { color: '#9ca3af' },
  wrapperStyle: { zIndex: 50 },
}

const compactInr = (v: number) => {
  const n = Math.abs(v)
  if (n >= 1e7) return `₹${(v / 1e7).toFixed(1)}Cr`
  if (n >= 1e5) return `₹${(v / 1e5).toFixed(1)}L`
  if (n >= 1e3) return `₹${(v / 1e3).toFixed(0)}K`
  return `₹${v.toFixed(0)}`
}

export interface GrowthPoint {
  label: string
  revenue: number
  margin: number
  marginPct: number
  tasks: number
}

/**
 * Revenue and contribution margin per month, one money scale.
 *
 * SINGLE Y-AXIS ON PURPOSE. An earlier version put margin % on a second axis,
 * which read well in theory and rendered wrong in practice: with two y-axes on
 * a ComposedChart the bars were scaled against a domain other than the one the
 * axis was labelling, drawing every bar a few pixels tall next to correct
 * numbers — the most dangerous kind of chart bug, because nothing looks broken.
 * Margin % is a ratio and belongs in the table beside the figures it divides,
 * so the picture keeps the two quantities that genuinely share a scale (₹) and
 * the percentage lives where it can be read exactly.
 *
 * The domain is derived here rather than left to auto-scaling, so the height of
 * a bar is provable from the input.
 */
export function RevenueMarginChart({ data }: { data: GrowthPoint[] }) {
  const peak = data.reduce((m, d) => Math.max(m, d.revenue, d.margin), 0)
  // Round the ceiling up to a clean step so the axis labels stay readable.
  const step = Math.pow(10, Math.max(0, String(Math.round(peak)).length - 2))
  const moneyMax = peak > 0 ? Math.ceil(peak / step) * step : 1

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" vertical={false} />
        <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#6b7280' }} tickLine={false} axisLine={false} />
        <YAxis
          domain={[0, moneyMax]}
          allowDataOverflow={false}
          tick={{ fontSize: 10, fill: '#6b7280' }}
          tickFormatter={compactInr}
          tickLine={false}
          axisLine={false}
          width={54}
        />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(value: unknown, name: unknown) => {
            const v = Number(value)
            return [`₹${v.toLocaleString('en-IN')}`, name === 'revenue' ? 'Revenue' : 'Margin']
          }}
        />
        <Bar dataKey="revenue" radius={[4, 4, 0, 0]} fill="#6366f1" fillOpacity={0.85} maxBarSize={26} />
        <Bar dataKey="margin" radius={[4, 4, 0, 0]} fill="#10b981" fillOpacity={0.75} maxBarSize={26} />
      </BarChart>
    </ResponsiveContainer>
  )
}

/**
 * Card sparkline — shape only, no axes.
 *
 * Deliberately axis-less: at this size a labelled axis is unreadable, and a
 * number that cannot be read is worse than one that was never drawn. The card
 * carries the actual figures; this only shows the direction they moved.
 *
 * `id` makes the gradient's DOM id unique — several cards render at once, and a
 * shared id would make every sparkline adopt the first card's colour.
 */
export function Sparkline({ data, id, positive }: {
  data: { label: string; revenue: number }[]
  id: string
  positive: boolean
}) {
  const stroke = positive ? '#10b981' : '#ef4444'
  const gradientId = `spark-${id}`
  return (
    <ResponsiveContainer width="100%" height={48}>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area
          type="monotone"
          dataKey="revenue"
          stroke={stroke}
          strokeWidth={1.75}
          fill={`url(#${gradientId})`}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
