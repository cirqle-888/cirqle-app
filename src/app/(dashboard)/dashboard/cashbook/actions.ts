'use server'

/**
 * Cashbook server actions — all write operations go through here.
 *
 * Permission requirement: cashbook.edit
 * Admins bypass the permission check (is_admin designation).
 */

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { requirePermission } from '@/lib/permissions/check'
import { PERMS } from '@/lib/permissions/keys'
import { fetchRates } from '@/lib/fx/sync'
import { syncDraftInvoiceExpenses } from '@/lib/sync/integrity'
import { recomputeCampaignBilling } from '@/lib/advertising/billing'
import { logActivity } from '@/lib/activity/log'
import { retryWithoutScope, withoutScope, type FinanceScope } from '@/lib/finance/classify'
import { computeEqualSplit } from '@/lib/finance/splits'
import { todayISO } from '@/lib/utils/local-date'

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
  allocations:cashbook_invoice_allocations(
    id, invoice_id, allocated_amount, deleted_at,
    invoice:invoices(invoice_number, status, due_date, total_amount, paid_amount, client:clients(name))
  ),
  payroll_allocations:cashbook_payroll_allocations(
    id, payroll_id, allocated_amount, deleted_at,
    payroll:payroll(net_salary, status, employee:employees(name, cqid))
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
  client_id: string | null      // entity tag for per-client FIFO allocation
  // Finance dimension: 'client' | 'company' | null (null = leave untriaged —
  // the DB trigger may still derive it from client/employee/category).
  scope?: FinanceScope | null
  // Free-form spend tags (e.g. "Photoshop", "Design") for ad-hoc reporting.
  tags?: string[]
  // Employees sharing this expense — split equally (see computeEqualSplit).
  employee_split_ids?: string[]
  // Explicit split of this receipt across several invoices, in ₹ (INR) — the
  // currency `cashbook_invoice_allocations.allocated_amount` is always in.
  //
  // When present, the entry is inserted with invoice_id = NULL: the
  // `auto_create_allocation_on_entry` trigger reacts to invoice_id by dumping
  // the FULL amount_inr onto that one invoice, which is exactly what a split
  // must not do. These rows are written instead, and for a single-invoice
  // split the invoice_id link is restored afterwards (the trigger is
  // INSERT-only, so a later UPDATE can't duplicate the allocation).
  allocations?: { invoice_id: string; allocated_amount: number }[]
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
// Format:  RCPT-{YYMM}-CQ{ClientCode}-{NNN}
//   e.g.   RCPT-2606-CQ042-001
//
// Delegates to the PostgreSQL function `generate_receipt_number` (created by
// migration 011) via supabase.rpc(). The function atomically increments a
// per-month counter in `receipt_number_sequences` using INSERT … ON CONFLICT
// DO UPDATE … RETURNING, so two simultaneous server actions can never receive
// the same sequence value — no advisory locks or application retries required.
//
// The UNIQUE index on cashbook_entries.receipt_number is an additional safety
// net: if the DB function somehow returned a duplicate (e.g. a manual DB edit
// corrupted the counter), the INSERT would fail rather than silently create a
// duplicate receipt.
async function generateReceiptNumber(
  admin: ReturnType<typeof createAdminClient>,
  entryDate: string,
  clientCode: string,
): Promise<string | null> {
  const { data, error } = await (admin as any).rpc('generate_receipt_number', {
    p_entry_date:  entryDate,
    p_client_code: clientCode || null,
  })
  if (error || !data) {
    // Log and return null — insert will proceed without a receipt number
    // rather than blocking the cashbook entry creation entirely.
    console.error('[receipt-number] generate_receipt_number RPC failed:', error)
    return null
  }
  return data as string
}

// ─── Tags & employee cost splits ──────────────────────────────────────────────
// Both are best-effort against the optional 20260714160000 migration: on a
// pre-migration DB, saving still succeeds — the entry just has no tags/splits.

/** Find-or-create tags by name (case-insensitive), returning their ids. */
async function resolveOrCreateTagIds(
  admin: ReturnType<typeof createAdminClient>,
  names: string[],
): Promise<string[]> {
  const cleaned = [...new Set(names.map(n => n.trim()).filter(Boolean))]
  if (cleaned.length === 0) return []

  const ids: string[] = []
  for (const name of cleaned) {
    const { data: existing } = await admin
      .from('cashbook_tags').select('id').ilike('name', name).limit(1).maybeSingle()
    if (existing) { ids.push((existing as any).id); continue }

    const { data: created, error } = await admin
      .from('cashbook_tags').insert({ name }).select('id').single()
    if (created) {
      ids.push((created as any).id)
    } else if (error?.code === '23505') {
      // Lost a race to create the same new tag — use the winner's row.
      const { data: retry } = await admin
        .from('cashbook_tags').select('id').ilike('name', name).limit(1).maybeSingle()
      if (retry) ids.push((retry as any).id)
    }
  }
  return ids
}

/** Replace an entry's tag set. No-op (not an error) if the tags tables aren't migrated yet. */
async function saveEntryTags(
  admin: ReturnType<typeof createAdminClient>,
  entryId: string,
  tagNames: string[],
): Promise<void> {
  try {
    await admin.from('cashbook_entry_tags').delete().eq('cashbook_entry_id', entryId)
    const tagIds = await resolveOrCreateTagIds(admin, tagNames)
    if (tagIds.length > 0) {
      await admin.from('cashbook_entry_tags')
        .insert(tagIds.map(tag_id => ({ cashbook_entry_id: entryId, tag_id })))
    }
  } catch { /* tags tables not migrated yet */ }
}

/**
 * Replace an entry's employee cost splits with a fresh equal split of its
 * current amount. No-op (not an error) if the splits table isn't migrated yet.
 */
async function saveEntryEmployeeSplits(
  admin: ReturnType<typeof createAdminClient>,
  entryId: string,
  employeeIds: string[],
  amount: number,
  amountInr: number,
): Promise<void> {
  try {
    await admin.from('cashbook_entry_employee_splits').delete().eq('cashbook_entry_id', entryId)
    if (employeeIds.length === 0) return

    const nativeShares = computeEqualSplit(amount, employeeIds)
    const inrByEmployee = new Map(computeEqualSplit(amountInr, employeeIds).map(s => [s.employeeId, s.amount]))
    const rows = nativeShares.map(s => ({
      cashbook_entry_id: entryId,
      employee_id: s.employeeId,
      amount: s.amount,
      amount_inr: inrByEmployee.get(s.employeeId) ?? s.amount,
    }))
    if (rows.length > 0) await admin.from('cashbook_entry_employee_splits').insert(rows)
  } catch { /* splits table not migrated yet */ }
}

export async function insertCashbookEntries(
  baseDates: string[],
  basePayload: Omit<CashbookEntryPayload, 'entry_date'>,
  baseDescription: string,
  smartEffect: SmartEffect,
): Promise<ActionResult<{ entries: any[]; allocationError?: string }>> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // Tags, employee splits and invoice allocations aren't columns on
  // cashbook_entries — pull them out before building the insert payload and
  // apply them afterward.
  const { tags: entryTags, employee_split_ids: splitEmployeeIds, allocations, ...tableFields } = basePayload

  // A split receipt allocates itself explicitly (see `allocations` above);
  // anything without a positive ₹ amount is dropped rather than written as a
  // no-op row.
  const splitAllocations = (allocations ?? [])
    .filter(a => a.invoice_id && a.allocated_amount > 0)
  const isSplit = splitAllocations.length > 0

  // Resolve the client code once (used for all dates in a recurring series).
  // Lookup order: linked invoice (or the first invoice of a split) → its
  // client's code → the entry's own client tag → fallback 'GEN'.
  let clientCode = 'GEN'
  const receiptInvoiceId = basePayload.invoice_id || splitAllocations[0]?.invoice_id || null
  if (basePayload.type === 'inflow' && receiptInvoiceId) {
    const { data: invRow } = await admin
      .from('invoices')
      .select('client:clients(code)')
      .eq('id', receiptInvoiceId)
      .maybeSingle()
    const code = (invRow as any)?.client?.code
    if (code) clientCode = String(code).toUpperCase()
  }
  if (basePayload.type === 'inflow' && clientCode === 'GEN' && basePayload.client_id) {
    const { data: clientRow } = await admin
      .from('clients')
      .select('code')
      .eq('id', basePayload.client_id)
      .maybeSingle()
    const code = clientRow?.code
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
    ...tableFields,
    // A split receipt writes its own allocation rows below — see `allocations`.
    invoice_id: isSplit ? null : tableFields.invoice_id,
    entry_date,
    receipt_number: receiptNumbers[i],
    description: i > 0 && baseDates.length > 1
      ? `${baseDescription}${baseDescription ? ' ' : ''}(recurring ${i + 1}/${baseDates.length})`
      : baseDescription,
  }))

  const { data, error } = await retryWithoutScope(strip =>
    admin
      .from('cashbook_entries')
      .insert(strip ? rows.map(withoutScope) : rows)
      .select(ENTRY_SELECT)
  )

  if (error) return { ok: false, error: error.message }

  const allInserted = Array.isArray(data) ? data : data ? [data] : []
  const firstEntry = allInserted[0]

  // ── Explicit invoice split ──────────────────────────────────────────────────
  // Only the FIRST entry of a recurring series is allocated: the split names
  // specific invoices, and re-applying it to every copy would pay them several
  // times over. The DB's over-allocation trigger is the final authority — if it
  // rejects, the entry still stands and the error is surfaced so the user can
  // fix the split from the entry's allocation panel.
  let allocationError: string | undefined
  if (isSplit && firstEntry) {
    const entryId = (firstEntry as unknown as { id: string }).id
    const { error: allocErr } = await admin
      .from('cashbook_invoice_allocations')
      .insert(splitAllocations.map(a => ({
        cashbook_entry_id: entryId,
        invoice_id:        a.invoice_id,
        allocated_amount:  a.allocated_amount,
      })))

    if (allocErr) {
      allocationError = allocErr.message
      console.error('[cashbook] invoice allocation insert failed:', allocErr)
    } else {
      // A single-invoice split still deserves the direct invoice_id link that
      // the invoice page and reconciliation read. Safe here: the auto-allocate
      // trigger fires on INSERT only, so this can't duplicate the row above.
      if (splitAllocations.length === 1) {
        await admin
          .from('cashbook_entries')
          .update({ invoice_id: splitAllocations[0].invoice_id })
          .eq('id', entryId)
      }
      // Re-read the row so the caller renders the new allocation chips without
      // a refresh.
      const { data: refreshed } = await admin
        .from('cashbook_entries')
        .select(ENTRY_SELECT)
        .eq('id', entryId)
        .maybeSingle()
      if (refreshed) allInserted[0] = refreshed
    }
  }

  // Tags + employee splits apply to every occurrence in a recurring series
  // (same labels, split recomputed per-entry from that row's own amount).
  if (entryTags?.length || splitEmployeeIds?.length) {
    for (const entry of allInserted) {
      const entryId = (entry as any)?.id
      if (typeof entryId !== 'string') continue
      if (entryTags?.length) await saveEntryTags(admin, entryId, entryTags)
      if (splitEmployeeIds?.length) {
        await saveEntryEmployeeSplits(
          admin, entryId, splitEmployeeIds,
          Number((entry as any).amount ?? basePayload.amount),
          Number((entry as any).amount_inr ?? basePayload.amount_inr),
        )
      }
    }
  }

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

  // Auto-sync outflows to draft invoices if they have a client_id
  if (basePayload.type === 'outflow' && basePayload.client_id) {
    for (const entry of allInserted) {
      const entryId = (entry as any)?.id
      if (typeof entryId === 'string') {
        await syncDraftInvoiceExpenses(entryId)
      }
    }
  }

  // Timeline: expense / inflow recorded (one row for the series)
  if (firstEntry) {
    void logActivity({
      actorId: guard.employeeId, entityType: 'cashbook', entityId: (firstEntry as any).id,
      action: basePayload.type === 'outflow' ? 'expense_added' : 'payment_received',
      category: 'finance', clientId: basePayload.client_id ?? null,
      detail: { label: baseDescription || basePayload.type, amount: basePayload.amount, currency: basePayload.currency, count: baseDates.length },
    })
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { entries: allInserted, allocationError } }
}

// ─── Update cashbook entry (inline edit) ─────────────────────────────────────

export interface CashbookEntryUpdate {
  entry_date: string
  type?: 'inflow' | 'outflow'
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
  client_id?: string | null
  scope?: FinanceScope | null
  tags?: string[]
  employee_split_ids?: string[]
}

export async function updateCashbookEntry(
  id: string,
  changes: CashbookEntryUpdate,
): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { tags: entryTags, employee_split_ids: splitEmployeeIds, ...tableFields } = changes
  const { error } = await retryWithoutScope(strip =>
    admin
      .from('cashbook_entries')
      .update(strip ? withoutScope(tableFields) : tableFields)
      .eq('id', id)
  )
  if (error) return { ok: false, error: error.message }

  // Tags/splits are always replaced with the submitted set (including an
  // empty array — clearing all tags on edit is a valid, explicit action).
  if (entryTags !== undefined) await saveEntryTags(admin, id, entryTags)
  if (splitEmployeeIds !== undefined) {
    await saveEntryEmployeeSplits(admin, id, splitEmployeeIds, changes.amount, changes.amount_inr)
  }

  // Sync potential expense changes to draft invoice
  await syncDraftInvoiceExpenses(id)

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

  // Release any campaign fund allocations backed by this entry and re-derive
  // the affected campaigns' billing (best-effort — table may not be migrated).
  try {
    const { data: allocs } = await admin
      .from('ad_fund_allocations').select('id, ad_project_id')
      .eq('cashbook_entry_id', id).is('deleted_at', null)
    if (allocs && allocs.length > 0) {
      await admin.from('ad_fund_allocations')
        .update({ deleted_at: new Date().toISOString() })
        .eq('cashbook_entry_id', id).is('deleted_at', null)
      const projectIds = [...new Set(allocs.map((a: any) => a.ad_project_id as string))]
      for (const pid of projectIds) await recomputeCampaignBilling(admin, pid)
    }
  } catch { /* ad_fund_allocations not migrated */ }

  // Release wallet credits funded by this entry (ledger rows stay for audit).
  // Campaign debits are left untouched — committed money is a finance decision;
  // any resulting negative wallet balance surfaces on the Advertising dashboard.
  try {
    await admin.from('ad_wallet_ledger')
      .update({ deleted_at: new Date().toISOString() })
      .eq('cashbook_entry_id', id).eq('direction', 'credit').is('deleted_at', null)
  } catch { /* ad_wallet_ledger not migrated */ }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Toggle Review Status ─────────────────────────────────────────────────────

export async function toggleCashbookEntryReview(id: string, is_reviewed: boolean): Promise<ActionResult> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()
  const { error } = await admin
    .from('cashbook_entries')
    .update({ is_reviewed })
    .eq('id', id)
  if (error) return { ok: false, error: error.message }

  revalidatePath(REVALIDATE)
  return { ok: true }
}

// ─── Allocation Rebuild Actions (admin only) ──────────────────────────────────
//
// Safe rebuild workflow:
//   1. backupAndResetAllocations() - snapshots existing rows, then soft-deletes
//      them all (triggers cascade to fix invoice paid_amounts to 0).
//   2. commitAllocationRebuild(proposals) - inserts the approved proposals so
//      the triggers fire and rebuild all invoice statuses from scratch.
//
// NOTHING is written until the user approves the preview in the UI.

export interface AllocationProposal {
  cashbook_entry_id: string
  invoice_id: string
  allocated_amount: number   // INR
}

/**
 * Step 1 of the rebuild: soft-delete all active invoice allocations (resets
 * every invoice's paid_amount / paid_amount_inr via the trigger cascade).
 * Does NOT touch the payments table or payroll allocations.
 * ADMIN ONLY. Returns count of allocations reset.
 */
export async function backupAndResetAllocations(): Promise<ActionResult<{ backed_up: number }>> {
  const guard = await requirePermission('settings.manage_company')
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // Fetch all active allocation IDs.
  const { data: active, error: fetchErr } = await admin
    .from('cashbook_invoice_allocations')
    .select('id')
    .is('deleted_at', null)
  if (fetchErr) return { ok: false, error: fetchErr.message }

  const ids = (active || []).map((r: any) => r.id)
  if (ids.length === 0) return { ok: true, data: { backed_up: 0 } }

  // Soft-delete in batches (trigger fires per-row).
  const now = new Date().toISOString()
  const batchSize = 200
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize)
    const { error: delErr } = await admin
      .from('cashbook_invoice_allocations')
      .update({ deleted_at: now })
      .in('id', batch)
      .is('deleted_at', null)
    if (delErr) return { ok: false, error: delErr.message }
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { backed_up: ids.length } }
}

/**
 * Step 2 of the rebuild: insert the approved proposals.
 * Each insert fires the trigger -> updates the invoice's paid_amount + status.
 * ADMIN ONLY. Returns how many allocation rows were inserted.
 */
export async function commitAllocationRebuild(
  proposals: AllocationProposal[],
): Promise<ActionResult<{ inserted: number }>> {
  const guard = await requirePermission('settings.manage_company')
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!proposals.length) return { ok: true, data: { inserted: 0 } }

  const admin = createAdminClient()

  const batchSize = 200
  let inserted = 0
  for (let i = 0; i < proposals.length; i += batchSize) {
    const batch = proposals.slice(i, i + batchSize)
    const { error } = await admin.from('cashbook_invoice_allocations').insert(batch)
    if (error) return { ok: false, error: error.message }
    inserted += batch.length
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { inserted } }
}

/**
 * Fetch all data needed for the client-matching + allocation rebuild workflow.
 * Returns entries (with invoice client link), invoices (with INR balances),
 * and the full clients list for the matching engine.
 * ADMIN ONLY.
 */
export async function fetchRebuildData(): Promise<ActionResult<{
  entries: any[]
  invoices: any[]
  clients: any[]
}>> {
  const guard = await requirePermission('settings.manage_company')
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  const [entriesRes, invoicesRes, clientsRes] = await Promise.all([
    // Include invoice_id + the invoice's client_id so the matcher can derive
    // client from an import-time invoice link even when client_id is not set.
    admin
      .from('cashbook_entries')
      .select('id, entry_date, description, reference, amount_inr, currency, client_id, invoice_id, invoice:invoices(client_id)')
      .eq('type', 'inflow')
      .is('deleted_at', null)
      .order('entry_date', { ascending: true }),
    admin
      .from('invoices')
      .select('id, invoice_number, issue_date, due_date, currency, total_amount, paid_amount, total_amount_inr, paid_amount_inr, client_id, client:clients(id, name)')
      .not('status', 'in', '("cancelled","bad_debt")')
      .order('issue_date', { ascending: true }),
    admin
      .from('clients')
      .select('id, name, code')
      .eq('is_active', true)
      .order('name'),
  ])

  if (entriesRes.error) return { ok: false, error: entriesRes.error.message }
  if (invoicesRes.error) return { ok: false, error: invoicesRes.error.message }

  return {
    ok: true,
    data: {
      entries: entriesRes.data || [],
      invoices: invoicesRes.data || [],
      clients: clientsRes.data || [],
    },
  }
}

/**
 * Persist client_id tags to cashbook_entries after the manual review phase.
 * ADMIN ONLY.
 */
export async function saveClientTags(
  tags: { entry_id: string; client_id: string }[],
): Promise<ActionResult<{ saved: number }>> {
  const guard = await requirePermission('settings.manage_company')
  if (!guard.ok) return { ok: false, error: guard.error }
  if (!tags.length) return { ok: true, data: { saved: 0 } }

  const admin = createAdminClient()
  let saved = 0
  for (const t of tags) {
    const { error } = await admin
      .from('cashbook_entries')
      .update({ client_id: t.client_id })
      .eq('id', t.entry_id)
    if (error) return { ok: false, error: error.message }
    saved++
  }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { saved } }
}

// ─── Internal account transfer ───────────────────────────────────────────────

export interface TransferPayload {
  from_account_id: string
  to_account_id: string
  amount: number
  entry_date: string
  description: string
}

/**
 * Creates a matched pair of cashbook entries (outflow + inflow) linked by a
 * shared transfer_ref UUID. Both entries use INR, no category, no invoice.
 */
export async function insertTransfer(
  payload: TransferPayload,
): Promise<ActionResult<{ outflow: any; inflow: any }>> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const admin = createAdminClient()

  // Look up account names for auto-generated descriptions.
  const { data: accounts } = await admin
    .from('bank_accounts')
    .select('id, name')
    .in('id', [payload.from_account_id, payload.to_account_id])
  const nameOf = (id: string) => accounts?.find((a: any) => a.id === id)?.name ?? 'Account'

  const transferRef = crypto.randomUUID()
  const baseFields = {
    amount: payload.amount,
    currency: 'INR',
    amount_inr: payload.amount,
    exchange_rate: 1,
    rate_source: 'manual',
    rate_date: payload.entry_date,
    entry_date: payload.entry_date,
    transfer_ref: transferRef,
    scope: 'company' as const,   // account-to-account moves are Cirqle's own books
  }

  const outflowDesc = payload.description || `Transfer to ${nameOf(payload.to_account_id)}`
  const inflowDesc  = payload.description || `Transfer from ${nameOf(payload.from_account_id)}`

  const outRow = { ...baseFields, type: 'outflow', bank_account_id: payload.from_account_id, description: outflowDesc }
  const inRow  = { ...baseFields, type: 'inflow',  bank_account_id: payload.to_account_id,   description: inflowDesc }
  const [outRes, inRes] = await Promise.all([
    retryWithoutScope(strip =>
      admin.from('cashbook_entries').insert(strip ? withoutScope(outRow) : outRow).select(ENTRY_SELECT).single()),
    retryWithoutScope(strip =>
      admin.from('cashbook_entries').insert(strip ? withoutScope(inRow) : inRow).select(ENTRY_SELECT).single()),
  ])

  if (outRes.error) return { ok: false, error: outRes.error.message }
  if (inRes.error) return { ok: false, error: inRes.error.message }

  revalidatePath(REVALIDATE)
  return { ok: true, data: { outflow: outRes.data, inflow: inRes.data } }
}

// ─── Live FX rate sync ────────────────────────────────────────────────────────

/**
 * Fetch the live rate for a single foreign currency from the FX API.
 * Also upserts it to exchange_rates so Settings → Exchange Rates stays fresh.
 * Returns the new rate_to_inr value and the API's rate date.
 */
export async function fetchLiveRate(
  currency: string,
): Promise<ActionResult<{ rate: number; rateDate: string }>> {
  const guard = await requirePermission(PERMS.CASHBOOK_EDIT)
  if (!guard.ok) return { ok: false, error: guard.error }

  const fetched = await fetchRates()
  if (!fetched.ok || !fetched.rates) {
    return { ok: false, error: fetched.error || 'Failed to fetch live rates' }
  }

  const rate = fetched.rates[currency.toUpperCase()]
  if (typeof rate !== 'number' || rate <= 0) {
    return { ok: false, error: `No live rate available for ${currency}` }
  }

  const rateDate = fetched.rateDate ?? todayISO()

  // Persist so Settings / exchange_rates table stays current.
  const admin = createAdminClient()
  await admin.from('exchange_rates').upsert(
    { currency, rate_to_inr: rate, rate_source: 'api', rate_date: rateDate, last_updated: new Date().toISOString() },
    { onConflict: 'currency' },
  )

  revalidatePath(REVALIDATE)
  return { ok: true, data: { rate, rateDate } }
}
