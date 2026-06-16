import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import FollowUpsClient from './follow-ups-client'

export const dynamic = 'force-dynamic'

// Pending universe: unsent drafts (need sending) + sent/unpaid (need chasing).
// Paid / cancelled / bad_debt are excluded.
const PENDING_STATUSES = ['draft', 'reviewed', 'sent', 'partial', 'overdue']

export default async function FollowUpsPage() {
  // Route is permission-gated by middleware (`/^\/dashboard\/invoices/` → billing.view_invoices).
  const me = await loadCurrentUser().catch(() => null)
  const vis = financialVisibility(me)
  const showAmounts = (me?.isAdmin ?? true) || vis.billingAmounts
  const supabase = createAdminClient()

  const { data: invoicesRaw } = await supabase
    .from('invoices')
    .select(`
      id, invoice_number, status, issue_date, due_date, public_token,
      total_amount, paid_amount, total_amount_inr, paid_amount_inr, currency,
      client:clients(id, name, code, phone),
      items:invoice_items(task_id),
      cashbook_invoice_allocations(id, deleted_at)
    `)
    .in('status', PENDING_STATUSES)
    .order('issue_date', { ascending: true })

  const invoices = (invoicesRaw || []) as any[]
  const ids = invoices.map(i => i.id)

  // Follow-ups — defensive: the table may not exist before the migration runs.
  let followups: any[] = []
  let setupNeeded = false
  if (ids.length) {
    try {
      const { data, error } = await supabase
        .from('invoice_followups')
        .select('id, invoice_id, note, outcome, promised_date, next_followup_date, created_by, created_at, creator:created_by(cqid, name)')
        .in('invoice_id', ids)
        .order('created_at', { ascending: false })
      if (error) {
        if (/relation|does not exist|schema cache/i.test(error.message)) setupNeeded = true
      } else {
        followups = data || []
      }
    } catch {
      setupNeeded = true
    }
  }

  // Company name for the WhatsApp reminder text.
  const { data: settingsRows } = await supabase.from('company_settings').select('key, value')
  const settings: Record<string, string> = {}
  ;(settingsRows || []).forEach((s: any) => { settings[s.key] = s.value })
  const companyName = settings.company_name || 'Cirqle Design'

  // Shape the payload; strip ₹ figures when the user can't see billing amounts.
  const prepared = invoices.map(i => {
    const totalInr = i.total_amount_inr ?? i.total_amount ?? 0
    const paidInr  = i.paid_amount_inr ?? i.paid_amount ?? 0
    const outstanding = Math.max(0, totalInr - paidInr)
    // client comes back as an object (to-one FK); normalise defensively.
    const client = Array.isArray(i.client) ? i.client[0] : i.client
    const hasAllocations = ((i.cashbook_invoice_allocations || []) as any[]).some(a => !a.deleted_at)
    return {
      id:             i.id,
      invoice_number: i.invoice_number,
      status:         i.status,
      issue_date:     i.issue_date,
      due_date:       i.due_date,
      public_token:   i.public_token || null,
      currency:       i.currency || 'INR',
      client:         client ? { id: client.id, name: client.name, code: client.code, phone: client.phone } : null,
      outstanding:    showAmounts ? outstanding : null,
      total:          showAmounts ? totalInr : null,
      hasAllocations,
    }
  })

  return (
    <FollowUpsClient
      invoices={prepared}
      followups={followups}
      companyName={companyName}
      showAmounts={!!showAmounts}
      setupNeeded={setupNeeded}
    />
  )
}
