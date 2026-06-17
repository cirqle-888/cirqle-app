import { createAdminClient } from '@/lib/supabase/server'
import ActivityClient from './activity-client'

export const dynamic = 'force-dynamic'

export default async function FollowupActivityPage() {
  const supabase = createAdminClient()

  // Full history — unlike the Follow-ups page (pending invoices only), this
  // report includes follow-ups logged against invoices that are now paid/
  // cancelled, since the point is "how much follow-up work was done".
  const { data, error } = await supabase
    .from('invoice_followups')
    .select(`
      id, note, outcome, promised_date, next_followup_date, created_at,
      creator:created_by(cqid, name),
      invoice:invoice_id(id, invoice_number, status, client:clients(id, name))
    `)
    .order('created_at', { ascending: false })

  const setupNeeded = !!error && /relation|does not exist|schema cache/i.test(error.message || '')
  const rows = (data || []) as any[]

  const prepared = rows.map(r => {
    const inv = Array.isArray(r.invoice) ? r.invoice[0] : r.invoice
    const client = inv?.client ? (Array.isArray(inv.client) ? inv.client[0] : inv.client) : null
    const creator = Array.isArray(r.creator) ? r.creator[0] : r.creator
    return {
      id:                 r.id,
      note:               r.note,
      outcome:            r.outcome as string | null,
      promised_date:      r.promised_date as string | null,
      next_followup_date: r.next_followup_date as string | null,
      created_at:         r.created_at as string,
      employee:           creator ? { cqid: creator.cqid, name: creator.name } : null,
      invoice:            inv ? { id: inv.id, invoice_number: inv.invoice_number, status: inv.status } : null,
      client:             client ? { id: client.id, name: client.name } : null,
    }
  })

  return <ActivityClient rows={prepared} setupNeeded={setupNeeded} />
}
