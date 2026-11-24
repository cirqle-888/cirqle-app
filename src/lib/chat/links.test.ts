import { describe, it, expect } from 'vitest'
import { splitLinks, extractUrls, isPrivateIp, isBlockedHost, parsePreview } from './links'

describe('links in messages', () => {
  it('splits text and links and drops sentence punctuation', () => {
    expect(splitLinks('See https://cirqle.work/a?b=1, then reply.')).toEqual([
      { type: 'text', text: 'See ' },
      { type: 'link', text: 'https://cirqle.work/a?b=1', url: 'https://cirqle.work/a?b=1' },
      { type: 'text', text: ', then reply.' },
    ])
    expect(extractUrls('(https://a.com/x) and http://b.org.')).toEqual(['https://a.com/x', 'http://b.org'])
    expect(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
    expect(splitLinks('no links here')).toEqual([{ type: 'text', text: 'no links here' }])
  })

  it('refuses private and local addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.9', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1', '100.64.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true)
    }
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('172.32.0.1')).toBe(false)
    for (const h of ['localhost', 'db.internal', 'printer.local', 'intranet', '10.0.0.5', '[::1]']) expect(isBlockedHost(h), h).toBe(true)
    expect(isBlockedHost('cirqle.work')).toBe(false)
    expect(isBlockedHost('8.8.8.8')).toBe(false)
  })

  it('reads a preview from the page head', () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Sea Star &amp; Co">
      <meta content="Fresh catering" name="description">
      <meta property="og:image" content="/img/cover.jpg"></head></html>`
    expect(parsePreview(html, 'https://www.seastar.example/menu')).toEqual({
      url: 'https://www.seastar.example/menu', title: 'Sea Star & Co', description: 'Fresh catering',
      image: 'https://www.seastar.example/img/cover.jpg', site: 'seastar.example',
    })
    expect(parsePreview('<html><head></head></html>', 'https://a.com')).toBeNull()
    expect(parsePreview('<title>T</title><meta property="og:image" content="http://a.com/x.png">', 'https://a.com')?.image).toBeNull()
  })
})
