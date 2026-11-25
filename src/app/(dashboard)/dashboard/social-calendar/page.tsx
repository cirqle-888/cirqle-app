import { redirect } from 'next/navigation'
import { withDraftFlag } from '@/lib/clients/draft'
import { createAdminClient } from '@/lib/supabase/server'
import { coverageTaskColumns } from '@/lib/packages/coverage-select'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { getCompanySettings } from '@/lib/settings/company-settings'
import SocialCalendarClient from './social-calendar-client'

export const dynamic = 'force-dynamic'

/**
 * Social Media Calendar planner. Defensive by design (mirrors requests/
 * advertising pages): if the social_calendar tables haven't been migrated
 * yet, `migrated` flips false and the client shows a run-the-migration
 * notice instead of crashing.
 */
export default async function SocialCalendarPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || hasPermission(me, PERMS.SOCIAL_VIEW)
  if (me && !canView) redirect('/dashboard')

  const sp = searchParams ? await searchParams : undefined
  const requestedCalendarId = typeof sp?.calendar === 'string' ? sp.calendar : null

  const admin = createAdminClient()

  // ── Loading order ──────────────────────────────────────────────────────────
  // This page used to await every read below in turn — thirteen round trips in
  // a row before anything rendered (2.2–2.5 s measured 15 Nov 2026, for 83 KB
  // of data). Only two things genuinely depend on an earlier answer: which
  // plan is selected (needs the plan list), and that plan's items, packages
  // and delivered work (need the selection). Everything else is started here,
  // at once, and collected at the end.
  //
  // `early` starts a read now to be awaited later. It marks a rejection as
  // handled so Node does not report it while it waits its turn — it does NOT
  // swallow it: the await further down still throws exactly as it did.
  const early = <T,>(p: PromiseLike<T>): Promise<T> => {
    const q = Promise.resolve(p)
    q.catch(() => {})
    return q
  }

  // Every variant tag ever used, across all plans — powers the "Also as"
  // autocomplete so free-text tags converge on a shared vocabulary instead of
  // fragmenting into "reel"/"reels"/"Reel". A missing `variants` column
  // (pre-migration) just yields an empty list.
  const knownVariantsP: Promise<string[]> = early((async () => {
    try {
      const { data } = await admin
        .from('social_calendar_items')
        .select('variants')
        .not('variants', 'is', null)
        .limit(2000)
      const set = new Set<string>()
      for (const row of (data || []) as { variants: string[] | null }[]) {
        for (const v of row.variants || []) if (v) set.add(String(v))
      }
      return [...set].sort()
    } catch { return [] /* column not migrated yet — suggestions fall back to the built-ins */ }
  })())

  // Designers available for the optional per-item assignment.
  //
  // NAME IS DELIBERATELY NOT SELECTED. Employee names are private: the picker
  // shows CQIDs only, so the name never reaches the browser in the first place
  // — a stronger guarantee than masking it at render time.
  const employeesP = early(admin
    .from('employees').select('id, cqid')
    .eq('is_active', true).eq('is_archived', false).order('cqid'))

  // Service → department, for every service. Read once and used twice: the
  // assignee picker's effective-service map, and the "which services count as
  // social" filter on delivered work (which used to ask the same table two
  // more times, one after the other).
  const serviceCategoriesP = early(admin.from('services').select('id, category_id'))
  const employeeScopeP = early(Promise.all([
    admin.from('employee_service_categories').select('employee_id, category_id'),
    admin.from('employee_services').select('employee_id, service_id'),
  ]))

  // Department names for the picker's group headers.
  const departmentsP = early(admin
    .from('service_categories').select('id, name')
    .eq('is_active', true).order('display_order'))

  // is_draft labels trial clients "Draft" in the New Plan picker.
  const clientsP = early(withDraftFlag(x => admin
    .from('clients').select(`id, name, code${x}`).eq('is_active', true).order('name')))

  // Services power the item modal's Service picker — the same catalogue the
  // Requests form uses, so calendar items align with request types.
  const servicesP = early(admin
    .from('services').select('id, name, category_id').eq('is_active', true)
    .order('display_order').order('name'))

  // Full settings map: the PDF export borrows the invoice template's branding
  // keys (logo, colors, company identity), and the content-type → service
  // defaults live under 'social_content_type_services'.
  // EGRESS: shared 5-minute cache (getCompanySettings) rather than an
  // unfiltered select on every render — the PDF branding keys live alongside
  // the base64 logo blobs in this table.
  const companySettingsP: Promise<Record<string, string>> = early(getCompanySettings())

  // All plans, newest month first, with just enough embedded item data for
  // the picker's progress counts. Plans are few (one per client per month).
  let calendars: any[] = []
  let migrated = true
  try {
    // task_id lets the plan picker count items a task holds directly as sent.
    // It needs 20260825120000, so a database without that column is asked
    // again without it rather than being reported as unmigrated.
    const listPlans = (itemCols: string) => admin
      .from('social_calendars')
      .select(`
        id, client_id, month, title, status, notes, created_at,
        client:clients(id, name, code),
        items:social_calendar_items(${itemCols})
      `)
      .order('month', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    let res = await listPlans('id, status, request_id, task_id')
    if (res.error) res = await listPlans('id, status, request_id')
    if (res.error) migrated = false
    calendars = res.data || []
  } catch { migrated = false }

  const selectedId =
    (requestedCalendarId && calendars.some(c => c.id === requestedCalendarId))
      ? requestedCalendarId
      : (calendars.find(c => c.status !== 'archived')?.id ?? calendars[0]?.id ?? null)

  // Full items for the selected plan, with the live pipeline join:
  // item → request → promoted task. The calendar displays this chain's
  // status; it never stores it.
  const loadItems = async () => {
    let items: any[] = []
    if (!(migrated && selectedId)) return items
    // service_id / variants need the 202607170xxxxx patch migrations — fall back without them.
    const ITEM_COLS = `
        id, calendar_id, scheduled_date, title, content_type, platforms,
        caption, notes, status, request_id, created_at,
        request:task_requests!social_calendar_items_request_id_fkey(
          id, ref_no, status, promoted_task_id,
          promoted_task:tasks!task_requests_promoted_task_id_fkey(id, task_number, status, deleted_at)
        )
      `
    // The OTHER exit: a task linked straight to the item, no request in
    // between. Needs 20260825120000 — the embed is dropped together with
    // task_id below, since without the column the FK it names does not exist.
    const TASK_COLS = `
        task:tasks!social_calendar_items_task_id_fkey(id, task_number, status, deleted_at)
      `
    // Drop ONLY the column each retry trips on — a pending patch migration
    // must not also hide columns that already exist.
    let extraCols = ['service_id', 'variants', 'reference_url', 'reference_urls', 'scheduled_end_date', 'caption_canvas', 'assigned_employee_id', 'links', 'task_id', 'scheduled_time', 'post_asap', 'posting_priority']
    for (let attempt = 0; attempt <= extraCols.length; attempt++) {
      const sel = [
        ...extraCols, ITEM_COLS,
        ...(extraCols.includes('task_id') ? [TASK_COLS] : []),
      ].join(', ')
      const itemsRes = await admin
        .from('social_calendar_items')
        .select(sel)
        .eq('calendar_id', selectedId)
        .order('scheduled_date', { ascending: true })
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: true })
      if (!itemsRes.error) { items = itemsRes.data || []; break }
      // Match the column NAME the error quotes. A plain substring test would
      // resolve a missing `reference_urls` to `reference_url` and drop the
      // column that exists, hiding every legacy reference image.
      const msg = itemsRes.error.message || ''
      const quoted = [...msg.matchAll(/'([a-z_]+)'/gi)].map(m => m[1])
      // A missing EMBED reports the relationship, not the column: "Could not
      // find a relationship between 'social_calendar_items' and 'tasks'".
      // That names neither `task_id` nor the FK, so the generic matchers below
      // find nothing and would break out of the loop — leaving the calendar
      // with zero items instead of falling back. Catch it first.
      const embedMissing = extraCols.includes('task_id')
        && (/relationship/i.test(msg) || msg.includes('social_calendar_items_task_id_fkey'))
      const col = embedMissing
        ? 'task_id'
        : (extraCols.find(c => quoted.includes(c))
            ?? [...extraCols].sort((a, b) => b.length - a.length).find(c => msg.includes(c)))
      if (!col) break
      extraCols = extraCols.filter(c => c !== col)
    }
    return items
  }

  // The selected plan's items, its package commitments and its delivered work
  // all hang off the selection and off nothing else, so they leave together.
  const selectedCalendar = calendars.find(c => c.id === selectedId) ?? null
  const itemsP = early(loadItems())

  // ── Package commitments for the plan on screen ────────────────────────────
  //
  // A content plan for a client on a retainer is planning against a promise:
  // 15 posts this cycle, of which some are already done. The calendar cannot
  // show what is still owed without knowing that promise, so it is loaded here
  // and the client re-derives progress from its live item list.
  //
  // Degrades to nothing when the package tables aren't migrated — the calendar
  // is useful without them and must not fail because of them.
  type PackageRows = { packages: any[]; packageTasks: any[] }
  const packagesP: Promise<PackageRows> = early((async (): Promise<PackageRows> => {
    if (!selectedCalendar?.client_id) return { packages: [], packageTasks: [] }
    try {
      const { data: pkgs, error } = await admin
        .from('client_packages')
        .select('*, items:client_package_items(*)')
        .eq('client_id', selectedCalendar.client_id)
        .is('deleted_at', null)
      if (error || !pkgs?.length) return { packages: [], packageTasks: [] }
      const ids = pkgs.map((p: { id: string }) => p.id)
      const { data: linked } = await admin
        .from('tasks')
        .select(await coverageTaskColumns(admin))
        .in('package_id', ids)
        .is('deleted_at', null)
      return { packages: pkgs, packageTasks: linked || [] }
    } catch { return { packages: [], packageTasks: [] } /* packages not migrated — the calendar simply shows no commitment */ }
  })())

  // Completed work for the plan's client and month — the raw rows behind the
  // monthly-report overlay further down. Needs only the selection.
  const deliveredWindow = (() => {
    if (!(selectedCalendar?.client_id && selectedCalendar?.month)) return null
    const monthStart = String(selectedCalendar.month).slice(0, 10)
    const d = new Date(`${monthStart}T00:00:00`)
    const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1)
      .toLocaleDateString('en-CA')
    return { monthStart, nextMonth }
  })()
  const doneTasksP = early<{ data: Record<string, unknown>[] | null }>(deliveredWindow
    ? admin
        .from('tasks')
        .select('id, task_number, title, task_date, status, service_id, service:services!service_id(name)')
        .eq('client_id', selectedCalendar.client_id)
        .is('deleted_at', null)
        .in('status', ['delivered', 'done', 'invoiced', 'paid'])
        .gte('task_date', deliveredWindow.monthStart)
        .lt('task_date', deliveredWindow.nextMonth)
        .order('task_date', { ascending: true })
    : Promise.resolve({ data: [] }))

  const items = await itemsP
  const knownVariants = await knownVariantsP
  const employees = (await employeesP).data || []
  const serviceCategoryRows = ((await serviceCategoriesP).data || []) as { id: string; category_id: string | null }[]

  // Employee → department(s) AND employee → effective service ids, so the
  // picker can offer only the people who actually work this kind of content.
  // Derived from the same service-scope tables the visibility engine uses — no
  // parallel mapping.
  //
  // "Effective" mirrors src/lib/scope/service-scope.ts: direct assignments ∪
  // every service inside an assigned category. Resolving the category half here
  // (rather than at write time) keeps a category assignment dynamic — add a
  // service to Offer Flyers and its people pick it up with no re-assignment.
  const employeeDepartments: Record<string, string[]> = {}
  const employeeServices: Record<string, string[]> = {}
  try {
    const [{ data: cats }, { data: direct }] = await employeeScopeP
    const svcRows = serviceCategoryRows
    const svcDept = new Map(svcRows.map(s => [s.id, s.category_id ?? null]))
    const deptServices = new Map<string, string[]>()
    for (const s of svcRows) {
      if (!s.category_id) continue
      const list = deptServices.get(s.category_id) ?? []
      list.push(s.id)
      deptServices.set(s.category_id, list)
    }
    const add = (empId: string, dept: string | null) => {
      if (!dept) return
      const list = (employeeDepartments[empId] ||= [])
      if (!list.includes(dept)) list.push(dept)
    }
    const addService = (empId: string, serviceId: string | null) => {
      if (!serviceId) return
      const list = (employeeServices[empId] ||= [])
      if (!list.includes(serviceId)) list.push(serviceId)
    }
    for (const r of (cats || []) as { employee_id: string; category_id: string }[]) {
      add(r.employee_id, r.category_id)
      for (const id of deptServices.get(r.category_id) ?? []) addService(r.employee_id, id)
    }
    for (const r of (direct || []) as { employee_id: string; service_id: string }[]) {
      add(r.employee_id, svcDept.get(r.service_id) ?? null)
      addService(r.employee_id, r.service_id)
    }
  } catch { /* pre-migration — picker simply lists everyone */ }

  // Department names for the picker's group headers.
  let departments: { id: string; name: string }[] = []
  try {
    const { data } = await departmentsP
    departments = (data || []) as { id: string; name: string }[]
  } catch { /* pre-migration — picker falls back to a flat list */ }

  const clients = (await clientsP).data || []
  const { packages, packageTasks } = await packagesP
  const companySettings: Record<string, string> = await companySettingsP

  // ── Delivered work for the month (the monthly-report overlay) ──────────────
  // The plan answers "what did we say we would do". A monthly report also has
  // to answer "what did we actually deliver" — and those differ, because work
  // arrives by request and by ad-hoc task, not only off the calendar.
  //
  // Tasks already represented ON the calendar are excluded: a planned item that
  // became a task already shows its own Completed chip, so listing the task as
  // well would double-count it in the very report this exists to support. What
  // is left is delivered work that never appeared on the plan — precisely the
  // gap worth seeing.
  let deliveredTasks: any[] = []
  if (deliveredWindow) {
    try {
      // ── Which services count as "social"? ──────────────────────────────────
      // Client + month alone is not enough: a client buys packaging, logos and
      // print from the same agency, and none of that belongs on a SOCIAL
      // calendar. (It showed "2 Package Designs — Product Packaging Design",
      // which is exactly the noise this filter removes.)
      //
      // The allowed set is DERIVED, not hardcoded to a category name that a
      // rename would break: take the services this calendar demonstrably deals
      // in — the team's content-type→service defaults, plus whatever its own
      // items use — and allow everything sharing their category. So mapping
      // "post → Social Media Poster" admits the whole Social Media category
      // (stories, DPs, covers) and still excludes Print & Collateral.
      const settings = companySettings
      let seedServiceIds: string[] = []
      try {
        if (settings.social_content_type_services) {
          seedServiceIds = Object.values(
            JSON.parse(settings.social_content_type_services) as Record<string, string>,
          ).filter(Boolean)
        }
      } catch { /* unset or malformed */ }
      for (const it of items as any[]) if (it.service_id) seedServiceIds.push(it.service_id)
      seedServiceIds = [...new Set(seedServiceIds)]

      let allowedServiceIds: Set<string> | null = null
      if (seedServiceIds.length) {
        // From the service → department map read at the top; these were two
        // more reads of the same table, one waiting on the other.
        const seedSet = new Set(seedServiceIds)
        const seedRows = serviceCategoryRows.filter(r => seedSet.has(r.id))
        const cats = [...new Set(seedRows.map(r => r.category_id).filter((c): c is string => !!c))]
        if (cats.length) {
          const catSet = new Set(cats)
          const sameCat = serviceCategoryRows.filter(r => !!r.category_id && catSet.has(r.category_id))
          allowedServiceIds = new Set([
            ...seedServiceIds,
            ...sameCat.map(r => r.id),
          ])
        } else {
          // Services exist but carry no category — fall back to exactly the
          // seeds rather than opening the overlay to everything.
          allowedServiceIds = new Set(seedServiceIds)
        }
      }

      const { data: done } = await doneTasksP

      // Ids already on the plan, via either exit: item → task directly, or
      // item → request → promoted task.
      const onPlan = new Set<string>()
      for (const it of items as any[]) {
        if (it.task_id) onPlan.add(it.task_id)
        const pt = it.request?.promoted_task
        if (pt?.id) onPlan.add(pt.id)
        if (it.request?.promoted_task_id) onPlan.add(it.request.promoted_task_id)
      }

      deliveredTasks = (done ?? [])
        .filter((t: any) => !onPlan.has(t.id))
        // A task with no service cannot be judged social, and "unknown" is not
        // evidence — leaving it in is how the packaging job got here.
        .filter((t: any) => !allowedServiceIds || (t.service_id && allowedServiceIds.has(t.service_id)))
        .map((t: any) => {
          const s = Array.isArray(t.service) ? t.service[0] : t.service
          return {
            id: t.id, task_number: t.task_number, title: t.title,
            task_date: t.task_date, status: t.status, service_name: s?.name ?? null,
          }
        })
    } catch { /* tasks unreadable — the calendar is still useful without the overlay */ }
  }

  const services = (await servicesP).data || []

  let serviceMap: Record<string, string> = {}
  try {
    if (companySettings.social_content_type_services) {
      serviceMap = JSON.parse(companySettings.social_content_type_services)
    }
  } catch { /* unset or malformed — keyword fallback covers it */ }

  return (
    <SocialCalendarClient
      migrated={migrated}
      calendars={calendars}
      selectedId={selectedId}
      initialItems={items}
      packages={packages}
      packageTasks={packageTasks}
      deliveredTasks={deliveredTasks}
      clients={clients as any[]}
      services={services as any[]}
      knownVariants={knownVariants}
      employees={employees as any[]}
      employeeDepartments={employeeDepartments}
      employeeServices={employeeServices}
      departments={departments}
      serviceMap={serviceMap}
      companySettings={companySettings}
      canManage={isAdmin || hasPermission(me, PERMS.SOCIAL_MANAGE)}
    />
  )
}
