/** Stable report runs: persist the snapshot before exporting, retain successful
 * formats on retry, and never repeat an accepted or uncertain email attempt. */
import { createHash, randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/server'
import { syncBeforeReport } from './sync-before-report'
import { snapshotProblem } from './snapshot'
import { buildRenderData } from './render-engine'
import { generatePDF, generateImageBundle } from './exporters/pdf'
import { generateExcel } from './exporters/excel'
import { generateCSV } from './exporters/csv'
import { generateImagePortrait, generateImageSquare } from './exporters/image'
import { uploadExport, sendReportEmail, signDownloadUrl } from './delivery-engine'
import type { ReportConfig, RenderData, OrchestrationResult, ExportResult, DeliveryResult, ReportFormat, ExportFailure } from './types'

export interface QueuedReport { reportId: string; jobId: string; status: string }

export async function enqueueReportGeneration(config: ReportConfig, requestKey?: string): Promise<QueuedReport> {
  const admin = createAdminClient()
  // Schedule retries share one logical run; user actions use a client request ID.
  const key = config.scheduleId
    ? `schedule:${config.scheduleId}:${config.dateFrom}:${config.dateTo}:v1`
    : `manual:${config.generatedBy ?? 'server'}:${requestKey ?? randomUUID()}`
  const { data, error } = await admin.rpc('queue_ad_report', { p_config: config, p_request_key: key })
  if (error || !data) throw new Error('Could not queue the report. Please try again.')
  return data as QueuedReport
}

export async function generateReport(input: ReportConfig): Promise<OrchestrationResult> {
  const admin = createAdminClient()
  const started = Date.now()
  let reportId = input.reportId
  if (!reportId) {
    // Compatibility for old queued jobs: the worker supplies its own stable ID.
    const { data, error } = await admin.from('ad_reports').insert({
      project_id: input.projectId, client_id: input.clientId, report_type: input.reportType,
      template: input.template, date_from: input.dateFrom, date_to: input.dateTo,
      comparison_from: input.comparisonFrom ?? null, comparison_to: input.comparisonTo ?? null,
      generated_by: input.generatedBy ?? null, schedule_id: input.scheduleId ?? null,
      status: 'pending', config: input,
    }).select('id').single()
    if (error || !data) throw new Error('Could not create report.')
    reportId = data.id as string
  }
  const id = reportId
  const save = async (values: Record<string, unknown>) => {
    const { error } = await admin.from('ad_reports').update(values).eq('id', id)
    if (error) throw new Error('Could not save report progress.')
  }
  const { data: row, error } = await admin.from('ad_reports').select('*').eq('id', id).single()
  if (error || !row) throw new Error('Report not found.')
  const config = (row.config ?? input) as ReportConfig
  if (row.project_id !== input.projectId || row.client_id !== input.clientId) throw new Error('Report scope mismatch.')
  const exports: ExportResult[] = row.export_results ?? []
  const delivery: DeliveryResult[] = row.delivery_results ?? []
  const failedFormats: ExportFailure[] = []
  const result = (status: OrchestrationResult['status'], message?: string): OrchestrationResult => ({
    reportId: id, status, generationTimeMs: Date.now() - started, formats: config.formats,
    exports, failedFormats, delivery, ...(message ? { error: message } : {}),
  })
  if (row.status === 'ready') return result('ready')
  try {
    await save({ status: 'generating', stage: row.render_data ? 'exporting' : 'gathering_data', error_message: null })
    if (!row.render_data) {
      await save({ stage: 'syncing' })
      await syncBeforeReport(config, id)
    }
    const renderData: RenderData = row.render_data ?? await buildRenderData(config)
    const problem = snapshotProblem(renderData)
    if (problem && !config.allowIncomplete) {
      await save({ status: 'failed', stage: 'failed', error_message: problem })
      return result('failed', problem)
    }
    // Once stored, every format/retry uses exactly these figures and narrative.
    await save({ render_data: renderData, ai_narrative: renderData.ai, stage: 'exporting' })
    for (const format of config.formats) {
      if (exports.some(e => e.format === format)) continue
      let exported: ExportResult
      try {
        const buffer = await runExporter(format, renderData)
        exported = await uploadExport(id, format, buffer, renderData)
      } catch {
        failedFormats.push({ format, error: 'Could not create this format. Retry to try again.' })
        await save({ export_failures: failedFormats })
        continue
      }
      exports.push(exported)
      // Persist before starting another exporter or any external delivery.
      await save({ export_results: exports })
    }
    const status = exports.length === 0 ? 'failed' : failedFormats.length ? 'partial' : 'ready'
    const urls: Record<string, string> = {}
    const columns: Record<ReportFormat, string> = { pdf: 'pdf_url', xlsx: 'xlsx_url', csv: 'csv_url', image_portrait: 'image_url_portrait', image_square: 'image_url_square', image_bundle: 'image_bundle_url' }
    for (const ex of exports) urls[columns[ex.format]] = ex.publicUrl
    // Partial reports are available for download, but aren't automatically sent.
    if (status === 'ready' && row.review_status === 'approved' && !config.allowIncomplete && config.recipients?.length) {
      await save({ stage: 'delivery' })
      const freshExports = await Promise.all(exports.map(async ex => ({ ...ex, publicUrl: await signDownloadUrl(ex.storageKey) })))
      for (const recipient of config.recipients) {
        const previous = delivery.find(d => d.email.toLowerCase() === recipient.email.toLowerCase())
        // An interrupted send is ambiguous. Do not risk sending it twice.
        if (previous) continue
        const attempt: DeliveryResult = { email: recipient.email, status: 'sending' }
        delivery.push(attempt)
        await save({ delivery_results: delivery })
        const key = createHash('sha256').update(`${id}:${recipient.email.toLowerCase()}`).digest('hex')
        const outcome = await sendReportEmail(renderData, freshExports, [recipient], `report-${key}`)
        Object.assign(attempt, outcome.accepted.length
          ? { status: 'accepted', providerId: outcome.accepted[0].providerId }
          : { status: 'failed', error: outcome.failed[0]?.error ?? 'Email was not accepted.' })
        await save({ delivery_results: delivery })
        // Keep historical analytics consumers working; metadata distinguishes
        // provider acceptance from actual delivery.
        await admin.from('ad_report_analytics').insert({
          report_id: id,
          event: attempt.status === 'accepted' ? 'email_delivered' : 'email_failed',
          recipient_email: recipient.email,
          metadata: { state: attempt.status === 'accepted' ? 'provider_accepted' : 'failed', provider_id: attempt.providerId ?? null },
        }).then(() => undefined, () => undefined)
      }
    }
    if (status === 'ready' && row.review_status === 'approved' && config.supersedesId) {
      await admin.from('ad_reports').update({ review_status: 'superseded' }).eq('id', config.supersedesId).eq('client_id', config.clientId)
    }
    await admin.rpc('reconcile_report_delivery_events', { p_report_id: id })
    const warning = failedFormats.length ? `Could not produce: ${failedFormats.map(f => f.format).join(', ')}.` :
      config.recipients?.length && row.review_status !== 'approved' ? 'Review and approve this report before sending email.' :
      delivery.some(d => !['accepted', 'delivered'].includes(d.status)) ? 'Some email attempts failed or need review. They will not be resent automatically.' : null
    await save({ status, stage: status, error_message: warning, export_results: exports,
      export_failures: failedFormats, generation_time_ms: Date.now() - started,
      generated_at: new Date().toISOString(), ...urls })
    await admin.from('ad_report_analytics').insert({
      report_id: id, event: 'generated', user_id: config.generatedBy ?? null,
      metadata: { formats: config.formats, status, generation_time_ms: Date.now() - started },
    }).then(() => undefined, () => undefined)
    return result(status, status === 'failed' ? warning ?? 'No files were produced.' : undefined)
  } catch {
    const message = 'Report generation was interrupted. Retry to continue from saved progress.'
    await save({ status: 'failed', stage: 'failed', error_message: message }).catch(() => undefined)
    return result('failed', message)
  }
}

async function runExporter(format: ReportFormat, data: RenderData): Promise<Buffer> {
  switch (format) {
    case 'image_bundle': return generateImageBundle(data)
    case 'pdf': return generatePDF(data)
    case 'xlsx': return generateExcel(data)
    case 'csv': return generateCSV(data)
    case 'image_portrait': return generateImagePortrait(data)
    case 'image_square': return generateImageSquare(data)
  }
}
