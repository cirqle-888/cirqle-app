/**
 * Delivery Engine
 *
 * Handles two responsibilities:
 *   1. Upload export buffers to Supabase Storage (ad-reports bucket)
 *   2. Send the report via email (Resend)
 *
 * Storage keys: reports/{reportId}/{format}/{filename}
 * Signed URL TTL: 7 days (604800 seconds)
 */

import { createAdminClient } from '@/lib/supabase/server'
import { getResend } from '@/lib/email/resend'
import type { RenderData, ReportFormat, ExportResult, ReportRecipient } from './types'

const BUCKET = 'ad-reports'
const SIGNED_URL_TTL = 60 * 60 * 24 * 7 // 7 days

const FORMAT_EXT: Record<ReportFormat, string> = {
  pdf:            'pdf',
  xlsx:           'xlsx',
  csv:            'csv',
  image_portrait: 'png',
  image_square:   'png',
}

const FORMAT_MIME: Record<ReportFormat, string> = {
  pdf:            'application/pdf',
  xlsx:           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv:            'text/csv',
  image_portrait: 'image/png',
  image_square:   'image/png',
}

/**
 * Uploads a single export buffer to Supabase Storage and returns a signed URL.
 */
export async function uploadExport(
  reportId: string,
  format: ReportFormat,
  buffer: Buffer,
  data: RenderData,
): Promise<ExportResult> {
  const admin = createAdminClient()
  const ext = FORMAT_EXT[format]
  const slug = format === 'image_portrait' ? 'image-portrait'
             : format === 'image_square'   ? 'image-square'
             : format

  const filename = buildFilename(data, format)
  const storageKey = `reports/${reportId}/${slug}/${filename}`

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(storageKey, buffer, {
      contentType: FORMAT_MIME[format],
      upsert: true,
    })

  if (uploadError) throw new Error(`Upload failed for ${format}: ${uploadError.message}`)

  const { data: signedData, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(storageKey, SIGNED_URL_TTL)

  if (signError || !signedData) throw new Error(`Signed URL failed for ${format}: ${signError?.message}`)

  return {
    format,
    storageKey,
    publicUrl: signedData.signedUrl,
    sizeBytes: buffer.length,
  }
}

/**
 * Sends the report via email to all recipients using Resend.
 * Attaches up to 2 files: PDF (if generated) and CSV (if generated).
 * Returns the list of emails that succeeded.
 */
export async function sendReportEmail(
  data: RenderData,
  exports: ExportResult[],
  recipients: ReportRecipient[],
): Promise<{ delivered: string[]; failed: string[] }> {
  const resend = getResend()
  if (!resend || recipients.length === 0) return { delivered: [], failed: [] }

  const from = process.env.PAYSLIP_FROM_EMAIL ?? `${data.brand.agencyName} <farooq@cirqle.work>`

  const pdfExport  = exports.find(e => e.format === 'pdf')
  const xlsxExport = exports.find(e => e.format === 'xlsx')
  const csvExport  = exports.find(e => e.format === 'csv')

  const p = data.kpi.primary
  const derived = data.kpi.derived

  const htmlBody = buildEmailHTML(data, exports)

  const delivered: string[] = []
  const failed: string[] = []

  // Send individually so partial failures don't block others
  for (const recipient of recipients) {
    try {
      const attachments: { filename: string; url: string }[] = []
      if (pdfExport)  attachments.push({ filename: `Report.pdf`,  url: pdfExport.publicUrl })
      if (xlsxExport) attachments.push({ filename: `Report.xlsx`, url: xlsxExport.publicUrl })

      await resend.emails.send({
        from,
        to:      [recipient.email],
        subject: `${data.project.campaignName} — ${data.template.displayName} (${data.config.dateFrom} to ${data.config.dateTo})`,
        html:    htmlBody,
        attachments: attachments.length > 0 ? attachments : undefined,
      })

      delivered.push(recipient.email)
    } catch (err: any) {
      console.error(`[Delivery] Email failed to ${recipient.email}:`, err.message)
      failed.push(recipient.email)
    }
  }

  return { delivered, failed }
}

// ─── Email HTML builder ────────────────────────────────────────────────────────

function buildEmailHTML(data: RenderData, exports: ExportResult[]): string {
  const p = data.kpi.primary
  const d = data.kpi.derived
  const brand = data.brand
  const primary = brand.primaryColor

  const downloadLinks = exports
    .map(e => `<a href="${e.publicUrl}" style="display:inline-block;margin:4px 8px 4px 0;padding:8px 16px;background:#F3F0FF;color:${primary};border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">${formatLabel(e.format)}</a>`)
    .join('')

  const kpiRows = [
    ['Total Spend', `₹${inr(p.spend)}`],
    ['Revenue', `₹${inr(p.revenue)}`],
    ['ROAS', p.roas.toFixed(2)],
    ['Impressions', fmtN(p.impressions)],
    ['Clicks', fmtN(p.clicks)],
    ['CTR', `${p.ctr.toFixed(2)}%`],
    ['CPC', `₹${p.cpc.toFixed(2)}`],
    ['Leads', fmtN(p.leads)],
    ['CPL', `₹${p.cpl.toFixed(2)}`],
    ['Health Score', `${data.health.score}/100 (${data.health.grade})`],
  ].map(([label, value]) => `
    <tr>
      <td style="padding:8px 16px;font-size:14px;color:#666;border-bottom:1px solid #F0F0F0;">${label}</td>
      <td style="padding:8px 16px;font-size:14px;font-weight:600;color:#111;border-bottom:1px solid #F0F0F0;text-align:right;">${value}</td>
    </tr>`).join('')

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
    <!-- Header -->
    <div style="background:${primary};padding:28px 32px;">
      <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-bottom:6px;">${brand.agencyName}</div>
      <div style="font-size:22px;font-weight:700;color:#fff;">${data.project.campaignName}</div>
      <div style="font-size:14px;color:rgba(255,255,255,0.8);margin-top:4px;">${data.template.displayName} · ${data.config.dateFrom} – ${data.config.dateTo}</div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">
      <p style="font-size:15px;color:#333;line-height:1.7;margin:0 0 20px 0;">${data.ai.executiveSummary}</p>

      <!-- KPI table -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <thead>
          <tr style="background:#F8F6FF;">
            <th style="padding:10px 16px;font-size:13px;color:#888;text-align:left;border-bottom:2px solid #EEE;">Metric</th>
            <th style="padding:10px 16px;font-size:13px;color:#888;text-align:right;border-bottom:2px solid #EEE;">Value</th>
          </tr>
        </thead>
        <tbody>${kpiRows}</tbody>
      </table>

      <!-- Download links -->
      ${downloadLinks ? `<div style="margin-bottom:20px;"><div style="font-size:13px;font-weight:600;color:#888;margin-bottom:8px;letter-spacing:1px;">DOWNLOAD REPORT</div>${downloadLinks}</div>` : ''}
    </div>

    <!-- Footer -->
    <div style="background:#F8F8F8;padding:20px 32px;border-top:1px solid #EEE;">
      <div style="font-size:12px;color:#AAA;">
        ${brand.showPoweredBy ? `Powered by ${brand.agencyName}` : brand.agencyName}
        · ${brand.contactEmail ?? ''}
        ${brand.contactPhone ? `· ${brand.contactPhone}` : ''}
      </div>
    </div>
  </div>
</body>
</html>`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildFilename(data: RenderData, format: ReportFormat): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40)
  const name = safe(data.project.campaignName)
  const date = data.config.dateFrom.replace(/-/g, '')
  const ext  = FORMAT_EXT[format]
  return `${name}-${date}.${ext}`
}

function formatLabel(format: ReportFormat): string {
  const map: Record<ReportFormat, string> = {
    pdf: '📄 PDF', xlsx: '📊 Excel', csv: '📋 CSV',
    image_portrait: '📱 Image (Portrait)', image_square: '🖼 Image (Square)',
  }
  return map[format] ?? format
}

const inr  = (n: number) => Math.round(n).toLocaleString('en-IN')
const fmtN = (n: number) => Math.round(n).toLocaleString('en-IN')
