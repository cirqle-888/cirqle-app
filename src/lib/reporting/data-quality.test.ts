import { describe, it, expect } from 'vitest'
import { assessDataQuality, describeDataQuality } from './data-quality'

const row = (date: string, spend = 100, impressions = 1000) => ({ date, spend, impressions })

describe('assessDataQuality', () => {
  it('separates zero-delivery days from missing days', () => {
    const q = assessDataQuality({
      dateFrom: '2026-10-01', dateTo: '2026-10-05', campaignStart: null, campaignEnd: null, today: '2026-10-20',
      rows: [row('2026-10-01'), row('2026-10-02', 0, 0), row('2026-10-04')],
    })
    expect(q).toMatchObject({ expectedDays: 5, recordedDays: 3, zeroDeliveryDays: 1, missingCount: 2, missingDates: ['2026-10-03', '2026-10-05'], includesToday: false })
    expect(describeDataQuality(q)).toMatch(/No data was synced for 2 of 5 days \(2026-10-03, 2026-10-05\)/)
  })

  it('a fully zero-delivery period with rows is complete, not missing', () => {
    const q = assessDataQuality({
      dateFrom: '2026-10-01', dateTo: '2026-10-02', campaignStart: null, campaignEnd: null, today: '2026-10-20',
      rows: [row('2026-10-01', 0, 0), row('2026-10-02', 0, 0)],
    })
    expect(q.missingCount).toBe(0)
    expect(q.zeroDeliveryDays).toBe(2)
    expect(describeDataQuality(q)).toBeNull()
  })

  it('clips to campaign dates and today, and flags a partial today', () => {
    const q = assessDataQuality({
      dateFrom: '2026-10-01', dateTo: '2026-10-31', campaignStart: '2026-10-10', campaignEnd: '2026-12-31', today: '2026-10-12',
      rows: [row('2026-10-10'), row('2026-10-11'), row('2026-10-12')],
    })
    expect(q.expectedDays).toBe(3)
    expect(q.missingCount).toBe(0)
    expect(q.includesToday).toBe(true)
    expect(describeDataQuality(q)).toMatch(/partial/)
  })

  it('a period before the campaign started expects nothing', () => {
    const q = assessDataQuality({
      dateFrom: '2026-09-01', dateTo: '2026-09-30', campaignStart: '2026-10-10', campaignEnd: null, today: '2026-10-20', rows: [],
    })
    expect(q.expectedDays).toBe(0)
  })
})
