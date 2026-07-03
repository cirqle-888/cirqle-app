/**
 * Advertising — allocation-based billing engine (server-only).
 *
 * The agency funds ad platforms in advance (a Cashbook outflow), then allocates
 * portions of that entry to client campaigns (ad_fund_allocations). Billing is
 * derived from the ACTUAL allocated funds (GST-inclusive, what was really paid),
 * not the estimated campaign budget and not the platform-reported spend:
 *
 *     basis          = Σ active allocations   (fallback: ad_budget_amount)
 *     service charge = computeServiceCharge(basis, type, value)
 *
 * recomputeCampaignBilling() re-derives the campaign task's billing_amount and
 * resyncs the campaign's draft invoice. The DB trigger auto_attach_task_to_invoice
 * then propagates the new billing onto any monthly draft invoice line, so no
 * manual invoice edits are ever needed.
 *
 * Everything here is best-effort against optional migrations: if the
 * ad_fund_allocations table hasn't been applied yet, billing silently keeps the
 * previous estimated-budget behaviour.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { computeBudgetTotals, computeServiceCharge } from './budget'
import { PLATFORM_LABEL } from './types'

const round2 = (v: number) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100

/** Convert an amount to INR via exchange_rates (mirrors tasks/actions.ts toInr). */
export async function toInr(admin: SupabaseClient, amount: number, currency?: string | null): Promise<number> {
  if (!currency || currency === 'INR') return amount
  const { data } = await admin.from('exchange_rates').select('rate_to_inr').eq('currency', currency).maybeSingle()
  const rate = (data as any)?.rate_to_inr ?? 1
  return round2(amount * rate)
}

/** Convert an INR amount into another currency via exchange_rates. */
async function fromInr(admin: SupabaseClient, amountInr: number, currency?: string | null): Promise<number> {
  if (!currency || currency === 'INR') return amountInr
  const { data } = await admin.from('exchange_rates').select('rate_to_inr').eq('currency', currency).maybeSingle()
  const rate = Number((data as any)?.rate_to_inr) || 1
  return round2(amountInr / rate)
}

export interface AllocationBasis {
  /** True when at least one active allocation exists for the project. */
  hasAllocations: boolean
  /** Σ active allocations, normalised to INR. */
  allocatedInr: number
  /** Σ active allocations, in the given target currency. */
  allocatedNative: number
}

/**
 * Sums the campaign's active fund allocations. Reads the wallet ledger
 * (campaign_allocation debits) first; falls back to the legacy direct
 * ad_fund_allocations table (kept alive for clientless projects / pre-ledger
 * installs). Returns hasAllocations=false when there are none anywhere so
 * callers can fall back to the estimated budget.
 */
export async function getAllocationBasis(
  admin: SupabaseClient, projectId: string, targetCurrency: string,
): Promise<AllocationBasis> {
  try {
    // 1) Wallet ledger: client wallet → campaign debits.
    try {
      const { data, error } = await admin
        .from('ad_wallet_ledger')
        .select('amount_inr')
        .eq('ad_project_id', projectId)
        .eq('direction', 'debit')
        .is('deleted_at', null)
      if (!error && data && data.length > 0) {
        const allocatedInr = round2(data.reduce((s, r: any) => s + Number(r.amount_inr || 0), 0))
        return { hasAllocations: true, allocatedInr, allocatedNative: await fromInr(admin, allocatedInr, targetCurrency) }
      }
    } catch { /* ledger not migrated yet */ }

    // 2) Legacy direct entry→campaign allocations.
    const { data, error } = await admin
      .from('ad_fund_allocations')
      .select('amount, amount_inr')
      .eq('ad_project_id', projectId)
      .is('deleted_at', null)
    if (error || !data || data.length === 0) {
      return { hasAllocations: false, allocatedInr: 0, allocatedNative: 0 }
    }
    const allocatedInr = round2(data.reduce((s, r: any) => s + Number(r.amount_inr || 0), 0))
    const allocatedNative = await fromInr(admin, allocatedInr, targetCurrency)
    return { hasAllocations: true, allocatedInr, allocatedNative }
  } catch {
    return { hasAllocations: false, allocatedInr: 0, allocatedNative: 0 }
  }
}

/**
 * Re-derives the campaign task's billing from the latest allocation basis and
 * resyncs the campaign's draft invoice. Call after ANY event that changes the
 * basis: allocation added/removed, service charge % edited, funding entry
 * deleted. Never throws.
 */
export async function recomputeCampaignBilling(admin: SupabaseClient, projectId: string): Promise<void> {
  try {
    const { data: project } = await admin
      .from('ad_projects').select('*')
      .eq('id', projectId).is('deleted_at', null).maybeSingle()
    if (!project) return

    const currency = (project as any).ad_budget_currency || 'INR'
    const basis = await getAllocationBasis(admin, projectId, currency)
    const spendBasis = basis.allocatedNative
    const serviceCharge = computeServiceCharge(
      spendBasis, (project as any).service_charge_type, Number((project as any).service_charge_value || 0),
    )

    // The campaign's billing task = the earliest-linked task (created with the
    // campaign; extra tasks added later are work items, not the billing line).
    const { data: link } = await admin
      .from('ad_project_tasks').select('task_id')
      .eq('project_id', projectId)
      .order('created_at', { ascending: true }).limit(1).maybeSingle()

    if ((link as any)?.task_id) {
      const billingInr = await toInr(admin, serviceCharge, currency)
      // The auto_attach_task_to_invoice trigger propagates this onto any
      // draft/reviewed monthly invoice line and recalculates its totals.
      await admin.from('tasks').update({
        billing_amount: serviceCharge,
        billing_amount_inr: billingInr,
        updated_at: new Date().toISOString(),
      }).eq('id', (link as any).task_id)
    }

    await resyncInvoiceForProject(admin, projectId)
  } catch { /* best-effort — never block the calling action */ }
}

/** Recompute the linked draft invoice's service-charge + ad-spend lines. No-op if none. */
export async function resyncInvoiceForProject(admin: SupabaseClient, projectId: string): Promise<void> {
  try {
    const { data: project } = await admin.from('ad_projects')
      .select('*, client:clients(default_currency)').eq('id', projectId).maybeSingle()
    if (!project) return
    const { data: inv } = await admin.from('invoices')
      .select('id, status').eq('ad_project_id', projectId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    // Only touch a draft we created — never edit a sent/paid invoice.
    if (!inv || (inv as any).status !== 'draft') return
    await writeInvoiceLines(admin, projectId, (inv as any).id, project)
  } catch { /* invoice tables not migrated / transient */ }
}

/**
 * Write (insert-or-update) the agency service-charge item + ad-spend section
 * for a project's invoice. The ad-spend basis is the allocated funds when any
 * exist, else the estimated budget.
 */
export async function writeInvoiceLines(
  admin: SupabaseClient, projectId: string, invoiceId: string, project: any,
): Promise<void> {
  const currency = project.ad_budget_currency || project.client?.default_currency || 'INR'
  const basis = await getAllocationBasis(admin, projectId, currency)
  const totals = computeBudgetTotals({
    adBudget: basis.hasAllocations ? basis.allocatedNative : Number(project.ad_budget_amount || 0),
    serviceChargeType: project.service_charge_type,
    serviceChargeValue: Number(project.service_charge_value || 0),
    taxPercent: Number(project.tax_percent || 0),
  })

  // Agency service charge → normal invoice item (matched by description prefix).
  const { data: scItem } = await admin.from('invoice_items')
    .select('id').eq('invoice_id', invoiceId).ilike('description', 'Agency Service Charge%').limit(1).maybeSingle()
  const scDesc = `Agency Service Charge — ${project.campaign_name}`
  if (scItem) {
    await admin.from('invoice_items').update({
      description: scDesc, unit_price: totals.serviceCharge, total: totals.serviceCharge, currency,
    }).eq('id', (scItem as any).id)
  } else if (totals.serviceCharge > 0) {
    await admin.from('invoice_items').insert({
      invoice_id: invoiceId, description: scDesc, quantity: 1,
      unit_price: totals.serviceCharge, total: totals.serviceCharge, currency, display_order: 0,
    })
  }

  // Advertising spend → separate section (allocated funds when available).
  const adInr = basis.hasAllocations ? basis.allocatedInr : await toInr(admin, totals.adSpend, currency)
  const adDesc = `${PLATFORM_LABEL[project.platform] || 'Advertising'} Ad Spend — ${project.campaign_name}`
  const { data: adItem } = await admin.from('invoice_ad_spend_items')
    .select('id').eq('invoice_id', invoiceId).eq('ad_project_id', projectId).limit(1).maybeSingle()
  if (adItem) {
    await admin.from('invoice_ad_spend_items').update({
      description: adDesc, amount: totals.adSpend, amount_inr: adInr, currency,
    }).eq('id', (adItem as any).id)
  } else {
    await admin.from('invoice_ad_spend_items').insert({
      invoice_id: invoiceId, ad_project_id: projectId, description: adDesc,
      amount: totals.adSpend, amount_inr: adInr, currency, display_order: 0,
    })
  }

  // Invoice grand total = agency service + ad spend (the true amount owed).
  await admin.from('invoices')
    .update({ total_amount: totals.subtotal, updated_at: new Date().toISOString() })
    .eq('id', invoiceId)
}
