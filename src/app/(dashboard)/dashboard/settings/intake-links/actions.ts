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

/**
 * Friendly-but-unguessable token: a readable prefix (client/agency name slug)
 * + 24 random base36 chars (~124 bits). Reads professionally in the URL:
 *   /intake/seastar-k2m9qp4ztlwx8r3v7n1cq5d8
 */
function friendlyToken(prefix: string | null | undefined): string {
  const slug = (prefix || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12)
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const rand = Array.from(bytes, b => (b % 36).toString(36)).join('')
  return slug ? `${slug}-${rand}` : rand
}

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

  // Readable token prefix from the requester's name (slug + random suffix).
  let prefix: string | null = null
  if (input.type === 'client' && input.client_id) {
    const { data: c } = await admin.from('clients').select('name').eq('id', input.client_id).maybeSingle()
    prefix = c?.name || null
  } else if (input.type === 'agency' && input.agency_id) {
    const { data: a } = await admin.from('agencies').select('name').eq('id', input.agency_id).maybeSingle()
    prefix = a?.name || null
  } else if (input.type === 'generic') {
    prefix = 'request'
  }

  const { data, error } = await admin.from('intake_links').insert({
    token: friendlyToken(prefix),
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

  // Same readable-token format as createIntakeLink.
  let prefix: string | null = old.type === 'generic' ? 'request' : null
  if (old.type === 'client' && old.client_id) {
    const { data: c } = await admin.from('clients').select('name').eq('id', old.client_id).maybeSingle()
    prefix = c?.name || null
  } else if (old.type === 'agency' && old.agency_id) {
    const { data: a } = await admin.from('agencies').select('name').eq('id', old.agency_id).maybeSingle()
    prefix = a?.name || null
  }

  const { data, error } = await admin.from('intake_links').insert({
    token: friendlyToken(prefix),
    type: old.type, client_id: old.client_id, agency_id: old.agency_id,
    label: old.label, created_by: guard.employeeId,
  }).select('*, client:clients(id, name, code), agency:agencies(id, name)').single()
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { row: data } }
}

/** Set a client's shared Google Drive root folder (shown on their portal). */
export async function saveClientDriveFolder(
  clientId: string, url: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.INTAKE_LINKS_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  const u = (url || '').trim()
  if (u && !/^https?:\/\//i.test(u)) return { ok: false, error: 'Enter a valid link (https://…).' }
  const admin = createAdminClient()
  const { error } = await admin.from('clients')
    .update({ drive_folder_link: u || null })
    .eq('id', clientId)
  if (error) {
    if (/drive_folder_link/i.test(error.message || '')) {
      return { ok: false, error: 'Run the v1.1 migration first: supabase/migrations/20260611090000_portal_refinements.sql (Supabase → SQL Editor).' }
    }
    return { ok: false, error: error.message }
  }
  revalidatePath(REVALIDATE)
  return { ok: true }
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
