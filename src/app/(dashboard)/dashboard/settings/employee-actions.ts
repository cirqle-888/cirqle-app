'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { headers } from 'next/headers'
import { requirePermission } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
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

  const hdrs = await headers()
  const host  = hdrs.get('host') || ''
  const isLocal = host.startsWith('localhost') || host.startsWith('127.')
  const proto = hdrs.get('x-forwarded-proto') || (isLocal ? 'http' : 'https')
  const origin = `${proto}://${host}`
  
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

  // Log: employee archived (fire-and-forget)
  void logActivity({
    actorId:    auth.employeeId,
    subjectId:  employeeId,
    entityType: 'employee',
    entityId:   employeeId,
    action:     'employee_archived',
  })

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

  // Log: employee restored (fire-and-forget)
  void logActivity({
    actorId:    auth.employeeId,
    subjectId:  employeeId,
    entityType: 'employee',
    entityId:   employeeId,
    action:     'employee_created',
    detail:     { event: 'restored_from_archive' },
  })

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

/**
 * Update an employee's avatar_url (preset ID or uploaded photo URL).
 * Employees can update their own; admins can update anyone's.
 */
export async function updateEmployeeAvatar(employeeId: string, avatarUrl: string | null): Promise<ActionResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const admin = createAdminClient()

  // Check ownership (own record) or admin permission
  const { data: self } = await admin.from('employees').select('id').eq('auth_id', user.id).maybeSingle()
  const isSelf = self?.id === employeeId

  if (!isSelf) {
    const auth = await requirePermission('employees.edit')
    if (!auth.ok) return { ok: false, error: auth.error }
  }

  const { error } = await admin
    .from('employees')
    .update({ avatar_url: avatarUrl })
    .eq('id', employeeId)

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
