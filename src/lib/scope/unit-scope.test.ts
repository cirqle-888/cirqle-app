import { describe, it, expect } from 'vitest'
import {
  resolveUnitScopeMode, unitSubtreeFor, buildUnitScope, isUnitScoped,
  scopeRowsByUnitMember, scopeTasksByUnit, unitTaskIdsFrom,
} from './unit-scope'
import { PERMS } from '@/lib/permissions/keys'
import type { CurrentUser } from '@/lib/permissions/check'
import type { OrgUnit, OrgUnitScopeRow, OrgMember } from '@/lib/org/units'

// ── helpers ──────────────────────────────────────────────────────────────────

function user(perms: string[] = [], over: Partial<CurrentUser> = {}): CurrentUser {
  return {
    authId: 'a1', employeeId: 'e1', cqid: 'CQ1', name: 'Test', email: 't@x.com',
    designationId: 'd1', designationName: 'Designer', isAdmin: false, isArchived: false,
    permissions: new Set(perms), dateOfBirth: null, ...over,
  } as CurrentUser
}

const unit = (id: string, parentId: string | null = null): OrgUnit =>
  ({ id, name: id, type: 'team', parentId, isActive: true })

// region-south → branch-kochi → team-design, plus an unrelated branch
const UNITS: OrgUnit[] = [
  unit('region-south'),
  unit('branch-kochi', 'region-south'),
  unit('team-design', 'branch-kochi'),
  unit('branch-blr', 'region-south'),
]

const member = (unitId: string, employeeId: string, isManager = false): OrgMember =>
  ({ unitId, employeeId, isManager, roleLabel: null })

const MEMBERS: OrgMember[] = [
  member('branch-kochi', 'e1', true),   // the viewer: manages Kochi
  member('team-design',  'e2'),         // beneath Kochi → visible
  member('branch-blr',   'e3'),         // sibling branch → NOT visible
]

interface Task { id: string; client_id: string | null; service_id: string | null }

const PICK = {
  id:        (t: Task) => t.id,
  clientId:  (t: Task) => t.client_id,
  serviceId: (t: Task) => t.service_id,
}

const mapping = (unitId: string, o: Partial<OrgUnitScopeRow> = {}): OrgUnitScopeRow =>
  ({ unitId, clientId: null, serviceCategoryId: null, serviceId: null, ...o })

const MAPPINGS: OrgUnitScopeRow[] = [
  mapping('branch-kochi', { clientId: 'c1' }),
  mapping('team-design',  { serviceId: 's-design' }),
  mapping('branch-blr',   { clientId: 'c9' }),
]

/** The viewer (e1) manages branch-kochi. */
const kochi = () => buildUnitScope('unit', 'e1', UNITS, MEMBERS, MAPPINGS)

// ── mode resolution ──────────────────────────────────────────────────────────

describe('resolveUnitScopeMode', () => {
  const cases: [string, CurrentUser | null, ReturnType<typeof resolveUnitScopeMode>][] = [
    ['no user fails open',           null,                                'all'],
    ['admin sees everything',        user([], { isAdmin: true }),         'all'],
    ['scope.view_all overrides',     user([PERMS.SCOPE_VIEW_ALL, PERMS.SCOPE_BY_UNIT]), 'all'],
    ['scope.by_unit scopes',         user([PERMS.SCOPE_BY_UNIT]),         'unit'],
    ['neither key = legacy',         user([]),                            'legacy'],
    ['unrelated perms do not scope', user(['tasks.create']),              'legacy'],
  ]
  it.each(cases)('%s', (_label, me, expected) => {
    expect(resolveUnitScopeMode(me)).toBe(expected)
  })

  it('module keys apply only to their own module', () => {
    const tasks = user([PERMS.TASKS_VIEW_BY_UNIT])
    expect(resolveUnitScopeMode(tasks, 'tasks')).toBe('unit')
    expect(resolveUnitScopeMode(tasks, 'contributions')).toBe('legacy')

    const contrib = user([PERMS.CONTRIBUTIONS_VIEW_UNIT])
    expect(resolveUnitScopeMode(contrib, 'contributions')).toBe('unit')
    expect(resolveUnitScopeMode(contrib, 'tasks')).toBe('legacy')
  })

  it('the module view_all key wins over the unit key', () => {
    const me = user([PERMS.CONTRIBUTIONS_VIEW_ALL, PERMS.CONTRIBUTIONS_VIEW_UNIT])
    expect(resolveUnitScopeMode(me, 'contributions')).toBe('all')
    // …but only on its own module: the global key is unaffected.
    expect(resolveUnitScopeMode(me, 'global')).toBe('legacy')
  })
})

// ── subtree + build ──────────────────────────────────────────────────────────

describe('unitSubtreeFor', () => {
  it('covers the unit and everything beneath it', () => {
    expect([...unitSubtreeFor(UNITS, MEMBERS, 'e1')].sort())
      .toEqual(['branch-kochi', 'team-design'])
  })

  it('a member of nothing gets an empty subtree', () => {
    expect([...unitSubtreeFor(UNITS, MEMBERS, 'nobody')]).toEqual([])
  })

  it('unions every unit the employee belongs to', () => {
    const both = [...MEMBERS, member('branch-blr', 'e1')]
    expect([...unitSubtreeFor(UNITS, both, 'e1')].sort())
      .toEqual(['branch-blr', 'branch-kochi', 'team-design'])
  })
})

describe('buildUnitScope', () => {
  it('collects members and revenue from the whole subtree', () => {
    const s = kochi()
    expect([...s.memberEmployeeIds].sort()).toEqual(['e1', 'e2'])   // not e3
    expect([...s.clientIds]).toEqual(['c1'])                        // not c9
    expect([...s.serviceIds]).toEqual(['s-design'])                 // inherited from the team
    expect(s.hasRevenueMapping).toBe(true)
  })

  it('always includes the viewer, even with no unit membership', () => {
    const s = buildUnitScope('unit', 'orphan', UNITS, MEMBERS, MAPPINGS)
    expect([...s.memberEmployeeIds]).toEqual(['orphan'])
    expect(s.hasRevenueMapping).toBe(false)
  })

  it('resolves to an inert scope in every non-unit mode', () => {
    for (const mode of ['all', 'legacy'] as const) {
      const s = buildUnitScope(mode, 'e1', UNITS, MEMBERS, MAPPINGS)
      expect(isUnitScoped(s)).toBe(false)
      expect(s.memberEmployeeIds.size).toBe(0)
    }
  })
})

// ── the opt-in guarantee ─────────────────────────────────────────────────────

describe('a non-unit scope is an identity passthrough', () => {
  const rows = [{ employee_id: 'e3' }, { employee_id: 'e9' }]
  const tasks = [{ id: 't1', client_id: 'c9', service_id: 's9' }]

  it.each(['all', 'legacy'] as const)('%s mode returns the input array', mode => {
    const s = buildUnitScope(mode, 'e1', UNITS, MEMBERS, MAPPINGS)
    expect(scopeRowsByUnitMember(rows, s, r => r.employee_id)).toBe(rows)
    expect(scopeTasksByUnit(tasks, s, PICK)).toBe(tasks)
  })
})

// ── people filter (contributions) ────────────────────────────────────────────

describe('scopeRowsByUnitMember', () => {
  it('keeps the unit subtree and drops everyone else', () => {
    const rows = [
      { employee_id: 'e1', v: 'self' },
      { employee_id: 'e2', v: 'team beneath me' },
      { employee_id: 'e3', v: 'sibling branch' },
    ]
    expect(scopeRowsByUnitMember(rows, kochi(), r => r.employee_id).map(r => r.v))
      .toEqual(['self', 'team beneath me'])
  })

  it('drops rows with no employee at all — an unowned row is not "mine"', () => {
    const rows = [{ employee_id: undefined }, { employee_id: 'e1' }]
    expect(scopeRowsByUnitMember(rows, kochi(), r => r.employee_id)).toHaveLength(1)
  })
})

// ── task filter ──────────────────────────────────────────────────────────────

describe('scopeTasksByUnit', () => {
  const TASKS: Task[] = [
    { id: 't-client',  client_id: 'c1', service_id: 's-other' },   // unit's client
    { id: 't-service', client_id: 'c9', service_id: 's-design' },  // unit's service
    { id: 't-worked',  client_id: 'c9', service_id: 's-other' },   // a unit-mate worked it
    { id: 't-foreign', client_id: 'c9', service_id: 's-other' },   // nothing to do with us
  ]

  it('matches on client OR service OR personal history', () => {
    const kept = scopeTasksByUnit(TASKS, kochi(), PICK, ['t-worked']).map(t => t.id)
    expect(kept).toEqual(['t-client', 't-service', 't-worked'])
  })

  it('fails OPEN when the unit maps no revenue', () => {
    // Granting the key before the org chart is mapped must not blank the board.
    const unmapped = buildUnitScope('unit', 'e1', UNITS, MEMBERS, [])
    expect(scopeTasksByUnit(TASKS, unmapped, PICK)).toBe(TASKS)
  })
})

describe('unitTaskIdsFrom', () => {
  it('collects task ids touched by anyone in the subtree', () => {
    const ids = unitTaskIdsFrom(kochi(), [
      [{ task_id: 't1', employee_id: 'e1' }, { task_id: 't2', employee_id: 'e3' }],
      [{ task_id: 't3', employee_id: 'e2' }, { task_id: null,  employee_id: 'e1' }],
    ])
    expect([...ids].sort()).toEqual(['t1', 't3'])
  })

  it('is empty for an unscoped viewer', () => {
    const s = buildUnitScope('all', 'e1', UNITS, MEMBERS, MAPPINGS)
    expect(unitTaskIdsFrom(s, [[{ task_id: 't1', employee_id: 'e1' }]]).size).toBe(0)
  })
})
