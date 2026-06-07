'use server'

/**
 * Payslip email server actions.
 *
 * Flow: build data → render branded HTML + PDF → send via Resend → log to
 * `payslip_emails`. Single-send is preview-driven; bulk-send iterates every
 * PAID payroll record for the month. All sends are gated on payroll.edit.
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { getResend, payslipFrom, isEmailConfigured } from '@/lib/email/resend'
import { buildPayslipData } from './build-payslip'
import { renderPayslipHtml, renderPayslipText } from './payslip-html'
import { renderPayslipPdf, payslipFilename } from './payslip-pdf'
import type { PayslipData } from './types'

interface ActionResult<T = void> { ok: boolean; error?: string; data?: T }

function defaultSubject(d: PayslipData): string {
  return `Payslip — ${d.period.label} — Cirqle Design`
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export async function getPayslipPreview(
  employeeId: string, month: number, year: number,
): Promise<ActionResult<{ data: PayslipData; html: string; subject: string; recipient: string; emailConfigured: boolean }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const built = await buildPayslipData(employeeId, month, year)
  if (!built.ok) return { ok: false, error: built.error }

  return {
    ok: true,
    data: {
      data: built.data,
      html: renderPayslipHtml(built.data),
      subject: defaultSubject(built.data),
      recipient: built.data.employee.email,
      emailConfigured: isEmailConfigured(),
    },
  }
}

// ─── Single send ────────────────────────────────────────────────────────────────

export interface SendPayslipInput {
  employeeId: string
  month: number
  year: number
  toOverride?: string       // override recipient
  subjectOverride?: string  // override subject
  note?: string             // optional personal note shown in the email
}

export async function sendPayslip(
  input: SendPayslipInput,
): Promise<ActionResult<{ resendId: string | null; to: string }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const result = await sendOne(input, guard.employeeId)
  if (result.ok) revalidatePath('/dashboard/payroll')
  return result
}

// ─── Bulk send (all PAID employees in the month) ───────────────────────────────

export interface SendBulkInput {
  month: number
  year: number
  note?: string
  onlyEmployeeIds?: string[]  // optional subset; default = all paid in month
}

export async function sendBulkPayslips(
  input: SendBulkInput,
): Promise<ActionResult<{ sent: number; failed: number; results: { cqid: string; to: string; ok: boolean; error?: string }[] }>> {
  const guard = await requirePermission(PERMS.PAYROLL_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!isEmailConfigured()) return { ok: false, error: 'Email is not configured. Set RESEND_API_KEY first.' }

  const admin = createAdminClient()
  let q = admin
    .from('payroll')
    .select('employee_id, employee:employees(cqid)')
    .eq('month', input.month)
    .eq('year', input.year)
    .eq('status', 'paid')
  if (input.onlyEmployeeIds?.length) q = q.in('employee_id', input.onlyEmployeeIds)

  const { data: paid, error } = await q
  if (error) return { ok: false, error: error.message }
  if (!paid || paid.length === 0) {
    return { ok: false, error: 'No paid payroll records found for this month.' }
  }

  const results: { cqid: string; to: string; ok: boolean; error?: string }[] = []
  let sent = 0, failed = 0
  for (const rec of paid as any[]) {
    const r = await sendOne(
      { employeeId: rec.employee_id, month: input.month, year: input.year, note: input.note },
      guard.employeeId,
    )
    if (r.ok) { sent++; results.push({ cqid: rec.employee?.cqid || '—', to: r.data?.to || '', ok: true }) }
    else      { failed++; results.push({ cqid: rec.employee?.cqid || '—', to: '', ok: false, error: r.error }) }
  }

  revalidatePath('/dashboard/payroll')
  return { ok: true, data: { sent, failed, results } }
}

// ─── History ──────────────────────────────────────────────────────────────────

export async function getPayslipHistory(
  month: number, year: number,
): Promise<ActionResult<{ rows: any[] }>> {
  const guard = await requirePermission(PERMS.PAYROLL_VIEW)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('payslip_emails')
    .select('id, employee_id, sent_to, subject, status, error, sent_at, employee:employees(cqid, name)')
    .eq('month', month)
    .eq('year', year)
    .order('sent_at', { ascending: false })
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { rows: data ?? [] } }
}

// ─── Internal: build + send + log one payslip ──────────────────────────────────

async function sendOne(
  input: SendPayslipInput,
  actorId: string,
): Promise<ActionResult<{ resendId: string | null; to: string }>> {
  const admin = createAdminClient()

  const built = await buildPayslipData(input.employeeId, input.month, input.year)
  if (!built.ok) return { ok: false, error: built.error }
  const d = built.data

  const to = (input.toOverride || d.employee.email || '').trim()
  if (!to) return { ok: false, error: `${d.employee.cqid} has no email address.` }

  const subject = input.subjectOverride?.trim() || defaultSubject(d)
  const html = renderPayslipHtml(d, input.note)
  const text = renderPayslipText(d)

  const resend = getResend()
  if (!resend) return { ok: false, error: 'Email is not configured. Set RESEND_API_KEY first.' }

  let pdf: Buffer
  try {
    pdf = renderPayslipPdf(d)
  } catch (e: any) {
    return { ok: false, error: `PDF generation failed: ${e?.message || e}` }
  }

  const { data: sendRes, error: sendErr } = await resend.emails.send({
    from: payslipFrom(),
    to,
    subject,
    html,
    text,
    attachments: [{ filename: payslipFilename(d), content: pdf }],
  })

  const status = sendErr ? 'failed' : 'sent'
  const errMsg = sendErr ? (sendErr.message || String(sendErr)) : null

  // Audit row (best-effort — never blocks the result).
  await admin.from('payslip_emails').insert({
    employee_id: input.employeeId,
    month: input.month,
    year: input.year,
    sent_to: to,
    subject,
    status,
    resend_id: sendRes?.id || null,
    error: errMsg,
    snapshot: d as any,
    sent_by: actorId,
  })

  if (sendErr) return { ok: false, error: errMsg || 'Send failed' }
  return { ok: true, data: { resendId: sendRes?.id || null, to } }
}
