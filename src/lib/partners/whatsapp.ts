/**
 * Business Partner statement → WhatsApp text.
 *
 * Mirrors src/lib/invoices/share.ts's buildInvoiceShareText/whatsappShareUrl
 * pattern but is an independent module — the Invoice share code is never
 * imported or modified here.
 */
import { DEFAULT_TEMPLATES, renderTemplate } from '@/lib/messaging/templates'
import type { PartnerStatementData } from './queries'

const fmtAmt = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partial: 'Partially Paid',
  paid: 'Paid',
  overdue: 'Overdue',
}

export interface PartnerStatementLine {
  clientName:    string
  invoiceNumber: string
  pending:       number
  status:        string
}

export type PartnerStatementTemplates = { partnerStatement?: string; partnerStatementItem?: string }

/**
 * The statement text itself — shared by the partner dashboard (which passes
 * server-loaded statement rows) and the Follow-ups page (which passes the
 * partner's pending invoices already on screen), so both produce byte-identical
 * messages from the same Settings templates.
 */
export function buildPartnerStatementTextFromLines(
  partnerName: string,
  lines: PartnerStatementLine[],
  totalPending: number,
  templates?: PartnerStatementTemplates,
  greetingName?: string,
): string {
  const itemTpl = templates?.partnerStatementItem || DEFAULT_TEMPLATES.partnerStatementItem
  const items_block = lines
    .map(row => renderTemplate(itemTpl, {
      client_name:    row.clientName,
      invoice_number: row.invoiceNumber,
      amount:         fmtAmt(row.pending),
      status:         STATUS_LABEL[row.status] || row.status,
    }))
    .join('\n')

  return renderTemplate(templates?.partnerStatement || DEFAULT_TEMPLATES.partnerStatement, {
    partner_name:   greetingName || partnerName,
    items_block:    items_block || 'No pending invoices.',
    total_pending:  fmtAmt(totalPending),
  })
}

/** Copy-friendly WhatsApp collection summary for a Business Partner statement. */
export function buildPartnerStatementText(
  data: PartnerStatementData,
  templates?: PartnerStatementTemplates,
  greetingName?: string,
): string {
  return buildPartnerStatementTextFromLines(
    data.partner.name,
    data.rows.map(r => ({ clientName: r.clientName, invoiceNumber: r.invoiceNumber, pending: r.pending, status: r.status })),
    data.totalOutstanding,
    templates,
    greetingName,
  )
}

/** Build a wa.me deep link. 10-digit numbers are assumed Indian (prefix 91). */
export function partnerWhatsappShareUrl(text: string, phone?: string | null): string {
  let digits = (phone || '').replace(/\D/g, '')
  if (digits.length === 10) digits = '91' + digits
  const base = digits ? `https://wa.me/${digits}` : 'https://wa.me/'
  return `${base}?text=${encodeURIComponent(text)}`
}
