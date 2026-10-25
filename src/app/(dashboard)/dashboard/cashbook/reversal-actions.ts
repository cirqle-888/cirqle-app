'use server'

/**
 * Return / Reverse — recording money the bank handed back.
 *
 * The rules live in lib/cashbook/reversal.ts. This writes, in order:
 *
 *   1. the reversal entry (opposite type, same account and category, linked
 *      by `reversal_of`) — the unique index refuses a second live one;
 *   2. the release of the original's invoice and payroll allocations,
 *      stamped with the reversal's id. The allocation tables' own triggers
 *      then recompute: the invoice's paid amount falls back, the payslip
 *      returns to pending, exactly as if the allocation had been removed by
 *      hand;
 *   3. the side effects that follow the money: the expense comes off a
 *      DRAFT invoice it was rebilled on, and campaign funding it backed is
 *      released.
 *
 * Undo is deleting the reversal (softDeleteCashbookEntry), which puts back
 * precisely the allocations stamped in step 2.
 *
 * Needs migration 20261016100000. Before it, the action says so and writes
 * nothing.
 *
 * Permission requirement: cashbook.edit
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { retryWithoutScope, withoutScope, missingColumnName } from '@/lib/finance/classify'
import { syncDraftInvoiceExpenses } from '@/lib/sync/integrity'
import { releaseEntryFunding } from '@/lib/cashbook/release-funding'
import { ENTRY_SELECT } from '@/lib/cashbook/entry-select'
import { buildReversalRow, reverseBlocker } from '@/lib/cashbook/reversal'
import { todayISO } from '@/lib/utils/local-date'

const REVALIDATE = '/dashboard/cashbook'
const MIGRATION_NEEDED = 'Returns need database migration 20261016100000_cashbook_reversals — apply it, then try again'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

export interface ReversePayload {
  /** When the bank returned the money; defaults to today. */
  entry_date?: string
  note?: string
}

export async function reverseCashbookEntry(
  entryId: string,
  payload: ReversePayload = {},
): Promise<ActionResult<{ reversal: any; released: { invoices: number; payslips: number } }>> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const entryDate = payload.entry_date || todayISO()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return { ok: false, error: 'Date is not a valid date' }

  const admin = createAdminClient()
  const { data: original, error: loadErr } = await admin.from('cashbook_entries')
    .select('*, category:cashbook_categories(account_code)')
    .eq('id', entryId).maybeSingle()
  if (loadErr) return { ok: false, error: loadErr.message }
  if (!original) return { ok: false, error: 'Entry not found' }
  const orig = original as any
  if (entryDate < orig.entry_date) return { ok: false, error: 'A return cannot be dated before the payment it returns' }

  // Already reversed? This query is also the migration check.
  const { data: existing, error: revErr } = await admin.from('cashbook_entries')
    .select('id').eq('reversal_of', entryId).is('deleted_at', null)
  if (revErr) return { ok: false, error: missingColumnName(revErr) || /reversal_of/.test(revErr.message ?? '') ? MIGRATION_NEEDED : revErr.message }
  const reversedIds = new Set<string>((existing ?? []).length ? [entryId] : [])

  // Rebilled to the client on an invoice that has gone out? Then the client
  // has been charged for it, and that is fixed on the invoice, not here.
  let billedOnIssuedInvoice: string | null = null
  const { data: billed } = await admin.from('invoice_expense_items')
    .select('invoice:invoices(invoice_number, status)').eq('cashbook_entry_id', entryId)
  for (const b of (billed ?? []) as any[]) {
    const inv = Array.isArray(b.invoice) ? b.invoice[0] : b.invoice
    if (inv && inv.status !== 'draft') billedOnIssuedInvoice = inv.invoice_number || 'an issued invoice'
  }

  const category = Array.isArray(orig.category) ? orig.category[0] : orig.category
  const why = reverseBlocker(orig, { reversedIds, accountCode: category?.account_code ?? null, billedOnIssuedInvoice })
  if (why) return { ok: false, error: why }

  const row = buildReversalRow(orig, { entry_date: entryDate, note: payload.note })
  const { data: inserted, error: insErr } = await retryWithoutScope(strip =>
    admin.from('cashbook_entries').insert(strip ? withoutScope(row) : row).select(ENTRY_SELECT).single())
  if (insErr) {
    if (insErr.code === '23505') return { ok: false, error: 'This entry has already been reversed' }
    if (missingColumnName(insErr) === 'reversal_of') return { ok: false, error: MIGRATION_NEEDED }
    return { ok: false, error: insErr.message }
  }
  const reversal = inserted as any

  // Release what the original paid for, stamped so an undo can restore it.
  const now = new Date().toISOString()
  const released = { invoices: 0, payslips: 0 }
  for (const [table, key] of [
    ['cashbook_invoice_allocations', 'invoices'],
    ['cashbook_payroll_allocations', 'payslips'],
  ] as const) {
    const { data: rows, error } = await admin.from(table)
      .update({ deleted_at: now, released_by_entry_id: reversal.id })
      .eq('cashbook_entry_id', entryId)
      .is('deleted_at', null)
      .select('id')
    if (error) {
      // The entry is in; say plainly what did not happen rather than undo it.
      return { ok: false, error: `Return recorded, but its ${key} could not be released: ${error.message}` }
    }
    released[key] = (rows ?? []).length
  }

  await syncDraftInvoiceExpenses(entryId, { released: true })
  await releaseEntryFunding(admin, entryId)

  revalidatePath(REVALIDATE)
  return { ok: true, data: { reversal, released } }
}
