/**
 * What a statement line IS, when it is not the company's trading.
 *
 * A bank statement on a personal or mixed-use account carries four quite
 * different things, and a reconciliation is only honest once they are told
 * apart:
 *
 *   · the company's own receipts and payments — these match cash book entries;
 *   · money the BANK gave you — cashback, reward credits, interest. It reached
 *     the account, it moved the balance, and it is not company income;
 *   · the account holder's own spending and receipts;
 *   · movements that are not transactions at all — an auto-sweep into a linked
 *     fixed deposit and back out again, which nets to exactly zero.
 *
 * WHY `notCompanyFunds` LIVES HERE and not in the database. It is a policy
 * question, not a fact about the row: one company treats cashback on its own
 * card as company income, another passes it to whoever holds the account. A
 * CHECK constraint would make changing that a migration.
 */

export interface LineKind {
  key: string
  label: string
  /** One line, shown beside the option so the choice is not a guess. */
  hint: string
  /**
   * Money that reached the account but does not belong to the company.
   * These are what the "transfer this out" total is built from.
   */
  notCompanyFunds: boolean
}

export const LINE_KINDS: LineKind[] = [
  { key: 'cashback', label: 'Cashback & rewards', notCompanyFunds: true,
    hint: 'Credited by the bank or card scheme, not earned from a client.' },
  { key: 'interest', label: 'Interest earned', notCompanyFunds: true,
    hint: 'Savings interest, or interest released when a deposit is broken.' },
  { key: 'personal', label: 'Personal — not company funds', notCompanyFunds: true,
    hint: "The account holder's own money passing through a shared account." },
  { key: 'sweep', label: 'Fixed-deposit sweep', notCompanyFunds: false,
    hint: 'Idle cash moving into a linked deposit and back. Nets to zero — not income or expense.' },
  { key: 'charge', label: 'Bank charges & fees', notCompanyFunds: false,
    hint: 'A real company cost. Set aside here only if it is booked elsewhere.' },
  { key: 'elsewhere', label: 'Recorded on another account', notCompanyFunds: false,
    hint: 'A genuine entry exists, against a different account — an internal transfer seen from one side.' },
  { key: 'other', label: 'Other', notCompanyFunds: false,
    hint: 'Anything else. Say what it is in the note.' },
]

export const LINE_KIND_MAP: Record<string, LineKind> =
  Object.fromEntries(LINE_KINDS.map(k => [k.key, k]))

export function isLineKind(value: unknown): value is string {
  return typeof value === 'string' && value in LINE_KIND_MAP
}

/**
 * What a line's own wording suggests it is.
 *
 * SUGGESTS. Returns null whenever it is not sure, and a suggestion is offered
 * to a person before anything is written — the same rule the matcher follows.
 * Setting 44 sweep lines aside by hand is the kind of tedium that gets skipped
 * or done carelessly, which is why this exists; guessing at an ambiguous line
 * is not, which is why it stops at the patterns banks actually print.
 *
 * The patterns are deliberately anchored to the START of the narration. A
 * description merely CONTAINING the word "interest" is usually a payment to
 * somebody, and matching it would set a client receipt aside as bank income.
 */
const PATTERNS: [string, RegExp][] = [
  // Kotak / HDFC / ICICI reward credits.
  ['cashback', /^(cashback|cash back|reward|rewards? earned|milestone)/i],
  // 'Int.Pd:' is Kotak's savings-interest narration; 'FD PREMAT PROCEEDS' is
  // the interest released when a sweep deposit is broken early.
  ['interest', /^(int\.?\s?pd|interest (credit|paid|earned)|fd premat proceeds|credit interest)/i],
  ['sweep', /^(sweep (transfer|trf)|auto sweep|sweep-in|sweep out)/i],
  ['charge', /^(bank charge|service charge|amb charge|sms charge|chq return charge|gst on|igst|cgst|sgst|atm charge)/i],
]

export function suggestKind(description: string): string | null {
  const text = (description ?? '').trim()
  if (!text) return null
  for (const [kind, re] of PATTERNS) if (re.test(text)) return kind
  return null
}

export interface KindGroup {
  kind: LineKind
  count: number
  total: number
}

export interface KindSummary {
  groups: KindGroup[]
  /** Everything whose kind says it is not the company's, netted. */
  notCompanyFunds: number
  /** How many lines carry no kind at all. */
  unclassified: number
}

/**
 * Group classified lines and total each kind.
 *
 * The netting is deliberate. Cashback of 23.31 and personal spending of −5,000
 * do not add up to "5,023.31 of non-company activity"; they add up to the
 * −4,976.69 the account is out of pocket on the holder's behalf. A transfer
 * settles a NET position, so the figure offered has to be the net one.
 */
export function summariseKinds(
  lines: readonly { amount: number; lineKind?: string | null }[],
): KindSummary {
  const byKind = new Map<string, KindGroup>()
  let unclassified = 0

  for (const line of lines) {
    const kind = line.lineKind && LINE_KIND_MAP[line.lineKind]
    if (!kind) { unclassified++; continue }
    const at = byKind.get(kind.key) ?? { kind, count: 0, total: 0 }
    at.count += 1
    at.total = Math.round((at.total + line.amount) * 100) / 100
    byKind.set(kind.key, at)
  }

  // Ordered as LINE_KINDS is, so the panel does not reshuffle as lines are set
  // aside one at a time.
  const groups = LINE_KINDS.map(k => byKind.get(k.key)).filter((g): g is KindGroup => Boolean(g))
  const notCompanyFunds = Math.round(
    groups.filter(g => g.kind.notCompanyFunds).reduce((s, g) => s + g.total, 0) * 100) / 100

  return { groups, notCompanyFunds, unclassified }
}
