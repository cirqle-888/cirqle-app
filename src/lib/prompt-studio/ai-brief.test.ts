import { describe, it, expect } from 'vitest'
import { hexesIn, hexToHsl, hslToHex, pairingPalette, colourRule, swatches, COLOR_USE_OPTIONS } from './colors'
import { CLIENT_CARD_FIELDS, CARD_GROUPS } from './client-card'
import { isDirectImageLink, renderClientCard, renderPrompt } from './render'
import { TEMPLATES, templateByKey } from './templates'
import { AI_JOBS, buildAiBrief, planMonthLabel, socialGaps } from './ai-brief'
import { CUSTOM_CATEGORY_IDS } from './types'

const [EXACT, ACCENTS, MATCHING] = COLOR_USE_OPTIONS
const CARD = {
  brand: 'Sea Star', business: 'Supermarket', location: 'Kondotty, Malappuram', language: 'Malayalam',
  colors: 'Maroon #7A1F2B, gold #d4a64a, cream', logo: 'https://example.com/logo.png',
}

describe('brand colours', () => {
  it('reads hex codes out of free text, once each, in order', () => {
    expect(hexesIn('Maroon #7A1F2B, gold #d4a64a, again #7a1f2b, short #fa0')).toEqual(['#7A1F2B', '#D4A64A', '#FFAA00'])
    expect(hexesIn('maroon and gold')).toEqual([])
    expect(hexesIn(null)).toEqual([])
  })

  it('converts to HSL and back without drifting', () => {
    for (const hex of ['#7A1F2B', '#D4A64A', '#000000', '#FFFFFF', '#1E90FF']) {
      const [h, s, l] = hexToHsl(hex)
      const back = hexToHsl(hslToHex(h, s, l))
      expect(Math.abs(back[0] - h) <= 2 || s < 3, hex).toBe(true)
      expect(Math.abs(back[2] - l)).toBeLessThanOrEqual(1)
    }
  })

  it('builds the same matching palette every time, light to dark, around the first brand colour', () => {
    const p = pairingPalette(hexesIn(CARD.colors))!
    expect(p).toEqual(pairingPalette(hexesIn(CARD.colors)))
    expect(p.main).toBe('#7A1F2B')
    expect(p.accent).toBe('#D4A64A')                      // the brand's own second colour
    expect(hexToHsl(p.light)[2]).toBeGreaterThan(hexToHsl(p.soft)[2])
    expect(hexToHsl(p.soft)[2]).toBeGreaterThan(hexToHsl(p.dark)[2])
    expect(hexToHsl(p.neutral)[1]).toBeLessThanOrEqual(15)
    expect(pairingPalette(['#1E90FF'])!.accent).toMatch(/^#[0-9A-F]{6}$/)   // one colour: a calm neighbour
    expect(pairingPalette([])).toBeNull()
  })

  it('writes one plain rule for each way of using colour', () => {
    expect(colourRule(CARD.colors, '')).toBe('')
    expect(colourRule(CARD.colors, 'something else')).toBe('')
    expect(colourRule(CARD.colors, EXACT)).toContain('use only #7A1F2B, #D4A64A, plus white and black')
    expect(colourRule(CARD.colors, ACCENTS)).toMatch(/backgrounds stay neutral .*only as accents/)
    const m = colourRule(CARD.colors, MATCHING)
    expect(m).toContain('exact brand colours are not required')
    expect(m).toContain('Keep the logo in its own colours')
    expect(m).toContain(pairingPalette(hexesIn(CARD.colors))!.light)
    for (const use of COLOR_USE_OPTIONS) {
      expect(colourRule(CARD.colors, use)).toContain('same colours in every post')
      expect(colourRule('maroon and gold', use)).toMatch(/^Colour rule: /)      // still a rule without codes
      expect(colourRule('maroon and gold', use)).not.toContain('undefined')
    }
  })

  it('shows the colours each rule allows', () => {
    expect(swatches(CARD.colors, EXACT)).toEqual(['#7A1F2B', '#D4A64A'])
    expect(swatches(CARD.colors, '')).toEqual(['#7A1F2B', '#D4A64A'])
    expect(swatches(CARD.colors, MATCHING)).toHaveLength(6)
    expect(swatches('no codes', MATCHING)).toEqual([])
  })
})

describe('client card', () => {
  it('puts every field in exactly one group', () => {
    const grouped = CARD_GROUPS.flatMap(g => g.keys)
    expect([...grouped].sort()).toEqual(CLIENT_CARD_FIELDS.map(f => f.key).sort())
    expect(new Set(grouped).size).toBe(grouped.length)
    expect(CARD_GROUPS.filter(g => !g.advanced).flatMap(g => g.keys)).toContain('brand')
  })

  it('an older card prints exactly as before', () => {
    expect(renderClientCard({ brand: 'Seastar', colors: 'Maroon, gold' })).toBe('CLIENT CARD\nBrand: Seastar\nBrand colors: Maroon, gold')
  })

  it('gives the AI the logo link when it opens the image itself (a logo uploaded here)', () => {
    const url = 'https://abc.supabase.co/storage/v1/object/public/social-refs/logos/c1/x.png'
    const out = renderClientCard({ brand: 'Seastar', logo: url })
    expect(out).toContain(`Logo: ${url} (open this link to get the logo file; if you cannot open links, I am attaching it). Use it exactly as it is`)
    expect(isDirectImageLink('https://cdn.site.com/brand/logo.SVG?v=2')).toBe(true)
    for (const no of ['https://drive.google.com/file/d/abc/view', 'http://site.com/logo.png', 'logo.png', '', undefined]) expect(isDirectImageLink(no), String(no)).toBe(false)
  })

  it('prints a page link to the logo as an instruction, not a link, and the colour rule last', () => {
    const out = renderClientCard({ ...CARD, logo: 'https://drive.google.com/file/d/abc/view', colorUse: MATCHING, platforms: 'Instagram; Facebook' })
    expect(out).not.toContain('drive.google.com')
    expect(out).toContain('Logo: I am attaching the logo file')
    expect(out).toContain('Platforms: Instagram; Facebook')
    expect(out).not.toContain('How to use colour')
    expect(out.split('\n').at(-1)).toMatch(/^Colour rule: /)
  })

  it('a colour rule picked for one prompt wins over the card', () => {
    const t = templateByKey('social-fresh-ideas')!
    expect(renderPrompt(t, {}, { ...CARD, colorUse: EXACT }, { colorUse: MATCHING })).toContain('exact brand colours are not required')
    expect(renderPrompt(t, {}, { ...CARD, colorUse: EXACT })).toContain('use only #7A1F2B')
  })
})

describe('social templates', () => {
  const social = TEMPLATES.filter(t => t.category === 'social')

  it('are four, use the card, and never invent prices', () => {
    expect(social.map(t => t.key)).toEqual(['social-trends-today', 'social-calendar-month', 'social-fresh-ideas', 'social-post-brief'])
    for (const t of social) {
      expect(t.usesClientCard, t.key).toBe(true)
      expect(t.body, t.key).toContain('[ask client]')
      expect(t.body, t.key).toContain('Skip politics')
    }
  })

  it('the two that need today’s facts are marked as needing web search', () => {
    expect(social.filter(t => t.web).map(t => t.key)).toEqual(['social-trends-today', 'social-calendar-month'])
    expect(templateByKey('social-trends-today')!.body).toContain('each with a link')
  })

  it('cannot be saved as a custom category the database would refuse', () => {
    expect(CUSTOM_CATEGORY_IDS).not.toContain('social')
  })
})

describe('Copy for AI', () => {
  it('has nothing to copy without a card', () => {
    expect(buildAiBrief(null, 'trends')).toBe('')
    expect(buildAiBrief({ brand: ' ' }, 'details')).toBe('')
  })

  it('copies the card alone, or the card with one job under it', () => {
    expect(buildAiBrief(CARD, 'details')).toBe(renderClientCard(CARD))
    for (const j of AI_JOBS.filter(j => j.template)) {
      const out = buildAiBrief(CARD, j.id, { month: 'December 2026' })
      expect(out.startsWith('CLIENT CARD\nBrand: Sea Star'), j.id).toBe(true)
      expect(out, j.id).toMatch(/You are a (social media planner|senior creative director)/)
      expect(out, j.id).not.toMatch(/\{\{|undefined/)
    }
  })

  it('the monthly calendar asks for a full brief per post that the importer can read', () => {
    const out = buildAiBrief(CARD, 'calendar', { month: 'December 2026' })
    for (const label of ['Date:', 'Idea:', 'Text on design:', 'Visual direction:', 'Caption:', 'AI prompt:', 'Reel script:', 'References:']) expect(out).toContain(`\n${label}`)
    expect(out).toContain('FEED LOOK: As the card says')
    expect(out).toContain('DETAIL: Full brief for every post')
    expect(out).toContain('Never invent a link')
  })

  it('fills the month, the plan type and the format', () => {
    const cal = buildAiBrief(CARD, 'calendar', { month: 'December 2026', mode: 'Random' })
    expect(cal).toContain('calendar for December 2026')
    expect(cal).toContain('PLAN TYPE: Random')
    expect(buildAiBrief(CARD, 'reel', { idea: 'Rain-day delivery' })).toMatch(/IDEA: Rain-day delivery\nFORMAT: Reel/)
    expect(buildAiBrief(CARD, 'poster')).toMatch(/IDEA: Ask me for the idea before you start\.\nFORMAT: Poster/)
  })

  it('can switch the colour rule for one copy', () => {
    expect(buildAiBrief(CARD, 'details', { colorUse: ACCENTS })).toContain('only as accents')
    expect(buildAiBrief(CARD, 'details')).not.toContain('Colour rule')
  })

  it('names what a social plan still needs from the card', () => {
    expect(socialGaps(CARD)).toEqual(['Audience', 'Platforms', 'Posts per week'])
    expect(socialGaps(null)).toHaveLength(6)
    expect(socialGaps({ ...CARD, audience: 'Families', platforms: 'Instagram', postsPerWeek: '3' })).toEqual([])
  })

  it('plans this month, or the next once this one is nearly over', () => {
    expect(planMonthLabel(new Date(2026, 10, 17))).toBe('November 2026')
    expect(planMonthLabel(new Date(2026, 10, 20))).toBe('December 2026')
    expect(planMonthLabel(new Date(2026, 11, 25))).toBe('January 2027')
  })
})
