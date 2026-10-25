'use server'

/**
 * Internal transfers — create, edit, delete and convert, always BOTH legs.
 *
 * The rules (validation, currencies, which entries may pair up) live in
 * lib/cashbook/transfers.ts and are unit-tested there; this file is the
 * database side. Every write that touches both legs is ONE statement where
 * PostgREST allows it (a two-row insert, an update filtered on
 * transfer_ref / id list), so a transfer can never be left half-written.
 *
 * Permission requirement: cashbook.edit
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { retryWithoutScope, withoutScope } from '@/lib/finance/classify'
import { ENTRY_SELECT } from '@/lib/cashbook/entry-select'
import {
  buildTransferLegs, convertBlocker, validateTransfer,
  type RateMap, type TransferAccount, type TransferInput,
} from '@/lib/cashbook/transfers'

const REVALIDATE = '/dashboard/cashbook'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

type Admin = ReturnType<typeof createAdminClient>

async function loadAccountsAndRates(admin: Admin, ids: string[]): Promise<{ accounts: TransferAccount[]; rates: RateMap }> {
  const [{ data: accounts }, { data: rateRows }] = await Promise.all([
    admin.from('bank_accounts').select('id, name, currency, is_active').in('id', ids),
    admin.from('exchange_rates').select('currency, rate_to_inr'),
  ])
  const rates: RateMap = { INR: 1 }
  for (const r of (rateRows ?? []) as { currency: string; rate_to_inr: number }[]) {
    if (r.currency) rates[r.currency.toUpperCase()] = Number(r.rate_to_inr)
  }
  return { accounts: (accounts ?? []) as TransferAccount[], rates }
}

/** Both live legs of a transfer, outflow first — or an error if it is not whole. */
async function loadLegs(admin: Admin, transferRef: string) {
  const { data, error } = await admin.from('cashbook_entries')
    .select('*').eq('transfer_ref', transferRef).is('deleted_at', null)
  if (error) return { error: error.message }
  const legs = (data ?? []) as any[]
  const outflow = legs.find(l => l.type === 'outflow')
  const inflow = legs.find(l => l.type === 'inflow')
  if (legs.length !== 2 || !outflow || !inflow) {
    return { error: `This transfer has ${legs.length} live leg${legs.length === 1 ? '' : 's'} instead of 2 — fix it from the Reconciliation Toolkit` }
  }
  return { outflow, inflow }
}

// ─── Create ──────────────────────────────────────────────────────────────────

/**
 * Creates the matched pair (outflow + inflow) linked by one transfer_ref.
 * Neither leg has a category: a transfer is not income or expense.
 */
export async function insertTransfer(
  payload: TransferInput,
): Promise<ActionResult<{ outflow: any; inflow: any }>> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { accounts, rates } = await loadAccountsAndRates(admin, [payload.from_account_id, payload.to_account_id])
  const errors = validateTransfer(payload, accounts, rates)
  if (errors.length) return { ok: false, error: errors[0] }

  const { outflow, inflow } = buildTransferLegs(payload, accounts, rates)
  const transferRef = crypto.randomUUID()

  // No `created_by` on either leg — deliberately. It marks hand-typed cash-book
  // rows for the per-entry ownership basis, and one transfer writes two rows
  // that are neither income nor expense; attributing them would pay twice for
  // one action. (The counting query also excludes `transfer_ref` rows.)
  const rows = [outflow, inflow].map(l => ({
    ...l,
    transfer_ref: transferRef,
    category_id: null,
    scope: 'company' as const,   // account-to-account moves are Cirqle's own books
  }))

  // ONE insert of both rows: a single statement, so both land or neither does.
  const { data, error } = await retryWithoutScope(strip =>
    admin.from('cashbook_entries').insert(strip ? rows.map(withoutScope) : rows).select(ENTRY_SELECT))
  if (error) return { ok: false, error: error.message }

  const saved = (data ?? []) as any[]
  revalidatePath(REVALIDATE)
  return {
    ok: true,
    data: {
      outflow: saved.find(r => r.type === 'outflow'),
      inflow: saved.find(r => r.type === 'inflow'),
    },
  }
}

// ─── Edit both legs ──────────────────────────────────────────────────────────

/**
 * Rewrites both legs from one set of transfer details. Refused while either
 * leg is matched to a bank statement line and the money, date or accounts
 * would change — that match is a reconciled fact, and silently changing what
 * it points at would make a balanced period wrong.
 */
export async function updateTransfer(
  transferRef: string,
  payload: TransferInput,
): Promise<ActionResult<{ outflow: any; inflow: any }>> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const legs = await loadLegs(admin, transferRef)
  if ('error' in legs) return { ok: false, error: legs.error }

  const { accounts, rates } = await loadAccountsAndRates(admin, [payload.from_account_id, payload.to_account_id])
  const errors = validateTransfer(payload, accounts, rates)
  if (errors.length) return { ok: false, error: errors[0] }
  const next = buildTransferLegs(payload, accounts, rates)

  const moneyChanged =
    next.outflow.bank_account_id !== legs.outflow.bank_account_id ||
    next.inflow.bank_account_id !== legs.inflow.bank_account_id ||
    Number(next.outflow.amount) !== Number(legs.outflow.amount) ||
    Number(next.inflow.amount) !== Number(legs.inflow.amount) ||
    next.outflow.entry_date !== legs.outflow.entry_date
  if (moneyChanged) {
    const { data: matches, error: matchErr } = await admin.from('bank_statement_matches')
      .select('cashbook_entry_id').in('cashbook_entry_id', [legs.outflow.id, legs.inflow.id])
    if (!matchErr && (matches ?? []).length > 0) {
      return { ok: false, error: 'A leg of this transfer is matched to a bank statement line — unmatch it on the Bank page before changing the amount, date or accounts' }
    }
  }

  const patch = (leg: typeof next.outflow) => {
    const { type: _type, ...rest } = leg
    return rest
  }
  const { error: outErr } = await admin.from('cashbook_entries')
    .update(patch(next.outflow)).eq('id', legs.outflow.id)
  if (outErr) return { ok: false, error: outErr.message }
  const { error: inErr } = await admin.from('cashbook_entries')
    .update(patch(next.inflow)).eq('id', legs.inflow.id)
  if (inErr) {
    // Put the first leg back rather than leave the pair disagreeing.
    const { id: _id, ...before } = legs.outflow
    await admin.from('cashbook_entries').update({
      bank_account_id: before.bank_account_id, amount: before.amount, currency: before.currency,
      exchange_rate: before.exchange_rate, amount_inr: before.amount_inr, rate_source: before.rate_source,
      rate_date: before.rate_date, entry_date: before.entry_date, description: before.description,
    }).eq('id', legs.outflow.id)
    return { ok: false, error: inErr.message }
  }

  const { data: saved } = await admin.from('cashbook_entries')
    .select(ENTRY_SELECT).in('id', [legs.outflow.id, legs.inflow.id])
  const rows = (saved ?? []) as any[]
  revalidatePath(REVALIDATE)
  return {
    ok: true,
    data: { outflow: rows.find(r => r.type === 'outflow'), inflow: rows.find(r => r.type === 'inflow') },
  }
}

// ─── Convert two legacy entries into one transfer ────────────────────────────

/**
 * Pairs an existing expense on one account with an existing income on
 * another — same date, same INR amount — into one transfer. For money moved
 * between accounts before the Transfer button existed, typed in as two
 * separate entries and so counted as both income and expense.
 *
 * Both rows keep their ids, descriptions and bank statement matches; they
 * lose their category, client tag and employee cost split, none of which
 * means anything on a transfer.
 */
export async function convertToTransfer(
  entryIdA: string,
  entryIdB: string,
): Promise<ActionResult<{ transferRef: string; ids: string[] }>> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!entryIdA || !entryIdB || entryIdA === entryIdB) return { ok: false, error: 'Pick two different entries' }

  const admin = createAdminClient()
  const { data, error } = await admin.from('cashbook_entries')
    .select(`*,
      allocations:cashbook_invoice_allocations!cashbook_entry_id(deleted_at),
      payroll_allocations:cashbook_payroll_allocations!cashbook_entry_id(deleted_at),
      expense_billings:invoice_expense_items(id)`)
    .in('id', [entryIdA, entryIdB])
  if (error) return { ok: false, error: error.message }
  const rows = (data ?? []) as any[]
  if (rows.length !== 2) return { ok: false, error: 'One of the entries was not found' }
  const [a, b] = rows

  // Reversed entries cannot pair up either (no-op before the reversal migration).
  const reversedIds = new Set<string>()
  const { data: revs, error: revErr } = await admin.from('cashbook_entries')
    .select('reversal_of').in('reversal_of', [a.id, b.id]).is('deleted_at', null)
  if (!revErr) for (const r of (revs ?? []) as { reversal_of: string }[]) reversedIds.add(r.reversal_of)

  for (const r of rows) {
    const why = convertBlocker(r, reversedIds)
    if (why) return { ok: false, error: `${r.description || 'Entry'}: ${why}` }
  }
  if (a.type === b.type) return { ok: false, error: 'One entry must be an expense and the other an income' }
  if (a.bank_account_id === b.bank_account_id) return { ok: false, error: 'The two entries are on the same account' }
  if (a.entry_date !== b.entry_date) return { ok: false, error: 'The two entries are on different dates' }
  if (Math.abs(Number(a.amount_inr) - Number(b.amount_inr)) >= 0.005) return { ok: false, error: 'The two entries are for different amounts' }

  const transferRef = crypto.randomUUID()
  const ids = [a.id, b.id]
  const { error: upErr } = await retryWithoutScope(strip => {
    const patch = { transfer_ref: transferRef, category_id: null, client_id: null, scope: 'company' as const }
    return admin.from('cashbook_entries')
      .update(strip ? withoutScope(patch) : patch)
      .in('id', ids)
      .is('transfer_ref', null)   // a concurrent conversion cannot re-pair a leg
  })
  if (upErr) return { ok: false, error: upErr.message }

  try {
    await admin.from('cashbook_entry_employee_splits').delete().in('cashbook_entry_id', ids)
  } catch { /* splits table not migrated */ }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { transferRef, ids } }
}
