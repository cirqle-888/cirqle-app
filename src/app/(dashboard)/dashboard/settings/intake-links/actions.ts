'use server'

/**
 * Intake link + agency management for the External Request Portal.
 * Gated on intake_links.manage (client/generic links) / agency_links.manage
 * (agencies + agency links). Admins hold both via the catalog grant.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireAnyPermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }
const REVALIDATE = '/dashboard/settings/intake-links'

// ─── Links ────────────────────────────────────────────────────────────────────

export interface CreateLinkInput {
  type: 'client' | 'agency' | 'generic'
  client_id?: string | null
  agency_id?: string | null
  label?: string | null
}

export async function createIntakeLink(input: CreateLinkInput): Promise<ActionResult<{ row: any }>> {
  const guard = input.type === 'agency'
    ? await requirePermission(PERMS.AGENCY_LINKS_MANAGE)
    : await requirePermission(PERMS.INTAKE_LINKS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  if (input.type === 'client' && !input.client_id) return { ok: false, error: 'Pick a client for a client link.' }
  if (input.type === 'agency' && !input.agency_id) return { ok: false, error: 'Pick an agency for an agency link.' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('intake_links').insert({
    type: input.type,
    client_id: input.type === 'client' ? input.client_id : null,
    agency_id: input.type === 'agency' ? input.agency_id : null,
    label: input.label?.trim() || null,
    created_by: guard.employeeId,
  }).select('*, client:clients(id, name, code), agency:agencies(id, name)').single()
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { row: data } }
}

/** Revoke (deactivate) a link — the public URL stops working immediately. */
export async function revokeIntakeLink(id: string): Promise<ActionResult> {
  const guard = await requireAnyPermission([PERMS.INTAKE_LINKS_MANAGE, PERMS.AGENCY_LINKS_MANAGE])
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('intake_links')
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Regenerate: revoke the old link and mint a fresh token with the same scope. */
export async function regenerateIntakeLink(id: string): Promise<ActionResult<{ row: any }>> {
  const guard = await requireAnyPermission([PERMS.INTAKE_LINKS_MANAGE, PERMS.AGENCY_LINKS_MANAGE])
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()

  const { data: old, error: oldErr } = await admin.from('intake_links').select('*').eq('id', id).single()
  if (oldErr || !old) return { ok: false, error: oldErr?.message || 'Link not found' }

  await admin.from('intake_links')
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq('id', id)

  const { data, error } = await admin.from('intake_links').insert({
    type: old.type, client_id: old.client_id, agency_id: old.agency_id,
    label: old.label, created_by: guard.employeeId,
  }).select('*, client:clients(id, name, code), agency:agencies(id, name)').single()
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { row: data } }
}

// ─── Agencies ─────────────────────────────────────────────────────────────────

export interface AgencyInput { id?: string; name: string; contact_name?: string; email?: string; phone?: string }

export async function saveAgency(input: AgencyInput): Promise<ActionResult<{ row: any }>> {
  const guard = await requirePermission(PERMS.AGENCY_LINKS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const name = input.name?.trim()
  if (!name) return { ok: false, error: 'Agency name is required.' }

  const admin = createAdminClient()
  const payload = {
    name,
    contact_name: input.contact_name?.trim() || null,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
  }
  const q = input.id
    ? admin.from('agencies').update(payload).eq('id', input.id).select().single()
    : admin.from('agencies').insert(payload).select().single()
  const { data, error } = await q
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { row: data } }
}

export async function deactivateAgency(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.AGENCY_LINKS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('agencies').update({ is_active: false }).eq('id', id)
  if (error) return { ok: false, error: error.message }
  // Agency links die with the agency.
  await admin.from('intake_links')
    .update({ is_active: false, revoked_at: new Date().toISOString() })
    .eq('agency_id', id).eq('is_active', true)
  revalidatePath(REVALIDATE)
  return { ok: true }
}
