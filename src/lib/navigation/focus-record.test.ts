import { describe, it, expect } from 'vitest'
import { resolveFocus, matchesTaskRef, focusNoticeLabel } from './focus-record'

interface Row { id: string; ref: string; date: string }

const rows: Row[] = [
  { id: 'a', ref: 'CB-1', date: '2026-10-01' },
  { id: 'b', ref: 'CB-2', date: '2024-03-14' },
]
const idOf = (r: Row) => r.id

describe('resolveFocus', () => {
  it('does nothing without a deep link', () => {
    expect(resolveFocus(null, rows, rows, idOf)).toEqual({ kind: 'none' })
    expect(resolveFocus('   ', rows, rows, idOf)).toEqual({ kind: 'none' })
  })

  it('finds a record the filters leave on screen', () => {
    expect(resolveFocus('a', rows, rows, idOf)).toEqual({ kind: 'visible', record: rows[0] })
  })

  it('distinguishes "hidden by your filters" from "not loaded"', () => {
    // This is the whole point: the old code returned early for both, so a link
    // to last March's entry looked identical to a broken link.
    const visible = [rows[0]]
    expect(resolveFocus('b', rows, visible, idOf)).toEqual({ kind: 'hidden', record: rows[1] })
    expect(resolveFocus('zzz', rows, visible, idOf)).toEqual({ kind: 'missing' })
  })

  it('reports missing when nothing was loaded at all', () => {
    expect(resolveFocus('a', [], [], idOf)).toEqual({ kind: 'missing' })
  })

  it('trims a stray space from the URL', () => {
    expect(resolveFocus(' a ', rows, rows, idOf).kind).toBe('visible')
  })
})

describe('matchesTaskRef', () => {
  const task = { id: 'uuid-1', task_number: 42 }

  it('accepts every spelling a link might carry', () => {
    expect(matchesTaskRef(task, 'uuid-1')).toBe(true)
    expect(matchesTaskRef(task, '42')).toBe(true)
    expect(matchesTaskRef(task, '#42')).toBe(true)
    expect(matchesTaskRef(task, ' 042 ')).toBe(true)
  })

  it('does not match a different task', () => {
    expect(matchesTaskRef(task, '43')).toBe(false)
    expect(matchesTaskRef(task, 'uuid-2')).toBe(false)
  })

  it('never matches on junk or an absent number', () => {
    expect(matchesTaskRef(task, '')).toBe(false)
    expect(matchesTaskRef(task, null)).toBe(false)
    // "4x" must not be read as 4.
    expect(matchesTaskRef({ id: 'x', task_number: 4 }, '4x')).toBe(false)
    expect(matchesTaskRef({ id: 'x', task_number: null }, '4')).toBe(false)
  })
})

describe('focusNoticeLabel', () => {
  it('names the record without quoting any money', () => {
    expect(focusNoticeLabel({ reference: 'CB-2', date: '14 Mar 2024' })).toBe('CB-2 · 14 Mar 2024')
  })

  it('degrades to something sayable', () => {
    expect(focusNoticeLabel({})).toBe('The selected record')
    expect(focusNoticeLabel({ reference: '  ' })).toBe('The selected record')
  })
})
