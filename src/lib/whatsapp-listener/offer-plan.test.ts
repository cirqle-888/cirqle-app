import { describe, expect, it } from 'vitest'
import {
  DATE_ASSUMED_LINE, additionMarker, chatMarker, dateOnlyMessage, isPriceLine, isSmallAddition, messageMarker, notesWithAddition, notesWithDate,
  offerDates, offerNotes, parseDateHint, priceListSize,
} from './offer-plan'

const VEG = 'Onionbig-49\nChittulli-39\nTomato-26\nOrange-2k-100\nPinapple-49\nApple-140'
const GROCERY = [
  'DATE     14/15', '',
  'PROUDY DETERGENT POWDER 1.5KG     84.90',
  'FEBI DISH WASH 500ML  44.90',
  'AAMBAL HAND WASH B1G1  97.90',
  'BLISSBURRY BABY PANT NB42/S40/M32/L28/XL22    249.90',
  'MALKIST CHEESE BISCUITS 150GM  37.90    45',
].join('\n')
const TODAY = '2026-11-10' // a Tuesday

describe('spotting a price list', () => {
  it('reads the ways clients write a priced product', () => {
    for (const l of ['Tomato-26', 'Laddu   69', 'APPLE 149/-', 'BANANA MYSORE 39', 'FEBI DISH WASH 500ML  44.90', 'Rice Rs 55', 'ചിറ്റി ഉള്ളി 39']) {
      expect(isPriceLine(l), l).toBe(true)
    }
  })
  it('does not take ordinary lines for prices', () => {
    for (const l of ['Please check', 'DATE 14/15', 'Call me on 9876543210', '139', 'Any other changes?', 'SANTOOR SOAP 75GM 4PCS']) {
      expect(isPriceLine(l), l).toBe(false)
    }
  })
  it('counts the products of a real list', () => {
    expect(priceListSize(VEG)).toBe(6)
    expect(priceListSize(GROCERY)).toBe(5)
  })
  it('needs several priced lines, and mostly priced lines', () => {
    expect(priceListSize('Tomato-26\nApple-140')).toBe(0)
    expect(priceListSize('Poster ayo')).toBe(0)
    expect(priceListSize(`Hello\nWe changed a few things\nplease look\nand reply\nthanks\n${VEG.split('\n').slice(0, 4).join('\n')}\nok\nbye\nsee you`)).toBe(0)
  })
})

describe('the offer date', () => {
  it('is the next day when the client gives none', () => {
    expect(offerDates(VEG, TODAY)).toEqual({ start: '2026-11-11', end: null, given: false })
    expect(offerDates(VEG, '2026-11-30')).toEqual({ start: '2026-12-01', end: null, given: false })
  })
  it('reads "DATE 14/15" as two days of the month, not day/month', () => {
    expect(offerDates(GROCERY, TODAY)).toEqual({ start: '2026-11-14', end: '2026-11-15', given: true })
  })
  it('reads a bare day list above the products', () => {
    expect(offerDates(`12/13\n${VEG}`, TODAY)).toEqual({ start: '2026-11-12', end: '2026-11-13', given: true })
  })
  it('rolls into next month when the day has passed', () => {
    expect(parseDateHint('2/3', '2026-11-28')).toEqual({ start: '2026-12-02', end: '2026-12-03' })
    expect(parseDateHint('30/31/1', '2026-12-29')).toEqual({ start: '2026-12-30', end: '2027-01-01' })
  })
  it('reads day/month and full dates', () => {
    expect(parseDateHint('14/11', TODAY)).toEqual({ start: '2026-11-14', end: null })
    expect(parseDateHint('14-11-2026', TODAY)).toEqual({ start: '2026-11-14', end: null })
  })
  it('reads Malayalam and English words', () => {
    expect(parseDateHint('നാളെ', TODAY)?.start).toBe('2026-11-11')
    expect(parseDateHint('Tomorrow', TODAY)?.start).toBe('2026-11-11')
    expect(parseDateHint('ഇന്ന്', TODAY)?.start).toBe('2026-11-10')
    expect(parseDateHint('ശനി ഞായർ', TODAY)).toEqual({ start: '2026-11-14', end: '2026-11-15' })
    expect(parseDateHint('Thursday', TODAY)).toEqual({ start: '2026-11-12', end: null })
  })
  it('says nothing when there is no date', () => {
    for (const t of ['Please check', 'ok', '139', 'Uner Kava', '']) expect(parseDateHint(t, TODAY), t).toBeNull()
  })
})

describe('a date sent as its own message', () => {
  it('is recognised', () => {
    expect(dateOnlyMessage('29/30', '2026-10-28')).toEqual({ start: '2026-10-29', end: '2026-10-30' })
    expect(dateOnlyMessage('29/30/31', '2026-10-28')).toEqual({ start: '2026-10-29', end: '2026-10-31' })
    expect(dateOnlyMessage('നാളെ', TODAY)?.start).toBe('2026-11-11')
    expect(dateOnlyMessage('Date 14', TODAY)?.start).toBe('2026-11-14')
  })
  it('reads the ways Sea Star really writes it', () => {
    expect(dateOnlyMessage('3&4', '2026-09-02')).toEqual({ start: '2026-09-03', end: '2026-09-04' })
    expect(dateOnlyMessage('Sat and sun', '2026-09-04')).toEqual({ start: '2026-09-05', end: '2026-09-06' })
    expect(dateOnlyMessage('DATE 2/10/26', '2026-09-30')).toEqual({ start: '2026-10-02', end: null })
    expect(dateOnlyMessage('Sunday 3 page', '2026-09-19')?.start).toBe('2026-09-20')
  })
  it('does not take talk that mentions a day for an offer date', () => {
    for (const t of ['Before Thursday night kittiya mathi', 'Design vechit naley ayacha mathi', 'Innu complete aakalley', 'Tuesday final out venam']) {
      expect(dateOnlyMessage(t, TODAY), t).toBeNull()
    }
  })
  it('ignores a lone number, a list and ordinary chat', () => {
    expect(dateOnlyMessage('19', TODAY)).toBeNull()
    expect(dateOnlyMessage(VEG, TODAY)).toBeNull()
    expect(dateOnlyMessage('Poster ayo', TODAY)).toBeNull()
  })
})

describe('the notes on the calendar item', () => {
  const base = { list: VEG, client: 'Bismi Supermarket', sender: 'A', products: 6, messageId: 'MSG1', chatId: '1203@g.us' }
  it('carries the list, where it came from and the markers used to find it again', () => {
    const notes = offerNotes({ ...base, dates: offerDates(VEG, TODAY) })
    expect(notes).toContain('Tomato-26')
    expect(notes).toContain('Bismi Supermarket')
    expect(notes).toContain(DATE_ASSUMED_LINE)
    expect(notes).toContain(messageMarker('MSG1'))
    expect(notes).toContain(chatMarker('1203@g.us'))
  })
  it('states a date the client gave', () => {
    const notes = offerNotes({ ...base, list: GROCERY, dates: offerDates(GROCERY, TODAY) })
    expect(notes).toContain('Offer date: 14 Nov to 15 Nov (given by the client).')
    expect(notes).not.toContain(DATE_ASSUMED_LINE)
  })
  it('warns when the list was read off a photo', () => {
    expect(offerNotes({ ...base, dates: offerDates(VEG, TODAY), fromPhoto: true })).toContain('Read by AI from a photo')
    expect(offerNotes({ ...base, dates: offerDates(VEG, TODAY) })).not.toContain('from a photo')
  })
  it('is corrected when the date arrives later', () => {
    const notes = notesWithDate(offerNotes({ ...base, dates: offerDates(VEG, TODAY) }), { start: '2026-11-14', end: null })
    expect(notes).not.toContain(DATE_ASSUMED_LINE)
    expect(notes).toContain('Offer date: 14 Nov (given by the client in a later message).')
  })
})

describe('products sent a few at a time', () => {
  it('takes one to three priced lines as an addition to the list', () => {
    for (const t of ['Ador price 289', 'BANANA MYSORE 39', 'APPLE 149/-', 'Lotte chocopie 109\nMilkymist paneer 109\nMilkymist curd 119', 'Sahya Tea-99']) {
      expect(isSmallAddition(t), t).toBe(true)
    }
  })
  it('leaves talk, bare numbers and full lists alone', () => {
    for (const t of ['Please check', '139', 'Image please', VEG, 'Mysore pak\nBuy1 get 2']) expect(isSmallAddition(t), t).toBe(false)
  })
  it('adds it to the notes once, keeping the markers that find the item', () => {
    const base = offerNotes({ list: VEG, client: 'Mazra', sender: '', products: 6, dates: offerDates(VEG, TODAY), messageId: 'M1', chatId: 'c@g.us' })
    const notes = notesWithAddition(base, 'APPLE 149/-', 'M2')
    expect(notes).toContain('APPLE 149/-')
    expect(notes).toContain(additionMarker('M2'))
    expect(notes).toContain(chatMarker('c@g.us'))
    expect(notes).toContain(DATE_ASSUMED_LINE)
  })
})

describe('the date line as Goodwill types it', () => {
  it('reads "Date2 to 10" without the space', () => {
    expect(dateOnlyMessage('Date2 to 10', '2026-09-01')).toEqual({ start: '2026-09-02', end: '2026-09-10' })
  })
})
