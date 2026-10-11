import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), signOut: vi.fn() }))
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: mocks.getUser, signOut: mocks.signOut }, from: mocks.from }),
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
