/**
 * Loads the posting queue.
 *
 * Deliberately DERIVED rather than materialised. The obvious alternative —
 * writing a social_posts row the moment a task completes — would need a
 * backfill, would leave orphan drafts behind whenever a client is switched off
 * or an item cancelled, and would silently disagree with the calendar the first
 * time a plan moved. Here the queue is recomputed from the calendar every time,
 * and a social_posts row appears only once she actually writes something.
 *
 * Reads live alongside a possibly-unapplied migration: every column added by
 * 20260828100000 is probed, and its absence degrades the queue rather than
 * breaking the page. Same rule the rest of the codebase follows.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { columnExists } from '@/lib/supabase/server'
import { captionHtmlToText } from '@/lib/social/plan'
import {
  postStageOf, urgencyOf, needsAttention, postChecklist, checklistProgress,
  QUEUE_HIDDEN_ITEM_STATUSES, type PostStage, type UrgencyInfo, type ChecklistItem,
} from './post-queue'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, 'public', any>

export interface QueueEntry {
  /** The calendar item — the queue's stable identity, not the post's. */
  itemId: string
  postId: string | null
  clientId: string
  clientName: string | null
  driveFolderLink: string | null
  title: string
  plannedDate: string
  contentType: string | null
  platforms: string[]
  serviceId: string | null
  serviceName: string | null
  /** Caption planned on the calendar, used to seed the post. */
  plannedCaption: string
  caption: string | null
  hashtags: string | null
  altText: string | null
  firstComment: string | null
  publishedAt: string | null
  postedManually: boolean
  postStatus: string | null
  scheduledAt: string | null
  refNo: string | null
  taskNumber: number | null
  stage: PostStage
  urgency: UrgencyInfo
  attention: boolean
  checklist: ChecklistItem[]
  progress: { done: number; total: number }
}

/**
 * @param today yyyy-mm-dd in the workspace's own timezone. Passed in rather
 *   than read from the clock so urgency is testable and so a server in UTC does
 *   not call a post overdue an evening early.
 */
export async function loadPostQueue(
  admin: Admin,
  today: string,
  opts: { clientId?: string; month?: string } = {},
): Promise<QueueEntry[]> {
  const hasGate = await columnExists(admin as never, 'clients', 'has_social_media_service')

  // ── Which clients do we post for? ────────────────────────────────────────
  // Before the migration lands, fall back to "has a calendar", which is what
  // the gate is backfilled from anyway — so the queue looks the same either
  // way and does not spring into life for poster-only clients on deploy.
  let clientQ = admin.from('clients').select('id, name, drive_folder_link')
  if (hasGate) clientQ = clientQ.eq('has_social_media_service', true)
  const { data: clientRows } = await clientQ
  const clients = new Map<string, Row>((clientRows ?? []).map((c: Row) => [c.id, c]))
  if (clients.size === 0) return []

  // ── Their calendars ──────────────────────────────────────────────────────
  let calQ = admin.from('social_calendars')
    .select('id, client_id, month, status')
    .neq('status', 'archived')
  if (opts.clientId) calQ = calQ.eq('client_id', opts.clientId)
  if (opts.month) calQ = calQ.eq('month', opts.month)
  const { data: cals } = await calQ

  const calById = new Map<string, Row>()
  for (const c of (cals ?? []) as Row[]) {
    if (!clients.has(c.client_id)) continue   // not a client we post for
    calById.set(c.id, c)
  }
  if (calById.size === 0) return []

  // ── The planned items ────────────────────────────────────────────────────
  // task_id needs 20260825120000; retry without it so a pending migration
  // still lists the queue rather than blanking the page.
  let items: Row[] = []
  for (const withTask of [true, false]) {
    const cols = 'id, calendar_id, scheduled_date, title, content_type, platforms, ' +
      'caption, caption_canvas, status, request_id, service_id' +
      (withTask ? ', task_id' : '')
    const { data, error } = await admin.from('social_calendar_items')
      .select(cols)
      .in('calendar_id', [...calById.keys()])
      .order('scheduled_date', { ascending: true })
    if (!error) { items = (data ?? []) as Row[]; break }
  }
  items = items.filter(i => !(QUEUE_HIDDEN_ITEM_STATUSES as readonly string[]).includes(i.status))
  if (items.length === 0) return []

  // ── Everything the stage machine needs, in three parallel reads ──────────
  const reqIds = [...new Set(items.map(i => i.request_id).filter(Boolean))]
  const taskIds = [...new Set(items.map(i => i.task_id).filter(Boolean))]
  const svcIds = [...new Set(items.map(i => i.service_id).filter(Boolean))]
  const itemIds = items.map(i => i.id)

  const hasAltText = await columnExists(admin as never, 'social_posts', 'alt_text')
  const postCols = 'id, calendar_item_id, caption, hashtags, first_comment, status, ' +
    'scheduled_at, published_at, account_id' +
    (hasAltText ? ', alt_text, posted_manually' : '')

  const [reqRes, taskRes, svcRes, postRes] = await Promise.all([
    reqIds.length
      ? admin.from('task_requests').select('id, ref_no, status').in('id', reqIds)
      : Promise.resolve({ data: [] }),
    taskIds.length
      ? admin.from('tasks').select('id, task_number, status, deleted_at').in('id', taskIds)
      : Promise.resolve({ data: [] }),
    svcIds.length
      ? admin.from('services').select('id, name').in('id', svcIds)
      : Promise.resolve({ data: [] }),
    admin.from('social_posts').select(postCols).in('calendar_item_id', itemIds),
  ])

  const reqById = new Map((((reqRes as Row).data ?? []) as Row[]).map(r => [r.id, r]))
  const taskById = new Map((((taskRes as Row).data ?? []) as Row[]).map(t => [t.id, t]))
  const svcById = new Map((((svcRes as Row).data ?? []) as Row[]).map(s => [s.id, s]))
  const postByItem = new Map<string, Row>()
  for (const p of (((postRes as Row).data ?? []) as Row[])) {
    if (p.calendar_item_id) postByItem.set(p.calendar_item_id, p)
  }

  // ── Assemble ─────────────────────────────────────────────────────────────
  const out: QueueEntry[] = []
  for (const it of items) {
    const cal = calById.get(it.calendar_id)
    const client = cal ? clients.get(cal.client_id) : undefined
    if (!client) continue

    const req = it.request_id ? reqById.get(it.request_id) : null
    const rawTask = it.task_id ? taskById.get(it.task_id) : null
    const task = rawTask && !rawTask.deleted_at ? rawTask : null
    const post = postByItem.get(it.id) ?? null

    const creative = { requestStatus: req?.status ?? null, taskStatus: task?.status ?? null }

    // The calendar caption is rich text; the composer wants plain.
    const plannedCaption = captionHtmlToText(it.caption_canvas ?? it.caption ?? '')

    const content = {
      caption: post?.caption ?? null,
      hashtags: post?.hashtags ?? null,
      altText: post?.alt_text ?? null,
      publishedAt: post?.published_at ?? null,
    }

    const stage = postStageOf(creative, content)
    const urgency = urgencyOf(it.scheduled_date, today)
    const checklist = postChecklist(creative, content)

    out.push({
      itemId: it.id,
      postId: post?.id ?? null,
      clientId: client.id,
      clientName: client.name ?? null,
      driveFolderLink: client.drive_folder_link ?? null,
      title: it.title ?? '',
      plannedDate: it.scheduled_date,
      contentType: it.content_type ?? null,
      platforms: Array.isArray(it.platforms) ? it.platforms : [],
      serviceId: it.service_id ?? null,
      serviceName: it.service_id ? (svcById.get(it.service_id)?.name ?? null) : null,
      plannedCaption,
      caption: content.caption,
      hashtags: content.hashtags,
      altText: content.altText,
      firstComment: post?.first_comment ?? null,
      publishedAt: content.publishedAt,
      postedManually: post?.posted_manually === true,
      postStatus: post?.status ?? null,
      scheduledAt: post?.scheduled_at ?? null,
      refNo: req?.ref_no != null ? String(req.ref_no) : null,
      taskNumber: task?.task_number ?? null,
      stage,
      urgency,
      attention: needsAttention(stage, urgency),
      checklist,
      progress: checklistProgress(checklist),
    })
  }

  return out
}
