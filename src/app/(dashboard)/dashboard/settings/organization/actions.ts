'use server'

/**
 * Organization — units, members and revenue scopes.
 *
 * One typed table covers departments, teams, branches, regions and client
 * groups. The UI here stays deliberately small: most businesses need none of
 * this on day one, and the architecture is designed so that adding a branch
 * later is data entry, not a schema change.
 *
 * Permission: settings.manage_org (admins bypass).
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import type { OrgUnitType } from '@/lib/org/units'

const REVALIDATE = '/dashboard/settings/organization'
const MIGRATION = 'supabase/migrations/20260807100000_ownership_platform.sql'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

function friendly(message: string): string {
  return /does not exist|PGRST205|schema cache/i.test(message)
    ? `The Organization model needs a database migration. Run ${MIGRATION} in the Supabase SQL editor, then try again.`
    : message
}

export async function saveUnit(input: {
  id?: string
  name: string
  type: OrgUnitType
  parentId?: string | null
}): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_ORG)
  if (!guard.ok) return { ok: false, error: guard.error }

  const name = (input.name || '').trim()
  if (!name) return { ok: false, error: 'Give the unit a name.' }
  if (input.id && input.parentId === input.id) {
    return { ok: false, error: 'A unit cannot be its own parent.' }
  }

  const admin = createAdminClient()
  const row = {
    name, type: input.type,
    parent_id: input.parentId || null,
    updated_at: new Date().toISOString(),
  }

  if (input.id) {
    const { error } = await admin.from('org_units').update(row).eq('id', input.id)
    if (error) return { ok: false, error: friendly(error.message) }
    revalidatePath(REVALIDATE)
    return { ok: true, data: { id: input.id } }
  }
  const { data, error } = await admin.from('org_units')
    .insert({ ...row, created_by: guard.employeeId }).select('id').single()
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: data.id } }
}

export async function deleteUnit(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_ORG)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('org_units').delete().eq('id', id)
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/** Add or update a member. `isManager` is per-membership — a unit can have any
 *  number of managers, which is the point of modelling it here. */
export async function saveMember(input: {
  unitId: string
  employeeId: string
  isManager: boolean
  roleLabel?: string | null
}): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_ORG)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('org_unit_members').upsert({
    unit_id: input.unitId,
    employee_id: input.employeeId,
    is_manager: input.isManager,
    role_label: input.roleLabel || null,
  }, { onConflict: 'unit_id,employee_id' })
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function removeMember(unitId: string, employeeId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_ORG)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('org_unit_members')
    .delete().eq('unit_id', unitId).eq('employee_id', employeeId)
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Map revenue to a unit. Exactly one dimension per row — that is what keeps
 * scope resolution unambiguous, and it is enforced by a CHECK as well.
 */
export async function addScope(input: {
  unitId: string
  clientId?: string | null
  serviceCategoryId?: string | null
  serviceId?: string | null
}): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_ORG)
  if (!guard.ok) return { ok: false, error: guard.error }

  const set = [input.clientId, input.serviceCategoryId, input.serviceId].filter(Boolean)
  if (set.length !== 1) return { ok: false, error: 'Pick exactly one client, department or service.' }

  const admin = createAdminClient()
  const { error } = await admin.from('org_unit_scopes').insert({
    unit_id: input.unitId,
    client_id: input.clientId || null,
    service_category_id: input.serviceCategoryId || null,
    service_id: input.serviceId || null,
  })
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

export async function removeScope(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SETTINGS_MANAGE_ORG)
  if (!guard.ok) return { ok: false, error: guard.error }
  const admin = createAdminClient()
  const { error } = await admin.from('org_unit_scopes').delete().eq('id', id)
  if (error) return { ok: false, error: friendly(error.message) }
  revalidatePath(REVALIDATE)
  return { ok: true }
}
