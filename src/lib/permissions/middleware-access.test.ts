import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), getClaims: vi.fn(), from: vi.fn(), signOut: vi.fn(), rpc: vi.fn() }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: mocks.getUser, getClaims: mocks.getClaims, signOut: mocks.signOut }, from: mocks.from, rpc: mocks.rpc }),
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
    mocks.rpc.mockResolvedValue({ data: false, error: null })
  })

  it('denies a protected route to an employee without a designation', async () => {
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/payroll'))
    expect(response.headers.get('location')).toBe('https://cirqle.test/dashboard?denied=1')
  })

  it('lets every employee open Workspaces, where they design their own', async () => {
    // "My workspaces" in the sidebar's workspace menu is offered to everyone;
    // the page scopes itself. The general Settings rule must not catch it.
    const own = await updateSession(new NextRequest('https://cirqle.test/dashboard/settings/workspaces'))
    expect(own.headers.get('location')).toBeNull()
    const settings = await updateSession(new NextRequest('https://cirqle.test/dashboard/settings'))
    expect(settings.headers.get('location')).toBe('https://cirqle.test/dashboard?denied=1')
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
    mocks.rpc.mockResolvedValue({ data: false, error: null })
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

/**
 * Business units (lib/units): a non-admin on a unit's team opens only the
 * unit-team pages. The check is the caller's own `my_unit_route_lock()`.
 */
describe('unit team page lock', () => {
  const asMember = (sub: string) => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: sub } } })
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub } } })
    mocks.from.mockImplementation(table => query(table === 'employees'
      ? { id: 'member', is_archived: false, designation: { id: 'designer', is_admin: false } }
      : [{ permission: { key: 'billing.view_invoices' } }, { permission: { key: 'requests.view' } }]))
  }
  beforeEach(() => { vi.clearAllMocks() })

  it('sends a unit member away from a page outside their unit, even with its permission', async () => {
    asMember('unit-member-1')
    mocks.rpc.mockResolvedValue({ data: true, error: null })
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/invoices'))
    expect(response.headers.get('location')).toBe('https://cirqle.test/dashboard/units?denied=1')
  })

  it('lands a unit member on their unit page instead of the company dashboard', async () => {
    asMember('unit-member-2')
    mocks.rpc.mockResolvedValue({ data: true, error: null })
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard'))
    expect(response.headers.get('location')).toBe('https://cirqle.test/dashboard/units')
  })

  it('lets a unit member open their unit pages', async () => {
    asMember('unit-member-3')
    mocks.rpc.mockResolvedValue({ data: true, error: null })
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/requests'))
    expect(response.headers.get('location')).toBeNull()
  })

  it('keeps unit staff to the staff pages', async () => {
    asMember('unit-staff-1')
    mocks.rpc.mockResolvedValue({ data: 'staff', error: null })
    const closed = await updateSession(new NextRequest('https://cirqle.test/dashboard/social-calendar'))
    expect(closed.headers.get('location')).toBe('https://cirqle.test/dashboard/units?denied=1')
    asMember('unit-staff-2')
    const open = await updateSession(new NextRequest('https://cirqle.test/dashboard/requests'))
    expect(open.headers.get('location')).toBeNull()
  })

  it('gives a unit lead or member the team pages', async () => {
    asMember('unit-team-1')
    mocks.rpc.mockResolvedValue({ data: 'team', error: null })
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/social-calendar'))
    expect(response.headers.get('location')).toBeNull()
  })

  it('leaves staff outside any unit as they were', async () => {
    asMember('office-staff')
    mocks.rpc.mockResolvedValue({ data: false, error: null })
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/invoices'))
    expect(response.headers.get('location')).toBeNull()
  })

  it('treats a database without the units migration as "no units yet"', async () => {
    asMember('before-migration')
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.my_unit_route_lock' } })
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/invoices'))
    expect(response.headers.get('location')).toBeNull()
  })

  it('fails closed when the membership check errors', async () => {
    asMember('check-failed')
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/requests'))
    expect(response.headers.get('location')).toContain('/login?error=profile')
  })

  it('never asks for an Admin', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'admin-x' } } })
    mocks.getClaims.mockResolvedValue({ data: { claims: { sub: 'admin-x' } } })
    mocks.from.mockImplementation(() => query({ id: 'admin', is_archived: false, designation: { id: 'admin-role', is_admin: true } }))
    const response = await updateSession(new NextRequest('https://cirqle.test/dashboard/invoices'))
    expect(response.headers.get('location')).toBeNull()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
