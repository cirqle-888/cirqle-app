'use server'

/**
 * Access Preview — "what would this employee see?"
 *
 * Read-only by construction. It resolves the same designation → permissions
 * chain that loadCurrentUser() resolves at sign-in and hands the raw keys back;
 * it never changes a session, never acts as anyone, and writes nothing. An
 * admin asking what a designer can see should not have to become one.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser } from '@/lib/permissions/check'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

export interface AccessPreview {
  cqid: string
  designationName: string | null
  isAdmin: boolean
  isArchived: boolean
  /** Every permission key the employee effectively holds. */
  permissionKeys: string[]
  /** Total keys in the catalog, for "12 of 74" style context. */
  catalogSize: number
}

export async function previewEmployeeAccess(
  employeeId: string,
): Promise<ActionResult<AccessPreview>> {
  // Admin-only: the answer is a complete map of someone's access, which is
  // exactly the thing you would want before attacking an account.
  const me = await loadCurrentUser()
  if (!me) return { ok: false, error: 'Not signed in.' }
  if (!me.isAdmin) return { ok: false, error: 'Only admins can preview access.' }
  if (!employeeId) return { ok: false, error: 'Pick an employee.' }

  const admin = createAdminClient()
  const { data: emp, error } = await admin
    .from('employees')
    .select('id, cqid, is_archived, designation:designation_id(id, name, is_admin)')
    .eq('id', employeeId).maybeSingle()
  if (error || !emp) return { ok: false, error: 'Employee not found.' }

  const d: any = Array.isArray((emp as any).designation) ? (emp as any).designation[0] : (emp as any).designation
  const isAdmin = d?.is_admin === true

  const { count: catalogSize } = await admin
    .from('permissions').select('key', { count: 'exact', head: true })

  // Mirrors loadCurrentUser exactly, including the admin short-circuit — an
  // admin holds every key in the catalog rather than a stored list, and a
  // preview that showed their handful of explicit grants would badly
  // understate what they can reach.
  let permissionKeys: string[] = []
  if (isAdmin) {
    const { data: all } = await admin.from('permissions').select('key')
    permissionKeys = (all ?? []).map((p: any) => p.key)
  } else if (d?.id) {
    const { data: dp } = await admin
      .from('designation_permissions')
      .select('allowed, permission:permission_id(key)')
      .eq('designation_id', d.id).eq('allowed', true)
    permissionKeys = (dp ?? [])
      .map((r: any) => (Array.isArray(r.permission) ? r.permission[0] : r.permission)?.key)
      .filter(Boolean)
  }

  return {
    ok: true,
    data: {
      cqid: (emp as any).cqid ?? '',
      designationName: d?.name ?? null,
      isAdmin,
      isArchived: (emp as any).is_archived === true,
      permissionKeys: permissionKeys.sort(),
      catalogSize: catalogSize ?? 0,
    },
  }
}
