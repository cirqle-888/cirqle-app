import { describe, it, expect } from 'vitest'
import { buildCreditLedger, stillOwing, UNATTRIBUTED, type CreditMovement, SETTLEMENTS, HITS_PNL } from './credit-ledger'

const move = (over: Partial<CreditMovement> = {}): CreditMovement => ({
  direction: 'given',
  employeeCqid: 'CQID001',
  amountInr: 50000,
  entryId: 'e1',
  entryDate: '2026-09-04',
  description: 'Withdraw for fund rolling',
  ...over,
})

describe('what is still owed', () => {
  it('subtracts what came back from what went out', () => {
    const led = buildCreditLedger([
      move({ amountInr: 50000 }),
      move({ amountInr: 50000, entryId: 'e2', entryDate: '2026-09-05' }),
      move({ direction: 'returned', amountInr: 20000, entryId: 'e3', entryDate: '2026-09-20' }),
    ])
    expect(led.totalGivenInr).toBe(100000)
    expect(led.totalReturnedInr).toBe(20000)
    expect(led.totalOutstandingInr).toBe(80000)
    expect(led.balances[0].employeeCqid).toBe('CQID001')
  })

  it('reads the DIRECTION, never the sign of the number', () => {
    // The ledger stores an outflow of 50,000 as 50,000 with type 'outflow'.
    // A ledger that trusted the sign would report this as a debt of zero.
    const led = buildCreditLedger([
      move({ amountInr: 50000 }),
      move({ direction: 'returned', amountInr: 50000, entryId: 'e2' }),
    ])
    expect(led.totalOutstandingInr).toBe(0)
  })

  it('survives an amount that arrives negative anyway', () => {
    const led = buildCreditLedger([move({ amountInr: -50000 })])
    expect(led.totalOutstandingInr).toBe(50000)
  })

  it('shows somebody who has paid back more than they took', () => {
    const led = buildCreditLedger([
      move({ amountInr: 10000 }),
      move({ direction: 'returned', amountInr: 15000, entryId: 'e2' }),
    ])
    expect(led.balances[0].outstandingInr).toBe(-5000)
  })

  it('keeps people apart', () => {
    const led = buildCreditLedger([
      move({ employeeCqid: 'CQID001', amountInr: 50000 }),
      move({ employeeCqid: 'CQID002', amountInr: 3000, entryId: 'e2' }),
    ])
    expect(led.balances.map(b => b.employeeCqid)).toEqual(['CQID001', 'CQID002'])
    expect(led.balances[0].outstandingInr).toBe(50000)
    expect(led.balances[1].outstandingInr).toBe(3000)
  })

  it('puts the largest debt first', () => {
    const led = buildCreditLedger([
      move({ employeeCqid: 'CQID002', amountInr: 1000 }),
      move({ employeeCqid: 'CQID003', amountInr: 90000, entryId: 'e2' }),
    ])
    expect(led.balances[0].employeeCqid).toBe('CQID003')
  })
})

describe('money out with nobody against it', () => {
  it('is reported, not dropped', () => {
    // A silent drop is how ₹50,000 goes missing from a balance that
    // otherwise looks tidy. It gets its own line and its own number.
    const led = buildCreditLedger([
      move({ employeeCqid: 'CQID001', amountInr: 50000 }),
      move({ employeeCqid: null, amountInr: 50000, entryId: 'e2' }),
    ])
    expect(led.totalOutstandingInr).toBe(100000)
    expect(led.unattributedInr).toBe(50000)
    expect(led.balances.some(b => b.employeeCqid === null)).toBe(true)
  })

  it('is zero when everything is attributed', () => {
    expect(buildCreditLedger([move()]).unattributedInr).toBe(0)
  })

  it('groups every unattributed entry into one bucket', () => {
    const led = buildCreditLedger([
      move({ employeeCqid: null, amountInr: 100 }),
      move({ employeeCqid: null, amountInr: 200, entryId: 'e2' }),
    ])
    expect(led.balances.filter(b => b.employeeCqid === null)).toHaveLength(1)
    expect(led.unattributedInr).toBe(300)
    expect(UNATTRIBUTED).toBe('unattributed')
  })
})

describe('the open debts on their own', () => {
  it('leaves out the settled and the overpaid', () => {
    const led = buildCreditLedger([
      move({ employeeCqid: 'CQID001', amountInr: 50000 }),
      move({ employeeCqid: 'CQID002', amountInr: 1000, entryId: 'e2' }),
      move({ employeeCqid: 'CQID002', direction: 'returned', amountInr: 1000, entryId: 'e3' }),
    ])
    expect(stillOwing(led).map(b => b.employeeCqid)).toEqual(['CQID001'])
  })

  it('is empty when nothing is owed', () => {
    expect(stillOwing(buildCreditLedger([]))).toEqual([])
  })
})

describe('what a balance carries with it', () => {
  it('keeps every movement, oldest first, for showing the working', () => {
    const led = buildCreditLedger([
      move({ entryDate: '2026-09-20', entryId: 'late' }),
      move({ entryDate: '2026-09-04', entryId: 'early' }),
    ])
    expect(led.balances[0].movements.map(m => m.entryId)).toEqual(['early', 'late'])
  })

  it('names nobody — CQIDs only', () => {
    // A balance sheet of who owes what is precisely the report where the
    // name-privacy rule matters most.
    const led = buildCreditLedger([move()])
    expect(JSON.stringify(led)).not.toMatch(/name/i)
  })
})

import { plannedCreditRows, CREDIT_GIVEN_CODE, CREDIT_RETURN_CODE } from './credit-ledger'

const facts = (over: Partial<Parameters<typeof plannedCreditRows>[0]> = {}) => ({
  accountCode: CREDIT_GIVEN_CODE,
  amountInr: 50000,
  entryDate: '2026-09-05',
  bankAccountId: 'bank-1',
  description: 'Withdraw for fund rolling',
  ...over,
})

describe('what a credit entry writes to the ledger', () => {
  it('writes NOTHING for an entry that is not a credit', () => {
    expect(plannedCreditRows(facts({ accountCode: 'opex.rent' }))).toEqual([])
    expect(plannedCreditRows(facts({ accountCode: null }))).toEqual([])
  })

  it('takes the entity smart mode named, when it named one', () => {
    const rows = plannedCreditRows(facts({
      smart: { mode: 'credit_given', entityType: 'employee', entityId: 'emp-9' },
    }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entity_id: 'emp-9', credit_type: 'given', amount: 50000 })
  })

  it('falls back to the split when smart mode was never touched', () => {
    // The case that lost two ₹50,000 withdrawals: saved without smart mode,
    // so the old gate wrote nothing at all.
    const rows = plannedCreditRows(facts({
      splits: [{ employeeId: 'emp-1', amountInr: 50000 }],
    }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entity_id: 'emp-1', amount: 50000 })
  })

  it('writes one row per person on a shared credit, at their own amounts', () => {
    const rows = plannedCreditRows(facts({
      amountInr: 30000,
      splits: [
        { employeeId: 'emp-1', amountInr: 20000 },
        { employeeId: 'emp-2', amountInr: 10000 },
      ],
    }))
    expect(rows.map(r => [r.entity_id, r.amount])).toEqual([['emp-1', 20000], ['emp-2', 10000]])
  })

  it('STILL writes a row when nobody is recorded at all', () => {
    // Not tidy, and that is the point: it puts the money on the Credits tab
    // with a blank where the name should be, where somebody can see it. The
    // alternative is the silence that hid ₹1,00,000.
    const rows = plannedCreditRows(facts())
    expect(rows).toHaveLength(1)
    expect(rows[0].entity_id).toBe(null)
    expect(rows[0].amount).toBe(50000)
    expect(rows[0].notes).toContain('no one recorded')
  })

  it('marks a return as returned, not given', () => {
    const rows = plannedCreditRows(facts({ accountCode: CREDIT_RETURN_CODE }))
    expect(rows[0].credit_type).toBe('returned')
  })

  it('stores a magnitude, whatever sign it is handed', () => {
    expect(plannedCreditRows(facts({ amountInr: -50000 }))[0].amount).toBe(50000)
  })

  it('keeps the entry description, and says who when smart mode named an "other"', () => {
    const rows = plannedCreditRows(facts({
      smart: { mode: 'credit_given', entityType: 'other', entityOther: 'Kalathingal' },
    }))
    expect(rows[0].notes).toBe('Withdraw for fund rolling (Kalathingal)')
    expect(rows[0].entity_type).toBe('other')
  })

  it('carries the date and bank through, which is what makes it reconcilable', () => {
    const rows = plannedCreditRows(facts())
    expect(rows[0]).toMatchObject({ credit_date: '2026-09-05', bank_account_id: 'bank-1' })
  })
})

describe('the three ways a credit ends', () => {
  it('cash back reduces what is owed', () => {
    const led = buildCreditLedger([
      move({ amountInr: 50000 }),
      move({ direction: 'returned', amountInr: 20000, entryId: 'r' }),
    ])
    expect(led.totalOutstandingInr).toBe(30000)
  })

  it('a conversion to the owner’s share reduces it too, and is not an expense', () => {
    const led = buildCreditLedger([
      move({ amountInr: 50000 }),
      move({ direction: 'converted_drawings', amountInr: 50000, entryId: 'd' }),
    ])
    expect(led.totalOutstandingInr).toBe(0)
    expect(led.totalConvertedToDrawingsInr).toBe(50000)
    expect(HITS_PNL).not.toContain('converted_drawings')
  })

  it('a conversion to salary reduces it, and IS an expense', () => {
    // The distinction that matters: the business has now spent the money,
    // where before it held a receivable. Without this somebody is paid and
    // it never appears as a cost.
    const led = buildCreditLedger([
      move({ amountInr: 50000 }),
      move({ direction: 'converted_salary', amountInr: 50000, entryId: 's' }),
    ])
    expect(led.totalOutstandingInr).toBe(0)
    expect(led.totalConvertedToSalaryInr).toBe(50000)
    expect(HITS_PNL).toContain('converted_salary')
  })

  it('handles one credit ending three different ways at once', () => {
    // ₹50,000 out: ₹20,000 back in cash, ₹20,000 becomes pay, ₹10,000 left.
    const led = buildCreditLedger([
      move({ amountInr: 50000 }),
      move({ direction: 'returned', amountInr: 20000, entryId: 'r' }),
      move({ direction: 'converted_salary', amountInr: 20000, entryId: 's' }),
    ])
    const b = led.balances[0]
    expect(b.givenInr).toBe(50000)
    expect(b.returnedInr).toBe(20000)
    expect(b.convertedToSalaryInr).toBe(20000)
    expect(b.outstandingInr).toBe(10000)
  })

  it('counts every settlement as settling, none as a second loan', () => {
    expect(SETTLEMENTS).toEqual(['returned', 'converted_drawings', 'converted_salary'])
    const led = buildCreditLedger([
      move({ amountInr: 90000 }),
      move({ direction: 'returned', amountInr: 30000, entryId: 'a' }),
      move({ direction: 'converted_drawings', amountInr: 30000, entryId: 'b' }),
      move({ direction: 'converted_salary', amountInr: 30000, entryId: 'c' }),
    ])
    expect(led.totalOutstandingInr).toBe(0)
    expect(led.totalGivenInr).toBe(90000)
  })

  it('leaves only the outstanding part as money that might come back', () => {
    // What expected cash may count. Converted money is spent, not owed.
    const led = buildCreditLedger([
      move({ amountInr: 50000 }),
      move({ direction: 'converted_drawings', amountInr: 50000, entryId: 'd' }),
      move({ employeeCqid: 'CQID002', amountInr: 8000, entryId: 'x' }),
    ])
    expect(led.totalOutstandingInr).toBe(8000)
  })
})
