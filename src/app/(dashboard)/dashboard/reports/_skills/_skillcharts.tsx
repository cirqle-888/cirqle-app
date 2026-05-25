'use client'

// Lazy-loaded chart components for the Skills & Performance tab.
// Kept separate so recharts is only bundled when the tab is rendered.

import {
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
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

// ── Group Radar ───────────────────────────────────────────────────────────────
// One polygon per employee. axes = contribution groups.
export interface RadarSeries {
  employeeId: string
  label:      string  // CQID or name
  color:      string
  data:       Array<{ group: string; score: number }>  // score 0–100
}

export function GroupRadarChart({ series }: { series: RadarSeries[] }) {
  if (series.length === 0 || series[0].data.length === 0) {
    return (
      <div className="h-[250px] flex items-center justify-center text-sm text-muted-foreground">
        No group data yet
      </div>
    )
  }

  // Merge all series onto a shared axis list
  const merged: Record<string, Record<string, number>> = {}
  for (const s of series) {
    for (const pt of s.data) {
      if (!merged[pt.group]) merged[pt.group] = {}
      merged[pt.group][s.employeeId] = pt.score
    }
  }
  const chartData = Object.entries(merged).map(([group, vals]) => ({
    group,
    ...vals,
  }))

  return (
    <ResponsiveContainer width="100%" height={250}>
      <RadarChart data={chartData} outerRadius={85}>
        <PolarGrid stroke="rgba(255,255,255,0.08)" />
        <PolarAngleAxis
          dataKey="group"
          tick={{ fontSize: 11, fill: '#9ca3af' }}
          tickFormatter={g => g.replace(' Group', '')}
        />
        <PolarRadiusAxis
          angle={90}
          domain={[0, 100]}
          tick={false}
          axisLine={false}
        />
        {series.map(s => (
          <Radar
            key={s.employeeId}
            name={s.label}
            dataKey={s.employeeId}
            stroke={s.color}
            fill={s.color}
            fillOpacity={0.15}
            strokeWidth={2}
          />
        ))}
        <Legend
          iconSize={8}
          iconType="circle"
          wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
        />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(v: any, name: any) => [`${Math.round(Number(v))}%`, name]}
        />
      </RadarChart>
    </ResponsiveContainer>
  )
}

// ── Parameter Trend Line ──────────────────────────────────────────────────────
export interface TrendPoint {
  month:     string   // "YYYY-MM"
  label:     string   // "Jan '26"
  score:     number   // 0–1
  taskCount: number
}

export function StrengthTrendChart({ data, color }: { data: TrendPoint[]; color: string }) {
  if (data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
        No trend data yet — needs ≥1 task with parameter breakdown
      </div>
    )
  }

  const chartData = data.map(d => ({
    ...d,
    pct: Math.round(d.score * 100),
  }))

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={chartData}>
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: '#6b7280' }}
        />
        <YAxis
          domain={[0, 100]}
          tick={{ fontSize: 10, fill: '#6b7280' }}
          tickFormatter={v => `${v}%`}
        />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(v: any, name: any) => [
            `${v}%`,
            name === 'pct' ? 'Share of work' : name,
          ]}
        />
        <Line
          type="monotone"
          dataKey="pct"
          stroke={color}
          strokeWidth={2}
          dot={{ r: 4, fill: color }}
          activeDot={{ r: 6 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
