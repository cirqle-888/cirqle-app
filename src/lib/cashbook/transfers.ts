/**
 * Internal transfers between the company's own accounts — the rules, pure.
 *
 * A transfer is TWO cash-book rows sharing one `transfer_ref`: an outflow on
 * the From account and an inflow on the To account. Neither is income or
 * expense (see finance/cash-flow, finance/journal); they exist so each
 * account's balance — and its bank statement reconciliation — stays true.
 * Both legs are always created, edited and deleted together.
 *
 * ── CURRENCIES ────────────────────────────────────────────────────────────
 *
 * Each leg is in its OWN account's currency. Same currency: one amount, both
 * legs carry it, and both convert to INR at the same rate, so they cancel.
 * Different currencies: the amount sent and the amount received are both
 * asked for, and each leg converts at its own currency's book rate. The two
 * INR values then differ by the conversion's real cost or gain, which is
 * reported as FX — never as income or expense (`transferFxDifference`).
 *
 * Supabase-free so it is unit-tested directly.
 */

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100

export interface TransferAccount {
  id: string
  name: string
  currency?: string | null
  is_active?: boolean | null
}

export interface TransferInput {
  from_account_id: string
  to_account_id: string
  /** In the From account's currency. */
  amount: number
  /** In the To account's currency. Required only when the currencies differ. */
  amount_received?: number | null
  entry_date: string
  description?: string
}

/** currency → rate_to_inr, from exchange_rates. INR is always 1. */
export type RateMap = Record<string, number>

export const currencyOf = (a: TransferAccount | undefined | null): string =>
  (a?.currency || 'INR').toUpperCase()

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

function rateFor(currency: string, rates: RateMap): number | null {
  if (currency === 'INR') return 1
  const r = Number(rates[currency])
  return r > 0 ? r : null
}

/** Every reason the transfer cannot be saved; empty when it can. */
export function validateTransfer(
  input: TransferInput,
  accounts: readonly TransferAccount[],
  rates: RateMap,
): string[] {
  const errors: string[] = []
  const from = accounts.find(a => a.id === input.from_account_id)
  const to = accounts.find(a => a.id === input.to_account_id)

  if (!input.from_account_id || !input.to_account_id) errors.push('Select both accounts')
  else if (input.from_account_id === input.to_account_id) errors.push('From and To must be different accounts')
  else {
    if (!from) errors.push('From account not found')
    if (!to) errors.push('To account not found')
  }

  if (!(Number(input.amount) > 0)) errors.push('Enter an amount greater than 0')
  if (!input.entry_date) errors.push('Date is required')
  else if (!isRealDate(input.entry_date)) errors.push('Date is not a valid date')

  if (from && to) {
    const fc = currencyOf(from)
    const tc = currencyOf(to)
    if (fc !== tc && !(Number(input.amount_received) > 0)) {
      errors.push(`Enter the amount received in ${tc}`)
    }
    if (rateFor(fc, rates) == null) errors.push(`No exchange rate for ${fc} — add it in Settings`)
    if (tc !== fc && rateFor(tc, rates) == null) errors.push(`No exchange rate for ${tc} — add it in Settings`)
  }
  return errors
}

export interface TransferLeg {
  type: 'outflow' | 'inflow'
  bank_account_id: string
  amount: number
  currency: string
  exchange_rate: number
  amount_inr: number
  rate_source: 'manual' | 'settings'
  rate_date: string
  entry_date: string
  description: string
}

/** Fallback description of one leg when no note was typed. */
export function legDescription(type: 'outflow' | 'inflow', otherAccountName: string): string {
  return type === 'outflow' ? `Transfer to ${otherAccountName}` : `Transfer from ${otherAccountName}`
}

/**
 * The two rows to write. Call `validateTransfer` first — this assumes valid
 * input and throws if it is not, rather than writing a half-sensible pair.
 */
export function buildTransferLegs(
  input: TransferInput,
  accounts: readonly TransferAccount[],
  rates: RateMap,
): { outflow: TransferLeg; inflow: TransferLeg } {
  const errors = validateTransfer(input, accounts, rates)
  if (errors.length) throw new Error(errors[0])

  const from = accounts.find(a => a.id === input.from_account_id)!
  const to = accounts.find(a => a.id === input.to_account_id)!
  const fc = currencyOf(from)
  const tc = currencyOf(to)
  const sent = round2(Number(input.amount))
  const received = fc === tc ? sent : round2(Number(input.amount_received))
  const fromRate = rateFor(fc, rates)!
  const toRate = rateFor(tc, rates)!
  const note = (input.description ?? '').trim()

  const leg = (
    type: 'outflow' | 'inflow', account: TransferAccount, other: TransferAccount,
    amount: number, currency: string, rate: number,
  ): TransferLeg => ({
    type,
    bank_account_id: account.id,
    amount,
    currency,
    exchange_rate: rate,
    amount_inr: round2(amount * rate),
    rate_source: currency === 'INR' ? 'manual' : 'settings',
    rate_date: input.entry_date,
    entry_date: input.entry_date,
    description: note || legDescription(type, other.name),
  })

  return {
    outflow: leg('outflow', from, to, sent, fc, fromRate),
    inflow: leg('inflow', to, from, received, tc, toRate),
  }
}

/**
 * INR gained (+) or lost (−) converting between the legs' currencies: what
 * arrived, valued at book rate, less what left. Zero for a same-currency
 * transfer. Reported as FX, never as income or expense.
 */
export function transferFxDifference(
  legs: readonly { type: string; amount_inr?: number | null }[],
): number {
  const out = legs.find(l => l.type === 'outflow')
  const inn = legs.find(l => l.type === 'inflow')
  if (!out || !inn) return 0
  return round2(Number(inn.amount_inr || 0) - Number(out.amount_inr || 0))
}

// ─── Display ─────────────────────────────────────────────────────────────────

export interface TransferRowLike {
  id: string
  type: string
  transfer_ref?: string | null
  bank_account_id?: string | null
  bank_account?: { name?: string | null } | null
}

/** transfer_ref → its legs, for the rows that are loaded. */
export function indexTransfers<T extends TransferRowLike>(rows: readonly T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const r of rows) {
    if (!r.transfer_ref) continue
    const list = map.get(r.transfer_ref) ?? []
    list.push(r)
    map.set(r.transfer_ref, list)
  }
  return map
}

/** The other leg of a transfer, when it is loaded. */
export function partnerLeg<T extends TransferRowLike>(row: T, index: Map<string, T[]>): T | null {
  if (!row.transfer_ref) return null
  return (index.get(row.transfer_ref) ?? []).find(r => r.id !== row.id) ?? null
}

/**
 * "Transfer: HDFC to Cash". Always From → To, whichever leg is being shown,
 * so both rows of one transfer read the same.
 */
export function transferLabel<T extends TransferRowLike>(row: T, index: Map<string, T[]>): string {
  const partner = partnerLeg(row, index)
  const own = row.bank_account?.name || 'Account'
  const other = partner?.bank_account?.name || 'another account'
  return row.type === 'outflow' ? `Transfer: ${own} to ${other}` : `Transfer: ${other} to ${own}`
}

// ─── Convert two legacy entries into one transfer ────────────────────────────

export interface ConvertCandidateRow extends TransferRowLike {
  entry_date: string
  amount_inr?: number | null
  deleted_at?: string | null
  reversal_of?: string | null
  allocations?: { deleted_at?: string | null }[] | null
  payroll_allocations?: { deleted_at?: string | null }[] | null
  expense_billings?: unknown[] | null
}

/** Why this row cannot be one side of a converted transfer, or null if it can. */
export function convertBlocker(
  row: ConvertCandidateRow,
  reversedIds: ReadonlySet<string> = new Set(),
): string | null {
  if (row.deleted_at) return 'The entry is deleted'
  if (row.transfer_ref) return 'Already a transfer'
  if (row.reversal_of) return 'A reversal cannot become a transfer'
  if (reversedIds.has(row.id)) return 'This entry has been reversed'
  if (!row.bank_account_id) return 'The entry has no account'
  if ((row.allocations ?? []).some(a => !a.deleted_at)) return 'The entry is allocated to an invoice'
  if ((row.payroll_allocations ?? []).some(a => !a.deleted_at)) return 'The entry is allocated to a payslip'
  if ((row.expense_billings ?? []).length > 0) return 'The entry is billed on an invoice'
  return null
}

/**
 * Entries that could be the other side of `row`: the opposite type, on a
 * different account, the same date and the same INR amount (to the paisa),
 * and themselves free to convert.
 */
export function findTransferCounterparts<T extends ConvertCandidateRow>(
  row: T,
  rows: readonly T[],
  reversedIds: ReadonlySet<string> = new Set(),
): T[] {
  if (convertBlocker(row, reversedIds)) return []
  const amount = round2(Number(row.amount_inr) || 0)
  if (!(amount > 0)) return []
  return rows.filter(r =>
    r.id !== row.id &&
    r.type !== row.type &&
    r.entry_date === row.entry_date &&
    r.bank_account_id !== row.bank_account_id &&
    Math.abs(round2(Number(r.amount_inr) || 0) - amount) < 0.005 &&
    convertBlocker(r, reversedIds) == null,
  )
}
