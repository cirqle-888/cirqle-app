import { describe, it, expect } from 'vitest'
import { headlineReach } from './shared'
import type { RenderData } from '../types'

const data = (dateFrom: string, dateTo: string, periodReach?: RenderData['kpi']['periodReach']) =>
  ({ config: { dateFrom, dateTo }, kpi: { primary: { reach: 1500 }, periodReach } }) as unknown as RenderData

describe('headlineReach', () => {
  it('uses unique period reach when the platform returned it', () => {
    expect(headlineReach(data('2026-10-01', '2026-10-07', { available: true, value: 900, source: 'meta', fetchedAt: '' })))
      .toEqual({ label: 'Reach', value: '900', unique: true })
  })
  it('labels a multi-day sum as a sum', () => {
    expect(headlineReach(data('2026-10-01', '2026-10-07', { available: false, reason: 'x' })).label).toBe('Reach (sum)')
    expect(headlineReach(data('2026-10-01', '2026-10-07')).label).toBe('Reach (sum)')
  })
  it('a single day is already unique', () => {
    expect(headlineReach(data('2026-10-07', '2026-10-07')).label).toBe('Reach')
  })
})
