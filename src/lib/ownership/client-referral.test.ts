import { describe, it, expect } from 'vitest'
import { planClientReferralSync, clientReferralRangeError, type ClientReferral, type ReferralJob } from './referral'

const job = (id: string, date: string, referredBy: string | null = null, percent: number | null = null): ReferralJob =>
  ({ id, date, referredBy, percent })
const ref = (employeeId: string, percent: number, from: string, until: string | null = null): ClientReferral =>
  ({ employeeId, percent, from, until })

describe('planClientReferralSync', () => {
  it('fills jobs with no referral inside the range, and none outside it', () => {
    const jobs = [job('a', '2026-10-31'), job('b', '2026-11-01'), job('c', '2026-11-20')]
    expect(planClientReferralSync(jobs, null, ref('asha', 5, '2026-11-01'))).toEqual([
      { id: 'b', date: '2026-11-01', referredBy: 'asha', percent: 5 },
      { id: 'c', date: '2026-11-20', referredBy: 'asha', percent: 5 },
    ])
  })

  it('respects the end date', () => {
    const jobs = [job('a', '2026-11-30'), job('b', '2026-12-01')]
    expect(planClientReferralSync(jobs, null, ref('asha', 5, '2026-11-01', '2026-11-30')).map(c => c.id)).toEqual(['a'])
  })

  it('never touches a job someone set by hand to something else', () => {
    const jobs = [job('a', '2026-11-05', 'ravi', 10)]
    expect(planClientReferralSync(jobs, null, ref('asha', 5, '2026-11-01'))).toEqual([])
    expect(planClientReferralSync(jobs, ref('asha', 5, '2026-11-01'), ref('asha', 7, '2026-11-01'))).toEqual([])
  })

  it('moves jobs that came from the old client referral to the new one', () => {
    const jobs = [job('a', '2026-11-05', 'asha', 5), job('b', '2026-11-06')]
    expect(planClientReferralSync(jobs, ref('asha', 5, '2026-11-01'), ref('ravi', 8, '2026-11-01'))).toEqual([
      { id: 'a', date: '2026-11-05', referredBy: 'ravi', percent: 8 },
      { id: 'b', date: '2026-11-06', referredBy: 'ravi', percent: 8 },
    ])
  })

  it('removing the client referral clears only the jobs it filled', () => {
    const jobs = [job('a', '2026-11-05', 'asha', 5), job('b', '2026-11-06', 'ravi', 10), job('c', '2026-10-01', 'asha', 5)]
    expect(planClientReferralSync(jobs, ref('asha', 5, '2026-11-01'), null)).toEqual([
      { id: 'a', date: '2026-11-05', referredBy: null, percent: null },
    ])
  })

  it('narrowing the range clears jobs that fall out of it', () => {
    const jobs = [job('a', '2026-11-05', 'asha', 5), job('b', '2026-12-05', 'asha', 5)]
    expect(planClientReferralSync(jobs, ref('asha', 5, '2026-11-01'), ref('asha', 5, '2026-11-01', '2026-11-30'))).toEqual([
      { id: 'b', date: '2026-12-05', referredBy: null, percent: null },
    ])
  })

  it('returns nothing when nothing changes', () => {
    const jobs = [job('a', '2026-11-05', 'asha', 5)]
    expect(planClientReferralSync(jobs, ref('asha', 5, '2026-11-01'), ref('asha', 5, '2026-11-01'))).toEqual([])
  })
})

describe('clientReferralRangeError', () => {
  it('accepts an open or closed range', () => {
    expect(clientReferralRangeError('2026-11-01', null)).toBeNull()
    expect(clientReferralRangeError('2026-11-01', '2026-11-01')).toBeNull()
  })
  it('refuses a missing start or an end before the start', () => {
    expect(clientReferralRangeError('', null)).toBe('Pick the date it starts from.')
    expect(clientReferralRangeError('2026-11-01', '2026-10-31')).toBe('The end date is before the start date.')
  })
})
