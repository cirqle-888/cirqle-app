'use server'

/**
 * Brands — the one write path for Cirqle's own brands and what belongs to them.
 *
 * Managing brands and which services they sell changes how money is reported,
 * so it needs settings.manage_company. Linking an account to a brand is an
 * ownership-adjacent decision, so it needs assets.assign — and only ever
 * touches accounts already marked as Cirqle's own (Asset Assignment decides
 * THAT; this only decides which brand).
 *
 * A `'use server'` module may only EXPORT async functions.
 */

import { revalidatePath, revalidateTag } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, requirePermission, requireAnyPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { COMPANY_SETTINGS_TAG } from '@/lib/settings/company-settings'
import { BRAND_INVOICE_KEY, normalizeHex, slugify, type BrandInvoiceIdentity } from '@/lib/brands/brands'
import { loadBrands } from '@/lib/brands/load'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

const PATHS = ['/dashboard/cirqle-accounts', '/dashboard/advertising', '/dashboard/tasks', '/dashboard/cashbook', '/dashboard/social']
const revalidateAll = () => { for (const p of PATHS) revalidatePath(p, 'layout') }

export interface BrandInput {
  name: string
  tagline?: string | null
  color?: string | null
  logoUrl?: string | null
  whatsappNumber?: string | null
  website?: string | null
  isActive?: boolean
  showOnInvoices?: boolean
  displayOrder?: number
}

const clean = (v: string | null | undefined) => {
  const s = (v ?? '').trim()
  return s ? s : null
}

function rowFrom(input: BrandInput) {
  return {
    name: input.name.trim(),
    tagline: clean(input.tagline),
    color: normalizeHex(input.color),
    logo_url: clean(input.logoUrl),
    whatsapp_number: clean(input.whatsappNumber),
    website: clean(input.website),
    ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
    ...(input.showOnInvoices !== undefined ? { show_on_invoices: input.showOnInvoices } : {}),
    ...(input.displayOrder !== undefined ? { display_order: Math.trunc(input.displayOrder) } : {}),
  }
}

/** Brands for pickers (tasks, cash book, campaigns). Any signed-in user. */
export async function listBrandOptions(): Promise<ActionResult<{ id: string; name: string; color: string | null; isDefault: boolean }[]>> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false, error: 'Not signed in.' }
  const brands = await loadBrands(createAdminClient(), { activeOnly: true })
  return { ok: true, data: brands.map(b => ({ id: b.id, name: b.name, color: b.color, isDefault: b.is_default })) }
}

export async function createBrand(input: BrandInput): Promise<ActionResult<{ id: string; slug: string }>> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_COMPANY)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.name?.trim()) return { ok: false, error: 'Give the brand a name.' }

  const admin = createAdminClient()
  const existing = await loadBrands(admin)
  if (existing.some(b => b.name.toLowerCase() === input.name.trim().toLowerCase())) {
    return { ok: false, error: 'A brand with that name already exists.' }
  }
  let slug = slugify(input.name)
  for (let i = 2; existing.some(b => b.slug === slug); i++) slug = `${slugify(input.name)}-${i}`

  const { data, error } = await admin.from('brands')
    .insert({ ...rowFrom(input), slug, is_default: existing.length === 0,
              display_order: input.displayOrder ?? existing.length })
    .select('id, slug').single()
  if (error) {
    if (/relation .*brands/.test(error.message)) return { ok: false, error: 'Brands are not set up in the database yet (migration 20261122100000).' }
    return { ok: false, error: error.message }
  }
  void logActivity({ actorId: guard.employeeId, entityType: 'setting', action: 'created', detail: { label: `Brand: ${input.name.trim()}` } })
  await syncInvoiceIdentity(admin)
  revalidateAll()
  return { ok: true, data: { id: data.id, slug: data.slug } }
}

export async function updateBrand(id: string, input: BrandInput): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_COMPANY)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.name?.trim()) return { ok: false, error: 'Give the brand a name.' }

  const admin = createAdminClient()
  const existing = await loadBrands(admin)
  const me = existing.find(b => b.id === id)
  if (!me) return { ok: false, error: 'Brand not found.' }
  if (existing.some(b => b.id !== id && b.name.toLowerCase() === input.name.trim().toLowerCase())) {
    return { ok: false, error: 'Another brand already has that name.' }
  }
  // The default brand is Cirqle itself: it can't be switched off.
  if (me.is_default && input.isActive === false) return { ok: false, error: 'The default brand cannot be deactivated.' }

  const { error } = await admin.from('brands').update(rowFrom(input)).eq('id', id)
  if (error) return { ok: false, error: error.message }
  void logActivity({ actorId: guard.employeeId, entityType: 'setting', action: 'changed', detail: { label: `Brand: ${input.name.trim()}` } })
  await syncInvoiceIdentity(admin)
  revalidateAll()
  return { ok: true }
}

/** Point one of Cirqle's own Pages / Instagram accounts at a brand (null = default). */
export async function setAccountBrand(accountId: string, brandId: string | null): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.ASSETS_ASSIGN)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()

  const { data: acc } = await admin.from('social_accounts').select('id, name, owner_type').eq('id', accountId).maybeSingle()
  if (!acc) return { ok: false, error: 'Account not found.' }
  if (acc.owner_type !== 'cirqle') return { ok: false, error: "Only Cirqle's own accounts belong to a brand. Mark it as Cirqle's in Asset Assignment first." }
  if (brandId && !(await loadBrands(admin)).some(b => b.id === brandId)) return { ok: false, error: 'Brand not found.' }

  const { error } = await admin.from('social_accounts').update({ brand_id: brandId }).eq('id', accountId)
  if (error) return { ok: false, error: error.message }

  // Company campaigns that advertise this page follow it to the new brand.
  await admin.from('ad_projects').update({ brand_id: brandId })
    .eq('page_account_id', accountId).is('client_id', null)
    .then(null, () => { /* best-effort */ })

  void logActivity({ actorId: guard.employeeId, entityType: 'setting', action: 'changed', detail: { label: `Brand of ${acc.name}` } })
  revalidateAll()
  return { ok: true }
}

/** Which brand sells a service (null = default). Moves that service's revenue. */
export async function setServiceBrand(serviceId: string, brandId: string | null): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_COMPANY)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  if (brandId && !(await loadBrands(admin)).some(b => b.id === brandId)) return { ok: false, error: 'Brand not found.' }

  const { data: svc } = await admin.from('services').select('name').eq('id', serviceId).maybeSingle()
  if (!svc) return { ok: false, error: 'Service not found.' }
  const { error } = await admin.from('services').update({ brand_id: brandId }).eq('id', serviceId)
  if (error) return { ok: false, error: error.message }

  void logActivity({ actorId: guard.employeeId, entityType: 'setting', action: 'changed', detail: { label: `Brand of service ${svc.name}` } })
  await syncInvoiceIdentity(admin)
  revalidateAll()
  return { ok: true }
}

/**
 * Brand of an internal task. Only internal work (no client) carries one —
 * client work takes its brand from the service, so a client task is cleared.
 */
export async function setTaskBrand(taskId: string, brandId: string | null): Promise<ActionResult> {
  const guard = await requireAnyPermission([PERMS.TASKS_CREATE, PERMS.TASKS_EDIT])
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()

  const { data: task } = await admin.from('tasks').select('id, client_id').eq('id', taskId).maybeSingle()
  if (!task) return { ok: false, error: 'Task not found.' }
  if (brandId && !(await loadBrands(admin)).some(b => b.id === brandId)) return { ok: false, error: 'Brand not found.' }

  const { error } = await admin.from('tasks').update({ brand_id: task.client_id ? null : brandId }).eq('id', taskId)
  if (error) {
    if (/brand_id/.test(error.message)) return { ok: false, error: 'Brands are not set up in the database yet.' }
    return { ok: false, error: error.message }
  }
  revalidatePath('/dashboard/cirqle-accounts', 'layout')
  return { ok: true }
}

/**
 * Cache what invoices print per brand in company_settings, so every invoice
 * renderer (which already receives company settings) applies it with no new
 * query. Called after any change to brands or their services.
 */
async function syncInvoiceIdentity(admin: ReturnType<typeof createAdminClient>): Promise<void> {
  try {
    const brands = (await loadBrands(admin, { activeOnly: true })).filter(b => b.show_on_invoices && !b.is_default)
    const { data: services } = await admin.from('services').select('id, name, brand_id').not('brand_id', 'is', null)
    const identities: BrandInvoiceIdentity[] = brands.map(b => {
      const mine = (services ?? []).filter((s: { brand_id: string }) => s.brand_id === b.id) as { id: string; name: string }[]
      return {
        name: b.name, tagline: b.tagline, logoUrl: b.logo_url, whatsapp: b.whatsapp_number,
        serviceIds: mine.map(s => s.id),
        serviceNames: mine.map(s => s.name.trim().toLowerCase()),
      }
    }).filter(i => i.serviceIds.length > 0)
    await admin.from('company_settings')
      .upsert({ key: BRAND_INVOICE_KEY, value: JSON.stringify(identities) }, { onConflict: 'key' })
    revalidateTag(COMPANY_SETTINGS_TAG, 'max')
  } catch { /* the invoice simply stays plain Cirqle */ }
}
