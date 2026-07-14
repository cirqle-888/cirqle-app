import { describe, it, expect } from 'vitest'
import { buildTagSpend } from './tags'
import type { JournalLine } from './types'

let seq = 0
function line(over: Partial<JournalLine>): JournalLine {
  return {
    id: `l${++seq}`,
    date: '2026-07-10',
    scope: 'company',
    section: 'opex',
    accountCode: 'opex.software',
    categoryId: 'c1',
    categoryName: 'Software & Subscriptions',
    clientId: null,
    employeeId: null,
    bankAccountId: null,
    amountInr: -1000,
    description: null,
    isTransfer: false,
    ...over,
  }
}

describe('buildTagSpend', () => {
  it('sums outflow spend per tag, sorted descending', () => {
    const rows = buildTagSpend([
      line({ amountInr: -1200, tags: ['Photoshop'] }),
      line({ amountInr: -500, tags: ['Photoshop'] }),
      line({ amountInr: -3000, tags: ['Design'] }),
    ])
    expect(rows).toEqual([
      { tag: 'Design', totalInr: 3000, entryCount: 1 },
      { tag: 'Photoshop', totalInr: 1700, entryCount: 2 },
    ])
  })

  it('an entry with multiple tags contributes its full spend to each (not split)', () => {
    const rows = buildTagSpend([line({ amountInr: -1000, tags: ['Photoshop', 'Design'] })])
    expect(rows.find(r => r.tag === 'Photoshop')?.totalInr).toBe(1000)
    expect(rows.find(r => r.tag === 'Design')?.totalInr).toBe(1000)
  })

  it('ignores untagged lines and inflows', () => {
    const rows = buildTagSpend([
      line({ amountInr: -500 }),                         // no tags
      line({ amountInr: 900, tags: ['Photoshop'] }),      // inflow (positive) — not spend
    ])
    expect(rows).toEqual([])
  })

  it('returns [] for an empty input', () => {
    expect(buildTagSpend([])).toEqual([])
  })
})
