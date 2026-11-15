import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), getClaims: vi.fn(), from: vi.fn(), signOut: vi.fn() }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: mocks.getUser, getClaims: mocks.getClaims, signOut: mocks.signOut }, from: mocks.from }),
}))
import { updateSession } from '@/lib/supabase/middleware'

function query(data: unknown) {
  const result = { data, error: null }
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => result,
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  }
  return chain
}

describe('dashboard route authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'signed-in-user' } } })
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: 'signed-in-user' } } })
    mocks.from.mockImplementation(() => query({ id: 'employee', is_archived: false, designation: null }))
  })

  it('denies a protected route to an employee without a designation', async () => {
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/payroll'))
    expect(response.headers.get('location')).toBe('https://cirqle.test/dashboard?denied=1')
  })

  it('keeps the home dashboard reachable without a designation', async () => {
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard'))
    expect(response.headers.get('location')).toBeNull()
  })

  it('allows an explicitly assigned admin', async () => {
    mocks.from.mockImplementation(() => query({ id: 'admin', is_archived: false, designation: { id: 'admin-role', is_admin: true } }))
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/payroll'))
    expect(response.headers.get('location')).toBeNull()
  })

  it('allows a non-admin with the required permission', async () => {
    mocks.from.mockImplementation(table => query(table === 'employees'
      ? { id: 'accounts', is_archived: false, designation: { id: 'accounts-role', is_admin: false } }
      : [{ permission: { key: 'payroll.view' } }]))
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/payroll'))
    expect(response.headers.get('location')).toBeNull()
  })
})

/**
 * A Server Action must never be answered with a cookie from the proxy.
 *
 * Next folds every cookie the proxy sets into the action's own cookie jar and
 * cannot tell that from the action calling `cookies().set()`, so it re-renders
 * the whole page into the action's response and tells the browser to drop its
 * router cache. The profile cookie lives 60 s and the presence heartbeat fires
 * every 60 s — so every open tab re-ran every query on its page once a minute
 * (720 KB on the dashboard, 2.7 MB on Contributions, measured 15 Nov 2026).
 */
describe('profile cache on Server Actions', () => {
  const PROFILE_COOKIE = 'cirqle.mw.profile'
  const action = (path: string) => new NextRequest(`https://cirqle.test${path}`, {
    method: 'POST',
    headers: { 'next-action': '605fbabf594bbc02a372f093937167c49d314dfbb5' },
  })
  const asUser = (id: string) => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: id } } })
    mocks.from.mockImplementation(() => query({ id: 'admin', is_archived: false, designation: { id: 'admin-role', is_admin: true } }))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-signing-secret'
  })

  it('a page request still gets the profile cookie', async () => {
    asUser('cookie-user')
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/payroll'))
    expect(response.cookies.get(PROFILE_COOKIE)?.value).toBeTruthy()
  })

  it('a Server Action is let through with no cookie set', async () => {
    asUser('action-user')
    const response = await updateSession(action('/dashboard/payroll'))
    expect(response.headers.get('location')).toBeNull()
    expect(response.cookies.get(PROFILE_COOKIE)).toBeUndefined()
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('the next Server Action is answered from memory, not the database', async () => {
    asUser('repeat-user')
    await updateSession(action('/dashboard'))
    const readsAfterFirst = mocks.from.mock.calls.length
    expect(readsAfterFirst).toBeGreaterThan(0)
    const response = await updateSession(action('/dashboard'))
    expect(mocks.from.mock.calls.length).toBe(readsAfterFirst)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('memory is per person: one user\'s profile never answers for another', async () => {
    asUser('first-user')
    await updateSession(action('/dashboard'))
    // A different person, with no designation, on the same server instance.
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: 'second-user' } } })
    mocks.from.mockImplementation(() => query({ id: 'employee', is_archived: false, designation: null }))
    const response = await updateSession(action('/dashboard/payroll'))
    expect(response.headers.get('location')).toBe('https://cirqle.test/dashboard?denied=1')
  })

  it('an action is still refused on a route its role cannot open', async () => {
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: 'no-role-user' } } })
    mocks.from.mockImplementation(() => query({ id: 'employee', is_archived: false, designation: null }))
    const response = await updateSession(action('/dashboard/payroll'))
    expect(response.headers.get('location')).toBe('https://cirqle.test/dashboard?denied=1')
  })
})
