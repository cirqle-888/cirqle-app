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

/**
 * Do two projects' ad-account ids refer to the same campaign owner?
 *
 * A platform campaign id is unique on the platform, so two live projects
 * carrying the same one are the same campaign. The account id only has to
 * AGREE — and a project imported before ad accounts were recorded carries
 * none, so a null on either side agrees with anything.
 *
 * Requiring both ids to be present (the rule until 2026-11-09) let a
 * re-import of a pre-account campaign look like a brand-new campaign: both
 * copies counted as owners, and the client could be billed the spend and the
 * service charge twice for one campaign.
 */
export function sharesAdAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  return !a || !b || a === b
}

/** The set of those task ids that are not in the trash. */
export async function liveTaskIds(admin: SupabaseClient, ids: readonly string[]): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set()
  const { data, error } = await admin.from('tasks').select('id').in('id', [...ids]).is('deleted_at', null)
  // Pre-soft-delete schema: there is no deleted_at, so nothing is deleted.
  if (error) return new Set(ids)
  return new Set(asRows<{ id: string }>(data).map(t => t.id))
}

/** A project among several for one campaign, as the ownership rule sees it. */
export interface CampaignProjectRef {
  id: string
  created_at: string
  /** Does it still have a live task to put the service charge on? */
  hasLiveBillingTask?: boolean
}

/**
 * Which of several projects for one campaign is allowed to bill it.
 *
 * In order:
 *   1. a project that CAN bill — one with a live billing task. Billing never
 *      moves off a project that has been charging the client onto an empty
 *      re-import: that would leave the old task's money stranded on the list
 *      and write the same fee again on a new one.
 *   2. among those, the project the campaign registry maps the campaign to,
 *   3. else the oldest of them.
 *
 * With no billable project anywhere, the registry pointer and then age decide,
 * which is what the rule has always been.
 *
 * Sorts defensively rather than trusting the caller's order — "oldest" is half
 * the rule, and getting it wrong silently moves a client's billing.
 */
export function campaignOwnerId(
  live: readonly CampaignProjectRef[],
  registryProjectId?: string | null,
): string | null {
  if (live.length === 0) return null
  const billable = live.filter(p => p.hasLiveBillingTask)
  const pool = billable.length > 0 ? billable : live
  const ordered = [...pool].sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
  if (registryProjectId && ordered.some(p => p.id === registryProjectId)) return registryProjectId
  return ordered[0].id
}

/** project id → does it still have a live task the service charge can land on? */
export async function projectsWithLiveTask(
  admin: SupabaseClient, projectIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (projectIds.length === 0) return new Set()
  const { data } = await admin.from('ad_project_tasks')
    .select('project_id, task_id').in('project_id', [...projectIds])
  const links = asRows<{ project_id: string; task_id: string | null }>(data)
    .filter(l => !!l.task_id)
  const live = await liveTaskIds(admin, links.map(l => l.task_id as string))
  return new Set(links.filter(l => live.has(l.task_id as string)).map(l => l.project_id))
}

/**
 * Several live projects can point at the same platform campaign (e.g. a
 * second "Create Single Project" for a campaign that already had one, or a
 * re-import of one mapped before ad accounts were recorded). Only ONE may
 * bill it, or the client is invoiced the spend — and the service charge —
 * once per project. The owner is the project the campaign registry maps it
 * to; failing that, the oldest live project. True for every other one.
 */
export async function isDuplicateCampaignProject(admin: SupabaseClient, project: SpendProject): Promise<boolean> {
  const cid = project.provider_metadata?.campaign_id
  if (cid == null) return false
  // Matched on the campaign id alone, then narrowed by account: a project
  // with no ad_account_id has to be able to find its re-imported twin, which
  // an `.eq('ad_account_id', …)` filter in the query could never return.
  const { data } = await admin.from('ad_projects').select('id, created_at, ad_account_id')
    .eq('provider_metadata->>campaign_id', String(cid))
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
  const siblings = asRows<{ id: string; created_at: string; ad_account_id: string | null }>(data)
    .filter(p => sharesAdAccount(p.ad_account_id, project.ad_account_id))
  if (siblings.length <= 1) return false
  const { data: reg } = await admin.from('ad_campaigns').select('project_id, ad_account_id')
    .eq('external_campaign_id', String(cid))
  const regId = asRows<{ project_id: string | null; ad_account_id: string | null }>(reg)
    .find(r => sharesAdAccount(r.ad_account_id, project.ad_account_id))?.project_id
  const billable = await projectsWithLiveTask(admin, siblings.map(p => p.id))
  const live = siblings.map(p => ({ ...p, hasLiveBillingTask: billable.has(p.id) }))
  return campaignOwnerId(live, regId) !== project.id
}

/** Daily spend (excl. GST, INR) for one campaign. Empty for a duplicate project. */
export async function getCampaignSpend(admin: SupabaseClient, project: SpendProject): Promise<CampaignSpendDay[]> {
  if (await isDuplicateCampaignProject(admin, project)) return []
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

    // A duplicate project never bills — and takes back any lines it already
    // put on a draft invoice (sent/paid invoices are never touched).
    if (await isDuplicateCampaignProject(admin, project)) {
      const { data: mine } = await admin.from('invoice_expense_items')
        .select('id, invoice_id, invoice:invoices(status)')
        .eq('kind', 'ad_spend').eq('ad_project_id', projectId)
      let removed = 0
      for (const l of asRows<ExpenseLineRow>(mine)) {
        const inv = one(l.invoice)
        if (!inv || !['draft', 'reviewed'].includes(inv.status)) continue
        await admin.from('invoice_expense_items').delete().eq('id', l.id)
        await admin.rpc('recalc_invoice_totals', { p_invoice_id: l.invoice_id })
        removed++
      }
      return removed
    }

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
