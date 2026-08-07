/**
 * Retainer coverage — app-side read of the DB's task coverage state.
 *
 * `tasks.retainer_item_id` is auto-populated by a BEFORE trigger (migration
 * 20260728130000). A task is "covered" — i.e. NOT client-billable — when it has
 * a retainer item AND has not been flagged as extra work. This helper reads that
 * defensively so callers work even before the migration is applied (the columns
 * simply don't exist yet → treated as not covered).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadClientMonthProgress } from './server'

export interface TaskCoverage {
  covered: boolean
  retainerItemId: string | null
}

/** Rich coverage detail for the task modal's "Covered by Retainer" card. */
export interface RetainerCoverageInfo {
  agreementId: string
  agreementNumber: string
  itemId: string
  currency: string
  monthlyRetainer: number | null
  creativeAllocation: number | null
  managementAllocation: number | null
  allocatedUnitValue: number | null
  /** Internal per-task value paying contributors on covered work (item currency). */
  workUnitValue: number | null
  /** Employee-pool % override for this item's work; null = default 50. */
  workCommissionPct: number | null
  /** Client price per task when billed as extra work; null = not agreed. */
  extraUnitPrice: number | null
  includedQuantity: number | null
  delivered: number
  remaining: number
}

/**
 * Does an active retainer cover this client + service on this date? Uses the
 * same rule as the DB detection trigger (mapped service OR the item's own
 * service_id). Returns the operational figures for the card, or null if not
 * covered / unavailable. `pricingVisible=false` nulls the money fields so the
 * card can still show coverage + usage without leaking fees.
 */
export async function getRetainerCoverageInfo(
  admin: SupabaseClient,
  params: { clientId: string | null; serviceId: string | null; taskDate?: string | null; pricingVisible?: boolean },
): Promise<RetainerCoverageInfo | null> {
  const { clientId, serviceId, taskDate, pricingVisible = true } = params
  if (!clientId || !serviceId) return null
  const when = (taskDate && taskDate.slice(0, 10)) || new Date().toISOString().slice(0, 10)

  try {
    const { data: agreements } = await admin
      .from('client_agreements')
      .select('id, agreement_number, start_date, end_date')
      .eq('client_id', clientId).eq('status', 'active').is('deleted_at', null)
    if (!agreements || agreements.length === 0) return null

    const { data: items } = await admin
      .from('client_agreement_items')
      .select('id, agreement_id, service_id, unit_price, currency, committed_quantity, included_quantity, creative_allocation_amount, management_allocation_amount, allocated_unit_value, work_unit_value, work_commission_pct, extra_unit_price, effective_from, effective_to')
      .in('agreement_id', agreements.map(a => a.id)).eq('commitment_type', 'retainer')
    if (!items || items.length === 0) return null

    const { data: maps } = await admin
      .from('agreement_item_services').select('agreement_item_id, service_id')
      .in('agreement_item_id', items.map(i => i.id))
    const mappedItemIds = new Set((maps || []).filter(m => m.service_id === serviceId).map(m => m.agreement_item_id))

    const item = items.find(i => {
      const ag = agreements.find(a => a.id === i.agreement_id)
      if (!ag) return false
      const inTerm = i.effective_from <= when && (!i.effective_to || i.effective_to >= when)
        && ag.start_date <= when && (!ag.end_date || ag.end_date >= when)
      const svcMatch = i.service_id === serviceId || mappedItemIds.has(i.id)
      return inTerm && svcMatch
    })
    if (!item) return null
    const ag = agreements.find(a => a.id === item.agreement_id)!

    // Usage this month from the (money-independent) progress engine.
    let delivered = 0
    try {
      const prog = await loadClientMonthProgress(clientId, when.slice(0, 7))
      const summary = prog.find(p => p.agreementId === item.agreement_id)
      const itemSummary = summary?.items.find(it => it.itemId === item.id)
      delivered = itemSummary?.delivered ?? 0
    } catch { /* progress optional */ }

    const included = item.included_quantity ?? item.committed_quantity ?? null
    const remaining = included != null ? Math.max(0, included - delivered) : 0

    return {
      agreementId: item.agreement_id,
      agreementNumber: ag.agreement_number,
      itemId: item.id,
      currency: item.currency || 'INR',
      monthlyRetainer: pricingVisible ? (item.unit_price ?? null) : null,
      creativeAllocation: pricingVisible ? (item.creative_allocation_amount ?? null) : null,
      managementAllocation: pricingVisible ? (item.management_allocation_amount ?? null) : null,
      allocatedUnitValue: pricingVisible ? (item.allocated_unit_value ?? null) : null,
      workUnitValue: pricingVisible ? ((item as any).work_unit_value ?? null) : null,
      workCommissionPct: pricingVisible ? ((item as any).work_commission_pct ?? null) : null,
      extraUnitPrice: pricingVisible ? ((item as any).extra_unit_price ?? null) : null,
      includedQuantity: included,
      delivered,
      remaining,
    }
  } catch {
    return null
  }
}

export async function getTaskCoverage(admin: SupabaseClient, taskId: string): Promise<TaskCoverage> {
  try {
    const { data, error } = await admin
      .from('tasks')
      .select('retainer_item_id, bill_as_extra')
      .eq('id', taskId)
      .maybeSingle()
    if (error || !data) return { covered: false, retainerItemId: null }
    const itemId = (data as { retainer_item_id?: string | null }).retainer_item_id ?? null
    const extra = (data as { bill_as_extra?: boolean | null }).bill_as_extra ?? false
    return { covered: !!itemId && !extra, retainerItemId: itemId }
  } catch {
    return { covered: false, retainerItemId: null }
  }
}
