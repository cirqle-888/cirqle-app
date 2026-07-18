import { describe, expect, it } from 'vitest'
import { formatProductName } from './format-product-name'

describe('formatProductName', () => {
  it('uppercases everything in upper mode', () => {
    expect(formatProductName('bru coffee 200gm', 'upper')).toBe('BRU COFFEE 200GM')
  })

  it('sentence mode capitalises only the first letter', () => {
    expect(formatProductName('UNIBIC CASHEW BADAM COOKIES', 'sentence')).toBe('Unibic cashew badam cookies')
  })

  it('title mode capitalises words but keeps connector words lowercase', () => {
    expect(formatProductName('RICE AND SUGAR WITH FREE GIFT', 'title')).toBe('Rice and Sugar with Free Gift')
  })

  it('title mode keeps measurement tokens lowercase', () => {
    expect(formatProductName('EASTERN CHILLI POWDER 500GM', 'title')).toBe('Eastern Chilli Powder 500gm')
    expect(formatProductName('nanma vinegar 1LTR', 'title')).toBe('Nanma Vinegar 1ltr')
    expect(formatProductName('santoor soap 75g 4PCS', 'title')).toBe('Santoor Soap 75g 4pcs')
  })

  it('title mode capitalises after separators in compound names', () => {
    expect(formatProductName('priyas lime/mango/dates pickle', 'title')).toBe('Priyas Lime/Mango/Dates Pickle')
    expect(formatProductName('unibic fruit & nut cookies', 'title')).toBe('Unibic Fruit & Nut Cookies')
    expect(formatProductName('multi-grain atta', 'title')).toBe('Multi-Grain Atta')
  })

  it('a leading connector word is still capitalised', () => {
    expect(formatProductName('the coffee house blend', 'title')).toBe('The Coffee House Blend')
  })

  it('collapses extra whitespace and preserves empty input', () => {
    expect(formatProductName('  bru   coffee  ', 'title')).toBe('Bru Coffee')
    expect(formatProductName('   ', 'upper')).toBe('   ')
  })
})
