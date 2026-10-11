'use client'

import { useRef, useState } from 'react'
import { Crosshair, RotateCcw } from 'lucide-react'
import {
  focalFromPointer, nudgeFocal, visibleRegion, mediaAdvice, type ShowcaseMediaType,
} from '@/lib/portfolio/showcase'

interface Props {
  media: { type: ShowcaseMediaType; url: string; posterUrl: string | null }
  focal: { x: number; y: number }
  onChange: (focal: { x: number; y: number }) => void
  /** Shape of the screen this crop is for — what the shading is computed against. */
  frameAspect: number
  viewport: 'desktop' | 'mobile'
  /** Caps the displayed height so a tall phone image does not push everything off-screen. */
  maxHeight?: number
}

/**
 * Pick where a crop stays centred, on the whole uncropped image.
 *
 * The website draws the hero with `object-fit: cover`, so on any screen whose
 * shape differs from the artwork's, part of it is cut off. The focal point
 * decides which part survives. This shows the full image so the choice is made
 * on the real artwork, and shades what the chosen screen shape would lose, so
 * the effect of a drag is visible while dragging rather than after publishing.
 *
 * The image's own on-screen box is the coordinate space (the wrapper is
 * exactly as big as the image), so a pointer position converts straight to
 * the percentage `object-position` expects.
 */
export default function FocalPicker({ media, focal, onChange, frameAspect, viewport, maxHeight = 340 }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  // Whether a drag is in progress lives in a ref, because the move handler
  // must see it IMMEDIATELY: reading React state there goes through a stale
  // closure until the next render, so a fast press-and-move could be dropped.
  // The state copy exists only to switch the cursor.
  const draggingRef = useRef(false)
  const [dragging, setDragging] = useState(false)

  const region = dims ? visibleRegion(dims.w, dims.h, frameAspect, focal.x, focal.y) : null
  const advice = dims ? mediaAdvice(viewport, dims.w, dims.h) : null

  function setFromPointer(e: React.PointerEvent) {
    const el = box.current
    if (!el) return
    onChange(focalFromPointer(el.getBoundingClientRect(), e.clientX, e.clientY))
  }

  const mediaStyle: React.CSSProperties = { maxHeight, maxWidth: '100%', display: 'block' }

  return (
    <div className="space-y-2">
      <div className="flex justify-center rounded-xl border border-border bg-secondary/40 p-3">
        <div
          ref={box}
          className={`relative inline-block overflow-hidden rounded-md select-none touch-none ${dragging ? 'cursor-grabbing' : 'cursor-crosshair'}`}
          onPointerDown={(e) => {
            // Capture so the drag keeps tracking after the pointer leaves the image.
            e.currentTarget.setPointerCapture(e.pointerId)
            draggingRef.current = true
            setDragging(true)
            setFromPointer(e)
          }}
          onPointerMove={(e) => { if (draggingRef.current) setFromPointer(e) }}
          onPointerUp={() => { draggingRef.current = false; setDragging(false) }}
          onPointerCancel={() => { draggingRef.current = false; setDragging(false) }}
        >
          {media.type === 'video' ? (
            // Muted, no controls: this is a picture to aim at, and the first
            // frame is what the focal point is chosen against.
            <video
              src={media.url}
              poster={media.posterUrl ?? undefined}
              muted
              playsInline
              preload="metadata"
              draggable={false}
              style={mediaStyle}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                if (v.videoWidth) setDims({ w: v.videoWidth, h: v.videoHeight })
              }}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={media.url}
              alt=""
              draggable={false}
              style={mediaStyle}
              onLoad={(e) => {
                const i = e.currentTarget
                if (i.naturalWidth) setDims({ w: i.naturalWidth, h: i.naturalHeight })
              }}
            />
          )}

          {/* What this screen shape keeps. The shading is a box-shadow around
              the kept region, so it needs no four-rectangle bookkeeping. */}
          {region && (
            <div
              aria-hidden
              className="pointer-events-none absolute border border-white/80"
              style={{
                left: `${region.x}%`, top: `${region.y}%`,
                width: `${region.width}%`, height: `${region.height}%`,
                boxShadow: '0 0 0 9999px rgba(8, 6, 14, 0.58)',
              }}
            />
          )}

          <button
            type="button"
            aria-label={`Focal point: ${focal.x}% across, ${focal.y}% down. Use the arrow keys to move it; hold Shift for larger steps.`}
            className="absolute z-10 -translate-x-1/2 -translate-y-1/2 w-6 h-6 rounded-full border-2 border-white bg-violet-500/80 shadow-[0_0_0_2px_rgba(0,0,0,0.45)] flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            style={{ left: `${focal.x}%`, top: `${focal.y}%` }}
            onPointerDown={(e) => e.stopPropagation() /* the wrapper handles dragging */}
            onKeyDown={(e) => {
              if (e.key.startsWith('Arrow')) {
                e.preventDefault()
                onChange(nudgeFocal(focal, e.key, e.shiftKey))
              }
            }}
          >
            <Crosshair className="w-3 h-3 text-white" />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          Focal point <span className="font-medium text-foreground tabular-nums">{focal.x}% · {focal.y}%</span>
          {dims && <span className="ml-2 opacity-70">source {dims.w}×{dims.h}</span>}
        </span>
        <button
          type="button"
          onClick={() => onChange({ x: 50, y: 50 })}
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <RotateCcw className="w-3 h-3" /> Centre
        </button>
      </div>

      {advice && (
        <p className="text-[11px] leading-relaxed text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2.5 py-2">
          {advice}
        </p>
      )}
    </div>
  )
}
