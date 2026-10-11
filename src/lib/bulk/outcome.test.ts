import { describe, it, expect } from 'vitest'
import { describeBulkPlan, summariseBulkOutcome, retryableIds } from './outcome'

describe('describeBulkPlan', () => {
  it('names the count and the action before anything is written', () => {
    expect(describeBulkPlan(12, 'approve', 'request')).toContain('Approve 12 requests')
  })

  it('gets the singular right', () => {
    expect(describeBulkPlan(1, 'approve', 'request')).toContain('Approve 1 request.')
  })

  it('says so when nothing is selected', () => {
    expect(describeBulkPlan(0, 'approve', 'request')).toMatch(/[Nn]othing is selected/)
  })

  it('puts a qualifier after the count, not before it', () => {
    // Folding it into the verb gives "File them under Digital Setup 2 clients."
    expect(describeBulkPlan(2, 'file', 'client', 'under Digital Setup'))
      .toContain('File 2 clients under Digital Setup.')
  })

  it('keeps the qualifier when nothing is selected', () => {
    expect(describeBulkPlan(0, 'file', 'client', 'under Digital Setup'))
      .toBe('Nothing is selected, so there is nothing to file under Digital Setup.')
  })

  it('ignores a blank qualifier rather than leaving a double space', () => {
    expect(describeBulkPlan(2, 'approve', 'request', '  ')).toContain('Approve 2 requests. ')
  })
})

describe('summariseBulkOutcome', () => {
  const attempted = ['a', 'b', 'c']

  it('reports a clean run', () => {
    const r = summariseBulkOutcome({ succeeded: attempted, failed: [] }, attempted, 'request')
    expect(r.tone).toBe('success')
    expect(r.title).toBe('3 requests updated')
    expect(r.retryable).toEqual([])
  })

  it('reports a partial failure with the real numbers', () => {
    // The old UI said "3 requests updated" from `ids.length` regardless.
    const r = summariseBulkOutcome({ succeeded: ['a'], failed: ['b', 'c'] }, attempted, 'request')
    expect(r.tone).toBe('partial')
    expect(r.title).toBe('1 of 3 requests updated')
    expect(r.body).toContain('2 requests were refused')
    expect(r.retryable).toEqual(['b', 'c'])
  })

  it('says plainly when nothing went through', () => {
    const r = summariseBulkOutcome({ succeeded: [], failed: attempted }, attempted, 'request')
    expect(r.tone).toBe('failure')
    expect(r.body).toBe('Nothing was changed.')
    expect(r.retryable).toEqual(attempted)
  })

  it('treats rows the server never mentioned as failures', () => {
    // A loop that died halfway returns a short list. Reading that as success
    // is how a bulk action silently half-applies.
    const r = summariseBulkOutcome({ succeeded: ['a'], failed: [] }, attempted, 'request')
    expect(r.tone).toBe('partial')
    expect(r.retryable).toEqual(['b', 'c'])
  })

  it('treats a missing result as a total failure, not a success', () => {
    const r = summariseBulkOutcome(null, attempted, 'request')
    expect(r.tone).toBe('failure')
    expect(r.retryable).toEqual(attempted)
  })

  it('has nothing to say about an empty selection', () => {
    expect(summariseBulkOutcome({ succeeded: [], failed: [] }, [], 'request').tone).toBe('empty')
  })
})

describe('retryableIds', () => {
  it('offers only the failures, so a retry cannot double-apply', () => {
    const r = summariseBulkOutcome({ succeeded: ['a'], failed: ['b'] }, ['a', 'b'], 'task')
    expect(retryableIds(r)).toEqual(['b'])
  })
})
