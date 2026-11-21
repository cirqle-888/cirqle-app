import { describe, it, expect } from 'vitest'
import { pageLabel, pagesFor, type CampaignPageOption } from './campaign-page'

const opt = (o: Partial<CampaignPageOption>): CampaignPageOption => ({
  id: 'x', name: 'X', username: null, platform: 'facebook_page', clientId: null, ownerType: 'client', ...o,
})

const pages: CampaignPageOption[] = [
  opt({ id: 'works', name: 'Cirqle Works', ownerType: 'cirqle' }),
  opt({ id: 'flyers-ig', name: 'Cirqle Flyers', username: 'cirqle_flyers', platform: 'instagram', ownerType: 'cirqle' }),
  opt({ id: 'seastar', name: 'Sea Star', clientId: 'c1' }),
  opt({ id: 'mezza', name: 'Mezza', clientId: 'c2' }),
  opt({ id: 'loose', name: 'Unsorted', ownerType: 'unassigned', clientId: 'c1' }),
]

describe('pagesFor', () => {
  it('offers only Cirqle-owned pages to a company campaign', () => {
    expect(pagesFor(pages, null).map(p => p.id)).toEqual(['works', 'flyers-ig'])
  })
  it("offers only the client's own pages to a client campaign", () => {
    expect(pagesFor(pages, 'c1').map(p => p.id)).toEqual(['seastar'])
  })
})

describe('pageLabel', () => {
  it('names Instagram accounts by handle and Pages by name', () => {
    expect(pageLabel(pages[1])).toBe('@cirqle_flyers · Instagram')
    expect(pageLabel(pages[0])).toBe('Cirqle Works · Facebook')
  })
})
