'use client'

// Recharts is ~95 KB min+gz. Pulled in lazily via next/dynamic from
// payroll-client.tsx so it only loads when an employee detail modal is opened.

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

// ── 6-month base + commission stacked bar ──────────────────────────────────
export function PayrollHistoryBar({
  data,
}: {
  data: { month: string; base: number; commission: number }[]
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barSize={20}>
        <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false}
          tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} width={38} />
        <Tooltip
          contentStyle={{ background: '#0d1117', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', fontSize: 12 }}
          formatter={(v: any, name: any) => [`₹${Number(v).toLocaleString('en-IN')}`, name === 'base' ? 'Base' : 'Commission']}
        />
        <Bar dataKey="base"       name="base"       stackId="a" fill="#6366f1" radius={[0, 0, 2, 2]} />
        <Bar dataKey="commission" name="commission" stackId="a" fill="#22c55e" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
