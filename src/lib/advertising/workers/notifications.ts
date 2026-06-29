import { DequeuedJob } from '@/lib/jobs/engine'
import { createAdminClient } from '@/lib/supabase/server'

export async function sendNotificationWorker(job: DequeuedJob): Promise<any> {
  const { project_id } = job.payload
  if (!project_id) throw new Error('Missing project_id in job payload')

  const admin = createAdminClient()

  // 1. Fetch project and related client settings
  const { data: project, error: projErr } = await admin
    .from('ad_projects')
    .select('id, client_id')
    .eq('id', project_id)
    .single()

  if (projErr || !project) {
    throw new Error(`Project ${project_id} not found.`)
  }

  // In a real app we'd fetch `company_settings` here for alert thresholds
  // e.g. "budget_alert_threshold", "roas_alert_threshold"
  // For now, we mock reading from settings.

  return {
    evaluated: true,
    alerts_triggered: 0
  }
}
