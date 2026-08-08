import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import {
  buildAnalysisRows,
  type RawTask, type RawScore, type RawPricing, type EmployeeColumn,
} from '@/lib/reports/contribution-analysis'
import type { CommissionAgreement } from '@/lib/calculations/agreements'
import { resolveFetchWindow, scoreWindowFor } from '@/lib/reports/date-bounds'
import ContributionAnalysisClient from './contribution-analysis-client'

// Scores are written whenever contributions are saved — always read fresh.
export const dynamic = 'force-dynamic'

export default async function ContributionAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  // Egress: this page used to fetch EVERY task + EVERY score on every view
  // (~4–5 MB). The date filter lives in the URL and router.replace re-runs
  // this component, so the server now ships only the window being looked at.
  // No param = last 12 months; `date=all` = the explicit everything view.
  const { date: rawDate } = await searchParams
  const win = resolveFetchWindow(rawDate)
  const scoreWin = scoreWindowFor(win)
  // Same wall as Reports: admin OR explicit reports.view. Fail-open pre-migration
  // (no employee record yet) so the app keeps working before perms are seeded.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || me?.permissions.has('reports.view')
  if (!canView) redirect('/dashboard')

  const supabase = createAdminClient()

  const [employeesRes, clientsRes, servicesRes, pricingRes, tasksRes, scoresRes, invoiceItemsRes, invoicesRes, ratingsRes, taskToolsRes, toolsRes] = await Promise.all([
    // Active employees define the dynamic columns (ordered by CQID for stability).
    supabase.from('employees').select('id, cqid, name').eq('is_active', true).order('cqid'),
    supabase.from('clients').select('id, name').order('name'),
    supabase.from('services').select('id, name').order('name'),
    fetchAll(supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage').order('id', { ascending: true })),
    fetchAll(
      (() => {
        let q = supabase
          .from('tasks')
          .select('id, task_number, title, task_date, status, currency, billing_amount, billing_amount_inr, client_id, service_id, retainer_item_id, bill_as_extra, work_value_inr')
          .is('deleted_at', null)
        if (win.from) q = q.gte('task_date', win.from)
        if (win.to) q = q.lte('task_date', win.to)
        return q.order('id', { ascending: true })
      })(),
    ),
    fetchAll(
      (() => {
        // Lower bound only, with slack — see scoreWindowFor. Extra rows for
        // out-of-window tasks are dropped by the task-id match in the builder.
        let q = supabase
          .from('contribution_scores')
          .select('task_id, employee_id, score_percentage, earnings_inr, is_manual_override')
        if (scoreWin.fromTs) q = q.gte('calculated_at', scoreWin.fromTs)
        return q.order('id', { ascending: true })
      })(),
    ),
    // Task → invoice line items (for actual-received apportioning).
    fetchAll(supabase.from('invoice_items').select('task_id, invoice_id, total').order('id', { ascending: true })),
    // Invoice payment state — paid_amount_inr is the ACTUAL INR received.
    fetchAll(supabase.from('invoices').select('id, status, paid_amount_inr').order('id', { ascending: true })),
    // ALL employees' performance ratings (incl. archived contributors) — drives
    // the earnings formula: earnings = pool × score% × rating%.
    supabase.from('employees').select('id, performance_rating'),
    // Tool usage per task + tool deduction % (flat % off the pool, like the engine).
    fetchAll(supabase.from('task_tools').select('task_id, tool_id').order('id', { ascending: true })),
    supabase.from('tools').select('id, fixed_percentage, is_active'),
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

  // ── Employee performance ratings (id → rating %) ──────────────────────────
  const empRating = new Map<string, number>()
  for (const e of (ratingsRes.data || []) as { id: string; performance_rating: number | null }[]) {
    empRating.set(e.id, Number(e.performance_rating) || 100)
  }

  // ── Per-task tool deduction % (Σ active tool fixed_percentage) ─────────────
  const toolPctById = new Map<string, number>()
  for (const t of (toolsRes.data || []) as { id: string; fixed_percentage: number | null; is_active: boolean | null }[]) {
    if (t.is_active !== false) toolPctById.set(t.id, Number(t.fixed_percentage) || 0)
  }
  const toolPctByTask = new Map<string, number>()
  for (const tt of (taskToolsRes.data || []) as { task_id: string; tool_id: string }[]) {
    const pct = toolPctById.get(tt.tool_id) || 0
    if (pct) toolPctByTask.set(tt.task_id, (toolPctByTask.get(tt.task_id) || 0) + pct)
  }

  // Active employee commission agreements (defensive — table may not exist
  // pre-migration). Empty ⇒ the report behaves exactly as before.
  let agreements: CommissionAgreement[] = []
  try {
    const { data, error } = await supabase
      .from('employee_commission_agreements')
      .select('id, employee_id, client_id, service_id, agreement_type, agreement_value, currency, effective_from, effective_to, is_active')
      .eq('is_active', true)
    if (!error && data) agreements = data as CommissionAgreement[]
  } catch { /* table missing pre-migration — ignore */ }

  // Agreement-item commission overrides for retainer-linked tasks. Defensive:
  // empty pre-migration, so behaviour is unchanged.
  const itemCommissionPct = new Map<string, number | null>()
  try {
    const retainerItemIds = Array.from(new Set(
      ((tasksRes.data || []) as RawTask[])
        .map(t => t.retainer_item_id)
        .filter(Boolean) as string[]
    ))
    if (retainerItemIds.length > 0) {
      const { data: items } = await supabase
        .from('client_agreement_items')
        .select('id, work_commission_pct')
        .in('id', retainerItemIds)
      for (const i of (items || []) as { id: string; work_commission_pct: number | null }[]) {
        itemCommissionPct.set(i.id, i.work_commission_pct ?? null)
      }
    }
  } catch { /* pre-migration — default commission path */ }

  const rows = buildAnalysisRows(
    (tasksRes.data || []) as RawTask[],
    (scoresRes.data || []) as RawScore[],
    (pricingRes.data || []) as RawPricing[],
    clientName,
    serviceName,
    actualByTask,
    50,            // defaultCommissionPct
    empRating,
    toolPctByTask,
    100,           // defaultPerformanceRating
    agreements,
    itemCommissionPct,
  )

  // ── Saved layouts (personal + system default) ──────────────────────────────
  // Priority at load time (handled client-side): personal → system → hardcoded.
  // Wrapped defensively so the page still renders pre-migration (table missing).
  const REPORT_NAME = 'contribution_analysis'
  let personalLayout: Record<string, unknown> | null = null
  let systemLayout: Record<string, unknown> | null = null
  try {
    const [sysRes, personalRes] = await Promise.all([
      supabase.from('report_layouts').select('layout_json')
        .is('user_id', null).eq('report_name', REPORT_NAME).eq('is_system_default', true).maybeSingle(),
      me?.employeeId
        ? supabase.from('report_layouts').select('layout_json')
            .eq('user_id', me.employeeId).eq('report_name', REPORT_NAME).maybeSingle()
        : Promise.resolve({ data: null }),
    ])
    systemLayout = (sysRes?.data?.layout_json as Record<string, unknown>) ?? null
    personalLayout = ((personalRes as { data: { layout_json?: Record<string, unknown> } | null })?.data?.layout_json) ?? null
  } catch {
    // report_layouts not migrated yet — fall back to hardcoded defaults.
  }

  return (
    <ContributionAnalysisClient
      rows={rows}
      employees={employees}
      clients={clients}
      services={services}
      isAdmin={isAdmin}
      personalLayout={personalLayout}
      systemLayout={systemLayout}
      dataWindowLabel={win.label}
    />
  )
}
