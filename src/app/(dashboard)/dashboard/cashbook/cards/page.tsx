import { redirect } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadCurrentUser, hasPermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { closedCyclesBetween, cycleLabel } from '@/lib/cards/cycle'
import { todayISO } from '@/lib/utils/local-date'
import CardsClient, { type CardOption } from './cards-client'

export const metadata = { title: 'Card Statements | Cirqle' }
export const dynamic = 'force-dynamic'

/**
 * Credit card reconciliation.
 *
 * The page settles what a browser cannot ask for — who is signed in, which
 * cards exist and which of their cycles have closed. Everything else (the
 * statement, its lines, the entries to match against) is loaded per cycle by
 * the client, because it changes every time the person picks a different one.
 */
export default async function CardStatementsPage() {
  const user = await loadCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, PERMS.CARD_RECONCILIATION_VIEW)) redirect('/dashboard')

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('bank_accounts')
    .select('id, name, currency, card_last4, statement_day, due_day, credit_limit, reconcile_from, is_active')
    .eq('type', 'credit_card')
    .order('display_order', { ascending: true })

  // The column set only exists after migration 20260915100000. Until it is
  // applied the page says so plainly rather than rendering an empty screen
  // that looks like "you have no cards".
  const migrationMissing = Boolean(error && /column .* does not exist|card_last4|statement_day/i.test(error.message))

  const today = todayISO()
  type Row = {
    id: string; name: string; currency: string | null; card_last4: string | null
    statement_day: number | null; due_day: number | null; credit_limit: number | null
    reconcile_from: string | null; is_active: boolean | null
  }
  const cards: CardOption[] = ((data ?? []) as Row[])
    .filter(c => c.is_active !== false)
    .map(c => ({
      id: c.id,
      name: c.name,
      currency: c.currency ?? 'INR',
      last4: c.card_last4,
      statementDay: c.statement_day,
      dueDay: c.due_day,
      creditLimit: c.credit_limit === null ? null : Number(c.credit_limit),
      reconcileFrom: c.reconcile_from,
      cycles: c.statement_day
        ? closedCyclesBetween(c.reconcile_from ?? '2000-01-01', today, c.statement_day, 18)
            .map(cycle => ({ end: cycle.end, start: cycle.start, label: cycleLabel(cycle) }))
        : [],
    }))

  return (
    <CardsClient
      cards={cards}
      canManage={hasPermission(user, PERMS.CARD_RECONCILIATION_MANAGE)}
      migrationMissing={migrationMissing}
    />
  )
}
