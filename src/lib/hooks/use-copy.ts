'use client'

import { useState, useCallback } from 'react'

/**
 * Returns [copied, copy] — `copied` is true for 1.5s after copy.
 */
export function useCopy(timeout = 1500) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async (text: string) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), timeout)
    } catch {
      // Fallback for older browsers / non-secure contexts
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      setTimeout(() => setCopied(false), timeout)
    }
  }, [timeout])

  return [copied, copy] as const
}
