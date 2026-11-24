'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react'

export interface ViewerImage { id: string; url: string; name: string; caption?: string }

/** Full-screen picture viewer: arrows / swipe between the chat's pictures, Esc or tap outside to close. */
export function ImageViewer({ images, startId, onClose }: { images: ViewerImage[]; startId: string; onClose: () => void }) {
  const [index, setIndex] = useState(() => Math.max(0, images.findIndex(i => i.id === startId)))
  const img = images[index]
  const go = useCallback((d: number) => setIndex(i => Math.max(0, Math.min(images.length - 1, i + d))), [images.length])
  const [touchX, setTouchX] = useState<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, go])

  if (!img) return null
  const btn = 'rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-30'
  return createPortal(
    <div className="fixed inset-0 z-[220] flex flex-col bg-black/95" role="dialog" aria-label="Picture"
      onTouchStart={e => setTouchX(e.touches[0].clientX)}
      onTouchEnd={e => {
        if (touchX === null) return
        const d = e.changedTouches[0].clientX - touchX
        if (Math.abs(d) > 60) go(d < 0 ? 1 : -1)
        setTouchX(null)
      }}>
      <div className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2 text-white">
        <p className="min-w-0 flex-1 truncate text-sm">{img.name}{images.length > 1 && <span className="ml-2 text-white/60">{index + 1} / {images.length}</span>}</p>
        <a href={img.url} download={img.name} target="_blank" rel="noopener noreferrer" className={btn} aria-label="Download"><Download className="h-4 w-4" /></a>
        <button onClick={onClose} className={btn} aria-label="Close"><X className="h-4 w-4" /></button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-2" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        {/* Signed short-lived URL — next/image cannot optimize these. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={img.url} alt={img.name} className="max-h-full max-w-full select-none object-contain" draggable={false} />
        {images.length > 1 && (
          <>
            <button onClick={() => go(-1)} disabled={index === 0} className={`${btn} absolute left-3 hidden md:block`} aria-label="Previous"><ChevronLeft className="h-5 w-5" /></button>
            <button onClick={() => go(1)} disabled={index === images.length - 1} className={`${btn} absolute right-3 hidden md:block`} aria-label="Next"><ChevronRight className="h-5 w-5" /></button>
          </>
        )}
      </div>
      {img.caption && <p className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2 text-center text-sm text-white/90">{img.caption}</p>}
    </div>,
    document.body,
  )
}
