import { describe, it, expect } from 'vitest'
import { closedPeriodNotice } from './correction-notice'

/**
 * The wording is a contract, not decoration. A correction to closed books has
 * to tell the operator two things at once — the work record changed, the books
 * did not — and it must never read as a failure, because the save succeeded.
 */

describe('closedPeriodNotice', () => {
  const both = [
    ['adjustments queued', closedPeriodNotice('July 2026', 2)],
    ['nothing queued',     closedPeriodNotice('July 2026', 0)],
  ] as const

  it.each(both)('%s — states that historical payroll was untouched', (_label, notice) => {
    expect(notice.body).toMatch(/Historical payroll was not changed/)
  })

  it.each(both)('%s — never reads as an error', (_label, notice) => {
    const text = `${notice.title} ${notice.body}`
    expect(text).not.toMatch(/\b(failed|failure|error|blocked|refused|cannot)\b/i)
  })

  it.each(both)('%s — names the month being corrected', (_label, notice) => {
    expect(notice.title).toContain('July 2026')
  })

  it('says the difference rides on the next payroll when adjustments were queued', () => {
    const notice = closedPeriodNotice('July 2026', 2)
    expect(notice.body).toMatch(/2 prior-period adjustments/)
    expect(notice.body).toMatch(/next open payroll/)
  })

  it('singularises a lone adjustment', () => {
    expect(closedPeriodNotice('July 2026', 1).body).toMatch(/1 prior-period adjustment queued/)
  })

  it('explains a zero count instead of leaving it looking broken', () => {
    // Zero is normal: sub-₹1 drift, or a month locked before anyone was paid.
    // Both innocent, so both are named — and Check corrections is offered.
    const body = closedPeriodNotice('July 2026', 0).body
    expect(body).toMatch(/under ₹1/)
    expect(body).toMatch(/has not been paid yet/)
    expect(body).toMatch(/Check corrections/)
  })

  it('degrades gracefully when the month could not be resolved', () => {
    expect(closedPeriodNotice(undefined, undefined).title).toContain('a closed period')
  })
})
