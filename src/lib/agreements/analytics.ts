/**
 * Retainer Analytics — read-only operational metrics (Phase 3).
 *
 * ONE engine that every retainer dashboard/report consumes, so nothing is
 * recomputed twice. It reuses:
 *   • loadClientMonthProgress()  → Committed / Planned / Delivered (progress engine)
 *   • allocated_unit_value       → DB-generated internal unit value (Phase 1)
 *   • contribution_scores.earnings_inr → internal production cost (same source
 *                                        the client-profitability report uses)
 *
 * NOTHING here writes. Money fields are nulled when pricingVisible is false so
 * non-pricing viewers still get progress/usage without seeing fees/margins.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { loadClientMonthProgress } from './server'

export type CoverageHealth = 'green' | 'amber' | 'red'       // on-track / near-limit / exceeded
export type FinancialHealth = 'healthy' | 'warning' | 'loss'

export interface RetainerAnalytics {
  agreementId: string
  agreementNumber: string
  title: string
  status: string
  clientId: string
  clientName: string
  country: string | null
  currency: string
  startDate: string | null
  endDate: string | null
  // Progress (always present)
  included: number
  delivered: number
  planned: number
  remaining: number
  utilisation: number            // delivered / included × 100 (0 when nothing included)
  coverageHealth: CoverageHealth
  extraTasks: number             // covered-service tasks flagged bill_as_extra this month
  // Money (null when pricingVisible=false)
  monthlyRetainer: number | null
  monthlyRetainerInr: number | null    // INR-normalized, for cross-currency totals
  creativeAllocation: number | null
  creativeAllocationInr: number | null // INR-normalized
  managementAllocation: number | null
  allocatedUnitValue: number | null
  allocatedValueDelivered: number | null
  allocatedValueRemaining: number | null
  internalCost: number | null    // INR (contribution earnings of covered tasks this month)
  grossMargin: number | null     // INR: creativeAllocation→INR − internalCost
  marginPct: number | null       // currency-neutral ratio
  financialHealth: FinancialHealth | null
}

export interface RetainerTrendPoint {
  month: string                  // 'YYYY-MM'
  label: string                  // 'Jul 26'
  activeCount: number
  included: number
  delivered: number
  remaining: number
  extra: number
  avgUtilisation: number
  revenue: number | null         // INR (sum of monthlyRetainerInr)
  creativeAllocation: number | null  // INR
  internalCost: number | null    // INR
  grossMargin: number | null     // INR
  marginPct: number | null
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTH_ABBR[m - 1]} ${String(y).slice(-2)}`
}
function monthsBack(endMonth: string, count: number): string[] {
  const [y, m] = endMonth.split('-').map(Number)
  const list: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const total = y * 12 + (m - 1) - i
    const yy = Math.floor(total / 12)
    const mm = (total % 12) + 1
    list.push(`${yy}-${String(mm).padStart(2, '0')}`)
  }
  return list
}

/**
 * Time series over the last `months` ending at `endMonth`. Pure reuse — it calls
 * loadRetainerAnalytics() once per month (bounded ≤12) and aggregates; no new
 * calculation. Powers the executive trend charts.
 */
export async function loadRetainerAnalyticsTrend(
  params: { clientId?: string; endMonth: string; months: number; pricingVisible: boolean },
): Promise<RetainerTrendPoint[]> {
  const { clientId, endMonth, months, pricingVisible } = params
  const list = monthsBack(endMonth, Math.min(12, Math.max(1, months)))
  const perMonth = await Promise.all(
    list.map(month =>
      loadRetainerAnalytics({ clientId, month, pricingVisible }).catch(() => [] as RetainerAnalytics[])),
  )
  return list.map((month, i) => {
    const rows = perMonth[i]
    const included = rows.reduce((s, a) => s + a.included, 0)
    const delivered = rows.reduce((s, a) => s + a.delivered, 0)
    const revenue = rows.reduce((s, a) => s + (a.monthlyRetainerInr ?? 0), 0)
    const creative = rows.reduce((s, a) => s + (a.creativeAllocationInr ?? 0), 0)
    const cost = rows.reduce((s, a) => s + (a.internalCost ?? 0), 0)
    const margin = rows.reduce((s, a) => s + (a.grossMargin ?? 0), 0)
    return {
      month, label: monthLabel(month),
      activeCount: rows.length,
      included, delivered,
      remaining: Math.max(0, included - delivered),
      extra: rows.reduce((s, a) => s + a.extraTasks, 0),
      avgUtilisation: rows.length ? Math.round(rows.reduce((s, a) => s + a.utilisation, 0) / rows.length) : 0,
      revenue: pricingVisible ? Math.round(revenue) : null,
      creativeAllocation: pricingVisible ? Math.round(creative) : null,
      internalCost: pricingVisible ? Math.round(cost) : null,
      grossMargin: pricingVisible ? Math.round(margin) : null,
      // Same basis as the per-agreement marginPct (grossMargin ÷ creative
      // allocation) so the trend line and the table never disagree.
      marginPct: pricingVisible && creative > 0 ? Math.round((margin / creative) * 100) : null,
    }
  })
}

export interface EmployeeRetainerRow {
  employeeId: string
  employeeName: string
  tasks: number                        // covered tasks this employee contributed to
  avgContribution: number              // mean score_percentage across those tasks
  internalCost: number | null          // INR — their earnings on covered tasks
  allocatedValueProduced: number | null // INR — their share of covered tasks' allocated value
  efficiency: number | null            // allocatedValueProduced ÷ internalCost
  topClients: string[]
}

/**
 * Employee production on retainer-covered tasks this month. Read-only; reuses
 * contribution_scores (earnings + share) and the DB allocated_unit_value —
 * no new cost calculation. Money nulled when pricingVisible=false.
 */
export async function loadEmployeeRetainerContribution(
  params: { month: string; pricingVisible: boolean },
): Promise<EmployeeRetainerRow[]> {
  const { month, pricingVisible } = params
  const admin = await createAdminClient()
  const { start, end } = monthBounds(month)

  const { data: covTasks } = await admin.from('tasks')
    .select('id, retainer_item_id, client:clients(name)')
    .not('retainer_item_id', 'is', null).is('deleted_at', null)
    .gte('task_date', start).lte('task_date', end)
  if (!covTasks || covTasks.length === 0) return []

  // Allocated unit value + currency per covering item (for value produced).
  const itemIds = Array.from(new Set(covTasks.map(t => t.retainer_item_id as string)))
  const { data: itemsData } = await admin.from('client_agreement_items')
    .select('id, allocated_unit_value, currency').in('id', itemIds)
  const itemInfo = new Map((itemsData || []).map(i => [i.id, i]))
  const currencies = Array.from(new Set((itemsData || []).map(i => i.currency).filter(Boolean)))
  const rateToInr = new Map<string, number>([['INR', 1]])
  if (currencies.length > 0) {
    const { data: rates } = await admin.from('exchange_rates').select('currency, rate_to_inr').in('currency', currencies)
    for (const r of rates || []) rateToInr.set(r.currency as string, Number(r.rate_to_inr) || 1)
  }
  const taskInfo = new Map(covTasks.map(t => [t.id, {
    item: itemInfo.get(t.retainer_item_id as string),
    client: (t.client as { name?: string } | null)?.name || 'Unknown',
  }]))

  const { data: scores } = await admin.from('contribution_scores')
    .select('task_id, employee_id, earnings_inr, score_percentage, employee:employees(id, name)')
    .in('task_id', covTasks.map(t => t.id))
  if (!scores || scores.length === 0) return []

  const acc = new Map<string, {
    name: string; tasks: Set<string>; shareSum: number; shareCount: number
    cost: number; valueInr: number; byClient: Map<string, number>
  }>()
  for (const s of scores) {
    const share = Number(s.score_percentage || 0)
    if (share <= 0) continue
    const eid = s.employee_id as string
    if (!eid) continue
    const name = (s.employee as { name?: string } | null)?.name || 'Unknown'
    let row = acc.get(eid)
    if (!row) { row = { name, tasks: new Set(), shareSum: 0, shareCount: 0, cost: 0, valueInr: 0, byClient: new Map() }; acc.set(eid, row) }
    const ti = taskInfo.get(s.task_id as string)
    row.tasks.add(s.task_id as string)
    row.shareSum += share; row.shareCount += 1
    row.cost += Number(s.earnings_inr || 0)
    if (ti?.item?.allocated_unit_value != null) {
      const rate = rateToInr.get(ti.item.currency as string) ?? 1
      row.valueInr += Number(ti.item.allocated_unit_value) * rate * (share / 100)
    }
    if (ti) row.byClient.set(ti.client, (row.byClient.get(ti.client) || 0) + Number(s.earnings_inr || 0))
  }

  return Array.from(acc.entries()).map(([eid, r]) => ({
    employeeId: eid,
    employeeName: r.name,
    tasks: r.tasks.size,
    avgContribution: r.shareCount > 0 ? Math.round((r.shareSum / r.shareCount) * 10) / 10 : 0,
    internalCost: pricingVisible ? Math.round(r.cost) : null,
    allocatedValueProduced: pricingVisible ? Math.round(r.valueInr) : null,
    efficiency: pricingVisible && r.cost > 0 ? Math.round((r.valueInr / r.cost) * 100) / 100 : null,
    topClients: Array.from(r.byClient.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(c => c[0]),
  })).sort((a, b) => b.tasks - a.tasks)
}

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number)
  const end = new Date(y, m, 0).getDate()
  return { start: `${month}-01`, end: `${month}-${String(end).padStart(2, '0')}` }
}

function coverageHealth(util: number): CoverageHealth {
  if (util > 100) return 'red'
  if (util >= 80) return 'amber'
  return 'green'
}

function financialHealth(margin: number | null, marginPct: number | null): FinancialHealth | null {
  if (margin == null) return null
  if (margin < 0) return 'loss'
  if ((marginPct ?? 0) < 15) return 'warning'
  return 'healthy'
}

const r2 = (n: number) => Math.round(n * 100) / 100

export interface RetainerAnalyticsParams {
  clientId?: string
  month: string                  // 'YYYY-MM'
  pricingVisible: boolean
}

/**
 * Per-agreement retainer analytics for a month. Batched: a bounded number of
 * per-client progress calls (only clients that HAVE active retainers), plus two
 * set-queries for internal cost — never a per-agreement query loop.
 */
export async function loadRetainerAnalytics(params: RetainerAnalyticsParams): Promise<RetainerAnalytics[]> {
  const { clientId, month, pricingVisible } = params
  const admin = await createAdminClient()
  const { start, end } = monthBounds(month)

  // 1. Active agreements (optionally one client) + their retainer items.
  let aq = admin.from('client_agreements')
    .select('id, agreement_number, title, status, client_id, start_date, end_date, client:clients(id, name, default_currency, country)')
    .eq('status', 'active').is('deleted_at', null)
  if (clientId) aq = aq.eq('client_id', clientId)
  const { data: agreements, error } = await aq
  if (error || !agreements || agreements.length === 0) return []

  const { data: items } = await admin.from('client_agreement_items')
    .select('id, agreement_id, commitment_type, unit_price, currency, committed_quantity, included_quantity, creative_allocation_amount, management_allocation_amount, allocated_unit_value, effective_from, effective_to')
    .in('agreement_id', agreements.map(a => a.id)).eq('commitment_type', 'retainer')
  const retainerItems = items || []
  const itemById = new Map(retainerItems.map(i => [i.id, i]))

  // Exchange rates → INR, so margin can reconcile allocation (e.g. AED) against
  // internal cost (contribution_scores.earnings_inr, always INR).
  const currencies = Array.from(new Set(retainerItems.map(i => i.currency).filter(Boolean)))
  const rateToInr = new Map<string, number>([['INR', 1]])
  if (currencies.length > 0) {
    const { data: rates } = await admin.from('exchange_rates').select('currency, rate_to_inr').in('currency', currencies)
    for (const r of rates || []) rateToInr.set(r.currency as string, Number(r.rate_to_inr) || 1)
  }
  const rateFor = (c: string) => rateToInr.get(c) ?? 1

  // 2. Internal cost + extra-task count — two set-queries over covered tasks.
  const itemIds = retainerItems.map(i => i.id)
  const costByAgreement = new Map<string, number>()
  const extraByAgreement = new Map<string, number>()
  if (itemIds.length > 0) {
    const { data: covTasks } = await admin.from('tasks')
      .select('id, retainer_item_id, bill_as_extra')
      .in('retainer_item_id', itemIds).is('deleted_at', null)
      .gte('task_date', start).lte('task_date', end)
    const taskToAgreement = new Map<string, string>()
    for (const t of covTasks || []) {
      const it = itemById.get(t.retainer_item_id as string)
      if (!it) continue
      taskToAgreement.set(t.id, it.agreement_id)
      if (t.bill_as_extra) extraByAgreement.set(it.agreement_id, (extraByAgreement.get(it.agreement_id) || 0) + 1)
    }
    const taskIds = Array.from(taskToAgreement.keys())
    if (taskIds.length > 0) {
      const { data: scores } = await admin.from('contribution_scores')
        .select('task_id, earnings_inr').in('task_id', taskIds)
      for (const s of scores || []) {
        const agId = taskToAgreement.get(s.task_id as string)
        if (!agId) continue
        costByAgreement.set(agId, r2((costByAgreement.get(agId) || 0) + Number(s.earnings_inr || 0)))
      }
    }
  }

  // 3. Progress per client (bounded — only clients with active retainers).
  const clientIds = Array.from(new Set(agreements.map(a => a.client_id)))
  const progressByClient = new Map<string, Awaited<ReturnType<typeof loadClientMonthProgress>>>()
  await Promise.all(clientIds.map(async cid => {
    try { progressByClient.set(cid, await loadClientMonthProgress(cid, month)) }
    catch { progressByClient.set(cid, []) }
  }))

  // 4. Assemble per agreement.
  const out: RetainerAnalytics[] = []
  for (const ag of agreements) {
    const agItems = retainerItems.filter(i => i.agreement_id === ag.id)
    // Retainer analytics only — an active agreement with only one-time/package
    // items is not a retainer and must not inflate counts or the list.
    if (agItems.length === 0) continue
    const client = (ag.client as { name?: string; default_currency?: string | null; country?: string | null } | null)
    const currency = agItems[0]?.currency || client?.default_currency || 'INR'
    const progress = (progressByClient.get(ag.client_id) || []).find(p => p.agreementId === ag.id)

    const included = agItems.reduce((s, i) => s + Number(i.included_quantity ?? i.committed_quantity ?? 0), 0)
    const delivered = progress?.totalDelivered ?? 0
    const planned = progress?.totalPlanned ?? 0
    const remaining = Math.max(0, included - delivered)
    const utilisation = included > 0 ? r2((delivered / included) * 100) : 0

    // Allocated value uses each item's own generated unit value against its share.
    let allocValueDelivered = 0, allocValueRemaining = 0, hasAlloc = false
    for (const it of agItems) {
      const uv = it.allocated_unit_value
      if (uv == null) continue
      hasAlloc = true
      const itSummary = progress?.items.find(s => s.itemId === it.id)
      const itDelivered = itSummary?.delivered ?? 0
      const itIncluded = Number(it.included_quantity ?? it.committed_quantity ?? 0)
      allocValueDelivered = r2(allocValueDelivered + itDelivered * Number(uv))
      allocValueRemaining = r2(allocValueRemaining + Math.max(0, itIncluded - itDelivered) * Number(uv))
    }

    const monthlyRetainer = agItems.reduce((s, i) => s + Number(i.unit_price ?? 0), 0) || null
    const creativeAllocation = agItems.reduce((s, i) => s + Number(i.creative_allocation_amount ?? 0), 0) || null
    const managementAllocation = agItems.reduce((s, i) => s + Number(i.management_allocation_amount ?? 0), 0) || null
    // internalCost + grossMargin are in INR (the base cost currency). Creative
    // allocation is converted to INR just for the margin/percentage.
    const internalCost = costByAgreement.get(ag.id) ?? 0
    const creativeAllocInr = creativeAllocation != null ? creativeAllocation * rateFor(currency) : null
    const grossMargin = creativeAllocInr != null ? r2(creativeAllocInr - internalCost) : null
    const marginPct = grossMargin != null && creativeAllocInr ? r2((grossMargin / creativeAllocInr) * 100) : null

    out.push({
      agreementId: ag.id,
      agreementNumber: ag.agreement_number,
      title: ag.title,
      status: ag.status,
      clientId: ag.client_id,
      clientName: client?.name || 'Unknown',
      country: client?.country ?? null,
      currency,
      startDate: ag.start_date,
      endDate: ag.end_date,
      included, delivered, planned, remaining, utilisation,
      coverageHealth: coverageHealth(utilisation),
      extraTasks: extraByAgreement.get(ag.id) || 0,
      monthlyRetainer: pricingVisible ? monthlyRetainer : null,
      monthlyRetainerInr: pricingVisible && monthlyRetainer != null ? r2(monthlyRetainer * rateFor(currency)) : null,
      creativeAllocation: pricingVisible ? creativeAllocation : null,
      creativeAllocationInr: pricingVisible ? creativeAllocInr : null,
      managementAllocation: pricingVisible ? managementAllocation : null,
      allocatedUnitValue: pricingVisible ? (agItems.find(i => i.allocated_unit_value != null)?.allocated_unit_value ?? null) : null,
      allocatedValueDelivered: pricingVisible && hasAlloc ? allocValueDelivered : null,
      allocatedValueRemaining: pricingVisible && hasAlloc ? allocValueRemaining : null,
      internalCost: pricingVisible ? internalCost : null,
      grossMargin: pricingVisible ? grossMargin : null,
      marginPct: pricingVisible ? marginPct : null,
      financialHealth: pricingVisible ? financialHealth(grossMargin, marginPct) : null,
    })
  }
  return out
}
