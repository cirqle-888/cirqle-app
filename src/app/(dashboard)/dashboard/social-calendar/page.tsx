import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { loadClientMonthProgress } from '@/lib/agreements/server'
import type { AgreementProgressSummary } from '@/lib/agreements/progress'
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
  const canViewAgreements = isAdmin || hasPermission(me, PERMS.AGREEMENTS_VIEW)

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
    // service_id / variants need the 202607170xxxxx patch migrations — fall back without them.
    const ITEM_COLS = `
        id, calendar_id, scheduled_date, title, content_type, platforms,
        caption, notes, status, request_id, created_at,
        request:task_requests!social_calendar_items_request_id_fkey(
          id, ref_no, status, promoted_task_id,
          promoted_task:tasks!task_requests_promoted_task_id_fkey(id, task_number, status)
        )
      `
    // Drop ONLY the column each retry trips on — a pending patch migration
    // must not also hide columns that already exist.
    let extraCols = ['service_id', 'variants', 'reference_url', 'reference_urls', 'scheduled_end_date', 'caption_canvas']
    for (let attempt = 0; attempt <= 6; attempt++) {
      const sel = [...extraCols, ITEM_COLS].join(', ')
      const itemsRes = await admin
        .from('social_calendar_items')
        .select(sel)
        .eq('calendar_id', selectedId)
        .order('scheduled_date', { ascending: true })
        .order('display_order', { ascending: true })
        .order('created_at', { ascending: true })
      if (!itemsRes.error) { items = itemsRes.data || []; break }
      // Match the column NAME the error quotes. A plain substring test would
      // resolve a missing `reference_urls` to `reference_url` and drop the
      // column that exists, hiding every legacy reference image.
      const msg = itemsRes.error.message || ''
      const quoted = [...msg.matchAll(/'([a-z_]+)'/gi)].map(m => m[1])
      const col = extraCols.find(c => quoted.includes(c))
        ?? [...extraCols].sort((a, b) => b.length - a.length).find(c => msg.includes(c))
      if (!col) break
      extraCols = extraCols.filter(c => c !== col)
    }
  }

  const clients = (await admin
    .from('clients').select('id, name, code').eq('is_active', true).order('name')).data || []

  // Services power the item modal's Service picker — the same catalogue the
  // Requests form uses, so calendar items align with request types.
  const services = (await admin
    .from('services').select('id, name').eq('is_active', true)
    .order('display_order').order('name')).data || []

  // Full settings map: the PDF export borrows the invoice template's branding
  // keys (logo, colors, company identity), and the content-type → service
  // defaults live under 'social_content_type_services'.
  let companySettings: Record<string, string> = {}
  let serviceMap: Record<string, string> = {}
  try {
    const { data } = await admin.from('company_settings').select('key, value')
    companySettings = Object.fromEntries((data || []).map((r: { key: string; value: string }) => [r.key, r.value]))
    if (companySettings.social_content_type_services) {
      serviceMap = JSON.parse(companySettings.social_content_type_services)
    }
  } catch { /* unset or malformed — keyword fallback covers it */ }

  // Agreement meter data — a single per-client+month loader (no N+1), and only
  // when the viewer may see agreements at all (otherwise the widget is hidden).
  let agreementProgress: AgreementProgressSummary[] = []
  if (selectedId && canViewAgreements) {
    const cal = calendars.find(c => c.id === selectedId)
    if (cal) {
      try {
        agreementProgress = await loadClientMonthProgress(cal.client_id, cal.month.substring(0, 7))
      } catch (e) {
        console.error('Failed to load agreement progress', e)
      }
    }
  }

  return (
    <SocialCalendarClient
      migrated={migrated}
      calendars={calendars}
      selectedId={selectedId}
      initialItems={items}
      clients={clients as any[]}
      services={services as any[]}
      serviceMap={serviceMap}
      companySettings={companySettings}
      canManage={isAdmin || hasPermission(me, PERMS.SOCIAL_MANAGE)}
      agreementProgress={agreementProgress}
      canViewAgreements={canViewAgreements}
    />
  )
}
