'use client'

import { useEffect, useRef } from 'react'

interface ModalOverlayProps {
  onClose: () => void
  children: React.ReactNode
  /** Set true for confirmation/warning dialogs — disables outside-click and Escape */
  isConfirmation?: boolean
  /**
   * When true: below the `sm` breakpoint the modal docks to the bottom of the
   * viewport (bottom-sheet pattern). Above `sm` it's a centered dialog as
   * usual. The modal's own child should use responsive rounded corners
   * (e.g. `rounded-t-2xl sm:rounded-2xl`) and `h-full sm:h-auto` to take the
   * pattern advantage.
   */
  sheetOnMobile?: boolean
  className?: string
  zIndex?: string
}

/**
 * Standard modal backdrop.
 * - Click outside the content box → closes (unless isConfirmation)
 * - Press Escape → closes (unless isConfirmation)
 * - Optional `sheetOnMobile` for bottom-sheet behavior on small screens.
 */
export function ModalOverlay({
  onClose, children, isConfirmation = false, sheetOnMobile = false, className = '', zIndex = 'z-50',
}: ModalOverlayProps) {
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isConfirmation) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, isConfirmation])

  // Alignment: centered dialog by default; bottom-anchored sheet on mobile when opted in.
  // Padding: zero on mobile sheet (so the sheet hugs the viewport), p-4 on desktop.
  const alignment = sheetOnMobile
    ? 'items-end justify-center sm:items-center'
    : 'items-center justify-center'
  const padding = sheetOnMobile ? 'p-0 sm:p-4' : 'p-4'

  return (
    <div
      className={`fixed inset-0 ${zIndex} flex ${alignment} bg-black/60 backdrop-blur-sm ${padding} ${className}`}
      onMouseDown={e => {
        if (!isConfirmation && contentRef.current && !contentRef.current.contains(e.target as Node)) {
          onClose()
        }
      }}
    >
      <div ref={contentRef} className="contents">
        {children}
      </div>
    </div>
  )
}
