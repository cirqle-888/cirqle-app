import { it, expect } from 'vitest'
import { departmentSlug } from './mentions'

it('writes a department as a mention', () => {
  expect(departmentSlug('Social Media')).toBe('social-media')
  expect(departmentSlug('  Print & Offer Flyers ')).toBe('print-offer-flyers')
})
