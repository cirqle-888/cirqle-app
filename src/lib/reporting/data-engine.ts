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
import { AD_SPEND_GST_RATE } from '@/lib/advertising/budget'
import { fetchPeriodReach, type PeriodReach } from '@/lib/advertising/period-reach'
import { assessDataQuality } from './data-quality'
import { todayISO, toISODate } from '@/lib/utils/local-date'

export interface FetchReportDataOptions {
  projectId: string
  /** Client report: 2+ campaigns of the same client, merged day by day. */
  projectIds?: string[]
  /** Internal: skip the provider period-reach call (client-report parts). */
  skipPeriodReach?: boolean
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
  const ids = [...new Set(opts.projectIds ?? [])]
  if (ids.length > 1) return fetchClientReportData({ ...opts, projectIds: ids })
  const admin = createAdminClient()

  // ── 1. Project + Client ─────────────────────────────────────────────────
  const { data: projectRow, error: projErr } = await admin
    .from('ad_projects')
    .select(`
      id, client_id, campaign_name, platform, campaign_type, status,
      ad_budget_amount, ad_budget_currency, service_charge_type,
      service_charge_value, tax_percent, objective, optimization_goal,
      budget_input_mode, daily_budget, budget_days,
      start_date, end_date, last_sync_at, last_sync_error, created_at,
      client:clients(id, name, code)
    `)
    .eq('id', opts.projectId)
    .is('deleted_at', null)
    .maybeSingle()

  if (projErr || !projectRow) {
    throw new Error(`Project not found: ${opts.projectId} — ${projErr?.message ?? 'null'}`)
  }

  const client = (projectRow.client as any) ?? {}
  // ── 1.5. Campaign Wallet Allocation, as of the report's end date ─────────
  // Only allocations made by the end of the reported period count, and spend
  // from BEFORE the period is netted off to give the opening balance. The old
  // code took every allocation ever made and subtracted only the in-period
  // spend, so a week-two report showed all-time funds minus week-two spend as
  // the "remaining" amount.
  const periodEnd = endOfBusinessDay(opts.dateTo)
  const { data: ledgerRows, error: ledgerErr } = await admin
    .from('ad_wallet_ledger')
    .select('amount_inr, created_at')
    .eq('ad_project_id', opts.projectId)
    .eq('direction', 'debit')
    .eq('kind', 'campaign_allocation')
    .is('deleted_at', null)
    .lte('created_at', periodEnd)

  if (ledgerErr) throw new Error(`Wallet allocation fetch failed: ${ledgerErr.message}`)
  const walletAllocation = ledgerRows?.reduce((sum, row) => sum + Number(row.amount_inr || 0), 0) ?? 0

  const priorSpend = await fetchSpendBefore(admin, opts.projectId, opts.dateFrom)
  const openingBalance = walletAllocation - priorSpend * (1 + AD_SPEND_GST_RATE)

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
    // Invoice/service-charge tax — legitimately 0 for most campaigns.
    // GST on Meta ad spend is a fixed platform rate (AD_SPEND_GST_RATE in
    // lib/advertising/budget.ts), NOT derived from this field.
    taxPercent: Number(projectRow.tax_percent ?? 0),
    budgetInputMode: projectRow.budget_input_mode ?? 'total',
    dailyBudgetConfigured: projectRow.daily_budget != null ? Number(projectRow.daily_budget) : null,
    budgetDaysConfigured: projectRow.budget_days != null ? Number(projectRow.budget_days) : null,
    objective: projectRow.objective,
    startDate: projectRow.start_date,
    endDate: projectRow.end_date,
    walletAllocation,
    priorSpend,
    openingBalance,
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

  // ── 5. Period-level unique reach (provider call; never throws) ─────────
  // Skipped when there is no delivery to ask about.
  const delivered = (rows: ReportMetricRow[]) => rows.some(r => r.impressions > 0)
  const noDelivery: PeriodReach = { available: false, reason: 'No delivery in this period.' }
  const [periodReach, comparisonPeriodReach] = await Promise.all([
    opts.skipPeriodReach ? Promise.resolve(noDelivery)
      : delivered(metrics) ? fetchPeriodReach(opts.projectId, opts.dateFrom, opts.dateTo) : Promise.resolve(noDelivery),
    opts.comparisonFrom && opts.comparisonTo && !opts.skipPeriodReach
      ? (delivered(comparisonMetrics) ? fetchPeriodReach(opts.projectId, opts.comparisonFrom, opts.comparisonTo) : Promise.resolve(noDelivery))
      : Promise.resolve(undefined),
  ])

  // ── 6. Coverage: zero-delivery days vs days with no data at all ───────
  // Without a start date, the first day the campaign ever recorded data is
  // its effective start; with no data at all, the day it was created in
  // Cirqle — days before a campaign existed are not "missing".
  const effectiveStart = projectRow.start_date
    ?? await fetchFirstMetricDate(admin, opts.projectId)
    ?? (projectRow.created_at ? toISODate(new Date(projectRow.created_at)) : null)
  const dataQuality = assessDataQuality({
    dateFrom: opts.dateFrom,
    dateTo: opts.dateTo,
    campaignStart: effectiveStart,
    campaignEnd: projectRow.end_date,
    today: todayISO(),
    rows: metrics,
    lastSyncAt: projectRow.last_sync_at ?? null,
    lastSyncError: projectRow.last_sync_error ?? null,
  })

  return { project, metrics, comparisonMetrics, branding, periodReach, comparisonPeriodReach, dataQuality }
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/** Last instant of a YYYY-MM-DD day on the India business calendar. */
function endOfBusinessDay(isoDate: string): string {
  return new Date(`${isoDate}T23:59:59.999+05:30`).toISOString()
}

/** The earliest metric date ever recorded for a project (null = none). */
async function fetchFirstMetricDate(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
): Promise<string | null> {
  const { data } = await admin
    .from('ad_daily_metrics')
    .select('metric_date')
    .eq('project_id', projectId)
    .order('metric_date', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data as { metric_date?: string } | null)?.metric_date ?? null
}

/** Ex-GST spend in base currency for every metric day before `dateFrom`. */
async function fetchSpendBefore(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
  dateFrom: string,
): Promise<number> {
  const { data, error } = await admin
    .from('ad_daily_metrics')
    .select('spend, exchange_rate_ad_to_base')
    .eq('project_id', projectId)
    .lt('metric_date', dateFrom)
  if (error) throw new Error(`Prior spend fetch failed: ${error.message}`)
  return (data ?? []).reduce(
    (sum: number, row: { spend: number | null; exchange_rate_ad_to_base: number | null }) =>
      sum + Number(row.spend ?? 0) * Number(row.exchange_rate_ad_to_base ?? 1),
    0,
  )
}

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
      'conversions, messages, purchases, landing_page_views, exchange_rate_ad_to_base'
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
    messages: row.messages == null ? null : Number(row.messages),
    purchases: row.purchases == null ? null : Number(row.purchases),
    landingPageViews: row.landing_page_views == null ? null : Number(row.landing_page_views),
    exchangeRate: Number(row.exchange_rate_ad_to_base ?? 1),
  }))
}

// ─── Client report (several campaigns) ────────────────────────────────────────

/**
 * Loads each campaign exactly as a single-campaign report would (same
 * currency conversion, allocations, coverage), then merges them:
 *
 *   • daily rows are summed per date; a result column is null for a date
 *     only when NO campaign recorded it that day;
 *   • money (allocations, prior spend, opening balance, budget) is summed —
 *     all of it is already in base currency;
 *   • objective is the shared one, or 'mixed' when they differ (results are
 *     then only shown per campaign);
 *   • unique reach is NOT claimed: Meta cannot de-duplicate people across
 *     separately-fetched campaigns, so period reach is marked unavailable and
 *     the daily sum is labelled as such.
 */
async function fetchClientReportData(opts: FetchReportDataOptions & { projectIds: string[] }): Promise<ReportRawData> {
  const parts = await Promise.all(opts.projectIds.map(projectId =>
    fetchReportData({ ...opts, projectId, projectIds: undefined, skipPeriodReach: true })))
  return mergeReportParts(parts, Boolean(opts.comparisonFrom))
}

/** Pure merge of per-campaign raw data into one client report (see above). */
export function mergeReportParts(parts: ReportRawData[], withComparison: boolean): ReportRawData {
  const clientIds = new Set(parts.map(p => p.project.clientId))
  if (clientIds.size !== 1) throw new Error('A client report can only include one client\'s campaigns.')

  const first = parts[0]
  const types = new Set(parts.map(p => p.project.campaignType ?? null))
  const platforms = [...new Set(parts.map(p => p.project.platform))]
  const sum = (f: (p: ReportProject) => number | undefined | null) =>
    parts.reduce((t, p) => t + Number(f(p.project) ?? 0), 0)
  const minDate = (vals: (string | null)[]) => vals.some(v => !v) ? null : vals.reduce((a, b) => (a! < b! ? a : b), vals[0])
  const maxDate = (vals: (string | null)[]) => vals.some(v => !v) ? null : vals.reduce((a, b) => (a! > b! ? a : b), vals[0])

  const project: ReportProject = {
    ...first.project,
    id: first.project.id,
    campaignName: `${first.project.clientName} — ${parts.length} campaigns`,
    platform: platforms.join(' + '),
    campaignType: types.size === 1 ? [...types][0] : 'mixed',
    objective: null,
    status: parts.some(p => p.project.status === 'active') ? 'active' : first.project.status,
    adBudget: sum(p => p.adBudget),
    dailyBudgetConfigured: null,
    budgetDaysConfigured: null,
    startDate: minDate(parts.map(p => p.project.startDate)),
    endDate: maxDate(parts.map(p => p.project.endDate)),
    walletAllocation: sum(p => p.walletAllocation),
    priorSpend: sum(p => p.priorSpend),
    openingBalance: parts.reduce((t, p) => t + (p.project.openingBalance ?? p.project.walletAllocation), 0),
  }

  const merge = (lists: ReportMetricRow[][]): ReportMetricRow[] => {
    const byDate = new Map<string, ReportMetricRow>()
    const addNullable = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0))
    for (const r of lists.flat()) {
      const m = byDate.get(r.date)
      if (!m) { byDate.set(r.date, { ...r, exchangeRate: 1 }); continue }
      m.spend += r.spend; m.revenue += r.revenue; m.impressions += r.impressions; m.clicks += r.clicks
      m.reach += r.reach; m.leads += r.leads; m.conversions += r.conversions
      m.messages = addNullable(m.messages, r.messages)
      m.purchases = addNullable(m.purchases, r.purchases)
      m.landingPageViews = addNullable(m.landingPageViews, r.landingPageViews)
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  }

  const qs = parts.map(p => p.dataQuality).filter((q): q is NonNullable<typeof q> => !!q)
  const dataQuality = qs.length ? {
    expectedDays: qs.reduce((t, q) => t + q.expectedDays, 0),
    recordedDays: qs.reduce((t, q) => t + q.recordedDays, 0),
    zeroDeliveryDays: qs.reduce((t, q) => t + q.zeroDeliveryDays, 0),
    missingDates: [...new Set(qs.flatMap(q => q.missingDates))].sort().slice(0, 31),
    missingCount: qs.reduce((t, q) => t + q.missingCount, 0),
    includesToday: qs.some(q => q.includesToday),
    lastSyncAt: qs.map(q => q.lastSyncAt).filter(Boolean).sort()[0] ?? null,
    lastSyncError: qs.map(q => q.lastSyncError).find(Boolean) ?? null,
  } : undefined

  const multi: PeriodReach = { available: false, reason: 'Unique reach across several campaigns is not available; daily reach is summed.' }
  return {
    project,
    metrics: merge(parts.map(p => p.metrics)),
    comparisonMetrics: merge(parts.map(p => p.comparisonMetrics)),
    branding: first.branding,
    periodReach: multi,
    comparisonPeriodReach: withComparison ? multi : undefined,
    dataQuality,
    campaigns: parts.map(p => ({ project: p.project, metrics: p.metrics })),
  }
}
