/**
 * Finance Engine — money lent out, and whether it has come back.
 *
 * A "Credit Given" is cash that left the bank and is expected to return:
 * an advance, a float for fund rolling, a personal borrowing against next
 * month. It is correctly kept out of P&L — `financial` never counts as
 * spending — and until now that was the end of it. Nothing said the money
 * was owed, nothing said by whom, and nothing would notice if it never
 * came back.
 *
 * The ledger already holds both halves: `financial.credit_given` on the way
 * out and `financial.credit_return` on the way in. What was missing is the
 * subtraction.
 *
 * WHO IS FOUND FROM THE SPLIT, which is the same record used for cost
 * attribution — an entry with no split is money out with nobody against it,
 * and this reports that as its own line rather than dropping it. A silent
 * drop is how ₹50,000 goes missing from a balance that otherwise looks
 * tidy.
 *
 * CQIDs ONLY. Employee names never leave this module (see
 * scripts/check-name-privacy.mjs); a balance sheet of who owes what is
 * precisely the report where that matters.
 */

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

export type CreditDirection = 'given' | 'returned'

export interface CreditMovement {
  direction: CreditDirection
  /** null when the entry carries no split — money out with nobody against it. */
  employeeCqid: string | null
  amountInr: number
  entryId: string
  entryDate: string
  description: string | null
}

export interface CreditBalance {
  /** null is the unattributed bucket — see UNATTRIBUTED. */
  employeeCqid: string | null
  givenInr: number
  returnedInr: number
  /** given − returned. Negative means they have paid back more than they took. */
  outstandingInr: number
  movements: CreditMovement[]
}

export interface CreditLedger {
  balances: CreditBalance[]
  totalGivenInr: number
  totalReturnedInr: number
  totalOutstandingInr: number
  /** Money out that no one is recorded against. Worth its own number. */
  unattributedInr: number
}

/** What an unattributed balance is called when something must be shown. */
export const UNATTRIBUTED = 'unattributed'

/**
 * Per-person outstanding credit, biggest first.
 *
 * Pure, over movements already fetched, so the arithmetic can be proved
 * without a database — the same discipline as the rest of the engine.
 */
export function buildCreditLedger(movements: readonly CreditMovement[]): CreditLedger {
  const byPerson = new Map<string, CreditBalance>()

  for (const m of movements) {
    const key = m.employeeCqid ?? UNATTRIBUTED
    let row = byPerson.get(key)
    if (!row) {
      row = {
        employeeCqid: m.employeeCqid ?? null,
        givenInr: 0, returnedInr: 0, outstandingInr: 0, movements: [],
      }
      byPerson.set(key, row)
    }
    // Amounts arrive as magnitudes — the ledger stores an outflow of 50,000
    // as 50,000 with type 'outflow', not as -50,000 — so the direction is
    // what decides the sign here, never the number.
    const amount = Math.abs(Number(m.amountInr) || 0)
    if (m.direction === 'given') row.givenInr += amount
    else row.returnedInr += amount
    row.movements.push(m)
  }

  const balances = [...byPerson.values()].map(row => ({
    ...row,
    givenInr: round2(row.givenInr),
    returnedInr: round2(row.returnedInr),
    outstandingInr: round2(row.givenInr - row.returnedInr),
    movements: [...row.movements].sort((a, b) => a.entryDate.localeCompare(b.entryDate)),
  }))

  // Most outstanding first; the settled and the overpaid fall to the bottom.
  balances.sort((a, b) =>
    b.outstandingInr - a.outstandingInr
    || (a.employeeCqid ?? '￿').localeCompare(b.employeeCqid ?? '￿'))

  const sum = (pick: (b: CreditBalance) => number) => round2(balances.reduce((n, b) => n + pick(b), 0))

  return {
    balances,
    totalGivenInr: sum(b => b.givenInr),
    totalReturnedInr: sum(b => b.returnedInr),
    totalOutstandingInr: sum(b => b.outstandingInr),
    unattributedInr: round2(
      balances.filter(b => b.employeeCqid === null).reduce((n, b) => n + b.outstandingInr, 0),
    ),
  }
}

/** Anyone still holding money, for a dashboard that wants only the open ones. */
export function stillOwing(ledger: CreditLedger): CreditBalance[] {
  return ledger.balances.filter(b => b.outstandingInr > 0)
}

/* ── Reading it out of the ledger ───────────────────────────────────────── */

/** The two account codes that make up a credit's life. */
export const CREDIT_GIVEN_CODE = 'financial.credit_given'
export const CREDIT_RETURN_CODE = 'financial.credit_return'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Every credit movement, with whoever is recorded against it.
 *
 * Two reads rather than a join through the split table, because an entry
 * with NO split still has to appear — a left join expressed in PostgREST's
 * embedding is the kind of thing that silently returns the inner-join
 * answer, and the inner-join answer here is a balance that quietly omits
 * the money nobody claimed.
 *
 * Degrades to [] like fetchEmployeeCostSplits: a finance page that cannot
 * read one table should show the rest, not a stack trace.
 */
export async function fetchCreditMovements(
  admin: { from: (t: string) => any },
  filter: { from?: string; to?: string } = {},
): Promise<CreditMovement[]> {
  const cats = await admin.from('cashbook_categories')
    .select('id, account_code')
    .in('account_code', [CREDIT_GIVEN_CODE, CREDIT_RETURN_CODE])
  if (cats.error || !cats.data?.length) return []

  const directionOf = new Map<string, CreditDirection>(
    cats.data.map((c: any) => [c.id, c.account_code === CREDIT_GIVEN_CODE ? 'given' : 'returned']),
  )

  let query = admin.from('cashbook_entries')
    .select('id, entry_date, amount_inr, description, category_id, deleted_at')
    .in('category_id', [...directionOf.keys()])
  if (filter.from) query = query.gte('entry_date', filter.from)
  if (filter.to) query = query.lte('entry_date', filter.to)
  const entries = await query
  if (entries.error) return []

  const live = (entries.data ?? []).filter((e: any) => !e.deleted_at)
  if (!live.length) return []

  const splits = await admin.from('cashbook_entry_employee_splits')
    .select('cashbook_entry_id, amount_inr, employee:employees(cqid)')
    .in('cashbook_entry_id', live.map((e: any) => e.id))
  const byEntry = new Map<string, any[]>()
  for (const s of (splits.error ? [] : splits.data ?? [])) {
    const list = byEntry.get(s.cashbook_entry_id)
    if (list) list.push(s)
    else byEntry.set(s.cashbook_entry_id, [s])
  }

  const out: CreditMovement[] = []
  for (const entry of live) {
    const direction = directionOf.get(entry.category_id)
    if (!direction) continue
    const mine = byEntry.get(entry.id) ?? []
    const common = {
      direction,
      entryId: entry.id as string,
      entryDate: entry.entry_date as string,
      description: (entry.description as string) ?? null,
    }
    if (!mine.length) {
      // Nobody against it. Carried through as its own movement rather than
      // skipped — that is the whole point of the unattributed bucket.
      out.push({ ...common, employeeCqid: null, amountInr: Number(entry.amount_inr) || 0 })
      continue
    }
    for (const s of mine) {
      out.push({
        ...common,
        employeeCqid: (s.employee?.cqid as string) ?? null,
        amountInr: Number(s.amount_inr) || 0,
      })
    }
  }
  return out
}
