'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { NO_DEPARTMENT, type DepartmentView } from '@/lib/profit-sharing/departments'
import { Button, Card, Empty, Field, Table } from '../_components'
import { inputCls, inr, pct, td, tdNum } from '../_format'

export default function DepartmentsClient({ from, to, data, error }: {
  from: string
  to: string
  data: {
    view: DepartmentView
    departments: { id: string; name: string }[]
    cqid: Record<string, string>
    profitInr: number
    blocking: number
  } | null
  error: string | null
}) {
  const router = useRouter()
  const [range, setRange] = useState({ from, to })
  const [dept, setDept] = useState('')
  const [emp, setEmp] = useState('')
  const name = useMemo(() => new Map((data?.departments ?? []).map(d => [d.id, d.name])), [data])
  const deptName = (id: string) => (id === NO_DEPARTMENT ? 'No department' : name.get(id) ?? 'Unknown')
  const who = (id: string) => data?.cqid[id] ?? '—'

  const departments = (data?.view.departments ?? []).filter(d => !dept || d.deptId === dept)
    .filter(d => !emp || data!.view.employees.some(e => e.employeeId === emp && e.deptId === d.deptId))
  const people = (data?.view.employees ?? []).filter(e => (!dept || e.deptId === dept) && (!emp || e.employeeId === emp))
  const employeeIds = [...new Set((data?.view.employees ?? []).map(e => e.employeeId))].sort((a, b) => who(a).localeCompare(who(b)))

  return (
    <div className="space-y-6">
      <Card title="Departments" subtitle="Analysis only — nothing here changes anyone’s share. A department is a service category. Revenue and contribution pay are measured; shared costs (base pay, bonuses, rent, software, write-offs) are apportioned by each department’s share of own revenue, so the departments add up exactly to the period’s cash profit. Figures are live from the books.">
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="From month"><input type="month" className={inputCls} value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} /></Field>
          <Field label="To month"><input type="month" className={inputCls} value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} /></Field>
          <div className="flex items-end">
            <Button onClick={() => router.push(`/dashboard/finance/profit-sharing/departments?from=${range.from}&to=${range.to}`)}>Show period</Button>
          </div>
          <Field label="Department">
            <select className={inputCls} value={dept} onChange={e => setDept(e.target.value)}>
              <option value="">All departments</option>
              {(data?.view.departments ?? []).map(d => <option key={d.deptId} value={d.deptId}>{deptName(d.deptId)}</option>)}
            </select>
          </Field>
          <Field label="Employee">
            <select className={inputCls} value={emp} onChange={e => setEmp(e.target.value)}>
              <option value="">Everyone</option>
              {employeeIds.map(id => <option key={id} value={id}>{who(id)}</option>)}
            </select>
          </Field>
        </div>
      </Card>

      {error && <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-3 text-sm">Could not read the books: {error}</div>}
      {data && data.blocking > 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          This period still has {data.blocking} unresolved check(s) on the Profit Periods page (for example items waiting for review), so these figures may move once they are settled.
        </div>
      )}

      {data && (
        <Card title={`Cash profit by department — ${inr(data.profitInr)}`} subtitle={`Shared costs apportioned: ${inr(data.view.sharedPoolInr)}. Check: departments − cash profit = ${inr(data.view.reconciliationInr)}.`}>
          {departments.length === 0 ? <Empty>No department activity in this period.</Empty> : (
            <Table head={['Department', 'Own revenue', 'Share', 'Contribution pay', 'Shared costs (estimate)', 'Result', 'People']}>
              {departments.map(d => (
                <tr key={d.deptId} className="border-b border-border/60">
                  <td className={td}>{deptName(d.deptId)}</td>
                  <td className={tdNum}>{inr(d.ownRevenueInr)}</td>
                  <td className={tdNum}>{pct(d.revenueShare, 1)}</td>
                  <td className={tdNum}>{inr(d.contributionPayInr)}</td>
                  <td className={tdNum}>{inr(d.sharedCostInr)}</td>
                  <td className={tdNum}>{inr(d.resultInr)}</td>
                  <td className={tdNum}>{d.people}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {data && (
        <Card title="People by department" subtitle="Each employee (by CQID) in each department they worked in: contribution earnings on the period’s tasks, their share of that department’s contribution pay, and tasks where they held a role without earning on it.">
          {people.length === 0 ? <Empty>No one matches these filters.</Empty> : (
            <Table head={['Employee', 'Department', 'Contribution earnings', 'Share of dept pay', 'Tasks earned on', 'Role-only tasks']}>
              {people.map(p => (
                <tr key={`${p.employeeId}|${p.deptId}`} className="border-b border-border/60">
                  <td className={td}>{who(p.employeeId)}</td>
                  <td className={td}>{deptName(p.deptId)}</td>
                  <td className={tdNum}>{inr(p.earningsInr)}</td>
                  <td className={tdNum}>{pct(p.shareOfDeptPay, 1)}</td>
                  <td className={tdNum}>{p.tasks}</td>
                  <td className={tdNum}>{p.roleOnlyTasks}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}
    </div>
  )
}
