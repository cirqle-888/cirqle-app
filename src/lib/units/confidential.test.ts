import { describe, expect, it } from 'vitest'
import { confidentialRows, isConfidential, ownerCqidOf } from './confidential'
import type { DeptEntryRow } from './engine'

const dept = {
  members: [{ employeeId: 'e4', cqid: 'CQID004', role: 'member' as const }, { employeeId: 'e5', cqid: 'CQID005', role: 'member' as const }],
  partners: [{ employeeId: 'e1', cqid: 'CQID001', sharePct: 40 }, { employeeId: 'e4', cqid: 'CQID004', sharePct: 30 }, { employeeId: 'e5', cqid: 'CQID005', sharePct: 30 }],
}
const row = (over: Partial<DeptEntryRow>): DeptEntryRow => ({
  entryId: 'x', date: '2026-12-05', type: 'outflow', description: null, categoryName: 'Salary',
  amountInr: 1000, how: 'split', shareInr: 1000, general: false, employeeId: null, ...over,
})

describe('confidential staff costs in a unit\'s views', () => {
  it('shows them under the owner on the agreement', () => {
    expect(ownerCqidOf(dept)).toBe('CQID001')
    expect(ownerCqidOf({ members: [], partners: [] })).toBe('Cirqle')
  })
  it('the team\'s own pay stays visible; anyone else\'s is confidential', () => {
    expect(isConfidential(row({ employeeId: 'e4' }), dept)).toBe(false)
    expect(isConfidential(row({ employeeId: 'e2' }), dept)).toBe(true)
    expect(isConfidential(row({ description: 'Salary — CQID002 — November 2026' }), dept)).toBe(true)
    expect(isConfidential(row({ description: 'Salary — CQID005 — November 2026' }), dept)).toBe(false)
    expect(isConfidential(row({ description: 'Domain renewal' }), dept)).toBe(false)
  })
  it('folds every confidential entry of a month into one line, this unit\'s share only', () => {
    const out = confidentialRows([
      row({ entryId: 'a', employeeId: 'e2', description: 'Salary — CQID002', amountInr: 4352, shareInr: 461.31, date: '2026-12-07' }),
      row({ entryId: 'b', employeeId: 'e1', description: 'Salary — CQID001', amountInr: 1577, shareInr: 662.34, date: '2026-12-11' }),
      row({ entryId: 'c', employeeId: 'e4', description: 'Salary — CQID004', amountInr: 4965, shareInr: 4965, date: '2026-12-13' }),
    ], dept)
    expect(out).toHaveLength(2)
    const staff = out.find(r => r.how === 'combined')!
    expect(staff.description).toBe('CQID001 — owner\'s team (staff pay and costs)')
    expect(staff.shareInr).toBe(1123.65)
    expect(staff.amountInr).toBe(1123.65)          // never the full salaries
    expect(JSON.stringify(out)).not.toContain('CQID002')
    expect(out.find(r => r.entryId === 'c')?.description).toBe('Salary — CQID004')
  })
  it('keeps General and direct costs apart, and months apart', () => {
    const out = confidentialRows([
      row({ employeeId: 'e2', shareInr: 100, general: true }),
      row({ employeeId: 'e2', shareInr: 50, general: false }),
      row({ employeeId: 'e2', shareInr: 70, general: false, date: '2027-01-05' }),
    ], dept)
    expect(out.filter(r => r.how === 'combined')).toHaveLength(3)
  })
})
