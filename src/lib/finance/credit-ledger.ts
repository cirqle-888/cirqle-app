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

/**
 * How a credit moves. One way out, three ways back.
 *
 *   given               money leaves, and is expected back
 *   returned            it came back as cash
 *   converted_drawings  it is not coming back — the owner's share. Out of
 *                       P&L either way, so this changes who is owed and
 *                       nothing else.
 *   converted_salary    an advance became pay. This one DOES change P&L:
 *                       the business has spent the money, where before it
 *                       held a receivable.
 *
 * Any of the three may be partial, which is why they are rows against a
 * person rather than a status on the original.
 */
export type CreditDirection = 'given' | 'returned' | 'converted_drawings' | 'converted_salary'

/** Everything that reduces what somebody owes. */
export const SETTLEMENTS: readonly CreditDirection[] = ['returned', 'converted_drawings', 'converted_salary']

/** Only this one turns a credit into an expense. */
export const HITS_PNL: readonly CreditDirection[] = ['converted_salary']

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
  /** Written off to the owner's share. Never coming back, never an expense. */
  convertedToDrawingsInr: number
  /** Turned into pay. Never coming back, and it IS an expense. */
  convertedToSalaryInr: number
  /** given − everything that settled it. Negative means over-settled. */
  outstandingInr: number
  movements: CreditMovement[]
}

export interface CreditLedger {
  balances: CreditBalance[]
  totalGivenInr: number
  totalReturnedInr: number
  totalConvertedToDrawingsInr: number
  totalConvertedToSalaryInr: number
  /**
   * What is still owed, and therefore what may still come back. This is the
   * only part of a credit that belongs in expected cash — money converted
   * to a drawing or to salary is spent, not owed.
   */
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
        givenInr: 0, returnedInr: 0,
        convertedToDrawingsInr: 0, convertedToSalaryInr: 0,
        outstandingInr: 0, movements: [],
      }
      byPerson.set(key, row)
    }
    // Amounts arrive as magnitudes — the ledger stores an outflow of 50,000
    // as 50,000 with type 'outflow', not as -50,000 — so the direction is
    // what decides the sign here, never the number.
    const amount = Math.abs(Number(m.amountInr) || 0)
    if (m.direction === 'given') row.givenInr += amount
    else if (m.direction === 'converted_drawings') row.convertedToDrawingsInr += amount
    else if (m.direction === 'converted_salary') row.convertedToSalaryInr += amount
    else row.returnedInr += amount
    row.movements.push(m)
  }

  const balances = [...byPerson.values()].map(row => ({
    ...row,
    givenInr: round2(row.givenInr),
    returnedInr: round2(row.returnedInr),
    convertedToDrawingsInr: round2(row.convertedToDrawingsInr),
    convertedToSalaryInr: round2(row.convertedToSalaryInr),
    outstandingInr: round2(
      row.givenInr - row.returnedInr - row.convertedToDrawingsInr - row.convertedToSalaryInr,
    ),
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
    totalConvertedToDrawingsInr: sum(b => b.convertedToDrawingsInr),
    totalConvertedToSalaryInr: sum(b => b.convertedToSalaryInr),
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
 * Every credit movement, from credit_ledger — the one source of truth.
 *
 * WHY NOT THE CASHBOOK, which is where this started. A credit's cash
 * movements are cashbook entries, so reading those looked right and worked
 * for `given` and `returned`. It cannot work for a CONVERSION: converting
 * to a drawing or to salary moves no cash — the money left when the credit
 * was given — so there is no cashbook entry to find, and a ledger built on
 * cashbook entries reports a ₹1,00,000 balance that never moves however
 * much of it is settled.
 *
 * credit_ledger holds all four kinds, and cashbook saves write a row into
 * it for every credit entry (see cashbook/actions.ts), so it is both
 * complete and the only place that can answer the question.
 *
 * Degrades to [] like fetchEmployeeCostSplits: a finance page that cannot
 * read one table should show the rest, not a stack trace.
 */
export async function fetchCreditMovements(
  admin: { from: (t: string) => any },
  filter: { from?: string; to?: string } = {},
): Promise<CreditMovement[]> {
  let query = admin.from('credit_ledger')
    .select('id, credit_type, amount, credit_date, notes, entity_id, employee:employees(cqid)')
  if (filter.from) query = query.gte('credit_date', filter.from)
  if (filter.to) query = query.lte('credit_date', filter.to)
  const { data, error } = await query
  if (error) return []

  const known: CreditDirection[] = ['given', 'returned', 'converted_drawings', 'converted_salary']
  return (data ?? [])
    // A credit_type this build does not know about is skipped rather than
    // silently counted as a repayment, which is what an `else` would do.
    .filter((r: any) => known.includes(r.credit_type))
    .map((r: any) => ({
      direction: r.credit_type as CreditDirection,
      employeeCqid: (r.employee?.cqid as string) ?? null,
      amountInr: Number(r.amount) || 0,
      entryId: r.id as string,
      entryDate: r.credit_date as string,
      description: (r.notes as string) ?? null,
    }))
}

/* ── Writing it, on every credit entry ──────────────────────────────────── */

export interface CreditEntryFacts {
  /** The category's account code. Anything but the two credit codes is ignored. */
  accountCode: string | null | undefined
  amountInr: number
  entryDate: string
  bankAccountId: string | null
  description: string | null
  /** The entry form's "smart mode", when somebody used it. */
  smart?: {
    mode?: string | null
    entityType?: string | null
    entityId?: string | null
    entityOther?: string | null
  } | null
  /** Who the entry was split across, which is the other way to know. */
  splits?: readonly { employeeId: string; amountInr: number }[]
}

export interface CreditLedgerRow {
  entity_type: string
  entity_id: string | null
  credit_type: CreditDirection
  amount: number
  credit_date: string
  bank_account_id: string | null
  notes: string | null
}

/**
 * The credit_ledger rows a cashbook entry should produce.
 *
 * WHY THIS EXISTS. Writing the ledger row used to be gated on the entry
 * form's "smart mode" having named an entity:
 *
 *     smartEffect.mode === 'credit_given' && (entity_id || entity_other)
 *
 * Save a Credit Given without touching smart mode and no row was written —
 * no error, no warning, nothing. Two ₹50,000 withdrawals went out that way
 * and the Credits tab never heard of either; the cashbook had them, the
 * ledger meant to track them did not, and the only thing that would ever
 * have revealed it is somebody asking.
 *
 * So the account code decides, not the form. A credit entry ALWAYS produces
 * rows, from whichever of the three the entry actually has:
 *
 *   1 · smart mode named an entity     — the explicit answer, and it wins
 *   2 · the entry is split across people — one row each, at their amounts
 *   3 · neither                         — one row with no entity
 *
 * Case 3 is the important one. An unattributed row is not tidy, and that is
 * the point: it puts the money on the Credits tab with a blank where the
 * name should be, where somebody can see it and fix it. The alternative is
 * what happened before, which is silence.
 */
export function plannedCreditRows(facts: CreditEntryFacts): CreditLedgerRow[] {
  const direction: CreditDirection | null =
    facts.accountCode === CREDIT_GIVEN_CODE ? 'given'
      : facts.accountCode === CREDIT_RETURN_CODE ? 'returned'
        : null
  if (!direction) return []

  const base = {
    credit_type: direction,
    credit_date: facts.entryDate,
    bank_account_id: facts.bankAccountId ?? null,
  }
  const note = (extra?: string | null) =>
    [facts.description, extra ? `(${extra})` : null].filter(Boolean).join(' ').trim() || null

  const smart = facts.smart
  if (smart && (smart.entityId || smart.entityOther)) {
    return [{
      ...base,
      entity_type: smart.entityType || 'employee',
      entity_id: smart.entityId || null,
      amount: Math.abs(Number(facts.amountInr) || 0),
      notes: note(smart.entityOther),
    }]
  }

  const splits = facts.splits ?? []
  if (splits.length) {
    return splits.map(s => ({
      ...base,
      entity_type: 'employee',
      entity_id: s.employeeId,
      amount: Math.abs(Number(s.amountInr) || 0),
      notes: note(),
    }))
  }

  return [{
    ...base,
    entity_type: 'employee',
    entity_id: null,
    amount: Math.abs(Number(facts.amountInr) || 0),
    notes: note('no one recorded'),
  }]
}
