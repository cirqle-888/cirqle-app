import { createAdminClient } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import { templatesFromSettings } from '@/lib/messaging/templates'
import { getCompanySettings } from '@/lib/settings/company-settings'
import FollowUpsClient, { type FUPartner } from './follow-ups-client'

export const dynamic = 'force-dynamic'

// Pending universe: unsent drafts (need sending) + sent/unpaid (need chasing).
// Paid / cancelled / bad_debt are excluded.
const PENDING_STATUSES = ['draft', 'reviewed', 'sent', 'partial', 'overdue']

export default async function FollowUpsPage() {
  // Route is permission-gated by middleware (`/^\/dashboard\/invoices/` → billing.view_invoices).
  const me = await loadCurrentUser().catch(() => null)
  const vis = financialVisibility(me)
  const showAmounts = (me?.isAdmin ?? false) || vis.billingAmounts
  const supabase = createAdminClient()

  // Independent of the invoice list — started now so they overlap it instead of
  // queueing behind it. Company settings, and this user's saved greeting names.
  const settingsP = getCompanySettings()
  const greetingsP = (async () => {
    const partnerGreetings: Record<string, string> = {}
    const clientGreetings: Record<string, string> = {}
    if (me?.employeeId) {
      const [p, c] = await Promise.all([
        supabase.from('employee_partner_preferences')
          .select('business_partner_id, greeting_name').eq('employee_id', me.employeeId)
          .then(r => r.data, () => null),
        supabase.from('employee_client_preferences')
          .select('client_id, greeting_name').eq('employee_id', me.employeeId)
          .then(r => r.data, () => null),
      ])
      ;(p || []).forEach((r: any) => { partnerGreetings[r.business_partner_id] = r.greeting_name })
      ;(c || []).forEach((r: any) => { clientGreetings[r.client_id] = r.greeting_name })
    }
    return { partnerGreetings, clientGreetings }
  })()

  const { data: invoicesRaw } = await supabase
    .from('invoices')
    .select(`
      id, invoice_number, status, issue_date, due_date, public_token,
      total_amount, paid_amount, total_amount_inr, paid_amount_inr, currency,
      client:clients(id, name, code, phone, business_partner_id),
      items:invoice_items(task_id),
      cashbook_invoice_allocations(id, deleted_at)
    `)
    .in('status', PENDING_STATUSES)
    .order('issue_date', { ascending: true })

  const invoices = (invoicesRaw || []) as any[]
  const ids = invoices.map(i => i.id)

  // Business partners of the invoiced clients — powers the "By Business Partner"
  // view and the partner collection statement. Queried separately (not embedded)
  // so a missing business_partners table can't take the whole page down.
  const partnerIds = [...new Set(
    invoices
      .map(i => (Array.isArray(i.client) ? i.client[0] : i.client)?.business_partner_id)
      .filter(Boolean) as string[],
  )]

  // Both derive from the invoice list but not from each other, so one wait.
  let followups: any[] = []
  let setupNeeded = false
  const partners: Record<string, FUPartner> = {}

  const [followupsOut, partnersOut] = await Promise.all([
    // Follow-ups — defensive: the table may not exist before the migration runs.
    (async () => {
      if (!ids.length) return { rows: [] as any[], setupNeeded: false }
      try {
        const { data, error } = await supabase
          .from('invoice_followups')
          .select('id, invoice_id, note, outcome, promised_date, next_followup_date, created_by, created_at, creator:created_by(cqid, name)')
          .in('invoice_id', ids)
          .order('created_at', { ascending: false })
        if (error) {
          return { rows: [], setupNeeded: /relation|does not exist|schema cache/i.test(error.message) }
        }
        return { rows: data || [], setupNeeded: false }
      } catch { return { rows: [] as any[], setupNeeded: true } }
    })(),
    (async () => {
      if (!partnerIds.length) return [] as { id: string; name: string; partner_code: string | null; phone: string | null }[]
      try {
        const { data } = await supabase
          .from('business_partners')
          .select('id, name, partner_code, phone')
          .in('id', partnerIds)
          .returns<{ id: string; name: string; partner_code: string | null; phone: string | null }[]>()
        return data || []
      } catch { return [] /* partners feature not set up — page still works */ }
    })(),
  ])
  followups = followupsOut.rows
  setupNeeded = followupsOut.setupNeeded
  partnersOut.forEach(p => {
    partners[p.id] = { id: p.id, name: p.name, code: p.partner_code, phone: p.phone }
  })

  // Company name + message templates for the WhatsApp reminder text.
  // EGRESS: shared 5-minute cache instead of an unfiltered per-render select
  // that dragged the base64 logo rows along with it.
  const [settings, { partnerGreetings, clientGreetings }] = await Promise.all([settingsP, greetingsP])
  const companyName = settings.company_name || 'Cirqle Works'
  const templates = templatesFromSettings(settings)

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
      client:         client
        ? {
            id: client.id, name: client.name, code: client.code, phone: client.phone,
            partner: partners[client.business_partner_id as string] ?? null,
          }
        : null,
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
      templates={templates}
      partnerGreetings={partnerGreetings}
      clientGreetings={clientGreetings}
    />
  )
}
