import { describe, it, expect, vi } from 'vitest'

// ai-insights imports ai/groq (pure fetch wrapper) — no server-only chain, but
// mock it so no network is attempted if a test path calls it.
vi.mock('@/lib/ai/groq', () => ({ callGroqJSON: vi.fn(async () => ({})) }))

import { ruleBasedNarrative } from './ai-insights'

describe('ruleBasedNarrative', () => {
  it('reports reach growth and lead growth as wins', () => {
    const n = ruleBasedNarrative({
      rollup: { reach: 84000, reachDeltaPct: 38.4, leads: 126, leadsDeltaPct: 12, roas: 3.5, cpl: 120, interactions: 5000, contentPublished: 14 },
      leadsByCampaign: { 'August Leadgen': 90, Organic: 36 },
    })
    expect(n.ruleBased).toBe(true)
    expect(n.wins.join(' ')).toMatch(/38\.4%/)
    expect(n.wins.join(' ')).toMatch(/ROAS/)
    expect(n.leadInsight).toMatch(/August Leadgen/)
  })

  it('flags declines and high CPL as weak areas', () => {
    const n = ruleBasedNarrative({
      rollup: { reach: 1000, reachDeltaPct: -45, leads: 10, leadsDeltaPct: -30, cpl: 800, interactions: 100, contentPublished: 3 },
      leadsByCampaign: {},
    })
    expect(n.weak.join(' ')).toMatch(/declined 45%/)
    expect(n.weak.join(' ')).toMatch(/₹800/)
    // low cadence + declining reach → recommendations mention cadence / reach
    expect(n.recommendations.join(' ')).toMatch(/cadence|reach|targeting/i)
  })

  it('degrades gracefully with sparse data', () => {
    const n = ruleBasedNarrative({ rollup: { reach: 0, leads: 0 }, leadsByCampaign: {} })
    expect(n.summary).toBeTruthy()
    expect(n.wins.length).toBeGreaterThan(0)
    expect(n.recommendations.length).toBeGreaterThan(0)
  })
})
