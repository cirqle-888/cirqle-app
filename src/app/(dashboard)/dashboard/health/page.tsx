import { redirect } from 'next/navigation'
import { createAdminClient, fetchAll } from '@/lib/supabase/server'
import { loadCurrentUser } from '@/lib/permissions/check'
import { financialVisibility } from '@/lib/permissions/strip'
import { billedForCollection, collectedAmount, badDebtLoss } from '@/lib/finance/invoice-revenue'
import { computeClientScores } from '@/lib/clients/scoring'
import { daysOverdue } from '@/lib/followups/grouping'
import HealthClient from './health-client'

export const dynamic = 'force-dynamic'

const KNOWN_CRONS = ['recurring-tasks', 'recurring-expenses', 'payroll-draft', 'business-alerts', 'cleanup-product-images']

export default async function BusinessHealthPage() {
  // Same sensitivity as Reports / Contribution Analysis / Client Ranking —
  // gate identically so it sits naturally alongside them under Insights.
  const me = await loadCurrentUser().catch(() => null)
  const isAdmin = me?.isAdmin ?? false
  const canView = isAdmin || me?.permissions.has('reports.view') || !me
  if (me && !canView) redirect('/dashboard')

  const vis = financialVisibility(me)
  const showAmounts = isAdmin || vis.billingAmounts

  const admin = createAdminClient()

  const [
    { data: invoices },
    { data: cashbookRaw },
    { data: clientsForScoring },
    { data: payments },
    { data: allocationsRaw },
    { data: tasksForScoring },
  ] = await Promise.all([
    fetchAll(admin.from('invoices').select('id, status, issue_date, due_date, total_amount_inr, paid_amount_inr')),
    fetchAll(admin.from('cashbook_entries').select('type, amount_inr').is('deleted_at', null)),
    fetchAll(admin.from('clients').select('id, name')),
    fetchAll(admin.from('payments').select('invoice_id, payment_date')),
    fetchAll(admin.from('cashbook_invoice_allocations').select('invoice_id, deleted_at, cashbook_entry:cashbook_entry_id(entry_date)').is('deleted_at', null)),
    fetchAll(admin.from('tasks').select('client_id, status, task_date').is('deleted_at', null)),
  ])

  let followupsForScoring: { invoice_id: string; created_at: string; promised_date: string | null }[] = []
  try {
    const { data, error } = await admin.from('invoice_followups').select('invoice_id, created_at, promised_date')
    if (!error) followupsForScoring = data || []
  } catch { /* pre-migration */ }

  // ── Cash & Collections ──────────────────────────────────────────────────
  const bankBalance = (cashbookRaw || []).reduce((s: number, e: any) =>
    e.type === 'inflow' ? s + (e.amount_inr || 0) : s - (e.amount_inr || 0), 0)

  const liveStatuses = ['sent', 'partial', 'overdue']
  const draftStatuses = ['draft', 'reviewed']

  // Collection rate = collected ÷ billed-and-expected-to-collect.
  //
  // Write-offs MUST sit in the denominator: a written-off invoice is a collection
  // FAILURE, not an invoice that never existed. Excluding them while their partial
  // recoveries stayed in the numerator was letting this rate drift above 100% —
  // the worse the debt, the better the rate looked.
  const totalBilled = (invoices || []).reduce((s: number, i: any) => s + billedForCollection(i), 0)
  const totalPaid = (invoices || []).reduce((s: number, i: any) => s + collectedAmount(i), 0)
  const badDebtInr = (invoices || []).reduce((s: number, i: any) => s + badDebtLoss(i), 0)
  const outstanding = (invoices || []).filter((i: any) => liveStatuses.includes(i.status))
    .reduce((s: number, i: any) => s + Math.max(0, (i.total_amount_inr || 0) - (i.paid_amount_inr || 0)), 0)
  const toBeInvoiced = (invoices || []).filter((i: any) => draftStatuses.includes(i.status))
    .reduce((s: number, i: any) => s + (i.total_amount_inr || 0), 0)
  const collectionRatePct = totalBilled > 0 ? Math.round((totalPaid / totalBilled) * 1000) / 10 : null

  // ── Overdue aging buckets ───────────────────────────────────────────────
  const buckets = { '0-30': { count: 0, amount: 0 }, '31-60': { count: 0, amount: 0 }, '61-90': { count: 0, amount: 0 }, '90+': { count: 0, amount: 0 } }
  for (const inv of (invoices || []) as any[]) {
    if (!liveStatuses.includes(inv.status)) continue
    const d = daysOverdue(inv)
    if (d === null || d <= 0) continue
    const amount = Math.max(0, (inv.total_amount_inr || 0) - (inv.paid_amount_inr || 0))
    const key = d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+'
    buckets[key].count++
    buckets[key].amount += amount
  }

  // ── Client risk — reuses Client Ranking's own scoring (no second scoring system) ──
  const allocations = (allocationsRaw || []).map((a: any) => ({
    invoice_id: a.invoice_id,
    entry_date: (Array.isArray(a.cashbook_entry) ? a.cashbook_entry[0] : a.cashbook_entry)?.entry_date ?? null,
  }))
  const clientScores = computeClientScores(
    (clientsForScoring || []) as any[],
    (invoices || []) as any[],
    (payments || []) as any[],
    allocations,
    followupsForScoring,
    (tasksForScoring || []) as any[],
  )
    .filter(s => s.value.invoiceCount > 0 || s.value.taskCount > 0)
    .sort((a, b) => a.strategicScore - b.strategicScore)
    .slice(0, 5)

  // ── Automation health ───────────────────────────────────────────────────
  let cronStatus: { name: string; ranAt: string | null; ok: boolean | null; summary: any; error: string | null }[] = []
  try {
    const { data: recentRuns } = await admin
      .from('cron_runs')
      .select('cron_name, ran_at, ok, summary, error')
      .order('ran_at', { ascending: false })
      .limit(200)
    const latestByName = new Map<string, any>()
    for (const r of recentRuns || []) {
      if (!latestByName.has(r.cron_name)) latestByName.set(r.cron_name, r)
    }
    cronStatus = KNOWN_CRONS.map(name => {
      const r = latestByName.get(name)
      return r
        ? { name, ranAt: r.ran_at, ok: r.ok, summary: r.summary, error: r.error }
        : { name, ranAt: null, ok: null, summary: null, error: null }
    })
  } catch {
    cronStatus = KNOWN_CRONS.map(name => ({ name, ranAt: null, ok: null, summary: null, error: null }))
  }

  let offerSyncBroken: { count: number; items: { client: string; error: string }[] } = { count: 0, items: [] }
  try {
    const { data: brokenCampaigns } = await admin
      .from('offer_campaigns')
      .select('sheet_sync_error, client:clients(name)')
      .not('sheet_sync_error', 'is', null)
      .eq('status', 'active')
    const items = (brokenCampaigns || []).map((c: any) => ({
      client: Array.isArray(c.client) ? c.client[0]?.name : c.client?.name,
      error: c.sheet_sync_error,
    }))
    offerSyncBroken = { count: items.length, items: items.slice(0, 5) }
  } catch { /* pre-migration */ }

  return (
    <HealthClient
      showAmounts={showAmounts}
      cash={{ bankBalance, totalBilled, totalPaid, badDebtInr, outstanding, toBeInvoiced, collectionRatePct, totalExpectedCash: bankBalance + outstanding + toBeInvoiced }}
      agingBuckets={buckets}
      clientRisk={clientScores.map(s => ({ clientId: s.clientId, clientName: s.clientName, strategicScore: s.strategicScore, classification: s.classification }))}
      cronStatus={cronStatus}
      offerSyncBroken={offerSyncBroken}
    />
  )
}
