import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
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

  // All plans, newest month first, with just enough embedded item data for
  // the picker's progress counts. Plans are few (one per client per month).
  let calendars: any[] = []
  let migrated = true
  try {
    const { data, error } = await admin
      .from('social_calendars')
      .select(`
        id, client_id, month, title, status, notes, created_at,
        client:clients(id, name, code),
        items:social_calendar_items(id, status, request_id)
      `)
      .order('month', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) migrated = false
    calendars = data || []
  } catch { migrated = false }

  const selectedId =
    (requestedCalendarId && calendars.some(c => c.id === requestedCalendarId))
      ? requestedCalendarId
      : (calendars.find(c => c.status !== 'archived')?.id ?? calendars[0]?.id ?? null)

  // Full items for the selected plan, with the live pipeline join:
  // item → request → promoted task. The calendar displays this chain's
  // status; it never stores it.
  let items: any[] = []
  if (migrated && selectedId) {
    // service_id / variants need the 202607170xxxxx patch migrations — fall back without them.
    const ITEM_COLS = `
        id, calendar_id, scheduled_date, title, content_type, platforms,
        caption, notes, status, request_id, created_at,
        request:task_requests!social_calendar_items_request_id_fkey(
          id, ref_no, status, promoted_task_id,
          promoted_task:tasks!task_requests_promoted_task_id_fkey(id, task_number, status)
        )
      `
    // Drop ONLY the column each retry trips on — a pending patch migration
    // must not also hide columns that already exist.
    let extraCols = ['service_id', 'variants', 'reference_url', 'reference_urls', 'scheduled_end_date', 'caption_canvas', 'assigned_employee_id']
    for (let attempt = 0; attempt <= 7; attempt++) {
      const sel = [...extraCols, ITEM_COLS].join(', ')
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
      const col = extraCols.find(c => quoted.includes(c))
        ?? [...extraCols].sort((a, b) => b.length - a.length).find(c => msg.includes(c))
      if (!col) break
      extraCols = extraCols.filter(c => c !== col)
    }
  }

  // Every variant tag ever used, across all plans — powers the "Also as"
  // autocomplete so free-text tags converge on a shared vocabulary instead of
  // fragmenting into "reel"/"reels"/"Reel". A missing `variants` column
  // (pre-migration) just yields an empty list.
  let knownVariants: string[] = []
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
    knownVariants = [...set].sort()
  } catch { /* column not migrated yet — suggestions fall back to the built-ins */ }

  // Designers available for the optional per-item assignment.
  //
  // NAME IS DELIBERATELY NOT SELECTED. Employee names are private: the picker
  // shows CQIDs only, so the name never reaches the browser in the first place
  // — a stronger guarantee than masking it at render time.
  const employees = (await admin
    .from('employees').select('id, cqid')
    .eq('is_active', true).eq('is_archived', false).order('cqid')).data || []

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
    const [{ data: cats }, { data: direct }, { data: svcs }] = await Promise.all([
      admin.from('employee_service_categories').select('employee_id, category_id'),
      admin.from('employee_services').select('employee_id, service_id'),
      admin.from('services').select('id, category_id'),
    ])
    const svcRows = (svcs || []) as { id: string; category_id: string | null }[]
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
    const { data } = await admin
      .from('service_categories').select('id, name')
      .eq('is_active', true).order('display_order')
    departments = (data || []) as { id: string; name: string }[]
  } catch { /* pre-migration — picker falls back to a flat list */ }

  const clients = (await admin
    .from('clients').select('id, name, code').eq('is_active', true).order('name')).data || []

  // ── Package commitments for the plan on screen ────────────────────────────
  //
  // A content plan for a client on a retainer is planning against a promise:
  // 15 posts this cycle, of which some are already done. The calendar cannot
  // show what is still owed without knowing that promise, so it is loaded here
  // and the client re-derives progress from its live item list.
  //
  // Degrades to nothing when the package tables aren't migrated — the calendar
  // is useful without them and must not fail because of them.
  let packages: any[] = []
  let packageTasks: any[] = []
  const selectedCalendar = calendars.find(c => c.id === selectedId) ?? null
  if (selectedCalendar?.client_id) {
    try {
      const { data: pkgs, error } = await admin
        .from('client_packages')
        .select('*, items:client_package_items(*)')
        .eq('client_id', selectedCalendar.client_id)
        .is('deleted_at', null)
      if (!error && pkgs?.length) {
        packages = pkgs
        const ids = pkgs.map((p: { id: string }) => p.id)
        const { data: linked } = await admin
          .from('tasks')
          .select('id, package_id, service_id, task_date, task_number, status')
          .in('package_id', ids)
          .is('deleted_at', null)
        packageTasks = linked || []
      }
    } catch { /* packages not migrated — the calendar simply shows no commitment */ }
  }

  // Services power the item modal's Service picker — the same catalogue the
  // Requests form uses, so calendar items align with request types.
  const services = (await admin
    .from('services').select('id, name').eq('is_active', true)
    .order('display_order').order('name')).data || []

  // Full settings map: the PDF export borrows the invoice template's branding
  // keys (logo, colors, company identity), and the content-type → service
  // defaults live under 'social_content_type_services'.
  // EGRESS: shared 5-minute cache (getCompanySettings) rather than an
  // unfiltered select on every render — the PDF branding keys live alongside
  // the base64 logo blobs in this table.
  const companySettings: Record<string, string> = await getCompanySettings()
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
