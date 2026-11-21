import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/mcp/ops-actions', () => ({ unbilledTasks: vi.fn() }))
vi.mock('@/lib/notifications/create', () => ({ notifyAdmins: vi.fn() }))

import { billingMonth } from './billing'

describe('month-end billing window', () => {
  it('runs on the last two days for this month and the first three for last month', () => {
    expect(billingMonth('2026-11-28')).toBeNull()
    expect(billingMonth('2026-11-29')).toBe('2026-11-01')
    expect(billingMonth('2026-11-30')).toBe('2026-11-01')
    expect(billingMonth('2026-12-01')).toBe('2026-11-01')
    expect(billingMonth('2026-12-03')).toBe('2026-11-01')
    expect(billingMonth('2026-12-04')).toBeNull()
    expect(billingMonth('2027-02-27')).toBe('2027-02-01')
  })
})
