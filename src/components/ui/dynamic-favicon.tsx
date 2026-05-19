'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

/**
 * DynamicFavicon — runs once on mount, reads company_settings.favicon_url from
 * Supabase, and updates the browser tab icon to the custom favicon.
 * Falls back to the static /icon.svg if no custom URL is stored.
 */
export function DynamicFavicon() {
  useEffect(() => {
    ;(async () => {
      try {
        const supabase = createClient()
        const { data } = await supabase
          .from('company_settings')
          .select('value')
          .eq('key', 'favicon_url')
          .maybeSingle()

        // Each setting is stored as its own row: { key: 'favicon_url', value: 'https://...' }
        const faviconUrl: string = data?.value || ''
        if (!faviconUrl) return   // nothing stored → keep the static /icon.svg

        // Update (or create) the <link rel="icon"> element
        let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
        if (!link) {
          link = document.createElement('link')
          link.rel = 'icon'
          document.head.appendChild(link)
        }
        link.href = faviconUrl
      } catch {
        // silently ignore — network errors, missing table, etc.
      }
    })()
  }, [])

  return null
}
