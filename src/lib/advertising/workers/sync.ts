import { DequeuedJob, enqueueJob } from '@/lib/jobs/engine'
import { createAdminClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/advertising/providers'
import { ingestMetrics } from '@/lib/advertising/pipeline'
import { triggerAIAnalysisDAG } from '@/lib/advertising/workers/ai'


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
  const accessToken = connection.access_token
  
  if (!accessToken || connection.status !== 'active') {
    throw new Error('No active connection or access token')
  }

  const provider = getProvider(providerName)

  // Sync a trailing 7 day window
  const d = new Date()
  const endDate = d.toISOString().split('T')[0]
  d.setDate(d.getDate() - 7)
  const startDate = d.toISOString().split('T')[0]

  const pStartedAt = new Date().toISOString()
  
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
    adCurrency: account.currency
  }))

  let imported = 0
  let updated = 0
  if (rows.length > 0) {
    const result = await ingestMetrics(`${providerName} API`, null, rows)
    imported = result.imported
    updated = result.updated
  }
  
  const pFinishedAt = new Date().toISOString()
  const durationMs = new Date(pFinishedAt).getTime() - new Date(pStartedAt).getTime()

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
  
  // Enqueue dependent notifications and reports
  await enqueueJob({
    job_type: 'advertising_send_notification',
    parent_job_id: job.id,
    payload: { project_id: project.id }
  })
  
  // E4: Automatically trigger AI Analysis DAG if AI is enabled
  if (project.provider_metadata?.ai_enabled !== false) {
    await triggerAIAnalysisDAG(project.id)
  }
  
  return { rows_fetched: metrics.length, imported, updated, durationMs }
}
