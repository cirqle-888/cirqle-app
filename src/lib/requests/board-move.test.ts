import { describe, it, expect } from 'vitest'
import { planBoardMove, columnOf } from './board-move'

const card = (status: string, o: { hasTask?: boolean; hasAssignee?: boolean } = {}) =>
  ({ status, hasTask: o.hasTask ?? false, hasAssignee: o.hasAssignee ?? true })

describe('columnOf', () => {
  it('maps every request status to its board column', () => {
    expect(columnOf('approved')).toBe('new')
    expect(columnOf('waiting_for_content')).toBe('ongoing')
    expect(columnOf('delivered')).toBe('review')
    expect(columnOf('cancelled')).toBe('rejected')
    expect(columnOf('nonsense')).toBeNull()
  })
})

describe('planBoardMove', () => {
  it('does nothing inside the same column', () => {
    expect(planBoardMove(card('submitted'), 'new')).toEqual({ kind: 'none' })
  })

  it('opens Start task when a new request with an assignee goes to On Going', () => {
    expect(planBoardMove(card('submitted'), 'ongoing')).toEqual({ kind: 'start-task' })
  })

  it('will not start a request nobody is assigned to', () => {
    expect(planBoardMove(card('submitted', { hasAssignee: false }), 'ongoing').kind).toBe('blocked')
  })

  it('moves the TASK, not the request, once a task exists', () => {
    expect(planBoardMove(card('in_progress', { hasTask: true }), 'review'))
      .toEqual({ kind: 'task-status', to: 'delivered', confirm: null })
    expect(planBoardMove(card('delivered', { hasTask: true }), 'completed'))
      .toEqual({ kind: 'task-status', to: 'done', confirm: null })
    expect(planBoardMove(card('delivered', { hasTask: true }), 'ongoing'))
      .toEqual({ kind: 'task-status', to: 'in_progress', confirm: null })
  })

  it('asks before cancelling a task', () => {
    const m = planBoardMove(card('in_progress', { hasTask: true }), 'rejected')
    expect(m.kind).toBe('task-status')
    expect(m.kind === 'task-status' && m.confirm).toBeTruthy()
  })

  it('never reopens finished work by dragging', () => {
    expect(planBoardMove(card('completed', { hasTask: true }), 'ongoing').kind).toBe('blocked')
    expect(planBoardMove(card('cancelled'), 'new').kind).toBe('blocked')
    expect(planBoardMove(card('archived'), 'ongoing').kind).toBe('blocked')
  })

  it('never sends anything back to New, or archives by dragging', () => {
    expect(planBoardMove(card('in_progress', { hasTask: true }), 'new').kind).toBe('blocked')
    expect(planBoardMove(card('in_progress'), 'archived').kind).toBe('blocked')
  })

  it('needs a task before a new request can skip ahead', () => {
    expect(planBoardMove(card('approved'), 'completed').kind).toBe('blocked')
    expect(planBoardMove(card('approved'), 'review').kind).toBe('blocked')
  })

  it('rejects a new request, with a confirmation', () => {
    expect(planBoardMove(card('submitted'), 'rejected'))
      .toEqual({ kind: 'request-status', to: 'rejected', confirm: 'Reject this request?' })
  })

  it('moves an older started request with no task through the request itself', () => {
    expect(planBoardMove(card('in_progress'), 'review')).toEqual({ kind: 'request-status', to: 'delivered', confirm: null })
    expect(planBoardMove(card('delivered'), 'completed')).toEqual({ kind: 'request-status', to: 'completed', confirm: null })
    expect(planBoardMove(card('delivered'), 'ongoing').kind).toBe('blocked')
  })
})
