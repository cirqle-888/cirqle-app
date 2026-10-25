'use client'

// Dashboard — Departments panel. The figures are built in
// lib/finance/department-flows.ts (unit-tested); this file is presentation only.

import { use, useMemo } from 'react'
import Link from 'next/link'
import { departmentFlows, UNASSIGNED_DEPT } from '@/lib/finance/department-flows'
import type { DepartmentFacts } from '@/lib/dashboard/department-facts'

export function DepartmentFlowsPanel({ factsPromise, window, outflowInr, periodLabel, fmt }: {
  factsPromise: Promise<DepartmentFacts | null>
  /** The dashboard date filter as a window; null = all time. */
  window: { from: string; to: string } | null
  /** The Outflow card's figure for the same window — shared out across departments. */
  outflowInr: number
  periodLabel: string
  fmt: (v: number) => string
}) {
  const data = use(factsPromise)
  const rows = useMemo(() => (data ? departmentFlows(data.facts, window, outflowInr) : []), [data, window, outflowInr])
  if (!data) return null

  const name = new Map(data.departments.map(d => [d.id, d.name]))
  const label = (id: string) => (id === UNASSIGNED_DEPT ? 'Unassigned' : name.get(id) ?? 'Unknown')
  const total = rows.reduce((t, r) => ({
    jobs: t.jobs + r.jobs, jobValueInr: t.jobValueInr + r.jobValueInr, billedInr: t.billedInr + r.billedInr,
    inflowInr: t.inflowInr + r.inflowInr, outflowInr: t.outflowInr + r.outflowInr, netInr: t.netInr + r.netInr,
  }), { jobs: 0, jobValueInr: 0, billedInr: 0, inflowInr: 0, outflowInr: 0, netInr: 0 })
  const num = 'px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap'

  return (
    <section className="bg-card border border-border rounded-xl shadow-sm">
      <div className="px-4 py-3.5 border-b border-border flex items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-sm">Departments</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5 font-medium">{periodLabel} · a department is a service category</p>
        </div>
        <Link href="/dashboard/reports/department-pnl" className="text-xs text-primary hover:underline shrink-0">Department P&amp;L →</Link>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">No department activity in this period</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">
                <th className="px-3 py-2 text-left font-semibold">Department</th>
                <th className="px-3 py-2 text-right font-semibold">Jobs</th>
                <th className="px-3 py-2 text-right font-semibold">Job Value</th>
                <th className="px-3 py-2 text-right font-semibold">Revenue (billed)</th>
                <th className="px-3 py-2 text-right font-semibold">Inflow</th>
                <th className="px-3 py-2 text-right font-semibold">Outflow*</th>
                <th className="px-3 py-2 text-right font-semibold">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map(r => (
                <tr key={r.deptId} className={r.deptId === UNASSIGNED_DEPT ? 'text-muted-foreground' : ''}>
                  <td className="px-3 py-2 font-medium">{label(r.deptId)}</td>
                  <td className={num}>{r.jobs}</td>
                  <td className={num}>{fmt(r.jobValueInr)}</td>
                  <td className={num}>{fmt(r.billedInr)}</td>
                  <td className={`${num} text-green-500`}>{fmt(r.inflowInr)}</td>
                  <td className={`${num} text-red-500`} title={`Contribution pay ${fmt(r.contributionPayInr)} + shared costs ${fmt(r.sharedCostInr)}`}>{fmt(r.outflowInr)}</td>
                  <td className={`${num} ${r.netInr < 0 ? 'text-red-500' : ''}`}>{fmt(r.netInr)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className={num}>{total.jobs}</td>
                <td className={num}>{fmt(total.jobValueInr)}</td>
                <td className={num}>{fmt(total.billedInr)}</td>
                <td className={num}>{fmt(total.inflowInr)}</td>
                <td className={num}>{fmt(total.outflowInr)}</td>
                <td className={num}>{fmt(total.netInr)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="px-4 py-2.5 border-t border-border text-[11px] text-muted-foreground">
        Inflow follows the invoices each payment was allocated to; cash with no invoice is Unassigned.
        *Outflow is contribution pay (measured) plus every other operating cost shared by Revenue share (an estimate) — hover a figure for the split. Totals match the Income and Outflow cards.
      </p>
    </section>
  )
}
