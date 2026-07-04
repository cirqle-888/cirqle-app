'use server'

/**
 * Business Partner statement → email.
 * Reuses the existing Resend integration (src/lib/email/resend.ts, already
 * used for payslip emails) — no new email infrastructure.
 */
import { getResend, isEmailConfigured, payslipFrom } from '@/lib/email/resend'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'
import { getPartnerStatementData } from '@/lib/partners/queries'
import { renderPartnerStatementHtml } from '@/lib/partners/render-html'

interface ActionResult {
  ok: boolean
  error?: string
}

export async function sendPartnerStatementEmail(
  partnerId: string,
  companyName: string,
  primaryColor: string,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.PARTNERS_EXPORT)
  if (!guard.ok) return { ok: false, error: guard.error }

  if (!isEmailConfigured()) {
    return { ok: false, error: 'Email is not configured (RESEND_API_KEY missing).' }
  }

  const data = await getPartnerStatementData(partnerId)
  if (!data) return { ok: false, error: 'Business partner not found.' }
  if (!data.partner.email) return { ok: false, error: 'This partner has no email address on file.' }

  const resend = getResend()
  if (!resend) return { ok: false, error: 'Email is not configured.' }

  const html = renderPartnerStatementHtml(data, { companyName, primaryColor })

  const { error } = await resend.emails.send({
    from: payslipFrom(),
    to: data.partner.email,
    subject: `Collection Statement — ${companyName}`,
    html,
  })

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
