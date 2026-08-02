import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { selectWithOptionalColumns } from '@/lib/offer-columns'
import { loadCurrentUser } from '@/lib/permissions/check'
import RequestsClient from './requests-client'

export const dynamic = 'force-dynamic'

export default async function RequestsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = searchParams ? await searchParams : undefined
  const focusId = typeof sp?.focus === 'string' ? sp.focus : null
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || !!me?.permissions?.has('requests.view')
  if (me && !canView) redirect('/dashboard')

  const admin = createAdminClient()

  // Defensive: portal tables may not exist until the migration runs.
  let requests: any[] = []
  let migrated = true
  try {
    const { data, error } = await admin
      .from('task_requests')
      .select('*, client:clients(id, name, code), agency:agencies(id, name), service:services(id, name), assigned_employee:employees!task_requests_assigned_employee_id_fkey(id, cqid, name), promoted_task:tasks!task_requests_promoted_task_id_fkey(id, task_number, title, status)')
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) migrated = false
    requests = data || []
  } catch { migrated = false }

  // Pickers for the New Request form + employee assignment.
  // drive_folder_link needs the v1.1 patch migration — fall back without it.
  let clientsRes = await admin.from('clients').select('id, name, code, drive_folder_link').order('name')
  if (clientsRes.error && /drive_folder_link/i.test(clientsRes.error.message || '')) {
    clientsRes = await admin.from('clients').select('id, name, code').order('name') as any
  }
  const [employeesRes, servicesRes, pricingRes] = await Promise.all([
    admin.from('employees').select('id, cqid, name').eq('is_active', true).order('cqid'),
    admin.from('services').select('id, name').eq('is_active', true).order('display_order').order('name'),
    // Pipeline-value fallback: client+service price when a request has no
    // staff-entered estimated_value.
    admin.from('client_service_pricing').select('client_id, service_id, price').not('price', 'is', null),
  ])

  // Offer-campaign submissions surface in this same inbox (service-based intake
  // routing — Offer Flyer clients submit via the Offer Intake app). Defensive:
  // offer tables may not exist until that migration runs.
  let offerCampaigns: any[] = []
  try {
    // `source` only exists after the offer-groups migration; asking for it
    // before that would fail the whole query and empty the inbox, so it is
    // requested optionally.
    const data = await selectWithOptionalColumns<any[]>(
      `id, title, status, date_type, offer_date, offer_date_from, offer_date_to,
       sheet_last_synced_at, sheet_sync_error, created_at, updated_at,
       client:clients(id, name),
       products:offer_products(id, name, offer_type, price, mrp, offer_text, image_url, page, badges:offer_product_badges(badge_id, custom_label, color, badge:offer_badges(label))),
       logs:offer_change_logs(id, log_type, product_name, field, old_value, new_value, note, acknowledged, acknowledged_by, acknowledged_at, created_at)`,
      ['source'],
      cols => admin
        .from('offer_campaigns')
        .select(cols)
        .not('status', 'eq', 'archived')
        .order('updated_at', { ascending: false })
        .limit(200),
    )
    offerCampaigns = data || []
  } catch { /* offer intake not set up yet */ }

  const perms = {
    review:   isAdmin || !!me?.permissions?.has('requests.review'),
    start:    isAdmin || !!me?.permissions?.has('requests.start'),
    manage:   isAdmin || !!me?.permissions?.has('requests.manage'),
    activity: isAdmin || !!me?.permissions?.has('requests.activity.view'),
  }

  return (
    <RequestsClient
      migrated={migrated}
      initialRequests={requests}
      perms={perms}
      clients={clientsRes.data || []}
      employees={employeesRes.data || []}
      services={servicesRes.data || []}
      servicePricing={pricingRes.data || []}
      offerCampaigns={offerCampaigns}
      initialFocusId={focusId}
    />
  )
}
