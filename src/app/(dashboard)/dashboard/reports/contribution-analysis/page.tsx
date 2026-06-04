import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import {
  buildAnalysisRows,
  type RawTask, type RawScore, type RawPricing, type EmployeeColumn,
} from '@/lib/reports/contribution-analysis'
import ContributionAnalysisClient from './contribution-analysis-client'

// Scores are written whenever contributions are saved — always read fresh.
export const dynamic = 'force-dynamic'

export default async function ContributionAnalysisPage() {
  // Same wall as Reports: admin OR explicit reports.view. Fail-open pre-migration
  // (no employee record yet) so the app keeps working before perms are seeded.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canView) redirect('/dashboard')

  const supabase = createAdminClient()

  const [employeesRes, clientsRes, servicesRes, pricingRes, tasksRes, scoresRes, invoiceItemsRes, invoicesRes] = await Promise.all([
    // Active employees define the dynamic columns (ordered by CQID for stability).
    supabase.from('employees').select('id, cqid, name').eq('is_active', true).order('cqid'),
    supabase.from('clients').select('id, name').order('name'),
    supabase.from('services').select('id, name').order('name'),
    fetchAll(supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage').order('id', { ascending: true })),
    fetchAll(
      supabase
        .from('tasks')
        .select('id, task_number, title, task_date, status, currency, billing_amount, billing_amount_inr, client_id, service_id')
        .order('id', { ascending: true }),
    ),
    fetchAll(
      supabase
        .from('contribution_scores')
        .select('task_id, employee_id, score_percentage, earnings_inr')
        .order('id', { ascending: true }),
    ),
    // Task → invoice line items (for actual-received apportioning).
    fetchAll(supabase.from('invoice_items').select('task_id, invoice_id, total').order('id', { ascending: true })),
    // Invoice payment state — paid_amount_inr is the ACTUAL INR received.
    fetchAll(supabase.from('invoices').select('id, status, paid_amount_inr').order('id', { ascending: true })),
  ])

  const employees: EmployeeColumn[] = (employeesRes.data || []) as EmployeeColumn[]
  const clients = (clientsRes.data || []) as { id: string; name: string }[]
  const services = (servicesRes.data || []) as { id: string; name: string }[]

  const clientName = new Map(clients.map(c => [c.id, c.name]))
  const serviceName = new Map(services.map(s => [s.id, s.name]))

  // ── Actual INR received per task ──────────────────────────────────────────
  // Apportion an invoice's actual paid INR (paid_amount_inr) across its line
  // items by each item's share of the invoice line-total. A task's "actual
  // received" is only counted when EVERY invoice it appears on is fully paid —
  // otherwise the result is still pending and the report shows "—".
  // This NEVER touches employee earnings; it's purely company-side FX/profit.
  type InvItem = { task_id: string | null; invoice_id: string; total: number | null }
  type Inv = { id: string; status: string; paid_amount_inr: number | null }
  const invItems = (invoiceItemsRes.data || []) as InvItem[]
  const invoices = (invoicesRes.data || []) as Inv[]
  const invMap = new Map(invoices.map(i => [i.id, i]))

  // Σ line totals per invoice (denominator for the apportion share).
  const lineSum = new Map<string, number>()
  for (const it of invItems) {
    if (!it.invoice_id) continue
    lineSum.set(it.invoice_id, (lineSum.get(it.invoice_id) || 0) + (it.total || 0))
  }

  // task_id → { received, allPaid, anyItem }
  const acc = new Map<string, { received: number; allPaid: boolean; anyItem: boolean }>()
  for (const it of invItems) {
    if (!it.task_id) continue
    const inv = invMap.get(it.invoice_id)
    const cur = acc.get(it.task_id) || { received: 0, allPaid: true, anyItem: false }
    cur.anyItem = true
    if (!inv || inv.status !== 'paid') {
      cur.allPaid = false
    } else {
      const denom = lineSum.get(it.invoice_id) || 0
      const share = denom > 0 ? (it.total || 0) / denom : 0
      cur.received += (inv.paid_amount_inr || 0) * share
    }
    acc.set(it.task_id, cur)
  }
  const actualByTask = new Map<string, number>()
  for (const [taskId, v] of acc) {
    if (v.anyItem && v.allPaid) actualByTask.set(taskId, v.received)
  }

  const rows = buildAnalysisRows(
    (tasksRes.data || []) as RawTask[],
    (scoresRes.data || []) as RawScore[],
    (pricingRes.data || []) as RawPricing[],
    clientName,
    serviceName,
    actualByTask,
  )

  return (
    <ContributionAnalysisClient
      rows={rows}
      employees={employees}
      clients={clients}
      services={services}
    />
  )
}
