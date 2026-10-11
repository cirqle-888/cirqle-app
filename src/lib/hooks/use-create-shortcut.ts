'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

/** Consume a permitted ?new=true link once without clearing other filters. */
export function useCreateShortcut(allowed: boolean, onOpen: () => void) {
  const pathname = usePathname()
  const params = useSearchParams()
  const router = useRouter()
  const onOpenRef = useRef(onOpen)
  useEffect(() => { onOpenRef.current = onOpen }, [onOpen])
  const query = params.toString()

  useEffect(() => {
    const next = new URLSearchParams(query)
    if (!allowed || next.get('new') !== 'true') return
    const timer = setTimeout(() => {
      onOpenRef.current()
      next.delete('new')
      const remaining = next.toString()
      router.replace(`${pathname}${remaining ? `?${remaining}` : ''}`, { scroll: false })
    }, 0)
    return () => clearTimeout(timer)
  }, [allowed, pathname, query, router])
}
