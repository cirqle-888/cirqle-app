import { describe, expect, it } from 'vitest'
import {
  OFFER_SHEET_HEADERS, DATE_FORMATS,
  buildOfferSheetRows, offerSheetTsv, offerSheetCsv,
  figmaLayerName, figmaBindingGuide,
} from './offer-sheet'

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
      ['1', '4', 'Tea', '250 g', 'bogo', '120', '', 'Buy 1 Get 1', '', '', 'Weekend Offer', '19 Jul 2026', 'B.N. Mart', '120', '', '', ''],
      ['2', '2', 'Rice', '', 'price', '80', '', '', 'Hot', '', 'Weekend Offer', '19 Jul 2026', 'B.N. Mart', '80', '', '', ''],
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
    const tail = rows.map(r => r.slice(13, 15))
    expect(tail).toEqual([
      ['20', '99'], // paise as its own smaller design layer
      ['20', '50'], // .5 → 50 paise, always two digits
      ['20', ''],   // whole price → Price 2 blank, not "00"
      ['', ''],     // no price yet
    ])
    // The frozen contract Figma binds against is the INDEX of each column.
    // Price 1/Price 2 must stay at 13/14 no matter what gets appended later.
    expect(OFFER_SHEET_HEADERS[13]).toBe('Price 1')
    expect(OFFER_SHEET_HEADERS[14]).toBe('Price 2')
    expect(OFFER_SHEET_HEADERS[5]).toBe('Offer Price')
  })

  it('leaves the two date columns blank when no dates are passed', () => {
    // Every existing caller omits `dates`; they must not start emitting text.
    const rows = buildOfferSheetRows({ clientName: 'Mart', products: [{ name: 'Tea', display_order: 0 }] })
    expect(rows[0].slice(-2)).toEqual(['', ''])
    expect(rows[0]).toHaveLength(OFFER_SHEET_HEADERS.length)
  })

  it('emits both bindable date styles from the campaign dates', () => {
    const rows = buildOfferSheetRows({
      clientName: 'Mart',
      dates: { date_type: 'range', offer_date_from: '2026-07-18', offer_date_to: '2026-07-20' },
      products: [{ name: 'Tea', display_order: 0 }],
    })
    expect(rows[0].slice(-2)).toEqual(['18, 19, 20 JULY 2026', 'July 18 – July 20 2026'])
  })
})

describe('figma layer names', () => {
  it('derives the plugin binding name from each column', () => {
    // Verified against BN MART JULY 2026, whose working PRODUCT component
    // contains a text layer literally named "#product".
    expect(figmaLayerName('Product')).toBe('#product')
    expect(figmaLayerName('Offer Price')).toBe('#offerprice')
    expect(figmaLayerName('Price 1')).toBe('#price1')
    expect(figmaLayerName('MRP')).toBe('#mrp')
    expect(figmaLayerName('Offer Date Display')).toBe('#offerdatedisplay')
  })

  it('covers every column and stays unique', () => {
    const guide = figmaBindingGuide()
    expect(guide).toHaveLength(OFFER_SHEET_HEADERS.length)
    // A duplicate would make two columns fight over the same layer.
    expect(new Set(guide.map(g => g.layer)).size).toBe(guide.length)
    expect(guide.every(g => g.layer.startsWith('#'))).toBe(true)
  })
})

describe('offer date formats', () => {
  const enumerated = DATE_FORMATS.enumerated
  const title = DATE_FORMATS.title

  it('formats a single day', () => {
    const d = { date_type: 'single', offer_date: '2026-07-19' }
    expect(enumerated(d)).toBe('19 JULY 2026')
    expect(title(d)).toBe('Offer valid on July 19 2026')
  })

  it('enumerates short same-month ranges and collapses long ones', () => {
    expect(enumerated({ date_type: 'range', offer_date_from: '2026-07-18', offer_date_to: '2026-07-20' }))
      .toBe('18, 19, 20 JULY 2026')
    // Five days is still readable as a list; six is not.
    expect(enumerated({ date_type: 'range', offer_date_from: '2026-07-18', offer_date_to: '2026-07-22' }))
      .toBe('18, 19, 20, 21, 22 JULY 2026')
    expect(enumerated({ date_type: 'range', offer_date_from: '2026-07-18', offer_date_to: '2026-07-25' }))
      .toBe('18 – 25 JULY 2026')
  })

  it('handles cross-month and cross-year ranges', () => {
    expect(enumerated({ date_type: 'range', offer_date_from: '2026-06-30', offer_date_to: '2026-07-02' }))
      .toBe('30 JUNE – 2 JULY 2026')
    expect(enumerated({ date_type: 'range', offer_date_from: '2025-12-30', offer_date_to: '2026-01-02' }))
      .toBe('30 DEC 2025 – 2 JAN 2026')
    expect(title({ date_type: 'range', offer_date_from: '2025-12-30', offer_date_to: '2026-01-02' }))
      .toBe('December 30 2025 – January 2 2026')
  })

  it('collapses a degenerate range to a single day', () => {
    // End missing, equal to start, or before it — a printed flyer must not say
    // "18 – 18 JULY" or run backwards.
    const same = { date_type: 'range', offer_date_from: '2026-07-18', offer_date_to: '2026-07-18' }
    const backwards = { date_type: 'range', offer_date_from: '2026-07-20', offer_date_to: '2026-07-18' }
    const openEnded = { date_type: 'range', offer_date_from: '2026-07-18', offer_date_to: null }
    for (const d of [same, backwards, openEnded]) {
      expect(enumerated(d)).toMatch(/^\d+ JULY 2026$/)
      expect(title(d)).toMatch(/^Offer valid on July \d+ 2026$/)
    }
  })

  it('returns empty for missing or malformed dates', () => {
    for (const d of [
      {},
      { date_type: 'single', offer_date: null },
      { date_type: 'single', offer_date: 'not-a-date' },
      { date_type: 'single', offer_date: '2026-13-01' },
      { date_type: 'range', offer_date_from: null, offer_date_to: '2026-07-20' },
    ]) {
      expect(enumerated(d)).toBe('')
      expect(title(d)).toBe('')
    }
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

  it('neutralizes formulas hidden behind leading whitespace', () => {
    // Importers trim before deciding if a cell is a formula, so " =..." is
    // still live code once pasted/imported.
    const csv = offerSheetCsv([['1', '1', ' =HYPERLINK("x")', '', 'other']], false)
    expect(csv).toContain(`"' =HYPERLINK(""x"")"`)
  })

  it('neutralizes formula-injection in the TSV copy path too', () => {
    // "Copy table" pastes straight into Google Sheets, where =IMPORTXML runs.
    const tsv = offerSheetTsv([['1', '1', '=IMPORTXML("evil","//x")', '', 'other']], false)
    expect(tsv).toContain(`'=IMPORTXML("evil","//x")`)
    // Ordinary product names stay clean.
    expect(offerSheetTsv([['1', '1', 'Tea']], false)).toBe('1\t1\tTea')
  })
})
