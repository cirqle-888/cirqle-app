import { describe, it, expect } from 'vitest'
import { aiPromptForBrief, extractAiPrompt, promptFromBrief } from './content-brief-prompt'

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
    expect(p).toContain('Create a poster for instagram: Christmas wishes.')
    expect(p).toContain('Look: red and white, star lights')
    expect(p).toContain('Merry Christmas / Sea Star')
    expect(p).toContain('No text in the image, no logo.')
  })
  it('prefers the planner’s own prompt', () => {
    expect(aiPromptForBrief({ title: 'x', contentType: 'post', caption: null, notes }).fromNotes).toBe(true)
    expect(aiPromptForBrief({ title: 'x', contentType: 'reel', caption: null, notes: 'Goal: reach' })).toMatchObject({ fromNotes: false })
  })
})
