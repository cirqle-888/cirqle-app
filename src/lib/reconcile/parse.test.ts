import { describe, it, expect } from 'vitest'
import { guessColumns, parseStatementRows, parseStatementText, readAmount } from './parse'
import { periodBalance } from './match'

/**
 * Parsing a statement, and the two ways it silently ruins a reconciliation.
 *
 * A refund read as a charge puts a cycle out by twice its value, and the
 * cycle still "balances" against a wrong total. A date read month-first
 * lands a charge in the wrong cycle, where it is missing from one statement
 * and unexplained on another. Both groups below exist for those.
 */

describe('the sign — a credit is not a charge', () => {
  it('reads Cr as a credit and Dr as a charge', () => {
    expect(readAmount('2,286.83 Cr')).toEqual({ amount: 2286.83, credit: true })
    expect(readAmount('2,286.83 Dr')).toEqual({ amount: 2286.83, credit: false })
    expect(readAmount('CR 500.00')).toEqual({ amount: 500, credit: true })
  })

  it('reads brackets and a minus as a credit', () => {
    expect(readAmount('(1,250.00)')?.credit).toBe(true)
    expect(readAmount('-1,250.00')?.credit).toBe(true)
  })

  it('reports NO marker rather than guessing one', () => {
    // A bare number in a Debit column is a charge; a bare number on a pasted
    // line is only probably one. The caller decides, so this must not.
    expect(readAmount('1,250.00')).toEqual({ amount: 1250, credit: null })
  })

  it('strips currency symbols and codes', () => {
    expect(readAmount('₹ 2,286.83')?.amount).toBe(2286.83)
    expect(readAmount('INR 2,286.83')?.amount).toBe(2286.83)
    expect(readAmount('Rs. 500')?.amount).toBe(500)
  })

  it('is null when there is no number at all', () => {
    expect(readAmount('')).toBeNull()
    expect(readAmount('Opening balance')).toBeNull()
  })
})

describe('pasted statement text', () => {
  it('reads the shape every bank collapses to', () => {
    const got = parseStatementText(`
      25/06/2026   ANTHROPIC CLAUDE.AI SUBSCRIPTION      2,286.83
      01/07/2026   GODADDY.COM 4806505                     715.84
    `)
    expect(got.problems).toEqual([])
    expect(got.lines).toEqual([
      { txnDate: '2026-06-25', description: 'ANTHROPIC CLAUDE.AI SUBSCRIPTION', amount: 2286.83, raw: expect.any(String), balanceAfter: null, reference: null },
      { txnDate: '2026-07-01', description: 'GODADDY.COM 4806505', amount: 715.84, raw: expect.any(String), balanceAfter: null, reference: null },
    ])
  })

  it('takes the LAST number as the amount, not one inside the description', () => {
    // 'AMAZON 4806505' — the merchant reference is not the money.
    const got = parseStatementText('25/06/2026  AMAZON SELLER 4806505   1,250.00')
    expect(got.lines[0].amount).toBe(1250)
    expect(got.lines[0].description).toBe('AMAZON SELLER 4806505')
  })

  it('makes a Cr line negative', () => {
    const got = parseStatementText('03/07/2026  REFUND AMAZON   450.00 Cr')
    expect(got.lines[0].amount).toBe(-450)
  })

  it('skips headers and footers instead of complaining about them', () => {
    // A statement is mostly these, and reporting each would bury a real failure.
    const got = parseStatementText(`
      STATEMENT OF ACCOUNT
      Date        Transaction Details              Amount
      25/06/2026  CLAUDE                         2,286.83
      Page 1 of 3
      Total                                      2,286.83
    `)
    expect(got.lines).toHaveLength(1)
    expect(got.problems).toEqual([])
  })

  it('reports a dated line whose amount it cannot read', () => {
    const got = parseStatementText('25/06/2026  SOME CHARGE  ---')
    expect(got.lines).toEqual([])
    expect(got.problems[0].reason).toMatch(/amount/i)
  })

  it('reports a dated amount with no description', () => {
    const got = parseStatementText('25/06/2026     2,286.83')
    expect(got.problems[0].reason).toMatch(/description/i)
  })

  it('handles ISO and long-form dates', () => {
    const got = parseStatementText(`
      2026-06-25  CLAUDE   100.00
      25-Jun-2026 GODADDY  200.00
    `)
    expect(got.lines.map(l => l.txnDate)).toEqual(['2026-06-25', '2026-06-25'])
  })

  it('is empty, not broken, for nothing', () => {
    expect(parseStatementText('')).toEqual({ lines: [], problems: [], datesAmbiguous: false })
  })
})

describe('day-first, and honest when it cannot tell', () => {
  it('reads an unambiguous date the Indian way', () => {
    // 25 is not a month, so this can only be 25 June.
    expect(parseStatementText('25/06/2026 X 10.00').lines[0].txnDate).toBe('2026-06-25')
  })

  it('FLAGS a date that could be read either way', () => {
    // 03/04/2026 is 3 April day-first and 4 March month-first. It parses
    // day-first, and says it could not be sure — a silent choice here puts
    // a charge in the wrong cycle.
    const got = parseStatementText('03/04/2026 X 10.00')
    expect(got.lines[0].txnDate).toBe('2026-04-03')
    expect(got.datesAmbiguous).toBe(true)
  })

  it('does not flag when something in the batch settles it', () => {
    const got = parseStatementText('25/06/2026 X 10.00')
    expect(got.datesAmbiguous).toBe(false)
  })
})

describe('guessing the columns of an export', () => {
  it('finds the usual Indian header labels', () => {
    expect(guessColumns(['Transaction Date', 'Transaction Details', 'Debit', 'Credit']))
      .toEqual({ date: 0, description: 1, debit: 2, credit: 3 })
  })

  it('handles a single signed amount column', () => {
    expect(guessColumns(['Date', 'Narration', 'Amount'])).toEqual({ date: 0, description: 1, amount: 2 })
  })

  it('does not let "Debit Amount" steal the Amount slot', () => {
    const got = guessColumns(['Date', 'Particulars', 'Amount', 'Debit Amount'])
    expect(got.date).toBe(0)
    expect(got.description).toBe(1)
  })

  it('prefers an explicit debit/credit pair over a lone amount column', () => {
    const got = guessColumns(['Date', 'Details', 'Amount', 'Debit', 'Credit'])
    expect(got.debit).toBeDefined()
    expect(got.amount).toBeUndefined()
  })

  it('returns what it found and nothing it did not', () => {
    expect(guessColumns(['Foo', 'Bar'])).toEqual({})
  })
})

describe('tabular rows', () => {
  it('takes the sign from which COLUMN the number is in', () => {
    // No Cr/Dr marker needed: the column is the sign.
    const got = parseStatementRows(
      [['25/06/2026', 'CLAUDE', '2286.83', ''], ['03/07/2026', 'REFUND', '', '450.00']],
      { date: 0, description: 1, debit: 2, credit: 3 })
    expect(got.lines.map(l => l.amount)).toEqual([2286.83, -450])
  })

  it('reads a single signed column', () => {
    const got = parseStatementRows(
      [['25/06/2026', 'CLAUDE', '2286.83'], ['03/07/2026', 'REFUND', '450.00 Cr']],
      { date: 0, description: 1, amount: 2 })
    expect(got.lines.map(l => l.amount)).toEqual([2286.83, -450])
  })

  it('reports a row it cannot date, with the row in the message', () => {
    const got = parseStatementRows([['Opening Balance', '', '0']], { date: 0, description: 1, amount: 2 })
    expect(got.lines).toEqual([])
    expect(got.problems[0].reason).toContain('Opening Balance')
  })

  it('skips a wholly blank row', () => {
    const got = parseStatementRows([['', '', '']], { date: 0, description: 1, amount: 2 })
    expect(got).toEqual({ lines: [], problems: [], datesAmbiguous: false })
  })

  it('keeps the raw row so a bad parse can be seen', () => {
    const got = parseStatementRows([['25/06/2026', 'CLAUDE', '2286.83']], { date: 0, description: 1, amount: 2 })
    expect(got.lines[0].raw).toContain('CLAUDE')
  })
})

/* ── Bank statements ─────────────────────────────────────────────────────── */

describe('bank convention', () => {
  it('reads a withdrawal as money OUT and a deposit as money IN', () => {
    // The same 'Dr' that means a charge on a card means money leaving a bank.
    const rows = [
      ['01/07/2026', 'NEFT SEA STAR SUPERMARKET', '', '25,000.00', '1,25,000.00'],
      ['02/07/2026', 'UPI ZOHO CORP', '1,180.00', '', '1,23,820.00'],
    ]
    const got = parseStatementRows(rows, { date: 0, description: 1, debit: 2, credit: 3, balance: 4 }, { convention: 'bank' })
    expect(got.problems).toEqual([])
    expect(got.lines.map(l => l.amount)).toEqual([25000, -1180])
    expect(got.lines[1].balanceAfter).toBe(123820)
  })

  it('reads the SAME columns the opposite way for a card', () => {
    const rows = [['01/07/2026', 'GODADDY', '715.84', '', '']]
    const card = parseStatementRows(rows, { date: 0, description: 1, debit: 2, credit: 3 }, { convention: 'card' })
    const bank = parseStatementRows(rows, { date: 0, description: 1, debit: 2, credit: 3 }, { convention: 'bank' })
    expect(card.lines[0].amount).toBe(715.84)    // a charge raises what is owed
    expect(bank.lines[0].amount).toBe(-715.84)   // a debit lowers what is held
  })

  it('refuses to guess a bare unmarked amount on a bank account', () => {
    const rows = [['01/07/2026', 'SOME TRANSFER', '5,000.00']]
    const got = parseStatementRows(rows, { date: 0, description: 1, amount: 2 }, { convention: 'bank' })
    expect(got.lines).toEqual([])
    expect(got.problems[0].reason).toMatch(/money in or out/i)
  })

  it('still takes a marked amount on a bank account', () => {
    const rows = [
      ['01/07/2026', 'INTEREST', '412.00 Cr'],
      ['02/07/2026', 'BANK CHARGES', '118.00 Dr'],
    ]
    const got = parseStatementRows(rows, { date: 0, description: 1, amount: 2 }, { convention: 'bank' })
    expect(got.lines.map(l => l.amount)).toEqual([412, -118])
  })

  it('never lets a Balance column be mistaken for the amount', () => {
    const guess = guessColumns(['Date', 'Narration', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'])
    expect(guess.debit).toBe(2)
    expect(guess.credit).toBe(3)
    expect(guess.balance).toBe(4)
    expect(guess.amount).toBeUndefined()
  })

  it('picks up a reference column', () => {
    expect(guessColumns(['Txn Date', 'Particulars', 'Chq No', 'Debit', 'Credit']).reference).toBe(2)
  })
})

describe('a pasted bank statement with a running balance', () => {
  // The balance column settles every sign, so nothing here carries Dr/Cr.
  const paste = `
    01/07/2026   NEFT SEA STAR SUPERMARKET      25,000.00   1,25,000.00
    02/07/2026   UPI ZOHO CORP                   1,180.00   1,23,820.00
    03/07/2026   SALARY CQID004                 18,000.00   1,05,820.00
  `

  it('uses the balance moving to decide direction', () => {
    const got = parseStatementText(paste, { convention: 'bank', openingBalance: 100000 })
    expect(got.problems).toEqual([])
    expect(got.balanceChain?.used).toBe(true)
    expect(got.lines.map(l => l.amount)).toEqual([25000, -1180, -18000])
    expect(got.lines.map(l => l.balanceAfter)).toEqual([125000, 123820, 105820])
  })

  it('keeps the description clear of both numbers', () => {
    const got = parseStatementText(paste, { convention: 'bank', openingBalance: 100000 })
    expect(got.lines[0].description).toBe('NEFT SEA STAR SUPERMARKET')
  })

  it('reports the first line when nothing settles its direction', () => {
    // No opening balance given, so line 1 has no predecessor to compare to and
    // carries no marker. It is reported; the rest still come through.
    const got = parseStatementText(paste, { convention: 'bank' })
    expect(got.lines.map(l => l.amount)).toEqual([-1180, -18000])
    expect(got.problems).toHaveLength(1)
    expect(got.problems[0].reason).toMatch(/money in or out/i)
  })

  it('leaves a card paste alone', () => {
    const got = parseStatementText('25/06/2026  ANTHROPIC  2,286.83')
    expect(got.lines[0].amount).toBe(2286.83)
    expect(got.balanceChain).toBeUndefined()
  })
})

describe("the app's own statement template", () => {
  it('maps its headers without the person touching anything', () => {
    const guess = guessColumns(['account', 'date', 'description', 'reference', 'money_in', 'money_out', 'balance'])
    expect(guess).toMatchObject({ date: 1, description: 2, reference: 3, credit: 4, debit: 5, balance: 6 })
    expect(guess.amount).toBeUndefined()
  })
})

describe('an account that goes overdrawn mid-statement', () => {
  /**
   * Found against a real Kotak statement, 2026-09-22.
   *
   * The balance column prints a MAGNITUDE. When the account is overdrawn the
   * true balance is negative and the statement still shows a positive-looking
   * number, with no minus and no Dr marker. Reading the column as written
   * therefore inverts every line until the balance climbs back above zero —
   * deposits are read as withdrawals, silently, and the reconciliation is out
   * by twice each one while still looking tidy.
   *
   * Opening 10,000; a 30,000 payment takes it to −20,000 (printed 20,000);
   * three receipts bring it back to +15,000.
   */
  const paste = `
    01 Sep 2026  PAYMENT OUT      30,000.00   20,000.00
    02 Sep 2026  RECEIPT ONE       5,000.00   15,000.00
    03 Sep 2026  RECEIPT TWO       5,000.00   10,000.00
    04 Sep 2026  RECEIPT THREE    25,000.00   15,000.00
  `

  it('reads the receipts as money IN, not money out', () => {
    const got = parseStatementText(paste, { convention: 'bank', openingBalance: 10000 })
    expect(got.problems).toEqual([])
    expect(got.lines.map(l => l.amount)).toEqual([-30000, 5000, 5000, 25000])
  })

  it('records the balance as genuinely negative while it is', () => {
    const got = parseStatementText(paste, { convention: 'bank', openingBalance: 10000 })
    expect(got.lines.map(l => l.balanceAfter)).toEqual([-20000, -15000, -10000, 15000])
  })

  it('still trusts the balance column across the crossing', () => {
    // A zero crossing shows up as the SUM of two balances rather than their
    // difference. Counting only differences made the column look unreliable
    // exactly where it mattered most.
    const got = parseStatementText(paste, { convention: 'bank', openingBalance: 10000 })
    expect(got.balanceChain).toEqual({ used: true, checked: 3, agreed: 3 })
  })

  it('cannot tell which side of zero it started on without an opening balance', () => {
    // A LIMITATION, asserted so it stays visible rather than being discovered
    // during a reconciliation.
    //
    // The balance column constrains only the GAPS between rows, so a statement
    // running +20,000 → +15,000 and one running −20,000 → −15,000 print
    // identically. Nothing inside the text can separate them; only the opening
    // balance can, and without it the parser assumes the account is in credit,
    // which is right for almost every statement and wrong for this one.
    //
    // It is not silent. The first line has nothing to reconcile against and is
    // reported, and the period's own opening-plus-movement-equals-closing
    // check (periodBalance) then fails, which is what the import screen refuses
    // to close on. The fix for a person seeing that is to fill in the opening
    // balance — which is exactly what the screen asks for.
    const got = parseStatementText(paste, { convention: 'bank' })
    expect(got.problems).toHaveLength(1)
    expect(got.problems[0].reason).toMatch(/money in or out/i)
    expect(got.lines.map(l => l.amount)).toEqual([-5000, -5000, -25000])
  })

  it('and the period check is what catches that', () => {
    const got = parseStatementText(paste, { convention: 'bank' })
    const lines = got.lines.map((l, i) => ({ id: String(i), txnDate: l.txnDate, description: l.description, amount: l.amount }))
    // True closing is 15,000. The unanchored read moves the wrong way, so the
    // period refuses to balance and the screen says a line was read backwards.
    expect(periodBalance(lines, 10000, 15000).agrees).toBe(false)
    // With the opening balance supplied, it reconciles exactly.
    const ok = parseStatementText(paste, { convention: 'bank', openingBalance: 10000 })
    const okLines = ok.lines.map((l, i) => ({ id: String(i), txnDate: l.txnDate, description: l.description, amount: l.amount }))
    expect(periodBalance(okLines, 10000, 15000).agrees).toBe(true)
  })
})
