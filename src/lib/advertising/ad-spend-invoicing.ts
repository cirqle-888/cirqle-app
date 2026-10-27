/**
 * Spend-based ad billing (server-only).
 *
 * Billing basis = ACTUAL platform spend incl. 18% GST — not the top-ups and
 * not the estimated budget. Unspent wallet money carries forward.
 *
 *   getCampaignSpend()        daily spend rows for one campaign, from the
 *                              account-level sync (ad_campaign_daily_spend)
 *                              when available, else the campaign's own synced
 *                              / manual metrics (ad_daily_metrics).
 *   syncCampaignAdSpendLines() one invoice line per campaign per month on the
 *                              client's monthly draft invoice:
 *                              "Meta ad spend — <campaign> — Oct 2026 (incl. 18% GST)"
 *                              kind='ad_spend' in invoice_expense_items, so
 *                              every existing total recalculation includes it.
 *
 * Safety rules: never edits a sent/paid invoice; only creates lines for the
 * current and previous month (older gaps show on the statement instead of
 * silently spawning drafts for closed months); company campaigns and
 * campaigns billed on their own invoice are skipped. Never throws.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { monthlySpendInclGst } from './funds-core'
import { PLATFORM_LABEL } from './types'
import { todayISO, addDaysISO } from '@/lib/utils/local-date'
import {
  one, asRows, asRow, num,
  type AdProjectLite, type CampaignSpendRow, type DailyMetricRow, type ExpenseLineRow, type InvoiceRef,
} from './funds-rows'

const r2 = (v: number) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100

export interface CampaignSpendDay { date: string; spendExGst: number }

/** The fields of an ad project the spend lookup needs. */
export type SpendProject = Pick<AdProjectLite, 'id' | 'ad_account_id' | 'provider_metadata'>

/** Daily spend (excl. GST, INR) for one campaign. */
export async function getCampaignSpend(admin: SupabaseClient, project: SpendProject): Promise<CampaignSpendDay[]> {
  const campaignId = project.provider_metadata?.campaign_id
  if (project.ad_account_id && campaignId != null) {
    const { data, error } = await admin.from('ad_campaign_daily_spend')
      .select('spend_date, spend')
      .eq('ad_account_id', project.ad_account_id)
      .eq('external_campaign_id', String(campaignId))
    const rows = asRows<CampaignSpendRow>(data)
    if (!error && rows.length) return rows.map(r => ({ date: r.spend_date, spendExGst: num(r.spend) }))
  }
  const { data } = await admin.from('ad_daily_metrics')
    .select('metric_date, spend, exchange_rate_ad_to_base')
    .eq('project_id', project.id)
  return asRows<DailyMetricRow>(data).map(r => ({
    date: r.metric_date,
    spendExGst: r2(num(r.spend) * (num(r.exchange_rate_ad_to_base) || 1)),
  }))
}

export interface SpendBasis {
  hasSpend: boolean
  spendExGstInr: number
  spendInclGstInr: number
}

export async function getSpendBasis(admin: SupabaseClient, project: SpendProject): Promise<SpendBasis> {
  try {
    const rows = await getCampaignSpend(admin, project)
    const ex = r2(rows.reduce((t, r) => t + r.spendExGst, 0))
    const incl = r2([...monthlySpendInclGst(rows).values()].reduce((t, v) => t + v, 0))
    return { hasSpend: ex > 0, spendExGstInr: ex, spendInclGstInr: incl }
  } catch {
    return { hasSpend: false, spendExGstInr: 0, spendInclGstInr: 0 }
  }
}

const monthLabel = (period: string) =>
  new Date(`${period}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })

const inCurrency = (inr: number, inv: Pick<InvoiceRef, 'currency' | 'exchange_rate'> | null) =>
  (inv?.currency || 'INR') === 'INR' ? inr : r2(inr / (num(inv?.exchange_rate) || 1))

/**
 * Upsert this campaign's monthly ad-spend lines on the client's draft
 * invoices. Returns the number of lines created or changed.
 */
export async function syncCampaignAdSpendLines(admin: SupabaseClient, projectId: string): Promise<number> {
  try {
    const { data: pData } = await admin.from('ad_projects')
      .select('id, campaign_name, client_id, ad_account_id, status, scope, platform, provider_metadata')
      .eq('id', projectId).is('deleted_at', null).maybeSingle()
    const project = asRow<AdProjectLite>(pData)
    if (!project || project.scope === 'company' || !project.client_id) return 0

    // Billed on its own campaign invoice (createInvoiceForProject) → leave it there.
    const { data: ownInv } = await admin.from('invoices').select('id')
      .eq('ad_project_id', projectId).neq('status', 'cancelled').limit(1).maybeSingle()
    if (ownInv) return 0

    const byMonth = monthlySpendInclGst(await getCampaignSpend(admin, project))
    const oldestAuto = addDaysISO(`${todayISO().slice(0, 7)}-01`, -1).slice(0, 7) // previous month

    const { data: existingData } = await admin.from('invoice_expense_items')
      .select('id, invoice_id, ad_period, amount_inr, invoice:invoices(status, currency, exchange_rate)')
      .eq('kind', 'ad_spend').eq('ad_project_id', projectId)
    const existing = asRows<ExpenseLineRow>(existingData)

    const platform = PLATFORM_LABEL[project.platform ?? ''] || 'Advertising'
    const name = project.campaign_name || 'Campaign'
    let changed = 0

    for (const [period, inclInr] of byMonth) {
      if (inclInr <= 0) continue
      const desc = `${platform} ad spend — ${name} — ${monthLabel(period)} (incl. 18% GST)`
      const line = existing.find(l => l.ad_period === period)

      if (line) {
        const inv = one(line.invoice)
        if (!inv || !['draft', 'reviewed'].includes(inv.status)) continue  // sent/paid: never touched
        if (Math.abs(num(line.amount_inr) - inclInr) < 0.005) continue
        const amount = inCurrency(inclInr, inv)
        await admin.from('invoice_expense_items').update({
          description: desc, amount, amount_inr: inclInr, original_amount: amount, original_amount_inr: inclInr,
        }).eq('id', line.id)
        await admin.rpc('recalc_invoice_totals', { p_invoice_id: line.invoice_id })
        changed++
        continue
      }

      if (period < oldestAuto) continue  // closed month — the statement flags it instead

      const { data: invoiceId, error: draftErr } = await admin.rpc('find_or_create_client_month_draft', {
        p_client_id: project.client_id, p_period: `${period}-01`, p_currency: 'INR', p_exchange_rate: 1,
      })
      if (draftErr || typeof invoiceId !== 'string') continue
      const { data: draftData } = await admin.from('invoices').select('status, currency, exchange_rate').eq('id', invoiceId).maybeSingle()
      const draft = asRow<InvoiceRef>(draftData)
      const amount = inCurrency(inclInr, draft)
      const { error } = await admin.from('invoice_expense_items').insert({
        invoice_id: invoiceId, kind: 'ad_spend', ad_project_id: projectId, ad_period: period,
        cashbook_entry_id: null, description: desc, currency: draft?.currency || 'INR',
        amount, amount_inr: inclInr, original_amount: amount, original_amount_inr: inclInr,
        markup_type: 'none', markup_value: 0, markup_amount: 0,
      })
      if (!error) {
        await admin.rpc('recalc_invoice_totals', { p_invoice_id: invoiceId })
        changed++
      }
    }
    return changed
  } catch {
    return 0
  }
}

/** Re-sync the ad-spend lines of every client campaign on one ad account. */
export async function syncAccountAdSpendLines(admin: SupabaseClient, accountRowId: string): Promise<number> {
  const { data } = await admin.from('ad_projects').select('id')
    .eq('ad_account_id', accountRowId).is('deleted_at', null)
  let n = 0
  for (const p of asRows<{ id: string }>(data)) n += await syncCampaignAdSpendLines(admin, p.id)
  return n
}
