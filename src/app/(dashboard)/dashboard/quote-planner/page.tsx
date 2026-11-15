import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAll, fetchAllParallel } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { userCanSee } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import QuotePlannerClient from './quote-planner-client'

/**
 * Quote Planner — price a proposal and see what it does to everyone's numbers.
 *
 * This page only GATHERS. Every figure on screen is computed client-side by
 * `src/lib/quote-planner/compute.ts`, which calls the real commission engine,
 * so a number here can never drift from what payroll would actually do.
 */
export const dynamic = 'force-dynamic'

export default async function QuotePlannerPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (!(isAdmin || userCanSee(me, PERMS.QUOTE_PLANNER_VIEW))) redirect('/dashboard')
  const canManage = isAdmin || userCanSee(me, PERMS.QUOTE_PLANNER_MANAGE)

  const admin = createAdminClient()

  const [clients, services, groups, parameters, employees, pricings, rates, plans, scores, tasks] =
    await Promise.all([
      fetchAll(admin.from('clients').select('id, name, default_currency').eq('is_active', true).order('name')),
      fetchAll(admin.from('services').select('id, name, default_price, pricing_type').eq('is_active', true).order('name')),
      fetchAll(admin.from('contribution_groups').select('id, name, weight, is_active, display_order').eq('is_active', true).order('display_order')),
      fetchAll(admin.from('parameters').select('id, group_id, name, weight, is_active, display_order, input_type').eq('is_active', true).order('display_order')),
      // CQID only — a name must never reach the browser for this page.
      fetchAll(admin.from('employees').select('id, cqid, performance_rating').eq('is_active', true).order('cqid')),
      // NOT filtered by is_active: a plan may reference a service whose row was
      // archived, and the price it was quoted at is still the right one to show.
      fetchAll(admin.from('client_service_pricing').select('client_id, service_id, price, currency, commission_percentage')),
      fetchAll(admin.from('exchange_rates').select('currency, rate_to_inr')),
      fetchAll(admin.from('quote_plans').select('id, name, client_id, status, currency, term_months, updated_at').is('deleted_at', null).order('updated_at', { ascending: false })),
      // Historical shares: what each employee actually averaged, per service.
      //
      // The two big reads on this page — 5,683 score rows and ~2,100 tasks on
      // 15 Nov 2026, six pages and three. fetchAll asked for them one page
      // after another (the six alone were ~2.3 s from a laptop); these ask for
      // every page together. Ordered by id, which paging needs to be stable
      // and which the unordered reads before this never guaranteed.
      fetchAllParallel(() => admin.from('contribution_scores').select('task_id, employee_id, score_percentage').order('id'), 8),
      fetchAllParallel(() => admin.from('tasks').select('id, service_id').is('deleted_at', null).order('id'), 4),
    ])

  return (
    <QuotePlannerClient
      canManage={canManage}
      clients={(clients.data || []) as never}
      services={(services.data || []) as never}
      groups={(groups.data || []) as never}
      parameters={(parameters.data || []) as never}
      employees={(employees.data || []) as never}
      pricings={(pricings.data || []) as never}
      rates={(rates.data || []) as never}
      plans={(plans.data || []) as never}
      scores={(scores.data || []) as never}
      tasks={(tasks.data || []) as never}
    />
  )
}
