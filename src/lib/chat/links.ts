/**
 * Links inside chat messages: finding them, and reading a page's preview
 * (title, description, picture) safely.
 *
 * The preview is fetched by OUR server, so the address must be checked first —
 * otherwise a pasted link could make the server call private machines
 * (localhost, 10.x, the cloud metadata address). isBlockedHost / isPrivateIp
 * are that check; lib/chat/link-preview.ts applies them to the resolved IPs.
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi
/** Punctuation that ends a sentence, not a link. */
const TRAILING = /[.,;:!?)\]}'"]+$/

export type TextSegment = { type: 'text'; text: string } | { type: 'link'; text: string; url: string }

function cleanUrl(raw: string): string {
  let url = raw.replace(TRAILING, '')
  // Keep a closing bracket that belongs to the address, e.g. …/Foo_(bar)
  const opens = (url.match(/\(/g) ?? []).length, closes = (url.match(/\)/g) ?? []).length
  if (raw.length > url.length && raw[url.length] === ')' && opens > closes) url += ')'
  return url
}

/** Split a message into plain text and links, in order. */
export function splitLinks(text: string): TextSegment[] {
  const out: TextSegment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0])
    const start = m.index ?? 0
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) })
    out.push({ type: 'link', text: url, url })
    last = start + url.length
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) })
  return out
}

export function extractUrls(text: string): string[] {
  return splitLinks(text).filter((s): s is Extract<TextSegment, { type: 'link' }> => s.type === 'link').map(s => s.url)
}

export function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  const v6 = ip.toLowerCase()
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9')
    || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff')
}

/** Addresses we never fetch, judged from the name alone (before DNS). */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^[\d.]+$/.test(h) || h.includes(':')) return isPrivateIp(h)
  return !h.includes('.')
}

export interface LinkPreview {
  url: string
  title: string
  description: string | null
  image: string | null
  site: string | null
}

const decode = (s: string) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/\s+/g, ' ').trim()

function metaContent(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i'))?.[0]
      ?? html.match(new RegExp(`<meta[^>]+content=["'][^"']*["'][^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i'))?.[0]
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1]
    if (content?.trim()) return decode(content)
  }
  return null
}

/** Read a page's preview from its HTML head. Null when it has no usable title. */
export function parsePreview(html: string, pageUrl: string): LinkPreview | null {
  const head = html.slice(0, 200_000)
  const title = metaContent(head, ['og:title', 'twitter:title']) ?? (head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ? decode(head.match(/<title[^>]*>([^<]*)<\/title>/i)![1]) : null)
  if (!title) return null
  let image = metaContent(head, ['og:image', 'og:image:url', 'twitter:image'])
  if (image) {
    try {
      const abs = new URL(image, pageUrl)
      image = abs.protocol === 'https:' ? abs.toString() : null
    } catch { image = null }
  }
  let site = metaContent(head, ['og:site_name'])
  if (!site) { try { site = new URL(pageUrl).hostname.replace(/^www\./, '') } catch { site = null } }
  return {
    url: pageUrl,
    title: title.slice(0, 200),
    description: metaContent(head, ['og:description', 'twitter:description', 'description'])?.slice(0, 300) ?? null,
    image,
    site,
  }
}
