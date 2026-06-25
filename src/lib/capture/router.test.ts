import { describe, it, expect } from 'vitest'
import { getAdapter, ROUTABLE_TYPES } from './router'
import type { CaptureType } from './types'

describe('Smart Router', () => {
  it('routes every routable type to an adapter declaring that type', () => {
    for (const t of ROUTABLE_TYPES) {
      const a = getAdapter(t)
      expect(a, `adapter for ${t}`).not.toBeNull()
      expect(a!.type).toBe(t)
    }
  })

  it('registers exactly the six modules', () => {
    expect([...ROUTABLE_TYPES].sort()).toEqual(
      ['client', 'invoice', 'offer', 'quotation', 'request', 'task'],
    )
  })

  it('returns null for unknown / unregistered types', () => {
    expect(getAdapter('unknown' as CaptureType)).toBeNull()
    expect(getAdapter('banana' as CaptureType)).toBeNull()
  })
})
