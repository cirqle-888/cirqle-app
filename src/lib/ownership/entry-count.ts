/**
 * Cash-book entry counting for the `entries` ownership basis.
 *
 * Pays for the act of recording a row, so the question this file answers is
 * "how many cash-book rows did this person type in the period?" — not "how much
 * money went through". Effort scales with row count; rupee value does not.
 *
 * The predicate lives in a pure function so the boundary cases that decide
 * someone's pay are testable without a database.
 */

import { toISODate, addDaysISO } from '@/lib/utils/local-date'
import { fetchAll } from '@/lib/supabase/server'
import type { OwnershipPeriod } from './types'
import type { createAdminClient } from '@/lib/supabase/admin'

/** The columns the count needs. Deliberately narrow — this runs every payroll. */
export interface CountableEntry {
  created_by: string | null
  created_at: string
  type: string | null
  transfer_ref: string | null
  deleted_at: string | null
  /** Set on a receipt recorded against one invoice. */
  invoice_id?: string | null
  /** True when the row is allocated to one or more invoices (split receipts). */
  allocated?: boolean
}

/**
 * An invoice payment is collections work, already rewarded by a "% of
 * collections" program — counting it as an entry too would pay twice for one
 * receipt. Linked directly (invoice_id) or through allocations (a split).
 */
export const isInvoicePayment = (r: Pick<CountableEntry, 'invoice_id' | 'allocated'>) => !!r.invoice_id || !!r.allocated

export interface EntryCountResult {
  /** employeeId → number of entries recorded. */
  unitsByEmployee: Record<string, number>
  /** Per employee, the detail that lands in the award's `breakdown`. */
  detailByEmployee: Record<string, {
    inflowCount: number
    outflowCount: number
    byDay: Record<string, number>
  }>
}

/**
 * The IST instant a business day begins. `created_at` is a timestamptz and the
 * period bounds are India calendar dates, so the window must be expressed with
 * an explicit offset — comparing against a bare `YYYY-MM-DD` would silently
 * drop everything typed after 05:30 IST on the last day of the month.
 */
export function istDayStart(isoDate: string): string {
  return `${isoDate}T00:00:00+05:30`
}

/** Half-open window `[start, dayAfter(end))` for a period, in IST instants. */
export function periodWindow(period: OwnershipPeriod): { fromIso: string; toIso: string } {
  return {
    fromIso: istDayStart(period.start),
    toIso: istDayStart(addDaysISO(period.end, 1)),
  }
}

/**
 * Count the entries each participant recorded.
 *
 * Exclusions, and why each one is load-bearing:
 *   - soft-deleted rows: otherwise create-and-delete inflates a count at will
 *   - NULL `created_by`: machine-written rows (cron, imports, auto-entries)
 *     were nobody's data entry — see the comments at each insert site
 *   - non-participants: someone with no rule this period earns nothing
 *   - transfers: one action writes two rows, and a transfer is neither income
 *     nor expense
 */
export function countByEmployee(
  rows: CountableEntry[],
  employeeIds: string[],
  fromIso: string,
  toIso: string,
): EntryCountResult {
  const wanted = new Set(employeeIds)
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)

  const unitsByEmployee: EntryCountResult['unitsByEmployee'] = {}
  const detailByEmployee: EntryCountResult['detailByEmployee'] = {}
  for (const id of employeeIds) {
    unitsByEmployee[id] = 0
    detailByEmployee[id] = { inflowCount: 0, outflowCount: 0, byDay: {} }
  }

  for (const row of rows) {
    if (row.deleted_at) continue
    if (!row.created_by || !wanted.has(row.created_by)) continue
    if (row.transfer_ref) continue
    if (isInvoicePayment(row)) continue

    const at = Date.parse(row.created_at)
    if (!Number.isFinite(at) || at < from || at >= to) continue

    const id = row.created_by
    unitsByEmployee[id] += 1
    const detail = detailByEmployee[id]
    if (row.type === 'inflow') detail.inflowCount += 1
    else if (row.type === 'outflow') detail.outflowCount += 1
    const day = toISODate(new Date(at))
    detail.byDay[day] = (detail.byDay[day] ?? 0) + 1
  }

  return { unitsByEmployee, detailByEmployee }
}

/**
 * Load and count the period's entries for a set of participants.
 *
 * The query mirrors `countByEmployee`'s predicate so the database does the
 * narrowing, but the pure function re-applies it — the count that decides pay
 * should not depend on which of the two is authoritative.
 */
export async function loadEntryCounts(
  admin: ReturnType<typeof createAdminClient>,
  period: OwnershipPeriod,
  employeeIds: string[],
): Promise<EntryCountResult> {
  if (employeeIds.length === 0) {
    return { unitsByEmployee: {}, detailByEmployee: {} }
  }

  const { fromIso, toIso } = periodWindow(period)
  // fetchAll, not a bare select: PostgREST truncates at 1000 rows silently, and
  // a truncated count is an underpayment nobody would notice.
  const { data } = await fetchAll(
    admin
      .from('cashbook_entries')
      .select('id, created_by, created_at, type, transfer_ref, deleted_at, invoice_id')
      .is('deleted_at', null)
      .is('transfer_ref', null)
      .in('created_by', employeeIds)
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('created_at', { ascending: true })
  )

  const rows = (data ?? []) as (CountableEntry & { id: string })[]
  const allocated = await allocatedEntryIds(admin, rows.filter(r => !r.invoice_id).map(r => r.id))
  return countByEmployee(rows.map(r => ({ ...r, allocated: allocated.has(r.id) })), employeeIds, fromIso, toIso)
}

/** Which of these cash-book rows are allocated to an invoice (live allocations only). */
export async function allocatedEntryIds(admin: ReturnType<typeof createAdminClient>, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await admin.from('cashbook_invoice_allocations')
      .select('cashbook_entry_id').in('cashbook_entry_id', ids.slice(i, i + 200)).is('deleted_at', null)
    for (const r of (data ?? []) as { cashbook_entry_id: string }[]) out.add(r.cashbook_entry_id)
  }
  return out
}
