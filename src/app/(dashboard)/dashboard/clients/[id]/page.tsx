import { redirect, notFound } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import {
  loadServiceScope, isServiceRestricted, scopeRowsByService, scopeServiceList,
} from '@/lib/scope/service-scope'
import ClientDetailClient from './client-detail-client'

export const dynamic = 'force-dynamic'

/** Per-client dashboard — KPIs, invoices, tasks, pricing, contact details. */
export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || me?.permissions.has(PERMS.CLIENTS_VIEW) || !me
  if (me && !canView) redirect('/dashboard')

  const vis = financialVisibility(me)
  const showAmounts = isAdmin || vis.billingAmounts

  const supabase = createAdminClient()

  const { data: client } = await supabase.from('clients').select('*').eq('id', id).maybeSingle()
  if (!client) notFound()

  // Department scoping (C-1). The list page hides out-of-department clients,
  // but this route is directly addressable — without this guard a restricted
  // employee could read any client by URL. notFound (not redirect) so the
  // response doesn't even confirm the client exists.
  //
  // A client with NO active pricing rows is "not configured yet" and stays
  // reachable by everyone; a client whose services don't intersect the
  // viewer's departments 404s.
  const scope = await loadServiceScope(supabase, me, 'global')
  if (isServiceRestricted(scope) && scope.clientServices.has(id) && !scope.visibleClientIds.has(id)) {
    notFound()
  }

  const [invoicesRes, tasksRes, pricingRes, servicesRes, partnerRes, socialRes] = await Promise.all([
    showAmounts
      ? fetchAll(supabase.from('invoices')
          .select('id, invoice_number, status, total_amount, paid_amount, issue_date, due_date, created_at')
          .eq('client_id', id).order('created_at', { ascending: false }))
      : Promise.resolve({ data: [] as any[] }),
    supabase.from('tasks')
      .select('id, task_number, title, status, task_date, service:services(id, name)')
      .eq('client_id', id).is('deleted_at', null)
      .order('task_date', { ascending: false }).limit(400),
    supabase.from('client_service_pricing').select('service_id, price, commission_percentage, currency').eq('client_id', id),
    supabase.from('services').select('id, name, is_active').order('name'),
    client.business_partner_id
      ? supabase.from('business_partners').select('id, name, partner_code').eq('id', client.business_partner_id).maybeSingle()
      : Promise.resolve({ data: null }),
    // Social Hub panel — safe columns only, never the access_token. Degrades to
    // [] when the social_accounts migration has not been applied yet.
    supabase.from('social_accounts')
      .select('id, platform, name, username, profile_picture_url, followers_count, status, last_synced_at')
      .eq('client_id', id).neq('status', 'disconnected')
      .then((r) => r, () => ({ data: [] as any[] })),
  ])
  
  // A multi-department client is VISIBLE but partially rendered: the viewer
  // sees only their departments' slice. Tasks filter by the task's service
  // (tasks with no service stay — unclassified work is visible app-wide);
  // pricing rows for other departments' services are stripped so what the
  // client buys elsewhere isn't disclosed. Invoices are client-level money and
  // stay gated by billing permissions (showAmounts) rather than department.
  const scopedTasks = scopeRowsByService((tasksRes.data || []) as any[], scope, (t: any) => t.service?.id ?? null)
  const scopedPricing = isServiceRestricted(scope)
    ? ((pricingRes.data || []) as any[]).filter((p: any) => scope.serviceIds.has(p.service_id))
    : ((pricingRes.data || []) as any[])

  return (
    <ClientDetailClient
      client={client}
      invoices={(invoicesRes.data || []) as any[]}
      tasks={scopedTasks}
      pricing={scopedPricing}
      services={scopeServiceList((servicesRes.data || []) as any[], scope)}
      partner={partnerRes.data as any}
      showAmounts={showAmounts}
      socialAccounts={(socialRes.data || []) as any[]}
    />
  )
}
