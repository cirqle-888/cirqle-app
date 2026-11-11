import { describe, it, expect } from 'vitest'
import { hasTemporaryPassword, newPasswordError } from './temp-password'

describe('hasTemporaryPassword', () => {
  it('is true only when an admin reset set the flag', () => {
    expect(hasTemporaryPassword({ temp_password: true })).toBe(true)
    expect(hasTemporaryPassword({ temp_password: false })).toBe(false)
    expect(hasTemporaryPassword({ temp_password: 'true' })).toBe(false)
    expect(hasTemporaryPassword({})).toBe(false)
    expect(hasTemporaryPassword(null)).toBe(false)
  })
})

describe('newPasswordError', () => {
  it('asks for 8+ characters and a matching repeat', () => {
    expect(newPasswordError('short', 'short')).toMatch(/at least 8/)
    expect(newPasswordError('longenough', 'longenougH')).toMatch(/do not match/)
    expect(newPasswordError('longenough', 'longenough')).toBeNull()
  })
})
