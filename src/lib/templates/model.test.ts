import { describe, it, expect } from 'vitest'
import {
  resolveTemplateSteps, planTemplateRun, templatesFor, validateTemplate,
  parseStoredTemplates, isBuiltInTemplate, BUILTIN_PREFIX,
  MAX_TEMPLATE_NAME, MAX_TEMPLATE_STEPS,
  type TaskTemplate,
} from './model'

const monthly: TaskTemplate = {
  id: 'monthly-cycle',
  name: 'Monthly content cycle',
  steps: [
    { title: 'Collect the brief' },
    { title: 'First drafts', dueOffsetDays: 3, priority: 'high' },
    { title: 'Client review', dueOffsetDays: 7, assignedEmployeeId: 'emp-9' },
    { title: 'Highlight icons', complimentary: true },
  ],
}

const ctx = { startDate: '2026-10-11', defaultAssignedEmployeeId: 'emp-1' }

describe('resolving a run', () => {
  it('turns relative offsets into real dates', () => {
    const steps = resolveTemplateSteps(monthly, ctx)
    expect(steps.map(s => s.dueDate)).toEqual([
      '2026-10-11', '2026-10-14', '2026-10-18', '2026-10-11',
    ])
  })

  it('crosses a month boundary correctly', () => {
    const steps = resolveTemplateSteps(
      { ...monthly, steps: [{ title: 'x', dueOffsetDays: 25 }] },
      { startDate: '2026-10-11' },
    )
    expect(steps[0].dueDate).toBe('2026-11-05')
  })

  it('falls back to the run’s assignee, and lets a step override it', () => {
    const steps = resolveTemplateSteps(monthly, ctx)
    expect(steps[0].assignedEmployeeId).toBe('emp-1')
    expect(steps[2].assignedEmployeeId).toBe('emp-9')
  })

  it('clamps a negative offset instead of dating a step before the job starts', () => {
    const steps = resolveTemplateSteps({ ...monthly, steps: [{ title: 'x', dueOffsetDays: -5 }] }, ctx)
    expect(steps[0].dueDate).toBe('2026-10-11')
  })

  it('carries the complimentary flag through', () => {
    expect(resolveTemplateSteps(monthly, ctx)[3].complimentary).toBe(true)
    expect(resolveTemplateSteps(monthly, ctx)[0].complimentary).toBe(false)
  })

  it('declines to invent a date from a malformed start', () => {
    expect(resolveTemplateSteps(monthly, { startDate: 'tomorrow' })[0].dueDate).toBeNull()
  })

  it('defaults the priority rather than leaving it empty', () => {
    expect(resolveTemplateSteps(monthly, ctx)[0].priority).toBe('normal')
    expect(resolveTemplateSteps(monthly, ctx)[1].priority).toBe('high')
  })
})

describe('the preview, which is also the instruction', () => {
  const steps = resolveTemplateSteps(monthly, ctx)

  it('creates everything when the client has nothing yet', () => {
    const plan = planTemplateRun(steps, [])
    expect(plan.create).toHaveLength(4)
    expect(plan.skip).toHaveLength(0)
  })

  it('skips what the client already has, so re-running tops up', () => {
    // The rule the brand-onboarding button already used: a brand that arrives
    // with a Facebook page keeps that item instead of collecting a duplicate.
    const plan = planTemplateRun(steps, ['  first DRAFTS '])
    expect(plan.create.map(s => s.title)).toEqual(['Collect the brief', 'Client review', 'Highlight icons'])
    expect(plan.skip.map(s => s.title)).toEqual(['First drafts'])
  })

  it('creates nothing on a second identical run', () => {
    const plan = planTemplateRun(steps, steps.map(s => s.title))
    expect(plan.create).toHaveLength(0)
    expect(plan.skip).toHaveLength(4)
  })

  it('deduplicates a template that repeats a title inside itself', () => {
    const dup = resolveTemplateSteps(
      { ...monthly, steps: [{ title: 'Brief' }, { title: 'brief' }] }, ctx,
    )
    expect(planTemplateRun(dup, []).create).toHaveLength(1)
  })

  it('ignores an untitled step rather than creating a blank row', () => {
    const blank = resolveTemplateSteps({ ...monthly, steps: [{ title: '   ' }] }, ctx)
    expect(planTemplateRun(blank, [])).toEqual({ create: [], skip: [] })
  })
})

describe('which templates to offer', () => {
  const all: TaskTemplate[] = [
    { id: 'general', name: 'General', steps: [{ title: 'a' }] },
    { id: 'client', name: 'Acme only', clientId: 'c1', steps: [{ title: 'a' }] },
    { id: 'service', name: 'Social only', serviceId: 's1', steps: [{ title: 'a' }] },
    { id: 'other', name: 'Other client', clientId: 'c2', steps: [{ title: 'a' }] },
  ]

  it('puts the most specific first and hides the irrelevant', () => {
    expect(templatesFor(all, { clientId: 'c1', serviceId: 's1' }).map(t => t.id))
      .toEqual(['client', 'service', 'general'])
  })

  it('offers only the general ones with no context', () => {
    expect(templatesFor(all, {}).map(t => t.id)).toEqual(['general'])
  })

  it('sorts equally-specific templates by name', () => {
    const two = [
      { id: 'b', name: 'Beta', steps: [{ title: 'a' }] },
      { id: 'a', name: 'Alpha', steps: [{ title: 'a' }] },
    ]
    expect(templatesFor(two, {}).map(t => t.name)).toEqual(['Alpha', 'Beta'])
  })
})

describe('validation — the only gate on a JSON blob', () => {
  const good = { id: 'x', name: 'X', steps: [{ title: 'Step' }] }

  it('accepts and normalises a sound template', () => {
    const v = validateTemplate({ ...good, name: '  Monthly   cycle ', steps: [{ title: ' Brief ', dueOffsetDays: '3' }] })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.template.name).toBe('Monthly cycle')
    expect(v.template.steps[0]).toMatchObject({ title: 'Brief', dueOffsetDays: 3, priority: 'normal' })
  })

  it('refuses a template with no name, no id, or no steps', () => {
    expect(validateTemplate({ ...good, name: ' ' }).ok).toBe(false)
    expect(validateTemplate({ ...good, id: '' }).ok).toBe(false)
    expect(validateTemplate({ ...good, steps: [] }).ok).toBe(false)
  })

  it('refuses a step with no title', () => {
    expect(validateTemplate({ ...good, steps: [{ title: '' }] }).ok).toBe(false)
  })

  it('refuses to impersonate a built-in', () => {
    expect(validateTemplate({ ...good, id: `${BUILTIN_PREFIX}onboarding` }).ok).toBe(false)
    expect(isBuiltInTemplate(`${BUILTIN_PREFIX}onboarding`)).toBe(true)
  })

  it('refuses a name or a step list beyond the limits', () => {
    expect(validateTemplate({ ...good, name: 'x'.repeat(MAX_TEMPLATE_NAME + 1) }).ok).toBe(false)
    expect(validateTemplate({
      ...good,
      steps: Array.from({ length: MAX_TEMPLATE_STEPS + 1 }, (_, i) => ({ title: `s${i}` })),
    }).ok).toBe(false)
  })

  it('never throws on rubbish', () => {
    for (const junk of [null, undefined, 0, 'nope', [], {}]) {
      expect(validateTemplate(junk).ok).toBe(false)
    }
  })
})

describe('reading the stored blob', () => {
  it('round-trips a valid list', () => {
    const raw = JSON.stringify([{ id: 'a', name: 'A', steps: [{ title: 's' }] }])
    expect(parseStoredTemplates(raw).map(t => t.id)).toEqual(['a'])
  })

  it('drops the invalid entries and keeps the rest', () => {
    // One hand-edited bad entry must not take the whole library down with it.
    const raw = JSON.stringify([
      { id: 'a', name: 'A', steps: [{ title: 's' }] },
      { id: '', name: '', steps: [] },
    ])
    expect(parseStoredTemplates(raw).map(t => t.id)).toEqual(['a'])
  })

  it('returns nothing for missing or unparseable storage', () => {
    expect(parseStoredTemplates(null)).toEqual([])
    expect(parseStoredTemplates('{oops')).toEqual([])
    expect(parseStoredTemplates('{"not":"an array"}')).toEqual([])
  })
})
