import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The authorization path must read through the SERVICE ROLE, not the
 * cookie-session client.
 *
 * loadCurrentUser() decides what every signed-in user may do, and it is
 * imported by 158 modules. It used to make all of its reads on the client
 * returned by `await createClient()` — the cookie-session client, which
 * connects to Postgres as `authenticated` and is therefore subject to table
 * grants.
 *
 * That made authorization depend on a grant on the permission catalogue itself.
 * The least-privilege migration (20260815110000) revokes `authenticated` on
 * everything outside its keep list, and `permissions` and
 * `designation_permissions` were not in it — so applying that migration would
 * have made hasPermission() return the empty set for every user on every page.
 * A silent, total lockout.
 *
 * An unauthenticated request returns before any of this runs, so no live smoke
 * test exercises it. This test does: it stubs both clients, drives
 * loadCurrentUser() with a signed-in user, and asserts which client each call
 * landed on.
 */

const sessionFrom = vi.fn()
const adminFrom = vi.fn()
const getUser = vi.fn()

/** A chainable Supabase query stub that resolves to `rows`. */
function queryStub(rows: unknown) {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'limit', 'order', 'in', 'not']) {
    chain[m] = vi.fn(() => chain)
  }
  chain.maybeSingle = vi.fn(async () => ({ data: rows, error: null }))
  chain.single = vi.fn(async () => ({ data: rows, error: null }))
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null })
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser }, from: sessionFrom }),
  createAdminClient: () => ({ from: adminFrom }),
}))
vi.mock('react', async (orig) => {
  const actual = await orig<typeof import('react')>()
  // `cache()` memoises per-request in Next; identity is enough here.
  return { ...actual, cache: (fn: unknown) => fn }
})
vi.mock('./dev-bypass', () => ({ devPermissionBypass: null }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }))

describe('loadCurrentUser reads through the service role', () => {
  // loadCurrentUser memoises per auth id in a module-level Map for 30s, so each
  // test needs its own user or it is asserting against the previous test's
  // cached result instead of a fresh set of queries.
  let userSeq = 0

  beforeEach(() => {
    vi.clearAllMocks()
    userSeq += 1
    getUser.mockResolvedValue({ data: { user: { id: `auth-user-${userSeq}` } } })

    adminFrom.mockImplementation((table: string) => {
      if (table === 'employees') {
        return queryStub({
          id: 'emp-1',
          cqid: 'CQID001',
          name: 'Test',
          email: 't@example.com',
          is_archived: false,
          date_of_birth: '1990-01-01',
          designation: { id: 'desig-1', name: 'Staff', is_admin: false },
        })
      }
      if (table === 'permissions') return queryStub([{ key: 'tasks.view' }])
      if (table === 'designation_permissions') {
        return queryStub([{ allowed: true, permission: { key: 'tasks.view' } }])
      }
      return queryStub([])
    })
    sessionFrom.mockImplementation(() => queryStub([]))
  })

  it('resolves the user and never queries on the session client', async () => {
    const { loadCurrentUser } = await import('./check')
    const user = await loadCurrentUser()

    expect(user).not.toBeNull()
    expect(user?.employeeId).toBe('emp-1')

    // The session client is for establishing identity, and nothing else.
    expect(getUser).toHaveBeenCalledTimes(1)
    expect(
      sessionFrom.mock.calls.map((c) => c[0]),
      'loadCurrentUser queried these on the cookie-session client. They run as ' +
        '`authenticated` and break the moment least-privilege revokes them.',
    ).toEqual([])
  })

  it('reads employees and the permission catalogue on the service role', async () => {
    const { loadCurrentUser } = await import('./check')
    await loadCurrentUser()

    const tables = adminFrom.mock.calls.map((c) => c[0])
    expect(tables).toContain('employees')
    // Non-admin designation, so the catalogue is resolved via designation_permissions.
    expect(tables).toContain('designation_permissions')
  })

  it('carries the date of birth, which is deliberately ungranted to authenticated', async () => {
    // employees.date_of_birth is withheld by the least-privilege migration's
    // column grant, on purpose — it is PII and no employee needs another's.
    // The authz path still needs the signed-in user's own, which only works
    // because this read is on the service role.
    const { loadCurrentUser } = await import('./check')
    const user = await loadCurrentUser()
    expect(user?.dateOfBirth).toBe('1990-01-01')
  })
})
