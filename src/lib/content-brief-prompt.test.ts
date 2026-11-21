import { describe, it, expect } from 'vitest'
import { aiPromptForBrief, extractAiPrompt, postPromptWithCard, promptFromBrief } from './content-brief-prompt'
import { renderClientCard } from './prompt-studio/render'

const notes = [
  'Goal: trust before the wedding season',
  'Visual direction: wide shot of the buffet, warm light, red accents',
  'AI prompt (paste into the image or video tool):\nA lavish Kerala wedding buffet, golden hour, shallow depth of field. No text in the image, no logo.',
  'Reference searches: kerala wedding buffet',
].join('\n\n')

describe('extractAiPrompt', () => {
  it('takes the text under the AI prompt label, up to the next labelled section', () => {
    expect(extractAiPrompt(notes)).toBe('A lavish Kerala wedding buffet, golden hour, shallow depth of field. No text in the image, no logo.')
  })
  it('reads an inline prompt and keeps unlabelled follow-on paragraphs', () => {
    expect(extractAiPrompt('AI prompt: chef plating mandi\n\nclose-up, steam rising\n\nPost by: 12 Dec')).toBe('chef plating mandi\n\nclose-up, steam rising')
    expect(extractAiPrompt('AI video prompt: slow pan over biriyani')).toBe('slow pan over biriyani')
  })
  it('returns null when there is no prompt', () => {
    expect(extractAiPrompt('Goal: reach')).toBeNull()
    expect(extractAiPrompt(null)).toBeNull()
    expect(extractAiPrompt('AI prompt:')).toBeNull()
  })
})

describe('prompt from the brief', () => {
  it('uses the visual direction and keeps space for the design text', () => {
    const p = promptFromBrief({ title: 'Christmas wishes', contentType: 'poster', caption: 'Text on design:\nMerry Christmas\nSea Star\n\nCaption here', notes: 'Visual direction: red and white, star lights', platforms: ['instagram'] })
    expect(p).toContain('Create a poster for Instagram: Christmas wishes.')
    expect(p).toContain('Look: red and white, star lights')
    expect(p).toContain('Merry Christmas / Sea Star')
    expect(p).toContain('No text in the image, no logo.')
  })
  it('prefers the planner’s own prompt', () => {
    expect(aiPromptForBrief({ title: 'x', contentType: 'post', caption: null, notes }).fromNotes).toBe(true)
    expect(aiPromptForBrief({ title: 'x', contentType: 'reel', caption: null, notes: 'Goal: reach' })).toMatchObject({ fromNotes: false })
  })
})

describe('prompt with the client card', () => {
  const card = renderClientCard({
    brand: 'Sea Star Catering & Events',
    colors: 'Red #FE0000, white #FFFFFF',
    neverShow: 'Non-Indian looking people, blonde hair',
    audienceByService: 'Weddings: local families and couples, Kerala wedding wear\nOffice parties: colleagues in smart office wear',
  })
  const brief = {
    title: 'Grand wedding package',
    contentType: 'poster',
    caption: 'Hook: x\n\nText on design:\nകല്യാണം ഗ്രാൻഡ്\n₹3,45,000\n\nCaption: y',
    notes: `Theme: Wedding packages\n\n${notes}`,
    platforms: ['instagram', 'facebook'],
    date: '2026-12-01',
  }

  it('puts the card, the post and the prompt together for a fresh chat', () => {
    const out = postPromptWithCard(card, brief)
    const at = (block: string) => out.indexOf(`\n\n${block}\n`)
    expect(at('CLIENT CARD')).toBeGreaterThan(0)
    expect(at('CLIENT CARD')).toBeLessThan(at('POST'))
    expect(at('POST')).toBeLessThan(at('AI PROMPT'))
    expect(out).toContain('Brand: Sea Star Catering & Events')
    expect(out).toContain('Never show: Non-Indian looking people, blonde hair')
    expect(out).toContain('Format: Poster for Instagram and Facebook')
    expect(out).toContain('Publishes: 1 December 2026')
    expect(out).toContain('Theme: Wedding packages')
    expect(out).toContain('Goal: trust before the wedding season')
    expect(out).toContain('Text on design: കല്യാണം ഗ്രാൻഡ് / ₹3,45,000')
    expect(out).toContain('Visual direction: wide shot of the buffet, warm light, red accents')
    expect(out.endsWith('A lavish Kerala wedding buffet, golden hour, shallow depth of field. No text in the image, no logo.')).toBe(true)
  })

  it('points at the audience line and keeps space for the designer\'s text', () => {
    const out = postPromptWithCard(card, brief)
    expect(out).toContain('Audience by service: Weddings: local families and couples, Kerala wedding wear; Office parties')
    expect(out).toContain('from the Audience by service line that matches this post')
    expect(out).toContain('leave clear space for the text on design, the logo and the location line')
  })

  it('without an audience line, still asks for people who fit the audience', () => {
    const out = postPromptWithCard(renderClientCard({ brand: 'X' }), { ...brief, notes: 'AI prompt: chef plating mandi, steam rising' })
    expect(out).toContain('Match the people, their clothes and the setting to the audience')
    expect(out).not.toContain('leave clear space')
  })

  it('with no card, copies the prompt alone', () => {
    expect(postPromptWithCard('', brief)).toBe(aiPromptForBrief(brief).text)
    expect(postPromptWithCard(null, brief)).toBe(aiPromptForBrief(brief).text)
  })
})
