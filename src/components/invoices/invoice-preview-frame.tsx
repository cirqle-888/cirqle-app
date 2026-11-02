'use client'

/**
 * The invoice document, drawn at the width it prints at (PDF_PAGE_W) and
 * scaled to fit whatever room the panel has — so the preview reads as the
 * whole page on a phone and as a large sheet on a desktop, with no inner
 * scrollbars. The page itself scrolls; the iframe is sized to its content.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { PDF_PAGE_W } from '@/lib/invoices/render-html'

const MIN_SCALE = 0.4
const MAX_SCALE = 1.25
const GUTTER = 32

export function InvoicePreviewFrame({ html, title = 'Invoice preview' }: { html: string; title?: string }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [boxW, setBoxW] = useState(0)
  const [contentH, setContentH] = useState(1100)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth))
    ro.observe(el)
    setBoxW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const measure = useCallback(() => {
    try {
      const doc = frameRef.current?.contentDocument
      if (!doc) return
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0)
      if (h > 0) setContentH(h)
    } catch { /* cross-origin or torn down: keep the last height */ }
  }, [])

  // Images (logo, QR) can land after `load`; measure again once they have.
  const onLoad = useCallback(() => {
    measure()
    window.setTimeout(measure, 400)
    window.setTimeout(measure, 1500)
  }, [measure])

  const scale = boxW
    ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, (boxW - GUTTER) / PDF_PAGE_W))
    : 1

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
