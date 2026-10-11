import { describe, it, expect } from 'vitest'
import {
  NO_DEPARTMENT, filterByDepartments, departmentFilterOptions, selectedDepartmentLabels,
  clientDepartmentIds, departmentOverrideDiffers,
} from './department-filter'

const clients = [
  { id: 'a' }, // social
  { id: 'b' }, // social + print
  { id: 'c' }, // print
  { id: 'd' }, // nothing
]
const deps: Record<string, string[]> = {
  a: ['social'],
  b: ['social', 'print'],
  c: ['print'],
  // d deliberately absent, not an empty array — a client with no services
  // never gets a key.
}

const ids = (rows: { id: string }[]) => rows.map(r => r.id)

describe('filterByDepartments', () => {
  it('is not a filter when nothing is selected', () => {
    expect(ids(filterByDepartments(clients, [], deps))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('keeps every client in the chosen department', () => {
    expect(ids(filterByDepartments(clients, ['social'], deps))).toEqual(['a', 'b'])
  })

  it('matches ANY of several, not all', () => {
    // A client buying from both is still a Social Media client.
    expect(ids(filterByDepartments(clients, ['social', 'print'], deps))).toEqual(['a', 'b', 'c'])
  })

  it('reaches the clients that buy from no department at all', () => {
    expect(ids(filterByDepartments(clients, [NO_DEPARTMENT], deps))).toEqual(['d'])
  })

  it('combines "no department" with a real one', () => {
    expect(ids(filterByDepartments(clients, ['print', NO_DEPARTMENT], deps))).toEqual(['b', 'c', 'd'])
  })

  it('treats an explicit empty list the same as a missing key', () => {
    expect(ids(filterByDepartments(clients, [NO_DEPARTMENT], { ...deps, d: [] }))).toEqual(['d'])
  })

  it('returns nothing for a department nobody buys from', () => {
    expect(filterByDepartments(clients, ['video'], deps)).toEqual([])
  })

  it('does not mutate the input', () => {
    const input = [...clients]
    filterByDepartments(input, ['social'], deps)
    expect(input).toHaveLength(4)
  })
})

describe('departmentFilterOptions', () => {
  it('keeps the order Settings displays, with "No department" last', () => {
    const opts = departmentFilterOptions([
      { id: 'social', name: 'Social Media' },
      { id: 'print', name: 'Print' },
    ])
    expect(opts.map(o => o.label)).toEqual(['Social Media', 'Print', 'No department'])
    expect(opts[2].value).toBe(NO_DEPARTMENT)
  })

  it('still offers "No department" when there are no departments', () => {
    expect(departmentFilterOptions([]).map(o => o.value)).toEqual([NO_DEPARTMENT])
  })
})

describe('selectedDepartmentLabels', () => {
  const departments = [{ id: 'social', name: 'Social Media' }]

  it('names each selected department', () => {
    expect(selectedDepartmentLabels(['social', NO_DEPARTMENT], departments))
      .toEqual([
        { value: 'social', label: 'Social Media' },
        { value: NO_DEPARTMENT, label: 'No department' },
      ])
  })

  it('drops a department that no longer exists rather than showing a blank chip', () => {
    expect(selectedDepartmentLabels(['archived-one'], departments)).toEqual([])
  })
})


describe('clientDepartmentIds — the override', () => {
  const derived = { a: ['social', 'print'] }

  it('derives when no override is set, which is every existing client', () => {
    expect(clientDepartmentIds({ id: 'a' }, derived)).toEqual(['social', 'print'])
    expect(clientDepartmentIds({ id: 'a', department_id: null }, derived)).toEqual(['social', 'print'])
  })

  it('is the override when one is set — not the union', () => {
    // A client filed under Branding is in Branding, full stop. "And also"
    // would make the override unable to narrow anything.
    expect(clientDepartmentIds({ id: 'a', department_id: 'branding' }, derived)).toEqual(['branding'])
  })

  it('gives a department to a client that buys nothing yet', () => {
    // The whole point: a brand-new client derives to nothing and would sit
    // under "No department" forever.
    expect(clientDepartmentIds({ id: 'new', department_id: 'social' }, derived)).toEqual(['social'])
    expect(clientDepartmentIds({ id: 'new' }, derived)).toEqual([])
  })
})

describe('departmentOverrideDiffers', () => {
  it('is quiet when there is no override', () => {
    expect(departmentOverrideDiffers({ id: 'a' }, { a: ['social'] })).toBe(false)
  })

  it('is quiet when the override only states what the services already say', () => {
    expect(departmentOverrideDiffers({ id: 'a', department_id: 'social' }, { a: ['social'] })).toBe(false)
  })

  it('is quiet for a client with no services to disagree with', () => {
    expect(departmentOverrideDiffers({ id: 'a', department_id: 'social' }, {})).toBe(false)
  })

  it('flags a client filed away from what it buys', () => {
    expect(departmentOverrideDiffers({ id: 'a', department_id: 'social' }, { a: ['print'] })).toBe(true)
  })

  it('flags a client whose services spill past the override', () => {
    expect(departmentOverrideDiffers({ id: 'a', department_id: 'social' }, { a: ['social', 'print'] })).toBe(true)
  })
})

describe('filterByDepartments with overrides', () => {
  const clientsWithOverride = [
    { id: 'a' },                                 // derives: social
    { id: 'b', department_id: 'print' },         // derives social, filed print
    { id: 'c', department_id: 'social' },        // buys nothing, filed social
  ]
  const derived: Record<string, string[]> = { a: ['social'], b: ['social'] }

  it('filters on the override, not on what the client buys', () => {
    expect(ids(filterByDepartments(clientsWithOverride, ['social'], derived))).toEqual(['a', 'c'])
    expect(ids(filterByDepartments(clientsWithOverride, ['print'], derived))).toEqual(['b'])
  })

  it('stops an overridden client counting as "no department"', () => {
    expect(ids(filterByDepartments(clientsWithOverride, [NO_DEPARTMENT], derived))).toEqual([])
  })
})
