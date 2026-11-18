import { describe, it, expect } from 'vitest'
import {
  departmentsByClient, clientsInDepartments, isDepartmentUnrestricted, scopeClientsByDepartment,
} from './department-clients'
import type { CurrentUser } from '@/lib/permissions/check'

const SOCIAL = 'cat-social', FLYERS = 'cat-flyers', PRINT = 'cat-print'
const serviceDepartment = new Map<string, string | null>([
  ['svc-poster', SOCIAL], ['svc-flyer', FLYERS], ['svc-brochure', PRINT], ['svc-loose', null],
])

describe('departmentsByClient', () => {
  it('derives from what the client buys, and an override wins outright', () => {
    const map = departmentsByClient(
      [{ id: 'catering' }, { id: 'supermarket' }, { id: 'filed', department_id: PRINT }, { id: 'new' }],
      [
        { client_id: 'catering', service_id: 'svc-poster' },
        { client_id: 'catering', service_id: 'svc-brochure' },
        { client_id: 'supermarket', service_id: 'svc-flyer' },
        { client_id: 'filed', service_id: 'svc-poster' },        // ignored: override says Print
        { client_id: 'new', service_id: 'svc-loose' },           // service with no department
      ],
      serviceDepartment,
    )
    expect(map.get('catering')?.sort()).toEqual([PRINT, SOCIAL].sort())
    expect(map.get('supermarket')).toEqual([FLYERS])
    expect(map.get('filed')).toEqual([PRINT])
    expect(map.get('new')).toEqual([])
  })
})

describe('clientsInDepartments', () => {
  const byClient = new Map<string, string[]>([
    ['catering', [SOCIAL, PRINT]], ['supermarket', [FLYERS]], ['new', []],
  ])

  it('keeps a client when any of its departments is one of the employee\'s', () => {
    expect([...clientsInDepartments(byClient, new Set([SOCIAL]))]).toEqual(['catering'])
    expect([...clientsInDepartments(byClient, new Set([FLYERS]))]).toEqual(['supermarket'])
  })

  it('never shows a client that is in no department to a restricted employee', () => {
    expect(clientsInDepartments(byClient, new Set([SOCIAL, PRINT, FLYERS])).has('new')).toBe(false)
  })
})

describe('isDepartmentUnrestricted', () => {
  const user = (o: Partial<CurrentUser>): CurrentUser => ({
    authId: 'a', employeeId: 'e', cqid: 'CQID005', name: '', email: '', designationId: 'd',
    designationName: null, isAdmin: false, isArchived: false, permissions: new Set(), dateOfBirth: null, ...o,
  })

  it('lets admins and view-all see everything', () => {
    expect(isDepartmentUnrestricted(user({ isAdmin: true }))).toBe(true)
    expect(isDepartmentUnrestricted(user({ permissions: new Set(['scope.view_all']) }))).toBe(true)
  })

  it('restricts everyone else, including whoever manages Prompt Studio', () => {
    expect(isDepartmentUnrestricted(user({ permissions: new Set(['prompt_studio.view', 'prompt_studio.manage']) }))).toBe(false)
  })
})

describe('scopeClientsByDepartment', () => {
  const rows = [{ id: 'catering' }, { id: 'supermarket' }]
  it('filters only when restricted', () => {
    expect(scopeClientsByDepartment(rows, { restricted: false, departmentIds: new Set(), clientIds: new Set() })).toBe(rows)
    expect(scopeClientsByDepartment(rows, { restricted: true, departmentIds: new Set([SOCIAL]), clientIds: new Set(['catering']) }))
      .toEqual([{ id: 'catering' }])
  })
})
