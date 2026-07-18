'use client'

import { useEffect } from 'react'
import { X } from 'lucide-react'

/**
 * Full-screen large image preview.
 *
 * Three ways out, because a preview you can't dismiss is a trap: press Escape,
 * click the backdrop, or hit the close button. The button is deliberately
 * high-contrast — a faint one is invisible against a dark backdrop (and against
 * transparent-background product cutouts, which show the backdrop through them).
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  // Escape to close + freeze background scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `Preview: ${alt}` : 'Image preview'}
      className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        autoFocus
        aria-label="Close preview"
        title="Close preview (Esc)"
        className="absolute top-4 right-4 z-10 flex items-center gap-1.5 rounded-full bg-white px-3 py-2 text-sm font-semibold text-black shadow-lg ring-1 ring-black/10 transition-transform hover:scale-105 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
      >
        <X className="h-4 w-4" />
        Close
      </button>

      {/* Checkerboard sits behind the image so a transparent cutout reads as
          transparent instead of blending into the dark backdrop. */}
      <div
        className="relative max-h-full max-w-full overflow-hidden rounded-lg shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{
          backgroundColor: '#fff',
          backgroundImage:
            'linear-gradient(45deg, #d4d4d8 25%, transparent 25%), linear-gradient(-45deg, #d4d4d8 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #d4d4d8 75%), linear-gradient(-45deg, transparent 75%, #d4d4d8 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt || ''} className="block max-h-[85vh] max-w-full object-contain" />
      </div>

      <p className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 text-xs text-white/60">
        Press <kbd className="rounded bg-white/15 px-1.5 py-0.5 font-sans text-white/80">Esc</kbd> or click outside to close
      </p>
    </div>
  )
}

export default ImageLightbox
