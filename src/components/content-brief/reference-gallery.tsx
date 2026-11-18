'use client'

/**
 * Reference images for a brief: small previews that open full screen inside
 * the app (no new tab), with next / previous when there is more than one.
 * Used by the brief form (Calendar, Requests) and the read-only brief view.
 */

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'
import { ImageLightbox } from '@/components/ui/image-lightbox'

export function ReferenceGallery({ images, thumb = 'w-24 h-24', onRemove }: {
  images: string[]
  /** Tailwind size classes for one preview. */
  thumb?: string
  /** Shows a remove button on each preview (the form); leave out for read-only. */
  onRemove?: (index: number) => void
}) {
  const [open, setOpen] = useState<number | null>(null)
  const many = images.length > 1
  const step = useCallback((d: number) => {
    setOpen(i => (i === null ? i : (i + d + images.length) % images.length))
  }, [images.length])
  const close = useCallback(() => setOpen(null), [])

  useEffect(() => {
    if (open === null || !many) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, many, step])

  if (!images.length) return null
  const current = open !== null ? images[Math.min(open, images.length - 1)] : null
  const NAV = 'fixed top-1/2 z-[210] -translate-y-1/2 flex h-11 w-11 items-center justify-center rounded-full bg-white text-black shadow-lg ring-1 ring-black/10 transition-transform hover:scale-105'

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {images.map((src, i) => (
          <div key={`${src}-${i}`} className="relative group">
            <button type="button" onClick={() => setOpen(i)} title="View full screen"
              className={`block ${thumb} rounded-lg overflow-hidden border border-border bg-secondary hover:ring-2 hover:ring-violet-500/40 transition`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Reference ${i + 1}`} loading="lazy" className="w-full h-full object-cover" />
            </button>
            {onRemove && (
              <button type="button" onClick={() => onRemove(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-card border border-border text-muted-foreground hover:text-red-500 flex items-center justify-center shadow sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                title="Remove image" aria-label="Remove image">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        ))}
      </div>

      {current && (
        <>
          <ImageLightbox key={current} src={current} alt={`Reference ${(open ?? 0) + 1} of ${images.length}`} onClose={close} />
          {many && (
            <>
              <button type="button" onClick={() => step(-1)} aria-label="Previous image" title="Previous (←)" className={`${NAV} left-4`}>
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button type="button" onClick={() => step(1)} aria-label="Next image" title="Next (→)" className={`${NAV} right-4`}>
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          )}
          <a href={current} target="_blank" rel="noreferrer"
            className="fixed left-4 top-4 z-[210] inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-2 text-xs font-medium text-white hover:bg-white/25">
            <ExternalLink className="h-3.5 w-3.5" /> {many ? `${(open ?? 0) + 1} / ${images.length} · ` : ''}Open original
          </a>
        </>
      )}
    </>
  )
}

export default ReferenceGallery
