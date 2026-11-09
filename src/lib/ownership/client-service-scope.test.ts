import { describe, it, expect } from 'vitest'
import { inClientScope } from './engine'

const SEA_STAR = 'client-seastar'
const POSTER = 'svc-poster'
const REEL = 'svc-reel'

describe('inClientScope', () => {
  it('counts every task of the client when no service is picked', () => {
    const program = { scopeId: SEA_STAR, scopeServiceId: null }
    expect(inClientScope(program, SEA_STAR, POSTER)).toBe(true)
    expect(inClientScope(program, SEA_STAR, REEL)).toBe(true)
    expect(inClientScope(program, SEA_STAR, null)).toBe(true)
  })

  it('counts only that service of that client when one is picked', () => {
    const program = { scopeId: SEA_STAR, scopeServiceId: POSTER }
    expect(inClientScope(program, SEA_STAR, POSTER)).toBe(true)
    expect(inClientScope(program, SEA_STAR, REEL)).toBe(false)
  })

  it('never counts the same service bought by another client', () => {
    expect(inClientScope({ scopeId: SEA_STAR, scopeServiceId: POSTER }, 'client-other', POSTER)).toBe(false)
  })

  it('never counts a task with no service against a narrowed program', () => {
    expect(inClientScope({ scopeId: SEA_STAR, scopeServiceId: POSTER }, SEA_STAR, null)).toBe(false)
  })

  it('treats a program from before the migration as the whole client', () => {
    // scopeServiceId is simply absent on rows read before 20261110110000.
    expect(inClientScope({ scopeId: SEA_STAR }, SEA_STAR, REEL)).toBe(true)
  })
})
