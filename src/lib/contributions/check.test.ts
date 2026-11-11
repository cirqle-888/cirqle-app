import { describe, it, expect } from 'vitest'
import { normalizeCheckTaskIds, summarizeCheck, checkAccess, answersMessage, cleanText } from './check'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'

describe('normalizeCheckTaskIds', () => {
  it('drops duplicates and junk, keeps order', () => {
    expect(normalizeCheckTaskIds([B, 'nope', A, B.toUpperCase(), ''])).toEqual({ ids: [B, A], dropped: 0 })
  })
  it('caps the list and says how many were left out', () => {
    expect(normalizeCheckTaskIds([A, B, C], 2)).toEqual({ ids: [A, B], dropped: 1 })
  })
})

describe('summarizeCheck', () => {
  it('counts each answer', () => {
    expect(summarizeCheck([{ answer: 'correct' }, { answer: 'worked' }, { answer: null }, { answer: 'correct' }]))
      .toEqual({ total: 4, answered: 3, correct: 2, worked: 1, pending: 1 })
  })
})

describe('checkAccess', () => {
  const check = { employee_id: A, requested_by: B, status: 'open' as const }
  it('lets the person it was sent to answer while it is open', () => {
    expect(checkAccess({ employeeId: A, isAdmin: false }, check)).toBe('answer')
    expect(checkAccess({ employeeId: A, isAdmin: false }, { ...check, status: 'answered' })).toBe('read')
  })
  it('lets the sender and admins review', () => {
    expect(checkAccess({ employeeId: B, isAdmin: false }, check)).toBe('review')
    expect(checkAccess({ employeeId: C, isAdmin: true }, check)).toBe('review')
  })
  it('an admin who was sent the check answers it rather than reviewing', () => {
    expect(checkAccess({ employeeId: A, isAdmin: true }, check)).toBe('answer')
  })
  it('shuts everyone else out', () => {
    expect(checkAccess({ employeeId: C, isAdmin: false }, check)).toBeNull()
    expect(checkAccess({ employeeId: null, isAdmin: false }, check)).toBeNull()
  })
})

describe('answersMessage', () => {
  it('reads naturally', () => {
    expect(answersMessage({ total: 5, answered: 5, correct: 5, worked: 0, pending: 0 })).toBe('All 5 jobs marked correct.')
    expect(answersMessage({ total: 5, answered: 5, correct: 4, worked: 1, pending: 0 })).toBe('1 job needs a look, 4 marked correct.')
    expect(answersMessage({ total: 5, answered: 5, correct: 3, worked: 2, pending: 0 })).toBe('2 jobs need a look, 3 marked correct.')
  })
})

describe('cleanText', () => {
  it('trims, empties to null, caps length', () => {
    expect(cleanText('  hi ', 10)).toBe('hi')
    expect(cleanText('   ', 10)).toBeNull()
    expect(cleanText(null, 10)).toBeNull()
    expect(cleanText('abcdef', 3)).toBe('abc')
  })
})
