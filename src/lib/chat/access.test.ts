import { describe, it, expect } from 'vitest'
import { canChat, effectiveRule, reachable, canSeeDepartmentChannel, type ChatAccessContext, type ChatAccessRule } from './access'

const SM = 'social', PR = 'print', AD = 'ads'
const ctx = (rules: ChatAccessRule[], defaultVisible: ChatAccessContext['defaultVisible'] = () => null): ChatAccessContext => ({
  rules,
  departmentsByEmployee: new Map([
    ['s1', new Set([SM])], ['s2', new Set([SM])], ['p1', new Set([PR])], ['a1', new Set([AD])], ['boss', new Set<string>()],
  ]),
  adminIds: new Set(['boss']),
  defaultVisible,
})
const dept = (id: string, mode: ChatAccessRule['mode'], departmentIds: string[] = [], employeeIds: string[] = []): ChatAccessRule =>
  ({ subjectType: 'department', subjectId: id, mode, departmentIds, employeeIds })
const person = (id: string, mode: ChatAccessRule['mode'], departmentIds: string[] = [], employeeIds: string[] = []): ChatAccessRule =>
  ({ subjectType: 'employee', subjectId: id, mode, departmentIds, employeeIds })

describe('chat access', () => {
  it('keeps the old shared-work default when no rule is set', () => {
    const c = ctx([], v => (v === 's1' ? new Set(['s1', 's2']) : null))
    expect(canChat(c, 's1', 's2')).toBe(true)
    expect(canChat(c, 's1', 'p1')).toBe(false)
    expect(canChat(c, 'p1', 's1')).toBe(true) // p1 has no restriction; s1 has no explicit rule to refuse
  })

  it('own department only blocks other departments in both directions', () => {
    const c = ctx([dept(SM, 'own_department')])
    expect(canChat(c, 's1', 's2')).toBe(true)
    expect(canChat(c, 's1', 'p1')).toBe(false)
    expect(canChat(c, 'p1', 's1')).toBe(false) // Social Media's rule refuses the reverse too
  })

  it('custom adds chosen departments and people', () => {
    const c = ctx([dept(SM, 'custom', [PR], ['a1'])])
    expect(canChat(c, 's1', 'p1')).toBe(true)
    expect(canChat(c, 's1', 'a1')).toBe(true)
    expect(canChat(ctx([dept(SM, 'custom', [PR])]), 's1', 'a1')).toBe(false)
  })

  it('a person rule wins over the department rule', () => {
    const c = ctx([dept(SM, 'own_department'), person('s1', 'everyone')])
    expect(effectiveRule(c, 's1')?.source).toBe('employee')
    expect(canChat(c, 's1', 'a1')).toBe(true)
    expect(canChat(c, 's2', 'a1')).toBe(false)
  })

  it('none blocks every direct chat except with an admin', () => {
    const c = ctx([person('s1', 'none')])
    expect(canChat(c, 's1', 's2')).toBe(false)
    expect(canChat(c, 's2', 's1')).toBe(false)
    expect(canChat(c, 's1', 'boss')).toBe(true)
    expect(canChat(c, 'boss', 's1')).toBe(true)
  })

  it('merges several department rules to the most generous', () => {
    const c: ChatAccessContext = { ...ctx([dept(SM, 'own_department'), dept(PR, 'everyone')]),
      departmentsByEmployee: new Map([['x', new Set([SM, PR])], ['a1', new Set([AD])]]) }
    expect(effectiveRule(c, 'x')?.mode).toBe('everyone')
    expect(canChat(c, 'x', 'a1')).toBe(true)
  })

  it('lists only reachable people, never yourself', () => {
    const c = ctx([dept(SM, 'own_department')])
    expect(reachable(c, 's1', [{ id: 's1' }, { id: 's2' }, { id: 'p1' }, { id: 'boss' }]).map(p => p.id)).toEqual(['s2', 'boss'])
  })

  it('shows a department channel to that department and to admins', () => {
    const c = ctx([])
    expect(canSeeDepartmentChannel(c, 's1', SM)).toBe(true)
    expect(canSeeDepartmentChannel(c, 'p1', SM)).toBe(false)
    expect(canSeeDepartmentChannel(c, 'boss', SM)).toBe(true)
    expect(canSeeDepartmentChannel(c, 'p1', null)).toBe(true)
  })
})
