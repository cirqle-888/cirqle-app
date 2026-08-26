import { describe, it, expect } from 'vitest'
import {
  stageOf, canMove, isPending, isHidden, STAGE_TARGET_STATUS, WORK_STAGES,
  moveRefusalReason,
} from './my-work'

describe('stageOf', () => {
  it('collapses the inbox vocabulary into the four a designer thinks in', () => {
    for (const s of ['submitted', 'under_review', 'approved']) expect(stageOf(s)).toBe('todo')
    for (const s of ['started', 'in_progress', 'waiting_for_content', 'revision_requested']) {
      expect(stageOf(s)).toBe('working')
    }
    expect(stageOf('delivered')).toBe('delivered')
    expect(stageOf('completed')).toBe('done')
  })

  it('a revision coming back reads as working, not as still delivered', () => {
    expect(stageOf('revision_requested')).toBe('working')
  })

  it('never throws on an unknown status — it lands in To Do', () => {
    expect(stageOf('some_future_status')).toBe('todo')
  })
})

describe('canMove', () => {
  it('allows each forward step', () => {
    expect(canMove('todo', 'working')).toBe(true)
    expect(canMove('working', 'delivered')).toBe(true)
    expect(canMove('delivered', 'done')).toBe(true)
  })

  it('allows skipping ahead (finished before it was ever marked started)', () => {
    expect(canMove('todo', 'done')).toBe(true)
    expect(canMove('todo', 'delivered')).toBe(true)
  })

  it('allows Delivered → Working, because clients ask for changes', () => {
    expect(canMove('delivered', 'working')).toBe(true)
  })

  it('refuses every other backwards move', () => {
    expect(canMove('working', 'todo')).toBe(false)
    expect(canMove('delivered', 'todo')).toBe(false)
    expect(canMove('done', 'delivered')).toBe(false)
    expect(canMove('done', 'working')).toBe(false)
    expect(canMove('done', 'todo')).toBe(false)
  })

  it('refuses a no-op', () => {
    for (const s of WORK_STAGES) expect(canMove(s, s)).toBe(false)
  })

  it('never lets anything move INTO To Do — there is no status to write', () => {
    for (const s of WORK_STAGES) expect(canMove(s, 'todo')).toBe(false)
    expect(STAGE_TARGET_STATUS.todo).toBeUndefined()
  })

  it('every allowed destination has a status to write', () => {
    for (const from of WORK_STAGES) {
      for (const to of WORK_STAGES) {
        if (canMove(from, to)) expect(STAGE_TARGET_STATUS[to]).toBeTruthy()
      }
    }
  })
})

describe('isPending / isHidden', () => {
  it('pending is work not yet handed over', () => {
    expect(isPending('todo')).toBe(true)
    expect(isPending('working')).toBe(true)
    expect(isPending('delivered')).toBe(false)   // it is off their plate
    expect(isPending('done')).toBe(false)
  })

  it('hides work that is not the designer’s to resurrect', () => {
    expect(isHidden('cancelled')).toBe(true)
    expect(isHidden('rejected')).toBe(true)
    expect(isHidden('archived')).toBe(true)
    expect(isHidden('submitted')).toBe(false)
    expect(isHidden('completed')).toBe(false)
  })
})

describe('moveRefusalReason', () => {
  it('explains a backwards drop in plain terms, naming no internal status', () => {
    const r = moveRefusalReason('working', 'todo')
    expect(r).toContain('cannot be moved back')
    expect(r).not.toMatch(/submitted|under_review|approved/)
  })

  it('explains that finished work needs a manager', () => {
    expect(moveRefusalReason('done', 'working')).toContain('manager')
  })
})
