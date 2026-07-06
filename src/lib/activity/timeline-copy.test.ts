import { describe, it, expect } from 'vitest'
import { timelineSentence, timelineHref, ALL_CATEGORIES } from './timeline-copy'

const base = { entity_id: 'abc', category: null, note: null, detail: null }

describe('timelineSentence', () => {
  it('renders create with label', () => {
    expect(timelineSentence({ ...base, entity_type: 'client', action: 'created', detail: { label: 'Sea Star' } }))
      .toBe('created client “Sea Star”')
  })

  it('renders without label', () => {
    expect(timelineSentence({ ...base, entity_type: 'invoice', action: 'generated', detail: null }))
      .toBe('generated a invoice')
  })

  it('login reads as a plain sentence', () => {
    expect(timelineSentence({ ...base, entity_type: 'auth', action: 'login' })).toBe('signed in')
  })

  it('manual notes quote the note text', () => {
    expect(timelineSentence({ ...base, entity_type: 'task', action: 'note', note: 'called client' }))
      .toBe('noted: “called client”')
  })

  it('unknown actions degrade to space-separated words', () => {
    expect(timelineSentence({ ...base, entity_type: 'task', action: 'some_future_action' }))
      .toContain('some future action')
  })
})

describe('timelineHref', () => {
  it('links tasks to the tasks page with the id', () => {
    expect(timelineHref({ ...base, entity_type: 'task', action: 'created' })).toBe('/dashboard/tasks?task=abc')
  })
  it('links projects to the project detail', () => {
    expect(timelineHref({ ...base, entity_type: 'project', action: 'created' })).toBe('/dashboard/advertising/abc')
  })
  it('returns null for unknown types', () => {
    expect(timelineHref({ ...base, entity_type: 'mystery', action: 'created' })).toBeNull()
  })
})

describe('categories', () => {
  it('exposes all 9 filter groups', () => {
    expect(ALL_CATEGORIES.map(c => c.key)).toEqual([
      'tasks', 'billing', 'chat', 'files', 'advertising', 'crm', 'employees', 'finance', 'recruitment',
    ])
  })
})
