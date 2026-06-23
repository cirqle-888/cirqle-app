'use server'

/**
 * Notification inbox actions — any logged-in employee reads/marks their own
 * notifications (employee_id = them). "Broadcast" notifications (see
 * notifyAdmins in lib/notifications/create.ts) are already fanned out as one
 * row per admin, so this is always a plain per-employee query — no shared
 * row, no cross-admin read-state collision. No special permission required
 * beyond being signed in, same as the command palette.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveCurrentEmployeeId } from '@/lib/auth/enforce'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

export interface NotificationRow {
  id: string
  employee_id: string | null
  type: string
  title: string
  message: string | null
  link: string | null
  read: boolean
  created_at: string
}

export async function getMyNotifications(limit = 30): Promise<ActionResult<{ rows: NotificationRow[]; unreadCount: number }>> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in' }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('notifications')
    .select('id, employee_id, type, title, message, link, read, created_at')
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return { ok: false, error: error.message }
  const rows = data || []
  return { ok: true, data: { rows, unreadCount: rows.filter(r => !r.read).length } }
}

export async function markNotificationRead(id: string): Promise<ActionResult> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('notifications')
    .update({ read: true })
    .eq('id', id)
    .eq('employee_id', employeeId)

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard')
  return { ok: true }
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  const employeeId = await resolveCurrentEmployeeId()
  if (!employeeId) return { ok: false, error: 'Not signed in' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('notifications')
    .update({ read: true })
    .eq('employee_id', employeeId)
    .eq('read', false)

  if (error) return { ok: false, error: error.message }
  revalidatePath('/dashboard')
  return { ok: true }
}
