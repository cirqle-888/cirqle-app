'use server'

/**
 * Package server actions — the only write path for packages and their items.
 *
 * A package is a commitment: one agreed price, a term, and a list of what's
 * included. It never prices a task and never touches payroll, so nothing here
 * writes to `tasks` beyond the explicit link the user sets from the task form.
 *
 * Note: a `'use server'` module may only EXPORT async functions. Types stay
 * local or live in @/lib/packages/types — exporting one from here would survive
 * the server-actions transform as a value reference and 500 the whole module.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import type { PackageRow, PackageItemRow, PackageBillingType, PackageStatus } from '@/lib/packages/types'

const REVALIDATE = '/dashboard/packages'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/** One included line as the form submits it. */
export interface PackageItemInput {
  /** Present when editing an existing row; absent for a new one. */
  id?: string
  serviceId: string
  includedQuantity: number
}

export interface PackageInput {
  /** Present when editing. */
  id?: string
  clientId: string
  name: string
  billingType: PackageBillingType
  price: number
  currency: string
  /** NULL → extras bill at the normal Pricing-Matrix price. */
  extraTaskPrice: number | null
  startDate: string
  endDate: string | null
  /**
   * Optional extended opening cycle. NULL → plain calendar months. Ignored for
   * one-time packages, which have no cycles.
   */
  firstCycleEnd: string | null
  status: PackageStatus
  notes: string | null
  items: PackageItemInput[]
}

/** A package with its included lines, as the page renders it. */
export interface PackageWithItems extends PackageRow {
  items: PackageItemRow[]
}

/**
 * Every package with its items.
 *
 * Degrades to an empty list when the tables aren't migrated yet, so a
 * pre-migration environment shows an empty screen rather than an error page.
 */
export async function listPackages(): Promise<ActionResult<PackageWithItems[]>> {
  const guard = await requireReadPermission(PERMS.PACKAGES_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('client_packages')
    .select('*, items:client_package_items(*)')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })

  if (error) {
    if (/does not exist|PGRST205/i.test(error.message || '')) return { ok: true, data: [] }
    return { ok: false, error: error.message }
  }

  // Items come back in arbitrary order; the page reads them as written.
  const rows = ((data ?? []) as unknown as PackageWithItems[]).map(p => ({
    ...p,
    items: [...(p.items ?? [])].sort((a, b) => a.display_order - b.display_order),
  }))
  return { ok: true, data: rows }
}

function validate(input: PackageInput): string | null {
  if (!input.clientId) return 'Pick a client.'
  if (!input.name.trim()) return 'Give the package a name — it becomes the invoice line the client reads.'
  if (!input.startDate) return 'Set a start date.'
  if (!(input.price >= 0)) return 'Price cannot be negative.'
  if (input.extraTaskPrice != null && input.extraTaskPrice < 0) return 'Extra-work rate cannot be negative.'
  if (input.endDate && input.endDate < input.startDate) return 'The end date is before the start date.'
  if (input.firstCycleEnd && input.firstCycleEnd < input.startDate) return 'The first cycle ends before the package starts.'
  if (input.firstCycleEnd && input.endDate && input.firstCycleEnd > input.endDate) return 'The first cycle ends after the package itself does.'

  const withService = input.items.filter(i => i.serviceId)
  if (withService.length === 0) return 'Add at least one included service, or nothing can be delivered against this package.'
  if (withService.some(i => !(i.includedQuantity >= 0))) return 'Included quantity cannot be negative.'

  // Mirrors UNIQUE (package_id, service_id). Caught here so the user sees a
  // sentence instead of a Postgres constraint error — and because the whole
  // task→item match depends on one line per service.
  const seen = new Set<string>()
  for (const i of withService) {
    if (seen.has(i.serviceId)) return 'Each service can only appear once. Combine the duplicates into a single line with a larger quantity.'
    seen.add(i.serviceId)
  }
  return null
}

export async function savePackage(input: PackageInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.PACKAGES_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const problem = validate(input)
  if (problem) return { ok: false, error: problem }

  const admin = createAdminClient()
  const row = {
    client_id: input.clientId,
    name: input.name.trim(),
    billing_type: input.billingType,
    price: input.price,
    currency: input.currency,
    extra_task_price: input.extraTaskPrice,
    start_date: input.startDate,
    end_date: input.endDate,
    // A one-time package has no cycles, so an opening cycle would be a stored
    // value that nothing reads — clear it rather than leave it lying.
    first_cycle_end: input.billingType === 'monthly' ? input.firstCycleEnd : null,
    status: input.status,
    notes: input.notes?.trim() || null,
  }

  let packageId = input.id
  if (packageId) {
    const { error } = await admin
      .from('client_packages')
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq('id', packageId)
    if (error) return { ok: false, error: error.message }
  } else {
    const { data, error } = await admin
      .from('client_packages')
      .insert({ ...row, created_by: guard.employeeId })
      .select('id')
      .single()
    if (error) return { ok: false, error: error.message }
    packageId = data.id
  }

  const itemsProblem = await syncItems(admin, packageId!, input.items)
  if (itemsProblem) return { ok: false, error: itemsProblem }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'client',
    entityId: input.clientId,
    clientId: input.clientId,
    action: input.id ? 'package_updated' : 'package_created',
    detail: {
      package: row.name,
      billing_type: row.billing_type,
      price: row.price,
      currency: row.currency,
      included: input.items.filter(i => i.serviceId).map(i => ({ service_id: i.serviceId, qty: i.includedQuantity })),
    },
  }).catch(() => {})

  revalidatePath(REVALIDATE)
  revalidatePath('/dashboard/invoices')
  return { ok: true, data: { id: packageId! } }
}

/**
 * Reconcile the included lines: upsert what's present, delete what's gone.
 *
 * Deliberately NOT delete-all-then-reinsert. Rows are referenced by nothing
 * today, but the old agreements module used delete+reinsert on its child rows
 * and that is exactly what nulled task links the moment a foreign key was added
 * to them. Upserting by id keeps the rows stable if anything ever points here.
 */
async function syncItems(
  admin: ReturnType<typeof createAdminClient>,
  packageId: string,
  items: PackageItemInput[],
): Promise<string | null> {
  const wanted = items.filter(i => i.serviceId)

  const { data: existing, error: readErr } = await admin
    .from('client_package_items').select('id').eq('package_id', packageId)
  if (readErr) return readErr.message

  const keepIds = new Set(wanted.map(i => i.id).filter(Boolean) as string[])
  const toDelete = (existing ?? []).map(r => r.id).filter(id => !keepIds.has(id))
  if (toDelete.length) {
    const { error } = await admin.from('client_package_items').delete().in('id', toDelete)
    if (error) return error.message
  }

  for (const [idx, i] of wanted.entries()) {
    const payload = {
      package_id: packageId,
      service_id: i.serviceId,
      included_quantity: Math.max(0, Math.round(i.includedQuantity)),
      display_order: idx,
      updated_at: new Date().toISOString(),
    }
    const { error } = i.id
      ? await admin.from('client_package_items').update(payload).eq('id', i.id)
      : await admin.from('client_package_items').insert(payload)
    if (error) {
      // The UNIQUE (package_id, service_id) constraint, in plain language.
      if (/duplicate key|unique/i.test(error.message)) {
        return 'That service is already on this package. Combine them into one line.'
      }
      return error.message
    }
  }
  return null
}

export async function setPackageStatus(
  packageId: string,
  status: PackageStatus,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PACKAGES_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('client_packages')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', packageId)
    .select('name, client_id')
    .single()
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'client',
    entityId: data.client_id,
    clientId: data.client_id,
    action: 'package_status_changed',
    detail: { package: data.name, status },
  }).catch(() => {})

  revalidatePath(REVALIDATE)
  revalidatePath('/dashboard/invoices')
  return { ok: true }
}

/**
 * Soft-delete a package.
 *
 * Linked tasks keep their `package_id` (the FK is ON DELETE SET NULL, but this
 * is a soft delete so nothing is nulled) — the work still happened. Invoice fee
 * lines already issued are untouched: an invoice the client has seen must never
 * change because of a later admin action here.
 */
export async function deletePackage(packageId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PACKAGES_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('client_packages')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', packageId)
    .select('name, client_id')
    .single()
  if (error) return { ok: false, error: error.message }

  void logActivity({
    actorId: guard.employeeId,
    entityType: 'client',
    entityId: data.client_id,
    clientId: data.client_id,
    action: 'package_deleted',
    detail: { package: data.name },
  }).catch(() => {})

  revalidatePath(REVALIDATE)
  revalidatePath('/dashboard/invoices')
  return { ok: true }
}
