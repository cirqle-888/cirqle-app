/**
 * Quotation → the invoice document renderer.
 *
 * There is one client-facing document layout (lib/invoices/render-html), with
 * the company's logo, colours, page decoration and contact strip. A quotation
 * is printed through it with `kind: 'quotation'`, and this adapter maps the
 * quotation row onto the fields that layout reads, so the two can't drift.
 */
import { renderInvoiceHtml, type InvoiceRenderOpts } from '@/lib/invoices/render-html'
import { sortQuotationLines } from './editing'

export interface QuotationForRender {
  quotation_number: string
  issue_date: string
  valid_until?: string | null
  currency: string
  total_amount: number
  notes?: string | null
  terms?: string | null
  client?: { name?: string | null; address?: string | null; phone?: string | null; email?: string | null } | null
  items?: { description: string; quantity: number; unit_price: number; total: number; display_order?: number | null }[] | null
}

/** The quotation in the shape the document renderer reads. */
export function quotationDocument(quo: QuotationForRender) {
  return {
    invoice_number: quo.quotation_number,
    issue_date: quo.issue_date,
    // Rendered under the "Valid Until" label for a quotation.
    due_date: quo.valid_until || null,
    currency: quo.currency,
    total_amount: quo.total_amount || 0,
    subtotal: quo.total_amount || 0,
    discount_amount: 0,
    tax_amount: 0,
    previous_balance: 0,
    paid_amount: 0,
    notes: quo.notes || '',
    terms: quo.terms || '',
    client: quo.client || null,
    // Each line carries its position so the renderer's sort keeps entry order.
    items: sortQuotationLines(quo.items).map((it, i) => ({ ...it, display_order: i })),
  }
}

export function renderQuotationHtml(
  quo: QuotationForRender,
  companySettings: Record<string, string>,
  opts?: Omit<InvoiceRenderOpts, 'kind' | 'agreements' | 'otherOutstanding'>,
): string {
  return renderInvoiceHtml(quotationDocument(quo), companySettings, { ...opts, kind: 'quotation' })
}
