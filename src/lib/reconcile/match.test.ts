import { describe, it, expect } from 'vitest'
import { cycleBalance, proposeForLine, reconcile, type EntryCandidate, type StatementLine } from './match'

/**
 * The matcher, and mostly the ways it could be confidently wrong.
 *
 * A proposal that pairs the wrong entry with a charge does not fail — it
 * produces a cycle that balances and books that do not. So the groups below
 * that prove it REFUSES are the ones carrying the weight.
 */

const line = (id: string, txnDate: string, description: string, amount: number): StatementLine =>
  ({ id, txnDate, description, amount })
const entry = (id: string, entryDate: string, description: string, amount: number, taken = false): EntryCandidate =>
  ({ id, entryDate, description, amount, taken })

describe('one entry, one charge', () => {
  it('matches the same amount on the same day', () => {
    const p = proposeForLine(
      line('l1', '2026-06-25', 'ANTHROPIC CLAUDE', 2286.83),
      [entry('e1', '2026-06-25', 'Claude subscription', 2286.83)])
    expect(p.entryIds).toEqual(['e1'])
    expect(p.confidence).toBe('exact')
  })

  it('matches across a few days, and says how far', () => {
    const p = proposeForLine(
      line('l1', '2026-06-25', 'GODADDY', 500),
      [entry('e1', '2026-06-27', 'Domain renewal', 500)])
    expect(p.entryIds).toEqual(['e1'])
    expect(p.confidence).toBe('likely')
    expect(p.reason).toContain('2 days apart')
  })

  it('is more confident when the wording agrees as well', () => {
    const p = proposeForLine(
      line('l1', '2026-06-25', 'GODADDY.COM 4806505', 500),
      [entry('e1', '2026-06-27', 'Godaddy domain renewal', 500)])
    expect(p.confidence).toBe('exact')
  })

  it('prefers the NEARER of two entries with the same amount', () => {
    const p = proposeForLine(
      line('l1', '2026-06-25', 'SWIGGY', 400),
      [entry('far', '2026-06-28', 'Team lunch', 400), entry('near', '2026-06-25', 'Lunch', 400)])
    expect(p.entryIds).toEqual(['near'])
  })
})

describe('the split — one charge, several entries', () => {
  it('finds two entries that add up to the charge', () => {
    // The real pair from the cashbook: one GoDaddy charge, split so hosting
    // and the domain could each carry their own category.
    const p = proposeForLine(
      line('l1', '2025-10-01', 'GODADDY', 715.84),
      [
        entry('host', '2025-10-01', 'Host Purchase (Cirqle.work)', 434.13),
        entry('domain', '2025-10-01', 'Domain Purchase (Cirqle.work)', 281.71),
      ])
    expect(p.confidence).toBe('split')
    expect([...p.entryIds].sort()).toEqual(['domain', 'host'])
  })

  it('finds a three-way split', () => {
    const p = proposeForLine(
      line('l1', '2026-05-10', 'AMAZON', 3000),
      [
        entry('a', '2026-05-10', 'Cables', 1000),
        entry('b', '2026-05-11', 'Stand', 1200),
        entry('c', '2026-05-09', 'Adapter', 800),
      ])
    expect(p.confidence).toBe('split')
    expect(p.entryIds).toHaveLength(3)
  })

  it('prefers the SMALLEST set that adds up', () => {
    // 600 is reachable as 600, or as 400 + 200. One entry is the better
    // answer and a bigger set is a coincidence more often than a split.
    const p = proposeForLine(
      line('l1', '2026-05-10', 'SHOP', 600),
      [entry('x', '2026-05-10', 'One payment', 600),
       entry('y', '2026-05-10', 'Part', 400), entry('z', '2026-05-10', 'Part', 200)])
    expect(p.entryIds).toEqual(['x'])
  })

  it('will not assemble a split out of more entries than a person could check', () => {
    const parts = Array.from({ length: 8 }, (_, i) => entry('p' + i, '2026-05-10', 'Bit', 100))
    const p = proposeForLine(line('l1', '2026-05-10', 'SHOP', 800), parts, { maxSplit: 4 })
    expect(p.confidence).toBe('none')
  })

  it('does not mix a refund into a split', () => {
    // 500 = 800 + (−300) is arithmetic, not a split. A credit inside a charge
    // is a different event and needs a person.
    const p = proposeForLine(
      line('l1', '2026-05-10', 'SHOP', 500),
      [entry('a', '2026-05-10', 'Purchase', 800), entry('b', '2026-05-10', 'Refund', -300)])
    expect(p.confidence).toBe('none')
  })
})

describe('it must NOT match', () => {
  it('refuses an entry outside the date window', () => {
    const p = proposeForLine(
      line('l1', '2026-06-25', 'SWIGGY', 400),
      [entry('e1', '2026-07-20', 'Lunch', 400)])
    expect(p.confidence).toBe('none')
  })

  it('refuses an amount that is merely close', () => {
    // 399.99 is not 400. A tolerance here would silently absorb real errors.
    const p = proposeForLine(
      line('l1', '2026-06-25', 'SWIGGY', 400),
      [entry('e1', '2026-06-25', 'Lunch', 399.99)])
    expect(p.confidence).toBe('none')
  })

  it('never offers an entry already matched to another line', () => {
    const p = proposeForLine(
      line('l1', '2026-06-25', 'SWIGGY', 400),
      [entry('e1', '2026-06-25', 'Lunch', 400, true)])
    expect(p.confidence).toBe('none')
  })

  it('proposes nothing when there is nothing near', () => {
    expect(proposeForLine(line('l1', '2026-06-25', 'X', 400), []).confidence).toBe('none')
  })

  it('matches to the paise, not to the rupee', () => {
    const p = proposeForLine(
      line('l1', '2025-10-01', 'GODADDY', 715.84),
      [entry('a', '2025-10-01', 'Host', 434.13), entry('b', '2025-10-01', 'Domain', 281.70)])
    expect(p.confidence).toBe('none')   // 715.83, not 715.84
  })
})

describe('a whole cycle', () => {
  it('gives an exact single its entry before a split can eat it', () => {
    // 'combo' could be split as 300 + 200, but 'solo' IS 300 exactly. Taking
    // confident answers first is what stops the wrong pairing.
    const lines = [line('combo', '2026-05-10', 'BIG', 500), line('solo', '2026-05-10', 'SMALL', 300)]
    const entries = [
      entry('a', '2026-05-10', 'Part', 300),
      entry('b', '2026-05-10', 'Part', 200),
    ]
    const got = reconcile(lines, entries)
    const solo = got.proposals.find(p => p.lineId === 'solo')
    expect(solo?.entryIds).toEqual(['a'])
    // …and 'combo' then has only 200 left, which does not add up, so it is
    // reported unmatched rather than mis-paired.
    expect(got.unmatchedLineIds).toContain('combo')
  })

  it('never uses one entry for two lines', () => {
    const lines = [line('l1', '2026-05-10', 'A', 250), line('l2', '2026-05-10', 'B', 250)]
    const got = reconcile(lines, [entry('only', '2026-05-10', 'One', 250)])
    const used = got.proposals.flatMap(p => p.entryIds)
    expect(used).toEqual(['only'])
    expect(got.unmatchedLineIds).toHaveLength(1)
  })

  it('reports charges with no entry — the ones not recorded yet', () => {
    const got = reconcile([line('l1', '2026-05-10', 'NEW', 999)], [])
    expect(got.unmatchedLineIds).toEqual(['l1'])
  })

  it('reports entries no line claimed — on the card but not billed', () => {
    const got = reconcile([], [entry('e1', '2026-05-10', 'Recorded', 100)])
    expect(got.unclaimedEntryIds).toEqual(['e1'])
  })

  it('handles an empty cycle without inventing anything', () => {
    expect(reconcile([], [])).toEqual({ proposals: [], unmatchedLineIds: [], unclaimedEntryIds: [] })
  })
})

describe('does the cycle add up', () => {
  it('agrees when the lines total the statement', () => {
    const b = cycleBalance([line('a', '2026-05-01', 'X', 700.5), line('b', '2026-05-02', 'Y', 299.5)], 1000)
    expect(b.agrees).toBe(true)
    expect(b.difference).toBe(0)
  })

  it('reports the gap when they do not', () => {
    const b = cycleBalance([line('a', '2026-05-01', 'X', 700)], 1000)
    expect(b.agrees).toBe(false)
    expect(b.difference).toBe(-300)
  })

  it('nets a refund off the total', () => {
    const b = cycleBalance([line('a', '2026-05-01', 'Buy', 1000), line('b', '2026-05-03', 'Refund', -250)], 750)
    expect(b.agrees).toBe(true)
  })

  it('does not claim agreement before a total has been entered', () => {
    const b = cycleBalance([line('a', '2026-05-01', 'X', 700)], null)
    expect(b.agrees).toBe(false)
    expect(b.difference).toBeNull()
  })
})
