import { notFound } from 'next/navigation'
import { computeRun, type RunComputation } from '@/lib/profit-sharing/engine'
import { deriveComposition } from '@/lib/profit-sharing/composition'
import { loadModuleState, loadRunInput } from '../../_data'
import { requireProfitSharingPage } from '../../_page'
import { NotInstalled } from '../../_not-installed'
import RunDetailClient, { type ReviewSupport } from './run-detail-client'

export const dynamic = 'force-dynamic'

export default async function PeriodDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { admin, installed } = await requireProfitSharingPage()
  if (!installed) return <NotInstalled />

  const state = await loadModuleState(admin)
  const run = state.runs.find(r => r.id === id)
  if (!run) notFound()

  // Always recompute from the books as they are now: for an open period this
  // is the preview; for a confirmed one it is the drift check against the
  // frozen figures (design §11.2).
  let live: RunComputation | null = null
  let liveError: string | null = null
  if (run.status !== 'void') {
    try {
      const input = await loadRunInput(admin, state, run)
      live = computeRun(input)
    } catch (e) {
      liveError = e instanceof Error ? e.message : String(e)
    }
  }
  const stored = (run.summary ?? null) as RunComputation | null
  const isFirst = !state.runs.some(r => r.status === 'confirmed' && r.id !== run.id && r.periodEnd < run.periodStart)

  // What the review forms need: payslips, advances and invoice parts for the items raised.
  const items = live?.reviewItems ?? []
  const employeeIds = [...new Set(items.map(i => i.context?.employeeId as string | undefined).filter(Boolean))] as string[]
  const invoiceIds = items.filter(i => i.category === 'invoice_split').map(i => i.sourceId)
  const [emps, payslips, credits, invoices] = await Promise.all([
    employeeIds.length ? admin.from('employees').select('id, cqid').in('id', employeeIds) : Promise.resolve({ data: [] }),
    employeeIds.length ? admin.from('payroll').select('id, employee_id, month, year, net_salary, status').in('employee_id', employeeIds).order('year').order('month') : Promise.resolve({ data: [] }),
    employeeIds.length ? admin.from('credit_ledger').select('id, entity_id, amount, credit_date').eq('credit_type', 'given').in('entity_id', employeeIds).order('credit_date') : Promise.resolve({ data: [] }),
    invoiceIds.length ? admin.from('invoices').select('id, invoice_number, total_amount, total_amount_inr, exchange_rate, tax_amount, discount_amount, previous_balance, status, client_id, updated_at').in('id', invoiceIds) : Promise.resolve({ data: [] }),
  ])
  const support: ReviewSupport = {
    cqid: Object.fromEntries((emps.data ?? []).map(e => [e.id, e.cqid])),
    payslips: (payslips.data ?? []).map(p => ({ id: p.id, employeeId: p.employee_id, label: `${p.year}-${String(p.month).padStart(2, '0')} · net ${Number(p.net_salary ?? 0)} · ${p.status}` })),
    credits: (credits.data ?? []).map(c => ({ id: c.id, employeeId: c.entity_id, label: `${c.credit_date} · ₹${Number(c.amount).toLocaleString('en-IN')}` })),
    invoices: Object.fromEntries((invoices.data ?? []).map(inv => {
      const d = deriveComposition({
        id: inv.id, clientId: inv.client_id, status: inv.status, exchangeRate: Number(inv.exchange_rate) || 1,
        totalAmount: Number(inv.total_amount ?? 0), totalAmountInr: inv.total_amount_inr == null ? null : Number(inv.total_amount_inr),
        taxAmount: Number(inv.tax_amount ?? 0), discountAmount: Number(inv.discount_amount ?? 0),
        previousBalance: Number(inv.previous_balance ?? 0), updatedOn: null, itemsTotal: 0, markupTotal: 0, adSpendInr: 0, expenseOriginalInr: 0,
      })
      return [inv.id, { number: inv.invoice_number as string | null, totalInr: d.composition.totalInr, taxInr: d.composition.taxInr, carriedInr: d.composition.carriedInr }]
    })),
  }

  return (
    <RunDetailClient
      run={{ ...run, summary: undefined }}
      stored={stored}
      live={live}
      liveError={liveError}
      isFirst={isFirst}
      members={state.members.map(m => ({ id: m.id, label: m.label }))}
      support={support}
    />
  )
}
