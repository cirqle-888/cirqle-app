import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import Header from '@/components/layout/header'
import { fetchAllIn } from '@/lib/supabase/server'
import { generalUnitsOf, loadAllocation, payOfPeople } from '@/lib/units/allocate-load'
import { UNIT_KIND_LABEL } from '@/lib/units/engine'
import { unitAmounts, type PersonPay } from '@/lib/units/hq'
import { monthStartISO } from '@/lib/utils/local-date'
import { Badge, Card, Empty, Stat, Table } from '../../finance/profit-sharing/_components'
import { inr, td, tdNum } from '../../finance/profit-sharing/_format'
import { MonthPicker } from '../_ui'
import { NotInstalled } from '../_not-installed'
import { MONTH, ROOT, monthName, requireDepartmentSharesPage } from '../_page'

export const dynamic = 'force-dynamic'

/**
 * Cirqle HQ — the umbrella over every unit, for the Admin only: each unit's
 * month, the office and owner's own staff (who belong to no unit) with their
 * pay by part and where it was allocated, the unit teams' pay, the General
 * pool, and money that sits in no unit. Units never see this page; their own
 * views fold everyone outside their team under the owner (lib/units/confidential).
 */
export default async function HqPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { admin, installed } = await requireDepartmentSharesPage()
  const header = <Header title="Cirqle HQ" subtitle="The umbrella: every unit, office staff pay, shared costs and what sits in no unit." crumbLabel="Cirqle HQ" />
  if (!installed) return <>{header}<div className="mx-auto max-w-6xl px-4 py-6 md:px-6"><NotInstalled /></div></>

  const sp = await searchParams
  const thisMonth = monthStartISO(0).slice(0, 7)
  const month = MONTH.test(sp.month ?? '') ? sp.month! : thisMonth
  const months = Array.from({ length: 12 }, (_, i) => monthStartISO(-i).slice(0, 7)).reverse()

  const data = await loadAllocation(admin, month)
  const { shares } = data
  const units = shares.departments.filter(d => d.isActive)
  const unitName = new Map(units.map(u => [u.id, u.name]))
  const generalUnitIds = generalUnitsOf(data)
  const kindOf = (id: string) => shares.result.classified.get(id)

  // People: every salary payment (or entry naming a person) this month.
  const people = payOfPeople(data)
  const { data: perf } = people.length
    ? await fetchAllIn((chunk: string[]) => admin.from('employees').select('id, performance_rating').in('id', chunk), people.map(p => p.employeeId))
    : { data: [] }
  const ratingOf = new Map(((perf ?? []) as { id: string; performance_rating: number | null }[]).map(e => [e.id, e.performance_rating]))
  const office = people.filter(p => !p.unitIds.length)
  const teams = people.filter(p => p.unitIds.length)

  // General pool this month.
  const generalRows = data.rows.filter(r => r.status === 'general')
  const generalTotal = generalRows.reduce((t, r) => t + (r.entry.type === 'outflow' ? 1 : -1) * r.entry.amountInr, 0)

  // What sits in no unit.
  const waiting = data.rows.filter(r => r.status === 'waiting' && r.entry.type === 'outflow').reduce((t, r) => t + r.entry.amountInr, 0)
  const leftOut = data.rows.filter(r => r.status === 'excluded' && r.entry.type === 'outflow').reduce((t, r) => t + r.entry.amountInr, 0)
  const noUnitCollected = shares.result.unassignedIncome.reduce((t, r) => t + r.collectedInr, 0)
  const noUnitInvoiced = shares.result.unassignedIncome.reduce((t, r) => t + r.invoicedInr, 0)

  const ledgers = shares.result.ledgers.filter(l => l.department.isActive)
  const total = ledgers.reduce((t, l) => {
    const m = l.months[0]
    if (!m) return t
    return {
      income: t.income + m.incomeInr + m.otherIncomeInr, direct: t.direct + m.directCostsInr,
      general: t.general + m.generalCostsInr, result: t.result + m.resultInr,
    }
  }, { income: 0, direct: 0, general: 0, result: 0 })

  const allocatedCell = (p: PersonPay) => [...p.byUnit].filter(([, v]) => v > 0).map(([u, v]) => `${unitName.get(u) ?? 'A unit'} ${inr(v)}`).join(' · ') || '—'
  const peopleTable = (list: PersonPay[]) => (
    <Table head={['Person', 'Team', 'Paid', 'Base', 'Contribution', 'Ownership', 'Bonus / adj.', 'Performance', 'Allocated to', 'Waiting']}>
      {list.map(p => (
        <tr key={p.employeeId} className="border-b border-border/60 last:border-0">
          <td className={`${td} font-medium`}>{p.cqid}{p.payMonths.length ? <div className="text-[11px] font-normal text-muted-foreground">for {p.payMonths.map(m => monthName(m)).join(', ')}</div> : null}</td>
          <td className={td}><span className="text-xs">{p.unitIds.length ? p.unitIds.map(u => unitName.get(u)).join(', ') : 'Office / owner'}</span></td>
          <td className={`${tdNum} font-medium`}>{inr(p.paid)}</td>
          <td className={tdNum}>{inr(p.base)}</td>
          <td className={tdNum}>{inr(p.contribution)}</td>
          <td className={tdNum}>{inr(p.ownership)}</td>
          <td className={tdNum}>{inr(p.extra)}</td>
          <td className={tdNum}>{ratingOf.get(p.employeeId) != null ? `${ratingOf.get(p.employeeId)}%` : '—'}</td>
          <td className={td}><span className="text-xs">{allocatedCell(p)}</span></td>
          <td className={tdNum}>{p.waiting ? <span className="text-amber-600">{inr(p.waiting)}</span> : '—'}</td>
        </tr>
      ))}
    </Table>
  )

  return (
    <>
      {header}
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href={ROOT} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="h-3.5 w-3.5" /> Departments &amp; Brands</Link>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{monthName(month)}</span>
            <MonthPicker months={months} value={month} allLabel={null} />
          </div>
        </div>

        <Card title="The umbrella this month" subtitle="Each unit as if it ran this month, and what sits in no unit. Units starting later show here for planning only.">
          <Table head={['Unit', 'Income', 'Direct costs', 'General', 'Result', 'Agreement']}>
            {ledgers.map(l => {
              const m = l.months[0]
              const d = l.department
              const before = d.startsOn.slice(0, 7) > month
              return (
                <tr key={d.id} className="border-b border-border/60 last:border-0">
                  <td className={td}>
                    <span className="flex items-center gap-2 font-medium"><span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color ?? '#7c3aed' }} />{d.name}</span>
                    <span className="text-[11px] text-muted-foreground">{UNIT_KIND_LABEL[d.kind].one}{before ? ` · starts ${monthName(d.startsOn.slice(0, 7))}` : ''}</span>
                  </td>
                  <td className={tdNum}>{inr((m?.incomeInr ?? 0) + (m?.otherIncomeInr ?? 0))}</td>
                  <td className={tdNum}>{inr(m?.directCostsInr ?? 0)}</td>
                  <td className={tdNum}>{inr(m?.generalCostsInr ?? 0)}</td>
                  <td className={`${tdNum} font-medium ${(m?.resultInr ?? 0) < 0 ? 'text-red-600 dark:text-red-400' : ''}`}>{inr(m?.resultInr ?? 0)}</td>
                  <td className={td}><span className="text-xs">{d.partners.length ? d.partners.map(p => `${p.cqid} ${p.sharePct}%`).join(' / ') : 'Cirqle'}</span></td>
                </tr>
              )
            })}
            <tr className="border-t-2 border-border font-semibold">
              <td className={td}>All units</td>
              <td className={tdNum}>{inr(total.income)}</td>
              <td className={tdNum}>{inr(total.direct)}</td>
              <td className={tdNum}>{inr(total.general)}</td>
              <td className={tdNum}>{inr(total.result)}</td>
              <td className={td} />
            </tr>
          </Table>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Stat label="Income in no unit" value={inr(noUnitCollected)} hint={`collected · ${inr(noUnitInvoiced)} invoiced`} tone={noUnitCollected > 0 ? 'bad' : 'muted'} />
            <Stat label="Cash Book waiting" value={inr(waiting)} hint={<Link href={`${ROOT}/allocate?month=${month}`} className="text-primary hover:underline">Allocate →</Link>} tone={waiting > 0 ? 'bad' : 'muted'} />
            <Stat label="Left out" value={inr(leftOut)} hint="loans, withdrawals, money moving" />
          </div>
        </Card>

        <Card title="Office and owner's own staff" subtitle="People on no unit's team. Units see their share of these costs only as one line under the owner — never who or how much.">
          {office.length === 0 ? <Empty>No pay to office staff this month.</Empty> : peopleTable(office)}
        </Card>

        <Card title="Unit teams" subtitle="People on a unit's team. Each unit's partners can see their own team here, in the unit's Team tab.">
          {teams.length === 0 ? <Empty>No pay to unit teams this month.</Empty> : peopleTable(teams)}
        </Card>

        <Card title={`General pool · ${inr(generalTotal)}`} subtitle={generalUnitIds.length ? `Split equally between ${generalUnitIds.map(u => unitName.get(u)).join(', ')}.` : 'No unit carries general costs.'}>
          {generalRows.length === 0 ? <Empty>No General costs this month.</Empty> : (
            <Table head={['Date', 'Entry', 'Amount', 'Each unit']}>
              {generalRows.map(r => {
                const a = unitAmounts(r.entry, kindOf(r.entry.id), generalUnitIds)
                const each = a.kind === 'units' ? [...a.byUnit.values()][0] ?? 0 : 0
                return (
                  <tr key={r.entry.id} className="border-b border-border/60 last:border-0">
                    <td className={td}><span className="text-xs">{r.entry.date}</span></td>
                    <td className={td}>{r.entry.description ?? '—'}<div className="text-[11px] text-muted-foreground">{r.entry.categoryName ?? ''} {r.manual ? '' : <Badge>automatic</Badge>}</div></td>
                    <td className={tdNum}>{inr(r.entry.amountInr)}</td>
                    <td className={tdNum}>{inr(each)}</td>
                  </tr>
                )
              })}
            </Table>
          )}
        </Card>
      </div>
    </>
  )
}
