'use client'

/**
 * Phone-friendly product photo picker for the simple intake.
 *
 * Camera/gallery via a plain file input (`capture` hints the rear camera on
 * mobile), client-side downscale to ≤1600px before the signed PUT so a 12MP
 * shot doesn't crawl over cellular. Upload is INDEPENDENT of saving: a failed
 * upload leaves the row marked "photo pending" with a Retry — it never blocks
 * or fails the campaign save.
 */

import { useRef, useState } from 'react'
import { Camera, Loader2, RefreshCw, X } from 'lucide-react'
import { getImageUploadUrl } from '../actions'

const MAX_EDGE = 1600

/** Downscale to ≤1600px on the long edge. Falls back to the original file on
 *  any canvas trouble — an oversized upload beats a lost photo. */
async function downscale(file: File): Promise<{ blob: Blob; contentType: string }> {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    if (scale >= 1) return { blob: file, contentType: file.type }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return { blob: file, contentType: file.type }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // PNG keeps transparency (cut-out shots); everything else compresses well
    // as JPEG.
    const isPng = file.type === 'image/png'
    const type = isPng ? 'image/png' : 'image/jpeg'
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.85))
    return blob ? { blob, contentType: type } : { blob: file, contentType: file.type }
  } catch {
    return { blob: file, contentType: file.type }
  }
}

export function ProductPhotoButton({
  token, imageUrl, onUploaded, onPendingChange, compact,
}: {
  token: string
  imageUrl?: string | null
  onUploaded: (publicUrl: string) => void
  /** Reports pending/failed state up so the row can flag "photo pending". */
  onPendingChange?: (pending: boolean) => void
  compact?: boolean
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [failedFile, setFailedFile] = useState<File | null>(null)

  async function upload(file: File) {
    setUploading(true)
    setFailedFile(null)
    onPendingChange?.(true)
    try {
      const { blob, contentType } = await downscale(file)
      const res = await getImageUploadUrl(token, file.name, contentType)
      if (!res.ok || !res.data) throw new Error(res.error || 'upload prep failed')
      const put = await fetch(res.data.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob })
      if (!put.ok) throw new Error('PUT failed')
      onUploaded(res.data.publicUrl)
      onPendingChange?.(false)
    } catch {
      // Keep the file so Retry re-sends without re-picking; the save flow is
      // deliberately unaffected.
      setFailedFile(file)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const input = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*"
      capture="environment"
      className="hidden"
      onChange={e => {
        const f = e.target.files?.[0]
        if (f) void upload(f)
      }}
    />
  )

  if (failedFile) {
    return (
      <span className="inline-flex items-center gap-2">
        {input}
        <button
          type="button"
          onClick={() => void upload(failedFile)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/25 hover:bg-amber-500/25 transition-colors"
        >
          <RefreshCw className="w-3 h-3" /> Photo didn&apos;t send — retry
        </button>
        <button
          type="button"
          onClick={() => { setFailedFile(null); onPendingChange?.(false) }}
          className="p-1 rounded text-white/30 hover:text-white/60"
          aria-label="Skip this photo"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </span>
    )
  }

  return (
    <span className="inline-flex">
      {input}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        className={
          compact
            ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-white/5 text-white/60 border border-white/10 hover:text-white hover:border-white/25 disabled:opacity-50 transition-colors'
            : 'w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-white/15 bg-white/[0.03] text-sm font-medium text-white/50 hover:text-white/80 hover:border-white/30 disabled:opacity-50 transition-colors'
        }
      >
        {uploading
          ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending…</>
          : <><Camera className="w-3.5 h-3.5" /> {imageUrl ? 'Change photo' : 'Add photo'}</>}
      </button>
    </span>
  )
}
