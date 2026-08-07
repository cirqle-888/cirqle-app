import { describe, it, expect } from 'vitest'
import { feeBillingMonth, feeBillsInMonth, feeLineDescription } from './billing'
import { resolveDeliveryPeriod } from './progress'
import type { ClientAgreementRow, ClientAgreementItemRow } from './types'

// Elara: agreement starts 20 Jul 2026 (mid-month), open-ended.
const midMonthAgreement = { start_date: '2026-07-20', end_date: null } as ClientAgreementRow
const firstOfMonthAgreement = { start_date: '2026-07-01', end_date: null } as ClientAgreementRow

const retainer = {
  commitment_type: 'retainer', effective_from: '2026-07-20', effective_to: null,
} as ClientAgreementItemRow
const oneTime = {
  commitment_type: 'one_time', effective_from: '2026-07-20', effective_to: null,
} as ClientAgreementItemRow

describe('feeBillsInMonth — mid-month start (the double-billing bug)', () => {
  it('bills NOTHING in the stub month', () => {
    expect(feeBillsInMonth('2026-07', midMonthAgreement, retainer)).toBe(false)
  })
  it('bills exactly one fee in the merged month', () => {
    expect(feeBillsInMonth('2026-08', midMonthAgreement, retainer)).toBe(true)
  })
  it('bills once per calendar month thereafter', () => {
    expect(feeBillsInMonth('2026-09', midMonthAgreement, retainer)).toBe(true)
    expect(feeBillsInMonth('2026-10', midMonthAgreement, retainer)).toBe(true)
  })
  it('charges one fee across the whole merged period, not two', () => {
    const billed = ['2026-07', '2026-08']
      .filter(m => feeBillsInMonth(m, midMonthAgreement, retainer))
    expect(billed).toEqual(['2026-08'])
  })
})

describe('feeBillsInMonth — start on the 1st', () => {
  it('bills every month from the start month', () => {
    expect(feeBillsInMonth('2026-07', firstOfMonthAgreement, retainer)).toBe(true)
    expect(feeBillsInMonth('2026-08', firstOfMonthAgreement, retainer)).toBe(true)
  })
  it('bills nothing before the agreement starts', () => {
    expect(feeBillsInMonth('2026-06', firstOfMonthAgreement, retainer)).toBe(false)
  })
})

describe('feeBillsInMonth — one_time items', () => {
  it('bills once, riding with the merged first cycle on a mid-month start', () => {
    expect(feeBillsInMonth('2026-07', midMonthAgreement, oneTime)).toBe(false)
    expect(feeBillsInMonth('2026-08', midMonthAgreement, oneTime)).toBe(true)
    expect(feeBillsInMonth('2026-09', midMonthAgreement, oneTime)).toBe(false)
  })
  it('bills in its own month when the agreement starts on the 1st', () => {
    expect(feeBillsInMonth('2026-07', firstOfMonthAgreement, oneTime)).toBe(true)
    expect(feeBillsInMonth('2026-08', firstOfMonthAgreement, oneTime)).toBe(false)
  })
  it('never recurs', () => {
    const billed = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11']
      .filter(m => feeBillsInMonth(m, midMonthAgreement, oneTime))
    expect(billed).toHaveLength(1)
  })
})

describe('feeBillsInMonth — closed windows', () => {
  it('stops at the agreement end date', () => {
    const ending = { start_date: '2026-07-01', end_date: '2026-09-30' } as ClientAgreementRow
    expect(feeBillsInMonth('2026-09', ending, retainer)).toBe(true)
    expect(feeBillsInMonth('2026-10', ending, retainer)).toBe(false)
  })
  it('stops a superseded term row after its effective_to', () => {
    const closed = {
      commitment_type: 'retainer', effective_from: '2026-07-01', effective_to: '2026-08-31',
    } as ClientAgreementItemRow
    expect(feeBillsInMonth('2026-08', firstOfMonthAgreement, closed)).toBe(true)
    expect(feeBillsInMonth('2026-09', firstOfMonthAgreement, closed)).toBe(false)
  })
})

describe('billing agrees with the delivery engine', () => {
  // The contract that makes this module worth having: over any span, the number
  // of fees charged must equal the number of DISTINCT delivery periods that owed
  // a commitment. Charging more is double-billing; fewer is under-billing.
  const months = ['2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12']

  for (const [label, agreement] of [
    ['mid-month start', midMonthAgreement],
    ['start on the 1st', firstOfMonthAgreement],
  ] as const) {
    it(`charges one fee per delivery period — ${label}`, () => {
      const periods = new Set(
        months
          .map(m => resolveDeliveryPeriod(m, agreement, retainer))
          .filter(p => !p.inactive)
          .map(p => `${p.start}..${p.end}`),
      )
      const fees = months.filter(m => feeBillsInMonth(m, agreement, retainer)).length
      expect(fees).toBe(periods.size)
    })
  }

  it('charges one fee for the one_time item, matching its single active period', () => {
    const activePeriods = months
      .map(m => resolveDeliveryPeriod(m, midMonthAgreement, oneTime))
      .filter(p => !p.inactive)
    expect(activePeriods).toHaveLength(1)
    expect(months.filter(m => feeBillsInMonth(m, midMonthAgreement, oneTime))).toHaveLength(1)
  })
})

describe('feeBillingMonth', () => {
  it('redirects the stub month to the merged month', () => {
    expect(feeBillingMonth('2026-07', midMonthAgreement, retainer)).toBe('2026-08')
  })
  it('returns null before the agreement starts', () => {
    expect(feeBillingMonth('2026-06', midMonthAgreement, retainer)).toBeNull()
  })
})

describe('feeLineDescription', () => {
  it('spells out the merged opening period', () => {
    expect(feeLineDescription('2026-08', midMonthAgreement, retainer, 'Social Media Services'))
      .toBe('Retainer — Social Media Services (20 Jul – 31 Aug 2026)')
  })
  it('names a plain month otherwise', () => {
    expect(feeLineDescription('2026-09', midMonthAgreement, retainer, 'Social Media Services'))
      .toBe('Retainer — Social Media Services (Sep 2026)')
  })
  it('labels one-time items as such', () => {
    expect(feeLineDescription('2026-08', midMonthAgreement, oneTime, 'Logo Design'))
      .toBe('One-time — Logo Design (Aug 2026)')
  })
})
