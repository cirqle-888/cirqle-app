import { describe, it, expect } from 'vitest'
import { LINE_KINDS, isLineKind, suggestKind, summariseKinds } from './line-kinds'

describe('suggestKind', () => {
  it('recognises the narrations Indian banks actually print', () => {
    expect(suggestKind('CASHBACK EARNED')).toBe('cashback')
    expect(suggestKind('Int.Pd:6050750513:14-03-2025 to 31-03-2026')).toBe('interest')
    expect(suggestKind('FD PREMAT PROCEEDS: 8314127303')).toBe('interest')
    expect(suggestKind('SWEEP TRANSFER TO [8316620452]')).toBe('sweep')
    expect(suggestKind('Sweep Trf From: 8315751299')).toBe('sweep')
    expect(suggestKind('GST ON SMS CHARGES')).toBe('charge')
  })

  it('says nothing rather than guessing', () => {
    expect(suggestKind('UPI/NAZAR T/642864636268/UPI')).toBeNull()
    expect(suggestKind('NEFT HDFCH01166682533 TOTAL MARKET')).toBeNull()
    expect(suggestKind('')).toBeNull()
  })

  it('never sets a client receipt aside because it mentions a keyword', () => {
    // The word is IN these, but they are payments to and from people. Matching
    // on "contains" would quietly reclassify real trading as bank income.
    expect(suggestKind('UPI/INTEREST FREE LOAN REPAYMENT/1234/UPI')).toBeNull()
    expect(suggestKind('UPI/Mr Reward Kumar/556677/UPI')).toBeNull()
    expect(suggestKind('NEFT TO SWEEP HOMES PVT LTD')).toBeNull()
  })
})

describe('summariseKinds', () => {
  const line = (amount: number, lineKind: string | null) => ({ amount, lineKind })

  it('groups, counts and totals each kind', () => {
    const got = summariseKinds([
      line(7, 'cashback'), line(2.66, 'cashback'), line(425, 'interest'), line(-1000, null),
    ])
    expect(got.groups.map(g => [g.kind.key, g.count, g.total]))
      .toEqual([['cashback', 2, 9.66], ['interest', 1, 425]])
    expect(got.unclassified).toBe(1)
  })

  it('nets the non-company total rather than adding magnitudes', () => {
    // Cashback in and personal spending out settle against each other: the
    // transfer owed is the NET position, not the gross traffic.
    const got = summariseKinds([line(23.31, 'cashback'), line(-5000, 'personal')])
    expect(got.notCompanyFunds).toBe(-4976.69)
  })

  it('leaves sweeps out of the non-company total', () => {
    // A sweep is the same money changing shelf — it is not anyone's income.
    const got = summariseKinds([
      line(-95000, 'sweep'), line(95000, 'sweep'), line(934, 'interest'),
    ])
    expect(got.groups.find(g => g.kind.key === 'sweep')!.total).toBe(0)
    expect(got.notCompanyFunds).toBe(934)
  })

  it('keeps a stable group order as lines are classified one at a time', () => {
    const got = summariseKinds([line(1, 'other'), line(1, 'cashback'), line(1, 'sweep')])
    expect(got.groups.map(g => g.kind.key)).toEqual(['cashback', 'sweep', 'other'])
  })

  it('ignores a kind the vocabulary does not know', () => {
    expect(summariseKinds([line(5, 'nonsense')]).unclassified).toBe(1)
    expect(isLineKind('nonsense')).toBe(false)
    expect(isLineKind('cashback')).toBe(true)
  })
})

describe('the vocabulary itself', () => {
  it('marks exactly the kinds that are somebody else s money', () => {
    expect(LINE_KINDS.filter(k => k.notCompanyFunds).map(k => k.key))
      .toEqual(['cashback', 'interest', 'personal'])
  })
})
