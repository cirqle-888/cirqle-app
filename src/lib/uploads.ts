/**
 * Shared upload validation.
 *
 * Every signed-upload path must decide one thing: what extension gets written
 * into storage. Deriving it from the caller's filename lets someone store
 * `evil.html` in a public bucket and serve scripts from our own origin — which
 * is stored XSS with none of the escaping work applying, because the file is
 * the document.
 *
 * So: the extension comes from the DECLARED CONTENT TYPE, and the filename is
 * only ever a fallback that must itself survive the allow-list. Anything that
 * matches neither is refused rather than defaulted — a silent `|| 'jpg'` writes
 * attacker-controlled bytes under a name we chose, which is worse than an error.
 *
 * This existed in three near-identical copies (catalog, intake/offer,
 * intake/library) and was missing entirely from social-calendar.
 */

/** contentType → the extension we will store it under. */
export const IMAGE_EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

/** Extensions acceptable when falling back to the filename. */
export const ALLOWED_IMAGE_EXTS = new Set([...Object.values(IMAGE_EXT_BY_TYPE), 'jpeg'])

export const IMAGE_UPLOAD_ERROR =
  'Only JPG, PNG, WebP, GIF, AVIF or HEIC images can be uploaded.'

/** 10 MB. Storage buckets should carry the same limit — a client can lie. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * Resolves the extension to store an image under, or null when the upload
 * should be refused.
 *
 * @param filename    caller-supplied name — untrusted, used only as a fallback
 * @param contentType caller-declared MIME type — preferred source
 */
export function resolveImageExt(
  filename: string | null | undefined,
  contentType: string | null | undefined,
): string | null {
  const declared = (contentType ?? '').toLowerCase().split(';')[0].trim()
  const fromType = IMAGE_EXT_BY_TYPE[declared]
  if (fromType) return fromType

  const fromName = (filename ?? '').split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (fromName && ALLOWED_IMAGE_EXTS.has(fromName)) {
    return fromName === 'jpeg' ? 'jpg' : fromName
  }
  return null
}
