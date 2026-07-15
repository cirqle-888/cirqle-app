'use client'

import { useState, useCallback } from 'react'
import { copyToClipboard } from '@/lib/clipboard'

/**
 * Returns [copied, copy] — `copied` is true for 1.5s after a successful copy.
 */
export function useCopy(timeout = 1500) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(async (text: string) => {
    if (!text) return
    if (!(await copyToClipboard(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), timeout)
  }, [timeout])

  return [copied, copy] as const
}
