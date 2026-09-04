import { createAdminClient, fetchAll, stablePaginationQuery, safeQuery, columnExists } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility, stripTaskListPricing, userCanSee } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import { resolveTaskVisibilityMode, fetchEmployeeServiceIds, filterTasksByVisibility } from '@/lib/tasks/visibility'
import { loadUnitScope, scopeTasksByUnit, unitTaskIdsFrom } from '@/lib/scope/unit-scope'
import { loadServiceScope } from '@/lib/scope/service-scope'
import { visibleEmployeeIds, scopeEmployeeList, stripEmployeeNames } from '@/lib/scope/employee-scope'
import { getPendingPricing } from '@/lib/pricing/pending'
import { PricingPendingBanner } from '@/components/pricing/pricing-pending-banner'
import { composeRequestDescription, sanitizeCaptionCanvas } from '@/lib/social/plan'
import TasksClient from './tasks-client'

export const dynamic = 'force-dynamic'

// Admin select — every column the Task interface / edit modal actually reads,
// spelled out instead of `*`. Egress: this page ships EVERY task on EVERY
// visit, so per-row weight is multiplied by ~2,000; `*` also dragged along
// scope, created_by, updated_at, billing_exchange_rate and contributions_locked,
// which nothing on the page renders. Add new columns here deliberately.
const ADMIN_TASK_SELECT = `id, task_number, title, description, client_id, service_id, status, billing_amount, billing_amount_inr, quantity, currency, task_date, created_at, deleted_at, is_recurring, recurring_interval, recurring_end_date, recurring_parent_id, cancelled_by, cancellation_notes, honor_contributions, loss_amount, completion_pct, parent_task_id, variant_type, variant_label, billing_mode, billing_percent, billing_override, is_billable, package_id, billing_rule, billing_snapshot, client:clients(id, name, code), service:services!service_id(id, name)`

// Employee select — explicit column list with ALL financial fields stripped.
// These never enter the client JS state for employees:
//   billing_amount, billing_amount_inr, currency, loss_amount, billing_mode,
//   billing_percent, billing_override, is_billable, honor_contributions.
// Quantity is kept because it represents task count, not money.
const EMPLOYEE_TASK_SELECT = `id, title, task_number, status, task_date, client_id, service_id, quantity, description, created_at, updated_at, parent_task_id, variant_type, variant_label, completion_pct, is_recurring, recurring_interval, recurring_end_date, recurring_parent_id, cancelled_by, cancellation_notes, client:clients(id, name, code), service:services!service_id(id, name)`

// Statuses that represent live work. These are ALWAYS loaded in full no matter
// how old they are — an eighteen-month-old task still sitting in `pending` has
// to appear on the board, or the board lies.
const LIVE_TASK_STATUSES = ['pending', 'in_progress', 'delivered'] as const

// How far back to load *settled* tasks (done / invoiced / cancelled) for the
// in-memory working set. Anything older is still fully reachable — tasks-client
// falls back to a server-side DB search whenever `dbTaskTotal > tasks.length`,
// which bounding this fetch is precisely what activates.
//
// EGRESS: this is the single biggest lever on the page. Previously this
// function pulled EVERY task row on EVERY visit (the select alone carries
// `description` and the `billing_snapshot` jsonb), under `force-dynamic`, with
// only a 30s router cache in front of it. Tune with TASKS_HISTORY_MONTHS.
const TASKS_HISTORY_MONTHS = Number(process.env.TASKS_HISTORY_MONTHS) || 12

function historyCutoffISO(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return d.toISOString().slice(0, 10)
}

// Supabase enforces a server-side max-rows cap (default 1,000) that overrides
// any client `.limit()` value. To fetch the working set we paginate with
// `.range()` in chunks of 1,000 until we hit a partial page. Capped at 50,000
// as a runaway-safety guard (10× more than any real agency should hit).
async function fetchAllTasks(
  supabase: ReturnType<typeof createAdminClient>,
  hasDeletedAt: boolean,
  selectClause: string,
  /**
   * Opt-in escape hatch (`?history=all`). Loads every task regardless of age,
   * exactly as this function did before the window was introduced.
   *
   * SECURITY: this is deliberately a SERVER-side widening. It reuses this same
   * admin-client query and therefore stays behind the identical downstream
   * pipeline — stripTaskListPricing, filterTasksByVisibility and
   * scopeTasksByUnit all still run on the result. It is NOT the browser
   * DB-search path (that one uses the RLS-scoped anon client, which cannot
   * reproduce the service/unit visibility model and so remains admin-only).
   * Widening the window therefore cannot reveal a task the viewer could not
   * already see; it only changes how far back we look.
   */
  fullHistory = false,
) {
  const PAGE = 1000
  const MAX_PAGES = 50
  const all: any[] = []
  const cutoff = historyCutoffISO(TASKS_HISTORY_MONTHS)
  // "Every live task, whatever its age" OR "anything dated inside the window".
  // `task_date.is.null` keeps undated rows, which a bare `gte` would drop.
  const windowFilter =
    `status.in.(${LIVE_TASK_STATUSES.join(',')}),task_date.gte.${cutoff},task_date.is.null`

  for (let page = 0; page < MAX_PAGES; page++) {
    let q = supabase
      .from('tasks')
      .select(selectClause)
      .order('task_number', { ascending: false, nullsFirst: false })
      .order('id', { ascending: true })
      .range(page * PAGE, (page + 1) * PAGE - 1)
    if (!fullHistory) q = q.or(windowFilter)
    if (hasDeletedAt) q = q.is('deleted_at', null)

    const { data, error } = await q
    if (error) {
      console.error('[tasks/page] fetchAllTasks query error', { page, message: error.message })
      break
    }
    if (!data) break
    all.push(...data)
    if (data.length < PAGE) break
  }

  return all
}

/**
 * Build the set of task IDs the current employee has any history on:
 * direct assignments, group/parameter assignments, contributions, scores.
 * Used by the "My Tasks" filter on the client. Employees by default see all
 * tasks; this Set is consulted only when they activate the toggle.
 */
async function fetchEmployeeOwnTaskIds(
  supabase: ReturnType<typeof createAdminClient>,
  employeeId: string,
): Promise<string[]> {
  const [
    { data: assignments },
    { data: groupAssign  },
    { data: paramAssign  },
    { data: scoreRows    },
    { data: contribRows  },
  ] = await Promise.all([
    supabase.from('task_assignments').select('task_id').eq('employee_id', employeeId),
    supabase.from('task_group_assignments').select('task_id').eq('employee_id', employeeId),
    supabase.from('task_parameter_assignments').select('task_id').eq('employee_id', employeeId),
    supabase.from('contribution_scores').select('task_id').eq('employee_id', employeeId),
    supabase.from('contributions').select('task_id').eq('employee_id', employeeId),
  ])
  const all = new Set<string>()
  for (const r of (assignments || []) as any[]) if (r.task_id) all.add(r.task_id)
  for (const r of (groupAssign  || []) as any[]) if (r.task_id) all.add(r.task_id)
  for (const r of (paramAssign  || []) as any[]) if (r.task_id) all.add(r.task_id)
  for (const r of (scoreRows    || []) as any[]) if (r.task_id) all.add(r.task_id)
  for (const r of (contribRows  || []) as any[]) if (r.task_id) all.add(r.task_id)
  return Array.from(all)
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  // createClient() (anon key + session) used only for auth via loadCurrentUser().
  // createAdminClient() (service role) bypasses RLS for all data queries server-side.
  const supabase = createAdminClient()

  // ── Request promotion (?fromRequest=<id>) — design §5 ─────────────────────
  // Fetch the request so the Add Task modal opens prefilled. Defensive: bad id
  // or missing portal tables simply yields no prefill.
  let promotionRequest: any = null
  const sp = searchParams ? await searchParams : undefined
  // `?history=all` widens the task window from TASKS_HISTORY_MONTHS to everything.
  // This is the on-demand path for reaching settled tasks older than the window —
  // notably the only one available to employees, for whom the browser DB search is
  // (correctly) disabled. See fetchAllTasks' `fullHistory` note.
  const fullHistory = sp?.history === 'all'
  const fromRequest = typeof sp?.fromRequest === 'string' ? sp.fromRequest : null
  if (fromRequest) {
    try {
      const { data: req } = await supabase
        .from('task_requests')
        .select('id, ref_no, title, description, remarks, design_plan, priority, due_date, client_id, service_id, content_link, reference_link, drive_folder_link, extra_links, promoted_task_id')
        .eq('id', fromRequest)
        .maybeSingle()
      if (req && !req.promoted_task_id) {
        // Compose the description block (remarks / plan / links / priority).
        const parts: string[] = []
        if (req.description) parts.push(req.description)
        if (req.design_plan) parts.push(`Design plan:\n${req.design_plan}`)
        if (req.remarks) parts.push(`Remarks:\n${req.remarks}`)
        const links: string[] = []
        if (req.content_link) links.push(`Content: ${req.content_link}`)
        if (req.reference_link) links.push(`Reference: ${req.reference_link}`)
        if (req.drive_folder_link) links.push(`Drive folder: ${req.drive_folder_link}`)
        for (const l of (req.extra_links || [])) if (l?.url) links.push(`${l.label || 'Link'}: ${l.url}`)
        if (links.length) parts.push(`Reference links:\n${links.join('\n')}`)
        if (req.priority && req.priority !== 'normal') parts.push(`Priority: ${req.priority}`)
        promotionRequest = {
          id: req.id,
          ref_no: req.ref_no,
          title: req.title,
          description: parts.join('\n\n'),
          client_id: req.client_id,
          service_id: req.service_id,
          due_date: req.due_date,
        }
      }
    } catch { /* portal not migrated — ignore */ }
  }

  // ── Direct calendar promotion (?fromSocialItem=<id>) ──────────────────────
  // The Social Calendar's second exit: straight to a task, no request in
  // between. Same shape as promotionRequest above so the client component
  // prefills identically; only the link-back target differs.
  let promotionSocialItem: any = null
  const fromSocialItem = typeof sp?.fromSocialItem === 'string' ? sp.fromSocialItem : null
  if (fromSocialItem) {
    try {
      // task_id needs 20260825120000. Retry without it rather than failing the
      // prefill outright — otherwise, before the migration lands, "Send to
      // Tasks" would drop the user on an empty Tasks page with no explanation.
      let raw: any = null
      for (const withTaskId of [true, false]) {
        const res = await supabase
          .from('social_calendar_items')
          .select('id, title, content_type, platforms, caption, notes, scheduled_date, scheduled_end_date, ' +
            'variants, reference_url, reference_urls, caption_canvas, service_id, assigned_employee_id, ' +
            'status, request_id' + (withTaskId ? ', task_id' : '') +
            ', calendar:social_calendars(id, title, client_id)')
          .eq('id', fromSocialItem)
          .maybeSingle()
        if (!res.error) { raw = res.data; break }
        if (!withTaskId) break
      }
      const it = raw as any
      // Only an unrouted item may be tasked — one that already went to
      // Requests, or already has a task, must not spawn a second one.
      // (`task_id` is undefined pre-migration, which correctly reads as unset.)
      if (it && !it.request_id && !it.task_id && it.status === 'planned') {
        const cal: any = Array.isArray(it.calendar) ? it.calendar[0] : it.calendar
        promotionSocialItem = {
          id: it.id,
          title: it.title,
          // Reuse the exact brief the Requests route composes, so the designer
          // reads the same thing either way.
          description: composeRequestDescription({
            title: it.title, contentType: it.content_type, platforms: it.platforms || [],
            scheduledDate: it.scheduled_date, scheduledEndDate: it.scheduled_end_date,
            caption: it.caption, notes: it.notes,
            calendarTitle: cal?.title, variants: it.variants,
            referenceUrls: it.reference_urls?.length ? it.reference_urls : (it.reference_url ? [it.reference_url] : []),
            captionCanvas: sanitizeCaptionCanvas(it.caption_canvas),
          }),
          client_id: cal?.client_id ?? '',
          service_id: it.service_id || '',
          due_date: it.scheduled_date,
          assigned_employee_id: it.assigned_employee_id || null,
        }
      }
    } catch { /* calendar or direct-task migration not applied — ignore */ }
  }

  // Best-effort load user role to apply optimizations
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin   = me?.isAdmin ?? false
  const vis = financialVisibility(me)

  const canAccessContribs = isAdmin
    || userCanSee(me, PERMS.CONTRIBUTIONS_VIEW_ALL)
    || userCanSee(me, PERMS.CONTRIBUTIONS_EDIT)
  const canViewContribs = isAdmin
    || userCanSee(me, PERMS.CONTRIBUTIONS_VIEW_OWN)
    || userCanSee(me, PERMS.CONTRIBUTIONS_VIEW_ALL)
  const canEditContribs = userCanSee(me, PERMS.CONTRIBUTIONS_EDIT)

  // Process-level cached probe (HAR showed this 400'd on every load).
  // Now: one round-trip per server lifetime instead of per page nav.
  // (Whole try-and-fallback dance exists because legacy installs may pre-date
  // the soft-delete migration. After the column lands universally, both this
  // and the `hasDeletedAt` branches below can be deleted.)
  const hasDeletedAt = await columnExists(supabase, 'tasks', 'deleted_at')
  // Same dance for the waiver reason (migration 20260829140000): the column is
  // new, and naming it in the select before it exists 400s the whole page.
  const [hasNoChargeReason, hasPackageCountsAs] = await Promise.all([
    columnExists(supabase, 'tasks', 'no_charge_reason'),
    columnExists(supabase, 'tasks', 'package_counts_as_service_id'),
  ])

  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()

  // Auto-purge tasks deleted more than 45 days ago. Fire-and-forget so the page
  // render doesn't wait on a write query that doesn't affect what we display
  // (purged rows are >45d old anyway, far outside the visible window).
  if (hasDeletedAt) {
    void supabase.from('tasks').delete().not('deleted_at', 'is', null).lt('deleted_at', cutoff)
  }

  // Pricing-aware select: viewers with `tasks.view_pricing` get the full row;
  // viewers without it get the explicit financial-stripped column list so
  // billing_amount / loss_amount / currency / billing_mode never reach the
  // client JS state. This replaces the old binary isAdmin gate so designated
  // roles can be granted task visibility without pricing.
  // Typed as plain string: the explicit column list is long enough that
  // supabase-js's literal-type parser hits TS2589 (excessively deep) on it.
  // Plain `string` for the same reason as selectClause below: a template
  // literal here trips supabase-js's select-literal parser (TS2589-adjacent).
  const serviceSelect: string = 'id, name, default_price, default_currency, pricing_type'
  const selectClause: string = (vis.tasksPricing ? ADMIN_TASK_SELECT : EMPLOYEE_TASK_SELECT)
    + (vis.tasksPricing && hasNoChargeReason ? ', no_charge_reason' : '')
    + (vis.tasksPricing && hasPackageCountsAs ? ', package_counts_as_service_id' : '')

  // Service-scoped task visibility (tasks.view_by_service). 'services' viewers
  // only receive tasks of their assigned services plus tasks they worked on —
  // filtered server-side below so hidden tasks never reach the client state.
  const visibilityMode = resolveTaskVisibilityMode(me)

  // Fetch tasks via pagination (bypasses Supabase's 1000-row response cap)
  // in parallel with all the smaller reference-data queries, including the
  // three visibility_* settings rows (used to be a separate sequential await).
  const [allTasks, dbCountRes, clientsRes, servicesRes, clientPricingsRes, employeesRes, taskAssignmentsRes,
    groupsRes, paramsRes, groupServicesRes, paramServicesRes,
    taskGroupsRes, taskGroupAssignmentsRes, taskParamAssignmentsRes, myTaskIds,
    visibilityBillingRes, visibilityContribRes, visibilityNamesRes, myServiceIds, unitScope,
    packagesRes, packageItemsRes] = await Promise.all([
    fetchAllTasks(supabase, hasDeletedAt, selectClause, fullHistory),
    // Real DB count of all tasks (used for the "DB search" fallback in the UI).
    hasDeletedAt
      ? supabase.from('tasks').select('id', { count: 'exact', head: true }).is('deleted_at', null)
      : supabase.from('tasks').select('id', { count: 'exact', head: true }),
    supabase.from('clients').select('id, name, code').eq('is_active', true).order('name'),
    // Services: viewers with `tasks.view_pricing` get default_price/currency/
    // pricing_type so admin task editors can use them; others get name only.
    vis.tasksPricing
      ? supabase.from('services').select(serviceSelect).eq('is_active', true).order('display_order').order('name')
      : supabase.from('services').select('id, name').eq('is_active', true).order('display_order').order('name'),
    // Pricing matrix is pure money — only sent to viewers with tasks.view_pricing.
    vis.tasksPricing
      ? supabase.from('client_service_pricing').select('client_id, service_id, price, currency')
      : Promise.resolve({ data: [] as any[], error: null }),
    // Full active employee roster is needed by both admins and employees so
    // task cards can show assignee names and the filter dropdown lists peers.
    supabase.from('employees').select('id, cqid, name, is_active, performance_rating').eq('is_active', true).order('cqid'),
    // Global task_assignments so employees can see who is on each task and
    // filter by any teammate. Just (task_id, employee_id) — no extra data.
    // safeQuery short-circuits the round-trip once the table is known missing.
    safeQuery('task_assignments', supabase.from('task_assignments').select('task_id, employee_id')),
    canAccessContribs
      ? supabase.from('contribution_groups').select('*').order('display_order')
      : Promise.resolve({ data: [] as any[], error: null }),
    canAccessContribs
      ? supabase.from('parameters').select('*').order('display_order')
      : Promise.resolve({ data: [] as any[], error: null }),
    canAccessContribs
      ? supabase.from('group_services').select('group_id, service_id')
      : Promise.resolve({ data: [] as any[], error: null }),
    isAdmin
      ? supabase.from('parameter_services').select('parameter_id, service_id')
      : Promise.resolve({ data: [] as any[], error: null }),
    // task_groups: group-category mapping. Admin-only — employees have no board group UI.
    isAdmin
      ? safeQuery('task_groups', supabase.from('task_groups').select('task_id, group_id'))
      : Promise.resolve({ data: [] as any[], error: null }),
    // Group/param assignments are part of the assignment graph; surfaced to all
    // so the "My Tasks" toggle plus assignee filter can resolve full history.
    safeQuery('task_group_assignments', supabase.from('task_group_assignments').select('task_id, group_id, employee_id')),
    safeQuery('task_parameter_assignments', supabase.from('task_parameter_assignments').select('task_id, parameter_id, employee_id')),
    // myTaskIds — the ids the current viewer (employee OR admin) personally has
    // any history on. Lightweight join; used by the "My Tasks" / "Not My Tasks"
    // filters on the client — admins have employee records too and can be
    // assignees/contributors, so this isn't employee-only.
    me?.employeeId
      ? fetchEmployeeOwnTaskIds(supabase, me.employeeId)
      : Promise.resolve([] as string[]),
    supabase.from('company_settings').select('value').eq('key', 'visibility_billing').maybeSingle(),
    supabase.from('company_settings').select('value').eq('key', 'visibility_contributions').maybeSingle(),
    supabase.from('company_settings').select('value').eq('key', 'visibility_employee_names').maybeSingle(),
    // Services assigned to the viewer (employee_services) — only needed when
    // their designation restricts task visibility by service.
    visibilityMode === 'services' && me?.employeeId
      ? fetchEmployeeServiceIds(supabase, me.employeeId)
      : Promise.resolve([] as string[]),
    // Org-unit task visibility (tasks.view_by_unit). Short-circuits without a
    // query for every viewer who isn't unit-scoped.
    loadUnitScope(supabase, me, 'tasks'),
    // Packages + their included lines, so the list can label each task
    // Package / Extra / Waived without opening it. Tiny tables (a handful of
    // rows), and only for viewers who can see billing at all.
    vis.tasksPricing
      ? safeQuery('client_packages', supabase.from('client_packages')
          .select('id, client_id, name, billing_type, start_date, end_date, first_cycle_end, status, deleted_at')
          .eq('status', 'active').is('deleted_at', null))
      : Promise.resolve({ data: [] as any[], error: null }),
    vis.tasksPricing
      ? safeQuery('client_package_items', supabase.from('client_package_items')
          .select('id, package_id, service_id, included_quantity, display_order'))
      : Promise.resolve({ data: [] as any[], error: null }),
  ])

  // Fetch trash only if column exists. Trash uses the same pricing-aware
  // select so a non-pricing viewer never receives financial fields even for
  // soft-deleted rows.
  let trashRes = { data: [] as any[] }
  if (hasDeletedAt) {
    const q = supabase
      .from('tasks')
      .select(selectClause)
      .not('deleted_at', 'is', null)
      .gte('deleted_at', cutoff)
      .order('deleted_at', { ascending: false })

    trashRes = await fetchAll(stablePaginationQuery(q)) as any
  }
  // Belt-and-suspenders: even with the right select, run the strip helper to
  // guarantee no late-added column slips through if a future select switches
  // to `*`. Cheap no-op when vis.tasksPricing is true.
  // Org-unit scoping (tasks.view_by_unit) stacks on top of the service filter:
  // the unit's own clients/services, plus every task the viewer or one of
  // their unit-mates has history on. Ids come from the assignment graph
  // already fetched above — no extra query. No-op when the viewer isn't
  // unit-scoped, or when their unit maps no revenue at all.
  const unitTaskIds = unitTaskIdsFrom(unitScope, [
    (taskAssignmentsRes.data || []) as any[],
    (taskGroupAssignmentsRes.data || []) as any[],
    (taskParamAssignmentsRes.data || []) as any[],
  ])
  const scopeToUnit = (rows: any[]) => scopeTasksByUnit(rows, unitScope, {
    id:        (t: any) => t.id,
    clientId:  (t: any) => t.client_id,
    serviceId: (t: any) => t.service_id,
  }, unitTaskIds)

  const initialTasks = scopeToUnit(filterTasksByVisibility(
    stripTaskListPricing(allTasks || [], vis.tasksPricing),
    visibilityMode, myServiceIds, myTaskIds,
  ))
  const initialTrash = scopeToUnit(filterTasksByVisibility(
    stripTaskListPricing((trashRes.data || []) as any[], vis.tasksPricing),
    visibilityMode, myServiceIds, myTaskIds,
  ))

  // Pending-to-price banner — only for users who can see/set pricing.
  const pendingPricing = vis.tasksPricing ? await getPendingPricing(supabase) : { clients: [], services: [], total: 0 }

  // Tasks promoted from external requests → "REQ-xxxx" chip on task rows so
  // employees can open the request brief (design plan, links) from the task.
  // Defensive: the portal tables may not exist pre-migration.
  const requestRefByTaskId: Record<string, { id: string; ref_no: number }> = {}
  try {
    const { data: promoted } = await supabase
      .from('task_requests')
      .select('id, ref_no, promoted_task_id')
      .not('promoted_task_id', 'is', null)
    for (const r of promoted || []) {
      if (r.promoted_task_id) requestRefByTaskId[r.promoted_task_id] = { id: r.id, ref_no: r.ref_no }
    }
  } catch { /* portal not migrated */ }

  // Pending (new, unstarted) external requests — count for the Requests button
  // badge. Server-side (admin client) since task_requests is admin-scoped.
  let pendingRequestCount = 0
  try {
    const { count } = await supabase
      .from('task_requests')
      .select('id', { count: 'exact', head: true })
      .in('status', ['submitted', 'under_review', 'approved'])
    pendingRequestCount = count ?? 0
  } catch { /* portal not migrated */ }

  // ?q=… deep link (e.g. "View Task #42" from a request) pre-fills the search.
  const initialSearch = typeof sp?.q === 'string' ? sp.q : ''

  // Structured deep link, used by the Packages page to open exactly the work a
  // package covers: ?client=<id>&service=<id>&from=<date>&to=<date>. A name in
  // ?q= would also match a different client with a similar name; ids can't.
  const one = (k: string) => (typeof sp?.[k] === 'string' ? (sp[k] as string) : '')
  const initialClient = one('client')
  const initialService = one('service')
  const from = one('from'), to = one('to')
  const initialDateRange = from && to ? { from, to } : null

  // ── Service catalogue, scoped the same way tasks are ──────────────────────
  // Task ROWS were already filtered by service, but the catalogue behind the
  // Service filter and the Add Task picker was the full active list — so a
  // designer scoped to Social Media still read every other department's
  // service names ("Offer Flyer", "A3 Offer Flyer", …) in the dropdowns, and
  // could file a task against them.
  //
  // Mirrors filterTasksByVisibility EXACTLY, including its no-lockout rule:
  // only narrows in 'services' mode, and an employee with zero assignments
  // keeps the full list rather than being left with an empty picker.
  //
  // Safe for display: task rows render task.service?.name, embedded by the
  // server join, so a task whose service falls outside the scope still shows
  // its real name rather than blank.
  // ── Colleague visibility ───────────────────────────────────────────────────
  // Task scoping says whose WORK you see; this says which PEOPLE exist for you.
  // Without it a designer scoped to Social Media still got the whole staff list
  // in the Assignee filter — a designer from another department they have no
  // working relationship with.
  //
  // Same fail-open contract as the task filter: null = no narrowing, which is
  // what an admin and a half-configured account both get.
  const employeeScope = await loadServiceScope(supabase, me, 'tasks')
  const visibleEmpIds = await visibleEmployeeIds(supabase, employeeScope)
  const canRevealNames = isAdmin || userCanSee(me, PERMS.EMPLOYEES_REVEAL_NAMES)
  const scopedEmployees = stripEmployeeNames(
    scopeEmployeeList((employeesRes.data || []) as { id: string; name?: string | null }[], visibleEmpIds),
    canRevealNames,
  )

  // Cast: the pricing branch selects through a plain string variable, which
  // supabase-js cannot type statically.
  const allServices = (servicesRes.data || []) as { id: string; name: string }[]
  const scopedServices =
    visibilityMode === 'services' && myServiceIds.length > 0
      ? allServices.filter(s => myServiceIds.includes(s.id))
      : allServices

  return (
    <>
    {vis.tasksPricing && <PricingPendingBanner clients={pendingPricing.clients} services={pendingPricing.services} />}
    <TasksClient
      promotionRequest={promotionRequest}
      promotionSocialItem={promotionSocialItem}
      requestRefByTaskId={requestRefByTaskId}
      pendingRequestCount={pendingRequestCount}
      initialSearch={initialSearch}
      initialClient={initialClient}
      initialService={initialService}
      initialDateRange={initialDateRange}
      dbTaskTotal={dbCountRes.count ?? undefined}
      fullHistory={fullHistory}
      initialTasks={initialTasks}
      initialTrash={initialTrash}
      clients={clientsRes.data || []}
      services={scopedServices}
      packages={(packagesRes.data || []) as any[]}
      packageItems={(packageItemsRes.data || []) as any[]}
      clientPricings={(clientPricingsRes.data || []) as any[]}
      employees={scopedEmployees as any[]}
      taskAssignments={(taskAssignmentsRes.data || []) as any[]}
      groups={(groupsRes.data || []) as any[]}
      parameters={(paramsRes.data || []) as any[]}
      groupServices={(groupServicesRes.data || []) as any[]}
      parameterServices={(paramServicesRes.data || []) as any[]}
      taskGroups={(taskGroupsRes.data || []) as any[]}
      taskGroupAssignments={(taskGroupAssignmentsRes.data || []) as any[]}
      taskParamAssignments={(taskParamAssignmentsRes.data || []) as any[]}
      myTaskIds={myTaskIds}
      visibilitySettings={{
        billing:        (visibilityBillingRes.data?.value as string) || 'all',
        contributions:  (visibilityContribRes.data?.value as string) || 'all',
        employee_names: (visibilityNamesRes.data?.value as string) || 'all',
      }}
      permissionFlags={{
        pricing: vis.tasksPricing,
        totals: vis.tasksTotals,
        contribView: canViewContribs,
        contribViewAll: isAdmin || userCanSee(me, PERMS.CONTRIBUTIONS_VIEW_ALL),
        contribEdit: canEditContribs,
        contribEarnings: vis.contributionEarnings,
      }}
    />
    </>
  )
}
