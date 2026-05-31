'use server'

/**
 * Cashbook server actions — all write operations go through here.
 *
 * Permission requirement: cashbook.edit
 * Admins bypass the permission check (is_admin designation).
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/auth/enforce'
import { PERMS } from '@/lib/permissions/keys'

const REVALIDATE = '/dashboard/cashbook'

interface ActionResult<T = void> {
  ok: boolean
  error?: string
  data?: T
}

// ─── Full entry select used for returning newly-created rows ──────────────────

const ENTRY_SELECT = `
  *,
  category:cashbook_categories(id, name, type),
  bank_account:bank_accounts(id, name),
  allocations:cashbook_allocations(
    id, invoice_id, allocated_amount, deleted_at,
    invoice:invoices(invoice_number, status, due_date, total_amount, paid_amount, client:clients(name))
  ),
  payroll_allocations:payroll_allocations(
    id, payroll_id, allocated_amount, deleted_at,
    payroll:payrolls(net_salary, status, employee:employees(name, cqid))
  )
`.trim()

// ─── Insert cashbook entry (possibly recurring) ───────────────────────────────

export interface CashbookEntryPayload {
  type: 'inflow' | 'outflow'
  category_id: string | undefined
  bank_account_id: string | null
  amount: number
  currency: string
  amount_inr: number
  // FX: the rate used (rate_to_inr), where it came from, and its value date.
  exchange_rate: number
  rate_source: string
  rate_date: string
  entry_date: string
  description: string
  reference: string
  invoice_id: string | null
}

export interface SmartEffect {
  mode: 'credit_given' | 'credit_return' | null
  entity_type?: string
  entity_id?: string | null
  entity_other?: string
  credit_id?: string
}

// ─── Receipt number generator ─────────────────────────────────────────────────
//
// Format:  RCPT-{YYMM}-{NNN}-CQ{ClientCode}
//   e.g.   RCPT-2606-001-CQ042
//
// Breakdown:
//   RCPT          = document type
//   YYMM          = entry date month (two-digit year + zero-padded month)
//   NNN           = global sequential counter for the month (001, 002, …)
//                   NOT per-client — increments regardless of which client pays
//   CQ{code}      = "CQ" Cirqle brand prefix + client's registered code
//
// Sequence is global so:
//   RCPT-2606-001-CQ042   (client 042 pays first)
//   RCPT-2606-002-CQ015   (client 015 pays next)
//   RCPT-2606-003-CQ042   (client 042 pays again — new seq, same client suffix)
//
// clientCode = 'GEN' when there is no linked invoice / unknown client, giving:
//   RCPT-2606-004-GEN
//
// Race-condition safety: the UNIQUE index on receipt_number
// (migrations/011_cashbook_receipt_number.sql) means concurrent inserts that
// accidentally pick the same seq will have one fail the DB constraint. The
// caller (insertCashbookEntries) inserts all rows in a single .insert() call,
// so within a batch the race doesn't apply. For simultaneous independent
// requests the index is the final guard.
async function generateReceiptNumber(
  admin: ReturnType<typeof createAdminClient>,
  entryDate: string,
  clientCode: string,
): Promise<string> {
  const d = new Date(entryDate)
  const yy = String(d.getFullYear()).slice(-2)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const monthPrefix = `RCPT-${yy}${mm}-`

  // Fetch all receipt numbers for this month to find the current maximum seq.
  const { data } = await admin
    .from('cashbook_entries')
    .select('receipt_number')
    .like('receipt_number', `${monthPrefix}%`)

  let maxSeq = 0
  for (const row of (data as { receipt_number: string | null }[] | null) ?? []) {
    if (!row.receipt_number) continue
    // Format: RCPT-2606-001-CQ042  →  parts[2] = '001'
    const parts = row.receipt_number.split('-')
    const seq = parseInt(parts[2] ?? '0', 10)
    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq
  }

  const nextSeq = String(maxSeq + 1).padStart(3, '0')
  const suffix = clientCode ? `CQ${clientCode.toUpperCase()}` : 'GEN'
  return `${monthPrefix}${nextSeq}-${suffix}`
}

export async function insertCashbookEntries(
  baseDates: string[],
  basePayload: Omit<CashbookEntryPayload, 'entry_date'>,
  baseDescription: string,
  smartEffect: SmartEffect,
): Promise<ActionResult<{ entries: any[] }>> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // Resolve the client code once (used for all dates in a recurring series).
  // Lookup order: linked invoice → its client's code → fallback 'GEN'.
  let clientCode = 'GEN'
  if (basePayload.type === 'inflow' && basePayload.invoice_id) {
    const { data: invRow } = await admin
      .from('invoices')
      .select('client:clients(code)')
      .eq('id', basePayload.invoice_id)
      .maybeSingle()
    const code = (invRow as any)?.client?.code
    if (code) clientCode = String(code).toUpperCase()
  }

  // Generate receipt numbers for inflow entries only. Each date in a recurring
  // series gets its own number so they are individually identifiable.
  const receiptNumbers: (string | null)[] = await Promise.all(
    baseDates.map(date =>
      basePayload.type === 'inflow'
        ? generateReceiptNumber(admin, date, clientCode)
        : Promise.resolve(null)
    )
  )

  const rows = baseDates.map((entry_date, i) => ({
    ...basePayload,
    entry_date,
    receipt_number: receiptNumbers[i],
    description: i > 0 && baseDates.length > 1
      ? `${baseDescription}${baseDescription ? ' ' : ''}(recurring ${i + 1}/${baseDates.length})`
      : baseDescription,
  }))

  const { data, error } = await admin
    .from('cashbook_entries')
    .insert(rows)
    .select(ENTRY_SELECT)

  if (error) return { ok: false, error: error.message }

  const allInserted = Array.isArray(data) ? data : data ? [data] : []
  const firstEntry = allInserted[0]

  // Smart mode side effects on the base (first) entry
  if (firstEntry) {
    if (smartEffect.mode === 'credit_given' && (smartEffect.entity_id || smartEffect.entity_other)) {
      await admin.from('credit_ledger').insert({
        entity_type: smartEffect.entity_type || 'employee',
        entity_id: smartEffect.entity_id || null,
        credit_type: 'given',
        amount: basePayload.amount,
        credit_date: baseDates[0],
        bank_account_id: basePayload.bank_account_id,
        notes: smartEffect.entity_other
          ? `${baseDescription}${smartEffect.entity_other ? ` (${smartEffect.entity_other})` : ''}`.trim()
          : baseDescription || null,
      })
    }
    if (smartEffect.mode === 'credit_return' && smartEffect.credit_id) {
      await admin.from('credit_ledger').insert({
        entity_type: smartEffect.entity_type || 'employee',
        entity_id: smartEffect.entity_id || null,
        credit_type: 'returned',
        amount: basePayload.amount,
        credit_date: baseDates[0],
        bank_account_id: basePayload.bank_account_id,
        notes: baseDescription || null,
      })
    }
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { entries: allInserted } }
}

// ─── Update cashbook entry (inline edit) ─────────────────────────────────────

export interface CashbookEntryUpdate {
  entry_date: string
  amount: number
  amount_inr: number
  currency: string
  exchange_rate: number
  rate_source: string
  rate_date: string
  category_id: string | undefined
  bank_account_id: string | null
  description: string
  reference: string
}

export async function updateCashbookEntry(
  id: string,
  changes: CashbookEntryUpdate,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('cashbook_entries')
    .update(changes)
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Soft-delete cashbook entry ───────────────────────────────────────────────

export async function softDeleteCashbookEntry(id: string): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('cashbook_entries')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}
