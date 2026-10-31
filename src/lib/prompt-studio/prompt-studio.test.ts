import { describe, it, expect } from 'vitest'
import { TEMPLATES, CATEGORIES, templateByKey } from './templates'
import { renderPrompt, renderBody, missingRequired, placeholdersIn, renderClientCard, estimateTokens } from './render'
import { splitMulti } from './types'
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
      const declared = t.fields.filter(f => f.type !== 'toggle').map(f => f.key)
      for (const f of t.fields.filter(x => x.showIf))
        expect(t.fields.find(x => x.key === f.showIf)?.type, `${t.key}.${f.key} showIf`).toBe('toggle')
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

describe('fixes from the review', () => {
  const clip = templateByKey('ad-video-clip')!

  it('drops "Use the CLIENT CARD above" when there is no card to point at', () => {
    const out = renderPrompt(clip, { need: 'x' }, null)
    expect(out).not.toMatch(/CLIENT CARD/)
    expect(out.startsWith('You write prompts for AI video tools.')).toBe(true)
  })

  it('the language picked for this prompt wins over the card, and works with no card', () => {
    const card = { brand: 'Seastar', language: 'English' }
    expect(renderPrompt(clip, { need: 'x' }, card, { language: 'Malayalam' })).toContain('Language for voice and text: Malayalam')
    const noCard = renderPrompt(clip, { need: 'x' }, null, { language: 'Arabic' })
    expect(noCard).toContain('CLIENT CARD\nLanguage for voice and text: Arabic')
    expect(noCard).toContain('Use the CLIENT CARD above')
  })

  it('counts Malayalam as costing more tokens than English', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('മലയാളം')).toBeGreaterThan(3)
  })
})

describe('Offer Flyer templates', () => {
  const text = templateByKey('flyer-text-effect')!
  const photo = templateByKey('flyer-product-photo')!

  it('come first, in their own category', () => {
    expect(CATEGORIES[0].id).toBe('flyer')
    expect(TEMPLATES.slice(0, 4).map(t => t.key)).toEqual(['flyer-text-effect', 'flyer-product-photo', 'flyer-product-direct', 'flyer-style-recipe'])
  })

  it('every option list, default and preset uses real options and fields', () => {
    for (const t of [text, photo]) {
      const keys = t.fields.map(f => f.key)
      const ok = (key: string, value: string) => {
        const f = t.fields.find(x => x.key === key)!
        expect(f, `${t.key}.${key}`).toBeTruthy()
        if (f.type === 'multi') for (const v of splitMulti(value)) expect(f.options, `${t.key}.${key}`).toContain(v)
        else if (f.options) expect(f.options, `${t.key}.${key}`).toContain(value)
      }
      for (const [k, v] of Object.entries(t.defaults || {})) ok(k, v)
      for (const p of t.presets || []) for (const [k, v] of Object.entries(p.values)) {
        expect(keys).toContain(k)
        ok(k, v)
      }
      for (const f of t.fields.filter(x => x.preview)) expect(['choice', 'multi']).toContain(f.type)
      for (const f of t.fields) for (const o of f.options || []) expect(o, `${t.key}.${f.key}`).not.toContain(';')
    }
  })

  it('3D text: defaults fill a full, short prompt from just the words', () => {
    expect(missingRequired(text, {})).toEqual(['Text to make'])
    const out = renderPrompt(text, { text: 'MEGA SALE' }, { brand: 'Seastar', colors: 'Red and gold' })
    expect(out).toContain('TEXT (spell exactly): "MEGA SALE"')
    expect(out).toContain('Effect: Bubble 3D with thick outline')
    expect(out).toContain('Background: Transparent PNG (no background)')
    expect(out).not.toContain('Reference image attached')
    expect(out).not.toContain('{{')
  })

  it('3D text: the text space, a painted layout box and objects reach the prompt', () => {
    const out = renderBody(text, {
      text: 'FRESH BASKET', space: 'Fit the coloured box in my layout', spaceNote: 'the white box at the top',
      objects: 'Ribbon under the text; Leaves', subline: 'Offer valid on 29, 30 Oct',
    })
    expect(out).toContain('Text space: Fit the coloured box in my layout')
    expect(out).toContain('About the space: the white box at the top')
    expect(out).toContain('Behind and around the text: Ribbon under the text; Leaves')
    expect(out).toContain('Small line in a ribbon: "Offer valid on 29, 30 Oct"')
    expect(out).toMatch(/fills its solid-coloured box exactly/)
  })

  it('3D text: with nothing ticked around it, the text stands alone', () => {
    const out = renderBody(text, { text: 'SALE' })
    expect(out).not.toContain('Behind and around the text:')
    expect(out).toContain('if none are listed, the text stands alone')
    expect(out).toContain('Text space: Wide (16:9)')
  })

  it('3D text: every effect and text-space option has a picture', async () => {
    const { TEXT_EFFECTS, SPACE_RATIOS } = await import('@/app/(dashboard)/dashboard/prompt-studio/option-preview')
    for (const o of text.fields.find(f => f.key === 'effect')!.options!) expect(TEXT_EFFECTS[o], o).toBeTruthy()
    for (const o of text.fields.find(f => f.key === 'space')!.options!) expect(SPACE_RATIOS[o], o).toBeTruthy()
  })

  it('3D text: ticking reference options adds the reference line', () => {
    const out = renderBody(text, { text: 'SALE', refUse: 'Text effect style; Colours' })
    expect(out).toContain('Reference image attached — copy its: Text effect style; Colours')
  })

  it('a field can be switched off even when it has a default', () => {
    expect(renderBody(text, { text: 'SALE', extras: '' })).not.toContain('Extra effects:')
  })

  it('product photo: always transparent 4K by default, keeps the real label, no card', () => {
    expect(photo.usesClientCard).toBe(false)
    const out = renderPrompt(photo, { product: 'Kabani Rose Liquid 5L can' }, { brand: 'Seastar' })
    expect(out).not.toContain('CLIENT CARD')
    expect(out).toContain('Background: Transparent PNG (no background)')
    expect(out).toContain('Output size: 4K (4096 px on the long side)')
    expect(out).toContain('keep the exact label text, logo, colours, shape and proportions')
  })

  it('product photo: a preset sets the same look for every product', () => {
    const look = photo.presets!.find(p => p.name === 'Falling offer')!
    const out = renderBody(photo, { product: 'Sony Soap 650g', ...look.values })
    expect(out).toContain('Pose: Falling diagonally')
    expect(out).toContain('Same look as the other products: Falling diagonally')
  })
})

describe('Product photo (general)', () => {
  const t = templateByKey('flyer-product-direct')!

  it('with nothing filled in, copies a complete general prompt', () => {
    expect(t.direct).toBe(true)
    expect(t.usesClientCard).toBe(false)
    expect(missingRequired(t, {})).toEqual([])
    const out = renderPrompt(t, {}, { brand: 'Seastar' })
    expect(out.startsWith('Edit the attached product photo')).toBe(true)
    expect(out).toContain('PRODUCT: the product in the photo')
    expect(out).toContain('every colour exactly as in the photo')
    expect(out).toContain('- Angle: straight front view, upright and centred')
    expect(out).toContain('- Shadow: a soft, natural shadow just under the product')
    expect(out).toContain('- Background: fully transparent (transparent PNG)')
    expect(out).toContain('- Quality: upscaled to the highest resolution you can (4K if possible)')
    expect(out).not.toMatch(/in my words|reference picture|Also fix|Match the other/)
    expect(out).not.toContain('{{')
    expect(out).not.toContain('CLIENT CARD')
  })

  it('ticking a property uses the choice, the words and the reference', () => {
    const out = renderBody(t, {
      product: 'Gautam 1121 Basmati 5kg', shadowOn: 'yes', shadow: 'Drop shadow to the side',
      shadowWords: 'long and soft, to the right', shadowRef: 'the shadow under the rice bag',
    })
    expect(out).toContain('PRODUCT: Gautam 1121 Basmati 5kg')
    expect(out).toContain('- Shadow: Drop shadow to the side')
    expect(out).toContain('  Shadow, in my words: long and soft, to the right')
    expect(out).toContain('  Shadow, copy from the reference picture I attached: the shadow under the rice bag')
    expect(out).toContain('- Angle: straight front view, upright and centred')
  })

  it('ticked but nothing chosen still uses the general words; words alone are enough', () => {
    const out = renderBody(t, { lightOn: 'yes', lightWords: 'bright light from the right' })
    expect(out).toContain('- Light: soft studio light from the top left')
    expect(out).toContain('  Light, in my words: bright light from the right')
  })

  it('unticking hides a choice without losing it', () => {
    const v = { shadowOn: '', shadow: 'Reflection below', shadowWords: 'x' }
    expect(renderBody(t, v)).not.toContain('Reflection below')
    expect(renderBody(t, { ...v, shadowOn: 'yes' })).toContain('- Shadow: Reflection below')
  })

  it('Quick looks use real options, tick their own boxes, and match Product photo fix', () => {
    const fix = templateByKey('flyer-product-photo')!
    for (const p of t.presets!) {
      for (const [k, v] of Object.entries(p.values)) {
        const f = t.fields.find(x => x.key === k)!
        expect(f, k).toBeTruthy()
        if (f.type === 'toggle') expect(v).toBe('yes')
        else if (f.options) expect(f.options, k).toContain(v)
        if (f.showIf) expect(p.values[f.showIf], `${p.name}: ${k} needs its box ticked`).toBe('yes')
      }
      expect(p.values.match, p.name).toBe(fix.presets!.find(x => x.name === p.name)!.values.setLook)
    }
  })
})

describe('placeholders with general words', () => {
  it('reads {{key|words}} as the field key', () => {
    expect(placeholdersIn('{{a|soft light}} and {{b}} and {{a}}')).toEqual(['a', 'b'])
  })
})
