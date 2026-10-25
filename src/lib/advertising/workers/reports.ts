/**
 * Report Generation Worker
 *
 * Handles the 'advertising_generate_report' job type.
 * Payload = ReportConfig (see src/lib/reporting/types.ts).
 *
 * Called by the background job processor in src/lib/jobs/worker.ts.
 */

import { DequeuedJob } from '@/lib/jobs/engine'
import { createAdminClient } from '@/lib/supabase/server'
import { generateReport } from '@/lib/reporting/orchestrator'
import type { ReportConfig } from '@/lib/reporting/types'

export async function generateReportWorker(job: DequeuedJob): Promise<any> {
  const config = job.payload as ReportConfig

  if (!config.projectId) throw new Error('Missing projectId in report job payload')
  if (!config.clientId)  throw new Error('Missing clientId in report job payload')
  if (!config.dateFrom)  throw new Error('Missing dateFrom in report job payload')
  if (!config.dateTo)    throw new Error('Missing dateTo in report job payload')

  // Old jobs predate atomic report creation. Reuse their UUID on every retry.
  if (!config.reportId) {
    const admin = createAdminClient()
    const { error } = await admin.from('ad_reports').upsert({
      id: job.id, project_id: config.projectId, client_id: config.clientId,
      report_type: config.reportType, template: config.template,
      date_from: config.dateFrom, date_to: config.dateTo,
      comparison_from: config.comparisonFrom ?? null, comparison_to: config.comparisonTo ?? null,
      generated_by: config.generatedBy ?? null, schedule_id: config.scheduleId ?? null,
      status: 'pending', config, job_id: job.id,
    }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw new Error('Could not recover report run.')
    config.reportId = job.id
  }
  const result = await generateReport(config)

  if (result.status === 'failed') {
    throw new Error(result.error ?? 'Report generation failed')
  }

  return {
    reportId:         result.reportId,
    status:           result.status,
    generationTimeMs: result.generationTimeMs,
    formats:          result.formats,
    exportCount:      result.exports.length,
    failedFormats:    result.failedFormats.map(f => f.format),
    emailAccepted:    result.delivery.filter(d => d.status === 'accepted').length,
    emailFailed:      result.delivery.filter(d => d.status === 'failed').length,
  }
}
