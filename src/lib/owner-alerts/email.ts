import type { SupabaseClient } from '@supabase/supabase-js'
import { getResend, payslipFrom } from '@/lib/email/resend'
import type { OwnerCheck } from './rules'

/**
 * Emails the Monday owner check to every active admin.
 *
 * Off by default (Settings → Company → Owner alerts). Internal only: it goes
 * to admins, never to clients. The sender reuses the verified address already
 * configured for payslips unless OWNER_ALERTS_FROM_EMAIL is set.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

function ownerCheckFrom(): string {
  if (process.env.OWNER_ALERTS_FROM_EMAIL) return process.env.OWNER_ALERTS_FROM_EMAIL
  const m = /<([^>]+)>/.exec(payslipFrom())
  return m ? `Cirqle Owner Check <${m[1]}>` : payslipFrom()
}

export function ownerCheckEmailHtml(check: OwnerCheck, lines: string[], appUrl: string): string {
  const list = (items: string[]) => items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''
  const top = check.overdue.top.map(t => `${t.invoiceNumber} · ${t.clientName} · ${t.daysOverdue} days · ${inr(t.outstandingInr)}`)
  const quiet = check.quiet.slice(0, 5).map(q => `${q.clientName}: quiet ${q.daysSilent} days (usually ${inr(q.monthlyAvgInr)}/month)`)
  return [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;color:#111">`,
    `<h2 style="font-size:18px;margin:0 0 8px">Monday owner check · ${esc(check.today)}</h2>`,
    lines.length ? list(lines) : '<p>Nothing needs you this week.</p>',
    top.length ? `<h3 style="font-size:14px;margin:16px 0 4px">Largest overdue</h3>${list(top)}` : '',
    quiet.length ? `<h3 style="font-size:14px;margin:16px 0 4px">Quiet clients</h3>${list(quiet)}` : '',
    `<p style="margin-top:16px"><a href="${esc(appUrl)}/dashboard/health#owner-check">Open Business Health</a></p>`,
    `</div>`,
  ].join('')
}

export async function sendOwnerCheckEmail(
  admin: SupabaseClient,
  check: OwnerCheck,
  lines: string[],
): Promise<string> {
  const resend = getResend()
  if (!resend) return 'skipped: email not configured'

  const { data: employees, error } = await admin
    .from('employees')
    .select('email, designation:designation_id(is_admin)')
    .eq('is_active', true)
    .eq('is_archived', false)
  if (error) return `skipped: ${error.message}`

  type Row = { email: string | null; designation: { is_admin: boolean } | { is_admin: boolean }[] | null }
  const to = (employees as Row[] | null || [])
    .filter(e => (Array.isArray(e.designation) ? e.designation[0]?.is_admin : e.designation?.is_admin) === true)
    .map(e => (e.email || '').trim())
    .filter(Boolean)
  if (!to.length) return 'skipped: no admin email'

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.cirqle.work').replace(/\/$/, '')
  let sent = 0
  for (const email of to) {
    try {
      const { error: sendErr } = await resend.emails.send({
        from: ownerCheckFrom(),
        to: [email],
        subject: check.attentionCount
          ? `Owner check: ${check.attentionCount} thing${check.attentionCount === 1 ? '' : 's'} need you this week`
          : 'Owner check: a quiet week',
        html: ownerCheckEmailHtml(check, lines, appUrl),
        text: [`Monday owner check · ${check.today}`, ...lines.map(l => `- ${l}`), `${appUrl}/dashboard/health#owner-check`].join('\n'),
      }, { idempotencyKey: `owner-check-${check.today}-${email}` })
      if (!sendErr) sent++
    } catch {
      // One failed address must not stop the others.
    }
  }
  return `sent ${sent} of ${to.length}`
}
