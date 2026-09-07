import { describe, it, expect } from 'vitest'
import { formatsFor, WORK_FORMATS, WORK_FORMAT_LABEL } from './types'

describe('formatsFor', () => {
  it('offers only the social types on a social collection', () => {
    expect(formatsFor('social-media')).toEqual(['post', 'reel', 'story'])
  })

  it('offers only the identity types on brand identity, so a logo cannot be filed as a story', () => {
    expect(formatsFor('brand-identity')).toEqual(['logo', 'guidelines', 'brandbook', 'chart'])
  })

  it('falls back to every format for a collection it does not know', () => {
    expect(formatsFor('something-new')).toEqual(WORK_FORMATS)
    expect(formatsFor(undefined)).toEqual(WORK_FORMATS)
  })

  it('labels every format, so no dropdown can render a blank option', () => {
    for (const format of WORK_FORMATS) expect(WORK_FORMAT_LABEL[format]).toBeTruthy()
  })
})
