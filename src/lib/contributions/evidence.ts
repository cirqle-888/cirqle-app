/**
 * Contribution evidence — the trail a task leaves before anyone records
 * contributions, read into `ContributionEvidence` for `buildSuggestion`.
 *
 * DESIGN (who made it), strongest first:
 *   4  the assignee moved its My Work card to Sent for Review / Done
 *   3  the request or calendar item it came from is assigned to them
 *   2  they are the task's only assignee
 * PLAN (who planned it):
 *   3  they created the request / added the calendar item (created_by, from
 *      20261004100000 — absent before it, so older work falls through)
 *   2  they own the month's content plan the item sits on
 *
 * Server-only (service role). Every query is chunked and tolerant: a missing
 * column or table yields less evidence, never an error on the page.
 */

import type { createAdminClient } from '@/lib/supabase/server'
import type { ContributionEvidence } from './suggest'

type Admin = ReturnType<typeof createAdminClient>
// Rows from several selects whose columns vary with which migrations have run;
// every read below is null-guarded, so the loose type is deliberate.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

const CHUNK = 200
const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null)
const refOf = (n: number | null | undefined) => (n ? `REQ-${String(n).padStart(4, '0')}` : 'the request')
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
const planName = (cal: Row | null) => {
  if (!cal) return 'the content plan'
  const client = one<Row>(cal.client)?.name
  const month = cal.month ? new Date(`${String(cal.month).slice(0, 7)}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long' }) : ''
  return [client ? `${client}'s` : 'the', month, 'content plan'].filter(Boolean).join(' ')
}

/** Select with `created_by`, retrying without it if the column is not there yet. */
async function selectTolerant(run: (cols: string) => PromiseLike<{ data: Row[] | null; error: { message?: string } | null }>, cols: string, optional: string) {
  const first = await run(`${cols}, ${optional}`)
  if (!first.error) return first.data ?? []
  if (!(first.error.message || '').includes(optional)) return []
  const retry = await run(cols)
  return retry.data ?? []
}

export async function loadContributionEvidence(admin: Admin, taskIds: string[]): Promise<Record<string, ContributionEvidence[]>> {
  const out: Record<string, ContributionEvidence[]> = {}
  if (!taskIds.length) return out
  const add = (taskId: string | null | undefined, e: ContributionEvidence | null) => {
    if (taskId && e?.employeeId) (out[taskId] ||= []).push(e)
  }

  try {
    const requests: Row[] = []
    const items: Row[] = []
    const moves: Row[] = []
    const assigns: Row[] = []
    const calSelect = 'calendar:social_calendars(created_by, month, client:clients(name))'

    for (const ids of chunks(taskIds)) {
      const [reqs, its, mv, as] = await Promise.all([
        selectTolerant(c => admin.from('task_requests').select(c).in('promoted_task_id', ids) as never,
          'id, ref_no, title, source, assigned_employee_id, promoted_task_id', 'created_by'),
        selectTolerant(c => admin.from('social_calendar_items').select(c).in('task_id', ids) as never,
          `id, title, task_id, request_id, assigned_employee_id, ${calSelect}`, 'created_by'),
        admin.from('activity_logs').select('actor_id, entity_id, detail, note, created_at')
          .eq('entity_type', 'task').in('entity_id', ids).like('note', 'My Work:%')
          .order('created_at', { ascending: false }),
        admin.from('task_assignments').select('task_id, employee_id').in('task_id', ids),
      ])
      requests.push(...reqs); items.push(...its)
      moves.push(...(mv.data ?? [])); assigns.push(...(as.data ?? []))
    }

    // Calendar items that went to Requests first: linked by request, not task.
    const reqIds = requests.map(r => r.id)
    for (const ids of chunks(reqIds)) {
      items.push(...await selectTolerant(c => admin.from('social_calendar_items').select(c).in('request_id', ids) as never,
        `id, title, task_id, request_id, assigned_employee_id, ${calSelect}`, 'created_by'))
    }
    const taskOfRequest = new Map(requests.map(r => [r.id, r.promoted_task_id as string]))

    // ── Design ──────────────────────────────────────────────────────────────
    for (const m of moves) {
      const to = m.detail?.to
      if (to !== 'delivered' && to !== 'done') continue
      const what = m.detail?.requestId ? refOf(requests.find(r => r.id === m.detail.requestId)?.ref_no) : 'the plan item'
      add(m.entity_id, {
        employeeId: m.actor_id, role: 'design', strength: 4,
        reason: `${to === 'done' ? 'moved' : 'sent'} ${what} ${to === 'done' ? 'to Done' : 'for review'} on My Work · ${dayOf(m.created_at)}`,
      })
    }
    for (const r of requests) {
      if (r.assigned_employee_id) add(r.promoted_task_id, { employeeId: r.assigned_employee_id, role: 'design', strength: 3, reason: `assigned ${refOf(r.ref_no)}` })
    }
    for (const it of items) {
      const taskId = it.task_id ?? taskOfRequest.get(it.request_id)
      if (it.assigned_employee_id) {
        add(taskId, { employeeId: it.assigned_employee_id, role: 'design', strength: 3, reason: `assigned “${it.title}” on ${planName(one(it.calendar))}` })
      }
    }
    const byTask = new Map<string, string[]>()
    for (const a of assigns) byTask.set(a.task_id, [...(byTask.get(a.task_id) ?? []), a.employee_id])
    for (const [taskId, emps] of byTask) {
      if (emps.length === 1) add(taskId, { employeeId: emps[0], role: 'design', strength: 2, reason: 'the only person assigned to this task' })
    }

    // ── Plan ────────────────────────────────────────────────────────────────
    for (const r of requests) {
      if (r.created_by) add(r.promoted_task_id, { employeeId: r.created_by, role: 'plan', strength: 3, reason: `created ${refOf(r.ref_no)}` })
    }
    for (const it of items) {
      const taskId = it.task_id ?? taskOfRequest.get(it.request_id)
      const cal = one<Row>(it.calendar)
      if (it.created_by) add(taskId, { employeeId: it.created_by, role: 'plan', strength: 3, reason: `planned “${it.title}” on ${planName(cal)}` })
      else if (cal?.created_by) add(taskId, { employeeId: cal.created_by, role: 'plan', strength: 2, reason: `owns ${planName(cal)}` })
    }
  } catch (e) {
    console.error('[contribution-evidence] load failed:', e instanceof Error ? e.message : e)
  }
  return out
}
