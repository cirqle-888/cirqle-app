import { describe, it, expect } from 'vitest'
import { buildPoll, tallyVotes, pollTotals, readPoll } from './polls'

describe('polls', () => {
  it('cleans options and refuses a poll with fewer than two', () => {
    const r = buildPoll('  Which   cover? ', ['A', ' a ', 'B', ''], false)
    expect(r.ok && r.poll.options).toEqual([{ id: 'o1', text: 'A' }, { id: 'o2', text: 'B' }])
    expect(r.ok && r.poll.question).toBe('Which cover?')
    expect(buildPoll('Q', ['only'], false)).toEqual({ ok: false, error: 'Add at least two different options.' })
    expect(buildPoll('', ['a', 'b'], false).ok).toBe(false)
  })

  it('tallies votes and ignores unknown options', () => {
    const built = buildPoll('Q', ['A', 'B'], true)
    if (!built.ok) throw new Error('poll')
    const votes = tallyVotes(built.poll, [
      { employee_id: 'e1', option_id: 'o1' }, { employee_id: 'e2', option_id: 'o1' },
      { employee_id: 'e1', option_id: 'o2' }, { employee_id: 'e3', option_id: 'zz' },
    ])
    expect(votes).toEqual({ o1: ['e1', 'e2'], o2: ['e1'] })
    expect(pollTotals({ ...built.poll, votes })).toEqual({ voters: 2, byOption: { o1: 2, o2: 1 }, top: 2 })
  })

  it('reads a poll back from message metadata', () => {
    expect(readPoll({})).toBeNull()
    expect(readPoll({ poll: { question: 'Q', options: [{ id: 'o1', text: 'A' }], multi: false } })?.votes).toEqual({})
  })
})
