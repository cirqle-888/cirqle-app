'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

/**
 * Auth guard — fail OPEN for legacy super_admin until the designations migration is applied.
 * Matches the employee row by auth_id OR (as a fallback) email, then backfills auth_id when
 * found by email so the link sticks for future calls.
 */
async function requirePermission(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const lookupAndBackfill = async (selectCols: string) => {
    let { data: e } = await supabase.from('employees').select(selectCols).eq('auth_id', user.id).maybeSingle()
    if (!e && user.email) {
      const byEmail = await supabase.from('employees').select(selectCols).eq('email', user.email).maybeSingle()
      e = byEmail.data
      if (e) {
        // Backfill auth_id so this is fast next time
        const empAny = e as any
        await supabase.from('employees').update({ auth_id: user.id }).eq('id', empAny.id)
      }
    }
    return e as any
  }

  // First, try the new shape (designation-based)
  let emp: any = null
  try {
    emp = await lookupAndBackfill('id, role, is_archived, designation:designation_id(id, is_admin)')
  } catch {}

  // Fallback to legacy shape if the new query fails
  if (!emp) {
    emp = await lookupAndBackfill('id, role')
    if (emp && emp.role === 'super_admin') return { ok: true }
    if (!emp) return { ok: false, error: 'No employee record linked to your account.' }
    return { ok: false, error: 'Permission denied.' }
  }

  if (emp.is_archived) return { ok: false, error: 'Your account is archived.' }

  const designation = Array.isArray(emp.designation) ? emp.designation[0] : emp.designation

  // No designation assigned yet — fall back to legacy role check
  if (!designation) {
    if (emp.role === 'super_admin') return { ok: true }
    return { ok: false, error: 'Permission denied (no designation assigned yet — run the SQL migration).' }
  }

  if (designation.is_admin === true) return { ok: true }

  // Designation assigned and not admin — check permission key
  const { data: dp } = await supabase
    .from('designation_permissions')
    .select('allowed, permission:permission_id(key)')
    .eq('designation_id', designation.id)
    .eq('allowed', true)
  const has = (dp ?? []).some((r: any) => {
    const perm = Array.isArray(r.permission) ? r.permission[0] : r.permission
    return perm?.key === key
  })
  if (!has) return { ok: false, error: 'Permission denied.' }
  return { ok: true }
}

/**
 * Generate (or regenerate) a 7-day invite token for an employee that hasn't registered yet.
 * Returns the registration link.
 */
export async function generateInviteToken(employeeId: string): Promise<ActionResult<{ token: string; url: string; expiresAt: string }>> {
  const auth = await requirePermission('employees.edit')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: emp } = await admin
    .from('employees')
    .select('id, auth_id, is_archived')
    .eq('id', employeeId)
    .maybeSingle()
  if (!emp) return { ok: false, error: 'Employee not found.' }
  if (emp.auth_id) return { ok: false, error: 'Employee is already registered.' }
  if (emp.is_archived) return { ok: false, error: 'Cannot invite archived employee.' }

  const token = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await admin
    .from('employees')
    .update({ invite_token: token, invite_token_expires_at: expiresAt })
    .eq('id', employeeId)
  if (error) return { ok: false, error: error.message }

  const origin = process.env.NEXT_PUBLIC_APP_URL || ''
  const url = `${origin}/register/${token}`
  return { ok: true, data: { token, url, expiresAt } }
}

export async function revokeInviteToken(employeeId: string): Promise<ActionResult> {
  const auth = await requirePermission('employees.edit')
  if (!auth.ok) return { ok: false, error: auth.error }
  const admin = createAdminClient()
  const { error } = await admin
    .from('employees')
    .update({ invite_token: null, invite_token_expires_at: null })
    .eq('id', employeeId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function archiveEmployee(employeeId: string): Promise<ActionResult> {
  const auth = await requirePermission('employees.archive')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: emp } = await admin
    .from('employees')
    .select('id, auth_id')
    .eq('id', employeeId)
    .maybeSingle()
  if (!emp) return { ok: false, error: 'Employee not found.' }

  // Soft-archive
  const { error: updateErr } = await admin
    .from('employees')
    .update({ is_archived: true, archived_at: new Date().toISOString(), is_active: false })
    .eq('id', employeeId)
  if (updateErr) return { ok: false, error: updateErr.message }

  // Block auth login if registered
  if (emp.auth_id) {
    await admin.auth.admin.updateUserById(emp.auth_id, {
      ban_duration: '876600h', // ~100 years
    }).catch(() => {})
  }
  return { ok: true }
}

export async function restoreEmployee(employeeId: string): Promise<ActionResult> {
  const auth = await requirePermission('employees.archive')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: emp } = await admin
    .from('employees')
    .select('id, auth_id')
    .eq('id', employeeId)
    .maybeSingle()
  if (!emp) return { ok: false, error: 'Employee not found.' }

  const { error: updateErr } = await admin
    .from('employees')
    .update({ is_archived: false, archived_at: null, is_active: true })
    .eq('id', employeeId)
  if (updateErr) return { ok: false, error: updateErr.message }

  if (emp.auth_id) {
    await admin.auth.admin.updateUserById(emp.auth_id, {
      ban_duration: 'none',
    }).catch(() => {})
  }
  return { ok: true }
}

export async function adminResetPassword(employeeId: string): Promise<ActionResult<{ tempPassword: string }>> {
  const auth = await requirePermission('employees.edit')
  if (!auth.ok) return { ok: false, error: auth.error }

  const admin = createAdminClient()
  const { data: emp } = await admin
    .from('employees')
    .select('id, auth_id')
    .eq('id', employeeId)
    .maybeSingle()
  if (!emp || !emp.auth_id) return { ok: false, error: 'Employee has no account yet.' }

  const tempPassword = 'cirqle-' + crypto.randomUUID().slice(0, 8)
  const { error } = await admin.auth.admin.updateUserById(emp.auth_id, {
    password: tempPassword,
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { tempPassword } }
}
