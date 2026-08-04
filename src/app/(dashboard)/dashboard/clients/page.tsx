import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import {
  loadServiceScope, markUnconfiguredClients, isServiceRestricted,
  scopeClientList, scopeServiceList, scopeRowsByService,
} from '@/lib/scope/service-scope'
import ClientsClient from './clients-client'

export const dynamic = 'force-dynamic'

/**
 * Clients module — first-class client management (list + per-client dashboard),
 * following the Business Partners module pattern. Gated by `clients.view`
 * (admins bypass pre-migration, so the page works before the permission row
 * is applied).
 */
export default async function ClientsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || me?.permissions.has(PERMS.CLIENTS_VIEW) || !me
  if (me && !canView) redirect('/dashboard')

  const vis = financialVisibility(me)
  // Outstanding/billed figures are money — same gate the invoices module uses.
  const showAmounts = isAdmin || vis.billingAmounts

  const supabase = createAdminClient()

  // Department scoping (C-1) — resolved ONCE per request via the shared engine.
  // 'all' for admins / scope.view_all, 'services' for department-restricted
  // designations, 'legacy' (identical to today) for everyone else.
  const scope = await loadServiceScope(supabase, me, 'global')

  const [clientsRes, invoicesRes, tasksRes, pricingRes, servicesRes] = await Promise.all([
    fetchAll(supabase.from('clients')
      .select('id, name, code, contact_name, email, phone, country, default_currency, is_active, pricing_pending, business_partner_id, created_at')
      .order('name')),
    // Minimal columns — only what the outstanding rollup needs.
    showAmounts
      ? fetchAll(supabase.from('invoices').select('client_id, total_amount, paid_amount, status'))
      : Promise.resolve({ data: [] as any[] }),
    // service_id so the task rollups can be filtered to the viewer's
    // departments — otherwise the counts leak cross-department volume.
    fetchAll(supabase.from('tasks').select('client_id, service_id, status').is('deleted_at', null)),
    // Canonical commitment predicate — without is_active the "services" stat
    // counts services the client no longer buys.
    fetchAll(supabase.from('client_service_pricing').select('client_id, service_id').eq('is_active', true)),
    supabase.from('services').select('id, name, category_id').eq('is_active', true),
  ])

  // Departments for the "group by department" view. Graceful pre-migration.
  let departments: any[] = []
  {
    const { data } = await supabase
      .from('service_categories')
      .select('id, name, color, display_order')
      .eq('is_active', true)
      .order('display_order')
    departments = data || []
  }

  // Clients with no pricing rows are "not configured yet", not "buys nothing" —
  // they stay visible to everyone so they can be found and configured.
  markUnconfiguredClients(scope, ((clientsRes.data || []) as any[]).map(c => c.id))
  const visibleClients = scopeClientList((clientsRes.data || []) as any[], scope)

  // Rollup inputs filtered per-department for restricted viewers, so a Social
  // Media exec's task counts reflect social work only. Tasks with no service
  // stay counted (unclassified work is visible everywhere in the app).
  const scopedTasks = scopeRowsByService((tasksRes.data || []) as any[], scope, t => t.service_id)
  const scopedPricing = isServiceRestricted(scope)
    ? ((pricingRes.data || []) as any[]).filter(p => scope.serviceIds.has(p.service_id))
    : ((pricingRes.data || []) as any[])

  // Per-client rollups computed server-side so the client component stays lean.
  const stats: Record<string, { billed: number; paid: number; outstanding: number; invoices: number; tasks: number; activeTasks: number; services: number }> = {}
  const ensure = (id: string) => (stats[id] ||= { billed: 0, paid: 0, outstanding: 0, invoices: 0, tasks: 0, activeTasks: 0, services: 0 })
  for (const inv of (invoicesRes.data || []) as any[]) {
    if (!inv.client_id || inv.status === 'draft') continue
    const s = ensure(inv.client_id)
    s.billed += inv.total_amount || 0
    s.paid += inv.paid_amount || 0
    s.invoices += 1
  }
  for (const s of Object.values(stats)) s.outstanding = Math.max(0, s.billed - s.paid)
  for (const t of scopedTasks) {
    if (!t.client_id) continue
    const s = ensure(t.client_id)
    s.tasks += 1
    if (['pending', 'in_progress'].includes(t.status)) s.activeTasks += 1
  }
  for (const p of scopedPricing) {
    if (p.client_id) ensure(p.client_id).services += 1
  }

  // Client → departments, DERIVED from what the client buys (never stored —
  // the frozen architecture rule). Built from scopedPricing, so a restricted
  // viewer's grouping shows only their own departments' membership.
  const serviceDept = new Map<string, string | null>(
    ((servicesRes.data || []) as any[]).map(s => [s.id, s.category_id ?? null]),
  )
  const clientDepartments: Record<string, string[]> = {}
  for (const p of scopedPricing) {
    if (!p.client_id) continue
    const dept = serviceDept.get(p.service_id)
    if (!dept) continue
    const list = (clientDepartments[p.client_id] ||= [])
    if (!list.includes(dept)) list.push(dept)
  }

  return (
    <ClientsClient
      clients={visibleClients}
      stats={stats}
      services={scopeServiceList((servicesRes.data || []) as any[], scope)}
      departments={departments}
      clientDepartments={clientDepartments}
      showAmounts={showAmounts}
      canCreate={isAdmin || hasPermission(me, PERMS.CLIENTS_CREATE) || hasPermission(me, PERMS.SETTINGS_ACCESS)}
      canEdit={isAdmin || hasPermission(me, PERMS.SETTINGS_ACCESS)}
    />
  )
}
