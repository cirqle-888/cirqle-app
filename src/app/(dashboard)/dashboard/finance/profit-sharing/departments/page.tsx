import { computeRun, monthEnd } from '@/lib/profit-sharing/engine'
import { departmentView } from '@/lib/profit-sharing/departments'
import { loadDepartmentData, loadModuleState, loadRunInput, todayIso } from '../_data'
import { requireProfitSharingPage } from '../_page'
import { NotInstalled } from '../_not-installed'
import DepartmentsClient from './departments-client'

export const dynamic = 'force-dynamic'

const MONTH = /^\d{4}-\d{2}$/

/**
 * Department view — analysis only (decided 2026-10-22): which departments the
 * period's cash profit came from, and who contributed to or held a role in
 * each. Nothing here changes a share.
 */
export default async function DepartmentsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const { admin, installed } = await requireProfitSharingPage()
  if (!installed) return <NotInstalled />
  const sp = await searchParams
  const state = await loadModuleState(admin)

  // Default: the latest period on record, else last month.
  const latest = state.runs.filter(r => r.status !== 'void').at(-1)
  const today = todayIso()
  const lastMonth = (() => { const [y, m] = today.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}` })()
  const from = MONTH.test(sp.from ?? '') ? sp.from! : latest?.periodStart.slice(0, 7) ?? lastMonth
  let to = MONTH.test(sp.to ?? '') ? sp.to! : latest?.periodEnd.slice(0, 7) ?? lastMonth
  if (to < from) to = from
  const start = `${from}-01`
  const end = monthEnd(`${to}-01`)

  let error: string | null = null
  let data: Parameters<typeof DepartmentsClient>[0]['data'] = null
  try {
    const input = await loadRunInput(admin, state, { id: 'departments', periodStart: start, periodEnd: end, openingLossInr: 0, openingLossEntered: true })
    const c = computeRun(input)
    const invoiceIds = c.ownRevenueByInvoice.map(r => r.invoiceId).filter(Boolean) as string[]
    const d = await loadDepartmentData(admin, start, end, invoiceIds)
    const view = departmentView({
      ownRevenueByInvoice: c.ownRevenueByInvoice,
      invoiceLines: d.invoiceLines,
      contributions: d.contributions,
      assignments: d.assignments,
      deductions: c.profit,
      profitInr: c.profit.profitInr,
    })
    data = { view, departments: d.departments, cqid: d.cqid, profitInr: c.profit.profitInr, blocking: c.gates.filter(g => g.level === 'block').length }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return <DepartmentsClient from={from} to={to} data={data} error={error} />
}
