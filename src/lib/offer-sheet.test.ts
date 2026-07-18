import { describe, expect, it } from 'vitest'
import { OFFER_SHEET_HEADERS, buildOfferSheetRows, offerSheetTsv, offerSheetCsv } from './offer-sheet'

describe('offer sheet output', () => {
  it('keeps the Figma columns stable and sorts products by page then display order', () => {
    const rows = buildOfferSheetRows({
      clientName: 'B.N. Mart',
      offerTitle: 'Weekend Offer',
      offerDate: '19 Jul 2026',
      products: [
        { name: 'Rice', page: 2, display_order: 1, price: 80, badges: [{ custom_label: 'Hot' }] },
        { name: 'Tea', weight: '250 g', page: 1, display_order: 3, price: 120, offer_type: 'bogo' },
      ],
    })

    expect(rows).toEqual([
      ['1', '4', 'Tea', '250 g', 'bogo', '120', '', 'Buy 1 Get 1', '', '', 'Weekend Offer', '19 Jul 2026', 'B.N. Mart', '120', ''],
      ['2', '2', 'Rice', '', 'price', '80', '', '', 'Hot', '', 'Weekend Offer', '19 Jul 2026', 'B.N. Mart', '80', ''],
    ])
    expect(offerSheetTsv(rows).split('\n')[0]).toBe(OFFER_SHEET_HEADERS.join('\t'))
  })

  it('splits prices into Price 1 / Price 2 for the two-layer design', () => {
    const rows = buildOfferSheetRows({
      clientName: 'Mart',
      products: [
        { name: 'Ghee', display_order: 0, price: 20.99 },
        { name: 'Oil', display_order: 1, price: 20.5 },
        { name: 'Salt', display_order: 2, price: 20 },
        { name: 'TBD', display_order: 3, price: null },
      ],
    })
    const tail = rows.map(r => r.slice(-2))
    expect(tail).toEqual([
      ['20', '99'], // paise as its own smaller design layer
      ['20', '50'], // .5 → 50 paise, always two digits
      ['20', ''],   // whole price → Price 2 blank, not "00"
      ['', ''],     // no price yet
    ])
    // Price 1 / Price 2 are APPENDED — the original 13 columns keep their order.
    expect(OFFER_SHEET_HEADERS.slice(-2)).toEqual(['Price 1', 'Price 2'])
    expect(OFFER_SHEET_HEADERS[5]).toBe('Offer Price')
  })

  it('removes tabs and new lines so pasted rows cannot break the sheet', () => {
    const tsv = offerSheetTsv([['1', '1', 'Tea\nGold', '', 'price', '50\t00', '', '', '', '', '', '', '']])
    expect(tsv.split('\n')).toHaveLength(2)
    expect(tsv).toContain('Tea Gold\t')
    expect(tsv).toContain('50 00')
  })

  it('produces CSV with the same frozen headers and RFC-4180 line endings', () => {
    const csv = offerSheetCsv([['1', '1', 'Tea', '', 'price', '50', '', '', '', '', '', '', '']])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(OFFER_SHEET_HEADERS.join(','))
    expect(lines[1]).toBe('1,1,Tea,,price,50,,,,,,,')
  })

  it('quotes CSV cells containing commas, quotes, or newlines', () => {
    const csv = offerSheetCsv(
      [['1', '1', 'Rice, Basmati', '', 'other', '', '', 'Say "hi"', 'A\nB', '', '', '', '']],
      false,
    )
    // comma → quoted; embedded quote → doubled + quoted; newline → quoted.
    expect(csv).toContain('"Rice, Basmati"')
    expect(csv).toContain('"Say ""hi"""')
    expect(csv).toContain('"A\nB"')
  })

  it('neutralizes CSV formula-injection prefixes but leaves normal cells alone', () => {
    const csv = offerSheetCsv(
      [['1', '1', '=HYPERLINK("x")', '', 'other', '', '', '@cmd', '+val', '', 'Weekend', '', 'Mart']],
      false,
    )
    // = and @ and + starting cells get a leading apostrophe (and the = cell is
    // also quoted because it contains a comma).
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(csv).toContain(`'@cmd`)
    expect(csv).toContain(`'+val`)
    // Ordinary text is untouched.
    expect(csv).toContain(',Weekend,')
    expect(csv).toContain(',Mart')
  })
})
