'use server'

/**
 * Generic activity-log server actions — read a per-entity timeline and post a
 * manual log note (Odoo-style "chatter"). Generalises the employee-only pattern
 * in `payroll/activity-actions.ts` so any entity (task, contribution, …) can
 * surface its own feed via the reusable <ActivityPanel> component.
 *
 * Writes are append-only via `logActivity` (fire-and-forget). Reads are gated
 * by the same view permission as the page the panel lives on.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { requireAnyPermission } from '@/lib/auth/enforce'
import { logActivity } from '@/lib/activity/log'
import type { EntityType } from '@/lib/activity/log'

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

export type FetchActivityResult =
  | { ok: true; rows: ActivityLogRow[]; setupNeeded?: boolean }
  | { ok: false; error: string }

// Permission map: which keys may read / annotate each entity's feed.
// Read uses requireAnyPermission (any one grants access). Note uses the edit key.
const READ_PERMS: Record<string, string[]> = {
  task:         ['tasks.view_own', 'tasks.view_all'],
  contribution: ['contributions.view_own', 'contributions.view_all'],
}
const NOTE_PERMS: Record<string, string[]> = {
  task:         ['tasks.edit'],
  contribution: ['contributions.edit'],
}

/** Fetch the timeline for one entity, newest-first, with actor name joined. */
export async function fetchEntityActivity(
  entityType: EntityType,
  entityId: string,
  limit = 50,
): Promise<FetchActivityResult> {
  const guard = await requireAnyPermission(READ_PERMS[entityType] ?? ['tasks.view_all'])
  if (!guard.ok) return { ok: false, error: guard.error }

  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from('activity_logs')
      .select('*, actor:actor_id(cqid, name)')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      // Table may not exist yet (migration 010 not applied) — degrade gracefully.
      if (/relation .*activity_logs.* does not exist/i.test(error.message)) {
        return { ok: true, rows: [], setupNeeded: true }
      }
      return { ok: false, error: error.message }
    }
    return { ok: true, rows: (data ?? []) as ActivityLogRow[] }
  } catch (err: any) {
    return { ok: true, rows: [], setupNeeded: true }
  }
}

/** Append a manual log note on an entity (admin/editor annotation). */
export async function postEntityNote(
  entityType: EntityType,
  entityId: string,
  note: string,
): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireAnyPermission(NOTE_PERMS[entityType] ?? ['tasks.edit'])
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!note.trim()) return { ok: false, error: 'Note cannot be empty.' }

  await logActivity({
    actorId:    guard.employeeId,
    entityType,
    entityId,
    action:     'note',
    note:       note.trim(),
  })

  return { ok: true }
}
