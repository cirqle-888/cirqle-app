/**
 * Quotation editing rules — pure, so the page and the tests agree on them.
 *
 * A quotation is a proposal until the client answers it. While it is a draft
 * or has only been sent, its lines and dates can still change. Once the client
 * has approved or rejected it, or it has become an invoice, it is a record of
 * what was agreed (or turned down) and is read-only. Only a draft, which has
 * never left the building, can be deleted.
 */
import { round2 } from '@/lib/calculations/currency'

export const EDITABLE_QUOTATION_STATUSES = ['draft', 'sent'] as const

export function isQuotationEditable(status: string | null | undefined): boolean {
  return (EDITABLE_QUOTATION_STATUSES as readonly string[]).includes(status || '')
}

/** Only a quotation nobody outside has seen can be deleted. */
export function canDeleteQuotation(status: string | null | undefined): boolean {
  return status === 'draft'
}

/** Why this quotation cannot be edited, or null when it can. */
export function quotationLockReason(status: string | null | undefined): string | null {
  switch (status) {
    case 'approved':
      return 'Approved by the client, so it stays as agreed. Convert it to an invoice to bill it.'
    case 'rejected':
      return 'Rejected by the client, so it is kept as it was. Create a new quotation for a revised offer.'
    case 'converted':
      return 'Already converted to an invoice. Change the invoice instead.'
    default:
      return isQuotationEditable(status) ? null : 'This quotation can no longer be edited.'
  }
}

// ─── Line items ───────────────────────────────────────────────────────────────

export interface QuotationLine {
  description: string
  quantity: number
  unit_price: number
  total: number
}

export interface StoredQuotationLine extends QuotationLine {
  display_order: number
}

/**
 * The lines worth saving: blank descriptions dropped, descriptions trimmed,
 * each total recomputed from quantity × rate (so a stale `total` in the form
 * can never be what gets billed), and display_order set to the form's order.
 */
export function normaliseQuotationLines(lines: QuotationLine[]): StoredQuotationLine[] {
  return lines
    .filter(l => l.description.trim())
    .map((l, i) => {
      const quantity = Number.isFinite(l.quantity) && l.quantity > 0 ? l.quantity : 1
      const unit_price = Number.isFinite(l.unit_price) && l.unit_price > 0 ? l.unit_price : 0
      return {
        description: l.description.trim(),
        quantity,
        unit_price,
        total: round2(quantity * unit_price),
        display_order: i,
      }
    })
}

export function quotationTotal(lines: { total: number }[]): number {
  return round2(lines.reduce((s, l) => s + (l.total || 0), 0))
}

/** Lines in the order they were entered (rows saved before display_order existed sort as 0). */
export function sortQuotationLines<T extends { display_order?: number | null }>(lines: T[] | null | undefined): T[] {
  return [...(lines || [])].sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
}

// ─── Form ─────────────────────────────────────────────────────────────────────

export interface QuotationFormValues<C extends string = string> {
  client_id: string
  currency: C
  issue_date: string
  valid_until: string
  notes: string
  terms: string
  items: QuotationLine[]
}

export interface QuotationRecord<C extends string = string> {
  client_id: string | null
  currency: C
  issue_date: string
  valid_until?: string | null
  notes?: string | null
  terms?: string | null
  items?: (Partial<QuotationLine> & { display_order?: number | null })[] | null
}

/** Prefill the quotation form from a saved quotation. */
export function quotationToForm<C extends string>(quo: QuotationRecord<C>): QuotationFormValues<C> {
  const items = sortQuotationLines(quo.items).map(i => {
    const quantity = Number(i.quantity) || 1
    const unit_price = Number(i.unit_price) || 0
    return {
      description: i.description || '',
      quantity,
      unit_price,
      total: Number.isFinite(Number(i.total)) ? Number(i.total) : round2(quantity * unit_price),
    }
  })
  return {
    client_id: quo.client_id || '',
    currency: quo.currency,
    issue_date: quo.issue_date,
    valid_until: quo.valid_until || '',
    notes: quo.notes || '',
    terms: quo.terms || '',
    items: items.length ? items : [{ description: '', quantity: 1, unit_price: 0, total: 0 }],
  }
}

// ─── Numbering ────────────────────────────────────────────────────────────────
//
// `QUO-<yymm>-<client code>` was the whole number, and quotation_number is
// UNIQUE, so a second quotation for the same client in the same month failed
// to save at all. The first one keeps the plain number (existing quotations,
// such as QUO-2610-063, are unchanged); later ones take a suffix: -2, -3, …

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `QUO-<yymm>-<CODE>` for an ISO issue date, read from the string (no timezone shift). */
export function quotationNumberBase(issueDateISO: string, clientCode: string): string {
  const [y, m] = issueDateISO.split('-')
  const code = (clientCode || '001').trim().toUpperCase()
  return `QUO-${(y || '').slice(-2)}${m || ''}-${code}`
}

/**
 * Whether `number` is `base` itself or `base-N`. A prefix match is not enough:
 * client code 06 must not count QUO-2610-063 as one of its own.
 */
export function belongsToBase(number: string, base: string): boolean {
  return new RegExp(`^${escapeRegExp(base)}(?:-(\\d+))?$`).test(number)
}

/** The first free number for `base`, given the numbers already used. */
export function nextQuotationNumber(base: string, existing: string[]): string {
  const re = new RegExp(`^${escapeRegExp(base)}(?:-(\\d+))?$`)
  let taken = false
  let maxSuffix = 1
  for (const n of existing) {
    const m = re.exec(n)
    if (!m) continue
    taken = true
    if (m[1]) maxSuffix = Math.max(maxSuffix, parseInt(m[1], 10))
  }
  return taken ? `${base}-${maxSuffix + 1}` : base
}

/**
 * Editing a draft can move it to another client or month, and its number
 * names both. A sent quotation keeps its number: the client already has it.
 */
export function needsRenumber(status: string, currentNumber: string, newBase: string): boolean {
  return status === 'draft' && !belongsToBase(currentNumber, newBase)
}

// ─── Links ────────────────────────────────────────────────────────────────────

export function quotationLink(origin: string, id: string): string {
  return `${origin.replace(/\/$/, '')}/dashboard/quotations/${encodeURIComponent(id)}`
}
