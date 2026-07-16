import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import SocialCalendarClient from './social-calendar-client'

export const dynamic = 'force-dynamic'

/**
 * Social Media Calendar planner. Defensive by design (mirrors requests/
 * advertising pages): if the social_calendar tables haven't been migrated
 * yet, `migrated` flips false and the client shows a run-the-migration
 * notice instead of crashing.
 */
export default async function SocialCalendarPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || hasPermission(me, PERMS.SOCIAL_VIEW)
  if (me && !canView) redirect('/dashboard')

  const sp = searchParams ? await searchParams : undefined
  const requestedCalendarId = typeof sp?.calendar === 'string' ? sp.calendar : null

  const admin = createAdminClient()

  // All plans, newest month first, with just enough embedded item data for
  // the picker's progress counts. Plans are few (one per client per month).
  let calendars: any[] = []
  let migrated = true
  try {
    const { data, error } = await admin
      .from('social_calendars')
      .select(`
        id, client_id, month, title, status, notes, created_at,
        client:clients(id, name, code),
        items:social_calendar_items(id, status, request_id)
      `)
      .order('month', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) migrated = false
    calendars = data || []
  } catch { migrated = false }

  const selectedId =
    (requestedCalendarId && calendars.some(c => c.id === requestedCalendarId))
      ? requestedCalendarId
      : (calendars.find(c => c.status !== 'archived')?.id ?? calendars[0]?.id ?? null)

  // Full items for the selected plan, with the live pipeline join:
  // item → request → promoted task. The calendar displays this chain's
  // status; it never stores it.
  let items: any[] = []
  if (migrated && selectedId) {
    const { data } = await admin
      .from('social_calendar_items')
      .select(`
        id, calendar_id, scheduled_date, title, content_type, platforms,
        caption, notes, status, request_id, created_at,
        request:task_requests!social_calendar_items_request_id_fkey(
          id, ref_no, status, promoted_task_id,
          promoted_task:tasks!task_requests_promoted_task_id_fkey(id, task_number, status)
        )
      `)
      .eq('calendar_id', selectedId)
      .order('scheduled_date', { ascending: true })
      .order('display_order', { ascending: true })
      .order('created_at', { ascending: true })
    items = data || []
  }

  const clients = (await admin
    .from('clients').select('id, name, code').eq('is_active', true).order('name')).data || []

  return (
    <SocialCalendarClient
      migrated={migrated}
      calendars={calendars}
      selectedId={selectedId}
      initialItems={items}
      clients={clients as any[]}
      canManage={isAdmin || hasPermission(me, PERMS.SOCIAL_MANAGE)}
    />
  )
}
