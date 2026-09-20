import { describe, it, expect } from 'vitest'
import { buildCreditLedger, stillOwing, UNATTRIBUTED, type CreditMovement } from './credit-ledger'

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
