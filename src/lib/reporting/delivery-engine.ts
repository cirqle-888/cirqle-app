/**
 * Delivery Engine
 *
 * Handles two responsibilities:
 *   1. Upload export buffers to Supabase Storage (ad-reports bucket)
 *   2. Send the report via email (Resend)
 *
 * Storage keys: reports/{reportId}/{format}/{filename}
 * Signed URL TTL: 7 days (604800 seconds) for the URL stored on the report
 * and put in e-mails. The app itself never relies on that URL: /download
 * recovers the storage key and signs a short-lived one per request.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { getResend } from '@/lib/email/resend'
import type { RenderData, ReportFormat, ExportResult, ReportRecipient } from './types'
import { describeDataQuality } from './data-quality'

const BUCKET = 'ad-reports'
const SIGNED_URL_TTL = 60 * 60 * 24 * 7 // 7 days
/** Lifetime of a URL minted by /download for one click. */
export const DOWNLOAD_URL_TTL = 60 * 10 // 10 minutes

const FORMAT_EXT: Record<ReportFormat, string> = {
  image_bundle: 'zip',
  pdf:            'pdf',
  xlsx:           'xlsx',
  csv:            'csv',
  image_portrait: 'png',
  image_square:   'png',
}

const FORMAT_MIME: Record<ReportFormat, string> = {
  image_bundle: 'application/zip',
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
    mimeType: FORMAT_MIME[format],
  }
}

export interface EmailOutcome {
  email: string
  /** Provider message ID — present only when the provider accepted the send. */
  providerId?: string
  error?: string
}

/**
 * Sends the report via email to all recipients using Resend.
 * Attaches the PDF and Excel files when generated.
 *
 * `accepted` means Resend ACCEPTED the message for sending — not that it
 * reached an inbox; delivery/bounce are only knowable from Resend's webhooks.
 * The SDK reports most failures by RETURNING `{ error }` rather than
 * throwing, and the old code only caught throws, so a rejected send was
 * logged as delivered. Missing configuration is a failure for every
 * recipient, never a silent success.
 */
export async function sendReportEmail(
  data: RenderData,
  exports: ExportResult[],
  recipients: ReportRecipient[],
  idempotencyKey?: string,
): Promise<{ accepted: EmailOutcome[]; failed: EmailOutcome[] }> {
  if (recipients.length === 0) return { accepted: [], failed: [] }
  const resend = getResend()
  if (!resend) {
    return { accepted: [], failed: recipients.map(r => ({ email: r.email, error: 'Email is not configured (RESEND_API_KEY missing).' })) }
  }
  if (exports.length === 0) {
    return { accepted: [], failed: recipients.map(r => ({ email: r.email, error: 'No report files were generated, so nothing was sent.' })) }
  }

  const from = process.env.PAYSLIP_FROM_EMAIL ?? `${data.brand.agencyName} <farooq@cirqle.work>`

  const pdfExport  = exports.find(e => e.format === 'pdf')
  const xlsxExport = exports.find(e => e.format === 'xlsx')

  const htmlBody = buildEmailHTML(data, exports)

  const accepted: EmailOutcome[] = []
  const failed: EmailOutcome[] = []

  // Resend fetches a remote attachment from `path` (it has no `url` field —
  // the old `{ url }` objects carried no file at all).
  const attachments: { filename: string; path: string }[] = []
  if (pdfExport)  attachments.push({ filename: `Report.pdf`,  path: pdfExport.publicUrl })
  if (xlsxExport) attachments.push({ filename: `Report.xlsx`, path: xlsxExport.publicUrl })

  // Send individually so partial failures don't block others
  for (const recipient of recipients) {
    try {
      const { data: sent, error } = await resend.emails.send({
        from,
        to:      [recipient.email],
        subject: `${data.project.campaignName} — ${data.template.displayName} (${data.config.dateFrom} to ${data.config.dateTo})`,
        html:    htmlBody,
        attachments: attachments.length > 0 ? attachments : undefined,
      }, idempotencyKey ? { idempotencyKey } : undefined)
      if (error || !sent?.id) {
        failed.push({ email: recipient.email, error: (error?.message ?? 'Provider did not accept the message').slice(0, 300) })
      } else {
        accepted.push({ email: recipient.email, providerId: sent.id })
      }
    } catch (err) {
      failed.push({ email: recipient.email, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) })
    }
  }

  return { accepted, failed }
}

/**
 * Recovers the storage key from a signed URL stored on an ad_reports row.
 *
 * Only a URL on our own Supabase project, in the ad-reports bucket, under
 * this report's own folder, is accepted — anything else returns null, so a
 * tampered or foreign URL can never be turned into a key we sign.
 */
export function storageKeyFromStoredUrl(
  storedUrl: string | null | undefined,
  reportId: string,
  supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL,
): string | null {
  if (!storedUrl || !supabaseUrl || !reportId) return null
  let url: URL, base: URL
  try {
    url = new URL(storedUrl)
    base = new URL(supabaseUrl)
  } catch {
    return null
  }
  if (url.origin !== base.origin) return null
  const prefix = `/storage/v1/object/sign/${BUCKET}/`
  if (!url.pathname.startsWith(prefix)) return null
  let key: string
  try {
    key = decodeURIComponent(url.pathname.slice(prefix.length))
  } catch {
    return null
  }
  if (!key.startsWith(`reports/${reportId}/`) || key.includes('..') || key.includes('\\')) return null
  return key
}

/** Signs a short-lived URL for one download. Throws if the object is gone. */
export async function signDownloadUrl(storageKey: string): Promise<string> {
  const admin = createAdminClient()
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(storageKey, DOWNLOAD_URL_TTL)
  if (error || !data?.signedUrl) throw new Error(error?.message ?? 'File not found')
  return data.signedUrl
}

// ─── Email HTML builder ────────────────────────────────────────────────────────

function buildEmailHTML(data: RenderData, exports: ExportResult[]): string {
  const p = data.kpi.primary
  const brand = data.brand
  // Colour goes into a style attribute: only accept a plain hex value.
  const primary = /^#[0-9a-fA-F]{3,8}$/.test(brand.primaryColor ?? '') ? brand.primaryColor : '#6D28D9'

  const downloadLinks = exports
    .map(e => `<a href="${esc(e.publicUrl)}" style="display:inline-block;margin:4px 8px 4px 0;padding:8px 16px;background:#F3F0FF;color:${primary};border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">${formatLabel(e.format)}</a>`)
    .join('')

  // A ratio with a zero denominator is "not available", not ₹0.00 — a CPL of
  // ₹0 reads as free leads. Revenue/ROAS only appear when revenue is tracked.
  const kpiRows = [
    ['Total Spend', `₹${inr(p.spend)}`],
    ...(p.revenue > 0 ? [['Revenue', `₹${inr(p.revenue)}`], ['ROAS', p.roas.toFixed(2)]] : []),
    ['Impressions', fmtN(p.impressions)],
    data.kpi.periodReach?.available
      ? ['Reach', fmtN(data.kpi.periodReach.value)]
      : [data.config.dateFrom === data.config.dateTo ? 'Reach' : 'Reach (sum of daily)', fmtN(p.reach)],
    ['Clicks', fmtN(p.clicks)],
    ['CTR', p.impressions > 0 ? `${p.ctr.toFixed(2)}%` : '—'],
    ['CPC', p.clicks > 0 ? `₹${p.cpc.toFixed(2)}` : '—'],
    ['Leads', fmtN(p.leads)],
    ['CPL', p.leads > 0 ? `₹${p.cpl.toFixed(2)}` : '—'],
    ['Health Score', data.health.result?.insufficientData ? 'Not graded yet' : `${data.health.score}/100 (${data.health.grade})`],
  ].map(([label, value]) => `
    <tr>
      <td style="padding:8px 16px;font-size:14px;color:#666;border-bottom:1px solid #F0F0F0;">${esc(label)}</td>
      <td style="padding:8px 16px;font-size:14px;font-weight:600;color:#111;border-bottom:1px solid #F0F0F0;text-align:right;">${esc(value)}</td>
    </tr>`).join('')

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:sans-serif;">
  <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
    <!-- Header -->
    <div style="background:${primary};padding:28px 32px;">
      <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-bottom:6px;">${esc(brand.agencyName)}</div>
      <div style="font-size:22px;font-weight:700;color:#fff;">${esc(data.project.campaignName)}</div>
      <div style="font-size:14px;color:rgba(255,255,255,0.8);margin-top:4px;">${esc(data.template.displayName)} · ${esc(data.config.dateFrom)} – ${esc(data.config.dateTo)}</div>
    </div>

    <!-- Body -->
    <div style="padding:28px 32px;">
      <p style="font-size:15px;color:#333;line-height:1.7;margin:0 0 20px 0;">${esc(data.ai.executiveSummary)}</p>
      ${coverageNote(data) ? `<p style="font-size:13px;color:#92400E;background:#FEF3C7;border-radius:8px;padding:10px 14px;margin:0 0 20px 0;">${esc(coverageNote(data))}</p>` : ''}

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
        ${esc(brand.showPoweredBy ? `Powered by ${brand.agencyName}` : brand.agencyName)}
        · ${esc(brand.contactEmail ?? '')}
        ${brand.contactPhone ? `· ${esc(brand.contactPhone)}` : ''}
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
    image_bundle: '🗂 All image pages', pdf: '📄 PDF', xlsx: '📊 Excel', csv: '📋 CSV',
    image_portrait: '📱 Image (Portrait)', image_square: '🖼 Image (Square)',
  }
  return map[format] ?? format
}

/** Coverage warning, unless the summary already says it (rule-based text does). */
function coverageNote(data: RenderData): string | null {
  const note = describeDataQuality(data.dataQuality)
  return note && !data.ai.executiveSummary?.includes(note) ? note : null
}

/** Escapes text interpolated into the e-mail HTML (campaign names, AI text). */
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const inr  = (n: number) => Math.round(n).toLocaleString('en-IN')
const fmtN = (n: number) => Math.round(n).toLocaleString('en-IN')
