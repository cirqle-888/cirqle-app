'use client'

import { MAX_SOURCE_BYTES, MAX_VIDEO_BYTES } from '@/lib/portfolio/types'
import { prepareShowcaseImage } from '@/lib/portfolio/resize'
import { SHOWCASE_FOLDER } from '@/lib/portfolio/showcase'
import { uploadMedia } from './upload-media'
import { createWorkUploadUrls } from './actions'

export interface UploadedShowcaseMedia {
  type: 'image' | 'video'
  /** Storage path of the image, or of the video file. */
  path: string
  /** A video's poster frame. Always null for an image. */
  posterPath: string | null
  width: number
  height: number
}

/**
 * Turn one picked file into what a presentation needs, using the SAME upload
 * pipeline the gallery uses:
 *
 *   · video — `uploadMedia` unchanged: the clip goes straight to storage and a
 *     poster frame is cut from it in the browser. The largest poster is kept.
 *   · image — one high-quality rendition (`prepareShowcaseImage`), uploaded
 *     through the gallery's own signed-URL action. The gallery's four small
 *     sizes would be wrong here: a hero fills the screen, so it needs one file
 *     as close to the original as is sensible, not four thumbnails.
 *
 * Files land in `showcase/<slug>/` so a presentation's media is one folder.
 * Throws with a message fit to show the user.
 */
export async function uploadShowcaseMedia(
  file: File,
  ctx: { slug: string; slot: 'desktop' | 'mobile' },
  onStep: (step: string) => void,
  opts: { requirePoster?: boolean } = {},
): Promise<UploadedShowcaseMedia> {
  const isVideo = file.type.startsWith('video/')
  const cap = isVideo ? MAX_VIDEO_BYTES : MAX_SOURCE_BYTES
  if (file.size > cap) {
    throw new Error(`The ${ctx.slot} file is too large — keep ${isVideo ? 'videos' : 'images'} under ${Math.round(cap / 1024 / 1024)} MB.`)
  }

  const where = { collectionSlug: SHOWCASE_FOLDER, brandSlug: ctx.slug, slug: ctx.slot }

  if (isVideo) {
    const uploaded = await uploadMedia(file, where, (step) => onStep(`${ctx.slot[0].toUpperCase()}${ctx.slot.slice(1)}: ${step}`))
    if (!uploaded.mediaPath) throw new Error(`The ${ctx.slot} video did not upload.`)
    // Largest first: the poster is what shows before the clip plays, on a
    // full-screen hero.
    const poster = [...uploaded.variants].sort((a, b) => b.width - a.width)[0]
    if (!poster && opts.requirePoster) {
      throw new Error(`Could not read a poster frame from the ${ctx.slot} video. Try an MP4 encoded as H.264.`)
    }
    return {
      type: 'video',
      path: uploaded.mediaPath,
      posterPath: poster?.path ?? null,
      width: uploaded.width,
      height: uploaded.height,
    }
  }

  onStep(`${ctx.slot[0].toUpperCase()}${ctx.slot.slice(1)}: preparing the image`)
  const prepared = await prepareShowcaseImage(file)

  const prep = await createWorkUploadUrls({ ...where, widths: [prepared.width] })
  if (!prep.ok || !prep.data?.length) throw new Error(prep.error ?? 'Could not prepare the upload.')
  const target = prep.data[0]

  onStep(`${ctx.slot[0].toUpperCase()}${ctx.slot.slice(1)}: uploading ${(prepared.blob.size / 1024 / 1024).toFixed(1)} MB`)
  const put = await fetch(target.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/webp' },
    body: prepared.blob,
  })
  if (!put.ok) throw new Error(`Storage rejected the ${ctx.slot} image (${put.status}).`)

  return { type: 'image', path: target.path, posterPath: null, width: prepared.width, height: prepared.height }
}
