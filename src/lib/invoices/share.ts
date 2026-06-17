/**
 * Client-facing invoice sharing helpers — the public hosted-invoice link and
 * the WhatsApp message text. Shared by the Invoices page and the Follow-ups page
 * so every "Share via WhatsApp" entry point uses the same client-safe link.
 */

import { DEFAULT_TEMPLATES, renderTemplate } from '@/lib/messaging/templates'

const DEFAULT_ORIGIN = 'https://app.cirqle.work'

/** Absolute URL of the public (no-login) hosted invoice page. */
export function publicInvoiceUrl(token: string | null | undefined, origin?: string): string {
  if (!token) return ''
  const base = origin || (typeof window !== 'undefined' ? window.location.origin : DEFAULT_ORIGIN)
  return `${base}/i/${token}`
}

const fmtAmt  = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`
const fmtDate = (s?: string | null) => {
  const d = s ? new Date(s) : null
  return d && !isNaN(d.getTime())
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''
}

/** A single-invoice share message (used after Mark Sent + the Invoices page). */
export function buildInvoiceShareText(opts: {
  invoiceNumber: string
  clientName?:   string | null
  companyName:   string
  amount?:       number | null
  dueDate?:      string | null
  showAmounts:   boolean
  link:          string
  template?:     string   // editable override from Settings → Message Templates
}): string {
  const { invoiceNumber, clientName, companyName, amount, dueDate, showAmounts, link, template } = opts
  return renderTemplate(template || DEFAULT_TEMPLATES.invoiceShare, {
    client_name:    clientName || '',
    invoice_number: invoiceNumber,
    company_name:   companyName,
    amount:         showAmounts && amount != null ? fmtAmt(amount) : '',
    due_date:       fmtDate(dueDate),
    link:           link || '',
  })
}

/** Build a wa.me deep link. 10-digit numbers are assumed Indian (prefix 91). */
export function whatsappShareUrl(text: string, phone?: string | null): string {
  let digits = (phone || '').replace(/\D/g, '')
  if (digits.length === 10) digits = '91' + digits
  const base = digits ? `https://wa.me/${digits}` : 'https://wa.me/'
  return `${base}?text=${encodeURIComponent(text)}`
}
