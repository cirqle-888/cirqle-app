import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import ContributionsClient from './contributions-client'

export const dynamic = 'force-dynamic'

export default async function ContributionsPage() {
  // Service-role client bypasses RLS — all scoping is done at the application level below.
  const supabase = createAdminClient()

  // Best-effort load user role to apply optimizations
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin    = me?.isAdmin ?? true
  const isEmployee = !isAdmin
  const vis = financialVisibility(me)

  // Every viewer sees the full task list and contributor graph. Pricing
  // fields (billing_amount_inr, currency, etc.) are included ONLY when the
  // viewer holds `tasks.view_pricing` — otherwise they're stripped from the
  // payload before it leaves the server.
  const taskSelectWithPricing    = 'id, task_number, title, service_id, billing_amount_inr, status, task_date, client:clients(id, name), service:services(id, name)'
  const taskSelectWithoutPricing = 'id, task_number, title, service_id, status, task_date, client:clients(id, name), service:services(id, name)'
  const tasksQuery = supabase
    .from('tasks')
    .select(vis.tasksPricing ? taskSelectWithPricing : taskSelectWithoutPricing)
    .in('status', ['pending', 'in_progress', 'done', 'delivered', 'invoiced', 'paid'])
    .order('task_date', { ascending: false })
    .order('id', { ascending: true })

  const noData = Promise.resolve({ data: [] as any[] })

  const [
    tasksRes, employeesRes, groupsRes, parametersRes, toolsRes,
    paramServicesRes, toolServicesRes, groupServicesRes,
    scoresRes, clientsRes, servicesRes, assignmentsRes,
    contributorRecordsRes, taskToolRecordsRes, pricingRes,
    visibilityBillingRes, visibilityContribRes, visibilityNamesRes,
    taskGroupAssignmentsRes, taskParamAssignmentsRes
  ] = await Promise.all([
    // Tasks — same shape for both roles, employee select drops billing_amount_inr.
    fetchAll(tasksQuery),
    // Employee roster: both roles get the full active list so the UI can
    // resolve names on contributor chips and offer the assignee filter.
    supabase.from('employees').select('id, cqid, name, performance_rating, role').eq('is_active', true).order('cqid'),
    supabase.from('contribution_groups').select('*').eq('is_active', true).order('display_order'),
    supabase.from('parameters').select('*').eq('is_active', true).order('display_order'),
    supabase.from('tools').select('*').eq('is_active', true).order('name'),
    supabase.from('parameter_services').select('parameter_id, service_id'),
    supabase.from('tool_services').select('tool_id, service_id'),
    supabase.from('group_services').select('group_id, service_id'),
    // Scores: every viewer sees the rows so contributor chips render. The
    // earnings_inr field is included only when the viewer holds
    // `contributions.view_earnings`. score_percentage is non-monetary and
    // always included.
    vis.contributionEarnings
      ? fetchAll(supabase.from('contribution_scores').select('task_id, employee_id, earnings_inr, score_percentage').order('id', { ascending: true }))
      : fetchAll(supabase.from('contribution_scores').select('task_id, employee_id, score_percentage').order('id', { ascending: true })),
    supabase.from('clients').select('id, name').order('name'),
    supabase.from('services').select('id, name').order('name'),
    // Full task_assignments graph — both roles get it so contributor strips
    // and the assignee filter work the same way for everyone.
    fetchAll(supabase.from('task_assignments').select('task_id, employee_id').order('task_id', { ascending: true }).order('employee_id', { ascending: true })),
    // Contributions ledger (numeric weights, not money) — visible to all.
    fetchAll(supabase.from('contributions').select('task_id, employee_id, value').gt('value', 0).order('id', { ascending: true })),
    isAdmin
      ? fetchAll(supabase.from('task_tools').select('task_id, tool_id').order('task_id', { ascending: true }).order('tool_id', { ascending: true }))
      : noData,
    // Pricing matrix carries client-by-client rates — only sent to viewers
    // who hold tasks.view_pricing. Without that perm, employees still see
    // tasks/contributions but the per-client price table is suppressed.
    vis.tasksPricing
      ? supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage, price, currency')
      : noData,
    supabase.from('company_settings').select('value').eq('key', 'visibility_billing').maybeSingle(),
    supabase.from('company_settings').select('value').eq('key', 'visibility_contributions').maybeSingle(),
    supabase.from('company_settings').select('value').eq('key', 'visibility_employee_names').maybeSingle(),
    // Group + param assignment graph: visible to all for consistent filter UX.
    fetchAll(supabase.from('task_group_assignments').select('task_id, employee_id')),
    fetchAll(supabase.from('task_parameter_assignments').select('task_id, employee_id')),
  ])

  // Merge all assignment types into a unique list for visibility filtering
  const allAssignments = [
    ...(assignmentsRes.data || []),
    ...(taskGroupAssignmentsRes.data || []),
    ...(taskParamAssignmentsRes.data || [])
  ]

  // De-duplicate assignments by task_id and employee_id
  const uniqueAssignmentsMap = new Map<string, { task_id: string; employee_id: string }>()
  for (const a of allAssignments) {
    if (a && a.task_id && a.employee_id) {
      uniqueAssignmentsMap.set(`${a.task_id}-${a.employee_id}`, a)
    }
  }
  const mergedAssignments = Array.from(uniqueAssignmentsMap.values())

  return (
    <ContributionsClient
      tasks={tasksRes.data || []}
      employees={employeesRes.data || []}
      groups={groupsRes.data || []}
      parameters={parametersRes.data || []}
      tools={toolsRes.data || []}
      parameterServices={paramServicesRes.data || []}
      toolServices={toolServicesRes.data || []}
      groupServices={groupServicesRes.data || []}
      scores={scoresRes.data || []}
      clients={clientsRes.data || []}
      services={servicesRes.data || []}
      taskAssignments={mergedAssignments}
      contributorRecords={contributorRecordsRes.data || []}
      taskToolRecords={taskToolRecordsRes.data || []}
      pricingMatrix={pricingRes.data || []}
      visibilitySettings={{
        billing:        (visibilityBillingRes.data?.value as string) || 'all',
        contributions:  (visibilityContribRes.data?.value as string) || 'all',
        employee_names: (visibilityNamesRes.data?.value as string) || 'all',
      }}
      permissionFlags={{
        earnings: vis.contributionEarnings,
        pricing:  vis.tasksPricing,
      }}
    />
  )
}
