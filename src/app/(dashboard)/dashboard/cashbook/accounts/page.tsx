import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import { redirect } from 'next/navigation'
import AccountsClient from './accounts-client'

export const dynamic = 'force-dynamic'

export default async function AccountsPage() {
  const me = await loadCurrentUser().catch(() => null)
  if (!me) redirect('/login')
  const vis = financialVisibility(me)
  if (!vis.cashbookAmounts) redirect('/dashboard/cashbook')   // amounts-only page

  const supabase = createAdminClient()

  const [entriesRes, accountsRes, categoriesRes] = await Promise.all([
    supabase
      .from('cashbook_entries')
      .select(`
        id, entry_date, type, amount, amount_inr, currency,
        description, reference, bank_account_id,
        category:cashbook_categories(id, name, type),
        bank_account:bank_accounts(id, name, type),
        allocations:cashbook_invoice_allocations(
          id, allocated_amount, deleted_at,
          invoice:invoices(invoice_number, client:clients(id, name))
        )
      `)
      .is('deleted_at', null)
      .order('entry_date', { ascending: true })
      .order('id',         { ascending: true }),

    supabase
      .from('bank_accounts')
      .select('id, name, type, account_number, bank_name, opening_balance, currency, is_active, display_order')
      .order('display_order')
      .order('name'),

    supabase
      .from('cashbook_categories')
      .select('id, name, type')
      .order('type').order('name'),
  ])

  return (
    <AccountsClient
      entries={(entriesRes.data  || []) as any[]}
      accounts={(accountsRes.data || []) as any[]}
      categories={(categoriesRes.data || []) as any[]}
      isAdmin={me.isAdmin}
    />
  )
}
