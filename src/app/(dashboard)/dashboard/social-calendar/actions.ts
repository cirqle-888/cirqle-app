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

import { revalidatePath, revalidateTag } from 'next/cache'
import { COMPANY_SETTINGS_TAG } from '@/lib/settings/company-settings'
import { resolveImageExt, IMAGE_UPLOAD_ERROR, IMAGE_EXT_BY_TYPE, MAX_IMAGE_BYTES } from '@/lib/uploads'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { logActivity } from '@/lib/activity/log'
import { createManualRequest } from '@/app/(dashboard)/dashboard/requests/actions'
import { setRequestStatus } from '@/lib/requests/core'
import {
  CONTENT_TYPES, PLATFORMS, composeRequestDescription, buildSocialMeta,
  isTerminalRequestStatus, isClosedRequestStatus, suggestServiceId,
  sanitizeCaptionHtml, captionHtmlToText, sanitizeCaptionCanvas,
} from '@/lib/social/plan'
import { todayISO } from '@/lib/utils/local-date'

const REVALIDATE = '/dashboard/social-calendar'
const MIGRATION_HINT = 'Apply migration 20260716120000_social_calendar.sql first.'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  /** Saved, but something the user entered could not be stored (pending migration). */
  warning?: string
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

// ─── Content type → service defaults ─────────────────────────────────────────
// The team decides which service each content type's pushed request carries
// (Settings gear on the calendar). Stored as one JSON map in company_settings;
// the client falls back to a service-name keyword guess for unmapped types.

const SERVICE_MAP_KEY = 'social_content_type_services'

export async function saveContentTypeServiceMap(
  map: Record<string, string | null>,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  // Keep only known content types with a real value — an empty entry means
  // "no default, use the keyword suggestion".
  const clean: Record<string, string> = {}
  for (const t of CONTENT_TYPES) {
    const v = map[t]
    if (v) clean[t] = v
  }

  const admin = createAdminClient()
  const { error } = await admin.from('company_settings')
    .upsert({ key: SERVICE_MAP_KEY, value: JSON.stringify(clean) }, { onConflict: 'key' })
  if (error) return { ok: false, error: error.message }

  // Shared company-settings cache (lib/settings/company-settings.ts) — bust it
  // so the calendar picks up the new content-type -> service map immediately.
  revalidateTag(COMPANY_SETTINGS_TAG, 'max')
  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Items ────────────────────────────────────────────────────────────────────

export interface ItemInput {
  /** Empty/undefined = an undated idea on the Idea Board backlog. */
  scheduledDate?: string | null
  /** End of a multi-day run (campaigns/SEO); null for single-day items. */
  scheduledEndDate?: string | null
  title: string
  contentType: string
  platforms: string[]
  caption?: string | null
  notes?: string | null
  /** Visual references: uploaded images / pasted links (a mood board). */
  referenceUrls?: string[] | null
  /** Free-drag visual board attached to the copy (validated server-side). */
  captionCanvas?: unknown
  /** Service the pushed design request should carry (aligns the item with the
   *  Requests inbox's service-based pricing/routing). Optional; nullable. */
  serviceId?: string | null
  /** Extra formats of the same creative (e.g. a post that also ships as a
   *  story-size variant). Same vocabulary as contentType. */
  variants?: string[]
  /** Optional designer earmarked at planning time. Rides into the pushed
   *  request's assigned_employee_id, so the plan answers "who draws this?"
   *  without waiting for the Requests inbox. Null = decide later. */
  assignedEmployeeId?: string | null
}

/** Optional patch-migration columns (each added in a later migration). When a
 *  write fails on one, we retry WITHOUT that column only — stripping all of
 *  them would silently drop data for columns that DO exist. */
const PATCH_COLUMNS = ['service_id', 'variants', 'reference_url', 'reference_urls', 'scheduled_end_date', 'caption_canvas', 'assigned_employee_id'] as const

/** Resolve WHICH patch column an error is about.
 *
 *  Postgres/PostgREST name the column in quotes ("Could not find the
 *  'reference_urls' column of ..."), so match that exact name first. A bare
 *  substring test is wrong here: `reference_url` is a prefix of
 *  `reference_urls`, so it would resolve a missing-`reference_urls` error to
 *  `reference_url` — stripping the column that EXISTS and leaving the missing
 *  one in the row, which never converges. */
const missingPatchColumn = (
  e: { message?: string } | null,
  candidates: readonly string[] = PATCH_COLUMNS,
): string | null => {
  const msg = e?.message ?? ''
  if (!msg) return null
  const quoted = [...msg.matchAll(/'([a-z_]+)'/gi)].map(m => m[1])
  const exact = candidates.find(c => quoted.includes(c))
  if (exact) return exact
  // Fallback for unquoted phrasings: longest name first, so a shorter prefix
  // can never shadow a longer column name.
  return [...candidates].sort((a, b) => b.length - a.length).find(c => msg.includes(c)) ?? null
}

/** Run a write, surgically dropping each not-yet-migrated column it trips on.
 *  `run` may return any thenable (Postgrest builders are PromiseLike). */
async function withPatchColumnFallback<T extends { error: { message?: string } | null }>(
  row: Record<string, unknown>,
  run: (row: Record<string, unknown>) => PromiseLike<T>,
  /** Receives every column that had to be dropped, so callers can warn. */
  dropped?: string[],
): Promise<T> {
  let current = row
  // Narrow the candidate list each pass — retrying the same column forever
  // would spin without ever dropping the one actually missing.
  let candidates: string[] = [...PATCH_COLUMNS]
  let res = await run(current)
  while (res.error && candidates.length) {
    const col = missingPatchColumn(res.error, candidates)
    if (!col || !(col in current)) break
    candidates = candidates.filter(c => c !== col)
    dropped?.push(col)
    current = { ...current }
    delete current[col]
    res = await run(current)
  }
  return res
}

/** Valid variant list: known content types, minus the item's own main type. */
const cleanVariants = (input: ItemInput): string[] =>
  [...new Set(input.variants || [])].filter(v =>
    v !== input.contentType && CONTENT_TYPES.includes(v as (typeof CONTENT_TYPES)[number]))

/** Sanitize a (possibly rich) caption; null when there is no visible text. */
const cleanCaption = (caption: string | null | undefined): string | null => {
  const safe = sanitizeCaptionHtml(caption).trim()
  return captionHtmlToText(safe).trim() ? safe : null
}

/** Keep only plausible public http(s) reference links; de-duplicate; cap at 8. */
const cleanReferenceUrls = (urls: string[] | null | undefined): string[] => {
  const out: string[] = []
  for (const raw of urls || []) {
    const t = raw?.trim()
    if (!t) continue
    try {
      const u = new URL(t)
      // Store the NORMALIZED href, not the raw string: `new URL()` accepts
      // http://x/" onerror=... as a valid http URL, and the raw form would
      // break out of the src="..." attribute when the PDF embeds it.
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !out.includes(u.href)) out.push(u.href)
    } catch { /* skip non-URLs */ }
  }
  return out.slice(0, 8)
}

/**
 * Resolve the service a content type's design request should carry —
 * automatically, so planners never see a Service field. Priority: the team's
 * Service-defaults mapping (company_settings, editable via the calendar's
 * gear), then a keyword match against active service names.
 */
async function resolveAutoService(
  admin: ReturnType<typeof createAdminClient>,
  contentType: string,
): Promise<string | null> {
  try {
    const [{ data: mapRow }, { data: services }] = await Promise.all([
      admin.from('company_settings').select('value').eq('key', 'social_content_type_services').maybeSingle(),
      admin.from('services').select('id, name').eq('is_active', true),
    ])
    let serviceMap: Record<string, string> = {}
    try { if (mapRow?.value) serviceMap = JSON.parse(mapRow.value) } catch { /* malformed map — keyword fallback */ }
    return suggestServiceId(contentType, (services as { id: string; name: string }[]) || [], serviceMap)
  } catch {
    return null // never block a save on service resolution
  }
}

/**
 * @param calendarMonth the parent plan's month (YYYY-MM-01). Items outside it
 *   would be stored but render in no grid cell — invisible yet still counted
 *   and still pushed — so the month is part of validity, not just the shape.
 */
function validateItem(input: ItemInput, calendarMonth?: string | null): string | null {
  if (!input.title?.trim()) return 'Give the item a title.'
  // No date = an undated idea on the Idea Board; a start date, when given, must
  // be real and inside the plan's month (the calendar anchors on the start).
  if (input.scheduledDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.scheduledDate)) return 'Pick a valid date.'
    if (calendarMonth && input.scheduledDate.slice(0, 7) !== calendarMonth.slice(0, 7)) {
      return `That date is outside this plan’s month (${calendarMonth.slice(0, 7)}).`
    }
  }
  // End date: valid, needs a start, and must not precede it. It MAY extend past
  // the plan's month (a campaign can spill into the next month).
  if (input.scheduledEndDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.scheduledEndDate)) return 'Pick a valid end date.'
    if (!input.scheduledDate) return 'A period needs a start date too.'
    if (input.scheduledEndDate < input.scheduledDate) return 'The end date cannot be before the start date.'
    // Cap the span: a mistyped year ("2926") is a typo, not a campaign, and an
    // unbounded range makes the calendar walk a million days to draw it.
    const days = Math.round(
      (Date.parse(input.scheduledEndDate + 'T00:00:00Z') - Date.parse(input.scheduledDate + 'T00:00:00Z')) / 86400000)
    if (!Number.isFinite(days)) return 'Pick a valid end date.'
    if (days > MAX_RANGE_DAYS) return 'A period cannot run longer than a year — check the end date.'
  }
  if (!CONTENT_TYPES.includes(input.contentType as any)) return 'Pick a valid content type.'
  const bad = (input.platforms || []).find(p => !PLATFORMS.includes(p as any))
  if (bad) return `Unknown platform "${bad}".`
  return null
}

/**
 * Human warning for data the pending migrations could not store. Only mentions
 * fields the user actually filled in — silently dropping a planner's layout
 * board behind a success toast is how work disappears without anyone noticing.
 */
function migrationWarning(dropped: string[], input: ItemInput, refs: string[]): string | undefined {
  if (!dropped.length) return undefined
  const lost: string[] = []
  const canvas = sanitizeCaptionCanvas(input.captionCanvas)
  if (dropped.includes('caption_canvas') && canvas?.blocks.length) lost.push('the layout board')
  if (dropped.includes('scheduled_end_date') && cleanEndDate(input)) lost.push('the end date')
  if (dropped.includes('reference_urls') && refs.length > 1) lost.push('the extra reference images')
  if (dropped.includes('variants') && cleanVariants(input).length) lost.push('the format variants')
  if (dropped.includes('assigned_employee_id') && input.assignedEmployeeId) lost.push('the assigned designer')
  if (!lost.length) return undefined
  return `Saved, but ${lost.join(' and ')} could not be stored — the database migration for those columns has not been applied yet.`
}

/** Longest span a single planned item may cover (mirrors the client's walk cap). */
const MAX_RANGE_DAYS = 366

/** Normalised end date: null unless it's a real range beyond the start day. */
const cleanEndDate = (input: ItemInput): string | null =>
  input.scheduledDate && input.scheduledEndDate && input.scheduledEndDate > input.scheduledDate
    ? input.scheduledEndDate : null

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

  const refs = cleanReferenceUrls(input.referenceUrls)
  const row = {
    calendar_id: calendarId,
    scheduled_date: input.scheduledDate || null,
    scheduled_end_date: cleanEndDate(input),
    title: input.title.trim(),
    content_type: input.contentType,
    platforms: input.platforms || [],
    caption: cleanCaption(input.caption),
    notes: input.notes?.trim() || null,
    status: 'planned',
    // Auto-assigned: planners never pick a service — the content type decides.
    service_id: input.serviceId ?? await resolveAutoService(admin, input.contentType),
    variants: cleanVariants(input),
    reference_urls: refs,
    reference_url: refs[0] ?? null, // legacy single kept in sync with refs[0]
    caption_canvas: sanitizeCaptionCanvas(input.captionCanvas),
    assigned_employee_id: input.assignedEmployeeId || null,
  }
  const dropped: string[] = []
  const { data, error } = await withPatchColumnFallback(row, r =>
    admin.from('social_calendar_items').insert(r).select('id').single(), dropped)

  if (error) {
    if (isMissingRelation(error)) return { ok: false, error: MIGRATION_HINT }
    return { ok: false, error: error.message }
  }
  revalidatePath(REVALIDATE)
  return { ok: true, data: { id: (data as any).id }, warning: migrationWarning(dropped, input, refs) }
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

  const refs = cleanReferenceUrls(input.referenceUrls)
  const patch = {
    scheduled_date: input.scheduledDate || null,
    scheduled_end_date: cleanEndDate(input),
    title: input.title.trim(),
    content_type: input.contentType,
    platforms: input.platforms || [],
    caption: cleanCaption(input.caption),
    notes: input.notes?.trim() || null,
    // Re-resolved on every edit so changing Post → Reel re-routes the service.
    service_id: input.serviceId ?? await resolveAutoService(admin, input.contentType),
    variants: cleanVariants(input),
    reference_urls: refs,
    reference_url: refs[0] ?? null,
    caption_canvas: sanitizeCaptionCanvas(input.captionCanvas),
    assigned_employee_id: input.assignedEmployeeId || null,
    updated_at: new Date().toISOString(),
  }
  const dropped: string[] = []
  const { error } = await withPatchColumnFallback(patch, r =>
    admin.from('social_calendar_items').update(r).eq('id', itemId), dropped)
  if (error) return { ok: false, error: error.message }
  const warning = migrationWarning(dropped, input, refs)

  // Keep the linked request's brief in sync — but never touch one that is
  // finished/closed (rewriting a record the client already saw), and re-assert
  // the un-promoted condition IN the predicate: the read above is stale the
  // moment someone clicks Start in the inbox (TOCTOU).
  if (req?.id && !isTerminalRequestStatus(req.status)) {
    const calTitle = (item as any).calendar?.title ?? null
    try {
      await admin.from('task_requests').update({
        title: input.title.trim(),
        due_date: input.scheduledDate || null,
        assigned_employee_id: input.assignedEmployeeId || null,
        description: composeRequestDescription({
          title: input.title, contentType: input.contentType, platforms: input.platforms || [],
          scheduledDate: input.scheduledDate, scheduledEndDate: cleanEndDate(input),
          caption: input.caption, notes: input.notes,
          calendarTitle: calTitle, variants: cleanVariants(input),
          referenceUrls: cleanReferenceUrls(input.referenceUrls),
          captionCanvas: sanitizeCaptionCanvas(input.captionCanvas),
        }),
        updated_at: new Date().toISOString(),
      })
        .eq('id', req.id)
        .is('promoted_task_id', null)
        .not('status', 'in', '("completed","delivered","cancelled","rejected","archived")')
    } catch { /* request update is cosmetic — never block the plan edit */ }
  }

  revalidatePath(REVALIDATE); revalidatePath('/dashboard/requests')
  return { ok: true, warning }
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
/**
 * Quick-add for brainstorming: title + type, nothing else. Lands undated on
 * the Idea Board (or on a day when `date` is given); service auto-assigns.
 */
export async function quickAddIdea(
  calendarId: string, title: string, contentType: string, date?: string | null,
): Promise<ActionResult<{ id: string }>> {
  return addCalendarItem(calendarId, {
    scheduledDate: date || null,
    title,
    contentType: CONTENT_TYPES.includes(contentType as (typeof CONTENT_TYPES)[number]) ? contentType : 'post',
    platforms: [],
  })
}

/**
 * Drag-and-drop move: reschedule an item to a day, or back to the Idea Board
 * (date = null). Frozen items (already a task) cannot move — the task owns
 * the schedule; the linked request's due date follows while still open.
 */
export async function moveCalendarItem(
  itemId: string, date: string | null,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'Invalid date.' }

  const admin = createAdminClient()
  const selectCols = 'id, calendar_id, scheduled_date, scheduled_end_date, calendar:social_calendars(month), request:task_requests(id, status, promoted_task_id)'
  let itemRes = await admin.from('social_calendar_items').select(selectCols).eq('id', itemId).maybeSingle()
  if (itemRes.error && (itemRes.error.message || '').includes('scheduled_end_date')) {
    // Pre-migration: no end date column — move without duration shifting.
    itemRes = await admin.from('social_calendar_items')
      .select('id, calendar_id, scheduled_date, calendar:social_calendars(month), request:task_requests(id, status, promoted_task_id)')
      .eq('id', itemId).maybeSingle()
  }
  const item = itemRes.data
  if (itemRes.error || !item) return { ok: false, error: 'Item not found.' }

  // Supabase renders to-one joins as an object or a one-element array
  // depending on FK metadata — normalise both shapes.
  type CalJoin = { month: string }
  type ReqJoin = { id: string; status: string; promoted_task_id: string | null }
  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null)
  const joined = item as unknown as {
    scheduled_date: string | null; scheduled_end_date?: string | null
    calendar: CalJoin | CalJoin[] | null; request: ReqJoin | ReqJoin[] | null
  }
  const month = one(joined.calendar)?.month
  if (date && month && date.slice(0, 7) !== month.slice(0, 7)) {
    return { ok: false, error: `That date is outside this plan’s month (${month.slice(0, 7)}).` }
  }
  const req = one(joined.request)
  if (req?.promoted_task_id) {
    return { ok: false, error: 'This item is already a task — reschedule the task instead.' }
  }

  // A dragged range keeps its DURATION: shift the end by the same day-delta as
  // the start. Moving to the Idea Board (date=null) clears the end too.
  const dayMs = 86_400_000
  const shiftDays = (d: string, days: number) => {
    const dt = new Date(d + 'T00:00:00Z')
    dt.setUTCDate(dt.getUTCDate() + days)
    return dt.toISOString().slice(0, 10)
  }
  const patch: Record<string, unknown> = { scheduled_date: date, updated_at: new Date().toISOString() }
  const oldStart = joined.scheduled_date
  const oldEnd = joined.scheduled_end_date ?? null
  if (!date) {
    patch.scheduled_end_date = null
  } else if (oldStart && oldEnd) {
    const delta = Math.round((new Date(date + 'T00:00:00Z').getTime() - new Date(oldStart + 'T00:00:00Z').getTime()) / dayMs)
    patch.scheduled_end_date = shiftDays(oldEnd, delta)
  }

  const { error } = await withPatchColumnFallback(patch, r =>
    admin.from('social_calendar_items').update(r).eq('id', itemId))
  if (error) return { ok: false, error: error.message }

  // Follow-on: keep an open linked request's due date in step (best-effort).
  if (req?.id && !isTerminalRequestStatus(req.status)) {
    try {
      await admin.from('task_requests')
        .update({ due_date: date, updated_at: new Date().toISOString() })
        .eq('id', req.id)
        .is('promoted_task_id', null)
        .not('status', 'in', '("completed","delivered","cancelled","rejected","archived")')
    } catch { /* cosmetic */ }
  }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

/**
 * Signed upload for an idea's reference image. Bucket is created on first use
 * (public — the URL must be loadable by the PDF rasteriser and designers).
 */
export async function getRefUploadUrl(
  filename: string,
  contentType?: string,
): Promise<ActionResult<{ uploadUrl: string; publicUrl: string }>> {
  const guard = await requirePermission(PERMS.SOCIAL_MANAGE)
  if (!guard.ok) return { ok: false, error: guard.error }

  // social-refs is a PUBLIC bucket, so an unchecked extension here would let a
  // .html upload be served from our own origin.
  const ext = resolveImageExt(filename, contentType)
  if (!ext) return { ok: false, error: IMAGE_UPLOAD_ERROR }

  const admin = createAdminClient()
  try {
    await admin.storage.createBucket('social-refs', {
      public: true,
      fileSizeLimit: MAX_IMAGE_BYTES,
      allowedMimeTypes: Object.keys(IMAGE_EXT_BY_TYPE),
    })
  } catch { /* exists */ }
  const path = `${todayISO()}/${crypto.randomUUID()}.${ext}`
  const { data, error } = await admin.storage.from('social-refs').createSignedUploadUrl(path)
  if (error || !data) return { ok: false, error: 'Could not prepare the upload.' }
  const { data: pub } = admin.storage.from('social-refs').getPublicUrl(path)
  return { ok: true, data: { uploadUrl: data.signedUrl, publicUrl: pub.publicUrl } }
}

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

  type PushItemRow = {
    id: string; scheduled_date: string | null; scheduled_end_date?: string | null
    title: string; content_type: string
    platforms: string[] | null; caption: string | null; notes: string | null
    status: string; request_id: string | null; service_id?: string | null
    variants?: string[] | null; reference_url?: string | null; reference_urls?: string[] | null
    caption_canvas?: unknown
  }
  let items: PushItemRow[] | null = null
  let itemsErr: { message: string } | null = null
  // Pre-migration fallback: drop ONLY the column each retry trips on, so a
  // pending migration doesn't also blank columns that DO exist.
  let cols = ['id', 'scheduled_date', 'scheduled_end_date', 'title', 'content_type', 'platforms', 'caption', 'notes', 'status', 'request_id', 'service_id', 'variants', 'reference_url', 'reference_urls', 'caption_canvas', 'assigned_employee_id']
  for (let attempt = 0; attempt <= PATCH_COLUMNS.length; attempt++) {
    const res = await admin.from('social_calendar_items')
      .select(cols.join(', '))
      .eq('calendar_id', calendarId)
      .in('id', itemIds)
    items = res.data as unknown as PushItemRow[] | null
    itemsErr = res.error
    // Resolve against the columns still selected, so a name already dropped
    // can't be picked again and stall the retry.
    const col = missingPatchColumn(itemsErr, PATCH_COLUMNS.filter(c => cols.includes(c)))
    if (!col || !cols.includes(col)) break
    cols = cols.filter(c => c !== col)
  }
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
        scheduledDate: item.scheduled_date, scheduledEndDate: item.scheduled_end_date,
        caption: item.caption, notes: item.notes,
        calendarTitle: (cal as any).title, variants: item.variants,
        referenceUrls: item.reference_urls?.length ? item.reference_urls : (item.reference_url ? [item.reference_url] : []),
        captionCanvas: sanitizeCaptionCanvas(item.caption_canvas),
      }),
      isPlanned: true,
      dueDate: item.scheduled_date,
      // The item's chosen service rides into the request so calendar work gets
      // the same service-based pricing/routing as directly-created requests.
      serviceId: item.service_id || null,
      // Planner's pick rides along; the inbox can still reassign.
      assignedEmployeeId: item.assigned_employee_id || null,
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
          scheduledEndDate: item.scheduled_end_date, variants: item.variants,
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
