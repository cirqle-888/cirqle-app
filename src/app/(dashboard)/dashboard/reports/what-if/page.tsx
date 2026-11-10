import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import type { RawTask, RawScore, RawPricing, EmployeeColumn } from '@/lib/reports/contribution-analysis'
import type { WhatIfRawInputs, PayrollExtraLine } from '@/lib/reports/what-if'
import { defaultWindow, scoreWindowFor } from '@/lib/reports/date-bounds'
import WhatIfClient from './what-if-client'

// Scores change whenever contributions are saved — always read fresh.
export const dynamic = 'force-dynamic'

export default async function WhatIfPage() {
  // Same wall as the sibling reports: admin OR explicit reports.view.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  // people's earnings — narrower than the old blanket reports.view, which
  // also carried burn rate, runway and every employee's earnings.
  // `reports.view` still admits holders granted before the split.
  const canView = isAdmin
    || me?.permissions.has('reports.view_people_earnings')
    || me?.permissions.has('reports.view')
  if (!canView) redirect('/dashboard')

  // Base salaries feed the payroll-cost / increment lever. Strip them
  // server-side unless the viewer can see payroll amounts, so ₹ salaries never
  // reach the client JS state (mirrors FINANCIAL_VISIBILITY_PERMS handling).
  const canSeeSalaries = hasPermission(me, PERMS.PAYROLL_VIEW_AMOUNTS)

  const supabase = createAdminClient()

  const planningWindow = defaultWindow()
  const planningScoreWindow = scoreWindowFor(planningWindow)

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
        // Egress guard: the planner models the business as it runs TODAY, and
        // multi-year-old tasks only distort that baseline — so the fetch is
        // hard-bounded to the last 12 months instead of shipping all history
        // (which cost megabytes per view).
        .gte('task_date', planningWindow.from!)
        .order('id', { ascending: true }),
    ),
    fetchAll(
      supabase
        .from('contribution_scores')
        .select('task_id, employee_id, score_percentage, earnings_inr, is_manual_override')
        // Lower bound with slack (scores trail task dates); out-of-window
        // rows are dropped by the builder's task-id match.
        .gte('calculated_at', planningScoreWindow.fromTs!)
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

  // The rest of payroll: live ownership awards, bonuses and back-pay
  // adjustments, booked in the planning window. Pay like base salary, so the
  // same gate — without it the planner stays commission-only.
  const extras: PayrollExtraLine[] = []
  if (canSeeSalaries) {
    const [fy, fm] = planningWindow.from!.split('-').map(Number)
    const fromKey = fy * 12 + fm
    const inWindow = (y: number, m: number) => y * 12 + m >= fromKey
    const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`
    const [awardsRes, payrollRes] = await Promise.all([
      fetchAll(supabase.from('ownership_awards')
        .select('employee_id, rule_id, basis, percent, fixed_amount_inr, earned_inr, booked_month, booked_year, program:ownership_programs(name), rule:ownership_rules(label)')
        .gte('booked_year', fy)
        .order('id', { ascending: true })),
      fetchAll(supabase.from('payroll')
        .select('employee_id, month, year, bonus, adjustment_earned')
        .gte('year', fy)
        .order('id', { ascending: true })),
    ])
    type AwardRow = {
      employee_id: string; rule_id: string; basis: string; percent: number | string | null; fixed_amount_inr: number | string | null
      earned_inr: number | string; booked_month: number; booked_year: number
      program: { name?: string } | null; rule: { label?: string | null } | null
    }
    for (const a of (awardsRes.data ?? []) as AwardRow[]) {
      const amt = Number(a.earned_inr) || 0
      if (!amt || !inWindow(a.booked_year, a.booked_month)) continue
      extras.push({
        employeeId: a.employee_id, month: monthKey(a.booked_year, a.booked_month), kind: 'ownership',
        basis: a.basis, programName: a.program?.name ?? 'Ownership reward',
        ruleId: a.rule_id, ruleLabel: a.rule?.label ?? null,
        percent: a.percent == null ? null : Number(a.percent),
        fixedAmountInr: a.fixed_amount_inr == null ? null : Number(a.fixed_amount_inr),
        amountInr: amt,
      })
    }
    for (const p of (payrollRes.data ?? []) as { employee_id: string; month: number; year: number; bonus: number | string | null; adjustment_earned: number | string | null }[]) {
      if (!inWindow(p.year, p.month)) continue
      const bonus = Number(p.bonus) || 0
      const adj = Number(p.adjustment_earned) || 0
      if (bonus) extras.push({ employeeId: p.employee_id, month: monthKey(p.year, p.month), kind: 'bonus', amountInr: bonus })
      if (adj) extras.push({ employeeId: p.employee_id, month: monthKey(p.year, p.month), kind: 'adjustment', amountInr: adj })
    }
  }

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
      payrollExtras={extras}
      currentPrices={currentPrices}
      canApply={{
        rating: hasPermission(me, PERMS.PAYROLL_EDIT),
        salary: hasPermission(me, PERMS.PAYROLL_EDIT),
        pricing: hasPermission(me, PERMS.SETTINGS_ACCESS),
      }}
    />
  )
}
