import { createAdminClient } from '@/lib/supabase/server'
import { CRITICAL_PERMS } from '@/lib/permissions/keys'
import SettingsClient from './settings-client'

const ALL_TABS = ['Company', 'Privacy & Security', 'Employees', 'Services', 'Departments', 'Groups & Params', 'Tools', 'Bank Accounts', 'Cash Categories', 'Exchange Rates']
const normalizeTab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')

export const dynamic = 'force-dynamic'

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; editClient?: string; editService?: string; returnTo?: string }> }) {
  const { tab: rawTab, editClient, editService, returnTo } = await searchParams
  const initialTab = ALL_TABS.find(t => normalizeTab(t) === normalizeTab(rawTab ?? '')) ?? 'Company'

  // Service role, like every other data-heavy dashboard page (cashbook,
  // invoices, tasks). Two reasons, and the first is a hard requirement:
  //
  //  1. The employee editor on this page reads base_salary, date_of_birth and
  //     performance_rating. The least-privilege migration grants `authenticated`
  //     eleven columns of `employees` and deliberately withholds those — they
  //     are pay and PII, and no employee should be able to read another's from
  //     the browser. A column-level GRANT is role-level: no RLS policy can widen
  //     it, so `select('*')` here would fail outright with "permission denied
  //     for column base_salary" once that migration lands.
  //
  //  2. Access is already decided before this code runs. The proxy gates
  //     /dashboard/settings on `settings.access` (see supabase/middleware.ts),
  //     so reaching this function at all means the check has passed. Re-deriving
  //     it from table grants adds no safety and, as above, actively breaks.
  const supabase = createAdminClient()

  const [
    groupsRes, paramsRes, toolsRes, servicesRes, clientsRes,
    employeesRes, bankRes, categoriesRes, companyRes, ratesRes,
    toolServicesRes, taskServiceUsageRes, groupServicesRes,
  ] = await Promise.all([
    supabase.from('contribution_groups').select('*').order('display_order'),
    supabase.from('parameters').select('*').order('display_order'),
    supabase.from('tools').select('*').order('name'),
    supabase.from('services').select('*').order('name'),
    supabase.from('clients').select('*, service_pricings:client_service_pricing(*)').order('name'),
    supabase.from('employees').select('*').order('cqid'),
    supabase.from('bank_accounts').select('*').order('name'),
    supabase.from('cashbook_categories').select('*').order('type').order('name'),
    // EGRESS: explicit columns — the table only has key/value payload worth
    // shipping, and select('*') dragged bookkeeping columns along too.
    supabase.from('company_settings').select('key, value'),
    supabase.from('exchange_rates').select('*'),
    // parameter_services is dead data (no write path exists) — params are
    // scoped to services via their group (group_services); nothing loads it here.
    supabase.from('tool_services').select('*'),
    supabase.from('tasks').select('service_id, created_at').not('service_id', 'is', null).order('created_at', { ascending: false }).limit(500),
    supabase.from('group_services').select('group_id, service_id'),
    // NOTE: invoices are intentionally NOT loaded here anymore — per-client
    // outstanding lives in the Clients module, which computes it itself.
  ])

  // Five INDEPENDENT lookups. Awaited one at a time they cost 1.65s against
  // live data; together, 0.33s. Each keeps its own catch so a table that a
  // migration hasn't created yet still degrades to [] on its own rather than
  // taking the other four (and the page) down with it — which is what the
  // separate try/catch blocks were protecting before.
  // PostgrestFilterBuilder is a thenable, not a real Promise, so the parameter
  // is typed PromiseLike — awaiting it is what turns it into a request.
  const settle = async <T,>(run: () => PromiseLike<{ data: T[] | null }>): Promise<T[]> => {
    try { return (await run()).data || [] } catch { return [] }
  }

  const [
    designations,
    designationPerms,
    employeeServices,
    serviceCategories,
    employeeServiceCategories,
  ] = await Promise.all([
    settle<any>(() => supabase
      .from('designations')
      .select('id, name, is_admin, is_system, display_order')
      .order('display_order')),
    // Which designations carry CRITICAL permissions (pricing, earnings,
    // salaries, personal data — CRITICAL_PERMS). Powers the red warning on the
    // employee form's designation picker, so "Reviewer" can't be handed to a
    // new hire without the assigner seeing it includes client pricing.
    settle<{ designation_id: string; permission: { key: string } | null }>(() => supabase
      .from('designation_permissions')
      .select('designation_id, allowed, permission:permissions(key)')
      .eq('allowed', true) as any),
    // Employee ↔ service assignments (graceful — table lands in 20260714150000)
    settle<{ employee_id: string; service_id: string }>(() => supabase
      .from('employee_services').select('employee_id, service_id')),
    // Service taxonomy + category-level assignments (graceful — 20260722090000).
    // NOTE: `serviceCategories`, not `categories` — that prop is already taken
    // by Cash Book categories, an unrelated concept.
    settle<any>(() => supabase
      .from('service_categories')
      .select('id, name, slug, description, color, display_order, is_active')
      .order('display_order')),
    settle<{ employee_id: string; category_id: string }>(() => supabase
      .from('employee_service_categories').select('employee_id, category_id')),
  ])

  const criticalDesignationIds = [...new Set(
    designationPerms
      .filter(r => r.permission?.key && CRITICAL_PERMS.has(r.permission.key))
      .map(r => r.designation_id),
  )]

  return (
    <SettingsClient
      groups={groupsRes.data || []}
      parameters={paramsRes.data || []}
      tools={toolsRes.data || []}
      services={servicesRes.data || []}
      clients={clientsRes.data || []}
      employees={employeesRes.data || []}
      bankAccounts={bankRes.data || []}
      categories={categoriesRes.data || []}
      companySettings={companyRes.data || []}
      exchangeRates={ratesRes.data || []}
      toolServices={toolServicesRes.data || []}
      taskServiceUsage={(taskServiceUsageRes.data || []) as any[]}
      groupServices={groupServicesRes.data || []}
      employeeServices={employeeServices}
      serviceCategories={serviceCategories}
      employeeServiceCategories={employeeServiceCategories}
      designations={designations}
      criticalDesignationIds={criticalDesignationIds}
      initialTab={initialTab}
      initialEditClientId={editClient}
      initialEditServiceId={editService}
      returnTo={returnTo}
    />
  )
}
