import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { recentMonths } from '@/lib/bank/period'
import { todayISO } from '@/lib/utils/local-date'
import BankClient, { type AccountOption } from './bank-client'

export const metadata = { title: 'Bank Reconciliation | Cirqle' }
export const dynamic = 'force-dynamic'

/**
 * Bank reconciliation.
 *
 * The page settles what a browser cannot ask for — who is signed in and which
 * accounts exist. Everything else (the statement, its lines, the entries to
 * match against) is loaded per period by the client, because it changes every
 * time the person picks a different one.
 *
 * Credit cards are excluded here and nowhere else: they reconcile against a
 * billing cycle rather than a date range, and Card Statements already does it.
 */
export default async function BankReconciliationPage() {
  const user = await loadCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, PERMS.BANK_RECONCILIATION_VIEW)) redirect('/dashboard')

  const admin = createAdminClient()
  const [accountsRes, probe] = await Promise.all([
    admin
      .from('bank_accounts')
      .select('id, name, type, currency, account_number, bank_name, reconcile_from, is_active')
      .order('display_order', { ascending: true }),
    // Cheapest possible "has the migration run" question: ask the new table
    // for nothing at all. A missing table answers with an error we can read.
    admin.from('bank_statements').select('id').limit(1),
  ])

  const migrationMissing = Boolean(
    probe.error && /does not exist|schema cache|bank_statements/i.test(probe.error.message ?? ''),
  )

  const today = todayISO()
  type Row = {
    id: string; name: string; type: string | null; currency: string | null
    account_number: string | null; bank_name: string | null
    reconcile_from: string | null; is_active: boolean | null
  }
  const accounts: AccountOption[] = ((accountsRes.data ?? []) as Row[])
    .filter(a => a.is_active !== false && a.type !== 'credit_card')
    .map(a => ({
      id: a.id,
      name: a.name,
      type: a.type ?? 'bank',
      currency: a.currency ?? 'INR',
      bankName: a.bank_name,
      // Only the last four, and only to tell two accounts apart on screen.
      last4: a.account_number ? a.account_number.replace(/\D/g, '').slice(-4) || null : null,
      reconcileFrom: a.reconcile_from,
      periods: recentMonths(today, a.reconcile_from, 24),
    }))

  return (
    <BankClient
      accounts={accounts}
      canManage={hasPermission(user, PERMS.BANK_RECONCILIATION_MANAGE)}
      migrationMissing={migrationMissing}
    />
  )
}
