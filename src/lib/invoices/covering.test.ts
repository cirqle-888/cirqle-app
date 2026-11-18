import { describe, it, expect } from 'vitest'
import {
  addLinesTerms, addsToExisting, coveringFrom, statusRank,
  monthStart, pickCovering, type CoveringRow,
  ADD_LINES_OPEN, ADD_LINES_WITH_REASON,
} from './covering'
import type { CoveringInvoice } from './missed-tasks'

/** An invoice row as invoicesCoveringMonths reads it. */
function inv(status: string, currency: string | null = 'INR'): CoveringInvoice {
  return coveringFrom({ id: `id-${status}`, invoice_number: `INV-2611-061${status[0]}`, status, currency })
}

describe('addLinesTerms', () => {
  it.each([...ADD_LINES_OPEN])('%s takes lines with no reason', status => {
    expect(addLinesTerms(status)).toEqual({ editable: true, needsReason: false })
  })

  it.each([...ADD_LINES_WITH_REASON])('%s takes lines only with a reason', status => {
    expect(addLinesTerms(status)).toEqual({ editable: true, needsReason: true })
  })

  it.each(['paid', 'closed', 'cancelled', 'bad_debt'])('%s takes no lines at all', status => {
    expect(addLinesTerms(status)).toEqual({ editable: false, needsReason: false })
  })

  it('treats an unknown status as closed rather than open', () => {
    expect(addLinesTerms('something_new')).toEqual({ editable: false, needsReason: false })
  })
})

describe('statusRank', () => {
  it('orders the workflow earliest first', () => {
    const order = ['draft', 'reviewed', 'sent', 'partial', 'overdue', 'paid', 'closed']
    const ranks = order.map(statusRank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(new Set(ranks).size).toBe(order.length)
  })

  it('ranks an unknown status last, so it never wins a tie-break', () => {
    expect(statusRank('who_knows')).toBeGreaterThan(statusRank('closed'))
  })
})

describe('coveringFrom', () => {
  it('carries the invoice through and derives the terms', () => {
    expect(coveringFrom({ id: 'a', invoice_number: 'INV-2611-061', status: 'sent', currency: 'AED' }))
      .toEqual({ id: 'a', invoice_number: 'INV-2611-061', status: 'sent', currency: 'AED', editable: true, needsReason: true })
  })

  it('normalises a missing currency to null rather than dropping the field', () => {
    expect(coveringFrom({ id: 'a', invoice_number: 'INV-1', status: 'draft' }).currency).toBeNull()
  })
})

describe('addsToExisting', () => {
  it('adds to a sent invoice — the case that used to open a second one', () => {
    expect(addsToExisting(inv('sent'), 'INR')?.invoice_number).toBe('INV-2611-061s')
  })

  it.each(['reviewed', 'sent', 'partial', 'overdue'])('adds to a %s invoice', status => {
    expect(addsToExisting(inv(status), 'INR')).toBeTruthy()
  })

  it('leaves a draft to the generators own append-to-draft path', () => {
    expect(addsToExisting(inv('draft'), 'INR')).toBeUndefined()
  })

  it.each(['paid', 'closed'])('raises a new invoice when the month is %s', status => {
    expect(addsToExisting(inv(status), 'INR')).toBeUndefined()
  })

  it('raises a new invoice when no invoice covers the month', () => {
    expect(addsToExisting(undefined, 'INR')).toBeUndefined()
  })

  it('will not put INR lines on an AED invoice', () => {
    expect(addsToExisting(inv('sent', 'AED'), 'INR')).toBeUndefined()
  })

  it('will not put AED lines on an INR invoice', () => {
    expect(addsToExisting(inv('sent', 'INR'), 'AED')).toBeUndefined()
  })

  it('treats an unset currency on either side as INR', () => {
    expect(addsToExisting(inv('sent', null), 'INR')).toBeTruthy()
    expect(addsToExisting(inv('sent', 'INR'), null)).toBeTruthy()
    expect(addsToExisting(inv('sent', null), null)).toBeTruthy()
    expect(addsToExisting(inv('sent', null), 'AED')).toBeUndefined()
  })

  it('matches on the same currency whatever it is', () => {
    expect(addsToExisting(inv('sent', 'AED'), 'AED')).toBeTruthy()
  })
})

describe('monthStart', () => {
  it('is the first of the month, which is what invoices store', () => {
    expect(monthStart('2026-10')).toBe('2026-10-01')
    expect(monthStart('2026-02')).toBe('2026-02-01')
  })
})

describe('pickCovering', () => {
  const row = (over: Partial<CoveringRow> = {}): CoveringRow => ({
    id: 'i1', client_id: 'c1', invoice_number: 'INV-2611-061',
    status: 'sent', currency: 'INR', billing_period_start: '2026-10-01', ...over,
  })

  it('keys the invoice by client and the month the caller asked about', () => {
    const out = pickCovering([row()], ['2026-10'])
    expect(Object.keys(out)).toEqual(['c1__2026-10'])
    expect(out['c1__2026-10'].invoice_number).toBe('INV-2611-061')
  })

  it('ignores a month the caller did not ask about', () => {
    expect(pickCovering([row({ billing_period_start: '2026-09-01' })], ['2026-10'])).toEqual({})
  })

  it('keeps clients apart for the same month', () => {
    const out = pickCovering([
      row({ id: 'a', client_id: 'c1', invoice_number: 'INV-A' }),
      row({ id: 'b', client_id: 'c2', invoice_number: 'INV-B' }),
    ], ['2026-10'])
    expect(out['c1__2026-10'].invoice_number).toBe('INV-A')
    expect(out['c2__2026-10'].invoice_number).toBe('INV-B')
  })

  it('keeps months apart for the same client', () => {
    const out = pickCovering([
      row({ id: 'a', invoice_number: 'INV-SEP', billing_period_start: '2026-09-01' }),
      row({ id: 'b', invoice_number: 'INV-OCT', billing_period_start: '2026-10-01' }),
    ], ['2026-09', '2026-10'])
    expect(out['c1__2026-09'].invoice_number).toBe('INV-SEP')
    expect(out['c1__2026-10'].invoice_number).toBe('INV-OCT')
  })

  it('picks the earliest in the workflow when a month already has several', () => {
    // Exactly the INV-2611-061A / -061-2 / -061-3 shape. Whichever order the
    // database hands them back, the one still open to lines must win.
    const rows = [
      row({ id: 'a', invoice_number: 'INV-2611-061-3', status: 'paid' }),
      row({ id: 'b', invoice_number: 'INV-2611-061A', status: 'sent' }),
      row({ id: 'c', invoice_number: 'INV-2611-061-2', status: 'draft' }),
    ]
    expect(pickCovering(rows, ['2026-10'])['c1__2026-10'].invoice_number).toBe('INV-2611-061-2')
    expect(pickCovering([...rows].reverse(), ['2026-10'])['c1__2026-10'].invoice_number).toBe('INV-2611-061-2')
  })

  it('never lets an unknown status displace a real one', () => {
    const out = pickCovering([
      row({ id: 'a', invoice_number: 'INV-WEIRD', status: 'teleported' }),
      row({ id: 'b', invoice_number: 'INV-CLOSED', status: 'closed' }),
    ], ['2026-10'])
    expect(out['c1__2026-10'].invoice_number).toBe('INV-CLOSED')
  })

  it('skips rows with no client or no billing period', () => {
    expect(pickCovering([
      row({ client_id: null }),
      row({ billing_period_start: null }),
    ], ['2026-10'])).toEqual({})
  })

  it('returns nothing for no rows and for no months', () => {
    expect(pickCovering([], ['2026-10'])).toEqual({})
    expect(pickCovering([row()], [])).toEqual({})
  })

  it('feeds addsToExisting the answer it needs end to end', () => {
    const out = pickCovering([row({ status: 'sent' })], ['2026-10'])
    expect(addsToExisting(out['c1__2026-10'], 'INR')?.needsReason).toBe(true)
  })
})
