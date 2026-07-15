import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
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
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has(PERMS.CLIENTS_VIEW) || !me
  if (me && !canView) redirect('/dashboard')

  const vis = financialVisibility(me)
  // Outstanding/billed figures are money — same gate the invoices module uses.
  const showAmounts = isAdmin || vis.billingAmounts

  const supabase = createAdminClient()

  const [clientsRes, invoicesRes, tasksRes, pricingRes, servicesRes] = await Promise.all([
    fetchAll(supabase.from('clients')
      .select('id, name, code, contact_name, email, phone, country, default_currency, is_active, pricing_pending, business_partner_id, created_at')
      .order('name')),
    // Minimal columns — only what the outstanding rollup needs.
    showAmounts
      ? fetchAll(supabase.from('invoices').select('client_id, total_amount, paid_amount, status'))
      : Promise.resolve({ data: [] as any[] }),
    fetchAll(supabase.from('tasks').select('client_id, status').is('deleted_at', null)),
    fetchAll(supabase.from('client_service_pricing').select('client_id, service_id')),
    supabase.from('services').select('id, name').eq('is_active', true),
  ])

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
  for (const t of (tasksRes.data || []) as any[]) {
    if (!t.client_id) continue
    const s = ensure(t.client_id)
    s.tasks += 1
    if (['pending', 'in_progress'].includes(t.status)) s.activeTasks += 1
  }
  for (const p of (pricingRes.data || []) as any[]) {
    if (p.client_id) ensure(p.client_id).services += 1
  }

  return (
    <ClientsClient
      clients={(clientsRes.data || []) as any[]}
      stats={stats}
      services={(servicesRes.data || []) as any[]}
      showAmounts={showAmounts}
      canCreate={isAdmin || hasPermission(me, PERMS.CLIENTS_CREATE) || hasPermission(me, PERMS.SETTINGS_ACCESS)}
      canEdit={isAdmin || hasPermission(me, PERMS.SETTINGS_ACCESS)}
    />
  )
}
