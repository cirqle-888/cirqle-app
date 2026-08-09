import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { userCanSee } from '@/lib/permissions/strip'
import { PERMS } from '@/lib/permissions/keys'
import { listRecurringExpenses } from '../recurring-actions'
import RecurringClient from './recurring-client'

// Rules and their next-due dates move with the calendar — never cache.
export const dynamic = 'force-dynamic'

/**
 * Recurring expenses — the screen the engine was missing.
 *
 * `recurring-actions.ts` and the nightly cron have existed for a while, fully
 * working, with nothing importing them: the rules could only be created by
 * hand in SQL. This page is that missing surface, nothing more — no new
 * server logic, no schema change.
 */
export default async function RecurringExpensesPage() {
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  if (!(isAdmin || userCanSee(me, PERMS.CASHBOOK_VIEW))) redirect('/dashboard')

  // Editing is gated in the server actions too (cashbook.edit); this only
  // decides whether the UI offers the buttons.
  const canEdit = isAdmin || userCanSee(me, PERMS.CASHBOOK_EDIT)

  const admin = createAdminClient()
  const [rulesRes, categoriesRes, banksRes] = await Promise.all([
    listRecurringExpenses(),
    admin.from('cashbook_categories').select('id, name, type').eq('type', 'outflow').order('name'),
    admin.from('bank_accounts').select('id, name').order('name'),
  ])

  return (
    <RecurringClient
      initialRules={rulesRes.ok ? (rulesRes.data ?? []) : []}
      loadError={rulesRes.ok ? null : (rulesRes.error ?? null)}
      categories={(categoriesRes.data ?? []) as { id: string; name: string }[]}
      bankAccounts={(banksRes.data ?? []) as { id: string; name: string }[]}
      canEdit={canEdit}
    />
  )
}
