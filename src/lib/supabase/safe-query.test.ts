import { describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({ cookies: () => ({}) }))
import { safeQuery } from './server'

describe('optional-table queries', () => {
  it('returns successful rows, including a genuinely empty table', async () => {
    const rows = [{ task_id: 'task-1', employee_id: 'employee-1' }]
    expect(await safeQuery('assignments-success', Promise.resolve({ data: rows, error: null })))
      .toEqual({ data: rows, error: null })
    expect(await safeQuery('assignments-empty', Promise.resolve({ data: [], error: null })))
      .toEqual({ data: [], error: null })
  })

  it('keeps the compatibility fallback for a missing optional table', async () => {
    const result = await safeQuery('optional-missing', Promise.resolve({
      data: null, error: { code: 'PGRST205', message: 'Missing optional table' },
    }))
    expect(result).toEqual({ data: [], error: null })
  })

  it.each(['42501', 'PGRST301', '08006'])('does not disguise %s as an empty assignment list', async code => {
    const error = { code, message: 'Database error with internal details' }
    await expect(safeQuery(`failed-${code}`, Promise.resolve({ data: null, error })))
      .rejects.toMatchObject({ message: `Unable to load failed-${code}. Please try again.`, cause: error })
    // A transient failure must not poison the missing-table cache.
    expect(await safeQuery(`failed-${code}`, Promise.resolve({ data: [{ id: 'recovered' }], error: null })))
      .toEqual({ data: [{ id: 'recovered' }], error: null })
  })

  it('propagates a rejected network request to the page error boundary', async () => {
    await expect(safeQuery('network-failure', Promise.reject(new Error('Network unavailable'))))
      .rejects.toThrow('Network unavailable')
  })
})
