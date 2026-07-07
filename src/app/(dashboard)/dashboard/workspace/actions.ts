'use server'

/**
 * Personal Workspace (Cirqle Connect Wave F).
 *
 * A private per-employee space: todos, notes, saved messages, pins, reminders.
 * CRITICAL: owner-only — every query is scoped to the caller's employeeId and
 * there is NO admin bypass (workspace_items RLS enforces the same; writes are
 * server-action-only). Graceful pre-migration: reads return [] if 021 isn't
 * applied yet.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser } from '@/lib/permissions/check'

export type WorkspaceKind = 'todo' | 'note' | 'saved_message' | 'pin' | 'reminder'

export interface WorkspaceItem {
  id: string
  kind: WorkspaceKind
  title: string
  body: string | null
  dueDate: string | null
  remindAt: string | null
  isDone: boolean
  refType: string | null
  refId: string | null
  conversationId: string | null
  sortOrder: number
  createdAt: string
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

async function requireUser() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false as const, error: 'Not signed in.' }
  return { ok: true as const, me }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapItem(r: any): WorkspaceItem {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body ?? null,
    dueDate: r.due_date ?? null,
    remindAt: r.remind_at ?? null,
    isDone: r.is_done ?? false,
    refType: r.ref_type ?? null,
    refId: r.ref_id ?? null,
    conversationId: r.conversation_id ?? null,
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
  }
}

export async function listWorkspaceItems(): Promise<Result<WorkspaceItem[]>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  try {
    const admin = createAdminClient()
    const { data, error } = await admin
      .from('workspace_items')
      .select('*')
      .eq('employee_id', auth.me.employeeId)   // owner-only
      .order('is_done', { ascending: true })
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) return { ok: true, data: [] } // pre-migration → empty, not an error
    return { ok: true, data: (data ?? []).map(mapItem) }
  } catch {
    return { ok: true, data: [] }
  }
}

export async function addWorkspaceItem(input: {
  kind?: WorkspaceKind
  title: string
  body?: string
  dueDate?: string | null
  remindAt?: string | null
  refType?: string | null
  refId?: string | null
  conversationId?: string | null
}): Promise<Result<WorkspaceItem>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const title = (input.title || '').trim()
  if (!title) return { ok: false, error: 'A title is required.' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('workspace_items').insert({
    employee_id: auth.me.employeeId,
    kind: input.kind ?? 'todo',
    title,
    body: (input.body || '').trim() || null,
    due_date: input.dueDate ?? null,
    remind_at: input.remindAt ?? null,
    ref_type: input.refType ?? null,
    ref_id: input.refId ?? null,
    conversation_id: input.conversationId ?? null,
  }).select('*').single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: mapItem(data) }
}

/** Update mutable fields. Owner-guarded by employee_id on the WHERE. */
export async function updateWorkspaceItem(id: string, patch: {
  title?: string
  body?: string | null
  dueDate?: string | null
  remindAt?: string | null
  isDone?: boolean
}): Promise<Result<null>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upd: any = { updated_at: new Date().toISOString() }
  if (patch.title !== undefined) upd.title = patch.title.trim()
  if (patch.body !== undefined) upd.body = (patch.body || '').trim() || null
  if (patch.dueDate !== undefined) upd.due_date = patch.dueDate
  if (patch.remindAt !== undefined) upd.remind_at = patch.remindAt
  if (patch.isDone !== undefined) {
    upd.is_done = patch.isDone
    upd.done_at = patch.isDone ? new Date().toISOString() : null
  }
  const { error } = await admin.from('workspace_items')
    .update(upd)
    .eq('id', id).eq('employee_id', auth.me.employeeId)   // owner-only
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}

export async function deleteWorkspaceItem(id: string): Promise<Result<null>> {
  const auth = await requireUser()
  if (!auth.ok) return auth
  const admin = createAdminClient()
  const { error } = await admin.from('workspace_items')
    .delete().eq('id', id).eq('employee_id', auth.me.employeeId)   // owner-only
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: null }
}
