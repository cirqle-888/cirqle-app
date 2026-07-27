/**
 * Agreement Numbering — single source of truth
 * ============================================
 * Format:  AGR-{YYMM}-{ClientCode}
 * Example: AGR-2607-004
 *
 * YYMM        = agreement creation month
 * ClientCode  = the client's registered code, e.g. "001", "004"
 *
 * Duplicate handling (same client + same creation month):
 *   Normal case:    AGR-2607-004   (unique)
 *   First duplicate: AGR-2607-004A
 *   Further:        AGR-2607-004-2, AGR-2607-004-3, …
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GeneratedAgreementNumber {
  /** Full formatted number, e.g. "AGR-2607-004" */
  agreementNumber: string
  /** YYMM string used, e.g. "2607" */
  sequenceMonth: string
  /** The client code embedded in the number, e.g. "004" */
  clientCode: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a Date as YYYY-MM-DD using its LOCAL calendar fields.
 *
 * IMPORTANT: never use `date.toISOString().split('T')[0]` for a calendar date.
 * In Asia/Calcutta (UTC+5:30) a local-midnight Date serialises to the PREVIOUS
 * day in UTC (e.g. 2025-09-01 00:00 IST → 2025-08-31T18:30Z → "2025-08-31"),
 * which silently shifts dates a day early. This helper reads the local Y/M/D
 * directly so the string matches what the user sees.
 */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Convert a Date to a YYMM string (two-digit year + zero-padded month).
 * e.g.  new Date('2026-07-01') → '2607'
 */
export function toSequenceMonth(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${yy}${mm}`
}

// ─── Core number generation ───────────────────────────────────────────────────

/**
 * Generate an agreement number in the format AGR-{YYMM}-{clientCode}.
 *
 * Checks the DB for existing agreements with the same base number and applies a
 * minimal suffix only when a duplicate would otherwise occur:
 *   AGR-2607-004     ← normal
 *   AGR-2607-004A    ← first duplicate
 *   AGR-2607-004-2   ← second duplicate
 *
 * @param supabase      Supabase client (server or browser)
 * @param creationDate  The date the agreement is being created (determines YYMM)
 * @param clientCode    The client's registered code, e.g. "004"
 */
export async function generateAgreementNumber(
  supabase: SupabaseClient,
  creationDate: Date,
  clientCode: string,
): Promise<GeneratedAgreementNumber> {
  const sequenceMonth = toSequenceMonth(creationDate)
  const baseNumber = `AGR-${sequenceMonth}-${clientCode}`

  // Fetch all existing numbers that share this prefix (handles suffixes too)
  const { data: existing } = await supabase
    .from('client_agreements')
    .select('agreement_number')
    .like('agreement_number', `${baseNumber}%`)

  const taken = new Set((existing || []).map((r: any) => r.agreement_number as string))

  // Happy path — no duplicate
  if (!taken.has(baseNumber)) {
    return { agreementNumber: baseNumber, sequenceMonth, clientCode }
  }

  // First duplicate → append 'A'
  const withA = `${baseNumber}A`
  if (!taken.has(withA)) {
    return { agreementNumber: withA, sequenceMonth, clientCode }
  }

  // Further duplicates → append '-2', '-3', …
  let n = 2
  while (taken.has(`${baseNumber}-${n}`)) n++
  return { agreementNumber: `${baseNumber}-${n}`, sequenceMonth, clientCode }
}
