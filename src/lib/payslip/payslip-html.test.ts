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

describe('summary format', () => {
  const base = {
    employee: { id: 'e', cqid: 'CQID005', name: 'Noora', email: 'n@x', designation: 'Client Success', role: 'employee' },
    period: { month: 9, year: 2026, monthName: 'September', label: 'September 2026' },
    payslipNumber: 'PAY-005-1026', generatedAt: '2026-10-07T00:00:00Z',
    salary: {
      salaryType: 'fixed', baseSalary: 0, commission: 231, bonus: 0, adjustment: 0, adjustmentSources: [],
      ownership: 189,
      ownershipAwards: [{ programName: 'Client Managing', label: 'Client Managing', basis: 'clients_handled', basisAmountInr: 6300, percent: 3, fixedAmountInr: null, earnedInr: 189 }],
      advancesDeducted: 0, otherDeductions: 0, netSalary: 420, status: 'pending', paidDate: null,
    },
    performance: { rating: 100 }, attendance: { workedDays: 6, daysInMonth: 30 },
    contributionRanges: [], monthTasks: [], sixMonthEarnings: [],
    totals: { monthEarnings: 231, monthTaskCount: 6, sixMonthTotal: 420 },
    company: { name: 'Cirqle', email: 'a@b', website: 'x', phone: '1', logoUrl: null },
  } as unknown as import('./types').PayslipData

  it('detailed lists each earning', async () => {
    const { renderPayslipHtml, renderPayslipText } = await import('./payslip-html')
    expect(renderPayslipHtml(base)).toContain('Creative Rewards')
    expect(renderPayslipHtml(base)).toContain('Client Managing')
    expect(renderPayslipText(base)).toContain('Creative Rewards')
  })

  it('summary shows one Total Earnings figure and nothing about what it is for', async () => {
    const { renderPayslipHtml, renderPayslipText } = await import('./payslip-html')
    const d = { ...base, format: 'summary' as const }
    for (const out of [renderPayslipHtml(d), renderPayslipText(d)]) {
      expect(out).toContain('Total Earnings')
      expect(out).toContain('420')
      expect(out).not.toContain('Creative Rewards')
      expect(out).not.toContain('Client Managing')
    }
  })
})
