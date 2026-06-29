/**
 * Report Generation Worker
 *
 * Handles the 'advertising_generate_report' job type.
 * Payload = ReportConfig (see src/lib/reporting/types.ts).
 *
 * Called by the background job processor in src/lib/jobs/worker.ts.
 */

import { DequeuedJob } from '@/lib/jobs/engine'
import { generateReport } from '@/lib/reporting/orchestrator'
import type { ReportConfig } from '@/lib/reporting/types'

export async function generateReportWorker(job: DequeuedJob): Promise<any> {
  const config = job.payload as ReportConfig

  if (!config.projectId) throw new Error('Missing projectId in report job payload')
  if (!config.clientId)  throw new Error('Missing clientId in report job payload')
  if (!config.dateFrom)  throw new Error('Missing dateFrom in report job payload')
  if (!config.dateTo)    throw new Error('Missing dateTo in report job payload')

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
    emailDelivered:   result.delivery.filter(d => d.emailDelivered).length,
  }
}
