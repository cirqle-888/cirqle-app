import { describe, expect, it } from 'vitest'
import { APPROVED_MARK, campaignTitle, cleanOfferTitle, notesWithApproval, flyerProgress, isApproval, isBehind, offerList, offerSource, priceWarnings, pricedProducts, type DeskMessage } from './flyer-desk'
import { offerDates, offerNotes, notesWithAddition } from './offer-plan'
import { isPaymentMessage, looksLikeEnquiry, paymentAmount } from './signals'

const VEG = 'Onionbig-49\nChittulli-39\nTomato-26\nOrange-2k-100\nPinapple-49\nApple-140'
const at = (h: number, m = 0) => `2026-11-10T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+00:00`
const msg = (h: number, from: 'cirqle' | 'client', type: string, body = ''): DeskMessage =>
  ({ chat_id: 'c@g.us', from_cirqle: from === 'cirqle', type, body, sent_at: at(h) })

describe('how far a flyer has got', () => {
  it('is new until Cirqle posts a design', () => {
    expect(flyerProgress([msg(6, 'client', 'text', 'Image please'), msg(7, 'cirqle', 'text', 'Ok')], at(5), null).stage).toBe('new')
  })
  it('is sent once a design is posted', () => {
    const p = flyerProgress([msg(6, 'cirqle', 'image'), msg(7, 'cirqle', 'text', 'Please check')], at(5), null)
    expect(p).toMatchObject({ stage: 'sent', designs: 1, corrections: 0, firstDesignAt: at(6) })
  })
  it('is approved when the client says ok', () => {
    for (const ok of ['Ok', 'ok 👍', '👍', 'Super', 'Approved', 'mathi']) {
      expect(flyerProgress([msg(6, 'cirqle', 'image'), msg(7, 'client', 'text', ok)], at(5), null).stage, ok).toBe('approved')
    }
  })
  it('counts one round of changes however many messages it takes', () => {
    const p = flyerProgress([
      msg(6, 'cirqle', 'image'), msg(7, 'client', 'text', 'Apple price 149 aanu'), msg(8, 'client', 'ptt'),
      msg(9, 'cirqle', 'image'), msg(10, 'client', 'text', 'Logo valuthakku'), msg(11, 'cirqle', 'image'), msg(12, 'client', 'text', 'Ok'),
    ], at(5), null)
    expect(p).toMatchObject({ stage: 'approved', designs: 3, corrections: 2 })
  })
  it('goes back to changes when the client asks again after approving', () => {
    expect(flyerProgress([msg(6, 'cirqle', 'image'), msg(7, 'client', 'text', 'ok'), msg(8, 'client', 'text', 'One change undu')], at(5), null).stage).toBe('changes')
  })
  it('only reads its own part of the chat', () => {
    const chat = [msg(4, 'cirqle', 'image'), msg(6, 'cirqle', 'image'), msg(9, 'client', 'text', 'ok')]
    expect(flyerProgress(chat, at(5), at(8))).toMatchObject({ stage: 'sent', designs: 1 })
  })
  it('does not take a greeting for approval', () => {
    expect(isApproval('Good morning')).toBe(false)
    expect(isApproval('Hi')).toBe(false)
    expect(isApproval('')).toBe(false)
  })
  it('nudges only for an offer by tomorrow with no finished design', () => {
    expect(isBehind('new', '2026-11-11', '2026-11-10', '2026-11-11')).toBe(true)
    expect(isBehind('changes', '2026-11-10', '2026-11-10', '2026-11-11')).toBe(true)
    expect(isBehind('sent', '2026-11-11', '2026-11-10', '2026-11-11')).toBe(false)
    expect(isBehind('new', '2026-11-13', '2026-11-10', '2026-11-11')).toBe(false)
    expect(isBehind('new', '2026-11-09', '2026-11-10', '2026-11-11')).toBe(false)
  })
})

describe('reading the calendar notes back', () => {
  const notes = notesWithAddition(
    offerNotes({ list: VEG, client: 'Bismi', sender: 'A', products: 6, dates: offerDates(VEG, '2026-11-10'), messageId: 'MSG1', chatId: '1203@g.us' }),
    'APPLE 149/-', 'M2',
  )
  it('finds the message and chat', () => {
    expect(offerSource(notes)).toEqual({ messageId: 'MSG1', chatId: '1203@g.us' })
    expect(offerSource('Hand-written note')).toBeNull()
  })
  it('gives back only the price list, with what was added', () => {
    expect(offerList(notes)).toBe(`${VEG}\nAPPLE 149/-`)
  })
})

describe('price checks', () => {
  it('reads names and prices', () => {
    expect(pricedProducts('Tomato-26\nAPPLE 149/-\nFEBI DISH WASH 500ML  44.90\nPlease check')).toEqual([
      { name: 'Tomato', key: 'tomato', price: 26 }, { name: 'APPLE', key: 'apple', price: 149 },
      { name: 'FEBI DISH WASH 500ML', key: 'febidishwash500ml', price: 44.9 },
    ])
  })
  it('is quiet for an ordinary list', () => {
    expect(priceWarnings(VEG, [VEG])).toEqual([])
  })
  it('flags a product listed at two prices', () => {
    expect(priceWarnings(`${VEG}\nTomato-36`)).toEqual(['Tomato is listed twice: 26 and 36.'])
  })
  it('flags a price far from last time, against the newest earlier list', () => {
    const list = VEG.replace('Apple-140', 'Apple-14')
    expect(priceWarnings(list, ['Apple-150\nTomato-28', 'Apple-20'])).toEqual(['Apple: 14 now, 150 last time.'])
  })
  it('flags a product with no price', () => {
    expect(priceWarnings(`${VEG}\nMysore pak`)).toEqual(['No price on "Mysore pak".'])
  })
})

describe('payment messages', () => {
  it('spots a payment', () => {
    for (const t of ['Paid', 'Payment done', 'GPay cheythu', 'Amount ayachittund', '5000 transferred', 'UTR 123456789012', 'പണം അയച്ചു', 'Paid to CIRQLE WORKS ₹12,000 UPI transaction ID 4455']) {
      expect(isPaymentMessage(t), t).toBe(true)
    }
  })
  it('leaves ordinary talk and price lists alone', () => {
    for (const t of ['Payment eppozha venam?', 'Invoice ayakkamo', 'Poster ayo', VEG, 'Ok', '']) expect(isPaymentMessage(t), t).toBe(false)
  })
  it('reads the amount when there is one', () => {
    expect(paymentAmount('Paid ₹12,000 today')).toBe('₹12,000')
    expect(paymentAmount('5000 rs gpay cheythu')).toBe('₹5000')
    expect(paymentAmount('Payment done')).toBeNull()
  })
})

describe('new enquiries', () => {
  it('spots someone asking about a service', () => {
    for (const t of ['Hi, logo design rate ethra?', 'I need a website for my shop', 'Poster cheyyan how much', 'Social media marketing package details']) {
      expect(looksLikeEnquiry(t), t).toBe(true)
    }
  })
  it('ignores greetings and unrelated talk', () => {
    for (const t of ['Hi', 'Good morning', 'Evide aanu?', 'Call me when free', 'Nice video']) expect(looksLikeEnquiry(t), t).toBe(false)
  })
})

describe('when the client approves', () => {
  it('keeps what the newest design says, for its title', () => {
    const chat = [{ ...msg(6, 'cirqle', 'image'), media_text: 'WEEKEND OFFER\nTomato 26' }, { ...msg(8, 'cirqle', 'image'), media_text: 'FRIDAY FRESH\nTomato 26' }, msg(9, 'client', 'text', 'ok')]
    expect(flyerProgress(chat, at(5), null)).toMatchObject({ stage: 'approved', designText: 'FRIDAY FRESH\nTomato 26' })
  })
  it('accepts a real title and refuses a price, a blank or the placeholder', () => {
    expect(cleanOfferTitle(' "Weekend Offer". ')).toBe('Weekend Offer')
    for (const t of ['', 'Untitled', 'Tomato-26', '14/15', 'ok', undefined, 'x'.repeat(80)]) expect(cleanOfferTitle(t), String(t)).toBeNull()
  })
  it('takes the Offer Studio offer whose dates cover the flyer', () => {
    const c = (title: string | null, d: string | null, from: string | null, to: string | null, created: string) =>
      ({ title, offer_date: d, offer_date_from: from, offer_date_to: to, created_at: created })
    const list = [c('Old Sale', '2026-11-01', null, null, '2026-10-31'), c('Weekend Offer', null, '2026-11-14', '2026-11-15', '2026-11-12'), c(null, '2026-11-14', null, null, '2026-11-13')]
    expect(campaignTitle(list, '2026-11-14')).toBe('Weekend Offer')
    expect(campaignTitle(list, '2026-11-20')).toBeNull()
  })
  it('marks the notes once', () => {
    const notes = notesWithApproval('List', '2026-11-14')
    expect(notes).toContain('Approved by the client in WhatsApp on 2026-11-14.')
    expect(notes).toContain(APPROVED_MARK)
  })
})
