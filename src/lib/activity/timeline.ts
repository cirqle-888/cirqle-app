'use server'

/**
 * Universal Timeline — the ONE read path for activity feeds.
 * Design: docs/cirqle-connect/API_DESIGN.md §1, SECURITY_REVIEW.md §1.
 *
 * Permission rules enforced here (single enforcement point):
 *   • global feed                 → timeline.view_all
 *   • employee scope (not self)   → employees.view
 *   • billing/finance categories  → timeline.view_finance (else stripped)
 *   • client/project/task scopes  → the page's own gate got the user here;
 *     rows are still category-filtered by the finance rule above.
 *
 * Graceful pre-migration behavior: if migration 014 is not applied yet
 * (missing columns), scope queries fall back to entity_type/entity_id or
 * subject_id lookups so the tabs still render.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import type { ActivityCategory } from './log'
import { FINANCE_CATEGORIES } from './timeline-copy'

export interface TimelineScope {
  clientId?:   string
  projectId?:  string
  taskId?:     string
  employeeId?: string
  /** Recruitment module — job_applications.id (migration 020). */
  applicationId?: string
  global?:     boolean
}

export interface TimelineItem {
  id:          string
  entityType:  string
  entityId:    string | null
  action:      string
  category:    string
  note:        string | null
  detail:      unknown
  actor:       { id: string; name: string; cqid: string } | null
  createdAt:   string
}

export type TimelineResult =
  | { ok: true; items: TimelineItem[]; nextCursor: string | null; setupNeeded?: boolean }
  | { ok: false; error: string }

const PAGE_SIZE = 30

export async function getTimeline(
  scope: TimelineScope,
  opts: { categories?: ActivityCategory[]; cursor?: string | null } = {},
): Promise<TimelineResult> {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) return { ok: false, error: 'Not signed in.' }

  // ── Scope authorization ────────────────────────────────────────────────────
  if (scope.global && !hasPermission(me, 'timeline.view_all')) {
    return { ok: false, error: 'You do not have permission to view the global activity feed.' }
  }
  if (scope.employeeId && scope.employeeId !== me.employeeId && !hasPermission(me, 'employees.view')) {
    return { ok: false, error: 'You do not have permission to view other employees’ timelines.' }
  }
  if (scope.applicationId && !hasPermission(me, 'recruitment.view')) {
    return { ok: false, error: 'You do not have permission to view recruitment activity.' }
  }
  if (!scope.global && !scope.clientId && !scope.projectId && !scope.taskId && !scope.employeeId && !scope.applicationId) {
    return { ok: false, error: 'A timeline scope is required.' }
  }

  // ── Category filter (finance rule) ─────────────────────────────────────────
  const canFinance = me.isAdmin || hasPermission(me, 'timeline.view_finance')
  let categories = opts.categories?.length ? [...opts.categories] : null
  if (!canFinance) {
    categories = categories
      ? categories.filter(c => !FINANCE_CATEGORIES.includes(c))
      : null // null = "all allowed" — finance exclusion applied in the query below
    if (opts.categories?.length && categories && categories.length === 0) {
      return { ok: true, items: [], nextCursor: null } // asked ONLY for categories they can't see
    }
  }

  try {
    const admin = createAdminClient()
    let q = admin
      .from('activity_logs')
      .select('id, actor_id, entity_type, entity_id, action, category, detail, note, created_at, actor:actor_id(id, cqid, name)')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false }) // stable tiebreak for cursor pagination
      .limit(PAGE_SIZE + 1)

    if (scope.clientId)  q = q.eq('client_id',  scope.clientId)
    if (scope.projectId) q = q.eq('project_id', scope.projectId)
    if (scope.taskId)    q = q.eq('task_id',    scope.taskId)
    if (scope.applicationId) q = q.eq('application_id', scope.applicationId)
    if (scope.employeeId) {
      // Employee timeline = things about them OR done by them
      q = q.or(`subject_id.eq.${scope.employeeId},actor_id.eq.${scope.employeeId}`)
    }
    if (categories)       q = q.in('category', categories)
    else if (!canFinance) q = q.not('category', 'in', '("billing","finance")')
    if (opts.cursor)      q = q.lt('created_at', opts.cursor)

    const { data, error } = await q

    if (error) {
      // Missing column (42703 / PGRST100 on order) or table → migration 010/014 not applied
      const msg = error.message || ''
      if (/column .* does not exist|does not exist|schema cache/i.test(msg)) {
        return await legacyFallback(scope, opts.cursor ?? null)
      }
      return { ok: false, error: msg }
    }

    return paginate(data ?? [])
  } catch {
    return { ok: true, items: [], nextCursor: null, setupNeeded: true }
  }
}

/** Pre-migration-014 fallback: task/employee scopes still work via legacy columns. */
async function legacyFallback(scope: TimelineScope, cursor: string | null): Promise<TimelineResult> {
  try {
    const admin = createAdminClient()
    let q = admin
      .from('activity_logs')
      .select('id, actor_id, entity_type, entity_id, action, detail, note, created_at, actor:actor_id(id, cqid, name)')
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE + 1)

    if (scope.taskId)        q = q.eq('entity_type', 'task').eq('entity_id', scope.taskId)
    else if (scope.employeeId) q = q.or(`subject_id.eq.${scope.employeeId},actor_id.eq.${scope.employeeId}`)
    else if (!scope.global)  return { ok: true, items: [], nextCursor: null, setupNeeded: true }
    if (cursor) q = q.lt('created_at', cursor)

    const { data, error } = await q
    if (error) return { ok: true, items: [], nextCursor: null, setupNeeded: true }
    return paginate(data ?? [], /* legacy */ true)
  } catch {
    return { ok: true, items: [], nextCursor: null, setupNeeded: true }
  }
}

type RawRow = Record<string, unknown> & { actor?: unknown }

function paginate(rows: unknown[], legacy = false): TimelineResult {
  const hasMore = rows.length > PAGE_SIZE
  const page = (hasMore ? rows.slice(0, PAGE_SIZE) : rows) as RawRow[]
  const items: TimelineItem[] = page.map((r) => {
    const rawActor = Array.isArray(r.actor) ? r.actor[0] : r.actor
    const actor = rawActor as { id: string; name?: string; cqid?: string } | null | undefined
    return {
      id:         String(r.id),
      entityType: String(r.entity_type),
      entityId:   (r.entity_id as string | null) ?? null,
      action:     String(r.action),
      category:   (r.category as string | null) ?? (legacy ? legacyCategory(String(r.entity_type)) : 'crm'),
      note:       (r.note as string | null) ?? null,
      detail:     r.detail ?? null,
      actor:      actor ? { id: actor.id, name: actor.name ?? '', cqid: actor.cqid ?? '' } : null,
      createdAt:  String(r.created_at),
    }
  })
  return {
    ok: true,
    items,
    nextCursor: hasMore ? String(page[page.length - 1].created_at) : null,
  }
}

function legacyCategory(entityType: string): string {
  switch (entityType) {
    case 'task': case 'contribution': case 'score': return 'tasks'
    case 'invoice': return 'billing'
    case 'cashbook': case 'payroll': return 'finance'
    case 'employee': return 'employees'
    default: return 'crm'
  }
}
