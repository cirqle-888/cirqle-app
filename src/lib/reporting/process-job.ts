import { createAdminClient } from '@/lib/supabase/server'
import { completeJob, failJob, heartbeatJob, type DequeuedJob } from '@/lib/jobs/engine'
import { generateReportWorker } from '@/lib/advertising/workers/reports'

/** Wake only this authorised report job, never unrelated queued mutations. */
export async function processReportJob(jobId: string): Promise<void> {
  const admin = createAdminClient()
  const { data, error } = await admin.from('system_jobs')
    .update({ status: 'running', started_at: new Date().toISOString(), locked_at: new Date().toISOString() })
    .eq('id', jobId).eq('job_type', 'advertising_generate_report')
    .in('status', ['pending', 'queued']).lte('queued_at', new Date().toISOString()).select('*').maybeSingle()
  if (error || !data) return
  const job = data as DequeuedJob
  const heartbeat = setInterval(() => { void heartbeatJob(job.id).catch(() => undefined) }, 10_000)
  try {
    const outcome = await generateReportWorker(job)
    await completeJob(job, outcome)
  } catch (error) {
    await failJob(job, error instanceof Error ? error.message : 'Report failed')
  } finally {
    clearInterval(heartbeat)
  }
}
