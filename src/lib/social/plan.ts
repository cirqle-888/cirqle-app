/**
 * Social Media Calendar — pure domain helpers (no Supabase, unit-tested).
 *
 * The planner's one integration rule: a pushed item becomes a REAL
 * task_request (tagged via task_requests.social_meta) and from then on the
 * pipeline owns it — the calendar only *displays* live progress read through
 * the item → request → promoted-task join. resolveItemProgress() is that
 * single display mapping.
 */

// Every kind of deliverable the agency plans — social formats plus design,
// content and marketing work — so the canvas serves all services, not just
// social media.
export const CONTENT_TYPES = [
  'post', 'reel', 'story', 'carousel', 'video', 'flyer',
  'poster', 'blog', 'seo', 'ad', 'email', 'other',
] as const
export type ContentType = typeof CONTENT_TYPES[number]

export const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  post: 'Post', reel: 'Reel', story: 'Story', carousel: 'Carousel',
  video: 'Video', flyer: 'Flyer', poster: 'Poster', blog: 'Blog / Article',
  seo: 'SEO', ad: 'Ad Campaign', email: 'Email', other: 'Other',
}

/** Chip tint per content type (tailwind classes, house palette). */
export const CONTENT_TYPE_CHIP: Record<ContentType, string> = {
  post:     'bg-violet-500/15 text-violet-400 border-violet-500/25',
  reel:     'bg-pink-500/15 text-pink-400 border-pink-500/25',
  story:    'bg-amber-500/15 text-amber-500 border-amber-500/25',
  carousel: 'bg-sky-500/15 text-sky-400 border-sky-500/25',
  video:    'bg-red-500/15 text-red-400 border-red-500/25',
  flyer:    'bg-teal-500/15 text-teal-400 border-teal-500/25',
  poster:   'bg-emerald-500/15 text-emerald-500 border-emerald-500/25',
  blog:     'bg-indigo-500/15 text-indigo-400 border-indigo-500/25',
  seo:      'bg-lime-500/15 text-lime-600 border-lime-500/25',
  ad:       'bg-fuchsia-500/15 text-fuchsia-400 border-fuchsia-500/25',
  email:    'bg-cyan-500/15 text-cyan-500 border-cyan-500/25',
  other:    'bg-secondary text-muted-foreground border-border',
}

/** Types that make sense as size/format variants of a visual creative. */
export const VARIANT_TYPES: readonly ContentType[] = ['post', 'reel', 'story', 'carousel', 'video', 'flyer', 'poster']

export const PLATFORMS = ['instagram', 'facebook', 'youtube', 'linkedin', 'tiktok', 'x', 'whatsapp'] as const
export type Platform = typeof PLATFORMS[number]

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube',
  linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', whatsapp: 'WhatsApp',
}

/** Short badge text, e.g. "IG" — used on tight calendar cells. */
export const PLATFORM_SHORT: Record<Platform, string> = {
  instagram: 'IG', facebook: 'FB', youtube: 'YT',
  linkedin: 'LI', tiktok: 'TT', x: 'X', whatsapp: 'WA',
}

export function platformLabels(platforms: string[] | null | undefined, short = false): string {
  const map = short ? PLATFORM_SHORT : PLATFORM_LABEL
  return (platforms ?? [])
    .map(p => map[p as Platform] ?? p)
    .join(short ? '·' : ', ')
}

// ── Rich caption (bold / italic / underline / lists) ─────────────────────────
// The caption editor stores a small allowlisted HTML fragment so formatting
// survives into the PDF. Everything else (request briefs, Excel, search)
// consumes the plain-text projection.

// Allowed caption tags → the attributes each may keep. Everything else is
// dropped. This is the full formatting vocabulary the editor can produce:
// emphasis, lists, headings, quotes, links, and inline color/alignment spans.
const CAPTION_TAG_ATTRS: Record<string, readonly string[]> = {
  b: [], strong: [], i: [], em: [], u: [], s: [], strike: [], del: [], mark: [], br: [],
  ul: [], ol: [], li: ['style'],
  p: ['style'], div: ['style'], blockquote: [],
  h1: ['style'], h2: ['style'], h3: ['style'],
  a: ['href'], span: ['style'],
}

// Only these CSS properties survive on a kept element, and only with simple,
// harmless values — this is what makes allowing `style` safe.
const CAPTION_STYLE_PROPS = new Set(['color', 'background-color', 'text-align', 'font-weight', 'text-decoration'])

function sanitizeStyle(raw: string): string {
  return raw.split(';').map(decl => {
    const i = decl.indexOf(':')
    if (i < 0) return ''
    const prop = decl.slice(0, i).trim().toLowerCase()
    const val = decl.slice(i + 1).trim()
    if (!CAPTION_STYLE_PROPS.has(prop) || !val) return ''
    // Reject anything that could smuggle behaviour (url(), expression(), etc.).
    if (/[<>{}]|url\s*\(|expression|javascript:|@import|\/\*/i.test(val)) return ''
    // Values are simple color/keyword/percentage tokens only.
    if (!/^[#a-z0-9.,()%\s-]+$/i.test(val) || val.length > 64) return ''
    return `${prop}:${val}`
  }).filter(Boolean).join(';')
}

/**
 * Reduce editor HTML to the safe caption subset. Keeps the allowlisted tags and,
 * per tag, only safe attributes: `href` on links restricted to http(s)/mailto,
 * and a `style` reduced to a handful of harmless CSS properties. Scripts, event
 * handlers, images, iframes, javascript: URLs and all other attributes are
 * removed. Plain text passes through untouched.
 */
// Matches ANY tag: the name, then everything up to the closing ">" while
// respecting quoted attribute values. Deliberately tolerant of what separates
// the name from its attributes — browsers parse `<img/src=x onerror=…>` as a
// real img tag, and a pattern that demanded whitespace there would fail to
// match it at all, passing the whole tag through unsanitized.
const CAPTION_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g

// Read one attribute out of a raw attribute run. The name must sit on a
// boundary (start / whitespace / "/") so `data-href=` can't be read as `href`.
function captionAttr(attrs: string, name: string): string {
  const m = new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s/>]+))`, 'i').exec(attrs)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : ''
}

export function sanitizeCaptionHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(CAPTION_TAG_RE, (_m, slash: string, rawTag: string, attrs: string) => {
      const tag = rawTag.toLowerCase()
      const allowed = CAPTION_TAG_ATTRS[tag]
      if (!allowed) return ''            // tag not allowed → drop the tag (keep inner text)
      if (slash) return `</${tag}>`
      let kept = ''
      if (allowed.includes('href')) {
        const href = captionAttr(attrs, 'href').trim()
        if (/^(https?:|mailto:)/i.test(href)) kept += ` href="${href.replace(/"/g, '&quot;')}"`
      }
      if (allowed.includes('style')) {
        const safe = sanitizeStyle(captionAttr(attrs, 'style'))
        if (safe) kept += ` style="${safe}"`
      }
      return `<${tag}${kept}>`
    })
}

/**
 * Plain-text projection of a (possibly rich) caption: bullets become "• ",
 * numbered items "1. ", block boundaries become newlines. Legacy plain-text
 * captions come back unchanged.
 */
export function captionHtmlToText(html: string | null | undefined): string {
  if (!html) return ''
  if (!/[<>]/.test(html)) return html // legacy plain text — untouched
  let text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
  // Numbered lists count their own items; bullet lists get "• ".
  text = text.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, body: string) => {
    let n = 0
    return body.replace(/<li[^>]*>/gi, () => `\n${++n}. `)
  })
  text = text
    .replace(/<li[^>]*>/gi, '\n• ')
    // </li> emits nothing — the NEXT <li> (or the list's close) provides the
    // line break; emitting here doubled every gap between items.
    .replace(/<\/(p|div|ul|ol|h1|h2|h3|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
  return text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim()
}

// ── Caption canvas (free-drag visual board) ──────────────────────────────────
// A second, optional view of an item's copy: images and short text labels
// positioned anywhere on a fixed-size board. Coordinates live in a FIXED
// design space so the editor and the PDF lay the board out identically —
// the PDF simply scales the whole board into the Content column.

/** Design-space width every canvas is authored and stored in. */
export const CANVAS_W = 640
/** Default board height; a board may grow taller, never wider. */
export const CANVAS_H = 360
/**
 * Hard ceiling on board height, derived from what the PDF can actually show.
 *
 * The board is scaled by (Content column 400px - 16px padding) / 640 = 0.6 in
 * the plan PDF, and a page has 1032px of usable height minus ~140px of row and
 * header chrome. 1200 × 0.6 = 720px, which fits comfortably. Going higher lets
 * a single row exceed a page — and the greedy paginator places an oversized row
 * anyway, so the overflow is silently CLIPPED out of the client's deliverable.
 */
export const CANVAS_MAX_H = 1200
/** Cap on blocks per board — a planning aid, not a design tool. */
export const CANVAS_MAX_BLOCKS = 40
const CANVAS_MIN_SIZE = 16
const CANVAS_MAX_TEXT = 400

export interface CanvasTextBlock {
  id: string; type: 'text'
  x: number; y: number; w: number; h: number; z: number
  text: string
  size?: number; bold?: boolean; color?: string
  align?: 'left' | 'center' | 'right'
}
export interface CanvasImageBlock {
  id: string; type: 'image'
  x: number; y: number; w: number; h: number; z: number
  url: string
}
export type CanvasBlock = CanvasTextBlock | CanvasImageBlock
export interface CaptionCanvas { w: number; h: number; blocks: CanvasBlock[] }

const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.min(hi, Math.max(lo, Math.round(v)))
}

const CANVAS_ALIGN = new Set(['left', 'center', 'right'])
// Same palette the caption editor offers, plus black/white.
const isSafeColor = (c: unknown): c is string =>
  typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c)

/**
 * Reduce untrusted canvas JSON to the safe, bounded subset. Everything is
 * clamped into the design space, image URLs must be http(s), text is plain
 * (no HTML ever reaches the board), and the block count is capped. Returns
 * null for an empty or unusable board so the column stays NULL.
 */
export function sanitizeCaptionCanvas(input: unknown): CaptionCanvas | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as { h?: unknown; blocks?: unknown }
  if (!Array.isArray(raw.blocks)) return null

  const h = clamp(raw.h, 120, CANVAS_MAX_H, CANVAS_H)
  const blocks: CanvasBlock[] = []
  // Ids address blocks in the editor; two blocks sharing one would make a
  // single edit mutate both.
  const seenIds = new Set<string>()
  const uniqueId = (candidate: string): string => {
    let id = /^[\w-]+$/.test(candidate) && candidate.length <= 40 ? candidate : ''
    if (!id || seenIds.has(id)) {
      let n = seenIds.size
      do { id = `blk${n++}` } while (seenIds.has(id))
    }
    seenIds.add(id)
    return id
  }
  for (const b of raw.blocks.slice(0, CANVAS_MAX_BLOCKS)) {
    if (!b || typeof b !== 'object') continue
    const o = b as Record<string, unknown>
    const type = o.type === 'image' ? 'image' : o.type === 'text' ? 'text' : null
    if (!type) continue

    const w = clamp(o.w, CANVAS_MIN_SIZE, CANVAS_W, 160)
    // Bound the block by THIS board's height, not the global ceiling: a block
    // sized/placed against CANVAS_MAX_H would sit below a shorter board, unseen
    // in the editor and clipped out of the PDF.
    const hh = clamp(o.h, CANVAS_MIN_SIZE, h, 120)
    // Position is clamped so a block can never sit off the board.
    const x = clamp(o.x, 0, Math.max(0, CANVAS_W - w), 0)
    const y = clamp(o.y, 0, Math.max(0, h - hh), 0)
    // Raw z may be any magnitude (the editor's bring-to-front just increments);
    // it is renormalized to a dense 0..n-1 range once every block is collected,
    // so a large value can never be clamped down onto a neighbour's layer.
    const z = clamp(o.z, 0, Number.MAX_SAFE_INTEGER, blocks.length)
    const id = uniqueId(typeof o.id === 'string' ? o.id : '')

    if (type === 'image') {
      const url = typeof o.url === 'string' ? o.url.trim() : ''
      if (!/^https?:\/\//i.test(url) || url.length > 2048) continue
      blocks.push({ id, type: 'image', x, y, w, h: hh, z, url })
    } else {
      // Plain text only — strip any markup rather than trusting the client.
      const text = String(o.text ?? '').replace(/<[^>]*>/g, '').slice(0, CANVAS_MAX_TEXT)
      if (!text.trim()) continue
      const block: CanvasTextBlock = { id, type: 'text', x, y, w, h: hh, z, text }
      const size = clamp(o.size, 9, 48, 14)
      if (size !== 14) block.size = size
      if (o.bold === true) block.bold = true
      if (isSafeColor(o.color)) block.color = o.color
      if (typeof o.align === 'string' && CANVAS_ALIGN.has(o.align)) {
        block.align = o.align as 'left' | 'center' | 'right'
      }
      blocks.push(block)
    }
  }
  if (!blocks.length) return null
  // Collapse z onto a dense 0..n-1 scale, preserving the arranged order. The
  // editor increments z without bound, so storing raw values would eventually
  // exceed any ceiling and flatten the planner's layering.
  ;[...blocks].sort((a, b) => a.z - b.z).forEach((b, i) => { b.z = i })
  return { w: CANVAS_W, h, blocks }
}

/**
 * Plain-text projection of a board, in visual reading order (top row first,
 * then left to right). Rows are banded so labels sitting at roughly the same
 * height read together instead of being split by a few pixels of drift.
 */
export function canvasToText(canvas: CaptionCanvas | null | undefined): string {
  if (!canvas?.blocks?.length) return ''
  const ROW_BAND = 24
  const texts = canvas.blocks
    .filter((b): b is CanvasTextBlock => b.type === 'text')
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)

  // Group into visual rows by PROXIMITY, not fixed bands: labels at y=20 and
  // y=24 sit on the same line to the eye, but a floor(y / band) split would
  // drop them either side of a boundary and read the right-hand one first.
  const rows: CanvasTextBlock[][] = []
  for (const b of texts) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(b.y - row[0].y) <= ROW_BAND) row.push(b)
    else rows.push([b])
  }

  return rows
    .map(row => row.slice().sort((a, b) => a.x - b.x).map(b => b.text.trim()).filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n')
}

/** Image URLs on a board — folded into the brief alongside reference images. */
export function canvasImageUrls(canvas: CaptionCanvas | null | undefined): string[] {
  if (!canvas?.blocks?.length) return []
  return canvas.blocks.filter((b): b is CanvasImageBlock => b.type === 'image').map(b => b.url)
}

// ── Automatic service assignment ─────────────────────────────────────────────
// Planners only choose the content type; the service the design request will
// carry is resolved automatically — from the team's Service-defaults mapping
// first, then by matching keywords against the service names.

export const SERVICE_SUGGEST_KEYWORDS: Record<string, string[]> = {
  post:     ['social', 'post', 'creative', 'design'],
  reel:     ['reel', 'video', 'social'],
  story:    ['story', 'social', 'design'],
  carousel: ['carousel', 'social', 'post', 'design'],
  video:    ['video', 'reel', 'edit'],
  flyer:    ['flyer', 'poster', 'design'],
  poster:   ['poster', 'flyer', 'design'],
  blog:     ['blog', 'article', 'content', 'seo'],
  seo:      ['seo', 'search', 'website', 'marketing'],
  ad:       ['advertis', 'campaign', 'ads', 'marketing', 'meta'],
  email:    ['email', 'newsletter', 'marketing'],
  other:    ['design'],
}

export function suggestServiceId(
  contentType: string,
  services: { id: string; name: string }[],
  serviceMap: Record<string, string> = {},
): string | null {
  // 1. The team's explicit mapping (validated against the live service list —
  //    a deactivated service silently falls through to the keyword guess).
  const mapped = serviceMap[contentType]
  if (mapped && services.some(s => s.id === mapped)) return mapped
  // 2. Keyword guess against service names.
  for (const kw of SERVICE_SUGGEST_KEYWORDS[contentType] ?? []) {
    const hit = services.find(s => s.name.toLowerCase().includes(kw))
    if (hit) return hit.id
  }
  return null
}

// ── Request description composer ─────────────────────────────────────────────

export interface PlanItemInput {
  title: string
  contentType: string
  platforms: string[]
  scheduledDate?: string | null  // YYYY-MM-DD; absent for undated Idea Board items
  /** End of a multi-day run (campaigns, SEO sprints); null for single-day items. */
  scheduledEndDate?: string | null
  caption?: string | null
  notes?: string | null
  calendarTitle?: string | null  // e.g. "July content plan"
  /** Extra formats of the SAME creative (e.g. a post that also ships as a
   *  story-size variant) — one item, one design request, several exports. */
  variants?: string[] | null
  /** Visual references (uploaded images / pasted links) — a mood board. */
  referenceUrls?: string[] | null
  /** Free-drag visual board attached to the copy. */
  captionCanvas?: CaptionCanvas | null
}

/** Short "03 Jul" / "03 Jul – 11 Jul" range label. Empty when no start. */
export function formatShortDateRange(start?: string | null, end?: string | null): string {
  const short = (d: string) => {
    const dt = new Date(d + 'T00:00:00')
    if (Number.isNaN(dt.getTime())) return d
    return `${String(dt.getDate()).padStart(2, '0')} ${dt.toLocaleDateString('en-GB', { month: 'short' })}`
  }
  if (!start) return ''
  return end && end !== start ? `${short(start)} – ${short(end)}` : short(start)
}

/** "Post + Story" — the display form of a type with its variant formats. */
export function contentTypeWithVariants(contentType: string, variants?: string[] | null): string {
  const label = (t: string) => CONTENT_TYPE_LABEL[t as ContentType] ?? t
  const extras = (variants ?? []).filter(v => v && v !== contentType)
  return extras.length ? `${label(contentType)} + ${extras.map(label).join(' + ')}` : label(contentType)
}

/**
 * Compose the task_request description for a pushed item. Mirrors the style
 * of the request → task description block (labelled sections joined by
 * blank lines), so the brief reads naturally in the Requests drawer and on
 * the prefilled Add Task form after promotion.
 */
export function composeRequestDescription(item: PlanItemInput): string {
  const type = CONTENT_TYPE_LABEL[item.contentType as ContentType] ?? item.contentType
  const when = item.scheduledDate
    ? (item.scheduledEndDate && item.scheduledEndDate !== item.scheduledDate
        ? `from ${item.scheduledDate} to ${item.scheduledEndDate}`
        : `for ${item.scheduledDate}`)
    : ''
  const parts: string[] = [
    item.scheduledDate
      ? `Planned ${type.toLowerCase()} ${when}` +
        (item.calendarTitle ? ` (${item.calendarTitle})` : '')
      : `Planned ${type.toLowerCase()}` +
        (item.calendarTitle ? ` (${item.calendarTitle}, date to be scheduled)` : ' (date to be scheduled)'),
  ]
  const extras = (item.variants ?? []).filter(v => v && v !== item.contentType)
  if (extras.length > 0) {
    const labels = extras.map(v => CONTENT_TYPE_LABEL[v as ContentType] ?? v)
    parts.push(`Also deliver as: ${labels.join(', ')} (size/format variant${extras.length === 1 ? '' : 's'} of the same creative)`)
  }
  if (item.platforms.length > 0) parts.push(`Platforms: ${platformLabels(item.platforms)}`)
  // Captions may carry rich formatting — the brief gets the plain-text
  // projection (bullets become "• ", blocks become lines).
  const captionText = captionHtmlToText(item.caption).trim()
  if (captionText) parts.push(`Caption / copy:\n${captionText}`)
  if (item.notes?.trim()) parts.push(`Notes:\n${item.notes.trim()}`)
  // Labels placed on the visual board are part of the brief — a designer
  // reading only the text must still get everything the planner wrote.
  const boardText = canvasToText(item.captionCanvas)
  if (boardText) parts.push(`Layout board:\n${boardText}`)
  // Board images join the reference list so nothing visual is lost in text.
  const refs = [
    ...((item.referenceUrls ?? []).map(u => u?.trim()).filter(Boolean) as string[]),
    ...canvasImageUrls(item.captionCanvas),
  ].filter((u, i, a) => a.indexOf(u) === i)
  if (refs.length) parts.push(`Reference image${refs.length > 1 ? 's' : ''}:\n${refs.join('\n')}`)
  return parts.join('\n\n')
}

/** The social_meta payload written onto the created task_request. */
export function buildSocialMeta(input: {
  calendarId: string; itemId: string; contentType: string; platforms: string[]
  scheduledDate: string | null; scheduledEndDate?: string | null
  variants?: string[] | null
}) {
  return {
    calendar_id: input.calendarId,
    item_id: input.itemId,
    content_type: input.contentType,
    platforms: input.platforms,
    scheduled_date: input.scheduledDate,
    ...(input.scheduledEndDate ? { scheduled_end_date: input.scheduledEndDate } : {}),
    ...(input.variants?.length ? { variants: input.variants } : {}),
  }
}

// ── Live progress resolution (item + joined request → one display state) ─────

export type ItemProgress =
  | 'planned'      // not yet sent to Requests
  | 'requested'    // request exists, not yet promoted to a task
  | 'in_progress'  // promoted; task pending/in_progress (or request says so)
  | 'delivered'    // task delivered — under client review
  | 'done'         // task done/invoiced/paid or request completed
  | 'cancelled'    // item cancelled, or its request/task cancelled/rejected

export const PROGRESS_LABEL: Record<ItemProgress, string> = {
  planned: 'Planned', requested: 'In Requests', in_progress: 'In Progress',
  delivered: 'Under Review', done: 'Completed', cancelled: 'Cancelled',
}

export const PROGRESS_CHIP: Record<ItemProgress, string> = {
  planned:     'bg-secondary text-muted-foreground border-border',
  requested:   'bg-blue-500/15 text-blue-400 border-blue-500/25',
  in_progress: 'bg-amber-500/15 text-amber-500 border-amber-500/25',
  delivered:   'bg-purple-500/15 text-purple-400 border-purple-500/25',
  done:        'bg-green-500/15 text-green-500 border-green-500/25',
  cancelled:   'bg-red-500/15 text-red-400 border-red-500/25',
}

export interface LinkedRequestView {
  status: string                                   // task_requests.status
  promoted_task?: { status: string } | null
}

/**
 * A task linked STRAIGHT to the item, with no request in between (the
 * "skip the inbox" exit). Same shape the request's promoted_task carries, so
 * both routes collapse onto one status read below.
 */
export interface LinkedTaskView {
  status: string                                   // tasks.status
  deleted_at?: string | null
}

/**
 * Map a task status onto the planner's display state. Shared by both exits —
 * a task reached through a request and one linked directly are the same work,
 * so they must never report different progress.
 */
function progressFromTaskStatus(status: string): ItemProgress {
  if (status === 'done' || status === 'invoiced' || status === 'paid') return 'done'
  if (status === 'delivered') return 'delivered'
  if (status === 'cancelled') return 'cancelled'
  return 'in_progress'
}

/**
 * Request statuses the planner must never write to: already closed, or
 * already finished-and-client-notified. Editing or cancelling one of these
 * from the calendar would rewrite a record the client has already seen.
 */
export const TERMINAL_REQUEST_STATUSES = ['completed', 'delivered', 'cancelled', 'rejected', 'archived'] as const

export function isTerminalRequestStatus(status: string | null | undefined): boolean {
  return !!status && (TERMINAL_REQUEST_STATUSES as readonly string[]).includes(status)
}

/** Statuses whose linked request is closed — the item may be re-planned. */
export function isClosedRequestStatus(status: string | null | undefined): boolean {
  return status === 'cancelled' || status === 'rejected' || status === 'archived'
}

/**
 * One state for the calendar chip, derived from the authored item status and
 * whatever the pipeline currently says. The request's own status is already
 * task-driven post-promotion (task-sync), so it is authoritative here.
 */
export function resolveItemProgress(
  itemStatus: string,
  request: LinkedRequestView | null | undefined,
  task?: LinkedTaskView | null,
): ItemProgress {
  if (itemStatus === 'cancelled') return 'cancelled'
  // Direct exit first: a task linked straight to the item owns its progress
  // outright, with no request status to reconcile against. A soft-deleted task
  // is treated as no task at all — the item falls back to whatever the request
  // route says, or to 'planned', so trashing a task never strands the item in
  // a state the planner cannot act on.
  if (task && !task.deleted_at) return progressFromTaskStatus(task.status)
  if (!request) return 'planned'
  const rs = request.status
  // 'archived' is terminal in the inbox too — without this it would fall
  // through to 'requested' and the chip would claim the item is still queued.
  if (rs === 'rejected' || rs === 'cancelled' || rs === 'archived') return 'cancelled'
  if (rs === 'completed') return 'done'
  if (rs === 'delivered') return 'delivered'
  if (request.promoted_task) return progressFromTaskStatus(request.promoted_task.status)
  if (rs === 'started' || rs === 'in_progress' || rs === 'waiting_for_content' || rs === 'revision_requested') {
    return 'in_progress'
  }
  return 'requested'   // submitted / under_review / approved — sitting in the inbox
}

// ── Routing (which exits an item may still take) ─────────────────────────────

/**
 * The item shape the routing helpers below read. Deliberately structural: the
 * calendar page, the push actions and the Tasks-page picker all hold slightly
 * different projections of the same row.
 */
export interface RoutableItem {
  status: string
  request_id?: string | null
  task_id?: string | null
  request?: LinkedRequestView | null
  task?: LinkedTaskView | null
}

/**
 * Is this item still unrouted — no live request, no live task — and therefore
 * available to send down either pipe?
 *
 * Reads the JOINED rows, not just the id columns, because a task can be
 * soft-deleted (deleted_at) and a request can be cancelled while the id stays
 * behind. Those items are genuinely back to square one and must be pushable
 * again; keying off `request_id != null` alone would strand them forever.
 *
 * Note the `task_id` fallback: before the direct-task migration is applied the
 * joined `task` is always undefined, so a bare id still counts as routed.
 */
export function isUnrouted(item: RoutableItem): boolean {
  if (item.status === 'cancelled') return false
  if (item.task_id && (!item.task || !item.task.deleted_at)) return false
  if (item.request_id && !isClosedRequestStatus(item.request?.status)) {
    // An id with no joined row (pre-migration read, or a request the viewer
    // cannot see) is treated as live — better to under-offer the button than
    // to double-push work that already exists.
    return false
  }
  return true
}

/**
 * Can the item be pulled back to 'planned' from the calendar alone?
 *
 * False once real downstream work exists: a promoted task owns the schedule,
 * and a completed/delivered request has already been shown to the client.
 * Both cases must be resolved where they live, not tidied away from the
 * planner.
 */
export function canPullBack(item: RoutableItem): boolean {
  if (item.status === 'cancelled') return false
  if (item.task_id && item.task && !item.task.deleted_at) {
    // Direct-task exit: only reversible while the task has not been delivered
    // or finished. An unstarted task is a planning mistake; a delivered one is
    // a record.
    return !['delivered', 'done', 'invoiced', 'paid'].includes(item.task.status)
  }
  if (!item.request_id) return false
  if (item.request?.promoted_task) return false
  return !['completed', 'delivered'].includes(item.request?.status ?? '')
}

// ── Lead time ────────────────────────────────────────────────────────────────

/**
 * Publish date minus the lead time — the date the DESIGNER works to.
 *
 * A calendar date is when the post GOES LIVE. The creative has to be finished
 * before then: an Independence Day piece due on Independence Day is already
 * late, because there is no room left to review it, fix it, or schedule it.
 *
 * Pure and day-based (no timezone maths beyond the local calendar day) so the
 * planner, the pushed request and any test all land on the same date. Returns
 * the publish date unchanged when there is no lead time or the input is not a
 * real date — a bad value must never silently move a deadline.
 */
export function dueDateForPublish(publish: string | null | undefined, leadDays: number): string | null {
  if (!publish) return null
  if (!Number.isFinite(leadDays) || leadDays <= 0) return publish
  const d = new Date(`${publish}T00:00:00`)
  if (isNaN(d.getTime())) return publish
  d.setDate(d.getDate() - Math.round(leadDays))
  return d.toLocaleDateString('en-CA')
}
