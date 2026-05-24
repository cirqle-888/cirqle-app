import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import ImportClient from './import-client'

export const dynamic = 'force-dynamic'

export default async function ImportPage() {
  // Bulk Import is strictly admin-only — it can mass-create tasks,
  // contributions, and cashbook entries. The sidebar already hides the link;
  // this is the server-side wall in case anyone types the URL.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true   // pre-migration fail-open
  if (me && !isAdmin) redirect('/dashboard')

  const supabase = createAdminClient()

  const [clientsRes, servicesRes, employeesRes, groupsRes, paramsRes, bankAccountsRes, cashCategoriesRes] = await Promise.all([
    supabase.from('clients').select('id, name, code').order('name'),
    supabase.from('services').select('id, name').order('name'),
    supabase.from('employees').select('id, cqid, name').order('cqid'),
    supabase.from('contribution_groups').select('id, name, weight').order('display_order'),
    supabase.from('parameters').select('id, name, group_id, weight, display_order').order('display_order'),
    supabase.from('bank_accounts').select('id, name').order('name'),
    supabase.from('cashbook_categories').select('id, name, type').order('name'),
  ])

  return (
    <ImportClient
      clients={clientsRes.data || []}
      services={servicesRes.data || []}
      employees={employeesRes.data || []}
      groups={groupsRes.data || []}
      parameters={paramsRes.data || []}
      bankAccounts={bankAccountsRes.data || []}
      cashCategories={cashCategoriesRes.data || []}
    />
  )
}
