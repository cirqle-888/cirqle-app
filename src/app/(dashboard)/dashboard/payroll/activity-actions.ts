'use server'

import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission, requireReadPermission } from '@/lib/permissions/check'
import { logActivity } from '@/lib/activity/log'
import type { LogActivityInput } from '@/lib/activity/log'

export interface ActivityLogRow {
  id:          string
  actor_id:    string | null
  subject_id:  string | null
  entity_type: string
  entity_id:   string | null
  action:      string
  detail:      Record<string, unknown> | null
  note:        string | null
  created_at:  string
  actor?:      { cqid: string; name: string } | null
}

/**
 * Fetch the last N activity log rows for a given employee.
 * Requires payroll.view — the same gate as viewing payroll records.
 */
export async function fetchEmployeeActivity(
  employeeId: string,
  limit = 50,
): Promise<{ ok: true; rows: ActivityLogRow[] } | { ok: false; error: string }> {
  const guard = await requireReadPermission('payroll.view')
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('activity_logs')
    .select('*, actor:actor_id(cqid, name)')
    .eq('subject_id', employeeId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) return { ok: false, error: error.message }
  return { ok: true, rows: (data ?? []) as ActivityLogRow[] }
}

/**
 * Add a manual note on an employee (admin-only annotation, like Odoo chatter).
 */
export async function addEmployeeNote(
  employeeId: string,
  note: string,
): Promise<{ ok: boolean; error?: string }> {
  const guard = await requirePermission('payroll.view')
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!note.trim()) return { ok: false, error: 'Note cannot be empty.' }

  await logActivity({
    actorId:    guard.employeeId,
    subjectId:  employeeId,
    entityType: 'note',
    entityId:   employeeId,
    action:     'note',
    note:       note.trim(),
  })

  return { ok: true }
}
