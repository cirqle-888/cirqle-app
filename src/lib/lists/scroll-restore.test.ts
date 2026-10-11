import { describe, it, expect } from 'vitest'
import {
  listIdentity, scrollStorageKey, encodeScroll, decodeScroll, worthStoring,
  SCROLL_TTL_MS, MIN_SCROLL_PX,
} from './scroll-restore'

const NOW = Date.UTC(2026, 9, 11, 10, 0, 0)

describe('which list a position belongs to', () => {
  it('is the path plus the filters, order-independent', () => {
    expect(listIdentity('/dashboard/tasks', 'status=done&client=a'))
      .toBe(listIdentity('/dashboard/tasks', 'client=a&status=done'))
  })

  it('ignores where-in-the-list params so paging keeps the position', () => {
    expect(listIdentity('/dashboard/tasks', 'status=done&page=4&focus=x'))
      .toBe(listIdentity('/dashboard/tasks', 'status=done'))
  })

  it('separates two different filter sets', () => {
    expect(listIdentity('/dashboard/tasks', 'status=done'))
      .not.toBe(listIdentity('/dashboard/tasks', 'status=pending'))
  })

  it('separates two different screens', () => {
    expect(listIdentity('/dashboard/tasks', '')).not.toBe(listIdentity('/dashboard/invoices', ''))
  })

  it('names a storage key per screen', () => {
    expect(scrollStorageKey('tasks')).not.toBe(scrollStorageKey('invoices'))
  })
})

describe('reading a position back', () => {
  const at = listIdentity('/dashboard/tasks', 'status=done')
  const stored = (top: number, savedAt = NOW, which = at) => encodeScroll(which, top, savedAt)

  it('restores a real position', () => {
    expect(decodeScroll(stored(1800), at, NOW)).toBe(1800)
  })

  it('refuses a position taken from a different list', () => {
    // Restoring 1,800px into a list that now shows four rows would scroll to
    // the bottom of nothing.
    const other = listIdentity('/dashboard/tasks', 'status=pending')
    expect(decodeScroll(stored(1800, NOW, other), at, NOW)).toBeNull()
  })

  it('refuses a stale position', () => {
    expect(decodeScroll(stored(1800, NOW - SCROLL_TTL_MS - 1), at, NOW)).toBeNull()
  })

  it('keeps one right on the TTL', () => {
    expect(decodeScroll(stored(1800, NOW - SCROLL_TTL_MS), at, NOW)).toBe(1800)
  })

  it('ignores a scroll too small to be worth a jump', () => {
    expect(decodeScroll(stored(MIN_SCROLL_PX - 1), at, NOW)).toBeNull()
    expect(decodeScroll(stored(MIN_SCROLL_PX), at, NOW)).toBe(MIN_SCROLL_PX)
  })

  it('never throws on rubbish', () => {
    for (const raw of [null, '', 'nope', '{}', '[]', '{"at":"x"}']) {
      expect(decodeScroll(raw, at, NOW)).toBeNull()
    }
  })

  it('rounds and floors what it stores', () => {
    expect(decodeScroll(stored(1800.6), at, NOW)).toBe(1801)
    expect(decodeScroll(encodeScroll(at, -50, NOW), at, NOW)).toBeNull()
  })
})

describe('worthStoring', () => {
  it('ignores the top of the list and anything nonsensical', () => {
    expect(worthStoring(0)).toBe(false)
    expect(worthStoring(Number.NaN)).toBe(false)
    expect(worthStoring(MIN_SCROLL_PX)).toBe(true)
  })
})
