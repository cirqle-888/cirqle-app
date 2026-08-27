import { describe, it, expect } from 'vitest'
import { scopeEmployeeList, stripEmployeeNames } from './employee-scope'

const ROWS = [
  { id: 'a', cqid: 'CQID001', name: 'Farooq' },
  { id: 'b', cqid: 'CQID003', name: 'Safoora' },
  { id: 'c', cqid: 'CQID004', name: 'Ajid' },
]

describe('scopeEmployeeList', () => {
  it('null means no restriction — everyone stays', () => {
    // The fail-open contract. A caller that mistook null for "nobody" would
    // leave an admin looking at an empty org, so this is asserted explicitly.
    expect(scopeEmployeeList(ROWS, null)).toHaveLength(3)
  })

  it('narrows to the visible set', () => {
    const out = scopeEmployeeList(ROWS, new Set(['a', 'c']))
    expect(out.map(r => r.cqid)).toEqual(['CQID001', 'CQID004'])
  })

  it('drops a colleague who shares no services', () => {
    // The reported case: CQID004 (Social Media) must not see CQID003 (Offer
    // Flyers), and the reverse.
    const seenByAjid = scopeEmployeeList(ROWS, new Set(['c', 'a']))
    expect(seenByAjid.some(r => r.cqid === 'CQID003')).toBe(false)
    const seenBySafoora = scopeEmployeeList(ROWS, new Set(['b', 'a']))
    expect(seenBySafoora.some(r => r.cqid === 'CQID004')).toBe(false)
  })

  it('never removes rows the set does contain', () => {
    expect(scopeEmployeeList(ROWS, new Set(['a', 'b', 'c']))).toHaveLength(3)
  })

  it('an empty set hides everyone — callers must pass null, not empty, to mean "all"', () => {
    expect(scopeEmployeeList(ROWS, new Set())).toHaveLength(0)
  })
})

describe('stripEmployeeNames', () => {
  it('removes names when the viewer cannot reveal them', () => {
    const out = stripEmployeeNames(ROWS, false)
    expect(out.every(r => r.name === null)).toBe(true)
    // CQID must survive — it is what the UI actually renders.
    expect(out.map(r => r.cqid)).toEqual(['CQID001', 'CQID003', 'CQID004'])
  })

  it('keeps names for someone who may reveal them', () => {
    expect(stripEmployeeNames(ROWS, true).map(r => r.name)).toEqual(['Farooq', 'Safoora', 'Ajid'])
  })

  it('does not mutate the input', () => {
    const rows = [{ id: 'a', cqid: 'CQID001', name: 'Farooq' }]
    stripEmployeeNames(rows, false)
    expect(rows[0].name).toBe('Farooq')
  })
})
