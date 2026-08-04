/**
 * Client Agreements — Data Loaders
 *
 * Safe read-only fetches. Uses the application standard createAdminClient.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  computeItemProgress, resolveDeliveryPeriod,
  type AgreementProgressSummary, type ItemProgressSummary, type DeliveryPeriod,
} from './progress'
import type { ClientAgreementItemRow } from './types'

export interface AgreementOverviewFilter {
  clientId?: string
  status?: string[]
}

export async function loadAgreementOverview(filters: AgreementOverviewFilter = {}) {
  const supabase = await createAdminClient()
  
  let q = supabase
    .from('client_agreements')
    .select(`
      *,
      client:clients(id, name, default_currency)
    `)
    .is('deleted_at', null)
    
  if (filters.clientId) {
    q = q.eq('client_id', filters.clientId)
  }
  if (filters.status && filters.status.length > 0) {
    q = q.in('status', filters.status)
  }
  
  const { data: agreements, error } = await q.order('created_at', { ascending: false })
  if (error || !agreements) return []
  
  // We don't fetch all deliverables here since overview just needs high level stats
  // For deep stats, use loadClientMonthProgress
  return agreements
}

/**
 * Load one agreement's items with their nested deliverables + milestones,
 * ordered for display. Returns [] on any read error (defensive: un-migrated
 * environments simply show an empty editor).
 */
export async function loadAgreementItems(agreementId: string) {
  const supabase = await createAdminClient()

  const { data: items, error } = await supabase
    .from('client_agreement_items')
    .select('*')
    .eq('agreement_id', agreementId)
    .order('display_order', { ascending: true })
    .order('effective_from', { ascending: true })

  if (error || !items || items.length === 0) return []

  const itemIds = items.map(i => i.id)
  const [{ data: deliverables }, { data: milestones }, coveredServices] = await Promise.all([
    supabase.from('client_agreement_deliverables').select('*').in('item_id', itemIds)
      .order('display_order', { ascending: true }),
    supabase.from('client_agreement_milestones').select('*').in('item_id', itemIds)
      .order('display_order', { ascending: true }),
    // Covered services (Phase 2b). Defensive: empty before the mapping migration.
    supabase.from('agreement_item_services')
      .select('agreement_item_id, service_id, service:services(id, name)')
      .in('agreement_item_id', itemIds)
      .then(r => r.data ?? [], () => []),
  ])

  return items.map(item => ({
    ...item,
    deliverables: (deliverables || []).filter(d => d.item_id === item.id),
    milestones: (milestones || []).filter(m => m.item_id === item.id),
    coveredServices: (coveredServices as any[])
      .filter(s => s.agreement_item_id === item.id)
      .map(s => ({ id: s.service_id as string, name: (s.service as { name?: string } | null)?.name ?? 'Service' })),
  }))
}

/** Load an agreement's timeline events (newest first). Best-effort. */
export async function loadAgreementEvents(agreementId: string, visibility?: 'internal' | 'client') {
  const supabase = await createAdminClient()
  let q = supabase
    .from('client_agreement_events')
    .select('*')
    .eq('agreement_id', agreementId)
  if (visibility) q = q.eq('visibility', visibility)
  const { data, error } = await q.order('created_at', { ascending: false }).limit(200)
  if (error || !data) return []
  return data
}

export async function loadClientMonthProgress(
  clientId: string,
  month: string // 'YYYY-MM'
): Promise<AgreementProgressSummary[]> {
  const supabase = await createAdminClient()
  
  // 1. Fetch active agreements
  const { data: agreements } = await supabase
    .from('client_agreements')
    .select('*')
    .eq('client_id', clientId)
    .in('status', ['active', 'paused'])
    .is('deleted_at', null)

  if (!agreements || agreements.length === 0) return []

  const agreementIds = agreements.map(a => a.id)
  
  // 2. Fetch all term rows (client_agreement_items)
  const { data: items } = await supabase
    .from('client_agreement_items')
    .select('*')
    .in('agreement_id', agreementIds)
    
  if (!items || items.length === 0) return []

  // Resolve the applicable term row for this month
  const activeItemsByAgreement = new Map<string, ClientAgreementItemRow[]>()
  
  for (const item of items) {
    // Note: items are typically returned in creation order, but resolveTermRows handles overlapping logic
    // We group them by item identifier but the schema generates new IDs per term row!
    // Wait, the spec says "a change CLOSES the row and INSERTs a successor (with its deliverables re-created)". 
    // So the item identity IS the `id` itself. Wait. If the row is replaced, how do we group them across time?
    // The design says: "term_changed with {from_item_id, to_item_id}". 
    // For a specific month M, we just find all items that overlap month M and apply them as active for that month.
    
    // Check if item is active in this month
    const startOfMonth = `${month}-01`
    const [y, m] = month.split('-').map(Number)
    const endOfMonth = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
    
    if (item.effective_from > endOfMonth) continue
    if (item.effective_to && item.effective_to < startOfMonth) continue
    
    let list = activeItemsByAgreement.get(item.agreement_id)
    if (!list) {
      list = []
      activeItemsByAgreement.set(item.agreement_id, list)
    }
    list.push(item)
  }

  const activeItemIds = Array.from(activeItemsByAgreement.values()).flat().map(i => i.id)
  if (activeItemIds.length === 0) return []

  // 3. Fetch Deliverables (commitment totals) and Adjustments (manual carry-forward)
  const [
    { data: deliverables },
    { data: adjustments }
  ] = await Promise.all([
    supabase.from('client_agreement_deliverables').select('*').in('item_id', activeItemIds),
    supabase.from('client_agreement_adjustments').select('*').in('item_id', activeItemIds).lte('month', `${month}-01`)
  ])

  // 4. Fetch tasks. Delivery is counted solely from tasks the coverage engine
  // stamped with retainer_item_id — see progress.ts for why the calendar and
  // service-matching paths were removed.
  //
  // The window spans every term row's resolved period, not the calendar month:
  // a mid-month start merges its stub month into the next one, so August's cards
  // must be able to see a task dated 29 July. computeItemProgress filters each
  // row down to its own period, so over-fetching here is safe.
  //
  // task_date is a DATE column, so the upper bound must be the REAL last day —
  // "${month}-31" is an invalid date for 30-day months / February and Postgres
  // rejects the whole query (silently, via the caller's catch), zeroing all
  // progress.
  const periodByItem = new Map<string, DeliveryPeriod>()
  for (const agr of agreements) {
    for (const termRow of activeItemsByAgreement.get(agr.id) || []) {
      periodByItem.set(termRow.id, resolveDeliveryPeriod(month, agr, termRow))
    }
  }
  const windows = Array.from(periodByItem.values()).filter(p => !p.inactive)
  const [my, mm] = month.split('-').map(Number)
  const monthEnd = `${month}-${String(new Date(my, mm, 0).getDate()).padStart(2, '0')}`
  const rangeStart = windows.reduce((min, p) => (p.start < min ? p.start : min), `${month}-01`)
  const rangeEnd = windows.reduce((max, p) => (p.end > max ? p.end : max), monthEnd)

  const { data: pipelineTasks, error: tasksError } = await supabase
    .from('tasks')
    .select('id, service_id, task_date, status, quantity, deleted_at, retainer_item_id, bill_as_extra')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .gte('task_date', rangeStart)
    .lte('task_date', rangeEnd)

  // Surface the failure rather than silently reporting zero progress.
  if (tasksError) {
    throw new Error(`loadClientMonthProgress: task fetch failed — ${tasksError.message}`)
  }

  const tasks = pipelineTasks || []
  const results: AgreementProgressSummary[] = []

  for (const agr of agreements) {
    const termRows = activeItemsByAgreement.get(agr.id) || []
    if (termRows.length === 0) continue

    let totalCommitted = 0, totalDelivered = 0, totalExtraBilled = 0
    const itemSummaries: ItemProgressSummary[] = []

    for (const termRow of termRows) {
      const itemDeliverables = (deliverables || []).filter(d => d.item_id === termRow.id)
      const itemAdjustments = (adjustments || []).filter(a => a.item_id === termRow.id)

      // Calculate manual carry in
      let carryIn = 0
      if (termRow.carry_forward_rule === 'manual') {
        carryIn = itemAdjustments.reduce((sum, a) => sum + Number(a.qty), 0)
      }

      const summary = computeItemProgress({
        month,
        agreement: agr,
        termRow,
        deliverables: itemDeliverables,
        adjustments: itemAdjustments,
        tasks,
        carryInRemaining: carryIn,
        period: periodByItem.get(termRow.id),
      })

      itemSummaries.push(summary)
      totalCommitted += summary.committed
      totalDelivered += summary.delivered
      totalExtraBilled += summary.extraBilled
    }

    results.push({
      agreementId: agr.id,
      agreementNumber: agr.agreement_number,
      title: agr.title,
      status: agr.status,
      items: itemSummaries.sort((a, b) => a.displayOrder - b.displayOrder),
      // Label off a row that actually owes something this period; an inactive
      // one_time row would otherwise name the period after a spent commitment.
      periodLabel: (itemSummaries.find(s => !s.period.inactive) ?? itemSummaries[0])?.period.label ?? month,
      totalCommitted,
      totalDelivered,
      totalRemaining: Math.max(0, totalCommitted - totalDelivered),
      totalExtra: Math.max(0, totalDelivered - totalCommitted),
      totalExtraBilled
    })
  }

  return results
}
