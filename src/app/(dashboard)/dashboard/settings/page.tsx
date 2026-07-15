import { createClient } from '@/lib/supabase/server'
import SettingsClient from './settings-client'

const ALL_TABS = ['Company', 'Privacy & Security', 'Employees', 'Clients', 'Pricing Matrix', 'Services', 'Groups & Params', 'Tools', 'Bank Accounts', 'Cash Categories', 'Exchange Rates']
const normalizeTab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-')

export const dynamic = 'force-dynamic'

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string; editClient?: string; editService?: string; returnTo?: string }> }) {
  const { tab: rawTab, editClient, editService, returnTo } = await searchParams
  const initialTab = ALL_TABS.find(t => normalizeTab(t) === normalizeTab(rawTab ?? '')) ?? 'Company'

  const supabase = await createClient()

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
    supabase.from('company_settings').select('*'),
    supabase.from('exchange_rates').select('*'),
    // parameter_services is dead data (no write path exists) — params are
    // scoped to services via their group (group_services); nothing loads it here.
    supabase.from('tool_services').select('*'),
    supabase.from('tasks').select('service_id, created_at').not('service_id', 'is', null).order('created_at', { ascending: false }).limit(500),
    supabase.from('group_services').select('group_id, service_id'),
    // NOTE: invoices are intentionally NOT loaded here anymore — per-client
    // outstanding lives in the Clients module, which computes it itself.
  ])

  // Load designations (graceful — may not exist yet if migration not run)
  let designations: any[] = []
  try {
    const { data } = await supabase
      .from('designations')
      .select('id, name, is_admin, is_system, display_order')
      .order('display_order')
    designations = data || []
  } catch {}

  // Employee ↔ service assignments (graceful — table lands in migration 20260714150000)
  let employeeServices: { employee_id: string; service_id: string }[] = []
  {
    const { data } = await supabase.from('employee_services').select('employee_id, service_id')
    employeeServices = data || []
  }

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
      designations={designations}
      initialTab={initialTab}
      initialEditClientId={editClient}
      initialEditServiceId={editService}
      returnTo={returnTo}
    />
  )
}
