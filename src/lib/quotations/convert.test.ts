import { describe, it, expect } from 'vitest'
import { statusNeedsConfirm } from './convert'

describe('quotation status changes', () => {
  it('asks before approving or rejecting, not before other steps', () => {
    expect(statusNeedsConfirm('approved')).toBe(true)
    expect(statusNeedsConfirm('rejected')).toBe(true)
    expect(statusNeedsConfirm('sent')).toBe(false)
    expect(statusNeedsConfirm('draft')).toBe(false)
  })
})
