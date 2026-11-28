/**
 * Who sees which workspace. The rule that matters most: making a personal
 * workspace must never take "All Workspace" away from someone nobody has
 * assigned anywhere — with it gone their menu narrowed to the new workspace
 * and the only way back was deleting it.
 */
import { describe, expect, it } from 'vitest'
import { hasAssignment, visibleWorkspaces, type WorkspaceRow } from './visibility'

const ALL: WorkspaceRow = { id: 'all', is_system: true, owner_employee_id: null }
const SALES: WorkspaceRow = { id: 'sales', is_system: false, owner_employee_id: null }
const MINE: WorkspaceRow = { id: 'mine', is_system: false, owner_employee_id: 'emp-a' }
const THEIRS: WorkspaceRow = { id: 'theirs', is_system: false, owner_employee_id: 'emp-b' }
const ROWS = [ALL, SALES, MINE, THEIRS]

const members = (entries: Record<string, string[]>) => new Map(Object.entries(entries))
const ids = (rows: WorkspaceRow[]) => rows.map(r => r.id)

describe('visibleWorkspaces', () => {
  it('gives someone assigned nowhere the All Workspace view only', () => {
    expect(ids(visibleWorkspaces(ROWS, members({ theirs: ['emp-b'] }), 'emp-a', false))).toEqual(['all'])
  })

  it('keeps All Workspace beside a personal workspace they made themselves', () => {
    const m = members({ mine: ['emp-a'], theirs: ['emp-b'] })
    expect(ids(visibleWorkspaces(ROWS, m, 'emp-a', false))).toEqual(['all', 'mine'])
  })

  it('keeps an assigned employee in what they were assigned, plus their own', () => {
    const m = members({ sales: ['emp-a'], mine: ['emp-a'] })
    expect(ids(visibleWorkspaces(ROWS, m, 'emp-a', false))).toEqual(['sales', 'mine'])
  })

  it('still shows All Workspace to someone who was added to it by name', () => {
    const m = members({ all: ['emp-a'], sales: ['emp-a'] })
    expect(ids(visibleWorkspaces(ROWS, m, 'emp-a', false))).toEqual(['all', 'sales'])
  })

  it('shows managers every shared workspace and only their own personal one', () => {
    expect(ids(visibleWorkspaces(ROWS, members({}), 'emp-a', true))).toEqual(['all', 'sales', 'mine'])
  })

  it('never lists another employee’s personal workspace, even if a member row names them', () => {
    const m = members({ theirs: ['emp-a', 'emp-b'] })
    expect(ids(visibleWorkspaces(ROWS, m, 'emp-a', false))).toEqual(['all'])
  })
})

describe('hasAssignment', () => {
  it('does not count a personal workspace', () => {
    expect(hasAssignment([MINE])).toBe(false)
  })

  it('counts a shared one', () => {
    expect(hasAssignment([MINE, SALES])).toBe(true)
  })

  it('treats every workspace as shared before the owner column exists', () => {
    expect(hasAssignment([{ id: 'sales', is_system: false }])).toBe(true)
  })

  it('is false for no memberships', () => {
    expect(hasAssignment([])).toBe(false)
  })
})
