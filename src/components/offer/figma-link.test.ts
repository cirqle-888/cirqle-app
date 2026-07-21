import { describe, it, expect } from 'vitest'
import { figmaDesktopUrl } from './figma-link'

describe('figmaDesktopUrl', () => {
  it('swaps the origin for the figma:// scheme', () => {
    expect(figmaDesktopUrl('https://www.figma.com/design/ABC123/BN-MART-JULY-2026'))
      .toBe('figma://design/ABC123/BN-MART-JULY-2026')
  })

  it('keeps the query so a link to one frame still lands on that frame', () => {
    expect(figmaDesktopUrl('https://www.figma.com/design/ABC/Name?node-id=12-34&t=xyz'))
      .toBe('figma://design/ABC/Name?node-id=12-34&t=xyz')
  })

  it('handles the older /file/ urls and the bare domain', () => {
    expect(figmaDesktopUrl('https://figma.com/file/K/Old')).toBe('figma://file/K/Old')
  })

  it('refuses anything that is not figma.com', () => {
    // A look-alike host must never be turned into a protocol handoff.
    expect(figmaDesktopUrl('https://figma.com.evil.test/design/K/N')).toBeNull()
    expect(figmaDesktopUrl('https://notfigma.com/design/K/N')).toBeNull()
    expect(figmaDesktopUrl('not a url')).toBeNull()
  })
})
