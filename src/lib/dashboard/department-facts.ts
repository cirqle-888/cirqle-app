import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAll, fetchAllIn, fetchAllParallel } from '@/lib/supabase/server'
import { round2 } from '@/lib/calculations/currency'
import { cashFlowContribution, type CashFlowRow } from '@/lib/finance/cash-flow'
import { recognisedRevenue } from '@/lib/finance/invoice-revenue'
import { splitOverLines, UNASSIGNED_DEPT, type DeptDayFact } from '@/lib/finance/department-flows'

export interface DepartmentFacts {
  facts: DeptDayFact[]
  departments: { id: string; name: string }[]
}

type CashRow = CashFlowRow & { id: string; entry_date: string }

/**
 * Day facts for the dashboard's department panel (lib/finance/department-flows).
 *
 * `cash` must be the dashboard's OPERATING cash-book rows (operatingRows), with
 * `id`, so the panel's Inflow adds up to the Income card. Tasks are read from
 * `tasksFrom` — the dashboard's 36-month analytics window, so Job Value
 * matches. Invoices and allocations are small and read whole.
 *
 * ONE wave of reads. This used to be three, each waiting for the last:
 * the batch, then invoice lines `.in()` the invoice ids, then scores `.in()`
 * ~2,000 task ids (21 chunks, three rounds). Neither follow-up needed the ids
 * to ask its question — invoices are read whole, so their lines are simply
 * all lines; and the scores wanted are those of tasks dated inside the
 * window, which the database can decide with a join. Both now leave with the
 * batch. Measured 15 Nov 2026 from a laptop: the panel's reads went from
 * three round-trip waves (~2.5 s) to one.
 *
 * `cash` may be a promise, so a caller that is still fetching the cash book
 * can start this at the same time rather than after it.
 */
export async function loadDepartmentFacts(
  admin: SupabaseClient,
  cashInput: readonly CashRow[] | PromiseLike<readonly CashRow[]>,
  tasksFrom: string,
): Promise<DepartmentFacts> {
  const [catsRes, svcRes, tasksRes, invRes, allocRes, linesRes, scoresRes, cash] = await Promise.all([
    fetchAll(admin.from('service_categories').select('id, name').order('display_order').order('name')),
    fetchAll(admin.from('services').select('id, category_id').order('id')),
    // 36 months is ~2,000 rows, three pages: paged together, not in sequence.
    fetchAllParallel(() => admin.from('tasks')
      .select('id, task_date, service_id, billing_amount_inr')
      .not('status', 'eq', 'cancelled').is('deleted_at', null)
      .gte('task_date', tasksFrom)
      .order('task_date').order('id')),
    fetchAll(admin.from('invoices')
      .select('id, status, issue_date, total_amount, total_amount_inr, paid_amount, paid_amount_inr')
      .order('id')),
    fetchAll(admin.from('cashbook_invoice_allocations')
      .select('cashbook_entry_id, invoice_id, allocated_amount')
      .is('deleted_at', null).order('id')),
    // Every invoice is read above, so every line is wanted: no id list needed.
    fetchAllParallel(() => admin.from('invoice_items')
      .select('id, invoice_id, total, task_id, service_id').order('id'), 4),
    // Scores of tasks dated inside the window. The loop below still drops any
    // whose task is cancelled or deleted (absent from `taskById`), exactly as
    // the id-list lookup did.
    fetchAllParallel(() => admin.from('contribution_scores')
      .select('id, task_id, earnings_inr, tasks!inner(task_date)')
      .gte('tasks.task_date', tasksFrom)
      .order('id'), 8),
    cashInput,
  ])
  for (const r of [catsRes, svcRes, tasksRes, invRes, allocRes, linesRes, scoresRes]) if (r.error) throw new Error(r.error.message)

  const categoryOf = new Map<string, string | null>((svcRes.data as any[]).map(s => [s.id, s.category_id ?? null]))
  const deptOfService = (s: string | null | undefined) => (s ? categoryOf.get(s) ?? null : null)
  const tasks = tasksRes.data as { id: string; task_date: string; service_id: string | null; billing_amount_inr: number | null }[]
  const invoices = invRes.data as any[]

  const lines = linesRes.data as { invoice_id: string; total: number | null; task_id: string | null; service_id: string | null }[]

  // A line's department: its task's service, else its own service.
  const serviceOfTask = new Map(tasks.map(t => [t.id, t.service_id]))
  const missing = [...new Set(lines.map(l => l.task_id).filter((t): t is string => !!t && !serviceOfTask.has(t)))]
  // Lines whose task falls outside the window (older, cancelled or deleted)
  // still need that task's service. Usually a handful; often none.
  const lineTasksRes = await fetchAllIn(ids => admin.from('tasks').select('id, service_id').in('id', ids).order('id'), missing)
  if (lineTasksRes.error) throw new Error(lineTasksRes.error.message)
  for (const t of lineTasksRes.data as any[]) serviceOfTask.set(t.id, t.service_id ?? null)

  const linesByInvoice = new Map<string, { deptId: string | null; amount: number }[]>()
  for (const l of lines) {
    const deptId = (l.task_id ? deptOfService(serviceOfTask.get(l.task_id)) : null) ?? deptOfService(l.service_id)
    const list = linesByInvoice.get(l.invoice_id) ?? []
    list.push({ deptId, amount: Number(l.total) || 0 })
    linesByInvoice.set(l.invoice_id, list)
  }

  const facts = new Map<string, DeptDayFact>()
  const at = (date: string, deptId: string) => {
    const k = `${date}|${deptId}`
    let f = facts.get(k)
    if (!f) { f = { date, deptId, jobs: 0, jobValueInr: 0, billedInr: 0, inflowInr: 0, contributionPayInr: 0 }; facts.set(k, f) }
    return f
  }
  const dept = (d: string | null | undefined) => d ?? UNASSIGNED_DEPT

  // Job value and contribution pay, on the task's date.
  const taskById = new Map(tasks.map(t => [t.id, t]))
  for (const t of tasks) {
    const f = at(t.task_date.slice(0, 10), dept(deptOfService(t.service_id)))
    f.jobs += 1
    f.jobValueInr += Number(t.billing_amount_inr) || 0
  }
  for (const s of scoresRes.data as { task_id: string; earnings_inr: number | null }[]) {
    const t = taskById.get(s.task_id)
    if (t) at(t.task_date.slice(0, 10), dept(deptOfService(t.service_id))).contributionPayInr += Number(s.earnings_inr) || 0
  }

  // Billed, on the issue date: what the invoice recognises, over its lines.
  for (const inv of invoices) {
    const amount = recognisedRevenue(inv)
    if (!amount || !inv.issue_date) continue
    for (const p of splitOverLines(amount, linesByInvoice.get(inv.id))) at(String(inv.issue_date).slice(0, 10), p.deptId).billedInr += p.amountInr
  }

  // Inflow: cash allocated to invoices follows their lines; the rest is Unassigned.
  const allocByEntry = new Map<string, { invoiceId: string; weight: number }[]>()
  for (const a of allocRes.data as { cashbook_entry_id: string; invoice_id: string; allocated_amount: number | null }[]) {
    const list = allocByEntry.get(a.cashbook_entry_id) ?? []
    list.push({ invoiceId: a.invoice_id, weight: Math.max(0, Number(a.allocated_amount) || 0) })
    allocByEntry.set(a.cashbook_entry_id, list)
  }
  for (const e of cash) {
    const inflow = cashFlowContribution(e).inflow
    if (!inflow || !e.entry_date) continue
    const date = e.entry_date.slice(0, 10)
    const allocs = allocByEntry.get(e.id) ?? allocByEntry.get((e as { reversal_of?: string | null }).reversal_of ?? '')
    if (!allocs?.length) { at(date, UNASSIGNED_DEPT).inflowInr += inflow; continue }
    // Each invoice's share of the entry, then each department's share of the invoice.
    const perInvoice = splitOverLines(inflow, allocs.map(a => ({ deptId: a.invoiceId, amount: a.weight || 1 })))
    for (const pi of perInvoice) {
      for (const p of splitOverLines(pi.amountInr, linesByInvoice.get(pi.deptId))) at(date, p.deptId).inflowInr += p.amountInr
    }
  }

  const round = round2
  return {
    facts: [...facts.values()].map(f => ({
      ...f, jobValueInr: round(f.jobValueInr), billedInr: round(f.billedInr),
      inflowInr: round(f.inflowInr), contributionPayInr: round(f.contributionPayInr),
    })),
    departments: (catsRes.data as any[]).map(c => ({ id: c.id, name: c.name })),
  }
}
