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

  it('summary consolidates ownership into Additional Earnings and names no role', async () => {
    const { renderPayslipHtml, renderPayslipText } = await import('./payslip-html')
    const d = { ...base, format: 'summary' as const }
    for (const out of [renderPayslipHtml(d), renderPayslipText(d)]) {
      expect(out).toContain('Creative Rewards')
      expect(out).toContain('Additional Earnings')
      expect(out).toContain('Total Earnings')
      expect(out).toContain('420')
      expect(out).not.toContain('Client Managing')
    }
  })
})

describe('summary consolidates the rest into Additional Earnings', () => {
  it('Creative Rewards + Additional Earnings + adjustment add up to Total Earnings and net', async () => {
    const { renderPayslipText, additionalEarnings } = await import('./payslip-html')
    const s = { salaryType: 'commission_only', baseSalary: 0, commission: 4687, bonus: 0, adjustment: 0, adjustmentSources: [], ownership: 784,
      ownershipAwards: [{ programName: 'Operations', label: 'Invoicing', basis: 'billing', basisAmountInr: 1, percent: 1, fixedAmountInr: null, earnedInr: 784 }],
      advancesDeducted: 0, otherDeductions: 0, netSalary: 5471, status: 'paid', paidDate: '2026-10-07' }
    expect(additionalEarnings(s)).toBe(784)
    const text = renderPayslipText({ format: 'summary', salary: s, employee: { name: 'S', cqid: 'CQID002', designation: null }, period: { label: 'September 2026', month: 9, year: 2026, monthName: 'September' }, payslipNumber: null, attendance: { workedDays: 1, daysInMonth: 30 }, totals: { monthTaskCount: 1, sixMonthTotal: 0 }, contributionRanges: [], sixMonthEarnings: [], company: { name: 'C' } } as never)
    expect(text).toContain('Creative Rewards: ₹4,687')
    expect(text).toContain('Additional Earnings: ₹784')
    expect(text).toContain('Total Earnings:  ₹5,471')
    expect(text).not.toMatch(/Invoicing|Operations/)
  })
})

describe('summary: corrections and pay basis', () => {
  it('a recovered overpayment is folded into Creative Rewards — no deduction line', async () => {
    const { summaryCreative, summaryArrears } = await import('./payslip-html')
    expect(summaryCreative({ commission: 5153, adjustment: -291 })).toBe(4862)
    expect(summaryArrears({ adjustment: -291 })).toBe(0)
  })
  it('money owed back is shown as arrears', async () => {
    const { summaryCreative, summaryArrears } = await import('./payslip-html')
    expect(summaryCreative({ commission: 4000, adjustment: 291 })).toBe(4000)
    expect(summaryArrears({ adjustment: 291 })).toBe(291)
  })
  it('pay basis comes from the payslip, not the profile setting', async () => {
    const { payBasisLabel } = await import('./payslip-html')
    expect(payBasisLabel({ baseSalary: 0, commission: 231, ownership: 189 })).toBe('Commission-based')
    expect(payBasisLabel({ baseSalary: 15000, commission: 0 })).toBe('Fixed Salary')
    expect(payBasisLabel({ baseSalary: 15000, commission: 500 })).toBe('Base + Earnings')
  })
})

describe('a recovery larger than creative rewards', () => {
  it('no line goes negative and the lines still add up to the net', async () => {
    const { summaryCreative, summaryAdditional } = await import('./payslip-html')
    const s = { commission: 162, ownership: 888, bonus: 0, adjustment: -679 }
    expect(summaryCreative(s)).toBe(0)
    expect(summaryAdditional(s)).toBe(371)
    expect(summaryCreative(s) + summaryAdditional(s)).toBe(162 + 888 - 679)
  })
})
