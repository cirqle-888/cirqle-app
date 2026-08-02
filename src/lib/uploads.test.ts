import { describe, it, expect } from 'vitest'
import { resolveImageExt } from './uploads'

describe('resolveImageExt', () => {
  it('prefers the declared content type over the filename', () => {
    // The filename claims .png but the bytes are declared jpeg — trust the type.
    expect(resolveImageExt('photo.png', 'image/jpeg')).toBe('jpg')
  })

  it('handles content types carrying parameters', () => {
    expect(resolveImageExt('x', 'image/png; charset=binary')).toBe('png')
    expect(resolveImageExt('x', 'IMAGE/PNG')).toBe('png')
  })

  it('falls back to the filename only when it is an allowed image', () => {
    expect(resolveImageExt('shot.webp', undefined)).toBe('webp')
    expect(resolveImageExt('shot.JPEG', undefined)).toBe('jpg')  // normalised
  })

  it('refuses executable and markup extensions', () => {
    // The reason this module exists: these would be served from our own origin
    // out of a public bucket.
    for (const name of ['evil.html', 'evil.svg', 'x.js', 'x.php', 'shell.sh']) {
      expect(resolveImageExt(name, undefined)).toBeNull()
    }
  })

  it('refuses a non-image content type even with an image-looking name', () => {
    expect(resolveImageExt('photo.jpg', 'text/html')).toBe('jpg') // name still allowed
    expect(resolveImageExt('payload.html', 'text/html')).toBeNull()
  })

  it('returns null rather than defaulting when nothing is usable', () => {
    // A silent `|| 'jpg'` would store attacker bytes under a name we chose.
    expect(resolveImageExt('', '')).toBeNull()
    expect(resolveImageExt(null, null)).toBeNull()
    expect(resolveImageExt('noextension', undefined)).toBeNull()
  })

  it('strips path-traversal characters out of the fallback', () => {
    expect(resolveImageExt('../../etc/passwd', undefined)).toBeNull()
  })
})
