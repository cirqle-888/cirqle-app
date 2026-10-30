import { describe, expect, it } from 'vitest'
import { answerField, cardFromAnswer } from './answer'
import { templateByKey } from './templates'

describe('using an answer in the next template', () => {
  it('a shot list answer goes into the clip-planning box, else the main need', () => {
    expect(answerField(templateByKey('ad-voiceover-script')!)).toBe('shots')
    expect(answerField(templateByKey('fix-shorten-prompt')!)).toBe('old')
    expect(answerField(templateByKey('ad-concepts')!)).toBe('need')
    expect(answerField(templateByKey('flyer-text-effect')!)).toBeNull()
  })

  it('reads a Client Card from the brief template answer and skips ASK CLIENT', () => {
    const card = cardFromAnswer(`Brand: Seastar
**Business:** Supermarket
- Location: Kondotty, Malappuram
Offer: ASK CLIENT
Phone / address: +91 81579 13616
Language: Malayalam
Look and feel: Bright, festive
Something else: ignored`)
    expect(card).toEqual({
      brand: 'Seastar',
      business: 'Supermarket',
      location: 'Kondotty, Malappuram',
      contact: '+91 81579 13616',
      language: 'Malayalam',
      look: 'Bright, festive',
    })
  })
})
