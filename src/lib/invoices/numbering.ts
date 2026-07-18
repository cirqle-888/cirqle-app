/**
 * Invoice Numbering — single source of truth
 * ============================================
 * Format:  INV-{YYMM}-{ClientCode}
 * Example: INV-2509-001
 *
 * YYMM        = invoice ISSUE month (NOT the task/billing-period month)
 * ClientCode  = the client's registered code, e.g. "001", "004"
 *               NOT a running sequence — preserves the old Google Sheets workflow
 *
 * Duplicate handling (same client + same billing month):
 *   Normal case:    INV-2509-001   (unique — one invoice per client per month)
 *   First duplicate: INV-2509-001A
 *   Further:        INV-2509-001-2, INV-2509-001-3, …
 *
 * Billing cycle separation
 * ------------------------
 * Task month ≠ invoice issue month.
 * By default (nextMonthBilling = true), tasks done in August are invoiced
 * on 1 Sep, so the invoice number carries YYMM = "2509" while billing_period_*
 * fields record the August dates. This is proper accounting practice.
 *
 * Backward compatibility
 * ----------------------
 * Old invoices (pre-migration format or different numbering) are untouched.
 * The duplicate-check query uses LIKE so it naturally avoids conflicts with
 * any pre-existing number that happens to start with the same prefix.
 *
 * Configuration
 * -------------
 * Pass an InvoiceNumberConfig to customise prefix or billing behaviour.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InvoiceNumberConfig {
  /** Invoice number prefix. Default: 'INV' */
  prefix?: string
  /**
   * When true (default), historical batch generation issues the invoice in
   * the NEXT calendar month after the task/billing month.
   * e.g.  tasks in Aug → invoice issued Sep 1
   * Set false to invoice in the same month as the tasks.
   */
  nextMonthBilling?: boolean
}

export interface GeneratedInvoiceNumber {
  /** Full formatted number, e.g. "INV-2509-001" */
  invoiceNumber: string
  /** YYMM string used (the invoice issue month), e.g. "2509" */
  sequenceMonth: string
  /** The client code embedded in the number, e.g. "001" */
  clientCode: string
}

export interface BillingPeriod {
  billing_period_start: string   // YYYY-MM-DD  first day of task month
  billing_period_end:   string   // YYYY-MM-DD  last day of task month
  billing_period_label: string   // e.g. "August 2025"
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a Date as YYYY-MM-DD using its LOCAL calendar fields.
 *
 * IMPORTANT: never use `date.toISOString().split('T')[0]` for a calendar date.
 * In Asia/Calcutta (UTC+5:30) a local-midnight Date serialises to the PREVIOUS
 * day in UTC (e.g. 2025-09-01 00:00 IST → 2025-08-31T18:30Z → "2025-08-31"),
 * which silently shifts invoice issue/due/period-end dates a day (and a month)
 * early. This helper reads the local Y/M/D directly so the string matches what
 * the user sees.
 */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Convert a Date to a YYMM string (two-digit year + zero-padded month).
 * e.g.  new Date('2025-09-01') → '2509'
 */
export function toSequenceMonth(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${yy}${mm}`
}

/**
 * Build the base invoice number from its parts (no suffix).
 * e.g.  ('INV', '2509', '001') → 'INV-2509-001'
 */
export function formatInvoiceNumber(
  sequenceMonth: string,
  clientCode: string,
  config: InvoiceNumberConfig = {},
): string {
  const prefix = config.prefix ?? 'INV'
  return `${prefix}-${sequenceMonth}-${clientCode}`
}

/**
 * For historical batch generation: given the task/billing month string
 * (e.g. '2025-08'), return the Date on which the invoice should be issued.
 *
 * Default behaviour (nextMonthBilling = true):
 *   Aug tasks → invoice issued on Sep 1
 *
 * This correctly separates "billing period" from "invoice issue date".
 */
export function getInvoiceDateForTaskMonth(
  taskMonth: string,         // 'YYYY-MM'
  config: InvoiceNumberConfig = {},
): Date {
  const nextMonth = config.nextMonthBilling ?? true
  const [year, month] = taskMonth.split('-').map(Number)

  if (!nextMonth) {
    return new Date(year, month - 1, 1)  // 1st of same month
  }

  // Move forward one month (handles Dec → Jan year roll-over)
  const invoiceYear  = month === 12 ? year + 1 : year
  const invoiceMonth = month === 12 ? 1 : month + 1
  return new Date(invoiceYear, invoiceMonth - 1, 1)  // 1st of next month
}

/**
 * Build all billing_period_* fields for a task/billing month string.
 * e.g.  '2025-08' → { start: '2025-08-01', end: '2025-08-31', label: 'August 2025' }
 */
export function buildBillingPeriod(taskMonth: string): BillingPeriod {
  const [year, month] = taskMonth.split('-').map(Number)
  const lastDay = new Date(year, month, 0).getDate()  // day 0 of next month = last day of this month
  return {
    billing_period_start: `${taskMonth}-01`,
    billing_period_end:   `${taskMonth}-${String(lastDay).padStart(2, '0')}`,
    billing_period_label: new Date(year, month - 1, 1)
      .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
  }
}

// ─── Core number generation ───────────────────────────────────────────────────

/**
 * Generate an invoice number in the format INV-{YYMM}-{clientCode}.
 *
 * Checks the DB for existing invoices with the same base number and applies a
 * minimal suffix only when a duplicate would otherwise occur:
 *   INV-2509-001     ← normal
 *   INV-2509-001A    ← first duplicate
 *   INV-2509-001-2   ← second duplicate
 *   INV-2509-001-3   ← etc.
 *
 * @param supabase    Supabase client (server or browser)
 * @param invoiceDate The date the invoice is being issued (determines YYMM)
 * @param clientCode  The client's registered code, e.g. "001"
 * @param config      Optional configuration overrides
 */
export async function generateInvoiceNumber(
  supabase: SupabaseClient,
  invoiceDate: Date,
  clientCode: string,
  config: InvoiceNumberConfig = {},
): Promise<GeneratedInvoiceNumber> {
  const sequenceMonth = toSequenceMonth(invoiceDate)
  const prefix = config.prefix ?? 'INV'
  const baseNumber = `${prefix}-${sequenceMonth}-${clientCode}`

  // Fetch all existing numbers that share this prefix (handles suffixes too)
  const { data: existing } = await supabase
    .from('invoices')
    .select('invoice_number')
    .like('invoice_number', `${baseNumber}%`)

  const taken = new Set((existing || []).map((r: any) => r.invoice_number as string))

  // Happy path — no duplicate
  if (!taken.has(baseNumber)) {
    return { invoiceNumber: baseNumber, sequenceMonth, clientCode }
  }

  // First duplicate → append 'A'
  const withA = `${baseNumber}A`
  if (!taken.has(withA)) {
    return { invoiceNumber: withA, sequenceMonth, clientCode }
  }

  // Further duplicates → append '-2', '-3', …
  let n = 2
  while (taken.has(`${baseNumber}-${n}`)) n++
  return { invoiceNumber: `${baseNumber}-${n}`, sequenceMonth, clientCode }
}
