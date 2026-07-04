import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import type { RawTask, RawScore, RawPricing, EmployeeColumn } from '@/lib/reports/contribution-analysis'
import type { CommissionAgreement } from '@/lib/calculations/agreements'
import type { WhatIfRawInputs } from '@/lib/reports/what-if'
import WhatIfClient from './what-if-client'

// Scores/agreements change whenever contributions are saved — always read fresh.
export const dynamic = 'force-dynamic'

export default async function WhatIfPage() {
  // Same wall as the sibling reports: admin OR explicit reports.view.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canView) redirect('/dashboard')

  // Base salaries feed the payroll-cost / increment lever. Strip them
  // server-side unless the viewer can see payroll amounts, so ₹ salaries never
  // reach the client JS state (mirrors FINANCIAL_VISIBILITY_PERMS handling).
  const canSeeSalaries = hasPermission(me, PERMS.PAYROLL_VIEW_AMOUNTS)

  const supabase = createAdminClient()

  const [employeesRes, clientsRes, servicesRes, pricingRes, tasksRes, scoresRes, ratingsRes, taskToolsRes, toolsRes] = await Promise.all([
    supabase.from('employees').select('id, cqid, name, base_salary').eq('is_active', true).order('cqid'),
    supabase.from('clients').select('id, name').order('name'),
    supabase.from('services').select('id, name').order('name'),
    fetchAll(supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage, price').order('id', { ascending: true })),
    fetchAll(
      supabase
        .from('tasks')
        .select('id, task_number, title, task_date, status, currency, billing_amount, billing_amount_inr, client_id, service_id')
        .is('deleted_at', null)
        .order('id', { ascending: true }),
    ),
    fetchAll(
      supabase
        .from('contribution_scores')
        .select('task_id, employee_id, score_percentage, earnings_inr, is_manual_override')
        .order('id', { ascending: true }),
    ),
    supabase.from('employees').select('id, performance_rating'),
    fetchAll(supabase.from('task_tools').select('task_id, tool_id').order('id', { ascending: true })),
    supabase.from('tools').select('id, fixed_percentage, is_active'),
  ])

  const employees: EmployeeColumn[] = ((employeesRes.data || []) as { id: string; cqid: string; name: string }[])
    .map(e => ({ id: e.id, cqid: e.cqid, name: e.name }))

  const baseSalaries: Record<string, number> | null = canSeeSalaries
    ? Object.fromEntries(
        ((employeesRes.data || []) as { id: string; base_salary: number | null }[])
          .map(e => [e.id, Number(e.base_salary) || 0]),
      )
    : null

  // employeeId → performance rating (current values; the simulation overrides these in-memory)
  const empRating: Record<string, number> = {}
  for (const e of (ratingsRes.data || []) as { id: string; performance_rating: number | null }[]) {
    empRating[e.id] = Number(e.performance_rating) || 100
  }

  // taskId → Σ active tool fixed_percentage (flat pool deduction)
  const toolPctById = new Map<string, number>()
  for (const t of (toolsRes.data || []) as { id: string; fixed_percentage: number | null; is_active: boolean | null }[]) {
    if (t.is_active !== false) toolPctById.set(t.id, Number(t.fixed_percentage) || 0)
  }
  const toolPctByTask: Record<string, number> = {}
  for (const tt of (taskToolsRes.data || []) as { task_id: string; tool_id: string }[]) {
    const pct = toolPctById.get(tt.tool_id) || 0
    if (pct) toolPctByTask[tt.task_id] = (toolPctByTask[tt.task_id] || 0) + pct
  }

  // Active employee commission agreements (defensive — table may not exist pre-migration).
  let agreements: CommissionAgreement[] = []
  try {
    const { data, error } = await supabase
      .from('employee_commission_agreements')
      .select('id, employee_id, client_id, service_id, agreement_type, agreement_value, currency, effective_from, effective_to, is_active')
      .eq('is_active', true)
    if (!error && data) agreements = data as CommissionAgreement[]
  } catch { /* pre-migration — planner runs without agreements */ }

  type PricingRow = { client_id: string; service_id: string; commission_percentage: number | null; price: number | null }
  const pricingRows = (pricingRes.data || []) as PricingRow[]

  const raw: WhatIfRawInputs = {
    tasks: (tasksRes.data || []) as RawTask[],
    scores: (scoresRes.data || []) as RawScore[],
    pricing: pricingRows.map(({ client_id, service_id, commission_percentage }): RawPricing => ({ client_id, service_id, commission_percentage })),
    clients: (clientsRes.data || []) as { id: string; name: string }[],
    services: (servicesRes.data || []) as { id: string; name: string }[],
    empRating,
    toolPctByTask,
    agreements,
  }

  // client|service → current price (feeds the price lever; 0/undefined hides it for that pairing)
  const currentPrices: Record<string, number> = {}
  for (const p of pricingRows) {
    if (p.price != null && p.price > 0) currentPrices[`${p.client_id}|${p.service_id}`] = Number(p.price)
  }

  return (
    <WhatIfClient
      raw={raw}
      employees={employees}
      baseSalaries={baseSalaries}
      currentPrices={currentPrices}
      canApply={{
        rating: hasPermission(me, PERMS.PAYROLL_EDIT),
        salary: hasPermission(me, PERMS.PAYROLL_EDIT),
        pricing: hasPermission(me, PERMS.SETTINGS_ACCESS),
        agreements: hasPermission(me, PERMS.EMPLOYEES_MANAGE_AGREEMENTS),
      }}
    />
  )
}
