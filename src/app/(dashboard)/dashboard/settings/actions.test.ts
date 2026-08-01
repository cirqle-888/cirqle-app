import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEmployee, updateEmployee } from './actions'

// Mock dependencies
vi.mock('@/lib/supabase/admin', () => {
  return {
    createAdminClient: vi.fn(() => ({
      from: vi.fn((table) => {
        if (table === 'employees') {
          return {
            insert: vi.fn((data) => ({
              select: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({ data: { id: 'mock-id', ...data }, error: null }))
              }))
            })),
            update: vi.fn((data) => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: vi.fn(() => Promise.resolve({ data: { id: 'mock-id', ...data }, error: null }))
                }))
              }))
            }))
          }
        }
        return {}
      })
    }))
  }
})

let mockRequirePermission = vi.fn()
let mockRequireAdmin = vi.fn()

vi.mock('@/lib/permissions/check', () => ({
  requirePermission: (...args: any[]) => mockRequirePermission(...args),
  requireAdmin: (...args: any[]) => mockRequireAdmin(...args),
  resolveCurrentEmployeeId: vi.fn(() => Promise.resolve('test-user-id'))
}))

vi.mock('@/lib/activity/log', () => ({
  logActivity: vi.fn()
}))

vi.mock('@/lib/fx/sync', () => ({
  syncRatesToDb: vi.fn(),
  ratesAreStale: vi.fn()
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn()
}))

vi.mock('@/lib/permissions/check', () => ({
  invalidateUserCache: vi.fn()
}))

vi.mock('@/lib/scope/audit', () => ({
  logScopeChanges: vi.fn(),
  diffAssignments: vi.fn()
}))

describe('Employee Settings Actions (SEC-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequirePermission.mockResolvedValue({ ok: true, employeeId: 'test-user-id' })
    mockRequireAdmin.mockResolvedValue({ ok: true })
  })

  it('drops unknown keys from the payload', async () => {
    const res = await createEmployee({ name: 'Alice', unknown_key: 'hacker' })
    expect(res.ok).toBe(true)
    expect(res.data).not.toHaveProperty('unknown_key')
    expect(res.data).toHaveProperty('name', 'Alice')
  })

  it('prevents non-admin with employees.edit from writing designation_id', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: false })
    
    // Attempting to set an escalating field
    const res = await updateEmployee('target-id', { designation_id: 'admin-role' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Only admins can set designations/)
  })

  it('prevents caller from changing their own designation', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: true })
    mockRequirePermission.mockResolvedValue({ ok: true, employeeId: 'my-own-id' })
    
    const res = await updateEmployee('my-own-id', { designation_id: 'new-role' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Cannot change your own designation/)
  })
})
