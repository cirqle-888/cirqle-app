import { describe, it, expect } from 'vitest'
import { buildSuggestion, pickEvidence, type ContributionEvidence, type SuggestGroup, type SuggestParam } from './suggest'

// Mirrors the production configuration (2026-10-03).
const G = {
  plan:    { id: 'g-plan',    name: 'Planning & Content Group', weight: 50 },
  design:  { id: 'g-design',  name: 'Creative & Design Group',  weight: 50 },
  review:  { id: 'g-review',  name: 'Review & Publishing Group', weight: 50 },
  social:  { id: 'g-social',  name: 'Social Media Group',       weight: 100 },
  flyerD:  { id: 'g-flyerd',  name: ' Flyer Design Group',      weight: 50 },
  flyerP:  { id: 'g-flyerp',  name: ' Flyer Products Group',    weight: 50 },
} satisfies Record<string, SuggestGroup>

const P: SuggestParam[] = [
  { id: 'p-content',    name: 'Content',          group_id: 'g-plan',   weight: 1,    is_master: true,  input_type: 'count' },
  { id: 'p-brief',      name: 'Brief Analysis',   group_id: 'g-plan',   weight: 0.1,  input_type: 'count' },
  { id: 'p-cplanning',  name: 'Content Planning', group_id: 'g-plan',   weight: 0.15, input_type: 'count' },
  { id: 'p-design',     name: 'Design',           group_id: 'g-design', weight: 1,    is_master: true,  input_type: 'percentage' },
  { id: 'p-revision',   name: 'Design Revision',  group_id: 'g-design', weight: 0.1,  input_type: 'count' },
  { id: 'p-publish',    name: 'Publishing/Delivery', group_id: 'g-review', weight: 1, is_master: true, input_type: 'count' },
  { id: 'p-creative',   name: 'Creative Production', group_id: 'g-social', weight: 1, is_master: true, input_type: 'percentage' },
  { id: 'p-pconcept',   name: 'Planning & Concept',  group_id: 'g-social', weight: 0.25, input_type: 'count' },
  { id: 'p-fdesign',    name: 'Design',   group_id: 'g-flyerd', weight: 1, is_master: true, input_type: 'percentage' },
  { id: 'p-fredesign',  name: 'Redesign', group_id: 'g-flyerd', weight: 0.48, input_type: 'count' },
  { id: 'p-products',   name: 'Products', group_id: 'g-flyerp', weight: 1, is_master: true, input_type: 'count' },
]
const paramsFor = (...groups: SuggestGroup[]) => P.filter(p => groups.some(g => g.id === p.group_id))

const designer: ContributionEvidence = { employeeId: 'farooq', role: 'design', reason: 'moved REQ-0123 to Done on My Work · 3 Oct', strength: 4 }
const planner: ContributionEvidence = { employeeId: 'navas', role: 'plan', reason: "planned on Sea Star's September content plan", strength: 3 }

describe('buildSuggestion', () => {
  it('Social Media Poster: designer → Design 100%, planner → Content Planning, split 50/50', () => {
    const groups = [G.plan, G.design, G.review, G.social]
    const s = buildSuggestion(groups, paramsFor(...groups), [designer, planner])!
    expect(s.lines.map(l => [l.employeeId, l.paramName, l.value])).toEqual([
      ['farooq', 'Design', 100],
      ['navas', 'Content Planning', 1],
    ])
    expect(s.contributions).toEqual({ 'p-design': { farooq: 100 }, 'p-cplanning': { navas: 1 } })
    expect(s.activeGroups.sort()).toEqual(['farooq:g-design', 'navas:g-plan'])
    // Content Planning is a sub-param, so it must be marked active or the panel hides it.
    expect(s.activeSubParams).toEqual(['navas:p-cplanning'])
    expect(s.split).toEqual([{ employeeId: 'farooq', pct: 50 }, { employeeId: 'navas', pct: 50 }])
  })

  it('designer alone keeps the whole pool — exactly what is entered today', () => {
    const groups = [G.plan, G.design, G.review, G.social]
    const s = buildSuggestion(groups, paramsFor(...groups), [designer])!
    expect(s.lines).toHaveLength(1)
    expect(s.split).toEqual([{ employeeId: 'farooq', pct: 100 }])
  })

  it('Social Media Services (one group): both land in it, weighted by step — 80/20', () => {
    const s = buildSuggestion([G.social], paramsFor(G.social), [designer, planner])!
    expect(s.lines.map(l => [l.employeeId, l.paramName])).toEqual([
      ['farooq', 'Creative Production'],
      ['navas', 'Planning & Concept'],
    ])
    expect(s.split).toEqual([{ employeeId: 'farooq', pct: 80 }, { employeeId: 'navas', pct: 20 }])
  })

  it('Offer Flyer: designer gets Design and a Products step to count; planner noted, not guessed', () => {
    const groups = [G.flyerP, G.flyerD]
    const s = buildSuggestion(groups, paramsFor(...groups), [designer, planner])!
    expect(s.lines.map(l => [l.paramName, l.value])).toEqual([['Design', 100], ['Products', null]])
    // The products count is unknown: the group is opened for the designer but nothing is credited for it.
    expect(s.contributions).toEqual({ 'p-fdesign': { farooq: 100 } })
    expect(s.activeGroups.sort()).toEqual(['farooq:g-flyerd', 'farooq:g-flyerp'])
    expect(s.notes).toEqual([{ employeeId: 'navas', role: 'plan', reason: planner.reason, why: 'this service has no planning step' }])
  })

  it('the same person planning and designing gets both steps and the whole pool', () => {
    const groups = [G.plan, G.design]
    const s = buildSuggestion(groups, paramsFor(...groups), [designer, { ...planner, employeeId: 'farooq' }])!
    expect(s.lines.map(l => l.employeeId)).toEqual(['farooq', 'farooq'])
    expect(s.split).toEqual([{ employeeId: 'farooq', pct: 100 }])
  })

  it('returns null with no evidence', () => {
    expect(buildSuggestion([G.design], paramsFor(G.design), [])).toBeNull()
  })

  it('ignores groups the task has but no parameters for', () => {
    const s = buildSuggestion([G.design, { id: 'empty', name: 'Creative & Design (old)', weight: 50 }], paramsFor(G.design), [designer])!
    expect(s.lines[0].groupId).toBe('g-design')
  })
})

describe('pickEvidence', () => {
  it('keeps the strongest evidence per role', () => {
    const weak: ContributionEvidence = { employeeId: 'x', role: 'design', reason: 'assigned on the task', strength: 2 }
    expect(pickEvidence([weak, designer, planner])).toEqual({ design: designer, plan: planner })
  })
})
