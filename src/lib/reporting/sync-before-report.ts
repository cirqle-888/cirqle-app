import { createAdminClient } from '@/lib/supabase/server'
import { syncProjectWorker } from '@/lib/advertising/workers/sync'
import type { DequeuedJob } from '@/lib/jobs/engine'
import type { ReportConfig } from './types'

/** Explicitly await provider backfill; rendering cannot race it. No wallet writes. */
export async function syncBeforeReport(config: ReportConfig, jobId: string): Promise<void> {
  const admin = createAdminClient()
  const ids = config.projectIds?.length ? config.projectIds : [config.projectId]
  const { data: projects, error } = await admin.from('ad_projects')
    .select('id, client_id, ad_account_id, sync_enabled').in('id', ids).is('deleted_at', null)
  if (error || !projects || projects.length !== ids.length || projects.some(p => p.client_id !== config.clientId)) throw new Error('Report campaign scope could not be verified.')
  for (const project of projects) {
    if (!project.ad_account_id || !project.sync_enabled) continue // manual data stays authoritative
    const ranges = [{ start_date: config.dateFrom, end_date: config.dateTo }]
    if (config.comparisonFrom && config.comparisonTo) ranges.push({ start_date: config.comparisonFrom, end_date: config.comparisonTo })
    for (const range of ranges) await syncProjectWorker({
      id: jobId, job_type: 'advertising_sync_project', attempts: 0, queued_at: new Date().toISOString(), error_log: '',
      payload: { project_id: project.id, ...range, suppress_notifications: true },
    } as DequeuedJob)
  }
}
