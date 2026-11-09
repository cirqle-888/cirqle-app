import { describe, it, expect } from 'vitest'
import {
  NO_DEPARTMENT, serviceDepartmentMap, taskDepartmentId, matchesDepartments,
  departmentFilterOptions, departmentLabel, servicesInDepartment,
} from './work-departments'

const SOCIAL = 'dept-social'
const PRINT = 'dept-print'

const services = [
  { id: 'svc-reel', category_id: SOCIAL },
  { id: 'svc-post', category_id: SOCIAL },
  { id: 'svc-flyer', category_id: PRINT },
  { id: 'svc-loose', category_id: null },
]
const map = serviceDepartmentMap(services)
const departments = [{ id: SOCIAL, name: 'Social Media' }, { id: PRINT, name: 'Print' }]

describe('taskDepartmentId', () => {
  it("is the service's category", () => {
    expect(taskDepartmentId('svc-reel', map)).toBe(SOCIAL)
    expect(taskDepartmentId('svc-flyer', map)).toBe(PRINT)
  })

  it('is NO_DEPARTMENT for a service in no category', () => {
    expect(taskDepartmentId('svc-loose', map)).toBe(NO_DEPARTMENT)
  })

  it('is NO_DEPARTMENT for a task with no service at all', () => {
    expect(taskDepartmentId(null, map)).toBe(NO_DEPARTMENT)
    expect(taskDepartmentId(undefined, map)).toBe(NO_DEPARTMENT)
  })

  it('does not invent a department for an unknown service', () => {
    // An inactive service, or one outside a restricted viewer's scope.
    expect(taskDepartmentId('svc-gone', map)).toBe(NO_DEPARTMENT)
  })
})

describe('matchesDepartments', () => {
  it('matches everything when nothing is selected', () => {
    expect(matchesDepartments([], 'svc-reel', map)).toBe(true)
    expect(matchesDepartments([], null, map)).toBe(true)
  })

  it('keeps only the selected department', () => {
    expect(matchesDepartments([SOCIAL], 'svc-reel', map)).toBe(true)
    expect(matchesDepartments([SOCIAL], 'svc-flyer', map)).toBe(false)
  })

  it('ORs several selections', () => {
    expect(matchesDepartments([SOCIAL, PRINT], 'svc-flyer', map)).toBe(true)
  })

  it('reaches unclassified work through the sentinel', () => {
    expect(matchesDepartments([NO_DEPARTMENT], null, map)).toBe(true)
    expect(matchesDepartments([NO_DEPARTMENT], 'svc-loose', map)).toBe(true)
    expect(matchesDepartments([NO_DEPARTMENT], 'svc-reel', map)).toBe(false)
  })
})

describe('departmentFilterOptions', () => {
  it('keeps Settings order and appends the no-department row', () => {
    expect(departmentFilterOptions(departments)).toEqual([
      { value: SOCIAL, label: 'Social Media' },
      { value: PRINT, label: 'Print' },
      { value: NO_DEPARTMENT, label: 'No department' },
    ])
  })

  it('can drop the no-department row', () => {
    expect(departmentFilterOptions(departments, false)).toHaveLength(2)
  })
})

describe('departmentLabel', () => {
  it('names a department, the sentinel, and nothing else', () => {
    expect(departmentLabel(SOCIAL, departments)).toBe('Social Media')
    expect(departmentLabel(NO_DEPARTMENT, departments)).toBe('No department')
    expect(departmentLabel('dept-archived', departments)).toBe('')
  })
})

describe('servicesInDepartment', () => {
  it('lists the services inside a department', () => {
    expect(servicesInDepartment(SOCIAL, services)).toEqual(['svc-reel', 'svc-post'])
  })

  it('lists the uncategorised services for the sentinel', () => {
    expect(servicesInDepartment(NO_DEPARTMENT, services)).toEqual(['svc-loose'])
  })

  it('is empty for a department that sells nothing', () => {
    expect(servicesInDepartment('dept-empty', services)).toEqual([])
  })
})
