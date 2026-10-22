import { describe, it, expect } from 'vitest'
import { pendingOf, settlementRefusal } from './settlements'

describe('settlements (design §10.4)', () => {
  it('computes pending as amount minus everything settled', () => {
    expect(pendingOf(22715.99, [{ amountInr: 22715.99 }])).toBe(0)
    expect(pendingOf(1000, [{ amountInr: 300 }, { amountInr: 200 }])).toBe(500)
  })

  it('refuses paying more than is pending', () => {
    expect(settlementRefusal({ kind: 'paid', amountInr: 600, pendingInr: 500 })).toMatch(/still pending/)
    expect(settlementRefusal({ kind: 'paid', amountInr: 500, pendingInr: 500 })).toBeNull()
  })

  it('needs a reason to waive', () => {
    expect(settlementRefusal({ kind: 'waived', amountInr: 100, pendingInr: 500 })).toMatch(/reason/)
    expect(settlementRefusal({ kind: 'waived', amountInr: 100, pendingInr: 500, reason: 'Agreed with investor' })).toBeNull()
  })

  it('limits an advance offset to what the advance has left (§7.5)', () => {
    expect(settlementRefusal({ kind: 'advance_offset', amountInr: 22715.99, pendingInr: 22715.99, advanceLeftInr: 25000 })).toBeNull()
    expect(settlementRefusal({ kind: 'advance_offset', amountInr: 3000, pendingInr: 5000, advanceLeftInr: 2284.01 })).toMatch(/only/)
  })

  it('refuses device capital without an approved agreement (D10)', () => {
    expect(settlementRefusal({ kind: 'reinvested', amountInr: 100, pendingInr: 100, isDevice: true, hasDeviceAgreement: false })).toMatch(/agreement/)
    expect(settlementRefusal({ kind: 'reinvested', amountInr: 100, pendingInr: 100, isDevice: true, hasDeviceAgreement: true })).toBeNull()
  })

  it('needs a written acknowledgement to pay beyond the cash available (D13)', () => {
    expect(settlementRefusal({ kind: 'paid', amountInr: 100, pendingInr: 100, cashAvailableInr: 50 })).toMatch(/acknowledgement/)
    expect(settlementRefusal({ kind: 'paid', amountInr: 100, pendingInr: 100, cashAvailableInr: 50, cashAck: 'Paying from the reserve account' })).toBeNull()
  })
})
