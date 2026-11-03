'use client'

/**
 * The invoice document, drawn at the width it prints at (PDF_PAGE_W) and
 * scaled — so the preview reads as the whole page on a phone and as a large
 * sheet on a desktop, with no inner scrollbars. The surrounding container
 * scrolls; the iframe is sized to its content.
 *
 * `zoom`: 'width' fills the available width, 'page' shows the whole page at
 * once, a number is a fixed scale (1 = print size).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PDF_PAGE_W } from '@/lib/invoices/render-html'

export type PreviewZoom = 'width' | 'page' | number

const MIN_SCALE = 0.3
const MAX_FIT_SCALE = 1.25
const MAX_SCALE = 2
const GUTTER = 32

export function InvoicePreviewFrame({
  html,
  title = 'Invoice preview',
  zoom = 'width',
  onScale,
}: {
  html: string
  title?: string
  zoom?: PreviewZoom
  /** Reports the scale actually in use, for a "75%" read-out. */
  onScale?: (scale: number) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [contentH, setContentH] = useState(1100)

  // Width from the box itself; height from the scrolling container around it,
  // which is the room "whole page" has to fit into.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const viewport = el.parentElement ?? el
    const read = () => setBox({ w: el.clientWidth, h: viewport.clientHeight })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    ro.observe(viewport)
    read()
    return () => ro.disconnect()
  }, [])

  const measure = useCallback(() => {
    try {
      const doc = frameRef.current?.contentDocument
      if (!doc) return
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0)
      if (h > 0) setContentH(h)
    } catch { /* torn down: keep the last height */ }
  }, [])

  // Images (logo, QR) can land after `load`; measure again once they have.
  const onLoad = useCallback(() => {
    measure()
    window.setTimeout(measure, 400)
    window.setTimeout(measure, 1500)
  }, [measure])

  const widthFit = box.w ? Math.min(MAX_FIT_SCALE, (box.w - GUTTER) / PDF_PAGE_W) : 1
  const raw = zoom === 'width'
    ? widthFit
    : zoom === 'page'
      ? Math.min(widthFit, box.h ? (box.h - GUTTER * 1.5) / contentH : widthFit)
      : zoom
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw))

  useEffect(() => { onScale?.(scale) }, [scale, onScale])

  return (
    <div ref={boxRef} className="w-full">
      <div
        className="mx-auto overflow-hidden rounded-sm bg-white shadow-[0_2px_16px_rgba(15,23,42,0.18)] ring-1 ring-black/5"
        style={{ width: PDF_PAGE_W * scale, height: contentH * scale }}
      >
        <iframe
          ref={frameRef}
          srcDoc={html}
          title={title}
          sandbox="allow-same-origin"
          scrolling="no"
          onLoad={onLoad}
          className="block border-0 bg-white"
          style={{
            width: PDF_PAGE_W,
            height: contentH,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        />
      </div>
    </div>
  )
}
