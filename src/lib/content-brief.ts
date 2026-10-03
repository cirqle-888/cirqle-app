/**
 * Content Brief — the one shape both planning surfaces write.
 *
 * The Social Calendar ("Plan an item") and Requests ("New design request")
 * both brief a designer on a piece of content, and used to collect it two
 * different ways: a rich caption + uploaded images on one side, plain text +
 * link fields on the other. Pushing a calendar item into Requests flattened
 * everything to text. A ContentBrief is the shared, lossless form:
 *
 *   calendar item  ──push──▶  task_requests.content_brief   (same object)
 *
 * Title stays on each row's own `title` column. Workflow fields (dates,
 * platforms, client, due date, priority…) stay on each page — this is only
 * the content.
 *
 * Plain-text consumers (Tasks prefill, client portal, share image) keep
 * reading `task_requests.description`, which is written alongside as the
 * text projection from contentBriefToText().
 */

import {
  CONTENT_TYPES, CONTENT_TYPE_LABEL,
  sanitizeCaptionHtml, captionHtmlToText,
  sanitizeCaptionCanvas, canvasToText, canvasImageUrls,
  type CaptionCanvas, type ContentType,
} from '@/lib/social/plan'

export interface BriefLink { label: string; url: string }

export interface ContentBrief {
  v: 1
  /** One of CONTENT_TYPES, or null when not set (requests may leave it). */
  contentType: string | null
  /** Sanitized rich caption HTML (the caption allowlist). */
  caption: string | null
  /** Optional free-drag layout board (Social Calendar's Canvas view). */
  captionCanvas: CaptionCanvas | null
  /** Public image URLs — uploads/pastes land in the social-refs bucket. */
  referenceImages: string[]
  notes: string | null
  links: BriefLink[]
}

/** What the form edits — everything optional/loose; normalised on save. */
export interface ContentBriefDraft {
  contentType: string
  caption: string
  captionCanvas: CaptionCanvas | null
  referenceImages: string[]
  notes: string
  links: BriefLink[]
}

export const EMPTY_BRIEF_DRAFT: ContentBriefDraft = {
  contentType: '', caption: '', captionCanvas: null, referenceImages: [], notes: '', links: [],
}

export const MAX_BRIEF_IMAGES = 8
export const MAX_BRIEF_LINKS = 10

/** Keep plausible public http(s) URLs only; normalise, de-duplicate, cap. */
export function cleanImageUrls(urls: readonly (string | null | undefined)[] | null | undefined, max = MAX_BRIEF_IMAGES): string[] {
  const out: string[] = []
  for (const raw of urls || []) {
    const t = raw?.trim()
    if (!t) continue
    try {
      const u = new URL(t)
      // Store the NORMALIZED href: `new URL()` accepts http://x/" onerror=…
      // and the raw form would break out of a src="…" attribute.
      if ((u.protocol === 'https:' || u.protocol === 'http:') && !out.includes(u.href)) out.push(u.href)
    } catch { /* not a URL */ }
  }
  return out.slice(0, max)
}

/** Links: http(s) only, normalised, label trimmed (defaults to the host). */
export function cleanBriefLinks(links: readonly Partial<BriefLink>[] | null | undefined): BriefLink[] {
  const out: BriefLink[] = []
  for (const l of links || []) {
    const raw = (l?.url || '').trim()
    if (!raw) continue
    // A bare host ("canva.com/d/1") gets https://; any OTHER scheme
    // (ftp:, javascript:, mailto:…) is rejected rather than rewritten.
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw)
    if (hasScheme && !/^https?:\/\//i.test(raw)) continue
    let href: string
    try {
      const u = new URL(hasScheme ? raw : `https://${raw}`)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
      href = u.href
    } catch { continue }
    if (out.some(x => x.url === href)) continue
    const label = (l?.label || '').trim().slice(0, 60)
    out.push({ label, url: href })
  }
  return out.slice(0, MAX_BRIEF_LINKS)
}

/** A short readable label for a link (its own label, else the host). */
export function linkDisplay(l: BriefLink): string {
  if (l.label) return l.label
  try { return new URL(l.url).hostname.replace(/^www\./, '') } catch { return l.url }
}

/**
 * Normalise anything brief-shaped into a safe ContentBrief, or null when it
 * carries nothing. Runs on the SERVER before every write.
 */
export function normalizeContentBrief(input: Partial<ContentBriefDraft> | ContentBrief | null | undefined): ContentBrief | null {
  if (!input) return null
  const type = (input.contentType || '').trim()
  const contentType = CONTENT_TYPES.includes(type as ContentType) ? type : null
  const safeCaption = sanitizeCaptionHtml(input.caption || '').trim()
  const caption = captionHtmlToText(safeCaption).trim() ? safeCaption : null
  const captionCanvas = sanitizeCaptionCanvas(input.captionCanvas)
  const referenceImages = cleanImageUrls(input.referenceImages)
  const notes = (input.notes || '').trim().slice(0, 4000) || null
  const links = cleanBriefLinks(input.links)
  const empty = !contentType && !caption && !(captionCanvas?.blocks.length) && !referenceImages.length && !notes && !links.length
  if (empty) return null
  return { v: 1, contentType, caption, captionCanvas: captionCanvas?.blocks.length ? captionCanvas : null, referenceImages, notes, links }
}

/** Runtime guard for a value read back from the database. */
export function asContentBrief(x: unknown): ContentBrief | null {
  if (!x || typeof x !== 'object') return null
  const b = x as Partial<ContentBrief>
  if (b.v !== 1) return null
  return {
    v: 1,
    contentType: typeof b.contentType === 'string' ? b.contentType : null,
    caption: typeof b.caption === 'string' ? b.caption : null,
    captionCanvas: sanitizeCaptionCanvas(b.captionCanvas),
    referenceImages: Array.isArray(b.referenceImages) ? b.referenceImages.filter((u): u is string => typeof u === 'string') : [],
    notes: typeof b.notes === 'string' ? b.notes : null,
    links: Array.isArray(b.links) ? b.links.filter((l): l is BriefLink => !!l && typeof (l as BriefLink).url === 'string') : [],
  }
}

/** Editable draft from a stored brief (or an empty one). */
export function briefToDraft(b: ContentBrief | null | undefined): ContentBriefDraft {
  if (!b) return { ...EMPTY_BRIEF_DRAFT }
  return {
    contentType: b.contentType ?? '',
    caption: b.caption ?? '',
    captionCanvas: b.captionCanvas ?? null,
    referenceImages: [...b.referenceImages],
    notes: b.notes ?? '',
    links: b.links.map(l => ({ ...l })),
  }
}

export function contentTypeLabel(t: string | null | undefined): string | null {
  if (!t) return null
  return (CONTENT_TYPE_LABEL as Record<string, string>)[t] ?? t
}

/**
 * Plain-text projection, written to task_requests.description for every
 * consumer that only reads text (Tasks prefill, client portal, share image).
 * Section style matches composeRequestDescription so both read the same.
 */
export function contentBriefToText(b: ContentBrief | null | undefined): string {
  if (!b) return ''
  const parts: string[] = []
  const type = contentTypeLabel(b.contentType)
  if (type) parts.push(`Content type: ${type}`)
  const caption = captionHtmlToText(b.caption).trim()
  if (caption) parts.push(`Caption / copy:\n${caption}`)
  if (b.notes?.trim()) parts.push(`Notes for designer:\n${b.notes.trim()}`)
  const board = canvasToText(b.captionCanvas)
  if (board) parts.push(`Layout board:\n${board}`)
  const refs = [...b.referenceImages, ...canvasImageUrls(b.captionCanvas)].filter((u, i, a) => a.indexOf(u) === i)
  if (refs.length) parts.push(`Reference image${refs.length > 1 ? 's' : ''}:\n${refs.join('\n')}`)
  if (b.links.length) parts.push(`Links:\n${b.links.map(l => (l.label ? `${l.label} — ${l.url}` : l.url)).join('\n')}`)
  return parts.join('\n\n')
}
