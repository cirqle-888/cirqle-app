'use client'

import { useEffect, useRef } from 'react'

interface ModalOverlayProps {
  onClose: () => void
  children: React.ReactNode
  /** Set true for confirmation/warning dialogs — disables outside-click and Escape */
  isConfirmation?: boolean
  className?: string
  zIndex?: string
}

/**
 * Standard modal backdrop.
 * - Click outside the content box → closes (unless isConfirmation)
 * - Press Escape → closes (unless isConfirmation)
 */
export function ModalOverlay({
  onClose, children, isConfirmation = false, className = '', zIndex = 'z-50',
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

  return (
    <div
      className={`fixed inset-0 ${zIndex} flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 ${className}`}
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
