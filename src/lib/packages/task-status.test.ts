import { describe, it, expect } from 'vitest'
import { buildCoverageIndex, taskBillingStatus, type CoveragePackage, type CoverageTask } from './task-status'
import type { PackageItemRow } from './types'

const POSTER = 'svc-poster'
const HIGHLIGHT = 'svc-highlight-icons'
const PKG = 'pkg-social'

const socialPackage: CoveragePackage = {
  id: PKG, billing_type: 'monthly', start_date: '2026-07-20', end_date: null,
}

/** 15 Social Media Posters a month — the real package this was written for. */
const items: PackageItemRow[] = [{
  id: 'item-1', package_id: PKG, service_id: POSTER, included_quantity: 15,
  display_order: 0, created_at: '', updated_at: '',
}]

function poster(n: number, over: Partial<CoverageTask> = {}): CoverageTask {
  return {
    id: `t${n}`,
    service_id: POSTER,
    task_date: `2026-08-${String(n).padStart(2, '0')}`,
    task_number: 1000 + n,
    status: 'done',
    package_id: PKG,
    ...over,
  }
}

describe('buildCoverageIndex', () => {
  it('covers work inside the allowance and bills the rest as extra', () => {
    const tasks = Array.from({ length: 17 }, (_, i) => poster(i + 1))
    const index = buildCoverageIndex([socialPackage], items, tasks)

    expect(index.get('t1')).toBe('covered')
    expect(index.get('t15')).toBe('covered')
    expect(index.get('t16')).toBe('extra')
    expect(index.get('t17')).toBe('extra')
  })

  it('gives each month its own allowance', () => {
    const august = Array.from({ length: 15 }, (_, i) => poster(i + 1))
    const september = poster(1, { id: 'sep-1', task_date: '2026-09-01', task_number: 2000 })
    const index = buildCoverageIndex([socialPackage], items, [...august, september])

    // August is full, but September starts fresh — not an overage.
    expect(index.get('t15')).toBe('covered')
    expect(index.get('sep-1')).toBe('covered')
  })

  it('leaves unlinked tasks out of the index entirely', () => {
    const index = buildCoverageIndex([socialPackage], items, [poster(1, { package_id: null })])
    expect(index.has('t1')).toBe(false)
  })
})

describe('a Facebook cover, delivered as a poster', () => {
  it('consumes one poster slot and is covered by the fee', () => {
    // No new service: the cover IS a Social Media Poster, so it takes a slot.
    const fourteen = Array.from({ length: 14 }, (_, i) => poster(i + 1))
    const cover = poster(15, { id: 'fb-cover', title: 'Facebook cover' } as Partial<CoverageTask>)
    const index = buildCoverageIndex([socialPackage], items, [...fourteen, cover])

    expect(taskBillingStatus(cover, index)).toBe('covered')
    // …and the 16th poster of the month is then an extra, as it should be.
    const sixteenth = poster(16)
    const withSixteen = buildCoverageIndex([socialPackage], items, [...fourteen, cover, sixteenth])
    expect(taskBillingStatus(sixteenth, withSixteen)).toBe('extra')
  })
})

describe('a Facebook cover spending a committed poster', () => {
  // The real case: its own service (its own price, its own place in reports),
  // but the agreement is that it comes out of the 15 posters.
  const COVER = 'svc-fb-cover'
  const cover: CoverageTask = {
    id: 'fb-cover', service_id: COVER, task_date: '2026-08-20', task_number: 1800,
    status: 'done', package_id: PKG, package_counts_as_service_id: POSTER,
  }

  it('is covered by the fee and uses one slot', () => {
    const fourteen = Array.from({ length: 14 }, (_, i) => poster(i + 1))
    const index = buildCoverageIndex([socialPackage], items, [...fourteen, cover])

    expect(taskBillingStatus(cover, index)).toBe('covered')
  })

  it('queues behind posters delivered before it, like any other slot', () => {
    // Slots go oldest first. A poster on the 15th is delivered before the cover
    // on the 20th, so it takes the last slot and the cover becomes the overage —
    // the same rule that applies between two posters, with no special case for
    // the substitution.
    const fourteen = Array.from({ length: 14 }, (_, i) => poster(i + 1))
    const fifteenth = poster(15)
    const index = buildCoverageIndex([socialPackage], items, [...fourteen, fifteenth, cover])

    expect(taskBillingStatus(fifteenth, index)).toBe('covered')
    expect(taskBillingStatus(cover, index)).toBe('extra')
  })

  it('bills on its own when nobody spends a slot on it', () => {
    // Same task without the substitution: not a poster, so the fee cannot cover
    // it and it charges normally.
    const unsubstituted: CoverageTask = { ...cover, package_counts_as_service_id: null }
    const index = buildCoverageIndex([socialPackage], items, [unsubstituted])
    expect(taskBillingStatus(unsubstituted, index)).toBe('billable')
  })

  it('goes over the allowance like any other poster once the month is full', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => poster(i + 1))
    const index = buildCoverageIndex([socialPackage], items, [...fifteen, cover])
    expect(taskBillingStatus(cover, index)).toBe('extra')
  })
})

describe('a highlight icon, given away', () => {
  const icon: CoverageTask = {
    id: 'icon-1', service_id: HIGHLIGHT, task_date: '2026-08-05', task_number: 1500,
    status: 'done', package_id: null, is_billable: false,
  }

  it('reads as waived, not as package work', () => {
    const index = buildCoverageIndex([socialPackage], items, [icon])
    expect(taskBillingStatus(icon, index)).toBe('waived')
  })

  it('does NOT consume the poster allowance, even if someone links it', () => {
    // The client's 15 posters stay 15: a free extra is not a deliverable they
    // paid for. Waived tasks never enter the coverage input at all.
    const fifteen = Array.from({ length: 15 }, (_, i) => poster(i + 1))
    const linkedIcon: CoverageTask = { ...icon, package_id: PKG, service_id: POSTER }
    const index = buildCoverageIndex([socialPackage], items, [...fifteen, linkedIcon])

    expect(index.get('t15')).toBe('covered')          // still inside the allowance
    expect(index.has('icon-1')).toBe(false)
    expect(taskBillingStatus(linkedIcon, index)).toBe('waived')
  })

  it('is billable again the moment a manager says so', () => {
    const index = buildCoverageIndex([socialPackage], items, [{ ...icon, is_billable: true }])
    expect(taskBillingStatus({ ...icon, is_billable: true }, index)).toBe('billable')
  })
})

describe('taskBillingStatus', () => {
  it('reads waived before anything else', () => {
    const tasks = Array.from({ length: 3 }, (_, i) => poster(i + 1))
    const index = buildCoverageIndex([socialPackage], items, tasks)
    // A covered task that is ALSO waived is free work, and says so.
    expect(taskBillingStatus({ ...tasks[0], is_billable: false }, index)).toBe('waived')
  })

  it('calls an ordinary task billable', () => {
    expect(taskBillingStatus(poster(1, { package_id: null }), new Map())).toBe('billable')
  })
})
