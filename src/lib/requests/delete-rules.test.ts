import { describe, expect, it } from 'vitest'
import { deleteRequestsWarning, isLiveTask, requestDeleteBlocker } from './delete-rules'

describe('isLiveTask', () => {
  it('is a task that is neither cancelled nor in the Trash', () => {
    expect(isLiveTask({ status: 'pending', deleted_at: null })).toBe(true)
    expect(isLiveTask({ status: 'invoiced' })).toBe(true)
    expect(isLiveTask({ status: 'cancelled', deleted_at: null })).toBe(false)
    expect(isLiveTask({ status: 'in_progress', deleted_at: '2026-01-01' })).toBe(false)
    expect(isLiveTask(null)).toBe(false)
  })
})

describe('requestDeleteBlocker', () => {
  it.each(['submitted', 'under_review', 'approved', 'in_progress', 'rejected', 'cancelled', 'archived'])(
    'lets a %s request with no task be deleted',
    status => { expect(requestDeleteBlocker({ status })).toBeNull() },
  )

  it('keeps a request whose task still stands, even a cancelled or archived one', () => {
    const task = { status: 'done', deleted_at: null }
    expect(requestDeleteBlocker({ status: 'cancelled', task })).toMatch(/has a task/)
    expect(requestDeleteBlocker({ status: 'archived', task })).toMatch(/has a task/)
  })

  it('lets it go once that task is cancelled or in the Trash', () => {
    expect(requestDeleteBlocker({ status: 'cancelled', task: { status: 'cancelled' } })).toBeNull()
    expect(requestDeleteBlocker({ status: 'in_progress', task: { status: 'pending', deleted_at: '2026-01-01' } })).toBeNull()
  })

  it.each(['completed', 'delivered'])('keeps %s work until it has been archived', status => {
    expect(requestDeleteBlocker({ status })).toMatch(/finished work/)
  })
})

describe('deleteRequestsWarning', () => {
  it('names a single request and says it cannot be undone', () => {
    const text = deleteRequestsWarning({ count: 1, title: 'Test entry' })
    expect(text).toBe('“Test entry” and its history will be removed. This cannot be undone. If it came from the social calendar, that entry is marked cancelled. The client’s tracking link will no longer show it.')
    expect(text).not.toContain('will be kept')
  })

  it('counts what goes and what stays', () => {
    const text = deleteRequestsWarning({ count: 3, keeping: 2 })
    expect(text).toContain('These 3 requests and their history')
    expect(text).toContain('Social calendar entries they came from are marked cancelled. Client tracking links will no longer show them.')
    expect(text).toContain('2 more you selected will be kept, because they have a task or finished work.')
  })
})
