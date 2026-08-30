import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEmployee, updateEmployee } from './actions'

// Mock dependencies
/** What the DB currently holds for the employee being edited. */
export let storedDesignation: string | null = 'existing-role'
export const setStoredDesignation = (v: string | null) => { storedDesignation = v }

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
            // Reading the stored designation is how the self-demotion guard
            // tells a real change from a form that merely echoes the field.
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                single: vi.fn(() => Promise.resolve({ data: { designation_id: storedDesignation }, error: null }))
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

const mockRequirePermission = vi.fn()
const mockRequireAdmin = vi.fn()

// One factory per module: a second vi.mock() for the same path silently replaces
// this one, which is how requirePermission went missing and took the SEC-01
// guarantees down with it. Every export settings/actions.ts pulls from
// permissions/check belongs here.
vi.mock('@/lib/permissions/check', () => ({
  requirePermission: (...args: any[]) => mockRequirePermission(...args),
  requireAdmin: (...args: any[]) => mockRequireAdmin(...args),
  resolveCurrentEmployeeId: vi.fn(() => Promise.resolve('test-user-id')),
  invalidateUserCache: vi.fn(),
}))

vi.mock('@/lib/activity/log', () => ({
  logActivity: vi.fn()
}))

vi.mock('@/lib/fx/sync', () => ({
  syncRatesToDb: vi.fn(),
  ratesAreStale: vi.fn()
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  // upsertCompanySettings busts the shared company-settings cache.
  revalidateTag: vi.fn(),
  // actions.ts imports COMPANY_SETTINGS_TAG from lib/settings/company-settings,
  // which builds its cached reader with unstable_cache at module load. Pass the
  // function straight through so importing this module doesn't blow up.
  unstable_cache: <T>(fn: T) => fn
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
    setStoredDesignation('existing-role')

    const res = await updateEmployee('my-own-id', { designation_id: 'new-role' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Cannot change your own designation/)
  })

  // REGRESSION: the guard used to test `designation_id !== undefined`, and the
  // edit form posts the whole employee row — so the owner could not save any
  // change to their own record (services, salary day, rating) and was told the
  // designation was the problem.
  it('lets the caller edit their own record when the designation is unchanged', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: true })
    mockRequirePermission.mockResolvedValue({ ok: true, employeeId: 'my-own-id' })
    setStoredDesignation('existing-role')

    const res = await updateEmployee('my-own-id', {
      designation_id: 'existing-role',   // echoed unchanged by the form
      performance_rating: 95,
    })
    expect(res.ok).toBe(true)
  })

  it('treats null and undefined designations as the same value, not a change', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: true })
    mockRequirePermission.mockResolvedValue({ ok: true, employeeId: 'my-own-id' })
    setStoredDesignation(null)

    const res = await updateEmployee('my-own-id', { designation_id: null, performance_rating: 80 })
    expect(res.ok).toBe(true)
  })

  it('still lets an admin change SOMEONE ELSE\'s designation', async () => {
    mockRequireAdmin.mockResolvedValue({ ok: true })
    mockRequirePermission.mockResolvedValue({ ok: true, employeeId: 'my-own-id' })
    setStoredDesignation('existing-role')

    const res = await updateEmployee('someone-else', { designation_id: 'new-role' })
    expect(res.ok).toBe(true)
  })
})
