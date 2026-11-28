import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  blockedByUnitLine, canChat, canSeeDepartmentChannel, crossesUnitLine, reachable,
  type ChatAccessContext, type ChatAccessRule,
} from './access'

/**
 * Business-unit lines in chat: s1, s2 are on Social Media's team; f1 on
 * Cirqle Flyers'; office is staff on no unit; boss is an admin.
 */
const SOCIAL = 'u-social', FLYERS = 'u-flyers'
const DEPT_SM = 'cat-social', DEPT_FLY = 'cat-flyer'

const person = (id: string, mode: ChatAccessRule['mode'], employeeIds: string[] = [], departmentIds: string[] = []): ChatAccessRule =>
  ({ subjectType: 'employee', subjectId: id, mode, departmentIds, employeeIds })
const dept = (id: string, mode: ChatAccessRule['mode'], departmentIds: string[] = []): ChatAccessRule =>
  ({ subjectType: 'department', subjectId: id, mode, departmentIds, employeeIds: [] })

const ctx = (rules: ChatAccessRule[] = []): ChatAccessContext => ({
  rules,
  departmentsByEmployee: new Map([
    ['s1', new Set([DEPT_SM])], ['s2', new Set([DEPT_SM])], ['f1', new Set([DEPT_FLY])],
    ['office', new Set([DEPT_SM, DEPT_FLY])], ['boss', new Set<string>()],
  ]),
  adminIds: new Set(['boss']),
  defaultVisible: () => null,
  unitsByEmployee: new Map([['s1', new Set([SOCIAL])], ['s2', new Set([SOCIAL])], ['f1', new Set([FLYERS])]]),
  unitDepartmentsByEmployee: new Map([['s1', new Set([DEPT_SM])], ['s2', new Set([DEPT_SM])], ['f1', new Set([DEPT_FLY])]]),
})

describe('direct chats across unit lines', () => {
  it('a unit team chats among itself', () => {
    expect(canChat(ctx(), 's1', 's2')).toBe(true)
  })
  it('two units cannot chat, either way', () => {
    expect(canChat(ctx(), 's1', 'f1')).toBe(false)
    expect(canChat(ctx(), 'f1', 's1')).toBe(false)
  })
  it('a unit member and someone on no unit cannot chat, either way', () => {
    expect(canChat(ctx(), 's1', 'office')).toBe(false)
    expect(canChat(ctx(), 'office', 's1')).toBe(false)
  })
  it('admins are always reachable', () => {
    expect(canChat(ctx(), 's1', 'boss')).toBe(true)
    expect(canChat(ctx(), 'boss', 'f1')).toBe(true)
  })
  it('a person rule of "Everyone" crosses the line', () => {
    expect(canChat(ctx([person('office', 'everyone')]), 's1', 'office')).toBe(true)
  })
  it('a person rule naming someone crosses the line for that pair only', () => {
    const c = ctx([person('office', 'custom', ['s1'])])
    expect(canChat(c, 's1', 'office')).toBe(true)
    expect(crossesUnitLine(c, 's2', 'office')).toBe(true)
  })
  it('a department rule never crosses the line', () => {
    expect(canChat(ctx([dept(DEPT_SM, 'everyone')]), 's1', 'f1')).toBe(false)
  })
  it('people on no unit are not affected', () => {
    const c: ChatAccessContext = { ...ctx(), departmentsByEmployee: new Map([['o1', new Set()], ['o2', new Set()]]) }
    expect(canChat(c, 'o1', 'o2')).toBe(true)
  })
  it('the people picker shows a unit member only their unit and admins', () => {
    const people = ['s1', 's2', 'f1', 'office', 'boss'].map(id => ({ id }))
    expect(reachable(ctx(), 's1', people).map(p => p.id)).toEqual(['s2', 'boss'])
  })
})

describe('group chats and channels across unit lines', () => {
  const group = (memberIds: string[], extra: Partial<{ departmentId: string | null; posting: 'all' | 'admins' }> = {}) =>
    ({ departmentId: null, posting: 'all' as const, memberIds, ...extra })

  it('a group with only the unit and admins stays open', () => {
    expect(blockedByUnitLine(ctx(), 's1', group(['s1', 's2', 'boss']))).toBe(false)
  })
  it('a group with anyone across the line is closed to the unit member', () => {
    expect(blockedByUnitLine(ctx(), 's1', group(['s1', 's2', 'office']))).toBe(true)
    expect(blockedByUnitLine(ctx(), 's1', group(['s1', 'f1']))).toBe(true)
  })
  it('…but not to the people on no unit', () => {
    expect(blockedByUnitLine(ctx(), 'office', group(['s1', 'office']))).toBe(false)
  })
  it('announcement channels (admins post) are never closed', () => {
    expect(blockedByUnitLine(ctx(), 's1', group(['s1', 'f1', 'office'], { posting: 'admins' }))).toBe(false)
  })
  it('a department channel is open only for the unit\'s own departments', () => {
    expect(blockedByUnitLine(ctx(), 's1', group(['s1', 'office'], { departmentId: DEPT_SM }))).toBe(false)
    expect(blockedByUnitLine(ctx(), 's1', group(['s1'], { departmentId: DEPT_FLY }))).toBe(true)
    expect(canSeeDepartmentChannel(ctx(), 's1', DEPT_FLY)).toBe(false)
    expect(canSeeDepartmentChannel(ctx(), 's1', DEPT_SM)).toBe(true)
  })
  it('a person rule of "Everyone" opens the group', () => {
    expect(blockedByUnitLine(ctx([person('office', 'everyone')]), 's1', group(['s1', 'office']))).toBe(false)
  })
})

describe('the database applies the same line', () => {
  const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261128100000_chat_unit_lines.sql'), 'utf8')
  it('every chat policy goes through the unit line', () => {
    expect(sql).toMatch(/FUNCTION public\.is_conversation_member[\s\S]*NOT public\.chat_unit_blocked\(conv_id, public\.current_employee_id\(\)\)/)
  })
  it('with the same exceptions as the app', () => {
    expect(sql).toContain("(SELECT posting FROM conv) = 'admins' THEN FALSE")                  // announcements
    expect(sql).toContain('= ANY (my_units.category_ids)')                                     // department channels
    expect(sql).toContain("COALESCE(od.is_admin, FALSE) = FALSE")                             // admins never block
    expect(sql).toContain("r.subject_type = 'employee'")                                        // person rules only
    expect(sql).toContain("r.mode = 'everyone' OR emp_id = ANY (r.employee_ids)")              // …"Everyone" or named
  })
})

describe('the office team works with every unit', () => {
  const withOffice = (): ChatAccessContext => ({ ...ctx(), officeIds: new Set(['office']) })
  it('a unit member and the office team can chat, either way', () => {
    expect(canChat(withOffice(), 's1', 'office')).toBe(true)
    expect(canChat(withOffice(), 'office', 'f1')).toBe(true)
    expect(crossesUnitLine(withOffice(), 'f1', 'office')).toBe(false)
  })
  it('…but two units still cannot', () => {
    expect(canChat(withOffice(), 's1', 'f1')).toBe(false)
  })
  it('a group with the unit and the office team stays open; add another unit and it closes', () => {
    expect(blockedByUnitLine(withOffice(), 's1', { departmentId: null, posting: 'all', memberIds: ['s1', 's2', 'office'] })).toBe(false)
    expect(blockedByUnitLine(withOffice(), 's1', { departmentId: null, posting: 'all', memberIds: ['s1', 'office', 'f1'] })).toBe(true)
  })
  it('the database agrees', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261128190000_chat_office_team.sql'), 'utf8')
    expect(sql).toContain('FROM public.business_unit_office_staff os WHERE os.employee_id = cm.employee_id')
    expect(sql).toContain("COALESCE(od.is_admin, FALSE) = FALSE")
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.chat_unit_blocked\(uuid, uuid\) TO authenticated/)
  })
})
