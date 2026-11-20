/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Social Calendar writes for the MCP server: edit, remove and send planned
 * items, without a signed-in session. The calendar page's own actions are
 * guarded by a person's permissions; the MCP route is guarded by its token
 * (see src/lib/mcp/server.ts), so these run on the admin client and keep to
 * the same rules the page enforces:
 *
 *   - only PLANNED items that are not yet in Requests or Tasks can change;
 *   - nothing is deleted once work has started on it;
 *   - sending to Requests files the same brief the page files, and claims the
 *     item atomically, so a double send can never make two requests.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { cleanPlanItem, captionFromText, type PlanItemInput } from '@/lib/social/plan-mcp'
import {
  buildSocialMeta, composeRequestDescription, dueDateForPublish, sanitizeCaptionCanvas,
} from '@/lib/social/plan'
import { cleanBriefLinks, cleanImageUrls, contentBriefToText, normalizeContentBrief } from '@/lib/content-brief'
import { normalizeTaskTitle } from '@/lib/utils/title-case'
import { logRequestActivity, setRequestStatus } from '@/lib/requests/core'

type Admin = SupabaseClient<any, any, any>

export const MAX_SEND_PER_CALL = 40

/** Columns that arrived in later migrations: a missing one is dropped, never fatal. */
const LATE_COLS = ['links', 'reference_urls', 'reference_url', 'post_asap', 'task_id', 'service_id', 'assigned_employee_id', 'caption_canvas', 'scheduled_end_date', 'variants'] as const
const BASE_COLS = ['id', 'calendar_id', 'scheduled_date', 'title', 'content_type', 'platforms', 'caption', 'notes', 'status', 'request_id']

const missingCol = (msg: string | undefined, cols: readonly string[]) =>
  cols.find(c => new RegExp(`'${c}'|\\b${c}\\b`).test(msg || ''))

/** Select items, dropping any late column the database does not have yet. */
async function selectItems(admin: Admin, ids: string[]) {
  let cols: string[] = [...BASE_COLS, ...LATE_COLS]
  for (let i = 0; i <= LATE_COLS.length; i++) {
    const res = await admin.from('social_calendar_items').select(cols.join(', ')).in('id', ids)
    if (!res.error) return { rows: (res.data || []) as any[], cols }
    const col = missingCol(res.error.message, cols.filter(c => (LATE_COLS as readonly string[]).includes(c)))
    if (!col) return { rows: null, cols, error: res.error.message }
    cols = cols.filter(c => c !== col)
  }
  return { rows: null, cols, error: 'Could not read the items.' }
}

/** Why an item may not change; null when it can. */
export function lockedReason(item: { status?: string | null; request_id?: string | null; task_id?: string | null }): string | null {
  if (item.request_id) return 'it is already in Requests'
  if (item.task_id) return 'it is already a task'
  if (item.status && item.status !== 'planned') return `it is ${item.status}`
  return null
}

export interface ItemPatch {
  title?: string
  /** YYYY-MM-DD inside the plan's month, or null to move it to the Idea Board. */
  date?: string | null
  content_type?: string
  platforms?: string[]
  /** Plain text; replaces the caption. */
  caption?: string | null
  /** Replaces the notes for the designer. */
  notes?: string | null
  asap?: boolean
  links?: { label?: string; url: string }[]
  images?: string[]
}

/**
 * The row update for one item, validated by the same rules as adding one.
 * Only the fields given change; the rest of the item stays exactly as it is.
 */
export function buildItemUpdate(current: any, patch: ItemPatch, month: string):
  { ok: true; update: Record<string, unknown> } | { ok: false; error: string } {
  const merged: PlanItemInput = {
    title: patch.title ?? current.title,
    date: patch.date !== undefined ? patch.date : current.scheduled_date,
    content_type: patch.content_type ?? current.content_type,
    platforms: patch.platforms ?? current.platforms ?? [],
    notes: patch.notes !== undefined ? patch.notes : current.notes,
    links: patch.links ?? current.links ?? [],
    images: patch.images ?? current.reference_urls ?? [],
  }
  const clean = cleanPlanItem(merged, month)
  if (!clean.ok) return clean
  const c = clean.item
  const u: Record<string, unknown> = {}
  if (patch.title !== undefined) u.title = c.title
  if (patch.date !== undefined) u.scheduled_date = c.scheduled_date
  if (patch.content_type !== undefined) u.content_type = c.content_type
  if (patch.platforms !== undefined) u.platforms = c.platforms
  if (patch.caption !== undefined) u.caption = captionFromText(patch.caption)
  if (patch.notes !== undefined) u.notes = c.notes
  if (patch.asap !== undefined) u.post_asap = !!patch.asap
  if (patch.links !== undefined) u.links = c.links
  if (patch.images !== undefined) { u.reference_urls = c.reference_urls; u.reference_url = c.reference_url }
  if (!Object.keys(u).length) return { ok: false, error: 'Nothing to change.' }
  u.updated_at = new Date().toISOString()
  return { ok: true, update: u }
}

async function updateRow(admin: Admin, id: string, update: Record<string, unknown>) {
  const u = { ...update }
  for (let i = 0; i <= LATE_COLS.length; i++) {
    const res = await admin.from('social_calendar_items').update(u).eq('id', id).eq('status', 'planned').is('request_id', null).select('id')
    if (!res.error) return { ok: true as const, changed: (res.data || []).length > 0, dropped: Object.keys(update).filter(k => !(k in u)) }
    const col = missingCol(res.error.message, Object.keys(u).filter(k => (LATE_COLS as readonly string[]).includes(k)))
    if (!col) return { ok: false as const, error: res.error.message }
    delete u[col]
  }
  return { ok: false as const, error: 'Could not save the item.' }
}

/** Edit one planned item. */
export async function updatePlanItem(admin: Admin, itemId: string, patch: ItemPatch) {
  const read = await selectItems(admin, [itemId])
  if (!read.rows) return { ok: false as const, error: read.error || 'Could not read the item.' }
  const item = read.rows[0]
  if (!item) return { ok: false as const, error: 'No item with that id.' }
  const why = lockedReason(item)
  if (why) return { ok: false as const, error: `"${item.title}" cannot be edited here: ${why}. Change it in the app.` }
  const { data: cal } = await admin.from('social_calendars').select('id, month, client_id').eq('id', item.calendar_id).maybeSingle()
  if (!cal) return { ok: false as const, error: 'The item’s plan was not found.' }
  const built = buildItemUpdate(item, patch, String((cal as any).month))
  if (!built.ok) return built
  const saved = await updateRow(admin, itemId, built.update)
  if (!saved.ok) return saved
  if (!saved.changed) return { ok: false as const, error: 'The item changed in the app meanwhile (sent or cancelled). Nothing was saved.' }
  return { ok: true as const, id: itemId, title: (built.update.title as string) ?? item.title, changed: Object.keys(built.update).filter(k => k !== 'updated_at'), not_saved: saved.dropped }
}

/** Remove planned items that no work has started on. Others are left and listed. */
export async function removePlanItems(admin: Admin, itemIds: string[]) {
  const read = await selectItems(admin, itemIds)
  if (!read.rows) return { ok: false as const, error: read.error || 'Could not read the items.' }
  const removable = read.rows.filter(r => !lockedReason(r)).map(r => r.id as string)
  const kept = read.rows.filter(r => lockedReason(r)).map(r => ({ id: r.id as string, title: r.title as string, reason: lockedReason(r)! }))
  const unknown = itemIds.filter(id => !read.rows!.some(r => r.id === id))
  let removed: { id: string; title: string }[] = []
  if (removable.length) {
    let q = admin.from('social_calendar_items').delete().in('id', removable).eq('status', 'planned').is('request_id', null)
    if (read.cols.includes('task_id')) q = q.is('task_id', null)
    const { data, error } = await q.select('id, title')
    if (error) return { ok: false as const, error: error.message }
    removed = (data || []) as { id: string; title: string }[]
  }
  return { ok: true as const, removed, kept, unknown }
}

/** The designer's lead time from company settings (days before the post date). */
async function leadDays(admin: Admin): Promise<number> {
  try {
    const { data } = await admin.from('company_settings').select('value').eq('key', 'social_lead_days').maybeSingle()
    return Math.max(0, Math.min(60, parseInt((data as any)?.value ?? '0', 10) || 0))
  } catch { return 0 }
}

const OPEN_REQUEST_STATUSES = ['submitted', 'under_review', 'approved', 'started', 'in_progress', 'waiting_for_content', 'revision_requested']

/** The task_requests row the calendar files for an item (same as the page's push). */
export function requestRowForItem(item: any, cal: { client_id: string; title?: string | null }, lead: number) {
  const refs: string[] = item.reference_urls?.length ? item.reference_urls : (item.reference_url ? [item.reference_url] : [])
  const links = (item.links || []) as { label?: string; url: string }[]
  const brief = normalizeContentBrief({
    contentType: item.content_type,
    caption: item.caption ?? '',
    captionCanvas: sanitizeCaptionCanvas(item.caption_canvas),
    referenceImages: cleanImageUrls(refs),
    notes: item.notes ?? '',
    links: links.map(l => ({ label: l.label ?? '', url: l.url })),
  })
  const description = composeRequestDescription({
    title: item.title, contentType: item.content_type, platforms: item.platforms || [],
    scheduledDate: item.scheduled_date, scheduledEndDate: item.scheduled_end_date,
    caption: item.caption, notes: item.notes, calendarTitle: cal.title ?? undefined, variants: item.variants,
    referenceUrls: refs, captionCanvas: sanitizeCaptionCanvas(item.caption_canvas), links,
  } as any)
  return {
    source: 'manual',
    kind: 'request',
    client_id: cal.client_id,
    title: normalizeTaskTitle(item.title) || item.title,
    description: description || (brief ? contentBriefToText(brief) : '') || null,
    extra_links: brief ? brief.links : cleanBriefLinks(links),
    ...(brief ? { content_brief: brief } : {}),
    is_planned: true,
    service_id: item.service_id || null,
    priority: 'normal',
    due_date: dueDateForPublish(item.scheduled_date, lead),
    assigned_employee_id: item.assigned_employee_id || null,
    status: 'submitted',
    client_status: 'submitted',
    last_staff_viewed_at: new Date().toISOString(),
  } as Record<string, unknown>
}

/** Columns a request can lose on an older database without losing the work. */
const OPTIONAL_REQUEST_COLS = ['priority_rank', 'content_brief', 'kind', 'assigned_employee_id', 'extra_links', 'is_planned']

async function insertRequest(admin: Admin, payload: Record<string, unknown>) {
  const p = { ...payload }
  for (let i = 0; i <= OPTIONAL_REQUEST_COLS.length; i++) {
    const res = await admin.from('task_requests').insert(p).select('id, ref_no').single()
    if (!res.error) return { ok: true as const, id: (res.data as any).id as string, ref_no: (res.data as any).ref_no as number | null }
    const col = missingCol(res.error.message, OPTIONAL_REQUEST_COLS.filter(k => k in p))
    if (!col) return { ok: false as const, error: res.error.message }
    delete p[col]
  }
  return { ok: false as const, error: 'Could not create the request.' }
}

const refLabel = (n: number | null | undefined) => `REQ-${String(n ?? 0).padStart(4, '0')}`

/**
 * Send planned items to the Requests inbox, exactly as the calendar's
 * "Send to Requests" does: one request per item, carrying its brief, the
 * designer's deadline (post date minus the lead time) and its service.
 */
export async function sendPlanItemsToRequests(admin: Admin, itemIds: string[]) {
  const ids = [...new Set(itemIds)].slice(0, MAX_SEND_PER_CALL)
  const read = await selectItems(admin, ids)
  if (!read.rows) return { ok: false as const, error: read.error || 'Could not read the items.' }
  const calIds = [...new Set(read.rows.map(r => r.calendar_id as string))]
  const { data: cals } = await admin.from('social_calendars').select('id, client_id, title').in('id', calIds)
  const calById = new Map(((cals || []) as any[]).map(c => [c.id as string, c]))
  const lead = await leadDays(admin)
  const sent: { id: string; title: string; ref: string }[] = []
  const skipped: { id: string; title: string; reason: string }[] = []
  for (const item of read.rows) {
    const why = lockedReason(item)
    if (why) { skipped.push({ id: item.id, title: item.title, reason: why }); continue }
    const cal = calById.get(item.calendar_id)
    if (!cal) { skipped.push({ id: item.id, title: item.title, reason: 'its plan was not found' }); continue }
    const payload = requestRowForItem(item, cal, lead)
    // Join the end of the client's open queue, like the page does.
    try {
      const { count } = await admin.from('task_requests').select('id', { count: 'exact', head: true })
        .eq('client_id', cal.client_id).in('status', OPEN_REQUEST_STATUSES)
      payload.priority_rank = (count ?? 0) + 1
    } catch { /* optional */ }
    const created = await insertRequest(admin, payload)
    if (!created.ok) { skipped.push({ id: item.id, title: item.title, reason: created.error }); continue }
    // Atomic claim: only one send can link the item.
    const { data: claimed, error: linkErr } = await admin.from('social_calendar_items')
      .update({ request_id: created.id, status: 'requested', updated_at: new Date().toISOString() })
      .eq('id', item.id).is('request_id', null).eq('status', 'planned').select('id')
    if (linkErr || !claimed?.length) {
      await setRequestStatus(admin, created.id, 'cancelled', { type: 'system', label: 'AI connector (rolled back)' })
      skipped.push({ id: item.id, title: item.title, reason: 'it was sent at the same moment from somewhere else' })
      continue
    }
    await logRequestActivity(admin, {
      requestId: created.id, actorType: 'system', actorLabel: 'Cirqle', action: 'submitted',
      visibility: 'client', detail: { title: payload.title },
    })
    try {
      await admin.from('task_requests').update({
        social_meta: buildSocialMeta({
          calendarId: item.calendar_id, itemId: item.id, contentType: item.content_type,
          platforms: item.platforms || [], scheduledDate: item.scheduled_date,
          scheduledEndDate: item.scheduled_end_date, variants: item.variants,
        }),
      }).eq('id', created.id)
    } catch { /* untagged is still good work */ }
    sent.push({ id: item.id, title: item.title, ref: refLabel(created.ref_no) })
  }
  const unknown = ids.filter(id => !read.rows!.some(r => r.id === id))
  return { ok: true as const, sent, skipped, unknown }
}

/** Planned posts in the next `days` days across clients, oldest first. */
export async function upcomingPosts(admin: Admin, p: { from: string; to: string; clientId?: string | null }) {
  let calQ = admin.from('social_calendars').select('id, client_id, month, title, client:clients(name)')
  if (p.clientId) calQ = calQ.eq('client_id', p.clientId)
  const { data: cals, error: calErr } = await calQ.gte('month', `${p.from.slice(0, 7)}-01`).lte('month', `${p.to.slice(0, 7)}-01`)
  if (calErr) return { ok: false as const, error: calErr.message }
  const byId = new Map(((cals || []) as any[]).map(c => [c.id as string, c]))
  if (!byId.size) return { ok: true as const, items: [] as any[] }
  const { data, error } = await admin.from('social_calendar_items')
    .select('id, calendar_id, scheduled_date, title, content_type, platforms, status, request_id')
    .in('calendar_id', [...byId.keys()]).gte('scheduled_date', p.from).lte('scheduled_date', p.to)
    .neq('status', 'cancelled').order('scheduled_date')
  if (error) return { ok: false as const, error: error.message }
  const items = ((data || []) as any[]).map(i => ({
    ...i, client: byId.get(i.calendar_id)?.client?.name ?? null,
    in_requests: !!i.request_id, needs_sending: i.status === 'planned' && !i.request_id,
  }))
  return { ok: true as const, items }
}
