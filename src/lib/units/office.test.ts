import { describe, expect, it } from 'vitest'
import { groupPermissions, officeRoster, REACH_KEY, type CatalogPerm } from './office'

const perm = (key: string, order = 0): CatalogPerm => ({ id: key, module: key.split('.')[0], key, label: key, description: null, order })

describe('groupPermissions', () => {
  const catalog = [perm('payroll.view'), perm('tasks.view_all', 2), perm('tasks.view_own', 1), perm(REACH_KEY), perm('scope.by_service'), perm('weird_thing.do')]
  const groups = groupPermissions(catalog, new Set(['tasks.view_own', 'payroll.view']))

  it('keeps data reach out of the groups', () => {
    expect(groups.flatMap(g => g.perms.map(p => p.key))).not.toContain(REACH_KEY)
    expect(groups.map(g => g.module)).not.toContain('scope')
  })
  it('orders known areas first and counts what is on', () => {
    expect(groups.map(g => g.module)).toEqual(['tasks', 'payroll', 'weird_thing'])
    expect(groups[0]).toMatchObject({ label: 'Tasks', on: 1, sensitive: false })
    expect(groups[0].perms.map(p => p.key)).toEqual(['tasks.view_own', 'tasks.view_all'])
    expect(groups[1]).toMatchObject({ label: 'Payroll', on: 1, sensitive: true })
    expect(groups[2].label).toBe('Weird Thing')
  })
})

describe('officeRoster', () => {
  const roles = [{ id: 'r-bill', name: 'Billing', isAdmin: false }, { id: 'r-des', name: 'Designer', isAdmin: false }, { id: 'r-adm', name: 'Admin', isAdmin: true }]
  const emps = [
    { id: 'e1', cqid: 'CQID001', designationId: 'r-adm' },
    { id: 'e2', cqid: 'CQID002', designationId: 'r-bill' },
    { id: 'e3', cqid: 'CQID003', designationId: null },
    { id: 'e4', cqid: 'CQID004', designationId: 'r-des' },
    { id: 'e6', cqid: 'CQID006', designationId: 'r-des' },
  ]
  const unitsOf = new Map([['e4', ['u-social']]])

  it('puts the office team first and says who shares a role', () => {
    const r = officeRoster(emps, roles, new Set(['e2']), unitsOf)
    expect(r.map(p => p.cqid)).toEqual(['CQID002', 'CQID001', 'CQID003', 'CQID004', 'CQID006'])
    expect(r.find(p => p.cqid === 'CQID004')!.sharedWith).toEqual(['CQID006'])
    expect(r.find(p => p.cqid === 'CQID002')).toMatchObject({ office: true, sharedWith: [], roleName: 'Billing' })
  })
  it('flags people on no team who are not marked, but not the admin', () => {
    const r = officeRoster(emps, roles, new Set(['e2']), unitsOf)
    expect(r.filter(p => p.unplaced).map(p => p.cqid)).toEqual(['CQID003', 'CQID006'])
  })
  it('before the office list exists, anyone on no team counts as office', () => {
    const r = officeRoster(emps, roles, null, unitsOf)
    expect(r.filter(p => p.office).map(p => p.cqid)).toEqual(['CQID001', 'CQID002', 'CQID003', 'CQID006'])
  })
})
