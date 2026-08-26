import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { isHidden } from '@/lib/requests/my-work'
import MyWorkClient from './my-work-client'

export const dynamic = 'force-dynamic'

/**
 * My Work — one person's own queue.
 *
 * Gated on requests.work_own, NOT requests.view: the whole point is that a
 * designer reaches this without the inbox being opened to them. Admins pass
 * via hasPermission's is_admin short-circuit and simply see their own assigned
 * rows (usually none), which is correct — this page is never a management view.
 */
export default async function MyWorkPage() {
  const me = await loadCurrentUser()
  if (!me) redirect('/login')
  if (!hasPermission(me, PERMS.REQUESTS_WORK_OWN)) redirect('/dashboard')

  const admin = createAdminClient()
  let rows: any[] = []
  try {
    const { data } = await admin
      .from('task_requests')
      .select('id, ref_no, title, description, status, due_date, priority, created_at, ' +
        'client:clients(name), service:services(name), ' +
        'promoted_task:tasks!task_requests_promoted_task_id_fkey(task_number)')
      .eq('assigned_employee_id', me.employeeId)
      .order('due_date', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
    rows = (data || []).filter((r: any) => !isHidden(r.status)).map((r: any) => {
      const c = Array.isArray(r.client) ? r.client[0] : r.client
      const s = Array.isArray(r.service) ? r.service[0] : r.service
      const t = Array.isArray(r.promoted_task) ? r.promoted_task[0] : r.promoted_task
      return {
        id: r.id, ref_no: r.ref_no, title: r.title, description: r.description,
        status: r.status, due_date: r.due_date, priority: r.priority,
        created_at: r.created_at,
        client_name: c?.name ?? null,
        service_name: s?.name ?? null,
        task_number: t?.task_number ?? null,
      }
    })
  } catch { /* portal tables not migrated — render the empty state */ }

  return <MyWorkClient initialRows={rows} firstName={(me.name || '').split(' ')[0] || 'there'} />
}
