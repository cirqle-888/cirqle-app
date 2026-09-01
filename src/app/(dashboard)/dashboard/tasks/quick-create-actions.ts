'use server'

/**
 * Quick-create + title-suggestion actions used by the Add Task modal.
 *
 * `clients.create` / `services.create` gate inline creation (admins always pass).
 * When the creator lacks `tasks.view_pricing`, the new record is flagged
 * `pricing_pending = true` so an admin / pricing person fills in the commercials.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnyPermission, requireAnyReadPermission, requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

// ─── Quick-create client ────────────────────────────────────────────────────────

export interface QuickClientInput {
  name: string
  phone?: string
  email?: string
  contact_name?: string
  default_currency?: string
  country?: string
}

export async function quickCreateClient(
  input: QuickClientInput,
): Promise<ActionResult<{ client: any; pricingPending: boolean }>> {
  // Either the dedicated create perm OR full settings access may add clients.
  const guard = await requireAnyPermission([PERMS.CLIENTS_CREATE, PERMS.SETTINGS_ACCESS])
  if (!guard.ok) return { ok: false, error: guard.error }

  const name = (input.name || '').trim()
  if (!name) return { ok: false, error: 'Client name is required.' }

  const admin = createAdminClient()

  // Auto-generate the next 3-digit code (matches the Settings convention).
  const { data: last } = await admin
    .from('clients').select('code').order('code', { ascending: false }).limit(1)
  const lastNum = parseInt(last?.[0]?.code || '000', 10) || 0
  const code = String(lastNum + 1).padStart(3, '0')

  // Creator without pricing access → leave it flagged for an admin to price.
  const pricing = await requirePermission(PERMS.TASKS_VIEW_PRICING)
  const pricingPending = !pricing.ok

  const { data, error } = await admin
    .from('clients')
    .insert({
      name,
      code,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      contact_name: input.contact_name?.trim() || null,
      default_currency: input.default_currency || 'INR',
      country: input.country || 'India',
      is_active: true,
      pricing_pending: pricingPending,
    })
    .select()
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/tasks')
  return { ok: true, data: { client: data, pricingPending } }
}

// ─── Quick-create service ───────────────────────────────────────────────────────

export interface QuickServiceInput {
  name: string
  pricing_type?: string
  default_price?: number | null
  default_currency?: string
  description?: string
}

export async function quickCreateService(
  input: QuickServiceInput,
): Promise<ActionResult<{ service: any; pricingPending: boolean }>> {
  const guard = await requireAnyPermission([PERMS.SERVICES_CREATE, PERMS.SETTINGS_ACCESS])
  if (!guard.ok) return { ok: false, error: guard.error }

  const name = (input.name || '').trim()
  if (!name) return { ok: false, error: 'Service name is required.' }

  const admin = createAdminClient()

  const pricing = await requirePermission(PERMS.TASKS_VIEW_PRICING)
  const hasPricing = pricing.ok
  // Pending if the creator can't price, OR (even if they can) no price was set.
  const pricingPending = !hasPricing || input.default_price == null

  // Place new service at the end of the display order.
  const { data: lastOrder } = await admin
    .from('services').select('display_order').order('display_order', { ascending: false }).limit(1)
  const display_order = ((lastOrder?.[0]?.display_order as number) || 0) + 1

  const { data, error } = await admin
    .from('services')
    .insert({
      name,
      pricing_type: input.pricing_type || 'fixed_per_creative',
      description: input.description?.trim() || null,
      default_price: hasPricing ? (input.default_price ?? null) : null,
      default_currency: input.default_currency || 'INR',
      display_order,
      is_active: true,
      pricing_pending: pricingPending,
    })
    .select()
    .single()
  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard/tasks')
  return { ok: true, data: { service: data, pricingPending } }
}

// ─── Mark priced (clears the pending flag) ──────────────────────────────────────

export async function markClientPriced(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_VIEW_PRICING)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('clients').update({ pricing_pending: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/tasks'); revalidatePath('/dashboard')
  return { ok: true }
}

export async function markServicePriced(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.TASKS_VIEW_PRICING)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('services').update({ pricing_pending: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard/tasks'); revalidatePath('/dashboard')
  return { ok: true }
}

// ─── Title suggestions (autocomplete from past task titles) ──────────────────────

export async function getTitleSuggestions(
  query: string,
): Promise<ActionResult<{ suggestions: { title: string; count: number }[] }>> {
  // Any task creator can use suggestions.
  const guard = await requireAnyReadPermission([PERMS.TASKS_CREATE, PERMS.TASKS_EDIT, PERMS.TASKS_VIEW_ALL])
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  let q = admin
    .from('tasks')
    .select('title')
    .not('title', 'is', null)
    .is('deleted_at', null)
    .order('id', { ascending: false })
    .limit(400)
  const term = (query || '').trim()
  if (term) q = q.ilike('title', `%${term}%`)

  const { data, error } = await q
  if (error) return { ok: false, error: error.message }

  // Dedupe (case-insensitive) keeping the most-common spelling, rank by frequency.
  const freq = new Map<string, { title: string; count: number }>()
  for (const r of (data ?? []) as { title: string }[]) {
    const t = (r.title || '').trim()
    if (!t) continue
    const key = t.toLowerCase()
    const e = freq.get(key)
    if (e) e.count++
    else freq.set(key, { title: t, count: 1 })
  }
  const suggestions = Array.from(freq.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  return { ok: true, data: { suggestions } }
}

/**
 * Broad pool of recent distinct task titles — NOT filtered by the query — so the
 * client can fuzzy-match typos against real history ("weec end sle" → "Weekend
 * Sale"). Fetched once when the title field is first focused.
 */
export async function getRecentTitlePool(): Promise<ActionResult<{ titles: string[] }>> {
  const guard = await requireAnyReadPermission([PERMS.TASKS_CREATE, PERMS.TASKS_EDIT, PERMS.TASKS_VIEW_ALL])
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('tasks')
    .select('title')
    .not('title', 'is', null)
    .is('deleted_at', null)
    .order('id', { ascending: false })
    .limit(800)
  if (error) return { ok: false, error: error.message }

  const seen = new Set<string>()
  const titles: string[] = []
  for (const r of (data ?? []) as { title: string }[]) {
    const t = (r.title || '').trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    titles.push(t)
  }
  return { ok: true, data: { titles } }
}
