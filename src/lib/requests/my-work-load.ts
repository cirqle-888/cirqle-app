import type { SupabaseClient } from '@supabase/supabase-js'
import { isHidden } from '@/lib/requests/my-work'
import { captionHtmlToText } from '@/lib/social/plan'

/**
 * The one query pair behind My Work, shared by the page (server component) and
 * the refresh action so the two can never disagree about what "my work" means.
 *
 * TWO SOURCES, ONE QUEUE. A designer is handed work in two shapes — a request
 * from the inbox, and a piece planned straight onto the social calendar — and
 * being made to watch two screens for one job is exactly the repetition this
 * page exists to remove. They are merged here, not in the UI, so counts,
 * filters and the board all see the same list.
 *
 * Plan items are included ONLY while they still belong to the designer alone:
 * once an item is pushed to Requests it becomes a task_request and is already
 * covered by the first query, so including it again would show one job twice.
 */
/** A PostgREST row from a string-built select — shape known, generated types
 *  cannot express it. Narrow index signature instead of `any`, so the fields
 *  are still readable without switching off type-checking entirely. */
type Row = Record<string, unknown> & { [k: string]: any }   // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RawMyWorkRow {
  id: string
  source: 'request' | 'plan'
  ref_no: number | null
  title: string
  description: string | null
  status: string
  due_date: string | null
  priority: string | null
  created_at: string
  client_name: string | null
  service_name: string | null
  task_number: number | null
}

export async function loadMyWork(
  admin: SupabaseClient,
  employeeId: string,
): Promise<RawMyWorkRow[]> {
  const rows: RawMyWorkRow[] = []

  // ── Requests assigned to them ──────────────────────────────────────────────
  try {
    const { data } = await admin
      .from('task_requests')
      .select('id, ref_no, title, description, status, due_date, priority, created_at, ' +
        'client:clients(name), service:services(name), ' +
        'promoted_task:tasks!task_requests_promoted_task_id_fkey(task_number)')
      .eq('assigned_employee_id', employeeId)
      .order('due_date', { ascending: true, nullsFirst: false })
    for (const r of (data ?? []) as unknown as Row[]) {
      if (isHidden(r.status)) continue
      const c = Array.isArray(r.client) ? r.client[0] : r.client
      const s = Array.isArray(r.service) ? r.service[0] : r.service
      const t = Array.isArray(r.promoted_task) ? r.promoted_task[0] : r.promoted_task
      rows.push({
        id: r.id, source: 'request', ref_no: r.ref_no, title: r.title,
        description: r.description, status: r.status, due_date: r.due_date,
        priority: r.priority, created_at: r.created_at,
        client_name: c?.name ?? null, service_name: s?.name ?? null,
        task_number: t?.task_number ?? null,
      })
    }
  } catch { /* portal not migrated */ }

  // ── Calendar items where they are the designer ─────────────────────────────
  // task_id needs 20260825120000; retry without it so a pending migration
  // still lists planned work rather than blanking half the board.
  for (const withTask of [true, false]) {
    try {
      const cols = 'id, title, caption, notes, scheduled_date, created_at, status, request_id, ' +
        'service:services(name), calendar:social_calendars!inner(client_id, status, client:clients(name))' +
        (withTask ? ', task_id, task:tasks!social_calendar_items_task_id_fkey(task_number, status, deleted_at)' : '')
      const { data, error } = await admin
        .from('social_calendar_items')
        .select(cols)
        .eq('assigned_employee_id', employeeId)
        .neq('status', 'cancelled')
        .is('request_id', null)          // pushed items arrive via the query above
        .neq('calendar.status', 'archived')
        .order('scheduled_date', { ascending: true, nullsFirst: false })
      if (error) { if (withTask) continue; break }
      for (const it of (data ?? []) as unknown as Row[]) {
        const cal = Array.isArray(it.calendar) ? it.calendar[0] : it.calendar
        const cl = cal ? (Array.isArray(cal.client) ? cal.client[0] : cal.client) : null
        const s = Array.isArray(it.service) ? it.service[0] : it.service
        const task = Array.isArray(it.task) ? it.task[0] : it.task
        const live = task && !task.deleted_at ? task : null
        // The calendar caption is RICH TEXT — it comes out as
        // "Fragrance,<br><b>Golden Glow</b>". My Work renders the brief as
        // plain text (deliberately: a designer's card is not a place to
        // execute stored markup), so it is flattened here rather than shown
        // with its tags visible.
        const caption = captionHtmlToText(it.caption).trim()
        rows.push({
          id: it.id, source: 'plan', ref_no: null, title: it.title,
          description: caption || it.notes || null,
          // No status of its own — the linked task's, or none at all.
          status: live?.status ?? '',
          due_date: it.scheduled_date, priority: null, created_at: it.created_at,
          client_name: cl?.name ?? null, service_name: s?.name ?? null,
          task_number: live?.task_number ?? null,
        })
      }
      break
    } catch { break }
  }

  // Soonest first across BOTH sources; undated work sinks to the bottom.
  rows.sort((a, b) => (a.due_date ?? '9999-12-31').localeCompare(b.due_date ?? '9999-12-31'))
  return rows
}
