'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, resolveCurrentEmployeeId } from '@/lib/auth/enforce'
import { logActivity } from '@/lib/activity/log'
import { syncRatesToDb, ratesAreStale } from '@/lib/fx/sync'

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
  return { ok: true }
}

// ── Employees ─────────────────────────────────────────────────────────────────

export async function createEmployee(form: Record<string, unknown>): Promise<ActionResult<any>> {
  const auth = await requirePermission('employees.create')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data, error } = await admin.from('employees').insert(form).select().single()
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

  const admin = createAdminClient()
  const { data, error } = await admin.from('employees').update(form).eq('id', id).select().single()
  if (error) return { ok: false, error: error.message }

  // Log: employee record edited (fire-and-forget)
  // Log designation changes specifically so the timeline shows them clearly
  const action = form.designation_id ? 'designation_changed' : 'edited'
  void logActivity({
    actorId:    auth.employeeId,
    subjectId:  id,
    entityType: 'employee',
    entityId:   id,
    action,
    detail:     Object.keys(form).filter(k => k !== 'updated_at').reduce<Record<string, unknown>>(
                  (acc, k) => { acc[k] = form[k]; return acc }, {}
                ),
  })

  return { ok: true, data }
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
  return { ok: true, data }
}

export async function upsertClientServicePricings(
  pricingRows: {
    client_id: string
    service_id: string
    price: number
    commission_percentage: number
    currency: string
    is_active: boolean
  }[],
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  if (pricingRows.length === 0) return { ok: true }
  const admin = createAdminClient()
  const { error } = await admin
    .from('client_service_pricing')
    .upsert(pricingRows, { onConflict: 'client_id,service_id' })
  if (error) return { ok: false, error: error.message }

  // Setting pricing resolves the "pending to price" flag for the touched
  // clients and services. Best-effort — ignore if the column isn't there yet.
  const clientIds = Array.from(new Set(pricingRows.map(r => r.client_id)))
  const serviceIds = Array.from(new Set(pricingRows.map(r => r.service_id)))
  await admin.from('clients').update({ pricing_pending: false }).in('id', clientIds).then(undefined, () => {})
  await admin.from('services').update({ pricing_pending: false }).in('id', serviceIds).then(undefined, () => {})

  return { ok: true }
}

export async function deactivateClient(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('clients').update({ is_active: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
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
  let { data, error } = await admin
    .from('parameters')
    .insert({ ...fullForm, is_active: true })
    .select()
    .single()
  if (error || !data) {
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
        rate_date: new Date().toISOString().slice(0, 10),
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
  price: number,
  commissionPercentage: number,
  currency: string,
): Promise<ActionResult> {
  const auth = await requirePermission('settings.access')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { error } = await admin.from('client_service_pricing').upsert(
    {
      client_id: clientId,
      service_id: serviceId,
      price,
      commission_percentage: commissionPercentage,
      currency: currency || 'INR',
      is_active: true,
    },
    { onConflict: 'client_id,service_id' },
  )
  if (error) return { ok: false, error: error.message }

  // Resolve the "pending to price" flag since we just set the price
  await admin.from('clients').update({ pricing_pending: false }).eq('id', clientId).then(undefined, () => {})
  await admin.from('services').update({ pricing_pending: false }).eq('id', serviceId).then(undefined, () => {})

  return { ok: true }
}
