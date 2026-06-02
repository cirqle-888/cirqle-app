/**
 * Entity-aware FIFO allocation engine.
 *
 * PURE — no database calls. Takes data already fetched by the caller, returns
 * a list of proposed allocation rows that can be reviewed before committing.
 *
 * Rules (per user spec):
 *   1. Only allocate to items belonging to the SAME entity (same client_id or
 *      same employee_id) as the payment.
 *   2. Item date must be ≤ payment date (never allocate to future records).
 *   3. Oldest item first (FIFO by issue_date / month+year / credit_date).
 *   4. Remainder flows to the next item in the sorted list.
 *   5. Stop when the payment balance is exhausted.
 */

// ─── Shared types ─────────────────────────────────────────────────────────────

/** A single proposed allocation row — not yet saved. */
export interface ProposedAllocation {
  // Target record
  item_id: string          // invoice id / payroll id / credit_ledger id
  item_label: string       // e.g. "INV-2025-014"
  item_sub: string         // e.g. "Sea Star · due 31 Jan 2026"
  item_date: string        // YYYY-MM-DD — the item's issue/month/credit date
  outstanding_inr: number  // ₹ outstanding before this payment

  // Proposed amount
  amount: number           // ₹ to allocate (editable in the UI review panel)

  // Existing allocation on this payment+item (for updates vs inserts)
  existingAllocationId?: string
  existingAmount?: number

  // Entity
  entity_type: 'client' | 'employee'
  entity_id: string
}

/** An item the engine can allocate against. */
export interface AllocatableItem {
  id: string
  entity_id: string        // client_id or employee_id
  item_date: string        // YYYY-MM-DD (invoice issue_date, payroll YYYY-MM-01, credit_date)
  label: string            // invoice_number / payslip_number / "Credit …"
  sub: string              // client name, employee name, etc.
  outstanding_inr: number  // ₹ balance not yet allocated (total_amount_inr − paid_amount_inr OR net_salary − allocated OR credit amount − recovered)
}

/** An existing allocation already committed for this payment entry. */
export interface ExistingAllocation {
  id: string
  item_id: string          // invoice_id / payroll_id / credit_id
  allocated_amount: number // ₹ already allocated from this payment to this item
}

// ─── Precision helper ─────────────────────────────────────────────────────────

function r2(n: number): number {
  return Math.round(((n || 0) + Number.EPSILON) * 100) / 100
}

// ─── Core FIFO engine ─────────────────────────────────────────────────────────

/**
 * Build a preview list of proposed allocations for ONE payment entry.
 *
 * @param paymentInr     Total ₹ amount of the payment entry.
 * @param paymentDate    YYYY-MM-DD — items dated after this are excluded.
 * @param entityId       client_id or employee_id of this payment.
 * @param entityType     'client' or 'employee'.
 * @param items          All open items for this workspace (filtered to entity + date inside here).
 * @param existing       Any already-committed allocations for this payment (accounted for as already used).
 */
export function buildFifoProposal(
  paymentInr: number,
  paymentDate: string,
  entityId: string,
  entityType: 'client' | 'employee',
  items: AllocatableItem[],
  existing: ExistingAllocation[],
): ProposedAllocation[] {
  // 1. Filter to same entity and not future (issue_date ≤ payment date).
  const eligible = items
    .filter(i => i.entity_id === entityId && i.item_date <= paymentDate)
    .sort((a, b) => a.item_date.localeCompare(b.item_date))  // oldest first

  // 2. How much of the payment is already committed to existing allocations?
  const alreadyUsed = r2(existing.reduce((s, a) => s + a.allocated_amount, 0))
  let remaining = r2(paymentInr - alreadyUsed)

  const rows: ProposedAllocation[] = []

  for (const item of eligible) {
    if (remaining <= 0.01) break

    // How much has this payment already allocated to this item?
    const existAlloc = existing.find(a => a.item_id === item.id)
    const alreadyForThis = existAlloc ? existAlloc.allocated_amount : 0

    // Effective outstanding for this payment: item's total outstanding minus
    // what this payment already put here.
    const outstanding = r2(item.outstanding_inr - alreadyForThis)
    if (outstanding <= 0.01) continue

    const give = r2(Math.min(remaining, outstanding))
    if (give <= 0.01) continue

    rows.push({
      item_id: item.id,
      item_label: item.label,
      item_sub: item.sub,
      item_date: item.item_date,
      outstanding_inr: item.outstanding_inr,
      amount: give,
      existingAllocationId: existAlloc?.id,
      existingAmount: alreadyForThis,
      entity_type: entityType,
      entity_id: entityId,
    })

    remaining = r2(remaining - give)
  }

  return rows
}

// ─── Bulk rebuild engine ───────────────────────────────────────────────────────

/**
 * Rebuild proposals for ALL payment entries in chronological order.
 *
 * Processes entries date-ascending so each payment builds on the state left by
 * the previous one (running balances). Returns one proposal set per entry plus
 * a summary of unmatched (no entity tag) entries.
 */
export interface RebuildEntry {
  entry_id: string
  entry_date: string
  description: string
  reference?: string
  amount_inr: number
  entity_id?: string
  entity_type?: 'client' | 'employee'
  entity_label?: string   // client name or employee CQID
}

export interface RebuildResult {
  matched: { entry: RebuildEntry; proposals: ProposedAllocation[] }[]
  unmatched: RebuildEntry[]   // no entity_id — need manual tagging
  ambiguous: RebuildEntry[]   // entity_id present but no eligible items found
  totals: {
    total_payments: number
    total_allocated: number
    total_unallocated: number
  }
}

/**
 * Build the full rebuild preview.
 *
 * @param entries  All inflow payment entries sorted by entry_date ASC.
 * @param items    All open allocatable items (invoices/payrolls/credits combined).
 *
 * Running-balance tracking: `items[i].outstanding_inr` is MUTATED in place as we
 * process entries so each subsequent payment sees the remaining balance (i.e. the
 * FIFO is truly chronological across payments). Callers should pass a deep copy if
 * they need the original data afterward.
 */
export function buildRebuildPreview(
  entries: RebuildEntry[],
  items: AllocatableItem[],
): RebuildResult {
  const matched: RebuildResult['matched'] = []
  const unmatched: RebuildEntry[] = []
  const ambiguous: RebuildEntry[] = []

  let totalAllocated = 0

  // Process oldest payment first.
  const sorted = [...entries].sort((a, b) => a.entry_date.localeCompare(b.entry_date))

  for (const entry of sorted) {
    if (!entry.entity_id || !entry.entity_type) {
      unmatched.push(entry)
      continue
    }

    const proposals = buildFifoProposal(
      entry.amount_inr,
      entry.entry_date,
      entry.entity_id,
      entry.entity_type,
      items,
      [], // no existing allocations — we're rebuilding from scratch
    )

    if (proposals.length === 0) {
      ambiguous.push(entry)
      continue
    }

    // Mutate running balances so subsequent payments see reduced outstanding.
    for (const p of proposals) {
      const item = items.find(i => i.id === p.item_id)
      if (item) item.outstanding_inr = r2(item.outstanding_inr - p.amount)
      totalAllocated = r2(totalAllocated + p.amount)
    }

    matched.push({ entry, proposals })
  }

  const totalPayments = r2(entries.reduce((s, e) => s + e.amount_inr, 0))

  return {
    matched,
    unmatched,
    ambiguous,
    totals: {
      total_payments: totalPayments,
      total_allocated: totalAllocated,
      total_unallocated: r2(totalPayments - totalAllocated),
    },
  }
}

// ─── Adapters: convert domain records to AllocatableItem ─────────────────────

/** Convert an invoice row (from the DB query) into an AllocatableItem. */
export function invoiceToItem(inv: {
  id: string
  client_id: string
  invoice_number: string
  issue_date: string
  total_amount_inr?: number
  paid_amount_inr?: number
  total_amount?: number
  paid_amount?: number
  currency?: string
  client?: { name?: string }
}): AllocatableItem {
  const totalInr = inv.total_amount_inr ?? inv.total_amount ?? 0
  const paidInr = inv.paid_amount_inr ?? inv.paid_amount ?? 0
  return {
    id: inv.id,
    entity_id: inv.client_id,
    item_date: inv.issue_date,
    label: inv.invoice_number,
    sub: inv.client?.name || '',
    outstanding_inr: Math.max(0, Math.round((totalInr - paidInr) * 100) / 100),
  }
}

/** Convert a payroll row into an AllocatableItem. */
export function payrollToItem(p: {
  id: string
  employee_id: string
  month: number
  year: number
  net_salary: number
  paid_salary?: number
  payslip_number?: string
  employee?: { name?: string; cqid?: string }
}): AllocatableItem {
  const paid = p.paid_salary ?? 0
  const date = `${p.year}-${String(p.month).padStart(2, '0')}-01`
  return {
    id: p.id,
    entity_id: p.employee_id,
    item_date: date,
    label: p.payslip_number || `Salary ${p.month}/${p.year}`,
    sub: p.employee?.name || p.employee?.cqid || '',
    outstanding_inr: Math.max(0, Math.round((p.net_salary - paid) * 100) / 100),
  }
}

/** Convert a credit_ledger row into an AllocatableItem. */
export function creditToItem(c: {
  id: string
  entity_id: string
  amount: number
  recovered?: number
  credit_date: string
  notes?: string
  employee?: { cqid?: string }
}): AllocatableItem {
  const recovered = c.recovered ?? 0
  return {
    id: c.id,
    entity_id: c.entity_id,
    item_date: c.credit_date,
    label: c.notes || `Credit ${c.credit_date}`,
    sub: c.employee?.cqid || '',
    outstanding_inr: Math.max(0, Math.round((c.amount - recovered) * 100) / 100),
  }
}
