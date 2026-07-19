import { describe, it, expect } from 'vitest'
import {
  narrowServiceOptions, committedServicesFor, assignedServicesFor, isCommitted,
  UNSCOPED_PAYLOAD, type ServiceScopePayload,
} from './service-scope-client'

const ALL = [
  { id: 's1', name: 'Offer Design' },
  { id: 's2', name: 'Social Poster' },
  { id: 's3', name: 'Video Editing' },
]

const payload = (over: Partial<ServiceScopePayload> = {}): ServiceScopePayload => ({
  mode: 'legacy', restricted: false, serviceIds: [],
  clientServices: { seastar: ['s1', 's2'] },     // Sea Star: no video
  clientNarrowingEnabled: true, ...over,
})

describe('committedServicesFor / assignedServicesFor / isCommitted', () => {
  it('null when narrowing is off, no client, or client unconfigured', () => {
    expect(committedServicesFor(payload({ clientNarrowingEnabled: false }), 'seastar')).toBeNull()
    expect(committedServicesFor(payload(), null)).toBeNull()
    expect(committedServicesFor(payload(), 'unknown-client')).toBeNull()
    expect(committedServicesFor(UNSCOPED_PAYLOAD, 'seastar')).toBeNull()
  })

  it('assignedServicesFor is null unless genuinely restricted', () => {
    expect(assignedServicesFor(payload())).toBeNull()
    expect(assignedServicesFor(payload({ restricted: true, serviceIds: [] }))).toBeNull()
    expect([...(assignedServicesFor(payload({ restricted: true, serviceIds: ['s1'] })) ?? [])]).toEqual(['s1'])
  })

  it('isCommitted defaults to true where there is nothing to narrow by', () => {
    expect(isCommitted(payload(), 'seastar', 's1')).toBe(true)
    expect(isCommitted(payload(), 'seastar', 's3')).toBe(false)     // video
    expect(isCommitted(payload(), 'unknown', 's3')).toBe(true)
    expect(isCommitted(payload(), 'seastar', null)).toBe(true)
  })
})

describe('narrowServiceOptions — the user requirement', () => {
  it('Sea Star offers its committed services and NOT video', () => {
    const r = narrowServiceOptions(ALL, payload(), 'seastar')
    expect(r.options.map(o => o.id)).toEqual(['s1', 's2'])
    expect(r.narrowed).toBe(true)
    expect(r.hiddenCount).toBe(1)
  })

  it('no client selected → full list', () => {
    expect(narrowServiceOptions(ALL, payload(), null).options).toHaveLength(3)
  })

  it('unconfigured client → full list (never an empty picker)', () => {
    const r = narrowServiceOptions(ALL, payload(), 'brand-new-client')
    expect(r.options).toHaveLength(3)
    expect(r.narrowed).toBe(false)
  })

  it('showAll escape hatch reveals everything', () => {
    const r = narrowServiceOptions(ALL, payload(), 'seastar', null, { showAll: true })
    expect(r.options).toHaveLength(3)
  })
})

describe('narrowServiceOptions — a scoping rule must never make a record unsavable', () => {
  it('keeps an already-selected non-committed service and flags it', () => {
    const r = narrowServiceOptions(ALL, payload(), 'seastar', 's3')   // saved video task
    expect(r.options.map(o => o.id)).toContain('s3')
    expect(r.selectionOutsidePlan).toBe(true)
  })

  it('keeps an already-selected service outside the employee assignment too', () => {
    const p = payload({ restricted: true, serviceIds: ['s1'] })
    const r = narrowServiceOptions(ALL, p, null, 's3')
    expect(r.options.map(o => o.id)).toEqual(['s1', 's3'])
  })
})

describe('narrowServiceOptions — employee restriction and client commitment compose', () => {
  it('applies both filters', () => {
    // assigned s1+s3; Sea Star commits s1+s2 → only s1 survives
    const p = payload({ restricted: true, serviceIds: ['s1', 's3'] })
    expect(narrowServiceOptions(ALL, p, 'seastar').options.map(o => o.id)).toEqual(['s1'])
  })

  it('falls back rather than returning an empty picker', () => {
    // assigned only s3 (video); Sea Star does not commit it → intersection empty
    const p = payload({ restricted: true, serviceIds: ['s3'] })
    const r = narrowServiceOptions(ALL, p, 'seastar')
    expect(r.options.map(o => o.id)).toEqual(['s3'])   // assignment list, not []
    expect(r.options.length).toBeGreaterThan(0)
  })
})
