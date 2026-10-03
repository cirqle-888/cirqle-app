import { describe, it, expect } from 'vitest'
import { predictTask, taskTokens } from './predict-task'

const services = [
  { id: 'poster', name: 'Social Media Poster' },
  { id: 'hoarding', name: 'Hoarding Design' },
  { id: 'logo', name: 'Logo Design' },
  { id: 'collateral', name: 'Collateral Design' },
  { id: 'pack', name: 'Product Packaging Design' },
]

const history = [
  { title: 'Flex Design for Flex', service_id: 'hoarding', client_id: 'seastar-mkt', created_at: '2026-09-25' },
  { title: 'Sunboard flex for entrance', service_id: 'hoarding', client_id: 'herbs', created_at: '2026-09-10' },
  { title: 'Glass Sticker Design - Two Sides', service_id: 'collateral', client_id: 'herbs', created_at: '2026-09-12' },
  { title: 'Milkees', service_id: 'poster', client_id: 'seastar-cat', created_at: '2026-09-29' },
  { title: 'Seastar', service_id: 'poster', client_id: 'seastar-cat', created_at: '2026-09-30' },
  { title: 'Prescent Perfume', service_id: 'poster', client_id: 'seastar-cat', created_at: '2026-10-01' },
  { title: 'Milk Peda - Package Design', service_id: 'pack', client_id: 'elmido', created_at: '2026-09-12' },
]

describe('taskTokens', () => {
  it('drops filler and stems plurals', () => {
    expect(taskTokens('New Posters & Stories design set for Onam')).toEqual(['poster', 'story', 'onam'])
  })
})

describe('predictTask', () => {
  it('reads the task straight from the title when a task name word appears', () => {
    const p = predictTask({ title: 'Diwali logo refresh', services, history })!
    expect(p.serviceId).toBe('logo')
    expect(p.reason).toMatch(/logo/)
  })

  it('learns from past titles — "flex" means Hoarding here', () => {
    const p = predictTask({ title: 'Flex board for Onam', services, history })!
    expect(p.serviceId).toBe('hoarding')
  })

  it('falls back to what the client usually asks for', () => {
    const p = predictTask({ title: 'Weekend special', clientId: 'seastar-cat', clientName: 'Sea Star Catering', services, history })!
    expect(p.serviceId).toBe('poster')
    expect(p.reason).toBe('most used for Sea Star Catering')
  })

  it("uses a client's single committed task when there is no history", () => {
    const p = predictTask({ title: '', clientId: 'newco', services, history, commitments: [{ client_id: 'newco', service_id: 'logo' }] })!
    expect(p.serviceId).toBe('logo')
  })

  it('a single past title match still outranks the client habit', () => {
    // Real case: one earlier "Flex" request was Hoarding; this client always orders posters.
    const p = predictTask({ title: 'Flex board for entrance', clientId: 'seastar-cat', services,
      history: history.filter(h => h.title !== 'Sunboard flex for entrance') })!
    expect(p.serviceId).toBe('hoarding')
  })

  it('title evidence beats client habit', () => {
    const p = predictTask({ title: 'Glass sticker for front door', clientId: 'seastar-cat', services, history })!
    expect(p.serviceId).toBe('collateral')
  })

  it('makes no guess with nothing to go on', () => {
    expect(predictTask({ title: 'Something', services, history })).toBeNull()
    expect(predictTask({ title: '', services, history: [] })).toBeNull()
  })

  it('offers chips but does not pre-fill on a near tie', () => {
    const tie = [
      { title: 'A', service_id: 'poster', client_id: 'c', created_at: '2026-10-01' },
      { title: 'B', service_id: 'logo', client_id: 'c', created_at: '2026-10-01' },
    ]
    const p = predictTask({ title: '', clientId: 'c', services, history: tie })
    // Recency weighting separates them slightly; either way both are offered.
    expect(p?.ranked.map(r => r.serviceId).sort()).toEqual(['logo', 'poster'])
  })

  it('ignores services that no longer exist', () => {
    const p = predictTask({ title: '', clientId: 'x', services, history: [{ title: 't', service_id: 'gone', client_id: 'x' }] })
    expect(p).toBeNull()
  })
})
