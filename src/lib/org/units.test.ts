import { describe, it, expect } from 'vitest'
import { descendantUnitIds, resolveScope, matchesScope, type OrgUnit, type OrgUnitScopeRow } from './units'

const unit = (id: string, parentId: string | null = null): OrgUnit =>
  ({ id, name: id, type: 'team', parentId, isActive: true })

// region → branch → team, plus an unrelated branch
const UNITS: OrgUnit[] = [
  unit('region-south'),
  unit('branch-kochi', 'region-south'),
  unit('team-design', 'branch-kochi'),
  unit('branch-blr', 'region-south'),
  unit('standalone'),
]

const scope = (unitId: string, o: Partial<OrgUnitScopeRow> = {}): OrgUnitScopeRow =>
  ({ unitId, clientId: null, serviceCategoryId: null, serviceId: null, ...o })

describe('descendantUnitIds', () => {
  it('includes the root and everything beneath it', () => {
    expect([...descendantUnitIds(UNITS, 'region-south')].sort())
      .toEqual(['branch-blr', 'branch-kochi', 'region-south', 'team-design'])
  })

  it('a leaf resolves to just itself', () => {
    expect([...descendantUnitIds(UNITS, 'team-design')]).toEqual(['team-design'])
  })

  it('does not hang on a parent cycle', () => {
    // The DB blocks self-parenting but not longer loops; an infinite loop
    // inside a payroll computation is the worst possible failure mode.
    const cyclic = [unit('a', 'b'), unit('b', 'a')]
    expect([...descendantUnitIds(cyclic, 'a')].sort()).toEqual(['a', 'b'])
  })
})

describe('resolveScope — a unit inherits its children mappings', () => {
  const SCOPES = [
    scope('team-design', { serviceCategoryId: 'cat-design' }),
    scope('branch-kochi', { clientId: 'client-1' }),
    scope('branch-blr', { clientId: 'client-2' }),
    scope('standalone', { serviceId: 'svc-x' }),
  ]

  it('rolls a branch up to include its teams', () => {
    const s = resolveScope(UNITS, SCOPES, 'branch-kochi')
    expect([...s.clientIds]).toEqual(['client-1'])
    expect([...s.categoryIds]).toEqual(['cat-design'])   // inherited from team-design
    expect(s.hasAnyMapping).toBe(true)
  })

  it('rolls a region up to include every branch', () => {
    const s = resolveScope(UNITS, SCOPES, 'region-south')
    expect([...s.clientIds].sort()).toEqual(['client-1', 'client-2'])
    expect([...s.categoryIds]).toEqual(['cat-design'])
  })

  it('excludes unrelated units', () => {
    const s = resolveScope(UNITS, SCOPES, 'region-south')
    expect(s.serviceIds.has('svc-x')).toBe(false)
  })

  it('reports an unmapped unit as having no mapping', () => {
    const s = resolveScope(UNITS, [], 'branch-kochi')
    expect(s.hasAnyMapping).toBe(false)
  })
})

describe('matchesScope', () => {
  const s = resolveScope(
    UNITS,
    [scope('branch-kochi', { clientId: 'client-1' }), scope('team-design', { serviceCategoryId: 'cat-design' })],
    'branch-kochi',
  )

  it('matches on client', () => {
    expect(matchesScope(s, { clientId: 'client-1', serviceId: 'any', serviceCategoryId: 'other' })).toBe(true)
  })

  it('matches on category — axes are OR-ed, so a branch can own both clients and a discipline', () => {
    expect(matchesScope(s, { clientId: 'client-99', serviceId: null, serviceCategoryId: 'cat-design' })).toBe(true)
  })

  it('rejects revenue the unit does not own', () => {
    expect(matchesScope(s, { clientId: 'client-99', serviceId: 'svc-z', serviceCategoryId: 'cat-video' })).toBe(false)
  })

  it('FAILS CLOSED on an unmapped unit — owns nothing, not everything', () => {
    // The opposite default would silently pay a half-configured branch's
    // manager a percentage of the entire company.
    const empty = resolveScope(UNITS, [], 'branch-kochi')
    expect(matchesScope(empty, { clientId: 'client-1', serviceId: 'svc', serviceCategoryId: 'cat' })).toBe(false)
  })

  it('tolerates a task with null dimensions (internal work)', () => {
    expect(matchesScope(s, { clientId: null, serviceId: null, serviceCategoryId: null })).toBe(false)
  })
})
