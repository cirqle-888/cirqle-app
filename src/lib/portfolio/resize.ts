import { VARIANT_WIDTHS, WEBP_QUALITY } from './types'

/**
 * Browser-side image resizing for portfolio uploads.
 *
 * Supabase image transformation is a paid add-on, so renditions are produced
 * here instead: the artwork is decoded once and re-encoded as WebP at each
 * width before anything is uploaded. A 12 MB print export becomes four files
 * totalling a few hundred kilobytes, and the original never crosses the wire.
 */

export interface Rendition {
  width: number
  height: number
  blob: Blob
}

export interface ResizedImage {
  /** Intrinsic size of the source artwork */
  width: number
  height: number
  renditions: Rendition[]
}

/** Widths to generate for a source of this width — never upscaling. */
export function widthsFor(sourceWidth: number): number[] {
  const largest = VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1]
  const smaller = VARIANT_WIDTHS.filter((w) => w < sourceWidth)
  return [...new Set([...smaller, Math.min(sourceWidth, largest)])].sort((a, b) => a - b)
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file)
  } catch {
    // Safari refuses some files in createImageBitmap but decodes them as an
    // <img>; going through an object URL covers that case.
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.decoding = 'async'
      img.src = url
      await img.decode()
      return await createImageBitmap(img)
    } finally {
      URL.revokeObjectURL(url)
    }
  }
}

async function toWebp(source: ImageBitmap, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser cannot process images.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, width, height)

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', WEBP_QUALITY),
  )
  if (!blob) throw new Error('This browser cannot save WebP images.')
  return blob
}

/** Decode `file` once and produce every rendition it needs. */
export async function resizeForUpload(file: File): Promise<ResizedImage> {
  const bitmap = await decode(file)
  const width = bitmap.width
  const height = bitmap.height
  if (!width || !height) throw new Error('That file is not a readable image.')

  try {
    const renditions: Rendition[] = []
    for (const target of widthsFor(width)) {
      const scaled = Math.round((height / width) * target)
      // Re-decode at the target size where the browser supports it: the
      // built-in resampler is better than a single drawImage downscale.
      let source = bitmap
      let temporary: ImageBitmap | null = null
      try {
        temporary = await createImageBitmap(bitmap, {
          resizeWidth: target,
          resizeHeight: scaled,
          resizeQuality: 'high',
        })
        source = temporary
      } catch {
        // Older browsers ignore the resize options; drawImage handles it below.
      }
      try {
        renditions.push({ width: target, height: scaled, blob: await toWebp(source, target, scaled) })
      } finally {
        temporary?.close()
      }
    }
    return { width, height, renditions }
  } finally {
    bitmap.close()
  }
}

/** "Eid Mubarak iPhone.jpg" → "eid-mubarak-iphone" */
export function slugFromFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

const CASE_FIXES: Record<string, string> = {
  iphone: 'iPhone', ipad: 'iPad', macbook: 'MacBook', ai: 'AI', ui: 'UI', ux: 'UX',
  fifa: 'FIFA', uae: 'UAE', ksa: 'KSA', vat: 'VAT', aed: 'AED', '3d': '3D', tv: 'TV',
  fc: 'FC', ceo: 'CEO', diy: 'DIY', qr: 'QR', eid: 'Eid', ipl: 'IPL', isl: 'ISL',
  and: 'and', of: 'of', the: 'the', with: 'with', for: 'for',
}

/** "03-happy-smile-day.jpg" → "Happy Smile Day" */
export function titleFromFilename(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/^\d+[-_ .]*/, '')
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word, i) => {
      const fix = CASE_FIXES[word.toLowerCase()]
      if (fix) return i === 0 ? fix[0].toUpperCase() + fix.slice(1) : fix
      return word[0].toUpperCase() + word.slice(1)
    })
    .join(' ')
}

// ─── Video ───────────────────────────────────────────────────────────────────

export interface VideoPoster {
  width: number
  height: number
  durationSeconds: number
  /** Poster frame at the same widths as a still, or [] if it could not be read */
  renditions: Rendition[]
}

/**
 * Read a video's dimensions and duration, and grab a frame to use as the
 * poster. Everything happens locally; the file itself is uploaded untouched.
 *
 * Some containers (notably .mov) will not decode in every browser. When the
 * frame cannot be captured the video still uploads — it just has no poster —
 * so this resolves with empty renditions rather than throwing.
 */
export async function posterFromVideo(file: File): Promise<VideoPoster> {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  video.src = url

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('This video could not be read in the browser.'))
      window.setTimeout(() => reject(new Error('Timed out reading the video.')), 20000)
    })

    const width = video.videoWidth
    const height = video.videoHeight
    const durationSeconds = Number.isFinite(video.duration) ? video.duration : 0
    if (!width || !height) return { width: 0, height: 0, durationSeconds, renditions: [] }

    // A frame a little way in is far more representative than frame zero,
    // which is often black.
    const target = durationSeconds > 2 ? Math.min(1, durationSeconds * 0.1) : 0
    let frame: ImageBitmap | null = null
    try {
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve()
        video.onerror = () => reject(new Error('Could not seek the video.'))
        video.currentTime = target
        window.setTimeout(() => reject(new Error('Timed out seeking the video.')), 20000)
      })
      frame = await createImageBitmap(video)
    } catch {
      return { width, height, durationSeconds, renditions: [] }
    }

    try {
      const renditions: Rendition[] = []
      for (const w of widthsFor(width)) {
        const scaled = Math.round((height / width) * w)
        renditions.push({ width: w, height: scaled, blob: await toWebp(frame, w, scaled) })
      }
      return { width, height, durationSeconds, renditions }
    } finally {
      frame.close()
    }
  } finally {
    URL.revokeObjectURL(url)
    video.removeAttribute('src')
    video.load()
  }
}

// ─── Brand logos ─────────────────────────────────────────────────────────────

/** Largest a brand logo is ever drawn; it sits ~20px tall on a filter chip. */
const LOGO_WIDTH = 480

/** How far a pixel may sit from the background colour and still be erased. */
const FLAT_TOLERANCE = 26
/** Beyond this it is artwork; between the two the alpha is faded, which is
 *  what stops a hard white halo around an anti-aliased edge. */
const EDGE_TOLERANCE = 78

export interface PreparedLogo {
  width: number
  height: number
  blob: Blob
  /** True when a flat background was found and erased. */
  backgroundRemoved: boolean
  /** True when a light slab UNDER the mark was found and erased. */
  plateRemoved: boolean
}

export interface LogoOptions {
  /**
   * Erase the light plate a mark is drawn on — the white oval or rounded
   * rectangle that is part of the artwork rather than around it.
   *
   * Left undefined, a plate is looked for and erased when found. Set it
   * explicitly to overrule that: a mark whose own letters are white on a
   * coloured shape loses them along with the plate, and only a person looking
   * at the preview can tell the difference.
   */
  removePlate?: boolean
}

const channelDistance = (d: Uint8ClampedArray, i: number, bg: number[]) =>
  Math.max(Math.abs(d[i] - bg[0]), Math.abs(d[i + 1] - bg[1]), Math.abs(d[i + 2] - bg[2]))

/**
 * Erase a flat background, so a logo saved on a white rectangle stops being a
 * white rectangle on the site.
 *
 * Only pixels REACHABLE FROM THE EDGE are erased, spreading inward and
 * stopping at anything that is not the background colour. A white letter
 * inside a mark is enclosed by the mark, never reached, and survives — which a
 * plain "make every white pixel transparent" pass would destroy.
 *
 * Does nothing unless all four corners agree on a colour and are opaque: that
 * is what tells us there is a background rather than artwork bleeding to the
 * edge.
 */
export function stripFlatBackgroundFromPixels(
  d: Uint8ClampedArray,
  width: number,
  height: number,
): boolean {
  const at = (x: number, y: number) => (y * width + x) * 4

  const corners = [at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1)]
  if (corners.some((i) => d[i + 3] < 250)) return false

  const bg = [d[corners[0]], d[corners[0] + 1], d[corners[0] + 2]]
  if (corners.some((i) => channelDistance(d, i, bg) > FLAT_TOLERANCE)) return false

  // Breadth-first from every edge pixel. A flat array of visited flags rather
  // than a Set: a 480px logo is ~200k pixels and Set churn dominates otherwise.
  const seen = new Uint8Array(width * height)
  const queue: number[] = []
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const p = y * width + x
    if (seen[p]) return
    seen[p] = 1
    queue.push(p)
  }

  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1) }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y) }

  let erased = 0
  for (let head = 0; head < queue.length; head++) {
    const p = queue[head]
    const i = p * 4
    const distance = channelDistance(d, i, bg)
    if (distance > EDGE_TOLERANCE) continue

    if (distance <= FLAT_TOLERANCE) {
      d[i + 3] = 0
      erased++
    } else {
      // Partly background, partly edge: keep the pixel but let the background
      // show through in proportion, so the cut edge stays smooth.
      const ratio = (distance - FLAT_TOLERANCE) / (EDGE_TOLERANCE - FLAT_TOLERANCE)
      d[i + 3] = Math.min(d[i + 3], Math.round(255 * ratio))
      continue
    }

    const x = p % width
    const y = (p - x) / width
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1)
  }

  return erased > 0
}

/** Canvas wrapper around the pass above. */
function stripFlatBackground(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const image = ctx.getImageData(0, 0, width, height)
  if (!stripFlatBackgroundFromPixels(image.data, width, height)) return false
  ctx.putImageData(image, 0, 0)
  return true
}

/** Perceived brightness, 0-1. */
const luminance = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

/**
 * The slab a mark sits on, if there is one.
 *
 * A plate is one near-uniform colour covering much of the artwork. That alone
 * is not enough — a solid wordmark on a transparent background is also one
 * uniform colour — so a candidate has to pass three tests:
 *
 *  1. it covers at least a third of the visible pixels;
 *  2. something SURVIVES erasing it, since a mark that erases to nothing was
 *     the mark, not its backing;
 *  3. it is light, or it reaches the edge of the image. A backing extends to
 *     the border; a mark floating on transparency does not.
 *
 * Together these catch both the white oval behind a logotype and the dark
 * rectangle behind a light one, while leaving flat two-colour marks alone.
 */
export function detectPlateColour(
  d: Uint8ClampedArray,
  width: number,
  height: number,
): number[] | null {
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>()
  let visible = 0

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue
    visible++
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.count++
      bucket.r += d[i]; bucket.g += d[i + 1]; bucket.b += d[i + 2]
    } else {
      buckets.set(key, { count: 1, r: d[i], g: d[i + 1], b: d[i + 2] })
    }
  }
  if (!visible) return null

  let best: { count: number; r: number; g: number; b: number } | null = null
  for (const bucket of buckets.values()) if (!best || bucket.count > best.count) best = bucket
  if (!best || best.count / visible < 0.34) return null

  const bg = [
    Math.round(best.r / best.count),
    Math.round(best.g / best.count),
    Math.round(best.b / best.count),
  ]

  // (2) Would anything be left?
  let survivors = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue
    if (channelDistance(d, i, bg) > EDGE_TOLERANCE) survivors++
  }
  if (survivors / visible < 0.025) return null

  // (3) Light, or touching the border.
  if (luminance(bg[0], bg[1], bg[2]) > 0.82) return bg

  let border = 0
  let onPlate = 0
  const check = (x: number, y: number) => {
    const i = (y * width + x) * 4
    if (d[i + 3] < 200) return
    border++
    if (channelDistance(d, i, bg) <= FLAT_TOLERANCE) onPlate++
  }
  for (let x = 0; x < width; x++) { check(x, 0); check(x, height - 1) }
  for (let y = 0; y < height; y++) { check(0, y); check(width - 1, y) }

  return border > 0 && onPlate / border >= 0.4 ? bg : null
}

/**
 * Erase every pixel close to `bg`, wherever it is — the pass that takes the
 * plate out from UNDER a mark, which the edge-following one deliberately
 * leaves alone.
 */
export function removePlateFromPixels(
  d: Uint8ClampedArray,
  bg: number[] = [255, 255, 255],
): number {
  let erased = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue
    const distance = channelDistance(d, i, bg)
    if (distance <= FLAT_TOLERANCE) {
      d[i + 3] = 0
      erased++
    } else if (distance <= EDGE_TOLERANCE) {
      const ratio = (distance - FLAT_TOLERANCE) / (EDGE_TOLERANCE - FLAT_TOLERANCE)
      d[i + 3] = Math.min(d[i + 3], Math.round(255 * ratio))
    }
  }
  return erased
}

/**
 * One WebP rendition of a brand logo, with any flat background erased.
 *
 * A single file serves both states on the site: its alpha channel is used as a
 * mask for the monochrome version, and the file itself is the colour version
 * shown on hover. That only works if the logo actually has transparency —
 * hence the strip above.
 */
export async function prepareLogoForUpload(
  file: File,
  options: LogoOptions = {},
): Promise<PreparedLogo> {
  const bitmap = await decode(file)
  const sourceWidth = bitmap.width
  const sourceHeight = bitmap.height
  if (!sourceWidth || !sourceHeight) throw new Error('That file is not a readable image.')

  try {
    const width = Math.min(sourceWidth, LOGO_WIDTH)
    const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width))

    let plateRemoved = false

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('This browser cannot process images.')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, width, height)

    let backgroundRemoved = stripFlatBackground(ctx, width, height)

    if (options.removePlate !== false) {
      const image = ctx.getImageData(0, 0, width, height)
      const plate = options.removePlate
        ? (detectPlateColour(image.data, width, height) ?? [255, 255, 255])
        : detectPlateColour(image.data, width, height)
      if (plate && removePlateFromPixels(image.data, plate)) {
        ctx.putImageData(image, 0, 0)
        backgroundRemoved = true
        plateRemoved = true
      }
    }

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.92),
    )
    if (!blob) throw new Error('This browser cannot save WebP images.')
    return { width, height, blob, backgroundRemoved, plateRemoved }
  } finally {
    bitmap.close()
  }
}
