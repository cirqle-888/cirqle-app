/**
 * Report Orchestrator
 *
 * The single entry-point for generating a complete report. Called by:
 *   • Background worker  (advertising_generate_report job)
 *   • API route          (POST /api/advertising/reports/generate)
 *
 * Steps:
 *   1. Create db record (status=generating)
 *   2. Build RenderData (data + KPI + branding + benchmarks + forecasts + health + AI)
 *   3. Run requested exporters in parallel (PDF, Excel, CSV, Image)
 *   4. Upload exports to Supabase Storage
 *   5. Deliver via email (if recipients provided)
 *   6. Update db record (status=ready, URLs, render_data, ai_narrative)
 *   7. Track analytics event
 *
 * On any failure the record is updated with status=failed + error_message.
 */

import { createTypedAdminClient } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'
import { buildRenderData } from './render-engine'
import { generatePDF } from './exporters/pdf'
import { generateExcel } from './exporters/excel'
import { generateCSV } from './exporters/csv'
import { generateImagePortrait, generateImageSquare } from './exporters/image'
import { uploadExport, sendReportEmail } from './delivery-engine'
import type {
  ReportConfig, RenderData, OrchestrationResult, ExportResult, DeliveryResult, ReportFormat,
} from './types'

/**
 * Generates a full report. Creates and manages the ad_reports db record.
 * Returns OrchestrationResult with all export URLs.
 */
export async function generateReport(config: ReportConfig): Promise<OrchestrationResult> {
  const admin = createTypedAdminClient()
  const t0 = Date.now()
  let reportId = ''

  // ── 1. Create report record ────────────────────────────────────────────
  const { data: reportRow, error: insertErr } = await admin
    .from('ad_reports')
    .insert({
      project_id:     config.projectId,
      client_id:      config.clientId,
      report_type:    config.reportType,
      template:       config.template,
      date_from:      config.dateFrom,
      date_to:        config.dateTo,
      comparison_from: config.comparisonFrom ?? null,
      comparison_to:   config.comparisonTo ?? null,
      status:         'generating',
      generated_by:   config.generatedBy ?? null,
      schedule_id:    config.scheduleId ?? null,
    })
    .select('id')
    .single()

  if (insertErr || !reportRow) {
    throw new Error(`Failed to create report record: ${insertErr?.message}`)
  }
  reportId = reportRow.id

  try {
    // ── 2. Build RenderData ────────────────────────────────────────────
    let renderData: RenderData
    try {
      renderData = await buildRenderData(config)
    } catch (err: any) {
      await markFailed(admin, reportId, `Render failed: ${err.message}`)
      return { reportId, status: 'failed', generationTimeMs: Date.now() - t0, formats: [], exports: [], delivery: [], error: err.message }
    }

    // ── 3. Run exporters ───────────────────────────────────────────────
    const formats = config.formats
    const exports: ExportResult[] = []

    // Generate each format; failures are logged but don't abort others
    const exportJobs = formats.map(async (format): Promise<ExportResult | null> => {
      try {
        const buffer = await runExporter(format, renderData)
        const result = await uploadExport(reportId, format, buffer, renderData)
        return result
      } catch (err: any) {
        logger.error(`[Orchestrator] Export ${format} failed`, err)
        return null
      }
    })

    const exportResults = await Promise.all(exportJobs)
    for (const r of exportResults) {
      if (r) exports.push(r)
    }

    // ── 4. Build URL map for db update ────────────────────────────────
    const urlMap: Record<string, string | null> = {
      pdf_url:            null,
      xlsx_url:           null,
      csv_url:            null,
      image_url_portrait: null,
      image_url_square:   null,
    }
    for (const ex of exports) {
      if (ex.format === 'pdf')            urlMap.pdf_url            = ex.publicUrl
      if (ex.format === 'xlsx')           urlMap.xlsx_url           = ex.publicUrl
      if (ex.format === 'csv')            urlMap.csv_url            = ex.publicUrl
      if (ex.format === 'image_portrait') urlMap.image_url_portrait = ex.publicUrl
      if (ex.format === 'image_square')   urlMap.image_url_square   = ex.publicUrl
    }

    // ── 5. Email delivery ─────────────────────────────────────────────
    const delivery: DeliveryResult[] = []
    if (config.recipients && config.recipients.length > 0) {
      const { delivered, failed } = await sendReportEmail(renderData, exports, config.recipients)
      for (const ex of exports) {
        delivery.push({
          format: ex.format,
          export: ex,
          emailDelivered: delivered.length > 0,
          emailRecipients: delivered,
          error: failed.length > 0 ? `Failed: ${failed.join(', ')}` : undefined,
        })
      }

      // Track email events
      if (delivered.length > 0) {
        await admin.from('ad_report_analytics').insert(
          delivered.map(email => ({
            report_id:       reportId,
            event:           'email_delivered',
            recipient_email: email,
            metadata:        { formats: formats },
          }))
        )
      }
      if (failed.length > 0) {
        await admin.from('ad_report_analytics').insert(
          failed.map(email => ({
            report_id:       reportId,
            event:           'email_failed',
            recipient_email: email,
          }))
        )
      }
    }

    // ── 6. Update report record ────────────────────────────────────────
    const generationTimeMs = Date.now() - t0
    const { error: updateErr } = await admin
      .from('ad_reports')
      .update({
        status:            'ready',
        generation_time_ms: generationTimeMs,
        generated_at:       new Date().toISOString(),
        render_data:        renderData as any,
        ai_narrative:       renderData.ai as any,
        ...urlMap,
      })
      .eq('id', reportId)

    if (updateErr) logger.error('[Orchestrator] Failed to update report record', new Error(updateErr.message))

    // ── 7. Track generated event ───────────────────────────────────────
    // Use .then(null, () => {}) instead of .catch() — Supabase returns a
    // PromiseLike (has .then) but not a full Promise (no .catch).
    void admin.from('ad_report_analytics').insert({
      report_id: reportId,
      event:     'generated',
      user_id:   config.generatedBy ?? null,
      metadata:  { formats, generation_time_ms: generationTimeMs },
    }).then(null, () => {}) // Non-critical

    return {
      reportId,
      status:            'ready',
      generationTimeMs,
      formats,
      exports,
      delivery,
    }
  } catch (err: any) {
    logger.error('[Orchestrator] Fatal error', err)
    await markFailed(admin, reportId, err.message)
    return {
      reportId,
      status: 'failed',
      generationTimeMs: Date.now() - t0,
      formats: config.formats,
      exports: [],
      delivery: [],
      error: err.message,
    }
  }
}

/**
 * Enqueues a report generation job without waiting for it to complete.
 * Use from API routes — the background worker picks it up.
 */
export async function enqueueReportGeneration(config: ReportConfig): Promise<string> {
  const { enqueueJob } = await import('@/lib/jobs/engine')
  return enqueueJob({
    job_type: 'advertising_generate_report',
    payload:  config,
    priority: 'normal',
  })
}

// ─── Exporter dispatch ────────────────────────────────────────────────────────

async function runExporter(format: ReportFormat, data: RenderData): Promise<Buffer> {
  switch (format) {
    case 'pdf':            return generatePDF(data)
    case 'xlsx':           return generateExcel(data)
    case 'csv':            return generateCSV(data)
    case 'image_portrait': return generateImagePortrait(data)
    case 'image_square':   return generateImageSquare(data)
    default: throw new Error(`Unknown export format: ${format}`)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function markFailed(admin: ReturnType<typeof createTypedAdminClient>, reportId: string, message: string) {
  try {
    await admin.from('ad_reports').update({
      status:        'failed',
      error_message: message.slice(0, 1000),
      generated_at:  new Date().toISOString(),
    }).eq('id', reportId)
  } catch { /* Non-critical */ }
}
