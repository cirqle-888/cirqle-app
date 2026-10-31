import { expect, it } from 'vitest'
import { TEMPLATES } from './templates'
import { quickLookValues, applyQuickLook } from './quick-looks'
it('keeps appearance, cleared choices and notes but excludes product content and unknown fields', () => {
  const t = TEMPLATES.find(t => t.key === 'flyer-product-direct')!
  const saved = quickLookValues(t, { product: 'Rice', angleOn: 'yes', angleWords: 'slightly left', unexpected: 'blob:photo' })
  expect(saved.product).toBeUndefined()
  expect(saved.unexpected).toBeUndefined()
  expect(saved.angleWords).toBe('slightly left')
  const applied = applyQuickLook(t, { product: 'Soap', shadowOn: 'yes', shadowWords: 'old shadow' }, saved)
  expect(applied.product).toBe('Soap')
  expect(applied.shadowOn).toBe('')
  expect(applied.shadowWords).toBe('')
})
it('preserves new headlines and explicitly cleared defaults', () => {
  const t = TEMPLATES.find(t => t.key === 'flyer-text-effect')!
  const saved = quickLookValues(t, { text: 'Old headline', subline: 'Old dates', effect: '' })
  const applied = applyQuickLook(t, { text: 'New headline', subline: 'New dates' }, saved)
  expect(applied.text).toBe('New headline')
  expect(applied.subline).toBe('New dates')
  expect(applied.effect).toBe('')
})
