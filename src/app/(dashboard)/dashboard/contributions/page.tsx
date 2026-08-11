import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility, userCanSee } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import { resolveTaskVisibilityMode, filterTasksByVisibility } from '@/lib/tasks/visibility'
import {
  loadUnitScope, isUnitScoped, scopeRowsByUnitMember, scopeTasksByUnit, unitTaskIdsFrom,
} from '@/lib/scope/unit-scope'
import ContributionsClient from './contributions-client'

export const dynamic = 'force-dynamic'

export default async function ContributionsPage() {
  // Service-role client bypasses RLS — all scoping is done at the application level below.
  const supabase = createAdminClient()

  // Best-effort load user role to apply optimizations
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin    = me?.isAdmin ?? false
  const isEmployee = !isAdmin
  const vis = financialVisibility(me)

  // Access control (decided with the user):
  //  • viewAll        — see EVERY employee's contributions/scores/names. Without
  //    it, the payload below is stripped server-side to the viewer's OWN rows so
  //    other contributors never reach the browser at all (real privacy, not just
  //    a UI hide). Tasks themselves stay full — all tasks show, other contributors
  //    are simply absent.
  //  • viewUnit       — the middle rung (contributions.view_unit): the same strip,
  //    widened from "just me" to everyone in my department / team / branch /
  //    region and every unit beneath it. Resolved below, after the org graph
  //    loads; ignored when viewAll is held.
  //  • canViewActivity — see the per-task activity log + post log notes.
  const viewAll         = isAdmin || userCanSee(me, PERMS.CONTRIBUTIONS_VIEW_ALL)
  const canViewActivity = isAdmin || userCanSee(me, PERMS.CONTRIBUTIONS_VIEW_ACTIVITY)
  const myEmployeeId    = me?.employeeId ?? null

  // Every viewer sees the full task list and contributor graph. Pricing
  // fields (billing_amount_inr, currency, etc.) are included ONLY when the
  // viewer holds `tasks.view_pricing` — otherwise they're stripped from the
  // payload before it leaves the server.
  // quantity is a count, not a price — included in both variants (see Qty display in contributions-client.tsx).
  // client_id and bill_as_extra are required by the shared TaskEditModal:
  // without them the Client field renders empty and the retainer-coverage
  // lookup never fires, so a covered task silently loses its coverage card.
  // client_id is required by the shared TaskEditModal: without it the Client
  // field renders empty and the retainer-coverage lookup never fires, so a
  // covered task silently loses its coverage card. bill_as_extra/billing_mode/
  // currency ride along only for pricing-visible viewers, mirroring the tasks
  // page's financial stripping.
  // retainer_item_id/work_value_inr: covered tasks bill 0 but pool from the
  // agreement's work value. work_value_inr is money → pricing-visible only.
  //
  // The commission override is fetched SEPARATELY below, never embedded:
  // PostgREST sees two relationships between tasks and client_agreement_items
  // (the retainer_item_id FK, and the legacy client_agreement_tasks join
  // table), so an unqualified embed fails with PGRST201 — and because the
  // embed is part of the main task select, that failure returned ZERO TASKS
  // for the whole page rather than merely dropping the override.
  const taskSelectWithPricing    = 'id, task_number, title, client_id, service_id, billing_amount_inr, quantity, status, task_date, bill_as_extra, retainer_item_id, work_value_inr, parent_task_id, billing_mode, currency, client:clients(id, name, code), service:services(id, name)'
  const taskSelectWithoutPricing = 'id, task_number, title, client_id, service_id, quantity, status, task_date, retainer_item_id, parent_task_id, client:clients(id, name, code), service:services(id, name)'
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
    .is('deleted_at', null)
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
    contributorRecordsRes, taskToolRecordsRes, pricingRes, agreementsRes,
    visibilityBillingRes, visibilityContribRes, visibilityNamesRes,
    taskGroupAssignmentsRes, taskParamAssignmentsRes, performanceHistoryRes,
    employeeServicesRes, unitScope,
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
    timed('clients',                supabase.from('clients').select('id, name, code').order('name')),
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
    timed('agreements',             supabase.from('employee_commission_agreements').select('id, employee_id, client_id, service_id, agreement_type, agreement_value, currency, effective_from, effective_to, is_active').eq('is_active', true)),
    timed('vis_billing',            supabase.from('company_settings').select('value').eq('key', 'visibility_billing').maybeSingle()),
    timed('vis_contrib',            supabase.from('company_settings').select('value').eq('key', 'visibility_contributions').maybeSingle()),
    timed('vis_names',              supabase.from('company_settings').select('value').eq('key', 'visibility_employee_names').maybeSingle()),
    timed('task_group_assigns',     fetchAll(supabase.from('task_group_assignments').select('task_id, group_id, employee_id'))),
    timed('task_param_assigns',     fetchAll(supabase.from('task_parameter_assignments').select('task_id, employee_id'))),
    timed('performance_history',    fetchAll(supabase.from('employee_performance_history').select('*').order('effective_from', { ascending: false }))),
    // Employee ↔ service assignments — drives "only employees of this task's
    // service" in the scoring UI. Missing table (pre-migration) → empty list.
    timed('employee_services',      supabase.from('employee_services').select('employee_id, service_id')),
    // Org-unit scope (contributions.view_unit). Short-circuits to an empty
    // scope without a query for every viewer who isn't unit-scoped.
    timed('unit_scope',             loadUnitScope(supabase, me, 'contributions')),
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

  // ── Server-side privacy strip ──────────────────────────────────────────────
  // When the viewer lacks `contributions.view_all`, drop every row that belongs
  // to someone outside their scope BEFORE it leaves the server, and send only
  // the matching employee records. The contributor graph for everyone else then
  // simply doesn't exist client-side — nothing to leak via dev tools or the
  // network tab.
  //
  // Three rungs, widest first:
  //   viewAll  → every row
  //   viewUnit → every member of the viewer's org unit subtree (always
  //              including the viewer, even when they belong to no unit — so
  //              an unconfigured org chart degrades to exactly the own-rows
  //              behaviour the grant replaced, never to a blank page)
  //   neither  → the viewer's own rows
  const viewUnit = !viewAll && isUnitScoped(unitScope)

  const mine = <T extends { employee_id?: string }>(rows: T[]): T[] => {
    if (viewAll) return rows
    if (viewUnit) return scopeRowsByUnitMember(rows, unitScope, r => r.employee_id)
    return rows.filter(r => r.employee_id === myEmployeeId)
  }

  const outEmployees = viewAll
    ? (employeesRes.data || [])
    : viewUnit
      ? (employeesRes.data || []).filter((e: any) => unitScope.memberEmployeeIds.has(e.id))
      : (employeesRes.data || []).filter((e: any) => e.id === myEmployeeId)
  const outScores             = mine(scoresRes.data || [])
  const outContributorRecords = mine(contributorRecordsRes.data || [])
  const outAssignments        = mine(mergedAssignments)

  // ── Service-scoped task visibility (tasks.view_by_service) ────────────────
  // Opt-in restriction: viewers with the perm (and without tasks.view_all) see
  // only tasks of their assigned services, plus tasks they personally worked on.
  const visibilityMode = resolveTaskVisibilityMode(me)
  let outTasks = tasksRes.data || []
  if (visibilityMode === 'services' && myEmployeeId) {
    const myServiceIds = (employeeServicesRes.data || [])
      .filter((es: any) => es.employee_id === myEmployeeId)
      .map((es: any) => es.service_id)
    const ownTaskIds = new Set<string>([
      ...mergedAssignments.filter(a => a.employee_id === myEmployeeId).map(a => a.task_id),
      ...(scoresRes.data || []).filter((s: any) => s.employee_id === myEmployeeId).map((s: any) => s.task_id),
      ...(contributorRecordsRes.data || []).filter((c: any) => c.employee_id === myEmployeeId).map((c: any) => c.task_id),
    ])
    outTasks = filterTasksByVisibility(outTasks, visibilityMode, myServiceIds, ownTaskIds)
  }

  // ── Org-unit task scoping ─────────────────────────────────────────────────
  // A unit-scoped viewer scores their own team's worklist: tasks whose client
  // or service the unit owns, plus anything the viewer or a unit-mate has
  // history on. No-op when the unit maps no revenue (see scopeTasksByUnit).
  if (viewUnit) {
    const unitTaskIds = unitTaskIdsFrom(unitScope, [
      mergedAssignments,
      (scoresRes.data || []) as any[],
      (contributorRecordsRes.data || []) as any[],
    ])
    outTasks = scopeTasksByUnit(outTasks as any[], unitScope, {
      id:        (t: any) => t.id,
      clientId:  (t: any) => t.client_id,
      serviceId: (t: any) => t.service_id,
    }, unitTaskIds)
  }

  // Agreement-item commission overrides for retainer-linked tasks. A SEPARATE
  // query, never an embed (see the select comment above). Defensive: on any
  // error the tasks simply fall back to the pricing matrix / default 50, which
  // is what happened before this existed.
  const retainerItemIds = Array.from(new Set(
    (outTasks as { retainer_item_id?: string | null }[])
      .map(t => t.retainer_item_id)
      .filter(Boolean) as string[],
  ))
  let agreementItems: { id: string; work_commission_pct: number | null }[] = []
  if (retainerItemIds.length > 0) {
    try {
      const { data } = await supabase
        .from('client_agreement_items')
        .select('id, work_commission_pct')
        .in('id', retainerItemIds)
      agreementItems = (data as typeof agreementItems) || []
    } catch { /* fall back to the pricing matrix */ }
  }

  return (
    <ContributionsClient
      agreementItems={agreementItems}
      tasks={outTasks}
      employees={outEmployees}
      groups={groupsRes.data || []}
      parameters={parametersRes.data || []}
      tools={toolsRes.data || []}
      parameterServices={paramServicesRes.data || []}
      toolServices={toolServicesRes.data || []}
      groupServices={groupServicesRes.data || []}
      employeeServices={employeeServicesRes.data || []}
      scores={outScores}
      clients={clientsRes.data || []}
      services={servicesRes.data || []}
      taskAssignments={outAssignments}
      contributorRecords={outContributorRecords}
      taskToolRecords={taskToolRecordsRes.data || []}
      pricingMatrix={pricingRes.data || []}
      agreements={agreementsRes.data || []}
      performanceHistory={performanceHistoryRes.data || []}
      visibilitySettings={{
        billing:        (visibilityBillingRes.data?.value as string) || 'all',
        contributions:  (visibilityContribRes.data?.value as string) || 'all',
        employee_names: (visibilityNamesRes.data?.value as string) || 'all',
      }}
      permissionFlags={{
        earnings:     vis.contributionEarnings,
        pricing:      vis.tasksPricing,
        // Unit viewers get the multi-employee roster UI: the payload above
        // already contains only their unit, so "all" here means "everyone in
        // what you were sent", not everyone in the company.
        viewAll:      viewAll || viewUnit,
        viewActivity: canViewActivity,
      }}
    />
  )
}
