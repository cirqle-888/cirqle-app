import { describe, it, expect } from 'vitest'
import { isOverdue } from './invoice'

describe('isOverdue', () => {
  it('flags a sent or part-paid invoice past its due date', () => {
    expect(isOverdue('2020-01-01', 'sent')).toBe(true)
    expect(isOverdue('2020-01-01', 'partial')).toBe(true)
    expect(isOverdue('', 'sent', '2020-01-01')).toBe(true)   // net-30 from issue
  })
  it('never flags an unsent, settled or written-off invoice', () => {
    for (const status of ['draft', 'reviewed', 'paid', 'cancelled', 'bad_debt'])
      expect(isOverdue('2020-01-01', status)).toBe(false)
  })
  it('does not flag an invoice not yet due', () => {
    expect(isOverdue('2999-01-01', 'sent')).toBe(false)
  })
})
