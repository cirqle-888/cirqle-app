import { describe, it, expect } from 'vitest'
import { advanceRecoveredOf, grossOf, netOf, summarisePayroll } from './payroll'
import type { CreditRow, PayrollRow, Review } from './types'

const row = (over: Partial<PayrollRow>): PayrollRow => ({
  id: 'p1', employeeId: 'emp7', month: 9, year: 2026, base: 0, commission: 0, bonus: 0,
  adjustment: 0, ownership: 0, advancesDeducted: 0, otherDeductions: 0, storedNet: null, status: 'pending', ...over,
})

const summary = (rows: PayrollRow[], opts: {
  paid?: [string, number][]; credits?: CreditRow[]; reviews?: Review[]; months?: string[]; start?: string; end?: string
} = {}) => summarisePayroll({
  rows,
  paidByPayroll: new Map(opts.paid ?? []),
  credits: opts.credits ?? [],
  reviews: new Map((opts.reviews ?? []).map(r => [`${r.sourceTable}:${r.sourceId}`, r])),
  months: opts.months ?? ['2026-09-01'],
  start: opts.start ?? '2026-09-01',
  end: opts.end ?? '2026-09-30',
})

const review = (over: Partial<Review>): Review => ({
  id: 'r', sourceTable: 'payroll', sourceId: 'p1', category: 'advance_deduction', classification: 'linked',
  memberId: null, amountInr: null, reviewedOn: '2026-10-01', detail: null, ...over,
})

describe('payroll components (design §6.1)', () => {
  it('builds gross from every component (example 4)', () => {
    const r = row({ base: 15000, commission: 8400, bonus: 2000, adjustment: -600, ownership: 1200 })
    expect(grossOf(r)).toBe(26000)
    expect(netOf(r)).toBe(26000)
  })

  it('clamps net at zero and recovers only what pay allowed', () => {
    const r = row({ base: 25000, advancesDeducted: 30000 })
    expect(netOf(r)).toBe(0)
    expect(advanceRecoveredOf(r)).toBe(25000)
  })
})

describe('§6.2 worked examples', () => {
  it('1 — earned in September, paid in October: an expense in September, a liability until paid', () => {
    const r = row({ base: 20000, commission: 5000 })
    const sep = summary([r])
    expect(sep.remunerationInr).toBe(25000)
    expect(sep.liabilityInr).toBe(25000)
    const oct = summary([r], { paid: [['p1', 25000]], months: ['2026-10-01'], start: '2026-10-01', end: '2026-10-31' })
    expect(oct.remunerationInr).toBe(0)
    expect(oct.liabilityInr).toBe(0)
  })

  it('2 — an advance deducted from pay: expense is gross, and the deduction needs linking', () => {
    const r = row({ base: 20000, commission: 5000, advancesDeducted: 5000 })
    const sep = summary([r])
    expect(sep.remunerationInr).toBe(25000)
    expect(sep.liabilityInr).toBe(20000)
    expect(sep.reviewItems.map(i => i.category)).toEqual(['advance_deduction'])
    const linked = summary([r], { reviews: [review({})] })
    expect(linked.reviewItems).toEqual([])
  })

  it('3 — an advance converted to salary counts as pay only when classified as additional pay', () => {
    const credit: CreditRow = { id: 'c1', type: 'converted_salary', employeeId: 'emp7', amountInr: 5000, date: '2026-09-20' }
    const open = summary([], { credits: [credit] })
    expect(open.reviewItems.map(i => i.category)).toEqual(['credit_conversion'])
    expect(open.remunerationInr).toBe(0)
    const extra = summary([], { credits: [credit], reviews: [review({ sourceTable: 'credit_ledger', sourceId: 'c1', category: 'credit_conversion', classification: 'additional_pay' })] })
    expect(extra.remunerationInr).toBe(5000)
    // The double-count trap: a conversion that only records a payroll deduction adds nothing.
    const record = summary([], { credits: [credit], reviews: [review({ sourceTable: 'credit_ledger', sourceId: 'c1', category: 'credit_conversion', classification: 'records_deduction' })] })
    expect(record.remunerationInr).toBe(0)
  })

  it('4 — uses components even when stored net drops the bonus, and flags it', () => {
    const r = row({ base: 15000, commission: 8400, bonus: 2000, adjustment: -600, ownership: 1200, storedNet: 24000 })
    const s = summary([r], { paid: [['p1', 24000]] })
    expect(s.remunerationInr).toBe(26000)
    expect(s.liabilityInr).toBe(2000)
    expect(s.warnings.map(w => w.key)).toContain('stored_net')
  })

  it('6 — pay is gross, not the net salary entry', () => {
    const r = row({ base: 20000, commission: 5000, advancesDeducted: 5000 })
    const s = summary([r], { paid: [['p1', 20000]], reviews: [review({})] })
    expect(s.remunerationInr).toBe(25000)
    expect(s.liabilityInr).toBe(0)
  })

  it('warns about other deductions without changing the expense (D17)', () => {
    const r = row({ base: 20000, otherDeductions: 1500 })
    const s = summary([r])
    expect(s.remunerationInr).toBe(20000)
    expect(s.liabilityInr).toBe(18500)
    expect(s.warnings.find(w => w.key === 'other_deductions')?.amountInr).toBe(1500)
  })

  it('reports a month with no payroll at all', () => {
    expect(summary([], { months: ['2026-09-01'] }).monthsWithoutPayroll).toEqual(['2026-09-01'])
  })
})
