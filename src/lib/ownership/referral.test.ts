import { describe, it, expect } from 'vitest'
import { validateReferral, referralCommission } from './referral'
import { attributeReferrals, type ReferralTaskRow } from './work-measures'
import { earningFor, measuredFor, computeAwards } from './compute'
import { rateLabel, explainAward } from './format'
import { roleKeyOf } from './role-earnings'
import type { OwnershipProgram, OwnershipRule, OwnershipPeriod } from './types'

describe('validateReferral', () => {
  it('treats both empty as "no referral"', () => {
    expect(validateReferral(null, null)).toEqual({ ok: true, employeeId: null, percent: null })
    expect(validateReferral('', undefined)).toEqual({ ok: true, employeeId: null, percent: null })
  })

  it('accepts a staff member with a % in range, rounded to two places', () => {
    expect(validateReferral('emp-1', 10)).toEqual({ ok: true, employeeId: 'emp-1', percent: 10 })
    expect(validateReferral('emp-1', 12.345)).toEqual({ ok: true, employeeId: 'emp-1', percent: 12.35 })
    expect(validateReferral('emp-1', 100)).toEqual({ ok: true, employeeId: 'emp-1', percent: 100 })
  })

  it('refuses half a referral, with a sentence to act on', () => {
    expect(validateReferral('emp-1', null)).toEqual({ ok: false, error: 'Enter their commission %.' })
    expect(validateReferral(null, 10)).toEqual({ ok: false, error: 'Pick who referred this job, or clear the %.' })
  })

  it('refuses a % of 0 or less, or over 100', () => {
    expect(validateReferral('emp-1', 0).ok).toBe(false)
    expect(validateReferral('emp-1', -5).ok).toBe(false)
    expect(validateReferral('emp-1', 100.01).ok).toBe(false)
  })
})

describe('referralCommission', () => {
  it('is the job billing × its %', () => {
    expect(referralCommission(20000, 10)).toBe(2000)
    expect(referralCommission(1499, 7.5)).toBe(112.43)
  })

  it('never pays more than the job, or less than nothing', () => {
    expect(referralCommission(1000, 150)).toBe(1000)
    expect(referralCommission(1000, -10)).toBe(0)
    expect(referralCommission(null, 10)).toBe(0)
  })
})

const job = (over: Partial<ReferralTaskRow>): ReferralTaskRow => ({
  id: 't1', task_number: 101, title: 'Wedding shoot', task_date: '2026-11-04',
  billing_amount_inr: 20000, status: 'done', referred_by: 'asha', referral_percent: 10, ...over,
})

describe('attributeReferrals', () => {
  it('pays each referrer every job they are named on, each at its own %', () => {
    const out = attributeReferrals([
      job({ id: 't1', billing_amount_inr: 20000, referral_percent: 10 }),          // 2,000
      job({ id: 't2', billing_amount_inr: 5000, referral_percent: 5 }),            //   250
      job({ id: 't3', billing_amount_inr: 8000, referral_percent: 20, referred_by: 'ravi' }), // 1,600
    ])
    expect(out.asha.units).toBe(2)
    expect(out.asha.amountInr).toBe(2250)
    expect(out.ravi.amountInr).toBe(1600)
    expect(out.asha.items.map(i => i.refId)).toEqual(['t1', 't2'])
  })

  it('pays nothing on a cancelled job, and still pays on a waived one', () => {
    // Waiving changes invoicing only; the job's billing amount is untouched,
    // exactly as for the designer's own commission.
    const out = attributeReferrals([
      job({ id: 'c', status: 'cancelled' }),
      job({ id: 'w', status: 'done', billing_amount_inr: 3000, referral_percent: 10 }),
    ])
    expect(out.asha.units).toBe(1)
    expect(out.asha.amountInr).toBe(300)
  })

  it('ignores jobs with no referrer or no %', () => {
    expect(attributeReferrals([job({ referred_by: null }), job({ referral_percent: null })])).toEqual({})
  })

  it('says on each item what it was and how it was worked out', () => {
    const [item] = attributeReferrals([job({})]).asha.items
    expect(item.label).toBe('#101 Wedding shoot · 10% of ₹20,000')
    expect(item.amountInr).toBe(2000)
  })
})

describe('the referrals basis in the award engine', () => {
  const rule: OwnershipRule = {
    id: 'r1', programId: 'p1', employeeId: null, designationId: 'admin',
    percent: 100, fixedAmountInr: null, label: 'Whoever is named on the job',
    effectiveFrom: '2026-01-01', effectiveTo: null, isActive: true,
  }
  const agg = { billingInr: 0, collectedInr: 0, profitInr: 0, amountByEmployee: { asha: 2250 }, unitsByEmployee: { asha: 2 } }

  it('measures the person in rupees, never the job count', () => {
    expect(measuredFor('referrals', agg, 'asha', rule)).toBe(2250)
    expect(measuredFor('referrals', agg, 'asha', { percent: null, fixedAmountInr: 5 })).toBe(2250)
  })

  it('pays exactly what the jobs worked out — the rule is not applied on top', () => {
    // A rule % on top would take 10% of a job and then 10% of that.
    expect(earningFor('referrals', 2250, { ...rule, percent: 10 })).toBe(2250)
    expect(earningFor('referrals', 2250, rule)).toBe(2250)
    expect(earningFor('referrals', -5, rule)).toBe(0)
  })

  it('produces one award per referrer, itemised', () => {
    const program: OwnershipProgram = {
      id: 'p1', name: 'Referral commission', programType: 'referral', basis: 'referrals',
      periodType: 'monthly', scopeKind: 'company', scopeId: null, periodStart: null, periodEnd: null,
      effectiveFrom: '2026-01-01', effectiveTo: null, isActive: true,
    }
    const period: OwnershipPeriod = { start: '2026-11-01', end: '2026-11-30', bookedMonth: 11, bookedYear: 2026, label: 'November 2026' }
    const [award] = computeAwards(program, [{ employeeId: 'asha', rule }], agg, period)
    expect(award.earnedInr).toBe(2250)
    expect(award.employeeId).toBe('asha')
    expect(award.period.bookedMonth).toBe(11)
  })

  it('goes by the program name, not the placeholder rule label', () => {
    const program: OwnershipProgram = {
      id: 'p1', name: 'Referral commission', programType: 'referral', basis: 'referrals',
      periodType: 'monthly', scopeKind: 'company', scopeId: null, periodStart: null, periodEnd: null,
      effectiveFrom: '2026-01-01', effectiveTo: null, isActive: true,
    }
    const period: OwnershipPeriod = { start: '2026-11-01', end: '2026-11-30', bookedMonth: 11, bookedYear: 2026, label: 'November 2026' }
    const [award] = computeAwards(program, [{ employeeId: 'asha', rule: { ...rule, label: 'Whoever is named on the job' } }], agg, period)
    expect(award.breakdown.ruleLabel).toBeNull()
    // An award stored with the old label still reads as the program.
    expect(roleKeyOf({ label: 'Whoever is named on the job', programName: 'Referral commission', basis: 'referrals' })).toBe('Referral commission')
    expect(roleKeyOf({ label: 'Team Lead', programName: 'Operations', basis: 'billing' })).toBe('Team Lead')
  })

  it('describes itself honestly on a payslip', () => {
    // The stored 100% is the placeholder rule's, not a rate anyone agreed to.
    const shape = { basis: 'referrals', basisAmountInr: 2250, percent: 100, earnedInr: 2250 }
    expect(rateLabel(shape)).toBe("each job's own % (₹2,250)")
    expect(explainAward(shape)).toBe('Referred jobs, each at its own % = ₹2,250')
  })
})
