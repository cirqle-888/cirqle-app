import { describe, it, expect } from 'vitest'
import { cardFillPrompt, styleStudyPrompt, parseCardAnswer } from './card-fill'
import { CLIENT_CARD_FIELDS, CARD_GROUPS, FEED_STYLE_OPTIONS } from './client-card'
import { renderClientCard } from './render'

describe('cardFillPrompt', () => {
  const p = cardFillPrompt({ name: 'Sea Star Catering', links: 'https://www.instagram.com/seastar_neerad/', card: { brand: 'Sea Star', contact: '+91 1\n+91 2' } })

  it('names the client, the pages and what is already known', () => {
    expect(p).toContain('CLIENT: Sea Star Catering')
    expect(p).toContain('PAGES: https://www.instagram.com/seastar_neerad/')
    expect(p).toContain('ALREADY ON THE CARD')
    expect(p).toContain('Phone / address: +91 1; +91 2')
  })

  it('asks for every field an AI can find, with the exact choices, and not for the ones people fill', () => {
    for (const label of ['Brand:', 'Business:', 'Brand colors:', 'Existing designs:', 'Feed style:', 'Posts per week:', 'What worked before:']) expect(p).toContain(`\n${label} <`)
    expect(p).toContain(FEED_STYLE_OPTIONS.join(' | '))
    expect(p).toContain('Choose from: Instagram, Facebook')
    expect(p).not.toContain('Logo link:')
    expect(p).not.toContain('Tools I am using:')
  })

  it('tells the AI to find the page when no link is given, and never to guess', () => {
    expect(cardFillPrompt({ name: 'X' })).toContain('search for their official Instagram')
    expect(p).toContain('never guess')
  })

  it('every label it asks for is read back by the parser', () => {
    const labels = [...p.matchAll(/^([A-Z][^:<\n]*): </gm)].map(m => m[1])
    expect(labels.length).toBeGreaterThan(15)
    const answer = labels.map(l => `${l}: zz`).join('\n')
    const got = parseCardAnswer(answer)
    const typed = CLIENT_CARD_FIELDS.filter(f => labels.includes(f.label) && f.type !== 'select' && f.type !== 'multi').map(f => f.label)
    expect(got.filled).toEqual(typed)
  })
})

describe('styleStudyPrompt', () => {
  it('asks only about how the page looks, sounds and performs', () => {
    const p = styleStudyPrompt({ name: 'Sea Star', links: 'https://instagram.com/x' })
    expect(p).toContain('\nExisting designs: <')
    expect(p).toContain('\nFeed style: <')
    expect(p).not.toContain('\nBusiness: <')
    expect(p).not.toContain('\nPhone / address: <')
  })
})

describe('parseCardAnswer', () => {
  const answer = `Here is the card:

\`\`\`
Brand: SEA STAR CATERING & EVENTS
Business: Catering and events management since 1999
Location: Neerad, Kondotty
Offer:
Phone / address: +91 81293 68417 | +91 98463 17155
**Audience:** Families planning weddings (check)
Language for voice and text: malayalam + english
- Brand colors: Red #FE0000, white
How to use colour: Brand colours as accents
Feed style: Mixed
Existing designs: Bold Malayalam headlines.
Trend-based posters with AI characters.
Platforms: Instagram, Facebook and Threads
Posts per week: 3 posters + 2 reels
Main goal: Enquiries
Gulf audience: Not found
What worked before: <their 3 posts with the most likes>
\`\`\`

Note: I could not open the Facebook page.`
  const got = parseCardAnswer(answer)

  it('fills the fields it can read, by label', () => {
    expect(got.card).toMatchObject({
      brand: 'SEA STAR CATERING & EVENTS',
      business: 'Catering and events management since 1999',
      contact: '+91 81293 68417 | +91 98463 17155',
      audience: 'Families planning weddings (check)',
      colors: 'Red #FE0000, white',
      postsPerWeek: '3 posters + 2 reels',
    })
  })

  it('matches choices loosely and keeps only real options', () => {
    expect(got.card.language).toBe('Malayalam + English')
    expect(got.card.colorUse).toBe('Brand colours as accents on neutral backgrounds')
    expect(got.card.feedStyle).toBe(FEED_STYLE_OPTIONS[2])
    expect(got.card.platforms).toBe('Instagram; Facebook')
    expect(got.refused).toEqual(['Main goal'])
    expect(got.card.goal).toBeUndefined()
  })

  it('keeps a value that runs over lines, and skips empty, "not found" and leftover hints', () => {
    expect(got.card.history).toBe('Bold Malayalam headlines.\nTrend-based posters with AI characters.')
    for (const k of ['offer', 'gulf', 'worked']) expect(got.card[k]).toBeUndefined()
    expect(got.filled).not.toContain('Offer')
  })

  it('finds nothing in ordinary text', () => {
    expect(parseCardAnswer('Sure, I can help with that. Note: I could not open the page.')).toEqual({ card: {}, filled: [], refused: [] })
  })
})

describe('the new card fields', () => {
  it('are in a group, and print on the card', () => {
    const grouped = CARD_GROUPS.flatMap(g => g.keys)
    for (const k of ['links', 'feedStyle', 'history']) expect(grouped).toContain(k)
    const out = renderClientCard({ brand: 'X', feedStyle: FEED_STYLE_OPTIONS[0], history: 'Red band on top' })
    expect(out).toContain(`Feed style: ${FEED_STYLE_OPTIONS[0]}`)
    expect(out).toContain('Existing designs: Red band on top')
  })
})
