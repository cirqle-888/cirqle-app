import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
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
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || !!me?.permissions?.has('requests.view')
  if (me && !canView) redirect('/dashboard')

  const admin = createAdminClient()

  // Defensive: portal tables may not exist until the migration runs.
  let requests: any[] = []
  let migrated = true
  try {
    const { data, error } = await admin
      .from('task_requests')
      .select('*, client:clients(id, name, code), agency:agencies(id, name), service:services(id, name), assigned_employee:employees!task_requests_assigned_employee_id_fkey(id, name), promoted_task:tasks!task_requests_promoted_task_id_fkey(id, task_number, title, status)')
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
      initialFocusId={focusId}
    />
  )
}
