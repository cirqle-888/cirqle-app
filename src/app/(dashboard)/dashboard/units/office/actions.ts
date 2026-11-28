'use server'

/**
 * Office team — server actions. Admin only. Marking someone as office staff
 * grants nothing; a permission change is made on the person's own role
 * (designation), exactly as Settings → Designations does, so the app and the
 * database stay in step. The role is always read here from the person, never
 * taken from the browser, and an Admin role is never narrowed.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { invalidateUserCache, requireAdmin } from '@/lib/permissions/check'
import { OFFICE_MIGRATION } from '@/lib/units/office-load'

type Result = { ok: true } | { ok: false; error: string }

const UUID = /^[0-9a-f-]{36}$/i
const PAGE = '/dashboard/units/office'

function fail(e: { message?: string; code?: string } | null): Result {
  const msg = e?.message ?? 'Unknown error'
  if (e?.code === 'PGRST205' || /business_unit_office_staff.*(does not exist|schema cache)/i.test(msg)) {
    return { ok: false, error: `The office list needs its database migration first (${OFFICE_MIGRATION}).` }
  }
  return { ok: false, error: msg }
}

/** Put someone on Cirqle's office team, or take them off it. */
export async function setOfficeStaff(employeeId: string, on: boolean): Promise<Result> {
  const g = await requireAdmin()
  if (!g.ok) return { ok: false, error: g.error }
  if (!UUID.test(employeeId)) return { ok: false, error: 'Unknown person.' }
  const admin = createAdminClient()
  const { data: emp } = await admin.from('employees').select('id').eq('id', employeeId).maybeSingle()
  if (!emp) return { ok: false, error: 'Unknown person.' }
  const { error } = on
    ? await admin.from('business_unit_office_staff').upsert({ employee_id: employeeId, added_by: g.employeeId }, { onConflict: 'employee_id' })
    : await admin.from('business_unit_office_staff').delete().eq('employee_id', employeeId)
  if (error) return fail(error)
  revalidatePath(PAGE)
  revalidatePath('/dashboard/units/hq')
  return { ok: true }
}

/** Turn one permission on or off on this person's role. */
export async function setPersonPermission(employeeId: string, key: string, allowed: boolean): Promise<Result> {
  const g = await requireAdmin()
  if (!g.ok) return { ok: false, error: g.error }
  if (!UUID.test(employeeId) || !/^[a-z_]+\.[a-z_.]+$/.test(key)) return { ok: false, error: 'Unknown person or permission.' }
  const admin = createAdminClient()
  const { data: emp } = await admin.from('employees').select('id, designation_id').eq('id', employeeId).maybeSingle()
  if (!emp) return { ok: false, error: 'Unknown person.' }
  const roleId = (emp as { designation_id: string | null }).designation_id
  if (!roleId) return { ok: false, error: 'This person has no role yet. Give them one in Settings → Employees first.' }
  const [{ data: role }, { data: perm }] = await Promise.all([
    admin.from('designations').select('id, is_admin').eq('id', roleId).maybeSingle(),
    admin.from('permissions').select('id').eq('key', key).maybeSingle(),
  ])
  if (!role) return { ok: false, error: 'Role not found.' }
  if ((role as { is_admin: boolean }).is_admin) return { ok: false, error: 'An Admin role has every permission and cannot be narrowed.' }
  if (!perm) return { ok: false, error: 'Unknown permission.' }
  const { error } = await admin.from('designation_permissions').upsert(
    { designation_id: roleId, permission_id: (perm as { id: string }).id, allowed },
    { onConflict: 'designation_id,permission_id' },
  )
  if (error) return fail(error)
  invalidateUserCache()
  revalidatePath(PAGE)
  revalidatePath('/dashboard/settings/designations')
  return { ok: true }
}
