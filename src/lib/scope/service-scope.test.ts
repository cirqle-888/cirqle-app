import { describe, it, expect } from 'vitest'
import {
  resolveServiceScopeMode, isServiceRestricted, markUnconfiguredClients,
  scopeServiceList, scopeClientList, scopeRowsByService, scopeRowsByClient,
  committedServiceIds, toServiceScopePayload,
  type ServiceScope, type ServiceScopeMode,
} from './service-scope'
import { PERMS } from '@/lib/permissions/keys'
import type { CurrentUser } from '@/lib/permissions/check'

// ── helpers ──────────────────────────────────────────────────────────────────

function user(perms: string[] = [], over: Partial<CurrentUser> = {}): CurrentUser {
  return {
    authId: 'a1', employeeId: 'e1', cqid: 'CQ1', name: 'Test', email: 't@x.com',
    designationId: 'd1', designationName: 'Designer', isAdmin: false, isArchived: false,
    permissions: new Set(perms), dateOfBirth: null, ...over,
  } as CurrentUser
}

function scope(over: Partial<ServiceScope> = {}): ServiceScope {
  return {
    mode: 'legacy', employeeId: 'e1',
    serviceIds: new Set(), clientServices: new Map(),
    visibleClientIds: new Set(), unconfiguredClientIds: new Set(),
    clientNarrowingEnabled: true, ...over,
  }
}

/** Restricted viewer: assigned to s1; c1 buys s1, c2 buys only s2. */
function restricted(): ServiceScope {
  return scope({
    mode: 'services',
    serviceIds: new Set(['s1']),
    clientServices: new Map([
      ['c1', new Set(['s1', 's2'])],
      ['c2', new Set(['s2'])],
    ]),
    visibleClientIds: new Set(['c1']),
  })
}

// ── mode resolution ──────────────────────────────────────────────────────────

describe('resolveServiceScopeMode', () => {
  const cases: [string, CurrentUser | null, ServiceScopeMode][] = [
    ['null user fails OPEN (auth hiccup must not restrict everyone)', null, 'all'],
    ['admin sees all', user([], { isAdmin: true }), 'all'],
    ['scope.view_all overrides the restriction', user([PERMS.SCOPE_VIEW_ALL, PERMS.SCOPE_BY_SERVICE]), 'all'],
    ['scope.by_service restricts', user([PERMS.SCOPE_BY_SERVICE]), 'services'],
    ['neither key = legacy passthrough', user([]), 'legacy'],
    ['unrelated perms do not restrict', user(['tasks.create', 'billing.view_invoices']), 'legacy'],
  ]
  it.each(cases)('%s', (_label, me, expected) => {
    expect(resolveServiceScopeMode(me)).toBe(expected)
  })

  it('honours the legacy tasks keys only on the tasks module', () => {
    const byService = user([PERMS.TASKS_VIEW_BY_SERVICE])
    expect(resolveServiceScopeMode(byService, 'tasks')).toBe('services')
    expect(resolveServiceScopeMode(byService, 'global')).toBe('legacy')

    const viewAll = user([PERMS.TASKS_VIEW_ALL, PERMS.SCOPE_BY_SERVICE])
    expect(resolveServiceScopeMode(viewAll, 'tasks')).toBe('all')
    expect(resolveServiceScopeMode(viewAll, 'global')).toBe('services')
  })
})

// ── the opt-in guarantee ─────────────────────────────────────────────────────

describe('legacy mode is a byte-identical passthrough', () => {
  const services = [{ id: 's1' }, { id: 's2' }, { id: 's3' }]
  const clients = [{ id: 'c1' }, { id: 'c2' }]
  const rows = [{ id: 't1', service_id: 's9', client_id: 'c9' }]

  for (const mode of ['legacy', 'all'] as ServiceScopeMode[]) {
    it(`${mode}: returns the SAME array reference, not a copy`, () => {
      const s = scope({ mode, serviceIds: new Set(['s1']) })
      expect(scopeServiceList(services, s)).toBe(services)
      expect(scopeClientList(clients, s)).toBe(clients)
      expect(scopeRowsByService(rows, s, r => r.service_id)).toBe(rows)
      expect(scopeRowsByClient(rows, s, r => r.client_id)).toBe(rows)
    })
  }

  it('restricted-but-unassigned also passes through (never lock anyone out)', () => {
    const s = scope({ mode: 'services', serviceIds: new Set() })
    expect(isServiceRestricted(s)).toBe(false)
    expect(scopeServiceList(services, s)).toBe(services)
    expect(scopeClientList(clients, s)).toBe(clients)
  })
})

// ── feature A: employee scoping ──────────────────────────────────────────────

describe('scopeServiceList', () => {
  it('keeps only assigned services', () => {
    expect(scopeServiceList([{ id: 's1' }, { id: 's2' }], restricted()).map(s => s.id)).toEqual(['s1'])
  })
})

describe('scopeClientList', () => {
  it('keeps clients buying an assigned service, hides the rest', () => {
    expect(scopeClientList([{ id: 'c1' }, { id: 'c2' }], restricted()).map(c => c.id)).toEqual(['c1'])
  })

  it('keeps UNCONFIGURED clients visible (not set up ≠ buys nothing)', () => {
    const s = markUnconfiguredClients(restricted(), ['c1', 'c2', 'c3'])
    expect(s.unconfiguredClientIds.has('c3')).toBe(true)
    expect(scopeClientList([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], s).map(c => c.id))
      .toEqual(['c1', 'c3'])
  })
})

describe('scopeRowsByService / scopeRowsByClient', () => {
  const rows = [
    { id: 't1', service_id: 's1', client_id: 'c1' },   // assigned service
    { id: 't2', service_id: 's2', client_id: 'c2' },   // not assigned
    { id: 't3', service_id: null, client_id: null },   // unclassified / internal
  ]

  it('keeps assigned services and always keeps unclassified rows', () => {
    expect(scopeRowsByService(rows, restricted(), r => r.service_id).map(r => r.id))
      .toEqual(['t1', 't3'])
  })

  it('keeps rows the viewer personally worked on', () => {
    const out = scopeRowsByService(rows, restricted(), r => r.service_id, {
      ids: ['t2'], id: r => r.id,
    })
    expect(out.map(r => r.id)).toEqual(['t1', 't2', 't3'])
  })

  it('client scoping keeps internal (null client) work', () => {
    expect(scopeRowsByClient(rows, restricted(), r => r.client_id).map(r => r.id))
      .toEqual(['t1', 't3'])
  })
})

// ── feature B: client commitment ─────────────────────────────────────────────

describe('committedServiceIds — null vs empty set', () => {
  it('returns the committed set for a configured client', () => {
    expect([...(committedServiceIds('c1', restricted()) ?? [])]).toEqual(['s1', 's2'])
  })

  it('returns NULL (do not narrow) when no client is selected', () => {
    expect(committedServiceIds(null, restricted())).toBeNull()
    expect(committedServiceIds(undefined, restricted())).toBeNull()
  })

  it('returns NULL for an unconfigured client — never an empty set', () => {
    expect(committedServiceIds('c-unknown', restricted())).toBeNull()
  })

  it('returns NULL for a client whose commitment set is empty', () => {
    const s = scope({ clientServices: new Map([['c9', new Set<string>()]]) })
    expect(committedServiceIds('c9', s)).toBeNull()
  })

  it('returns NULL when the kill switch is off', () => {
    const s = restricted(); s.clientNarrowingEnabled = false
    expect(committedServiceIds('c1', s)).toBeNull()
  })
})

// ── RSC payload ──────────────────────────────────────────────────────────────

describe('toServiceScopePayload', () => {
  it('serialises sets to arrays and reports the restricted flag', () => {
    const p = toServiceScopePayload(restricted())
    expect(p).toEqual({
      mode: 'services',
      restricted: true,
      serviceIds: ['s1'],
      clientServices: { c1: ['s1', 's2'], c2: ['s2'] },
      clientNarrowingEnabled: true,
    })
  })

  it('reports restricted=false when the viewer has no assignments', () => {
    const p = toServiceScopePayload(scope({ mode: 'services' }))
    expect(p.restricted).toBe(false)
  })
})
