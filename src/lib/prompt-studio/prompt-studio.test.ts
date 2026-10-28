import { describe, it, expect } from 'vitest'
import { TEMPLATES, CATEGORIES, templateByKey } from './templates'
import { renderPrompt, renderBody, missingRequired, placeholdersIn, renderClientCard } from './render'
import { CLIENT_CARD_FIELDS } from './client-card'

describe('template library', () => {
  it('has unique, stable keys', () => {
    const keys = TEMPLATES.map(t => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every template belongs to a known category and every category has templates', () => {
    const ids = new Set(CATEGORIES.map(c => c.id))
    for (const t of TEMPLATES) expect(ids.has(t.category), t.key).toBe(true)
    for (const c of CATEGORIES) expect(TEMPLATES.some(t => t.category === c.id), c.id).toBe(true)
  })

  it('every placeholder in a body is a declared field, and every field is used', () => {
    for (const t of TEMPLATES) {
      const used = placeholdersIn(t.body)
      const declared = t.fields.map(f => f.key)
      expect(used.filter(k => !declared.includes(k)), `${t.key}: undeclared`).toEqual([])
      expect(declared.filter(k => !used.includes(k)), `${t.key}: unused`).toEqual([])
    }
  })

  it('every template tells the AI to answer with output only', () => {
    for (const t of TEMPLATES) expect(t.body, t.key).toMatch(/Output only/)
  })

  it('templates that use the card mention it', () => {
    for (const t of TEMPLATES.filter(x => x.usesClientCard)) expect(t.body, t.key).toMatch(/CLIENT CARD/)
  })
})

describe('rendering', () => {
  const t = templateByKey('ad-video-clip')!

  it('drops lines for empty optional fields', () => {
    const out = renderBody(t, { need: 'Bride walks in' })
    expect(out).toContain('MY NEED (one shot only): Bride walks in')
    expect(out).not.toContain('Speech:')
    expect(out).not.toContain('{{')
  })

  it('keeps a required line visible even when empty', () => {
    expect(renderBody(t, {})).toContain('MY NEED (one shot only):')
    expect(missingRequired(t, {})).toEqual(['What you need (your own words)'])
    expect(missingRequired(t, { need: 'x' })).toEqual([])
  })

  it('puts the client card on top only when the template uses it', () => {
    const card = { brand: 'Seastar', location: 'Kondotty', neverShow: 'Alcohol\nother brands' }
    const out = renderPrompt(t, { need: 'x' }, card)
    expect(out.startsWith('CLIENT CARD\nBrand: Seastar\nLocation: Kondotty')).toBe(true)
    expect(out).toContain('Never show: Alcohol; other brands')
    const story = templateByKey('film-story-idea')!
    expect(renderPrompt(story, { need: 'x' }, card)).not.toContain('CLIENT CARD')
  })

  it('an empty card renders nothing', () => {
    expect(renderClientCard({})).toBe('')
    expect(renderClientCard(null)).toBe('')
  })

  it('card fields have unique keys', () => {
    const keys = CLIENT_CARD_FIELDS.map(f => f.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
