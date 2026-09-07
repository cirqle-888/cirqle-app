'use client'

import { MAX_SOURCE_BYTES, MAX_VIDEO_BYTES, VIDEO_EXT_BY_TYPE, type WorkVariant } from '@/lib/portfolio/types'
import { posterFromVideo, resizeForUpload } from '@/lib/portfolio/resize'
import { createVideoUploadUrl, createWorkUploadUrls } from './actions'

export interface UploadedMedia {
  width: number
  height: number
  durationSeconds: number | null
  variants: WorkVariant[]
  /** Set when the file was a video; the clip we now host */
  mediaPath: string | null
  /** True when a video gave no poster frame — the caller may want to say so */
  posterMissing: boolean
}

/**
 * Turn one picked file into everything the website needs: WebP renditions at
 * four widths, plus the original clip when it is a video.
 *
 * Shared by the drop zone and the "add reel by link" cover, so both produce
 * identical output. Throws with a message fit to show the user.
 */
export async function uploadMedia(
  file: File,
  ctx: { collectionSlug: string; brandSlug: string; slug: string },
  onStep: (step: string) => void,
): Promise<UploadedMedia> {
  const isVideo = file.type.startsWith('video/')
  const cap = isVideo ? MAX_VIDEO_BYTES : MAX_SOURCE_BYTES
  if (file.size > cap) {
    throw new Error(`Too large - keep ${isVideo ? 'videos' : 'images'} under ${Math.round(cap / 1024 / 1024)} MB`)
  }
  if (isVideo && !VIDEO_EXT_BY_TYPE[file.type]) {
    throw new Error('Videos must be MP4, WebM or MOV')
  }

  let width = 0
  let height = 0
  let durationSeconds: number | null = null
  let renditions: { width: number; height: number; blob: Blob }[] = []
  let mediaPath: string | null = null

  if (isVideo) {
    onStep('Reading the video')
    const poster = await posterFromVideo(file)
    width = poster.width
    height = poster.height
    durationSeconds = poster.durationSeconds || null
    renditions = poster.renditions

    onStep('Preparing upload')
    const prep = await createVideoUploadUrl({ ...ctx, contentType: file.type })
    if (!prep.ok || !prep.data) throw new Error(prep.error ?? 'Could not prepare the upload')

    onStep(`Uploading ${Math.max(1, Math.round(file.size / 1024 / 1024))} MB`)
    const put = await fetch(prep.data.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type },
      body: file,
    })
    if (!put.ok) throw new Error('Storage rejected the video.')
    mediaPath = prep.data.path
  } else {
    onStep('Resizing')
    const resized = await resizeForUpload(file)
    width = resized.width
    height = resized.height
    renditions = resized.renditions
  }

  const variants: WorkVariant[] = []
  if (renditions.length) {
    const prep = await createWorkUploadUrls({ ...ctx, widths: renditions.map((r) => r.width) })
    if (!prep.ok || !prep.data) throw new Error(prep.error ?? 'Could not prepare the upload')

    onStep(isVideo ? 'Uploading the poster' : `Uploading ${renditions.length} sizes`)
    const targets = prep.data
    for (const rendition of renditions) {
      const target = targets.find((t) => t.width === rendition.width)
      if (!target) continue
      const put = await fetch(target.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/webp' },
        body: rendition.blob,
      })
      if (!put.ok) throw new Error('Storage rejected the file.')
      variants.push({ width: rendition.width, height: rendition.height, path: target.path, bytes: rendition.blob.size })
    }
  }

  return { width, height, durationSeconds, variants, mediaPath, posterMissing: isVideo && !renditions.length }
}
