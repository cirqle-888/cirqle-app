import { describe, it, expect } from 'vitest'
import { safeNextPath } from './safe-next-path'

describe('safeNextPath', () => {
  it('keeps a same-site page, with its query', () => {
    expect(safeNextPath('/dashboard/tasks')).toBe('/dashboard/tasks')
    expect(safeNextPath('/dashboard/tasks?client=abc&from=2026-11-01')).toBe('/dashboard/tasks?client=abc&from=2026-11-01')
  })

  it('refuses anything that could leave the site', () => {
    expect(safeNextPath('//evil.example')).toBeNull()
    expect(safeNextPath('/\\evil.example')).toBeNull()
    expect(safeNextPath('https://evil.example/dashboard')).toBeNull()
    expect(safeNextPath('javascript:alert(1)')).toBeNull()
    expect(safeNextPath('dashboard/tasks')).toBeNull()
    expect(safeNextPath('/dashboard\n/tasks')).toBeNull()
  })

  it('refuses the auth screens and API routes, so it cannot loop or land on JSON', () => {
    expect(safeNextPath('/login')).toBeNull()
    expect(safeNextPath('/login?next=/dashboard')).toBeNull()
    expect(safeNextPath('/reset-password')).toBeNull()
    expect(safeNextPath('/api/health')).toBeNull()
    // A page that merely starts with the same letters is fine.
    expect(safeNextPath('/dashboard/login-activity')).toBe('/dashboard/login-activity')
  })

  it('treats empty and oversized input as nothing', () => {
    expect(safeNextPath(null)).toBeNull()
    expect(safeNextPath(undefined)).toBeNull()
    expect(safeNextPath('')).toBeNull()
    expect(safeNextPath('/' + 'a'.repeat(2001))).toBeNull()
  })
})
