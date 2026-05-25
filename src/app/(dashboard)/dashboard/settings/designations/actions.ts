'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

const REVALIDATE_PATH = '/dashboard/settings/designations'

// ─── createDesignation ────────────────────────────────────────────────────────
export async function createDesignation(
  input: { name: string; description?: string; copyFromId?: string | null },
): Promise<ActionResult<{ id: string }>> {
  const auth = await requirePermission('settings.manage_designations')
  if (!auth.ok) return { ok: false, error: auth.error }

  const name = (input.name ?? '').trim()
  if (!name) return { ok: false, error: 'Name is required.' }

  const admin = createAdminClient()

  // Uniqueness check (name is UNIQUE in DB but give a nice error).
  const { data: existing } = await admin
    .from('designations')
    .select('id')
    .ilike('name', name)
    .maybeSingle()
  if (existing) return { ok: false, error: 'A designation with that name already exists.' }

  const { data: created, error: insertErr } = await admin
    .from('designations')
    .insert({
      name,
      description: input.description?.trim() || null,
      is_admin: false,
      is_system: false,
      display_order: 100,
    })
    .select('id')
    .single()
  if (insertErr || !created) return { ok: false, error: insertErr?.message || 'Failed to create.' }

  // Optionally copy permissions from another designation.
  if (input.copyFromId) {
    const { data: source } = await admin
      .from('designation_permissions')
      .select('permission_id, allowed')
      .eq('designation_id', input.copyFromId)
    if (source && source.length > 0) {
      const rows = source.map(r => ({
        designation_id: created.id,
        permission_id: r.permission_id,
        allowed: r.allowed,
      }))
      const { error: copyErr } = await admin.from('designation_permissions').insert(rows)
      if (copyErr) {
        // Roll back so we don't leave a half-built designation.
        await admin.from('designations').delete().eq('id', created.id)
        return { ok: false, error: copyErr.message }
      }
    }
  }

  revalidatePath(REVALIDATE_PATH)
  return { ok: true, data: { id: created.id } }
}

// ─── updateDesignation ────────────────────────────────────────────────────────
export async function updateDesignation(
  id: string,
  changes: { name?: string; description?: string },
): Promise<ActionResult> {
  const auth = await requirePermission('settings.manage_designations')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('designations')
    .select('id, name, is_admin, is_system')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return { ok: false, error: 'Designation not found.' }

  const update: Record<string, any> = {}

  if (typeof changes.name === 'string') {
    const newName = changes.name.trim()
    if (!newName) return { ok: false, error: 'Name is required.' }

    if (existing.is_admin && newName !== 'Admin') {
      return { ok: false, error: 'Admin designation cannot be renamed.' }
    }
    if (existing.is_system && newName !== existing.name) {
      return { ok: false, error: 'System designations cannot be renamed.' }
    }
    if (newName !== existing.name) {
      const { data: clash } = await admin
        .from('designations')
        .select('id')
        .ilike('name', newName)
        .neq('id', id)
        .maybeSingle()
      if (clash) return { ok: false, error: 'A designation with that name already exists.' }
      update.name = newName
    }
  }

  if (typeof changes.description === 'string') {
    update.description = changes.description.trim() || null
  }

  if (Object.keys(update).length === 0) {
    return { ok: true } // nothing to change
  }

  update.updated_at = new Date().toISOString()

  const { error } = await admin.from('designations').update(update).eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE_PATH)
  return { ok: true }
}

// ─── deleteDesignation ────────────────────────────────────────────────────────
export async function deleteDesignation(id: string): Promise<ActionResult> {
  const auth = await requirePermission('settings.manage_designations')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('designations')
    .select('id, is_system')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return { ok: false, error: 'Designation not found.' }
  if (existing.is_system) return { ok: false, error: 'System designations cannot be deleted.' }

  const { count } = await admin
    .from('employees')
    .select('id', { count: 'exact', head: true })
    .eq('designation_id', id)
  if ((count ?? 0) > 0) {
    return { ok: false, error: `Cannot delete — ${count} employee(s) still use this designation. Reassign them first.` }
  }

  const { error } = await admin.from('designations').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE_PATH)
  return { ok: true }
}

// ─── setPermission ────────────────────────────────────────────────────────────
export async function setPermission(
  designationId: string,
  permissionId: string,
  allowed: boolean,
): Promise<ActionResult> {
  const auth = await requirePermission('settings.manage_designations')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()

  const { data: designation } = await admin
    .from('designations')
    .select('id, is_admin')
    .eq('id', designationId)
    .maybeSingle()
  if (!designation) return { ok: false, error: 'Designation not found.' }
  if (designation.is_admin) {
    return { ok: false, error: 'Admin permissions are immutable.' }
  }

  const { error } = await admin
    .from('designation_permissions')
    .upsert(
      { designation_id: designationId, permission_id: permissionId, allowed },
      { onConflict: 'designation_id,permission_id' },
    )
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE_PATH)
  return { ok: true }
}
