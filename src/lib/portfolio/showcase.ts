/**
 * Website "Presentation" — the full-screen client showcase on cirqle.work/portfolio.
 *
 * Distinct from the gallery (collections → brands → items), which stays as it
 * is. A presentation is one hero visual per client, shown full-bleed with the
 * client list beside it. cirqle-website reads it from `work_showcases`; this
 * module is everything the dashboard needs to write that table correctly.
 *
 * ── THE RENDERING RULES THIS HAS TO MIRROR ────────────────────────────────
 *
 * The website (WorkPresentation.tsx + .css) draws the hero as
 * `object-fit: cover` with `object-position: <focal_x>% <focal_y>%`, at
 * viewport height, and switches to the mobile media at ≤700px — but only when
 * a mobile image exists, falling back per field (poster, then focal point) to
 * the desktop values. `resolveForViewport` below is that rule, written once,
 * so the editor's live preview cannot disagree with the site about what a
 * visitor sees.
 *
 * ── WHY STORAGE PATHS, NOT URLS, CROSS THE BOUNDARY ───────────────────────
 *
 * The public site only accepts https media and renders whatever the row says.
 * If the dashboard let a client post a URL, a compromised or careless session
 * could point the site at any external image. So the browser sends storage
 * PATHS inside `showcase/<slug>/`, and the server builds the public URL itself
 * (`publicUrlFor`). `isOwnStoragePath` is the gate.
 *
 * Pure and dependency-free, so all of it is tested without a database.
 */

export type ShowcaseMediaType = 'image' | 'video'

/** Bucket folder every presentation file lives under. */
export const SHOWCASE_FOLDER = 'showcase'

/** Matches the website's own breakpoint (WorkPresentation.css: max-width 700px). */
export const MOBILE_BREAKPOINT_PX = 700

/**
 * Frames the live preview draws. 16:9 is a typical desktop viewport; 9:19.5 a
 * modern phone. The site fills the whole viewport, so these are the shapes the
 * focal point has to work for.
 */
export const DESKTOP_ASPECT = 16 / 9
export const MOBILE_ASPECT = 9 / 19.5

export const MAX_CLIENT_NAME = 80
export const MAX_CATEGORY = 60
export const MAX_DESCRIPTION = 400
export const MAX_ALT_TEXT = 200

/** One side (desktop or mobile) of a presentation. */
export interface ShowcaseMedia {
  type: ShowcaseMediaType
  /** Public https URL, as the website reads it. */
  url: string
  /** Required for video: the frame shown before it plays. */
  posterUrl: string | null
  /**
   * Where the file lives in storage, when the server could work it out.
   * Present so an edit that keeps the existing file can send the path back
   * without the browser having to take a public URL apart.
   */
  path: string | null
  posterPath: string | null
  /** 0–100, where the crop stays centred when the frame is narrower than the image. */
  focalX: number
  focalY: number
}

export interface ShowcaseEntry {
  id: string
  slug: string
  clientName: string
  category: string
  description: string
  altText: string
  /** Optional link to a project page, always inside /portfolio. */
  projectPath: string | null
  published: boolean
  position: number
  desktop: ShowcaseMedia
  /** Null means "use the desktop media on phones too". */
  mobile: ShowcaseMedia | null
}

/** `work_showcases` exactly as PostgREST returns it. */
export interface ShowcaseRow {
  id: string
  slug: string
  client_name: string
  category: string | null
  description: string | null
  media_type: ShowcaseMediaType
  media_url: string
  poster_url: string | null
  mobile_media_url: string | null
  mobile_media_type: ShowcaseMediaType | null
  mobile_poster_url: string | null
  alt_text: string
  focal_x: number | null
  focal_y: number | null
  mobile_focal_x: number | null
  mobile_focal_y: number | null
  project_path: string | null
  position: number | null
  published: boolean | null
}

/** Columns the dashboard reads. One list so list and write cannot drift. */
export const SHOWCASE_COLUMNS =
  'id, slug, client_name, category, description, media_type, media_url, poster_url, '
  + 'mobile_media_url, mobile_media_type, mobile_poster_url, alt_text, focal_x, focal_y, '
  + 'mobile_focal_x, mobile_focal_y, project_path, position, published'

// ─── Numbers ────────────────────────────────────────────────────────────────

/** A whole number 0–100. The table stores integers and constrains them to that range. */
export function clampFocal(value: unknown, fallback = 50): number {
  // Only numbers and numeric strings count. `Number(null)` is 0 and
  // `Number('')` is 0, so coercing blindly would read an UNSET column as the
  // top-left corner instead of falling back — the mobile focal point is null
  // by default, which is exactly the case that matters.
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(100, Math.max(0, Math.round(n)))
}

// ─── Slugs ──────────────────────────────────────────────────────────────────

/** "Elara Perfumes!" → "elara-perfumes". Never empty-by-accident: callers check. */
export function slugFromClientName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

/**
 * A slug that is not already taken.
 *
 * The slug is the table's unique key AND the storage folder, and it never
 * changes after creation — renaming a client later must not orphan its files
 * or break a shared link, so uniqueness is settled once, here.
 */
export function uniqueShowcaseSlug(name: string, taken: Iterable<string>): string {
  const base = slugFromClientName(name) || 'client'
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

// ─── Storage paths and URLs ─────────────────────────────────────────────────

const ALLOWED_EXT = /\.(webp|mp4|webm|mov)$/i

/**
 * May this path be published for this presentation?
 *
 * It must sit inside the presentation's own folder, carry an extension the
 * public bucket is allowed to serve, and contain no traversal. Everything the
 * browser sends goes through here before a URL is built from it.
 */
export function isOwnStoragePath(slug: string, path: unknown): path is string {
  if (typeof path !== 'string' || !slug) return false
  if (path.includes('..') || path.includes('\\') || path.startsWith('/')) return false
  if (!path.startsWith(`${SHOWCASE_FOLDER}/${slug}/`)) return false
  return ALLOWED_EXT.test(path)
}

/**
 * Public URL for an object in the public `work` bucket.
 *
 * `version` is appended as a query string. The editor re-uploads to the same
 * path when media is replaced, and the CDN and every visitor's browser would
 * otherwise keep serving the old file — the website only checks that the URL
 * starts with `https://`, so a cache-buster is safe.
 */
export function publicUrlFor(base: string, bucket: string, path: string, version: number): string {
  const root = base.replace(/\/+$/, '')
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${root}/storage/v1/object/public/${bucket}/${encoded}?v=${Math.trunc(version)}`
}

/** The inverse of `publicUrlFor`: the storage path a stored URL points at, or null. */
export function pathFromPublicUrl(base: string, bucket: string, url: string | null | undefined): string | null {
  if (!url) return null
  const prefix = `${base.replace(/\/+$/, '')}/storage/v1/object/public/${bucket}/`
  if (!url.startsWith(prefix)) return null
  try {
    return decodeURIComponent(url.slice(prefix.length).split('?')[0].split('#')[0])
  } catch {
    return null
  }
}

// ─── Row ⇄ entry ────────────────────────────────────────────────────────────

export function rowToEntry(row: ShowcaseRow, publicBase = ''): ShowcaseEntry {
  const hasMobile = !!row.mobile_media_url
  const pathOf = (url: string | null) => (publicBase ? pathFromPublicUrl(publicBase, 'work', url) : null)
  return {
    id: row.id,
    slug: row.slug,
    clientName: row.client_name,
    category: row.category ?? '',
    description: row.description ?? '',
    altText: row.alt_text,
    projectPath: row.project_path,
    published: row.published === true,
    position: row.position ?? 0,
    desktop: {
      type: row.media_type,
      url: row.media_url,
      posterUrl: row.poster_url,
      path: pathOf(row.media_url),
      posterPath: pathOf(row.poster_url),
      focalX: clampFocal(row.focal_x),
      focalY: clampFocal(row.focal_y),
    },
    mobile: hasMobile
      ? {
          // The column is nullable: absent means "same kind as desktop".
          type: row.mobile_media_type ?? row.media_type,
          url: row.mobile_media_url as string,
          posterUrl: row.mobile_poster_url,
          path: pathOf(row.mobile_media_url),
          posterPath: pathOf(row.mobile_poster_url),
          // Null means "follow the desktop focal point", which the editor
          // surfaces as the desktop value rather than a hidden fallback.
          focalX: clampFocal(row.mobile_focal_x, clampFocal(row.focal_x)),
          focalY: clampFocal(row.mobile_focal_y, clampFocal(row.focal_y)),
        }
      : null,
  }
}

// ─── What a visitor sees ────────────────────────────────────────────────────

export interface ResolvedMedia {
  type: ShowcaseMediaType
  url: string
  posterUrl: string | null
  focalX: number
  focalY: number
  /** True when a phone is being shown the desktop media. */
  fellBack: boolean
}

/**
 * The media, poster and focal point the website would use at this viewport.
 *
 * Mirrors WorkPresentation.tsx line for line: phones get the mobile media only
 * if there is one, and each field falls back to the desktop value on its own
 * (`mobile_poster_url || poster_url`, `mobile_focal_x ?? focal_x`).
 */
export function resolveForViewport(entry: ShowcaseEntry, viewport: 'desktop' | 'mobile'): ResolvedMedia {
  const d = entry.desktop
  if (viewport === 'mobile' && entry.mobile) {
    const m = entry.mobile
    return {
      type: m.type || d.type,
      url: m.url,
      posterUrl: m.posterUrl || d.posterUrl,
      focalX: m.focalX ?? d.focalX,
      focalY: m.focalY ?? d.focalY,
      fellBack: false,
    }
  }
  return { ...d, fellBack: viewport === 'mobile' }
}

// ─── Focal point geometry ───────────────────────────────────────────────────

/** CSS `object-position` for a focal point. */
export function objectPosition(focalX: number, focalY: number): string {
  return `${clampFocal(focalX)}% ${clampFocal(focalY)}%`
}

/**
 * Turn a pointer position over the displayed image into a focal point.
 *
 * `rect` is the image's on-screen box, so the result is a percentage of the
 * IMAGE, not of whatever frame it sits in — which is what object-position
 * means. Clamped, so dragging past an edge pins to it rather than escaping.
 */
export function focalFromPointer(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  if (!(rect.width > 0) || !(rect.height > 0)) return { x: 50, y: 50 }
  return {
    x: clampFocal(((clientX - rect.left) / rect.width) * 100),
    y: clampFocal(((clientY - rect.top) / rect.height) * 100),
  }
}

/** Arrow-key nudge for keyboard users. Shift moves in larger steps. */
export function nudgeFocal(
  focal: { x: number; y: number },
  key: string,
  large = false,
): { x: number; y: number } {
  const step = large ? 10 : 1
  switch (key) {
    case 'ArrowLeft':  return { x: clampFocal(focal.x - step), y: focal.y }
    case 'ArrowRight': return { x: clampFocal(focal.x + step), y: focal.y }
    case 'ArrowUp':    return { x: focal.x, y: clampFocal(focal.y - step) }
    case 'ArrowDown':  return { x: focal.x, y: clampFocal(focal.y + step) }
    default:           return focal
  }
}

/**
 * The part of an image that survives `object-fit: cover` in a frame of a given
 * shape, as percentages of the image — what the editor shades to show what
 * will be cropped away.
 *
 * With cover, the axis that overflows is the one that gets cropped, and
 * `object-position` decides how the spare room is split: 0% keeps the start,
 * 100% keeps the end. So only one of the two axes ever loses anything.
 */
export function visibleRegion(
  imageWidth: number,
  imageHeight: number,
  frameAspect: number,
  focalX: number,
  focalY: number,
): { x: number; y: number; width: number; height: number } {
  if (!(imageWidth > 0) || !(imageHeight > 0) || !(frameAspect > 0)) {
    return { x: 0, y: 0, width: 100, height: 100 }
  }
  const imageAspect = imageWidth / imageHeight
  if (imageAspect > frameAspect) {
    // Image is wider than the frame: the sides are cropped.
    const width = (frameAspect / imageAspect) * 100
    return { x: ((100 - width) * clampFocal(focalX)) / 100, y: 0, width, height: 100 }
  }
  // Image is taller than the frame: the top and bottom are cropped.
  const height = (imageAspect / frameAspect) * 100
  return { x: 0, y: ((100 - height) * clampFocal(focalY)) / 100, width: 100, height }
}

// ─── Phone media modes ──────────────────────────────────────────────────────

/**
 * How phones get their picture.
 *
 *   · same — no mobile row values; phones show the desktop media and the
 *            desktop focal point.
 *   · crop — the SAME file with its own focal point. The website picks the
 *            mobile media whenever a mobile URL exists, and nothing says it
 *            has to differ from the desktop one, so this is a supported way to
 *            re-crop one image for a tall screen without uploading it twice.
 *   · own  — a separate phone image or video.
 */
export type MobileMode = 'same' | 'crop' | 'own'

/** A URL without its cache-busting query, for comparing which FILE it points at. */
function fileOf(url: string): string {
  return url.split('?')[0].split('#')[0]
}

export function mobileModeOf(entry: Pick<ShowcaseEntry, 'desktop' | 'mobile'>): MobileMode {
  if (!entry.mobile) return 'same'
  return fileOf(entry.mobile.url) === fileOf(entry.desktop.url) ? 'crop' : 'own'
}

/**
 * Plain-language advice about a source file, or null when it is fine.
 *
 * The hero fills the whole screen, so two things matter: enough pixels, and a
 * shape that survives being cropped to the frame. Neither blocks saving — a
 * designer may have a good reason — they are said out loud so nobody
 * publishes a soft or badly cropped hero by accident.
 */
export function mediaAdvice(
  viewport: 'desktop' | 'mobile',
  width: number,
  height: number,
): string | null {
  if (!(width > 0) || !(height > 0)) return null
  const minWidth = viewport === 'desktop' ? 1600 : 900
  if (width < minWidth) {
    return `Only ${width}px wide — on a ${viewport === 'desktop' ? 'large screen' : 'modern phone'} this will look soft. Aim for at least ${minWidth}px.`
  }
  const aspect = width / height
  if (viewport === 'desktop' && aspect < 1) {
    return 'This is a portrait image. On a wide screen the top and bottom are cropped away — use the focal point to choose what stays, or upload a landscape version.'
  }
  if (viewport === 'mobile' && aspect > 1) {
    return 'This is a landscape image. On a phone most of the sides are cropped away — use the focal point to choose what stays, or upload a portrait version.'
  }
  return null
}

// ─── Validation ─────────────────────────────────────────────────────────────

/** A media side as the browser submits it: storage paths, never URLs. */
export interface ShowcaseMediaInput {
  type: ShowcaseMediaType
  path: string
  posterPath: string | null
  focalX: number
  focalY: number
}

export interface ShowcaseInput {
  /** Present when editing; absent when creating. */
  id?: string
  clientName: string
  category: string
  description: string
  altText: string
  projectPath: string | null
  desktop: ShowcaseMediaInput
  mobile: ShowcaseMediaInput | null
}

/** Default alt text: a sighted visitor gets the caption, a screen-reader user should too. */
export function defaultAltText(clientName: string, category: string): string {
  const name = clientName.trim()
  const cat = category.trim()
  if (!name) return ''
  return cat ? `${name} — ${cat}` : name
}

/**
 * Check a submission against the rules the database enforces, in words a
 * person can act on.
 *
 * The table has CHECK constraints for most of these, but a constraint failure
 * surfaces as `23514 work_showcases_check` — which tells nobody which field to
 * fix. This reports them first, by field.
 */
export function validateShowcaseInput(
  input: ShowcaseInput,
  slug: string,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const name = input.clientName.trim()
  if (!name) errors.push('Give the presentation a client name.')
  if (name.length > MAX_CLIENT_NAME) errors.push(`Keep the client name under ${MAX_CLIENT_NAME} characters.`)
  if (input.category.trim().length > MAX_CATEGORY) errors.push(`Keep the category under ${MAX_CATEGORY} characters.`)
  if (input.description.trim().length > MAX_DESCRIPTION) errors.push(`Keep the description under ${MAX_DESCRIPTION} characters.`)

  const alt = input.altText.trim() || defaultAltText(input.clientName, input.category)
  if (!alt) errors.push('Add a short description of the visual for screen readers.')
  if (alt.length > MAX_ALT_TEXT) errors.push(`Keep the image description under ${MAX_ALT_TEXT} characters.`)

  if (input.projectPath && !/^\/portfolio(?:[/?#]|$)/.test(input.projectPath)) {
    errors.push('A project link must point inside the portfolio, for example /portfolio/social-media/cell-world.')
  }

  const sides: [string, ShowcaseMediaInput | null][] = [['desktop', input.desktop], ['mobile', input.mobile]]
  for (const [label, media] of sides) {
    if (!media) continue
    if (!isOwnStoragePath(slug, media.path)) errors.push(`The ${label} file did not upload correctly. Choose it again.`)
    if (media.type === 'video' && label === 'desktop' && !isOwnStoragePath(slug, media.posterPath)) {
      errors.push('The desktop video has no poster frame. Choose the file again.')
    }
    if (media.posterPath && !isOwnStoragePath(slug, media.posterPath)) {
      errors.push(`The ${label} poster frame did not upload correctly. Choose the file again.`)
    }
  }

  // The table's own rule: a mobile video needs a poster from itself OR from
  // the desktop side. Checked here so the message names the field.
  if (input.mobile?.type === 'video' && !input.mobile.posterPath && !input.desktop.posterPath) {
    errors.push('The mobile video has no poster frame. Choose the file again.')
  }

  return errors.length ? { ok: false, errors } : { ok: true }
}

/** New `position` values after a drag, in steps of ten so a later insert has room. */
export function positionsFor(orderedIds: readonly string[]): { id: string; position: number }[] {
  return orderedIds.map((id, i) => ({ id, position: (i + 1) * 10 }))
}

/** Position for a new entry: after everything that exists. */
export function nextPosition(existing: readonly { position: number }[]): number {
  return existing.reduce((max, e) => Math.max(max, e.position), 0) + 10
}
