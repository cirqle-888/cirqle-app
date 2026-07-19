import { describe, expect, it } from 'vitest'
import { parseSheetCsv } from './pull'

describe('parseSheetCsv', () => {
  it('reads the Groceries shape (Product | MRP | SALE)', () => {
    const csv = [
      'Product,MRP,SALE',
      'THAI VICTOR MALABAR PUTTU PODI 5 KG,447,279',
      'ROOKE BOND RED LABEL DUST 500 G,160,119',
      'AJMI CHICKEN MASALA  100 G,59.50,43',
    ].join('\n')

    expect(parseSheetCsv(csv)).toEqual([
      { name: 'THAI VICTOR MALABAR PUTTU PODI 5 KG', price: 279, mrp: 447, weight: null },
      { name: 'ROOKE BOND RED LABEL DUST 500 G', price: 119, mrp: 160, weight: null },
      { name: 'AJMI CHICKEN MASALA  100 G', price: 43, mrp: 59.5, weight: null },
    ])
  })

  it('reads the Vegetables shape (Item | Sale), which has no MRP', () => {
    const csv = ['Item,Sale', 'THAKKALI,16', 'KIZHANG,22', 'BEETROOT,40'].join('\n')
    expect(parseSheetCsv(csv)).toEqual([
      { name: 'THAKKALI', price: 16, mrp: null, weight: null },
      { name: 'KIZHANG', price: 22, mrp: null, weight: null },
      { name: 'BEETROOT', price: 40, mrp: null, weight: null },
    ])
  })

  it('matches headers case-insensitively, in any order, with aliases', () => {
    const csv = ['  Offer Price , Pack Size ,  ITEM NAME ,m.r.p', '99,1 kg,Sugar,120'].join('\n')
    expect(parseSheetCsv(csv)).toEqual([
      { name: 'Sugar', price: 99, mrp: 120, weight: '1 kg' },
    ])
  })

  it('finds the header when the sheet starts with a title or blank rows', () => {
    const csv = ['WEEKEND OFFER,,', ',,', 'Product,MRP,SALE', 'Rice,100,80'].join('\n')
    expect(parseSheetCsv(csv)).toEqual([{ name: 'Rice', price: 80, mrp: 100, weight: null }])
  })

  it('keeps commas inside quoted product names', () => {
    const csv = ['Product,SALE', '"Rice, Basmati 5kg",499'].join('\n')
    expect(parseSheetCsv(csv)).toEqual([{ name: 'Rice, Basmati 5kg', price: 499, mrp: null, weight: null }])
  })

  it('strips currency symbols and separators from prices', () => {
    const csv = ['Product,MRP,SALE', 'Ghee,"₹1,499.00","1,299/-"'].join('\n')
    expect(parseSheetCsv(csv)).toEqual([{ name: 'Ghee', price: 1299, mrp: 1499, weight: null }])
  })

  it('treats unparseable or zero prices as blank, not zero', () => {
    // A flyer must never advertise "₹0" because a cell said "TBD".
    const csv = ['Product,SALE', 'Coming Soon,TBD', 'Free Sample,0', 'Dash,-'].join('\n')
    expect(parseSheetCsv(csv).map(r => r.price)).toEqual([null, null, null])
  })

  it('skips nameless rows and stops at 500 products', () => {
    const withBlanks = ['Product,SALE', 'Rice,80', ',,', '   ,50', 'Oil,120'].join('\n')
    expect(parseSheetCsv(withBlanks).map(r => r.name)).toEqual(['Rice', 'Oil'])

    const huge = ['Product,SALE', ...Array.from({ length: 600 }, (_, i) => `P${i},10`)].join('\n')
    expect(parseSheetCsv(huge)).toHaveLength(500)
  })

  it('returns nothing for junk input instead of throwing', () => {
    expect(parseSheetCsv('')).toEqual([])
    expect(parseSheetCsv('just,some,values\n1,2,3')).toEqual([])
    expect(parseSheetCsv('<!doctype html><html>sign in</html>')).toEqual([])
  })
})
