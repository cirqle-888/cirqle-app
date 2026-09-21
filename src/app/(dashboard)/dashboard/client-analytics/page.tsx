import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { userCanSee } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import { todayISO } from '@/lib/utils/local-date'
import ClientAnalyticsClient from './client-analytics-client'

/**
 * Client Analytics — one client's work and money over time, against the
 * period before it.
 *
 * WHY THIS IS A LIVE QUERY AND NOT THE CACHED AGGREGATES. The analytics cache
 * (src/lib/analytics/cache.ts) keeps per-client totals per MONTH, but its day
 * totals carry no client split on purpose. Week and month comparisons need
 * daily buckets, so the cache cannot answer them per client. What it CAN do
 * is not needed here either: this query is already small. The cache exists
 * because the dashboard reads 36 months of joined task rows for everybody —
 * 634 KB. Five columns of 24 months, with the client and service joins
 * dropped, is a fraction of that, and it buys exact daily resolution.
 *
 * 24 months because the longest comparison offered is this year against last,
 * and nothing on this page reaches further back than 1 January of last year.
 *
 * The page only GATHERS. Every figure is bucketed client-side by
 * src/lib/analytics/client-series.ts, which resolves its periods with the
 * same finance-engine helpers the company graph uses, so a quarter here and a
 * quarter on the dashboard can never mean two different date ranges.
 */
export const dynamic = 'force-dynamic'

export default async function ClientAnalyticsPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  // Client money, so it rides the permission that already means exactly that
  // — the same gate as Client Profitability — rather than a new key nobody
  // has been granted yet.
  if (!(isAdmin || userCanSee(me, PERMS.REPORTS_VIEW_CLIENT_FINANCIALS))) redirect('/dashboard')

  const admin = createAdminClient()
  const today = todayISO()
  const fromDate = `${Number(today.slice(0, 4)) - 1}-01-01`

  const [clientsRes, tasksRes] = await Promise.all([
    fetchAll(admin.from('clients').select('id, name, is_active').order('name')),
    // Cancelled work never happened and deleted work is not done work — the
    // same two filters every money engine applies. Without them this page
    // would read higher than the dashboard for the same month.
    fetchAll(admin
      .from('tasks')
      .select('client_id, task_date, billing_amount_inr, quantity, is_billable')
      .not('status', 'eq', 'cancelled')
      .is('deleted_at', null)
      .gte('task_date', fromDate)
      .order('task_date', { ascending: true })),
  ])

  type ClientRow = { id: string; name: string; is_active: boolean | null }
  type TaskRow = {
    client_id: string | null; task_date: string | null
    billing_amount_inr: number | null; quantity: number | null; is_billable: boolean | null
  }

  const points = ((tasksRes.data || []) as TaskRow[]).map(t => ({
    clientId: t.client_id,
    date: t.task_date,
    valueInr: Number(t.billing_amount_inr) || 0,
    billable: t.is_billable !== false,
    quantity: Number(t.quantity) || 0,
  }))

  return (
    <ClientAnalyticsClient
      today={today}
      clients={((clientsRes.data || []) as ClientRow[]).map(c => ({
        id: c.id, name: c.name, isActive: c.is_active !== false,
      }))}
      points={points}
    />
  )
}
