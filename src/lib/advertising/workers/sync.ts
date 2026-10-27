import { DequeuedJob, enqueueJob } from '@/lib/jobs/engine'
import { createAdminClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/advertising/providers'
import { ingestMetrics } from '@/lib/advertising/pipeline'
import { decryptToken } from '@/lib/integrations/tokens'
import { toISODate, addDaysISO } from '@/lib/utils/local-date'
import { daySpan, isISODate } from '@/lib/reporting/config'
import { recomputeCampaignBilling } from '@/lib/advertising/billing'
import { syncCampaignAdSpendLines } from '@/lib/advertising/ad-spend-invoicing'


export async function syncProjectWorker(job: DequeuedJob): Promise<any> {
  const { project_id } = job.payload
  if (!project_id) throw new Error('Missing project_id in job payload')

  const admin = createAdminClient()

  // 1. Fetch active ad_project with sync_enabled = true and an assigned ad_account_id
  const { data: project, error: projErr } = await admin
    .from('ad_projects')
    .select(`
      id, client_id, provider_metadata,
      ad_account:ad_accounts (
        id, provider, account_id, currency,
        connection:provider_connections ( access_token, status )
      )
    `)
    .eq('id', project_id)
    .single()

  if (projErr || !project) {
    throw new Error(`Project ${project_id} not found or query failed.`)
  }

  const account = Array.isArray(project.ad_account) ? project.ad_account[0] : project.ad_account
  if (!account || !account.connection) throw new Error(`Project ${project_id} missing ad_account or connection.`)

  const connection = Array.isArray(account.connection) ? account.connection[0] : account.connection
  if (!connection) throw new Error(`Project ${project_id} missing connection array.`)

  const providerName = account.provider
  const accessToken = decryptToken(connection.access_token)

  if (!accessToken || connection.status !== 'active') {
    throw new Error('No active connection or access token')
  }

  const provider = getProvider(providerName)

  // Default: a trailing 7-day window. A backfill job passes start_date /
  // end_date to fill days that were never synced (or synced before an action
  // type was imported, which left messages/purchases NULL).
  const range = syncRange(job.payload, new Date())
  if ('error' in range) throw new Error(range.error)
  const { startDate, endDate } = range

  const pStartedAt = new Date().toISOString()
  await admin.from('ad_projects').update({ sync_status: 'running' }).eq('id', project.id)

  try {
    // Fetch metrics
    const metrics = await provider.getCampaignInsights(
      account.account_id,
      accessToken,
      project.provider_metadata,
      startDate,
      endDate
    )

    // Convert to IngestRow
    const rows = metrics.map((m: any) => ({
      projectId: project.id,
      metricDate: m.metric_date,
      spend: m.spend,
      revenue: m.revenue || 0,
      impressions: m.impressions,
      clicks: m.clicks,
      reach: m.reach || 0,
      leads: m.leads || 0,
      messages: m.messages,
      purchases: m.purchases,
      landingPageViews: m.landing_page_views,
      adCurrency: account.currency
    }))

    let imported = 0
    let updated = 0
    if (rows.length > 0) {
      const result = await ingestMetrics(`${providerName} API`, null, rows)
      if (result.failed > 0) throw new Error(`${result.failed} metric rows could not be imported. Check currency rates and sync errors.`)
      imported = result.imported
      updated = result.updated
    }

    const pFinishedAt = new Date().toISOString()
    const durationMs = new Date(pFinishedAt).getTime() - new Date(pStartedAt).getTime()

    // Mark the project synced + stamp the campaign registry (drives the
    // mapping UI's sync column). ad_campaigns may not exist pre-migration.
    await admin.from('ad_projects').update({
      sync_status: 'idle',
      last_sync_at: pFinishedAt,
      last_sync_error: null,
    }).eq('id', project.id)
    await admin.from('ad_campaigns')
      .update({ last_synced_at: pFinishedAt })
      .eq('project_id', project.id)
      .then(null, () => {})

    // Log sync success
    const { error: logErr } = await admin.from('ad_sync_logs').insert({
      project_id: project.id,
      provider: providerName,
      status: 'success',
      started_at: pStartedAt,
      finished_at: pFinishedAt,
      duration_ms: durationMs,
      records_imported: imported + updated,
      trigger_source: 'manual',
    })
    if (logErr) console.error('[syncProjectWorker] Failed to write sync log:', logErr)

    // Spend changed → re-derive the spend-based billing (service charge) and
    // the campaign's monthly ad-spend invoice lines. Both best-effort.
    await recomputeCampaignBilling(admin, project.id)
    await syncCampaignAdSpendLines(admin, project.id)

    // Enqueue dependent notifications and reports
    if (!job.payload.suppress_notifications) await enqueueJob({
      job_type: 'advertising_send_notification',
      parent_job_id: job.id,
      payload: { project_id: project.id }
    })

    return { rows_fetched: metrics.length, imported, updated, durationMs }
  } catch (err: any) {
    // Surface the failure on the project so the mapping/sync UI shows it.
    await admin.from('ad_projects').update({
      sync_status: 'error',
      last_sync_error: err?.message ?? 'Sync failed',
    }).eq('id', project.id).then(null, () => {})
    await admin.from('ad_sync_logs').insert({
      project_id: project.id,
      provider: providerName,
      status: 'error',
      started_at: pStartedAt,
      finished_at: new Date().toISOString(),
      error_message: err?.message ?? 'Sync failed',
      trigger_source: 'manual',
    }).then(null, () => {})
    throw err
  }
}

/** Longest backfill one job may request; Meta keeps ~37 months of insights. */
export const MAX_SYNC_RANGE_DAYS = 400

/** The date window for a sync job: explicit start/end, or the last 7 days. */
export function syncRange(
  payload: { start_date?: unknown; end_date?: unknown } | null | undefined,
  now: Date,
): { startDate: string; endDate: string } | { error: string } {
  const today = toISODate(now)
  if (payload?.start_date == null && payload?.end_date == null) {
    return { startDate: addDaysISO(today, -7), endDate: today }
  }
  const startDate = payload?.start_date
  const endDate = payload?.end_date ?? today
  if (!isISODate(startDate) || !isISODate(endDate)) return { error: 'Invalid sync date range' }
  if (startDate > endDate) return { error: 'Sync start date is after end date' }
  const end = endDate > today ? today : endDate
  if (daySpan(startDate, end) > MAX_SYNC_RANGE_DAYS) {
    return { error: `A sync can cover at most ${MAX_SYNC_RANGE_DAYS} days` }
  }
  return { startDate, endDate: end }
}
