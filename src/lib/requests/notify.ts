import { createAdminClient } from '@/lib/supabase/admin'
import { getResend, payslipFrom } from '@/lib/email/resend'

/**
 * Request Portal — minimal v1 notifications (design §10).
 * Exactly three emails, all fire-and-forget and fully defensive:
 *   1. New request submitted  → company email
 *   2. Request started        → submitter (client/agency/generic email)
 *   3. Completed / Delivered  → submitter
 * No in-app notification system — awareness is the timeline + inbox indicators.
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.cirqle.work'

async function companyEmail(): Promise<string | null> {
  try {
    const admin = createAdminClient()
    const { data } = await admin.from('company_settings').select('value').eq('key', 'company_email').maybeSingle()
    const v = (data?.value as string) || ''
    return v.includes('@') ? v : null
  } catch { return null }
}

async function requesterEmail(req: {
  source: string; client_id: string | null; agency_id: string | null; submitter_email: string | null
}): Promise<string | null> {
  try {
    const admin = createAdminClient()
    if (req.source === 'client' && req.client_id) {
      const { data } = await admin.from('clients').select('email').eq('id', req.client_id).maybeSingle()
      if (data?.email) return data.email
    }
    if (req.source === 'agency' && req.agency_id) {
      const { data } = await admin.from('agencies').select('email').eq('id', req.agency_id).maybeSingle()
      if (data?.email) return data.email
    }
    return req.submitter_email || null
  } catch { return null }
}

function shell(title: string, bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0b1120;color:#e5e7eb;border-radius:16px">
    <div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:4px">cirqle<span style="color:#60a5fa">.</span></div>
    <div style="font-size:15px;font-weight:700;color:#fff;margin:16px 0 8px">${title}</div>
    ${bodyHtml}
    <div style="font-size:11px;color:#6b7280;margin-top:20px">Cirqle Works · cirqle.work</div>
  </div>`
}

/** 1. New request → company. */
export async function notifyNewRequest(req: { id: string; ref_no: number; title: string; source: string }, fromLabel: string) {
  try {
    const resend = getResend(); if (!resend) return
    const to = await companyEmail(); if (!to) return
    const ref = `REQ-${String(req.ref_no).padStart(4, '0')}`
    await resend.emails.send({
      from: payslipFrom(), to,
      subject: `New request ${ref} — ${req.title}`,
      html: shell('New request received', `
        <p style="font-size:13px;color:#9ca3af;line-height:1.6">
          <strong style="color:#e5e7eb">${ref} · ${req.title}</strong><br/>
          From: ${fromLabel}<br/>
          Review it in the Requests inbox.
        </p>
        <a href="${APP_URL}/dashboard/requests" style="display:inline-block;margin-top:8px;background:#7c3aed;color:#fff;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px;text-decoration:none">Open Requests Inbox</a>`),
    })
  } catch { /* never block on email */ }
}

/** 2 & 3. Status milestone → submitter (started / completed / delivered). */
export async function notifyRequesterStatus(
  req: { id: string; ref_no: number; title: string; track_token: string; source: string; client_id: string | null; agency_id: string | null; submitter_email: string | null },
  milestone: 'started' | 'completed' | 'delivered',
) {
  try {
    const resend = getResend(); if (!resend) return
    const to = await requesterEmail(req); if (!to) return
    const ref = `REQ-${String(req.ref_no).padStart(4, '0')}`
    const headline = milestone === 'started' ? 'Work has started on your request'
      : milestone === 'completed' ? 'Your request is completed'
      : 'Your request has been delivered'
    await resend.emails.send({
      from: payslipFrom(), to,
      subject: `${headline} — ${ref}`,
      html: shell(headline, `
        <p style="font-size:13px;color:#9ca3af;line-height:1.6">
          <strong style="color:#e5e7eb">${ref} · ${req.title}</strong><br/>
          Track progress any time using your link below.
        </p>
        <a href="${APP_URL}/intake/track/${req.track_token}" style="display:inline-block;margin-top:8px;background:#7c3aed;color:#fff;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px;text-decoration:none">Track this request</a>`),
    })
  } catch { /* never block on email */ }
}
