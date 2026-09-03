import { describe, it, expect } from 'vitest'
import { isDueToSend } from './invoice'

// The real situation that prompted this: on 4 Sept the list held next month's
// drafts (issue 1 Oct, billing September) next to one August invoice that was
// already three days late.
const TODAY = '2026-09-04'

describe('isDueToSend', () => {
  it('catches the invoice whose issue date has passed', () => {
    expect(isDueToSend({ status: 'reviewed', issue_date: '2026-09-01' }, TODAY)).toBe(true)
  })

  it('ignores next cycle’s drafts, which is the whole point', () => {
    // INV-2610-*: auto-collecting September's work, not raised until 1 October.
    expect(isDueToSend({ status: 'draft', issue_date: '2026-10-01' }, TODAY)).toBe(false)
  })

  it('includes a draft due today', () => {
    expect(isDueToSend({ status: 'draft', issue_date: TODAY }, TODAY)).toBe(true)
  })

  it('counts drafts as well as reviewed — both still have to go out', () => {
    expect(isDueToSend({ status: 'draft', issue_date: '2026-08-01' }, TODAY)).toBe(true)
    expect(isDueToSend({ status: 'reviewed', issue_date: '2026-08-01' }, TODAY)).toBe(true)
  })

  it('drops anything already sent or settled', () => {
    for (const status of ['sent', 'partial', 'paid', 'cancelled', 'bad_debt']) {
      expect(isDueToSend({ status, issue_date: '2026-08-01' }, TODAY), status).toBe(false)
    }
  })

  it('treats a missing issue date as due rather than hiding it', () => {
    // Nothing schedules it for later, and the view exists to catch stragglers.
    expect(isDueToSend({ status: 'draft', issue_date: null }, TODAY)).toBe(true)
    expect(isDueToSend({ status: 'draft' }, TODAY)).toBe(true)
  })

  it('compares dates as strings, so no timezone can shift the day', () => {
    // ISO dates sort lexicographically; going through Date() here is what makes
    // "due today" flip depending on the machine's clock.
    expect(isDueToSend({ status: 'draft', issue_date: '2026-09-04T18:30:00Z' }, TODAY)).toBe(true)
    expect(isDueToSend({ status: 'draft', issue_date: '2026-09-05' }, TODAY)).toBe(false)
  })
})
