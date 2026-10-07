import { describe, it, expect } from 'vitest'
import { ownershipRowLabel } from './payslip-html'

/**
 * The payslip goes to the employee. An ownership line must say WHAT they
 * earned and for WHICH role — never the rate or the measured billing
 * ("3% of their clients' billing (₹6,300)" leaked a client's billing).
 */
describe('ownershipRowLabel', () => {
  const award = { programName: 'Client Managing', label: 'Client Managing', basis: 'clients_handled', percent: 3, basisAmountInr: 6300, fixedAmountInr: null, earnedInr: 189 }

  it('names the role once and nothing else', () => {
    expect(ownershipRowLabel(award)).toBe('Client Managing')
    expect(ownershipRowLabel({ ...award, programName: 'Operations', label: 'Operation Manager' })).toBe('Operations · Operation Manager')
    expect(ownershipRowLabel({ ...award, label: null })).toBe('Client Managing')
  })

  it('never carries a rate or a rupee figure', () => {
    for (const a of [award, { ...award, basis: 'entries', percent: null, fixedAmountInr: 5, basisAmountInr: 142 }]) {
      expect(ownershipRowLabel(a)).not.toMatch(/%|₹|\d/)
    }
  })
})
