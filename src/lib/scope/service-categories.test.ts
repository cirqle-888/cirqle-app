/**
 * Category-level employee scoping.
 *
 * The contract under test:
 *     effective services = (services in my categories) ∪ (my direct services)
 *
 * resolved at READ time. The union itself is easy; what actually matters is the
 * three failure modes, because each one decides whether a restricted employee
 * is over-scoped (sees work that isn't theirs) or under-scoped (blank app):
 *
 *   direct read fails          → null → caller degrades to 'legacy' (fail OPEN)
 *   category table missing     → direct assignments still stand (pre-migration)
 *   category→services read fails, WITH categories held → null (fail OPEN)
 *
 * The third is the subtle one: the employee is known to hold category
 * assignments, so returning only their direct services would silently
 * under-scope them — the inverse of the fail-open intent everywhere else.
 */
import { describe, it, expect } from 'vitest'
import { loadServiceScope } from './service-scope'
import { PERMS } from '@/lib/permissions/keys'
import type { CurrentUser } from '@/lib/permissions/check'

function restrictedUser(): CurrentUser {
  return {
    authId: 'a1', employeeId: 'e1', cqid: 'CQ1', name: 'Test', email: 't@x.com',
    designationId: 'd1', designationName: 'Designer', isAdmin: false, isArchived: false,
    permissions: new Set([PERMS.SCOPE_BY_SERVICE]), dateOfBirth: null,
  } as unknown as CurrentUser
}

/**
 * Minimal stand-in for the service-role client, shaped to the exact call
 * sequences in loadServiceScope. Each table returns either rows or an error so
 * a test can fail one read in isolation.
 */
function fakeAdmin(tables: Record<string, { data?: any[]; error?: any; single?: any }>) {
  const res = (t: string) => tables[t] ?? { data: [] }
  const make = (t: string): any => {
    const out: any = {
      select: () => out,
      eq: () => out,
      in: () => out,
      range: () => out,
      maybeSingle: async () => ({ data: res(t).single ?? null, error: res(t).error ?? null }),
      then: (resolve: any) => resolve({ data: res(t).data ?? [], error: res(t).error ?? null }),
    }
    return out
  }
  return { from: (t: string) => make(t) } as any
}

const NO_COMMITMENTS = { client_service_pricing: { data: [] } }

describe('effective services = categories ∪ direct', () => {
  it('unions category-derived services with directly-assigned ones', async () => {
    const scope = await loadServiceScope(fakeAdmin({
      ...NO_COMMITMENTS,
      employee_services:           { data: [{ service_id: 'direct-1' }] },
      employee_service_categories: { data: [{ category_id: 'cat-A' }] },
      services:                    { data: [{ id: 'in-cat-1' }, { id: 'in-cat-2' }] },
    }), restrictedUser())

    expect(scope.mode).toBe('services')
    expect([...scope.serviceIds].sort()).toEqual(['direct-1', 'in-cat-1', 'in-cat-2'])
  })

  it('de-duplicates a service that is both in a category and ticked directly', async () => {
    const scope = await loadServiceScope(fakeAdmin({
      ...NO_COMMITMENTS,
      employee_services:           { data: [{ service_id: 'shared' }] },
      employee_service_categories: { data: [{ category_id: 'cat-A' }] },
      services:                    { data: [{ id: 'shared' }, { id: 'other' }] },
    }), restrictedUser())

    expect([...scope.serviceIds].sort()).toEqual(['other', 'shared'])
  })

  it('skips the category→services query entirely when no categories are held', async () => {
    // `services` is seeded with a row that must NOT appear: with no category
    // assignments there is nothing to expand, so the table is never consulted.
    const scope = await loadServiceScope(fakeAdmin({
      ...NO_COMMITMENTS,
      employee_services:           { data: [{ service_id: 'direct-1' }] },
      employee_service_categories: { data: [] },
      services:                    { data: [{ id: 'must-not-appear' }] },
    }), restrictedUser())

    expect([...scope.serviceIds]).toEqual(['direct-1'])
  })
})

describe('failure modes decide over- vs under-scoping', () => {
  it('sees nothing when the DIRECT assignment read fails', async () => {
    const scope = await loadServiceScope(fakeAdmin({
      ...NO_COMMITMENTS,
      employee_services:           { error: { message: 'boom' } },
      employee_service_categories: { data: [] },
    }), restrictedUser())

    // Fail CLOSED (2026-11-27): with reach defined explicitly, a read failure
    // may leave a restricted person with nothing, never with everything.
    expect(scope.mode).toBe('services')
    expect(scope.serviceIds.size).toBe(0)
  })

  it('keeps direct assignments working when the category table is missing', async () => {
    // Pre-migration environment: employee_service_categories does not exist.
    // That must not blank the user, and must not discard direct assignments.
    const scope = await loadServiceScope(fakeAdmin({
      ...NO_COMMITMENTS,
      employee_services:           { data: [{ service_id: 'direct-1' }] },
      employee_service_categories: { error: { message: 'relation does not exist' } },
    }), restrictedUser())

    expect(scope.mode).toBe('services')
    expect([...scope.serviceIds]).toEqual(['direct-1'])
  })

  it('sees nothing when expanding HELD categories fails', async () => {
    // The employee demonstrably holds category assignments; the read failed, so
    // they are shown nothing until it works again — never everything.
    const scope = await loadServiceScope(fakeAdmin({
      ...NO_COMMITMENTS,
      employee_services:           { data: [{ service_id: 'direct-1' }] },
      employee_service_categories: { data: [{ category_id: 'cat-A' }] },
      services:                    { error: { message: 'boom' } },
    }), restrictedUser())

    expect(scope.mode).toBe('services')
    expect(scope.serviceIds.size).toBe(0)
  })
})

describe('reach is explicit', () => {
  it('a viewer with no scope key sees only what is assigned to them', async () => {
    const plain = { ...restrictedUser(), permissions: new Set<string>() } as CurrentUser
    const scope = await loadServiceScope(fakeAdmin({
      ...NO_COMMITMENTS,
      employee_services:           { data: [{ service_id: 'direct-1' }] },
      employee_service_categories: { data: [{ category_id: 'cat-A' }] },
      services:                    { data: [{ id: 'cat-A-svc' }] },
    }), plain)

    expect(scope.mode).toBe('services')
    expect([...scope.serviceIds].sort()).toEqual(['cat-A-svc', 'direct-1'])
  })
})

describe('a client pinned to a department belongs there alone', () => {
  it('shows pinned clients only to that department, whatever they buy', async () => {
    const scope = await loadServiceScope(fakeAdmin({
      employee_services:           { data: [] },
      employee_service_categories: { data: [{ category_id: 'cat-A' }] },
      services:                    { data: [{ id: 's1', category_id: 'cat-A' }] },
      client_service_pricing:      { data: [
        { client_id: 'c1', service_id: 's1' },   // buys from A, not pinned → visible
        { client_id: 'c2', service_id: 's1' },   // buys from A but pinned to B → hidden
      ] },
      clients: { data: [
        { id: 'c1', department_id: null },
        { id: 'c2', department_id: 'cat-B' },
        { id: 'c3', department_id: 'cat-A' },     // buys nothing yet, pinned to A → visible
      ] },
    }), restrictedUser())

    expect([...scope.visibleClientIds].sort()).toEqual(['c1', 'c3'])
  })
})
