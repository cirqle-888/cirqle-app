import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import { computeClientScores } from '@/lib/clients/scoring'
import RankingClient from './ranking-client'

export const dynamic = 'force-dynamic'

export default async function ClientRankingPage() {
  // Surfaces lifetime revenue + payment-reliability per client — same
  // sensitivity as Reports, so gate the same way: admin or explicit
  // reports.view, fail-open pre-migration.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? true
  const canView = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canView) redirect('/dashboard')

  const vis = financialVisibility(me)
  const showAmounts = isAdmin || vis.billingAmounts

  const supabase = createAdminClient()

  const [
    { data: clients },
    { data: invoices },
    { data: payments },
    { data: allocationsRaw },
    { data: tasks },
  ] = await Promise.all([
    fetchAll(supabase.from('clients').select('id, name')),
    fetchAll(supabase.from('invoices').select('id, client_id, status, issue_date, due_date, total_amount_inr, paid_amount_inr')),
    fetchAll(supabase.from('payments').select('invoice_id, payment_date')),
    fetchAll(supabase.from('cashbook_invoice_allocations').select('invoice_id, deleted_at, cashbook_entry:cashbook_entry_id(entry_date)').is('deleted_at', null)),
    fetchAll(supabase.from('tasks').select('client_id, status, task_date').is('deleted_at', null)),
  ])

  // Follow-ups — defensive: the table may not exist before the migration runs.
  let followups: { invoice_id: string; created_at: string; promised_date: string | null }[] = []
  try {
    const { data, error } = await supabase.from('invoice_followups').select('invoice_id, created_at, promised_date')
    if (!error) followups = data || []
  } catch { /* pre-migration — leave empty */ }

  const allocations = (allocationsRaw || []).map((a: any) => ({
    invoice_id: a.invoice_id,
    entry_date: (Array.isArray(a.cashbook_entry) ? a.cashbook_entry[0] : a.cashbook_entry)?.entry_date ?? null,
  }))

  const scores = computeClientScores(
    (clients || []) as any[],
    (invoices || []) as any[],
    (payments || []) as any[],
    allocations,
    followups,
    (tasks || []) as any[],
  )
    // Drop clients with no billing/work history — pure noise on the ranking.
    .filter(s => s.value.invoiceCount > 0 || s.value.taskCount > 0)

  return <RankingClient scores={scores} showAmounts={!!showAmounts} />
}
