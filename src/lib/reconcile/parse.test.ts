import { describe, it, expect } from 'vitest'
import { guessColumns, parseStatementRows, parseStatementText, readAmount } from './parse'

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
      { txnDate: '2026-06-25', description: 'ANTHROPIC CLAUDE.AI SUBSCRIPTION', amount: 2286.83, raw: expect.any(String) },
      { txnDate: '2026-07-01', description: 'GODADDY.COM 4806505', amount: 715.84, raw: expect.any(String) },
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
