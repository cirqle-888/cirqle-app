/**
 * Report Data Engine
 *
 * Fetches all raw data needed to build a report for a given project
 * and date range. Provider-agnostic — works with any platform stored
 * in ad_daily_metrics.
 *
 * Outputs ReportRawData which is the single input to all downstream
 * engines (KPI, Branding, Template, Render).
 */

import { createAdminClient } from '@/lib/supabase/server'
import type { ReportRawData, ReportProject, ReportMetricRow } from './types'
import { resolveBrandConfig } from './branding-engine'

export interface FetchReportDataOptions {
  projectId: string
  clientId: string
  dateFrom: string    // YYYY-MM-DD (inclusive)
  dateTo: string      // YYYY-MM-DD (inclusive)
  comparisonFrom?: string
  comparisonTo?: string
}

/**
 * Primary data-fetch function. Called once per report generation.
 * All downstream engines operate on the returned ReportRawData.
 */
export async function fetchReportData(opts: FetchReportDataOptions): Promise<ReportRawData> {
  const admin = createAdminClient()

  // ── 1. Project + Client ─────────────────────────────────────────────────
  const { data: projectRow, error: projErr } = await admin
    .from('ad_projects')
    .select(`
      id, client_id, campaign_name, platform, campaign_type, status,
      ad_budget_amount, ad_budget_currency, service_charge_type,
      service_charge_value, tax_percent, objective, optimization_goal,
      start_date, end_date,
      client:clients(id, name, code)
    `)
    .eq('id', opts.projectId)
    .is('deleted_at', null)
    .maybeSingle()

  if (projErr || !projectRow) {
    throw new Error(`Project not found: ${opts.projectId} — ${projErr?.message ?? 'null'}`)
  }

  const client = (projectRow.client as any) ?? {}
  // ── 1.5. Fetch Campaign Wallet Allocation ──────────────────────────────────
  const { data: ledgerRows, error: ledgerErr } = await admin
    .from('ad_wallet_ledger')
    .select('amount_inr')
    .eq('ad_project_id', opts.projectId)
    .eq('direction', 'debit')
    .eq('kind', 'campaign_allocation')
    .is('deleted_at', null)

  const walletAllocation = ledgerRows?.reduce((sum, row) => sum + Number(row.amount_inr || 0), 0) ?? 0

  const project: ReportProject = {
    id: projectRow.id,
    clientId: projectRow.client_id ?? opts.clientId,
    clientName: client.name ?? 'Unknown Client',
    clientCode: client.code ?? '',
    campaignName: projectRow.campaign_name,
    platform: projectRow.platform,
    campaignType: projectRow.campaign_type,
    status: projectRow.status,
    adBudget: Number(projectRow.ad_budget_amount ?? 0),
    adBudgetCurrency: projectRow.ad_budget_currency ?? 'INR',
    serviceChargeType: projectRow.service_charge_type,
    serviceChargeValue: Number(projectRow.service_charge_value ?? 0),
    taxPercent: Number(projectRow.tax_percent) || 18,
    objective: projectRow.objective,
    startDate: projectRow.start_date,
    endDate: projectRow.end_date,
    walletAllocation,
  }

  // ── 2. Primary period metrics ───────────────────────────────────────────
  const metrics = await fetchMetrics(admin, opts.projectId, opts.dateFrom, opts.dateTo)

  // ── 3. Comparison period metrics ────────────────────────────────────────
  let comparisonMetrics: ReportMetricRow[] = []
  if (opts.comparisonFrom && opts.comparisonTo) {
    comparisonMetrics = await fetchMetrics(admin, opts.projectId, opts.comparisonFrom, opts.comparisonTo)
  }

  // ── 4. Branding ─────────────────────────────────────────────────────────
  const branding = await resolveBrandConfig(opts.clientId, client.name ?? 'Client')

  return { project, metrics, comparisonMetrics, branding }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

async function fetchMetrics(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
  dateFrom: string,
  dateTo: string,
): Promise<ReportMetricRow[]> {
  const { data, error } = await admin
    .from('ad_daily_metrics')
    .select(
      'metric_date, spend, revenue, impressions, clicks, reach, leads, ' +
      'conversions, exchange_rate_ad_to_base'
    )
    .eq('project_id', projectId)
    .gte('metric_date', dateFrom)
    .lte('metric_date', dateTo)
    .order('metric_date', { ascending: true })

  if (error) throw new Error(`Metrics fetch failed: ${error.message}`)

  return (data ?? []).map((row: any) => ({
    date: row.metric_date,
    spend: Number(row.spend ?? 0) * Number(row.exchange_rate_ad_to_base ?? 1),
    revenue: Number(row.revenue ?? 0) * Number(row.exchange_rate_ad_to_base ?? 1),
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    reach: Number(row.reach ?? 0),
    leads: Number(row.leads ?? 0),
    conversions: Number(row.conversions ?? 0),
    exchangeRate: Number(row.exchange_rate_ad_to_base ?? 1),
  }))
}
