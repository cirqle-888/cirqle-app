import { describe, expect, it } from 'vitest'
import { STYLE_TEMPLATE_KEY, styleFromAnswer, styleTemplate } from './style'
import { templateByKey } from './templates'
import { placeholdersIn, renderBody, renderPrompt } from './render'
import { FIELD_TYPES, PREVIEW_KINDS } from './types'

const ANSWER = `**NAME:** Monsoon Glass
STYLE: Wet glossy glass letters with rain drops running down, deep blue outline, soft {{reflection}} below.
COLOURS: #0EA5E9, #1E3A8A, #FFFFFF
ELEMENTS: rain drops, dark clouds
Avoid: dry look, flat letters, neon, clutter, text changes`

describe('saved styles', () => {
  it('the style template asks for the five recipe lines, with no card', () => {
    const t = templateByKey(STYLE_TEMPLATE_KEY)!
    expect(t.usesClientCard).toBe(false)
    const out = renderBody(t, { inspiration: 'monsoon rain' })
    expect(out).toContain('Take from it: Text effect only; Colours; Objects and elements around')
    expect(out).toContain('Inspiration: monsoon rain')
    for (const line of ['NAME:', 'STYLE:', 'COLOURS:', 'ELEMENTS:', 'Avoid:']) expect(out).toContain(line)
  })

  it('reads the name and keeps the rest as the recipe, without template braces', () => {
    const { name, recipe } = styleFromAnswer(ANSWER)
    expect(name).toBe('Monsoon Glass')
    expect(recipe.startsWith('STYLE: Wet glossy glass letters')).toBe(true)
    expect(recipe).toContain('COLOURS: #0EA5E9')
    expect(recipe).not.toContain('NAME')
    expect(recipe).not.toContain('{{')
    expect(styleFromAnswer('just some words').name).toBe('My style')
  })

  it('a saved style mixes into any template between the card and the task', () => {
    const { recipe } = styleFromAnswer(ANSWER)
    const out = renderPrompt(templateByKey('ad-video-clip')!, { need: 'a shop in the rain' }, { brand: 'Seastar' }, { style: recipe })
    const card = out.indexOf('CLIENT CARD'), style = out.indexOf('STYLE TO FOLLOW'), task = out.indexOf('You write prompts')
    expect(card).toBeLessThan(style)
    expect(style).toBeLessThan(task)
    expect(renderPrompt(templateByKey('ad-video-clip')!, { need: 'x' })).not.toContain('STYLE TO FOLLOW')
  })

  it('makes a valid custom text template with the recipe built in', () => {
    const { name, recipe } = styleFromAnswer(ANSWER)
    const t = styleTemplate(name, recipe)
    expect(t.name).toBe('Monsoon Glass text')
    expect(t.category).toBe('flyer')
    expect(placeholdersIn(t.body).sort()).toEqual(t.fields.map(f => f.key).sort())
    for (const f of t.fields) {
      expect(FIELD_TYPES).toContain(f.type)
      if (f.preview) expect(PREVIEW_KINDS).toContain(f.preview)
    }
    const out = renderPrompt(t, { text: 'RAIN DEALS', space: 'Wide banner (3:1)' }, { brand: 'Seastar' })
    expect(out).toContain('TEXT (spell exactly): "RAIN DEALS"')
    expect(out).toContain('STYLE (follow closely):\nSTYLE: Wet glossy glass letters')
    expect(out).toMatch(/Output only the prompt/)
  })
})
