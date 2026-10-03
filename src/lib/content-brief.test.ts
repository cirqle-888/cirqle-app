import { describe, it, expect } from 'vitest'
import {
  normalizeContentBrief, contentBriefToText, cleanBriefLinks, cleanImageUrls,
  asContentBrief, briefToDraft, linkDisplay,
} from './content-brief'

describe('normalizeContentBrief', () => {
  it('returns null when nothing is filled in', () => {
    expect(normalizeContentBrief(null)).toBeNull()
    expect(normalizeContentBrief({ contentType: '', caption: '<p><br></p>', notes: '  ', links: [{ label: 'x', url: '' }] })).toBeNull()
  })

  it('keeps allowed formatting and strips scripts / handlers', () => {
    const b = normalizeContentBrief({ caption: '<p><b>Big</b> sale<script>alert(1)</script><img src=x onerror=alert(1)></p>' })!
    expect(b.caption).toContain('<b>Big</b>')
    expect(b.caption).not.toMatch(/script|onerror|<img/i)
  })

  it('drops unknown content types but keeps known ones', () => {
    expect(normalizeContentBrief({ contentType: 'reel', notes: 'x' })!.contentType).toBe('reel')
    expect(normalizeContentBrief({ contentType: 'hologram', notes: 'x' })!.contentType).toBeNull()
  })

  it('is lossless for a brief that is already clean (calendar → request round trip)', () => {
    const first = normalizeContentBrief({
      contentType: 'post',
      caption: '<p>Onam <b>offers</b></p><ul><li>Rice 5kg</li></ul>',
      referenceImages: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
      notes: 'Use the green palette',
      links: [{ label: 'Drive', url: 'https://drive.google.com/x' }],
    })!
    const second = normalizeContentBrief(first)!
    expect(second).toEqual(first)
    expect(normalizeContentBrief(briefToDraft(first))).toEqual(first)
  })
})

describe('links and images', () => {
  it('accepts http(s), adds https:// to bare hosts, rejects other schemes, de-duplicates', () => {
    const out = cleanBriefLinks([
      { label: 'Canva', url: 'canva.com/design/1' },
      { label: '', url: 'javascript:alert(1)' },
      { label: 'dupe', url: 'https://canva.com/design/1' },
      { label: '', url: 'ftp://x.example/file' },
    ])
    expect(out).toEqual([{ label: 'Canva', url: 'https://canva.com/design/1' }])
  })

  it('normalises image URLs so they cannot break out of src=""', () => {
    const [u] = cleanImageUrls(['http://x.example/a.png" onerror="alert(1)'])
    expect(u).not.toContain('"')
  })

  it('caps images at 8', () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://x.example/${i}.png`)
    expect(cleanImageUrls(urls)).toHaveLength(8)
  })

  it('shows a link by its label, else its host', () => {
    expect(linkDisplay({ label: 'Brand kit', url: 'https://drive.google.com/x' })).toBe('Brand kit')
    expect(linkDisplay({ label: '', url: 'https://www.canva.com/d/1' })).toBe('canva.com')
  })
})

describe('contentBriefToText — the plain-text copy in description', () => {
  it('carries every part of the brief', () => {
    const b = normalizeContentBrief({
      contentType: 'poster',
      caption: '<p>Fresh fish daily</p><ol><li>Seer</li><li>Pomfret</li></ol>',
      referenceImages: ['https://cdn.example/a.png'],
      notes: 'Blue background',
      links: [{ label: 'Menu', url: 'https://example.com/menu' }],
    })!
    const text = contentBriefToText(b)
    expect(text).toContain('Content type: Poster')
    expect(text).toContain('Caption / copy:\nFresh fish daily')
    expect(text).toContain('1. Seer')
    expect(text).toContain('Notes for designer:\nBlue background')
    expect(text).toContain('Reference image:\nhttps://cdn.example/a.png')
    expect(text).toContain('Links:\nMenu — https://example.com/menu')
  })
})

describe('asContentBrief', () => {
  it('rejects anything that is not a v1 brief', () => {
    expect(asContentBrief(null)).toBeNull()
    expect(asContentBrief({ caption: 'x' })).toBeNull()
    expect(asContentBrief('nope')).toBeNull()
  })
  it('reads a stored brief back', () => {
    const b = normalizeContentBrief({ notes: 'hi', links: [{ label: '', url: 'https://a.example' }] })!
    expect(asContentBrief(JSON.parse(JSON.stringify(b)))).toEqual(b)
  })
})
