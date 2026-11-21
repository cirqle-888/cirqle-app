/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * "Posted work is done": the autopilot looks at what is live on each
 * client's connected Instagram / Facebook (social_media_items, filled by the
 * daily Meta sync) and closes the planned posts that went out.
 *
 * For each planned post that went to Requests and is now live:
 *   - no task yet       → a task is made for it (priced from the Pricing
 *                         Matrix, put in the client's package if one covers
 *                         it, the request's designer assigned) and marked done
 *   - task not finished → the task is marked done
 *   - task already done → the request is brought in line (it was left open)
 * Marking done runs the Tasks page's own follow-ups (draft invoice, derived
 * billing, the request and the client's tracking page). Nothing is sent to
 * clients beyond what marking a task done already sends.
 *
 * It also tidies requests whose task was finished but whose status stayed
 * open, and lists planned posts that are past their window with nothing live,
 * so a person can look.
 *
 * Safe to re-run: a request is linked to a task only while it has none, and a
 * finished task is never touched again.
 */
import type { Admin } from '@/lib/mcp/shared'
import { fetchAll } from '@/lib/supabase/server'
import { toISODate } from '@/lib/utils/local-date'
import { setTaskStatus } from '@/lib/mcp/ops-actions'
import { syncRequestStatusFromTask } from '@/lib/requests/task-sync'
import { logRequestActivity } from '@/lib/requests/core'
import { autoLinkTaskPackage } from '@/lib/packages/auto-link'
import { logActivity } from '@/lib/activity/log'
import { notifyAdmins } from '@/lib/notifications/create'
import { addDays } from './social-rules'
import {
  actionFor, liveKind, LOOKBACK_DAYS, matchPosted, MATCH_BEFORE, notSeenLive,
  type LivePost, type PlannedPost,
} from './posted-rules'

const ACTOR = 'Autopilot'
const CLOSED_REQUEST = ['completed', 'cancelled', 'rejected', 'archived']
const refOf = (n: number | null) => `REQ-${String(n ?? 0).padStart(4, '0')}`

interface ReqRow {
  id: string; ref_no: number | null; title: string; status: string; client_id: string | null
  service_id: string | null; description: string | null; assigned_employee_id: string | null
  promoted_task_id: string | null
}
interface TaskRow { id: string; task_number: number; status: string; deleted_at: string | null }

/** Make the request's task (pending, priced, linked); null when someone linked one meanwhile. */
async function createTaskForRequest(admin: Admin, req: ReqRow, day: string, permalink: string | null): Promise<TaskRow | null> {
  let task: TaskRow | null = null
  // task_number is max + 1 under a unique index: retry when another task took the number.
  for (let attempt = 0; attempt < 5 && !task; attempt++) {
    const { data: maxRow } = await admin.from('tasks').select('task_number')
      .order('task_number', { ascending: false, nullsFirst: false }).limit(1).maybeSingle()
    const candidate = (((maxRow as any)?.task_number as number | undefined) ?? 0) + 1 + attempt
    const { data, error } = await admin.from('tasks').insert({
      task_number: candidate,
      title: req.title,
      description: [req.description, permalink ? `Posted: ${permalink}` : null].filter(Boolean).join('\n\n') || null,
      client_id: req.client_id,
      service_id: req.service_id,
      status: 'pending',
      task_date: day,
      quantity: 1,
      billing_amount: 0,
      billing_amount_inr: 0,
    }).select('id, task_number, status, deleted_at').single()
    if (!error) { task = data as TaskRow; break }
    if ((error as { code?: string }).code !== '23505') throw new Error(`task for ${refOf(req.ref_no)}: ${error.message}`)
  }
  if (!task) throw new Error(`task for ${refOf(req.ref_no)}: no free task number`)

  // Linked only while the request still has no live task (none, or the deleted
  // one read above); otherwise someone linked one meanwhile and this is a duplicate.
  const now = new Date().toISOString()
  const link = admin.from('task_requests')
    .update({ promoted_task_id: task.id, promoted_at: now, updated_at: now })
    .eq('id', req.id)
  const { data: linked } = await (req.promoted_task_id ? link.eq('promoted_task_id', req.promoted_task_id) : link.is('promoted_task_id', null)).select('id')
  if (!linked?.length) {
    await admin.from('tasks').update({ deleted_at: now }).eq('id', task.id)
    return null
  }

  try {
    // Loaded on demand, as the WhatsApp flyer desk does: the Tasks actions pull in most of the app.
    const { serverFillTaskBilling } = await import('@/app/(dashboard)/dashboard/tasks/actions')
    await serverFillTaskBilling(task.id, req.client_id, req.service_id, 1)
  } catch (err) {
    console.warn('[autopilot posted] task left unpriced:', err)
  }
  await autoLinkTaskPackage(admin as never, task.id)
  if (req.assigned_employee_id) {
    await admin.from('task_assignments').insert({ task_id: task.id, employee_id: req.assigned_employee_id }).then(() => {}, () => {})
  }
  await logRequestActivity(admin as never, {
    requestId: req.id, actorType: 'system', actorLabel: ACTOR, action: 'promoted', visibility: 'internal',
    detail: { task_id: task.id, task_number: task.task_number, via: 'live post', permalink },
  })
  void logActivity({
    actorId: null, entityType: 'task', entityId: task.id, action: 'created', category: 'crm', clientId: req.client_id,
    detail: { label: 'Made by the autopilot: the post is live', requestId: req.id, refNo: req.ref_no, permalink },
  })
  return task
}

export async function markPostedJob(admin: Admin, today: string) {
  const from = addDays(today, -LOOKBACK_DAYS)

  // Clients with a connected page or account: only their posts can be checked.
  const accRes = await admin.from('social_accounts').select('id, client_id, status').not('client_id', 'is', null)
  if (accRes.error) return { ok: false as const, error: `accounts: ${accRes.error.message}` }
  const accounts = ((accRes.data || []) as any[]).filter(a => a.status !== 'disconnected')
  const accClient = new Map(accounts.map(a => [a.id as string, a.client_id as string]))
  const connected = new Set(accounts.map(a => a.client_id as string))

  // Planned posts that went to Requests, by planned date.
  const itemsRes = await fetchAll(admin.from('social_calendar_items')
    .select('id, calendar_id, scheduled_date, content_type, request_id, status')
    .not('request_id', 'is', null).neq('status', 'cancelled')
    .gte('scheduled_date', from).lte('scheduled_date', addDays(today, MATCH_BEFORE)))
  if (itemsRes.error) return { ok: false as const, error: `posts: ${itemsRes.error.message ?? itemsRes.error}` }
  const items = (itemsRes.data || []) as any[]
  const reqIds = [...new Set(items.map(i => i.request_id as string))]

  const reqs: ReqRow[] = []
  for (let i = 0; i < reqIds.length; i += 200) {
    const { data, error } = await admin.from('task_requests')
      .select('id, ref_no, title, status, client_id, service_id, description, assigned_employee_id, promoted_task_id')
      .in('id', reqIds.slice(i, i + 200))
    if (error) return { ok: false as const, error: `requests: ${error.message}` }
    reqs.push(...((data || []) as ReqRow[]))
  }
  const reqById = new Map(reqs.map(r => [r.id, r]))

  // Every open request whose task is already finished (planned or not): the status stayed behind.
  const { data: openReqs, error: openErr } = await admin.from('task_requests')
    .select('id, ref_no, promoted_task_id').not('promoted_task_id', 'is', null)
    .not('status', 'in', `(${CLOSED_REQUEST.join(',')})`).limit(1000)
  if (openErr) return { ok: false as const, error: `open requests: ${openErr.message}` }
  const taskIds = [...new Set([
    ...reqs.map(r => r.promoted_task_id).filter(Boolean) as string[],
    ...((openReqs || []) as any[]).map(r => r.promoted_task_id as string),
  ])]
  const taskById = new Map<string, TaskRow>()
  for (let i = 0; i < taskIds.length; i += 200) {
    const { data, error } = await admin.from('tasks').select('id, task_number, status, deleted_at').in('id', taskIds.slice(i, i + 200))
    if (error) return { ok: false as const, error: `tasks: ${error.message}` }
    for (const t of (data || []) as TaskRow[]) taskById.set(t.id, t)
  }

  const synced: string[] = []
  for (const r of (openReqs || []) as any[]) {
    const t = taskById.get(r.promoted_task_id)
    if (!t || t.deleted_at || !['done', 'invoiced', 'paid', 'cancelled'].includes(t.status)) continue
    await syncRequestStatusFromTask(t.id, t.status)
    synced.push(refOf(r.ref_no))
  }
  const syncedSet = new Set(synced)

  // What is live, a day before the oldest planned date up to today.
  let live: LivePost[] = []
  if (accClient.size) {
    const media = await fetchAll(admin.from('social_media_items')
      .select('id, account_id, posted_at, permalink, media_product_type, media_type, is_story')
      .in('account_id', [...accClient.keys()])
      .gte('posted_at', `${addDays(from, -1)}T00:00:00+05:30`).lte('posted_at', `${today}T23:59:59+05:30`))
    if (media.error) return { ok: false as const, error: `live posts: ${media.error.message ?? media.error}` }
    live = ((media.data || []) as any[]).filter(m => m.posted_at && m.media_product_type !== 'AD').map(m => ({
      id: m.id, clientId: accClient.get(m.account_id)!, day: toISODate(new Date(m.posted_at)),
      kind: liveKind(m), permalink: m.permalink ?? null,
    }))
  }

  const planned: PlannedPost[] = []
  for (const it of items) {
    const r = reqById.get(it.request_id)
    if (!r?.client_id || !connected.has(r.client_id)) continue
    planned.push({
      requestId: r.id, ref: refOf(r.ref_no), clientId: r.client_id, date: it.scheduled_date,
      contentType: it.content_type ?? null,
      closed: CLOSED_REQUEST.includes(r.status) || syncedSet.has(refOf(r.ref_no)),
    })
  }

  const matches = matchPosted(planned, live)
  const done: { ref: string; task: number; made: boolean; link: string | null }[] = []
  const problems: string[] = []
  for (const m of matches) {
    const req = reqById.get(m.requestId)!
    const task = req.promoted_task_id ? taskById.get(req.promoted_task_id) ?? null : null
    try {
      switch (actionFor(task)) {
        case 'create_done_task': {
          const made = await createTaskForRequest(admin, req, m.post.day, m.post.permalink)
          if (!made) break
          const r = await setTaskStatus(admin, made.task_number, 'done')
          if (!r.ok) { problems.push(`${m.ref}: ${r.error}`); break }
          done.push({ ref: m.ref, task: made.task_number, made: true, link: m.post.permalink })
          break
        }
        case 'mark_task_done': {
          const r = await setTaskStatus(admin, task!.task_number, 'done')
          if (!r.ok) { problems.push(`${m.ref}: ${r.error}`); break }
          done.push({ ref: m.ref, task: task!.task_number, made: false, link: m.post.permalink })
          break
        }
        case 'sync_request':
          await syncRequestStatusFromTask(task!.id, task!.status)
          synced.push(m.ref)
          break
        default:
          break
      }
    } catch (e) {
      problems.push(`${m.ref}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const matched = new Set(matches.map(m => m.requestId))
  const missing = notSeenLive(planned, matched, connected, today).map(p => ({ ref: p.ref, date: p.date }))
  const notConnected = [...new Set(items.map(i => reqById.get(i.request_id)?.client_id).filter(c => c && !connected.has(c)))].length

  if (done.length || synced.length) {
    const made = done.filter(d => d.made).length
    await notifyAdmins({
      type: 'autopilot_posted_done',
      title: `Autopilot closed ${done.length + synced.length} request${done.length + synced.length === 1 ? '' : 's'}: the posts are live`,
      message: [
        done.length && `Marked done: ${done.slice(0, 8).map(d => `${d.ref} (task #${d.task}${d.made ? ', new' : ''})`).join(', ')}`,
        made && `${made} new task${made === 1 ? '' : 's'} made and priced; they are on this month's draft invoices.`,
        synced.length && `Already done, request closed: ${synced.slice(0, 8).join(', ')}`,
      ].filter(Boolean).join(' · '),
      link: '/dashboard/requests',
      sourceKey: `autopilot_posted_done:${today}`,
    })
  }
  if (missing.length) {
    await notifyAdmins({
      type: 'autopilot_posted_missing',
      title: `${missing.length} planned post${missing.length === 1 ? ' is' : 's are'} past date and not live`,
      message: missing.slice(0, 8).map(m => `${m.ref} (${m.date})`).join(', ') +
        '. Posted somewhere the app cannot see, or not posted yet: mark them done or cancel them in Requests.',
      link: '/dashboard/requests',
      sourceKey: `autopilot_posted_missing:${today}`,
    })
  }

  return {
    ok: problems.length === 0,
    ...(problems.length ? { error: problems.slice(0, 5).join('; ') } : {}),
    done, synced, missing, livePostsChecked: live.length, clientsNotConnected: notConnected,
  }
}
