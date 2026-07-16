'use server'

/**
 * Social Media Calendar — server actions.
 *
 * Permission model: social.manage gates every planner mutation. Pushing an
 * item to Requests reuses the Requests module's guarded createManualRequest
 * (so the caller also needs requests.manage — same layering as the
 * advertising module's createAdvertisingRequest).
 *
 * Integration contract (mirrors ad_meta, see migration 20260716120000):
 * a pushed item becomes a REAL task_request tagged with social_meta; from
 * then on the pipeline owns it. The calendar never writes request/task
 * status — it only reads it back through joins.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { createManualRequest } from '@/app/(dashboard)/dashboard/requests/actions'
import { setRequestStatus } from '@/lib/requests/core'
import {
  CONTENT_TYPES, PLATFORMS, composeRequestDescription, buildSocialMeta,
  isTerminalRequestStatus, isClosedRequestStatus,
} from '@/lib/social/plan'

const REVALIDATE = '/dashboard/social-calendar'
const MIGRATION_HINT = 'Apply migration 20260716120000_social_calendar.sql first.'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

const isMissingRelation = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || /does not exist|schema cache/i.test(e.message ?? ''))

// ─── Calendars ────────────────────────────────────────────────────────────────

export interface CalendarInput {
  clientId: string
  month: string          // any date in the month; normalized to day 1
  title?: string | null
  notes?: string | null
}

export async function createSocialCalendar(input: CalendarInput): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!input.clientId) return { ok: false, error: 'Pick a client.' }
  if (!/^\d{4}-\d{2}/.test(input.month || '')) return { ok: false, error: 'Pick a month.' }
  const month = `${input.month.slice(0, 7)}-01`

  const admin = createAdminClient()
  const { data, error } = await admin.from('social_calendars').insert({
    client_id: input.clientId,
    month,
    title: input.title?.trim() || null,
    notes: input.notes?.trim() || null,
    status: 'active',
    created_by: guard.employeeId,
  }).select('id').single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: 'A calendar for this client and month already exists.' }
    if (isMissingRelation(error)) return { ok: false, error: MIGRATION_HINT }
    return { ok: false, error: error.message }
  }

  void logActivity({
    actorId: guard.employeeId, entityType: 'project', entityId: (data as any).id,
    action: 'created', category: 'crm', clientId: input.clientId,
    detail: { label: `Social calendar ${month.slice(0, 7)}` },
  })
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: (data as any).id } }
}

export async function updateSocialCalendar(
  id: string,
  changes: { title?: string | null; notes?: string | null; status?: 'draft' | 'active' | 'archived' },
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  // Whitelist explicitly — a server action is a network endpoint, so spreading
  // the caller's object would let it re-point client_id/month (detaching the
  // plan from the client its live requests belong to).
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (changes.title !== undefined) patch.title = changes.title?.trim() || null
  if (changes.notes !== undefined) patch.notes = changes.notes?.trim() || null
  if (changes.status !== undefined) {
    if (!['draft', 'active', 'archived'].includes(changes.status)) {
      return { ok: false, error: 'Invalid plan status.' }
    }
    patch.status = changes.status
  }

  const admin = createAdminClient()
  const { error } = await admin.from('social_calendars').update(patch).eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Hard-delete a calendar. Blocked once any item has been sent to Requests —
 * those requests are live pipeline work; archive the calendar instead.
 */
export async function deleteSocialCalendar(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  // Fail CLOSED: if the guard query itself fails we must not fall through to a
  // cascading delete of items that may back live requests.
  const { count, error: countErr } = await admin.from('social_calendar_items')
    .select('id', { count: 'exact', head: true })
    .eq('calendar_id', id).not('request_id', 'is', null)
  if (countErr) return { ok: false, error: 'Could not verify the plan is safe to delete — try again.' }
  if ((count ?? 0) > 0) {
    return { ok: false, error: 'Some items were already sent to Requests — archive this calendar instead of deleting it.' }
  }

  const { error } = await admin.from('social_calendars').delete().eq('id', id)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Items ────────────────────────────────────────────────────────────────────

export interface ItemInput {
  scheduledDate: string
  title: string
  contentType: string
  platforms: string[]
  caption?: string | null
  notes?: string | null
}

/**
 * @param calendarMonth the parent plan's month (YYYY-MM-01). Items outside it
 *   would be stored but render in no grid cell — invisible yet still counted
 *   and still pushed — so the month is part of validity, not just the shape.
 */
function validateItem(input: ItemInput, calendarMonth?: string | null): string | null {
  if (!input.title?.trim()) return 'Give the item a title.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.scheduledDate || '')) return 'Pick a date.'
  if (!CONTENT_TYPES.includes(input.contentType as any)) return 'Pick a valid content type.'
  const bad = (input.platforms || []).find(p => !PLATFORMS.includes(p as any))
  if (bad) return `Unknown platform "${bad}".`
  if (calendarMonth && input.scheduledDate.slice(0, 7) !== calendarMonth.slice(0, 7)) {
    return `That date is outside this plan’s month (${calendarMonth.slice(0, 7)}).`
  }
  return null
}

export async function addCalendarItem(
  calendarId: string, input: ItemInput,
): Promise<ActionResult<{ id: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: cal, error: calErr } = await admin.from('social_calendars')
    .select('id, month').eq('id', calendarId).maybeSingle()
  if (calErr && isMissingRelation(calErr)) return { ok: false, error: MIGRATION_HINT }
  if (!cal) return { ok: false, error: 'Calendar not found.' }

  const invalid = validateItem(input, (cal as any).month)
  if (invalid) return { ok: false, error: invalid }

  const { data, error } = await admin.from('social_calendar_items').insert({
    calendar_id: calendarId,
    scheduled_date: input.scheduledDate,
    title: input.title.trim(),
    content_type: input.contentType,
    platforms: input.platforms || [],
    caption: input.caption?.trim() || null,
    notes: input.notes?.trim() || null,
    status: 'planned',
  }).select('id').single()

  if (error) {
    if (isMissingRelation(error)) return { ok: false, error: MIGRATION_HINT }
    return { ok: false, error: error.message }
  }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: (data as any).id } }
}

/**
 * Edit an item. After it has been pushed, edits stay allowed while the linked
 * request is still un-promoted — and the request's title/due date/description
 * are kept in sync so the inbox never shows a stale brief. Once a task exists,
 * the plan is frozen (the task is the source of truth).
 */
export async function updateCalendarItem(
  itemId: string, input: ItemInput,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: item, error: itemErr } = await admin.from('social_calendar_items')
    .select('id, request_id, calendar_id, calendar:social_calendars(title, month), request:task_requests(id, promoted_task_id, status)')
    .eq('id', itemId).maybeSingle()
  if (itemErr || !item) return { ok: false, error: 'Item not found.' }

  const invalid = validateItem(input, (item as any).calendar?.month)
  if (invalid) return { ok: false, error: invalid }

  const req = (item as any).request
  if (req?.promoted_task_id) {
    return { ok: false, error: 'This item is already a task — edit the task instead; the plan entry is frozen.' }
  }

  const { error } = await admin.from('social_calendar_items').update({
    scheduled_date: input.scheduledDate,
    title: input.title.trim(),
    content_type: input.contentType,
    platforms: input.platforms || [],
    caption: input.caption?.trim() || null,
    notes: input.notes?.trim() || null,
    updated_at: new Date().toISOString(),
  }).eq('id', itemId)
  if (error) return { ok: false, error: error.message }

  // Keep the linked request's brief in sync — but never touch one that is
  // finished/closed (rewriting a record the client already saw), and re-assert
  // the un-promoted condition IN the predicate: the read above is stale the
  // moment someone clicks Start in the inbox (TOCTOU).
  if (req?.id && !isTerminalRequestStatus(req.status)) {
    const calTitle = (item as any).calendar?.title ?? null
    try {
      await admin.from('task_requests').update({
        title: input.title.trim(),
        due_date: input.scheduledDate,
        description: composeRequestDescription({
          title: input.title, contentType: input.contentType, platforms: input.platforms || [],
          scheduledDate: input.scheduledDate, caption: input.caption, notes: input.notes,
          calendarTitle: calTitle,
        }),
        updated_at: new Date().toISOString(),
      })
        .eq('id', req.id)
        .is('promoted_task_id', null)
        .not('status', 'in', '("completed","delivered","cancelled","rejected","archived")')
    } catch { /* request update is cosmetic — never block the plan edit */ }
  }

  revalidatePath(REVALIDATE); revalidatePath('/dashboard/requests')
  return { ok: true }
}

/**
 * Re-plan an item whose request was cancelled/rejected/archived in the inbox.
 * Without this the item is a dead end: push() skips anything already linked,
 * so a shelved-then-revived post could only be recreated from scratch.
 */
export async function revertItemToPlanned(itemId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: item, error: itemErr } = await admin.from('social_calendar_items')
    .select('id, request_id, request:task_requests(id, status, promoted_task_id)')
    .eq('id', itemId).maybeSingle()
  if (itemErr || !item) return { ok: false, error: 'Item not found.' }

  const req = (item as any).request
  if (!req) return { ok: false, error: 'This item has no linked request.' }
  if (req.promoted_task_id) return { ok: false, error: 'This item is already a task — manage it from the Tasks page.' }
  if (!isClosedRequestStatus(req.status)) {
    return { ok: false, error: 'Its request is still open in the inbox — cancel it there first.' }
  }

  // Unlink only (the cancelled request stays as history). Conditional on the
  // request_id we read, so a concurrent push can't have its link clobbered.
  const { data: reverted, error } = await admin.from('social_calendar_items')
    .update({ request_id: null, status: 'planned', updated_at: new Date().toISOString() })
    .eq('id', itemId).eq('request_id', req.id)
    .select('id')
  if (error) return { ok: false, error: error.message }
  if (!reverted?.length) return { ok: false, error: 'The item changed while you were working — reload and retry.' }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Remove an item. If it was pushed but the request is still open, that request
 * is cancelled first (via the house setRequestStatus, so client_status, the
 * portal timeline and visibility all behave exactly like an inbox cancel) —
 * the item row is deleted ONLY if that succeeded, otherwise we would strand a
 * live request with nothing pointing at it.
 *
 * Blocked once the request is promoted (the task owns it) or already
 * completed/delivered (a finished, client-notified record must not be
 * retroactively cancelled by a calendar tidy-up).
 */
export async function deleteCalendarItem(itemId: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data: item, error: itemErr } = await admin.from('social_calendar_items')
    .select('id, request_id, request:task_requests(id, ref_no, promoted_task_id, status)')
    .eq('id', itemId).maybeSingle()
  if (itemErr || !item) return { ok: false, error: 'Item not found.' }

  const req = (item as any).request
  if (req?.promoted_task_id) {
    return { ok: false, error: 'This item is already a task — cancel the task from the Tasks page instead.' }
  }
  if (req && (req.status === 'completed' || req.status === 'delivered')) {
    return {
      ok: false,
      error: `Its request (${req.ref_no ? `REQ-${String(req.ref_no).padStart(4, '0')}` : 'linked'}) is already ${req.status} — the client has been notified. Handle it in the Requests inbox.`,
    }
  }

  if (req?.id && !isClosedRequestStatus(req.status)) {
    // setRequestStatus writes status + client_status + status_updated_at and
    // logs a requester-visible status_changed entry (core.ts) — the inline
    // update this replaces flipped the portal to Cancelled with no timeline.
    const cancelled = await setRequestStatus(admin, req.id, 'cancelled', {
      type: 'admin', id: guard.employeeId,
    })
    if (!cancelled) {
      return { ok: false, error: 'Could not cancel the linked request — the item was kept so it stays traceable. Try again.' }
    }
  }

  const { error } = await admin.from('social_calendar_items').delete().eq('id', itemId)
  if (error) return { ok: false, error: error.message }
  revalidatePath(REVALIDATE); revalidatePath('/dashboard/requests')
  return { ok: true }
}

// ─── Push to Requests (the integration) ──────────────────────────────────────

/**
 * Send planned items into the Requests inbox. Each becomes a real
 * task_request (source 'manual', is_planned, due date = scheduled date)
 * tagged with social_meta — from there the normal pipeline applies:
 * Start → task, task status mirrors back, portal visibility, everything.
 *
 * Partial success is reported honestly: already-pushed/cancelled items are
 * skipped, per-item failures don't abort the batch.
 */
export async function pushItemsToRequests(
  calendarId: string, itemIds: string[],
): Promise<ActionResult<{ pushed: number; skipped: number; failed: number }>> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!itemIds.length) return { ok: false, error: 'Nothing selected.' }

  const admin = createAdminClient()
  const { data: cal, error: calErr } = await admin.from('social_calendars')
    .select('id, client_id, title, month')
    .eq('id', calendarId).maybeSingle()
  if (calErr || !cal) return { ok: false, error: 'Calendar not found.' }

  const { data: items, error: itemsErr } = await admin.from('social_calendar_items')
    .select('id, scheduled_date, title, content_type, platforms, caption, notes, status, request_id')
    .eq('calendar_id', calendarId)
    .in('id', itemIds)
  if (itemsErr) return { ok: false, error: itemsErr.message }

  let pushed = 0, skipped = 0, failed = 0
  let firstError: string | undefined

  for (const item of (items || []) as any[]) {
    if (item.request_id || item.status !== 'planned') { skipped++; continue }

    const res = await createManualRequest({
      clientId: (cal as any).client_id,
      title: item.title,
      description: composeRequestDescription({
        title: item.title, contentType: item.content_type, platforms: item.platforms || [],
        scheduledDate: item.scheduled_date, caption: item.caption, notes: item.notes,
        calendarTitle: (cal as any).title,
      }),
      isPlanned: true,
      dueDate: item.scheduled_date,
    })
    // createManualRequest guards REQUESTS_MANAGE independently — surfacing its
    // error matters: 'Permission denied.' is otherwise reported as an
    // unexplained, un-retryable failure.
    if (!res.ok || !res.data) { failed++; firstError ??= res.error; continue }
    const requestId = (res.data as any).id as string

    // Atomic claim: a single conditional UPDATE. Two concurrent pushes both
    // pass the in-memory check above, but only one can match request_id IS NULL
    // — the loser gets 0 rows and cleans up the request it just created, so an
    // item can never end up with two live requests.
    const { data: claimed, error: linkErr } = await admin.from('social_calendar_items')
      .update({ request_id: requestId, status: 'requested', updated_at: new Date().toISOString() })
      .eq('id', item.id).is('request_id', null).eq('status', 'planned')
      .select('id')

    if (linkErr || !claimed?.length) {
      // Compensate: the request is already committed, so leaving it would
      // strand open 'planned' work in the inbox that no item points at.
      const undone = await setRequestStatus(admin, requestId, 'cancelled', {
        type: 'admin', id: guard.employeeId, label: 'social calendar (rolled back)',
      })
      failed++
      firstError ??= undone
        ? 'Another push claimed the same item — its duplicate request was rolled back.'
        : `Could not link the item and could not roll back its request${(res.data as any).ref_no ? ` (REQ-${String((res.data as any).ref_no).padStart(4, '0')})` : ''} — cancel it in the Requests inbox.`
      continue
    }

    // Tag last (best-effort, mirrors the ad_meta precedent): an untagged
    // request is still perfectly good work, it just isn't attributed back.
    try {
      await admin.from('task_requests').update({
        social_meta: buildSocialMeta({
          calendarId, itemId: item.id, contentType: item.content_type,
          platforms: item.platforms || [], scheduledDate: item.scheduled_date,
        }),
      }).eq('id', requestId)
    } catch { /* social_meta column not migrated — request still created, just untagged */ }

    pushed++
  }

  void logActivity({
    actorId: guard.employeeId, entityType: 'project', entityId: calendarId,
    action: 'updated', category: 'crm', clientId: (cal as any).client_id,
    detail: { label: 'Social calendar → Requests', pushed, skipped, failed },
  })
  revalidatePath(REVALIDATE); revalidatePath('/dashboard/requests')

  // Nothing landed and it wasn't all skips → report the real reason instead of
  // a bare "N failed" the user can only retry into the same wall.
  if (pushed === 0 && failed > 0) {
    return { ok: false, error: firstError || 'Could not send any items to Requests.' }
  }
  return { ok: true, data: { pushed, skipped, failed } }
}
