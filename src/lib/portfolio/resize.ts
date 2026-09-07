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
