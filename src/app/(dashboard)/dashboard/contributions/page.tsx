import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility, userCanSee } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
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
  // 24-month window bounds the otherwise unbounded task list. Contributions for
  // tasks older than 24 months should already be finalized; the editor here is
  // for active/recent work. HAR showed this query was the slowest (2060ms) when
  // unbounded — capping dropped it to <500ms for a typical workload.
  const contribWindowFrom = new Date()
  contribWindowFrom.setMonth(contribWindowFrom.getMonth() - 24)
  const contribWindowFromStr = contribWindowFrom.toISOString().slice(0, 10)
  const tasksQuery = supabase
    .from('tasks')
    .select(vis.tasksPricing ? taskSelectWithPricing : taskSelectWithoutPricing)
    .in('status', ['pending', 'in_progress', 'done', 'delivered', 'invoiced', 'paid'])
    .gte('task_date', contribWindowFromStr)
    .order('task_date', { ascending: false })
    .order('id', { ascending: true })

  // Typed `any` because this stands in for a variety of Supabase query
  // builders whose return shapes differ — the consumer only reads `.data`.
  const noData: Promise<any> = Promise.resolve({ data: [] as any[] })

  // Wrap each query in a timer so we can spot the bottleneck in dev logs.
  // Output shows e.g. `[contrib query] tasksRes: 2840ms` so the slowest call
  // is obvious. Only runs in development — production has no overhead.
  // Accepts `PromiseLike<T>` (not `Promise<T>`) because Supabase query builders
  // are thenable but not real Promises until awaited.
  const timed = process.env.NODE_ENV === 'development'
    ? <T,>(label: string, p: PromiseLike<T>): Promise<T> => {
        const t0 = Date.now()
        return Promise.resolve(p).then(r => { console.log(`[contrib query] ${label}: ${Date.now() - t0}ms`); return r })
      }
    : <T,>(_: string, p: PromiseLike<T>): Promise<T> => Promise.resolve(p)

  const [
    tasksRes, employeesRes, groupsRes, parametersRes, toolsRes,
    paramServicesRes, toolServicesRes, groupServicesRes,
    scoresRes, clientsRes, servicesRes, assignmentsRes,
    contributorRecordsRes, taskToolRecordsRes, pricingRes,
    visibilityBillingRes, visibilityContribRes, visibilityNamesRes,
    taskGroupAssignmentsRes, taskParamAssignmentsRes, performanceHistoryRes
  ] = await Promise.all([
    // Tasks — same shape for both roles, employee select drops billing_amount_inr.
    timed('tasks',                  fetchAll(tasksQuery)),
    // Employee roster: both roles get the full active list so the UI can
    // resolve names on contributor chips and offer the assignee filter.
    timed('employees',              supabase.from('employees').select('id, cqid, name, performance_rating, role').eq('is_active', true).order('cqid')),
    timed('groups',                 supabase.from('contribution_groups').select('*').eq('is_active', true).order('display_order')),
    timed('parameters',             supabase.from('parameters').select('*').eq('is_active', true).order('display_order')),
    timed('tools',                  supabase.from('tools').select('*').eq('is_active', true).order('name')),
    timed('parameter_services',     supabase.from('parameter_services').select('parameter_id, service_id')),
    timed('tool_services',          supabase.from('tool_services').select('tool_id, service_id')),
    timed('group_services',         supabase.from('group_services').select('group_id, service_id')),
    // Scores: every viewer sees the rows so contributor chips render. The
    // earnings_inr field is included only when the viewer holds
    // `contributions.view_earnings`. score_percentage is non-monetary and
    // always included.
    // Bounded to the same 24-month window as the tasks query above — scores
    // older than this can't surface in the UI anyway because the tasks list
    // doesn't include those rows. HAR showed this was the slowest call on the
    // page (2477ms unbounded); the date filter drops it dramatically.
    timed('contribution_scores', vis.contributionEarnings
      ? fetchAll(supabase.from('contribution_scores').select('task_id, employee_id, earnings_inr, score_percentage, calculated_at').gte('calculated_at', contribWindowFromStr).order('id', { ascending: true }))
      : fetchAll(supabase.from('contribution_scores').select('task_id, employee_id, score_percentage, calculated_at').gte('calculated_at', contribWindowFromStr).order('id', { ascending: true }))),
    timed('clients',                supabase.from('clients').select('id, name').order('name')),
    timed('services',               supabase.from('services').select('id, name').order('name')),
    // Full task_assignments graph — both roles get it so contributor strips
    // and the assignee filter work the same way for everyone.
    timed('task_assignments',       fetchAll(supabase.from('task_assignments').select('task_id, employee_id').order('task_id', { ascending: true }).order('employee_id', { ascending: true }))),
    // Contributions ledger (numeric weights, not money) — visible to all.
    timed('contributions',          fetchAll(supabase.from('contributions').select('task_id, employee_id, parameter_id, value').gt('value', 0).order('id', { ascending: true }))),
    timed('task_tools', isAdmin
      ? fetchAll(supabase.from('task_tools').select('task_id, tool_id').order('task_id', { ascending: true }).order('tool_id', { ascending: true }))
      : noData),
    // Pricing matrix carries client-by-client rates — only sent to viewers
    // who hold tasks.view_pricing. Without that perm, employees still see
    // tasks/contributions but the per-client price table is suppressed.
    timed('pricing', vis.tasksPricing
      ? supabase.from('client_service_pricing').select('client_id, service_id, commission_percentage, price, currency')
      : noData),
    timed('vis_billing',            supabase.from('company_settings').select('value').eq('key', 'visibility_billing').maybeSingle()),
    timed('vis_contrib',            supabase.from('company_settings').select('value').eq('key', 'visibility_contributions').maybeSingle()),
    timed('vis_names',              supabase.from('company_settings').select('value').eq('key', 'visibility_employee_names').maybeSingle()),
    timed('task_group_assigns',     fetchAll(supabase.from('task_group_assignments').select('task_id, employee_id'))),
    timed('task_param_assigns',     fetchAll(supabase.from('task_parameter_assignments').select('task_id, employee_id'))),
    timed('performance_history',    fetchAll(supabase.from('employee_performance_history').select('*').order('effective_from', { ascending: false }))),
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
      performanceHistory={performanceHistoryRes.data || []}
      visibilitySettings={{
        billing:        (visibilityBillingRes.data?.value as string) || 'all',
        contributions:  (visibilityContribRes.data?.value as string) || 'all',
        employee_names: (visibilityNamesRes.data?.value as string) || 'all',
      }}
      permissionFlags={{
        earnings: vis.contributionEarnings,
        pricing:  vis.tasksPricing,
        viewAll:  isAdmin || userCanSee(me, PERMS.CONTRIBUTIONS_VIEW_ALL),
      }}
    />
  )
}
