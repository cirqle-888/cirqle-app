'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, resolveCurrentEmployeeId, requireAdmin } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'
import { syncRatesToDb, ratesAreStale } from '@/lib/fx/sync'
import { revalidatePath, revalidateTag } from 'next/cache'
import { COMPANY_SETTINGS_TAG } from '@/lib/settings/company-settings'
import { invalidateUserCache } from '@/lib/permissions/check'
import { logScopeChanges, diffAssignments } from '@/lib/scope/audit'
import { todayISO } from '@/lib/utils/local-date'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

// ── Company Settings ──────────────────────────────────────────────────────────

export async function upsertCompanySettings(
  entries: { key: string; value: string }[],
): Promise<ActionResult> {
  const auth = await requirePermission('settings.manage_company')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  await Promise.all(
    entries.map(({ key, value }) =>
      admin.from('company_settings').upsert({ key, value }, { onConflict: 'key' }),
    ),
  )
  // Bust the shared 5-minute company-settings cache (see
  // lib/settings/company-settings.ts) so branding/template edits appear at once
  // instead of after the TTL.
  revalidateTag(COMPANY_SETTINGS_TAG, 'max')
  void logActivity({
    actorId: auth.employeeId, entityType: 'setting', action: 'changed',
    detail: { label: entries.map(e => e.key).join(', ') },
  })
  return { ok: true }
}

// ── Employees ─────────────────────────────────────────────────────────────────

const PERMITTED_EMPLOYEE_FIELDS = new Set([
  'name', 'email', 'phone', 'cqid', 'designation_id', 'role', 
  'joined_date', 'date_of_birth', 'avatar_url', 'emergency_contact_name', 
  'emergency_contact_phone', 'bank_details', 'base_salary', 'hourly_rate', 
  'salary_type', 'reveal_salary', 'is_active', 'is_archived', 
  'performance_rating', 'current_workspace_id'
])

const PRIVILEGE_ESCALATING_FIELDS = new Set([
  'designation_id', 'base_salary', 'hourly_rate', 'salary_type', 'reveal_salary'
])

export async function createEmployee(form: Record<string, unknown>): Promise<ActionResult<any>> {
  const auth = await requirePermission('employees.create')
  if (!auth.ok) return { ok: false, error: auth.error }

  const safeForm: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(form)) {
    if (PERMITTED_EMPLOYEE_FIELDS.has(k)) {
      safeForm[k] = v
    }
  }

  const hasEscalating = Object.keys(safeForm).some(k => PRIVILEGE_ESCALATING_FIELDS.has(k))
  if (hasEscalating) {
    const adminCheck = await requireAdmin()
    if (!adminCheck.ok) return { ok: false, error: 'Only admins can set designations or compensation' }
  }

  const admin = createAdminClient()
  const { data, error } = await admin.from('employees').insert(safeForm).select().single()
  if (error) return { ok: false, error: error.message }

  // Log: new employee created (fire-and-forget)
  void logActivity({
    actorId:    auth.employeeId,
    subjectId:  data?.id ?? null,
    entityType: 'employee',
    entityId:   data?.id ?? null,
    action:     'employee_created',
    detail:     { cqid: data?.cqid ?? null, name: data?.name ?? null },
  })

  return { ok: true, data }
}

export async function updateEmployee(
  id: string,
  form: Record<string, unknown>,
): Promise<ActionResult<any>> {
  const auth = await requirePermission('employees.edit')
  if (!auth.ok) return { ok: false, error: auth.error }

  const safeForm: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(form)) {
    if (PERMITTED_EMPLOYEE_FIELDS.has(k)) {
      safeForm[k] = v
    }
  }

  const hasEscalating = Object.keys(safeForm).some(k => PRIVILEGE_ESCALATING_FIELDS.has(k))
  if (hasEscalating) {
    const adminCheck = await requireAdmin()
    if (!adminCheck.ok) return { ok: false, error: 'Only admins can set designations or compensation' }
  }

  const admin = createAdminClient()

  // Read the stored designation once: it answers both "is this a real change?"
  // (the self-demotion guard) and "how should this be logged?".
  let designationChanged = false
  if (safeForm.designation_id !== undefined) {
    const { data: current, error: readErr } = await admin
      .from('employees').select('designation_id').eq('id', id).single()
    if (readErr) return { ok: false, error: 'Could not verify the current role — try again.' }
    designationChanged = (current?.designation_id ?? null) !== (safeForm.designation_id ?? null)
  }

  // Self-demotion guard. It must fire on an actual CHANGE, not on the mere
  // presence of the field: the edit form posts the whole employee row, so
  // `designation_id` is always in the payload and testing `!== undefined`
  // blocked every self-edit — services, salary day, performance rating, the
  // lot — with a message about designations the user hadn't touched.
  if (id === auth.employeeId && designationChanged) {
    return { ok: false, error: 'Cannot change your own designation' }
  }

  const { data, error } = await admin.from('employees').update(safeForm).eq('id', id).select().single()
  if (error) return { ok: false, error: error.message }

  // Log: employee record edited (fire-and-forget)
  // Log designation changes specifically so the timeline shows them clearly
  // Same presence-vs-change distinction as the guard above: the form always
  // posts designation_id, so keying off its presence logged every ordinary
  // edit as a role change and made the audit trail lie.
  const action = designationChanged ? 'designation_changed' : 'edited'
  void logActivity({
    actorId:    auth.employeeId,
    subjectId:  id,
    entityType: 'employee',
    entityId:   id,
    action,
    detail:     Object.keys(safeForm).filter(k => k !== 'updated_at').reduce<Record<string, unknown>>(
                  (acc, k) => { acc[k] = safeForm[k]; return acc }, {}
                ),
  })

  return { ok: true, data }
}

// ── Employee ↔ Service assignment ────────────────────────────────────────────
// Both directions write the same employee_services junction, so the employee
// form and the service form can never drift out of sync.

// Diff-based writes (insert additions first, then delete removals) so a
// failure mid-way never wipes the existing assignments — the worst case is
// a partial update, not data loss.

/** Replace the full set of services assigned to one employee. */
export async function setEmployeeServices(
  employeeId: string,
  serviceIds: string[],
): Promise<ActionResult> {
  const auth = await requirePermission('employees.edit')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: existing, error: readError } = await admin
    .from('employee_services').select('service_id').eq('employee_id', employeeId)
  if (readError) return { ok: false, error: readError.message }
  const current = new Set((existing || []).map(r => r.service_id))
  const wanted = new Set(serviceIds)
  const toAdd = serviceIds.filter(sid => !current.has(sid))
  const toRemove = [...current].filter(sid => !wanted.has(sid))

  if (toAdd.length > 0) {
    const { error } = await admin
      .from('employee_services')
      .upsert(toAdd.map(sid => ({ employee_id: employeeId, service_id: sid })), { onConflict: 'employee_id,service_id' })
    if (error) return { ok: false, error: error.message }
  }
  if (toRemove.length > 0) {
    const { error } = await admin
      .from('employee_services').delete().eq('employee_id', employeeId).in('service_id', toRemove)
    if (error) return { ok: false, error: error.message }
  }
  void logActivity({
    actorId: auth.employeeId, subjectId: employeeId, entityType: 'employee',
    entityId: employeeId, action: 'services_assigned', detail: { service_ids: serviceIds },
  })
  // Per-pair audit (activity_logs only keeps the whole-set snapshot).
  await logScopeChanges(admin, diffAssignments({
    scopeKind: 'employee_service',
    before: current, after: wanted,
    anchor: { employeeId }, actorId: auth.employeeId, source: 'ui',
  }))
  // Service scope is read per-request, but the viewer's PERMISSION set is
  // cached for 30s — clear it so a reassignment is felt immediately.
  await invalidateEmployeeUserCache(admin, employeeId)
  revalidatePath('/dashboard/tasks'); revalidatePath('/dashboard/contributions')
  return { ok: true }
}

/**
 * Replace the full set of service CATEGORIES assigned to one employee.
 *
 * Deliberately does NOT expand the category into its member services. The
 * effective set is resolved at read time in lib/scope/service-scope.ts as
 * (services in my categories) ∪ (my direct services), which is what keeps a
 * category assignment dynamic — a service added to the category later is
 * picked up with no re-assignment. Expanding here would freeze today's members.
 *
 * Consequence worth knowing: a service can be in scope via its category AND
 * ticked individually. Removing the individual tick does not remove it while
 * the category is still assigned. The UI marks category-derived services so
 * this is visible rather than surprising.
 */
export async function setEmployeeServiceCategories(
  employeeId: string,
  categoryIds: string[],
): Promise<ActionResult> {
  const auth = await requirePermission('employees.edit')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: existing, error: readError } = await admin
    .from('employee_service_categories').select('category_id').eq('employee_id', employeeId)
  // Pre-migration environments have no table. Report it rather than silently
  // succeeding, because silently succeeding would look like the assignment
  // saved when nothing was written.
  if (readError) return { ok: false, error: readError.message }
  const current = new Set((existing || []).map(r => r.category_id))
  const wanted = new Set(categoryIds)
  const toAdd = categoryIds.filter(cid => !current.has(cid))
  const toRemove = [...current].filter(cid => !wanted.has(cid))

  // Additions first, then removals — a mid-way failure leaves a partial
  // update, never a wiped assignment set.
  if (toAdd.length > 0) {
    const { error } = await admin
      .from('employee_service_categories')
      .upsert(toAdd.map(cid => ({ employee_id: employeeId, category_id: cid })), { onConflict: 'employee_id,category_id' })
    if (error) return { ok: false, error: error.message }
  }
  if (toRemove.length > 0) {
    const { error } = await admin
      .from('employee_service_categories').delete().eq('employee_id', employeeId).in('category_id', toRemove)
    if (error) return { ok: false, error: error.message }
  }

  void logActivity({
    actorId: auth.employeeId, subjectId: employeeId, entityType: 'employee',
    entityId: employeeId, action: 'services_assigned', detail: { category_ids: categoryIds },
  })
  // service_scope_audit.scope_kind is open text precisely so new dimensions
  // reuse the table (20260720100000 §3). service_id stays null: the anchor of
  // this change is the category, and which services that resolves to is a
  // function of the catalog at read time, not a fact about this event.
  await logScopeChanges(admin, diffAssignments({
    scopeKind: 'employee_service_category',
    before: current, after: wanted, varying: 'category',
    anchor: { employeeId }, actorId: auth.employeeId, source: 'ui',
  }))
  await invalidateEmployeeUserCache(admin, employeeId)
  revalidatePath('/dashboard/tasks'); revalidatePath('/dashboard/contributions')
  return { ok: true }
}

/** Replace the full set of employees assigned to one service. */
export async function setServiceEmployees(
  serviceId: string,
  employeeIds: string[],
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: existing, error: readError } = await admin
    .from('employee_services').select('employee_id').eq('service_id', serviceId)
  if (readError) return { ok: false, error: readError.message }
  const current = new Set((existing || []).map(r => r.employee_id))
  const wanted = new Set(employeeIds)
  const toAdd = employeeIds.filter(eid => !current.has(eid))
  const toRemove = [...current].filter(eid => !wanted.has(eid))

  if (toAdd.length > 0) {
    const { error } = await admin
      .from('employee_services')
      .upsert(toAdd.map(eid => ({ employee_id: eid, service_id: serviceId })), { onConflict: 'employee_id,service_id' })
    if (error) return { ok: false, error: error.message }
  }
  if (toRemove.length > 0) {
    const { error } = await admin
      .from('employee_services').delete().eq('service_id', serviceId).in('employee_id', toRemove)
    if (error) return { ok: false, error: error.message }
  }
  void logActivity({
    actorId: auth.employeeId, entityType: 'setting', action: 'changed',
    detail: { label: 'service employees', service_id: serviceId, employee_ids: employeeIds },
  })
  // Audit the other direction as the same per-pair shape, so both writers
  // produce identical records.
  await logScopeChanges(admin, [
    ...toAdd.map(eid => ({
      scopeKind: 'employee_service' as const, action: 'added' as const,
      employeeId: eid, serviceId, oldValue: null, newValue: { assigned: true },
      actorId: auth.employeeId, source: 'ui' as const,
    })),
    ...toRemove.map(eid => ({
      scopeKind: 'employee_service' as const, action: 'removed' as const,
      employeeId: eid, serviceId, oldValue: { assigned: true }, newValue: null,
      actorId: auth.employeeId, source: 'ui' as const,
    })),
  ])
  for (const eid of [...toAdd, ...toRemove]) await invalidateEmployeeUserCache(admin, eid)
  revalidatePath('/dashboard/tasks'); revalidatePath('/dashboard/contributions')
  return { ok: true }
}

/**
 * Clear an employee's cached permission set by looking up their auth_id
 * (USER_CACHE is keyed by auth id, not employee id). Best-effort.
 */
async function invalidateEmployeeUserCache(
  admin: ReturnType<typeof createAdminClient>,
  employeeId: string,
): Promise<void> {
  try {
    const { data } = await admin.from('employees').select('auth_id').eq('id', employeeId).maybeSingle()
    invalidateUserCache((data as { auth_id?: string | null } | null)?.auth_id ?? null)
  } catch { /* best-effort — the 30s TTL still expires on its own */ }
}

// ── Clients ───────────────────────────────────────────────────────────────────

// The clients list is loaded with the pricing matrix embedded
// (`service_pricings:client_service_pricing(*)`). When the edit form spreads a
// loaded client, that embedded relation rides along — but it's not a real
// `clients` column, so PostgREST rejects the write ("Could not find the
// 'service_pricings' column of 'clients'"). Strip embedded relations before any
// insert/update; pricing rows are saved separately via upsertClientServicePricings.
function sanitizeClientForm(form: Record<string, unknown>): Record<string, unknown> {
  const { service_pricings, ...columns } = form
  void service_pricings
  return columns
}

export async function createClient(form: Record<string, unknown>): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin.from('clients').insert(sanitizeClientForm(form)).select().single()
  if (error) return { ok: false, error: error.message }
  void logActivity({
    actorId: auth.employeeId, entityType: 'client', entityId: data.id,
    action: 'created', clientId: data.id, detail: { label: data.name ?? data.code },
  })
  return { ok: true, data }
}

export async function updateClient(
  id: string,
  form: Record<string, unknown>,
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin.from('clients').update({ ...sanitizeClientForm(form), pricing_pending: false }).eq('id', id).select().single()
  if (error) return { ok: false, error: error.message }
  void logActivity({
    actorId: auth.employeeId, entityType: 'client', entityId: id,
    action: 'edited', clientId: id, detail: { label: data.name ?? data.code },
  })
  return { ok: true, data }
}

export async function upsertClientServicePricings(
  pricingRows: {
    client_id: string
    service_id: string
    /** null = committed, rate not agreed yet. Never coerce a blank to 0. */
    price: number | null
    /** OMIT to leave the stored value untouched. Never send 0 for "unset" —
     *  every commission reader guards with `?? 50` / `!= null`, so a 0 is a
     *  REAL value that collapses the pair's historical earnings pool. */
    commission_percentage?: number | null
    currency: string
    is_active: boolean
  }[],
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  if (pricingRows.length === 0) return { ok: true }
  const admin = createAdminClient()

  // Snapshot BEFORE the upsert. Reading prior state afterwards is useless —
  // the write has already set is_active: true on every row, so a revival
  // would be indistinguishable from a fresh commitment and 'activated' could
  // never be emitted.
  const priorState = await readPriorCommitmentState(admin, pricingRows)

  // Re-activating clears the deactivation stamp so the row never carries a
  // stale "removed on" date while being live.
  const rows = pricingRows.map(r => r.is_active
    ? { ...r, deactivated_at: null, deactivated_by: null }
    : r)
  const { error } = await admin
    .from('client_service_pricing')
    .upsert(rows, { onConflict: 'client_id,service_id' })
  if (error) return { ok: false, error: error.message }

  await auditCommitmentWrites(admin, pricingRows, priorState, auth.employeeId)

  // Setting pricing resolves the "pending to price" flag for the touched
  // clients and services. Best-effort — ignore if the column isn't there yet.
  const clientIds = Array.from(new Set(pricingRows.map(r => r.client_id)))
  const serviceIds = Array.from(new Set(pricingRows.map(r => r.service_id)))
  await admin.from('clients').update({ pricing_pending: false }).in('id', clientIds).then(undefined, () => {})
  await admin.from('services').update({ pricing_pending: false }).in('id', serviceIds).then(undefined, () => {})

  revalidateCommitmentSurfaces()
  return { ok: true }
}

/**
 * Remove services from a client's commitments.
 *
 * DEACTIVATES, never deletes: the row also carries the agreed price, and
 * destroying it breaks historical commission recompute for tasks already
 * invoiced (see the HISTORICAL READER CONTRACT in lib/payroll/compute.ts).
 * Writes is_active + deactivated_at + deactivated_by as one unit, and audits.
 */
export async function deactivateClientServices(
  clientId: string,
  serviceIds: string[],
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }
  if (serviceIds.length === 0) return { ok: true }

  const admin = createAdminClient()
  // Only touch rows that are currently active, so an already-deactivated row
  // is not re-stamped with a fresh date (and not re-audited).
  const { data: before } = await admin.from('client_service_pricing')
    .select('service_id, price, commission_percentage')
    .eq('client_id', clientId).in('service_id', serviceIds).not('is_active', 'is', false)
  const affected = (before || []).map((r: { service_id: string }) => r.service_id)
  if (affected.length === 0) return { ok: true }

  const { error } = await admin.from('client_service_pricing')
    .update({
      is_active: false,
      deactivated_at: new Date().toISOString(),
      deactivated_by: auth.employeeId,
    })
    .eq('client_id', clientId).in('service_id', affected)
  if (error) return { ok: false, error: error.message }

  await logScopeChanges(admin, (before || []).map((r: any) => ({
    scopeKind: 'client_service' as const, action: 'deactivated' as const,
    clientId, serviceId: r.service_id,
    oldValue: { is_active: true, price: r.price, commission_percentage: r.commission_percentage },
    newValue: { is_active: false },
    actorId: auth.employeeId, source: 'ui' as const,
  })))

  revalidateCommitmentSurfaces()
  return { ok: true }
}

type PriorCommitmentState = Map<string, boolean>

/**
 * Read the CURRENT is_active for the pairs about to be written. Must be called
 * BEFORE the upsert — see auditCommitmentWrites.
 */
async function readPriorCommitmentState(
  admin: ReturnType<typeof createAdminClient>,
  rows: { client_id: string; service_id: string }[],
): Promise<PriorCommitmentState> {
  const prior: PriorCommitmentState = new Map()
  const clientIds = [...new Set(rows.map(r => r.client_id))]
  const serviceIds = [...new Set(rows.map(r => r.service_id))]

  // `.in(clients).in(services)` is a CROSS PRODUCT, not a pair-wise match, so
  // it returns up to |clients| × |services| rows. PostgREST caps a response at
  // 1000 rows and drops the tail SILENTLY — past that the snapshot is missing
  // pairs, and a missing pair is indistinguishable from "no row", which
  // mislabels a reprice as 'added' and a revival as 'added' instead of
  // 'activated'. Paginate explicitly with a stable order.
  try {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from('client_service_pricing')
        .select('client_id, service_id, is_active')
        .in('client_id', clientIds)
        .in('service_id', serviceIds)
        .order('id', { ascending: true })
        .range(from, from + 999)
      // A read failure must NOT be swallowed into an empty map — that would
      // relabel every row in the batch as 'added'. Report it instead.
      if (error) {
        console.error('[scope-audit] prior-state read failed; audit labels may be wrong:', error.message)
        break
      }
      for (const r of (data || []) as { client_id: string; service_id: string; is_active: boolean }[]) {
        prior.set(`${r.client_id}|${r.service_id}`, r.is_active)
      }
      if (!data || data.length < 1000) break
    }
  } catch (e) {
    console.error('[scope-audit] prior-state read threw:', e instanceof Error ? e.message : e)
  }
  return prior
}

/**
 * Audit commitment writes, distinguishing a brand-new commitment ('added')
 * from the revival of a deactivated one ('activated') and a repricing of a
 * live one ('updated'). Best-effort: never breaks the write it describes.
 */
async function auditCommitmentWrites(
  admin: ReturnType<typeof createAdminClient>,
  rows: { client_id: string; service_id: string; is_active: boolean; price?: number | null; commission_percentage?: number | null }[],
  prior: PriorCommitmentState,
  actorId: string | null,
): Promise<void> {
  const active = rows.filter(r => r.is_active)
  if (active.length === 0) return
  await logScopeChanges(admin, active.map(r => {
    const was = prior.get(`${r.client_id}|${r.service_id}`)
    return {
      scopeKind: 'client_service' as const,
      action: was === undefined ? ('added' as const)
        : was === false ? ('activated' as const)
        : ('updated' as const),
      clientId: r.client_id, serviceId: r.service_id,
      oldValue: was === undefined ? null : { is_active: was },
      newValue: { is_active: true, price: r.price ?? null },
      actorId, source: 'ui' as const,
    }
  }))
}

/** Pages whose pickers are derived from commitments. */
function revalidateCommitmentSurfaces(): void {
  for (const p of ['/dashboard/tasks', '/dashboard/clients', '/dashboard/pricing-matrix', '/dashboard/requests']) {
    try { revalidatePath(p) } catch { /* best-effort */ }
  }
}

export async function reactivateClient(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('clients').update({ is_active: true }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function deactivateClient(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('clients').update({ is_active: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  void logActivity({
    actorId: auth.employeeId, entityType: 'client', entityId: id,
    action: 'archived', clientId: id,
  })
  return { ok: true }
}

export async function quickEditClient(
  id: string,
  field: string,
  value: unknown,
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('clients').update({ [field]: value }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── Services ──────────────────────────────────────────────────────────────────

export async function createService(
  payload: Record<string, unknown>,
  groupIds: string[],
): Promise<ActionResult<{ service: any; dbGroupServicesOk: boolean }>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: service, error } = await admin
    .from('services')
    .insert({ ...payload, is_active: true })
    .select()
    .single()
  if (error) return { ok: false, error: error.message }

  let dbGroupServicesOk = true
  if (groupIds.length > 0) {
    const { error: gsError } = await admin
      .from('group_services')
      .insert(groupIds.map(gid => ({ group_id: gid, service_id: service.id })))
    if (gsError) dbGroupServicesOk = false
  }

  return { ok: true, data: { service, dbGroupServicesOk } }
}

export async function updateService(
  id: string,
  payload: Record<string, unknown>,
  groupIds: string[],
): Promise<ActionResult<{ service: any; dbGroupServicesOk: boolean }>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: service, error } = await admin
    .from('services')
    .update({ ...payload, pricing_pending: false })
    .eq('id', id)
    .select()
    .single()
  if (error) return { ok: false, error: error.message }

  const { error: delError } = await admin.from('group_services').delete().eq('service_id', id)
  let dbGroupServicesOk = !delError
  if (!delError && groupIds.length > 0) {
    const { error: insError } = await admin
      .from('group_services')
      .insert(groupIds.map(gid => ({ group_id: gid, service_id: id })))
    if (insError) dbGroupServicesOk = false
  }

  return { ok: true, data: { service, dbGroupServicesOk } }
}

export async function deactivateService(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('services').update({ is_active: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function reactivateService(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('services').update({ is_active: true }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function quickEditService(
  id: string,
  field: string,
  value: unknown,
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('services').update({ [field]: value }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── Departments (service_categories) ─────────────────────────────────────────
// Master-data CRUD so new departments never need a migration. The visibility
// engine (src/lib/scope/service-scope.ts) resolves category membership at read
// time, so rows created here flow into employee access with no further code.

const slugify = (name: string) =>
  name.toLowerCase().trim().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

export async function createServiceCategory(
  form: { name: string; description?: string | null; color?: string | null },
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }
  const name = (form.name || '').trim()
  if (!name) return { ok: false, error: 'Department name is required' }

  const admin = createAdminClient()
  // New departments go to the end of the list.
  const { data: last } = await admin
    .from('service_categories').select('display_order')
    .order('display_order', { ascending: false }).limit(1).maybeSingle()

  // Slug is a stable identifier — derived once at creation, kept on rename.
  // A name collision after slugify ("Video" vs "video?") surfaces as a unique
  // violation; suffix with a counter rather than failing the save.
  let slug = slugify(name) || 'department'
  const { data: taken } = await admin
    .from('service_categories').select('slug').like('slug', `${slug}%`)
  const existing = new Set((taken || []).map((r: any) => r.slug))
  if (existing.has(slug)) {
    let n = 2
    while (existing.has(`${slug}-${n}`)) n++
    slug = `${slug}-${n}`
  }

  const { data, error } = await admin
    .from('service_categories')
    .insert({
      name, slug,
      description: form.description?.trim() || null,
      color: form.color || null,
      display_order: ((last as any)?.display_order ?? 0) + 1,
      is_active: true,
    })
    .select().single()
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: auth.employeeId, entityType: 'setting', entityId: data.id,
    action: 'created', detail: { label: `Department: ${name}` },
  })
  revalidatePath('/dashboard/settings')
  return { ok: true, data }
}

export async function updateServiceCategory(
  id: string,
  patch: { name?: string; description?: string | null; color?: string | null },
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }
  if (patch.name !== undefined && !patch.name.trim()) {
    return { ok: false, error: 'Department name cannot be empty' }
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('service_categories')
    .update({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description?.trim() || null } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id).select().single()
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: auth.employeeId, entityType: 'setting', entityId: id,
    action: 'edited', detail: { label: `Department: ${data.name}` },
  })
  revalidatePath('/dashboard/settings')
  return { ok: true, data }
}

/**
 * Archive / restore. Archiving hides the department from pickers but does NOT
 * hide its services or revoke access — employees assigned to it keep resolving
 * its services (the scope engine deliberately ignores category is_active, the
 * same way archived services keep their historical tasks visible). To actually
 * retire a department, move its services elsewhere first; the UI shows the
 * live service count so an archive with services still attached is a visible
 * choice, not an accident.
 */
export async function setServiceCategoryActive(id: string, active: boolean): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('service_categories')
    .update({ is_active: active, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/settings')
  return { ok: true }
}

/**
 * Persist a full ordering in one call — the client sends every category id in
 * display order. Writing the complete list (rather than swapping neighbours)
 * makes the operation idempotent and immune to two admins reordering at once
 * ending up with duplicate display_order values.
 */
export async function reorderServiceCategories(orderedIds: string[]): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  for (let i = 0; i < orderedIds.length; i++) {
    const { error } = await admin
      .from('service_categories')
      .update({ display_order: i + 1 })
      .eq('id', orderedIds[i])
    if (error) return { ok: false, error: error.message }
  }
  revalidatePath('/dashboard/settings')
  return { ok: true }
}

// ── Contribution Groups ───────────────────────────────────────────────────────

export async function createGroup(form: Record<string, unknown>): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('contribution_groups')
    .insert({ ...form, is_active: true })
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

export async function updateGroup(
  id: string,
  form: Record<string, unknown>,
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('contribution_groups')
    .update(form)
    .eq('id', id)
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

// Quick-edit fields are constrained: only these columns, and weights must be
// finite non-negative numbers (a 0-weight group silently zeroes every score
// computed from it, so garbage input must never reach the DB).
const QUICK_EDIT_FIELDS = new Set(['name', 'weight', 'description', 'display_order'])

function validateQuickEdit(field: string, value: unknown): string | null {
  if (!QUICK_EDIT_FIELDS.has(field)) return `Field "${field}" is not quick-editable`
  if (field === 'name' && !String(value ?? '').trim()) return 'Name cannot be empty'
  if ((field === 'weight' || field === 'display_order')
    && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    return `${field} must be a non-negative number`
  }
  return null
}

export async function quickEditGroup(
  id: string,
  field: string,
  value: unknown,
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }
  const invalid = validateQuickEdit(field, value)
  if (invalid) return { ok: false, error: invalid }

  const admin = createAdminClient()
  const { error } = await admin.from('contribution_groups').update({ [field]: value }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function restoreGroup(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('contribution_groups').update({ is_active: true }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function deactivateGroup(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('contribution_groups')
    .update({ is_active: false })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── Parameters ────────────────────────────────────────────────────────────────

export async function createParameter(
  fullForm: Record<string, unknown>,
  safeForm: Record<string, unknown>,
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const first = await admin
    .from('parameters')
    .insert({ ...fullForm, is_active: true })
    .select()
    .single()
  let data = first.data
  if (first.error || !data) {
    const res = await admin
      .from('parameters')
      .insert({ ...safeForm, is_active: true })
      .select()
      .single()
    if (res.error) return { ok: false, error: res.error.message }
    data = res.data
  }
  return { ok: true, data }
}

export async function updateParameter(
  id: string,
  fullForm: Record<string, unknown>,
  safeForm: Record<string, unknown>,
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  let { data } = await admin
    .from('parameters')
    .update(fullForm)
    .eq('id', id)
    .select()
    .single()
  if (!data) {
    const res = await admin
      .from('parameters')
      .update(safeForm)
      .eq('id', id)
      .select()
      .single()
    data = res.data
  }
  return { ok: true, data }
}

export async function quickEditParameter(
  id: string,
  field: string,
  value: unknown,
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }
  const invalid = validateQuickEdit(field, value)
  if (invalid) return { ok: false, error: invalid }

  const admin = createAdminClient()
  const { error } = await admin.from('parameters').update({ [field]: value }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function restoreParameter(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('parameters').update({ is_active: true }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function deactivateParameter(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('parameters').update({ is_active: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export async function createTool(form: Record<string, unknown>): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('tools')
    .insert({ ...form, is_active: true })
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

export async function updateTool(
  id: string,
  form: Record<string, unknown>,
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin.from('tools').update(form).eq('id', id).select().single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

export async function deactivateTool(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('tools').update({ is_active: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function reactivateTool(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('tools').update({ is_active: true }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function quickEditTool(
  id: string,
  field: string,
  value: unknown,
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('tools').update({ [field]: value }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── Bank Accounts ─────────────────────────────────────────────────────────────

export async function createBankAccount(form: Record<string, unknown>): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('bank_accounts')
    .insert({ ...form, is_active: true })
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

export async function updateBankAccount(
  id: string,
  form: Record<string, unknown>,
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('bank_accounts')
    .update(form)
    .eq('id', id)
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

export async function deactivateBankAccount(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('bank_accounts').update({ is_active: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function reactivateBankAccount(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('bank_accounts').update({ is_active: true }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function setDefaultBankAccount(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error: clearError } = await admin.from('bank_accounts').update({ is_default: false }).neq('id', id)
  if (clearError) return { ok: false, error: clearError.message }
  const { error } = await admin.from('bank_accounts').update({ is_default: true }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── Cashbook Categories ───────────────────────────────────────────────────────

export async function createCashbookCategory(
  form: Record<string, unknown>,
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin.from('cashbook_categories').insert(form).select().single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

export async function updateCashbookCategory(
  id: string,
  form: Record<string, unknown>,
): Promise<ActionResult<any>> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('cashbook_categories')
    .update(form)
    .eq('id', id)
    .select()
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data }
}

export async function reactivateCashbookCategory(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('cashbook_categories')
    .update({ is_active: true })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function deactivateCashbookCategory(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('cashbook_categories')
    .update({ is_active: false })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

// ── Exchange Rates ────────────────────────────────────────────────────────────

export async function upsertExchangeRate(
  currency: string,
  rate: number,
): Promise<ActionResult> {
  const auth = await requirePermission('settings.manage_company')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  // A hand-entered rate is a manual override — stamp the source + today's date so
  // the Settings UI can show "Manual" and the value date alongside API-synced rows.
  const { error } = await admin
    .from('exchange_rates')
    .upsert(
      {
        currency,
        rate_to_inr: rate,
        rate_source: 'manual',
        rate_date: todayISO(),
        last_updated: new Date().toISOString(),
      },
      { onConflict: 'currency' },
    )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Manually refresh every exchange rate from the free FX API ("Sync now" button).
 * Admin-gated. Returns how many rows were updated + the rate value date.
 */
export async function syncExchangeRates(): Promise<ActionResult<{ updated: number; rateDate?: string }>> {
  const auth = await requirePermission('settings.manage_company')
  if (!auth.ok) return { ok: false, error: auth.error }

  const res = await syncRatesToDb()
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, data: { updated: res.updated ?? 0, rateDate: res.rateDate } }
}

/**
 * Host-agnostic auto-refresh: called once per session on app load by any
 * authenticated user. Refreshes only when the freshest rate is older than the
 * configured `fx_auto_refresh_hours` interval, so it's cheap and self-throttling.
 * Gated on authentication only (FX market data is not sensitive).
 */
export async function syncExchangeRatesIfStale(): Promise<ActionResult<{ synced: boolean }>> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in.' }

  const admin = createAdminClient()
  const { data } = await admin
    .from('company_settings')
    .select('value')
    .eq('key', 'fx_auto_refresh_hours')
    .maybeSingle()
  const parsed = Number(data?.value)
  const intervalHours = Number.isFinite(parsed) ? parsed : 24

  if (!(await ratesAreStale(intervalHours))) return { ok: true, data: { synced: false } }

  const res = await syncRatesToDb()
  // Don't surface API failures to the background caller — just report no sync.
  return res.ok ? { ok: true, data: { synced: true } } : { ok: true, data: { synced: false } }
}

// ── Pricing Matrix ────────────────────────────────────────────────────────────

export async function upsertMatrixCell(
  clientId: string,
  serviceId: string,
  /** null = committed, rate not agreed yet. Never coerce a blank to 0. */
  price: number | null,
  /** null = leave the stored commission untouched (see below). */
  commissionPercentage: number | null,
  currency: string,
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  // Pricing a cell IS the act of committing the client to that service, so
  // is_active: true is correct here — but the deactivation stamp must be
  // cleared with it, or the row goes live carrying a stale "removed on" date.
  const { data: prior } = await admin.from('client_service_pricing')
    .select('is_active').eq('client_id', clientId).eq('service_id', serviceId).maybeSingle()
  const { error } = await admin.from('client_service_pricing').upsert(
    {
      client_id: clientId,
      service_id: serviceId,
      price,
      // Omitted when null so ON CONFLICT DO UPDATE leaves the stored
      // commission alone — a blank cell must never overwrite an agreed rate.
      ...(commissionPercentage === null ? {} : { commission_percentage: commissionPercentage }),
      currency: currency || 'INR',
      is_active: true,
      deactivated_at: null,
      deactivated_by: null,
    },
    { onConflict: 'client_id,service_id' },
  )
  if (error) return { ok: false, error: error.message }

  await logScopeChanges(admin, [{
    scopeKind: 'client_service',
    action: (prior as { is_active?: boolean } | null)?.is_active === false ? 'activated'
      : prior ? 'updated' : 'added',
    clientId, serviceId,
    oldValue: prior ? { is_active: (prior as any).is_active } : null,
    newValue: { is_active: true, price, commission_percentage: commissionPercentage },
    actorId: auth.employeeId, source: 'matrix',
  }])

  // Resolve the "pending to price" flag since we just set the price
  await admin.from('clients').update({ pricing_pending: false }).eq('id', clientId).then(undefined, () => {})
  await admin.from('services').update({ pricing_pending: false }).eq('id', serviceId).then(undefined, () => {})

  return { ok: true }
}

export async function createBrandingUploadUrl(input: {
  key: string
  fileName: string
}): Promise<ActionResult<{ signedUrl: string; token: string; storagePath: string }>> {
  const auth = await requirePermission('settings.manage_company')
  if (!auth.ok) return { ok: false, error: auth.error }

  const safeName = (input.fileName || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120)
  const ts = Date.now()
  // deterministic cache-busting path: key/v{timestamp}_{filename}
  const storagePath = `${input.key}/v${ts}_${safeName}`

  const admin = createAdminClient()
  const { data, error } = await admin.storage
    .from('company-branding')
    .createSignedUploadUrl(storagePath)

  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create upload URL.' }
  return { ok: true, data: { signedUrl: data.signedUrl, token: data.token, storagePath } }
}
