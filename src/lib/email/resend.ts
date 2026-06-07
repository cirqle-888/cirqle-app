import { Resend } from 'resend'

/**
 * Resend email client (server-only).
 *
 * Configuration (all via env — never hard-coded):
 *   RESEND_API_KEY      — your Resend secret key (re_...)
 *   PAYSLIP_FROM_EMAIL  — verified sender, e.g. "Cirqle Payroll <farooq@cirqle.work>"
 *                         The domain (cirqle.work) MUST be verified in Resend
 *                         (Domains → Add → set the DNS records) or sends bounce.
 *
 * The "from" address is changeable any time by editing PAYSLIP_FROM_EMAIL.
 */

let _client: Resend | null = null

export function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY
  if (!key) return null
  if (!_client) _client = new Resend(key)
  return _client
}

/** Sender identity for payslip emails. Falls back to the brand default. */
export function payslipFrom(): string {
  return process.env.PAYSLIP_FROM_EMAIL || 'Cirqle Payroll <farooq@cirqle.work>'
}

/** True when email sending is configured (API key present). */
export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY
}
